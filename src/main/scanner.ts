import { randomUUID } from 'node:crypto'
import { promises as fs, type Dirent } from 'node:fs'
import { basename, dirname, join, relative, resolve, win32 } from 'node:path'
import { AtlasDatabase, normalizePath, type ScannedImageRecord } from './db'
import { createThumbnail, isSupportedImage, thumbnailPath } from './media'
import type { RootFolder, ScanEvent, ScanPhase, ScanState } from '../shared/types'

const SKIP_DIRECTORIES = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '.git',
  '.svn',
  '__macosx'
])

const WORKER_COUNT = 4
const EMIT_INTERVAL_MS = 90

export interface ScanManagerCallbacks {
  onEvent: (event: ScanEvent) => void
  onChanged: () => void
}

interface QueueEntry {
  root: RootFolder
  requestedAt: number
}

interface ActiveScan {
  root: RootFolder
  token: string
  controller: AbortController
  state: ScanState
}

export interface FolderValidation {
  ok: boolean
  path: string
  reason?: string
}

export function isPathInsideOrEqual(parent: string, child: string): boolean {
  const from = normalizePath(parent)
  const to = normalizePath(child)
  const rel = win32.relative(from, to)
  return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel))
}

export async function validateFolder(candidate: string): Promise<FolderValidation> {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { ok: false, path: candidate, reason: 'The folder path is empty.' }
  }
  let resolved: string
  try {
    resolved = resolve(candidate)
    const info = await fs.stat(resolved)
    if (!info.isDirectory()) {
      return { ok: false, path: resolved, reason: 'That path is not a folder.' }
    }
    resolved = await fs.realpath(resolved)
  } catch {
    return { ok: false, path: resolved!, reason: 'That folder could not be opened.' }
  }

  const parsedRoot = win32.parse(resolved).root
  if (normalizePath(resolved).toLowerCase() === normalizePath(parsedRoot).toLowerCase()) {
    return {
      ok: false,
      path: resolved,
      reason: 'Choose a folder inside the drive, not an entire drive. Atlas never scans a whole drive.'
    }
  }

  return { ok: true, path: normalizePath(resolved) }
}

function initialState(root: RootFolder, queued: number): ScanState {
  return {
    rootId: root.id,
    rootName: root.name,
    phase: 'queued',
    queued,
    discovered: 0,
    processed: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    currentFile: null,
    message: null,
    startedAt: Date.now(),
    finishedAt: null
  }
}

export class ScanManager {
  private queue: QueueEntry[] = []
  private active: ActiveScan | null = null
  private callbacks: ScanManagerCallbacks
  private db: AtlasDatabase
  private thumbnailsDir: string
  private lastEmit = 0
  private emitTimer: NodeJS.Timeout | null = null
  private pumping = false

  constructor(db: AtlasDatabase, thumbnailsDir: string, callbacks: ScanManagerCallbacks) {
    this.db = db
    this.thumbnailsDir = thumbnailsDir
    this.callbacks = callbacks
  }

  get scanState(): ScanState | null {
    return this.active?.state ?? null
  }

  get scanningIds(): Set<string> {
    const ids = new Set<string>(this.queue.map((entry) => entry.root.id))
    if (this.active) ids.add(this.active.root.id)
    return ids
  }

  enqueue(root: RootFolder, changedDuringScan = false): void {
    if (this.active?.root.id === root.id && !changedDuringScan) return
    if (this.queue.some((entry) => entry.root.id === root.id)) return
    this.queue.push({ root, requestedAt: Date.now() })
    if (!this.active) {
      void this.pump()
    } else {
      this.emit(true)
    }
  }

  cancelAll(): void {
    this.queue = []
    if (this.active) {
      this.active.controller.abort()
      this.active.state.phase = 'cancelled'
      this.active.state.message = 'Scan stopped by you.'
      this.emit(true)
    }
  }

  private emit(force = false): void {
    if (!this.active) return
    const now = Date.now()
    if (!force && now - this.lastEmit < EMIT_INTERVAL_MS) {
      if (!this.emitTimer) {
        this.emitTimer = setTimeout(() => {
          this.emitTimer = null
          this.emit(true)
        }, EMIT_INTERVAL_MS)
      }
      return
    }
    this.lastEmit = now
    this.callbacks.onEvent({ state: { ...this.active.state } })
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length > 0) {
        const entry = this.queue.shift()!
        const state = initialState(entry.root, this.queue.length)
        const token = randomUUID()
        const controller = new AbortController()
        this.active = { root: entry.root, token, controller, state }
        this.emit(true)
        try {
          await this.runScan(this.active)
        } catch (error) {
          if (this.active) {
            this.active.state.phase = controller.signal.aborted ? 'cancelled' : 'error'
            this.active.state.message =
              error instanceof Error ? error.message : 'The scan could not be completed.'
            this.active.state.finishedAt = Date.now()
            this.emit(true)
          }
        } finally {
          this.active = null
          this.callbacks.onChanged()
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private async runScan(scan: ActiveScan): Promise<void> {
    const { root, token, controller, state } = scan
    const db = this.db
    let walkComplete = false
    let fatalError: string | null = null
    const fileQueue: string[] = []
    let walkDone = false
    let processed = 0
    let discovered = 0
    let added = 0
    let updated = 0
    let skipped = 0
    let errors = 0
    let walkFailures = 0

    db.beginScan(root.id)
    state.phase = 'walking'
    this.emit(true)

    const processFile = async (filePath: string): Promise<void> => {
      if (controller.signal.aborted) return
      state.currentFile = basename(filePath)
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) return
        const existing = db.getImageFingerprint(filePath)
        if (
          existing &&
          existing.mtime === Math.floor(stat.mtimeMs) &&
          existing.bytes === stat.size &&
          existing.thumbStatus === 'ready'
        ) {
          db.touchScanToken(existing.id, token)
          skipped += 1
          state.skipped = skipped
          state.processed = ++processed
          this.emit()
          return
        }

        const id = existing?.id ?? db.newImageId(filePath)
        const result = await createThumbnail(filePath, thumbnailPath(this.thumbnailsDir, id))
        if (controller.signal.aborted) return

        const record: ScannedImageRecord = {
          id,
          rootId: root.id,
          path: filePath,
          folder: dirname(filePath),
          filename: basename(filePath),
          ext: win32.extname(filePath).slice(1).toLowerCase(),
          bytes: stat.size,
          width: result.width,
          height: result.height,
          orientation: result.orientation,
          mtime: Math.floor(stat.mtimeMs),
          color: result.color,
          thumbStatus: result.status,
          thumbError: result.error,
          scanToken: token
        }
        db.upsertScannedImage(record)
        if (existing) updated += 1
        else added += 1
        state.updated = updated
        state.added = added
        if (result.status === 'error') errors += 1
        state.errors = errors
        state.processed = ++processed
        this.emit()
      } catch (error) {
        errors += 1
        state.errors = errors
        state.processed = ++processed
        state.message = `Skipped ${basename(filePath)}: ${
          error instanceof Error ? error.message.slice(0, 120) : 'unreadable file'
        }`
        this.emit()
      }
    }

    const worker = async (): Promise<void> => {
      while (!controller.signal.aborted) {
        const filePath = fileQueue.shift()
        if (!filePath) {
          if (walkDone) return
          await new Promise((resolveWait) => setTimeout(resolveWait, 18))
          continue
        }
        await processFile(filePath)
      }
    }

    const walk = async (directory: string): Promise<void> => {
      if (controller.signal.aborted) return
      let entries: Dirent[]
      try {
        entries = await fs.readdir(directory, { withFileTypes: true })
      } catch (error) {
        errors += 1
        walkFailures += 1
        state.errors = errors
        state.message = `Could not read ${basename(directory) || directory}.`
        this.emit()
        return
      }

      for (const entry of entries) {
        if (controller.signal.aborted) return
        const fullPath = join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
          if (entry.name.startsWith('.')) continue
          await walk(fullPath)
          continue
        }
        if (!entry.isFile() || !isSupportedImage(fullPath)) continue
        discovered += 1
        state.discovered = discovered
        if (state.phase === 'walking') state.phase = 'processing'
        fileQueue.push(fullPath)
        this.emit()
        if (fileQueue.length > 2500) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 2))
        }
      }
    }

    const workers = Array.from({ length: WORKER_COUNT }, () => worker())
    try {
      await walk(root.path)
      walkComplete = !controller.signal.aborted
    } catch (error) {
      fatalError = error instanceof Error ? error.message : 'The folder walk failed.'
      walkComplete = false
    } finally {
      walkDone = true
    }
    await Promise.all(workers)

    if (fatalError && !controller.signal.aborted) {
      state.phase = 'error'
      state.message = fatalError
    } else if (controller.signal.aborted) {
      state.phase = 'cancelled'
      state.message = 'Scan stopped by you.'
    } else {
      state.phase = 'finalizing'
      this.emit(true)
      const canMarkMissing = walkComplete && walkFailures === 0
      db.finishScan(root.id, token, canMarkMissing)
      state.phase = 'done'
      state.message =
        added + updated > 0
          ? `Added ${added}, refreshed ${updated}, and checked ${skipped} unchanged images.`
          : `All ${skipped} images are up to date.`
      if (!canMarkMissing && walkFailures > 0) {
        state.message += ` ${walkFailures} folder${walkFailures === 1 ? '' : 's'} could not be read; missing-file marks were left unchanged.`
      }
    }

    state.processed = processed
    state.discovered = discovered
    state.finishedAt = Date.now()
    state.currentFile = null
    if (!walkComplete && state.phase === 'done') {
      // Defensive: only a complete walk is allowed to mark anything missing.
      state.phase = 'cancelled'
    }
    this.emit(true)
  }
}

export function describeScanProgress(state: ScanState): string {
  const phaseLabels: Record<ScanPhase, string> = {
    queued: 'Waiting',
    walking: 'Reading folders',
    processing: 'Making previews',
    finalizing: 'Finishing',
    done: 'Complete',
    cancelled: 'Stopped',
    error: 'Needs attention'
  }
  return phaseLabels[state.phase]
}
