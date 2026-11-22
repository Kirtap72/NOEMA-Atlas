import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase } from '../src/main/db'
import { isPathInsideOrEqual, ScanManager, validateFolder } from '../src/main/scanner'
import type { ScanEvent, ScanState } from '../src/shared/types'

let workDir = ''
let db: AtlasDatabase | null = null

async function makeImage(path: string, color: string, width = 640, height = 420): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg({ quality: 80 })
    .toFile(path)
}

async function waitForScan(scans: ScanManager): Promise<ScanState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Scan timed out')), 30_000)
    const manager = scans as unknown as { callbacks: { onEvent: (event: ScanEvent) => void } }
    const original = manager.callbacks.onEvent
    manager.callbacks.onEvent = (event) => {
      original(event)
      if (['done', 'cancelled', 'error'].includes(event.state.phase)) {
        clearTimeout(timer)
        resolve(event.state)
      }
    }
    const root = db!.listRoots()[0]!
    scans.enqueue(root)
  })
}

beforeEach(async () => {
  workDir = join(tmpdir(), `noema-scan-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(join(workDir, 'images', 'nested'), { recursive: true })
  await fs.mkdir(join(workDir, 'images', '.hidden'), { recursive: true })
  await fs.mkdir(join(workDir, 'thumbs'), { recursive: true })
  await makeImage(join(workDir, 'images', 'amber.jpg'), '#a46f3a')
  await makeImage(join(workDir, 'images', 'blue.jpg'), '#2f5368', 420, 640)
  await makeImage(join(workDir, 'images', 'nested', 'green.png'), '#536c48')
  await makeImage(join(workDir, 'images', '.hidden', 'ignored.jpg'), '#ff0000')
  await fs.writeFile(join(workDir, 'images', 'notes.txt'), 'not an image')
  db = new AtlasDatabase(join(workDir, 'library.db'))
})

afterEach(async () => {
  db?.close()
  db = null
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 })
})

describe('folder validation', () => {
  it('rejects drive roots and missing paths', async () => {
    const driveRoot = process.cwd().slice(0, 3)
    const rootResult = await validateFolder(driveRoot)
    expect(rootResult.ok).toBe(false)
    expect(rootResult.reason).toContain('entire drive')

    const missing = await validateFolder(join(workDir, 'does-not-exist'))
    expect(missing.ok).toBe(false)

    const valid = await validateFolder(join(workDir, 'images'))
    expect(valid.ok).toBe(true)
  })

  it('detects overlapping source folders', () => {
    expect(isPathInsideOrEqual('G:\\art', 'G:\\art\\studies')).toBe(true)
    expect(isPathInsideOrEqual('G:\\art', 'G:\\art')).toBe(true)
    expect(isPathInsideOrEqual('G:\\art', 'G:\\artist')).toBe(false)
    expect(isPathInsideOrEqual('G:\\art', 'G:\\other')).toBe(false)
  })
})

describe('ScanManager', () => {
  it('indexes supported images recursively, creates previews, and never alters originals', async () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const scanners = new ScanManager(db!, join(workDir, 'thumbs'), {
      onEvent: () => undefined,
      onChanged: () => undefined
    })

    const hashesBefore = new Map<string, string>()
    for (const name of ['amber.jpg', 'blue.jpg', 'nested/green.png']) {
      const file = join(workDir, 'images', ...name.split('/'))
      hashesBefore.set(file, createHash('sha256').update(await fs.readFile(file)).digest('hex'))
    }

    const state = await waitForScan(scanners)
    expect(state.phase).toBe('done')
    expect(state.added).toBe(3)
    expect(state.errors).toBe(0)
    expect(db!.queryImages({ scope: 'archive', limit: 20 }).total).toBe(3)
    expect(db!.getRoot(root.id)?.imageCount).toBe(3)

    const images = db!.queryImages({ scope: 'archive', limit: 20 }).items
    expect(images.some((image) => image.filename === 'notes.txt')).toBe(false)
    expect(images.some((image) => image.filename === 'ignored.jpg')).toBe(false)
    expect(images.some((image) => image.width === 640 && image.height === 420)).toBe(true)
    for (const image of images) {
      await expect(fs.stat(join(workDir, 'thumbs', `${image.id}.webp`))).resolves.toBeTruthy()
    }

    for (const [file, hash] of hashesBefore) {
      const after = createHash('sha256').update(await fs.readFile(file)).digest('hex')
      expect(after).toBe(hash)
    }
  })

  it('skips unchanged files on rescan and picks up new ones', async () => {
    db!.addRoot(join(workDir, 'images'))
    const scanners = new ScanManager(db!, join(workDir, 'thumbs'), {
      onEvent: () => undefined,
      onChanged: () => undefined
    })

    await waitForScan(scanners)
    const second = await waitForScan(scanners)
    expect(second.phase).toBe('done')
    expect(second.added).toBe(0)
    expect(second.skipped).toBe(3)

    await makeImage(join(workDir, 'images', 'new-work.jpg'), '#8d7c54', 500, 500)
    const third = await waitForScan(scanners)
    expect(third.added).toBe(1)
    expect(third.skipped).toBe(3)
    expect(db!.queryImages({ scope: 'archive', limit: 20 }).total).toBe(4)
  })

  it('indexes a reused filename without replacing the moved picture or its preview', async () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const scans = new ScanManager(db!, join(workDir, 'thumbs'), { onEvent: () => undefined, onChanged: () => undefined })
    await waitForScan(scans)
    const source = join(root.path, 'blue.jpg')
    const id = db!.getImageFingerprint(source)!.id
    const preview = join(workDir, 'thumbs', id + '.webp')
    const before = await fs.readFile(preview)
    const dest = join(root.path, 'moved.jpg')
    await fs.rename(source, dest)
    const info = await fs.stat(dest)
    db!.relocateImage(id, { path: dest, bytes: info.size, mtime: Math.floor(info.mtimeMs), rootId: root.id })
    await makeImage(source, 'red')
    expect(await waitForScan(scans)).toMatchObject({ errors: 0, added: 1 })
    expect(db!.getImageFingerprint(source)!.id).not.toBe(id)
    expect(await fs.readFile(preview)).toEqual(before)
  })
})
