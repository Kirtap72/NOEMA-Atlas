import { existsSync, watch, type FSWatcher } from 'node:fs'
import { extname } from 'node:path'
import { IMAGE_EXTENSIONS } from '../shared/types'

/**
 * Notices new pictures in the folders Atlas watches, without scanning on a timer. Windows reports changes in a folder tree itself; a burst of
 * changes (a copy of 200 files, a program saving) is waited out, and then the source is checked once. The check is the same incremental scan
 * as "Check again": files Atlas already knows are skipped, so being told too often is harmless. Nothing here reads or changes a picture.
 *
 * A source that cannot be watched (a drive that is not there, a network share that does not report changes) is simply not watched; "Check
 * again" on the Sources page always works.
 */
const supported = new Set<string>(IMAGE_EXTENSIONS)

export interface WatchedRoot {
  id: string
  path: string
}

export class SourceWatcher {
  private watchers = new Map<string, { path: string; watcher: FSWatcher }>()
  private timers = new Map<string, NodeJS.Timeout>()
  private lastRun = new Map<string, number>()

  constructor(
    private onChange: (rootId: string) => void,
    private options: { quietMs?: number; minGapMs?: number } = {}
  ) {}

  /** Watches exactly these sources: new ones start, removed ones stop. */
  sync(roots: WatchedRoot[]): void {
    const wanted = new Map(roots.map((r) => [r.id, r.path]))
    for (const [id, entry] of this.watchers) {
      if (wanted.get(id) !== entry.path) this.stop(id)
    }
    for (const [id, path] of wanted) {
      if (!this.watchers.has(id)) this.start(id, path)
    }
  }

  private start(id: string, path: string): void {
    if (!existsSync(path)) return
    try {
      const watcher = watch(path, { recursive: true, persistent: false }, (_event, name) => {
        // Only pictures (or folders, which have no extension) matter; temporary and partial files are ignored.
        const file = typeof name === 'string' ? name : ''
        const extension = extname(file).toLowerCase()
        if (extension && !supported.has(extension)) return
        this.schedule(id)
      })
      watcher.on('error', () => this.stop(id))
      this.watchers.set(id, { path, watcher })
    } catch {
      /* not watchable: manual checking still works */
    }
  }

  private schedule(id: string): void {
    const quiet = this.options.quietMs ?? 6000
    const gap = this.options.minGapMs ?? 20_000
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const wait = Math.max(quiet, (this.lastRun.get(id) ?? 0) + gap - Date.now())
    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.lastRun.set(id, Date.now())
      try {
        this.onChange(id)
      } catch {
        /* a failing check must not stop watching */
      }
    }, wait)
    timer.unref?.()
    this.timers.set(id, timer)
  }

  private stop(id: string): void {
    const entry = this.watchers.get(id)
    if (entry) {
      try {
        entry.watcher.close()
      } catch {
        /* already closed */
      }
      this.watchers.delete(id)
    }
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  /** Stops watching everything. */
  close(): void {
    for (const id of Array.from(this.watchers.keys())) this.stop(id)
  }
}
