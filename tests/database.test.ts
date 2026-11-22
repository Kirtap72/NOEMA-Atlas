import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AtlasDatabase,
  imageIdForPath,
  normalizePath,
  normalizeTags
} from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'

sharp.cache(false)

let workDir = ''
let db: AtlasDatabase | null = null

function record(overrides: Partial<ScannedImageRecord> & { id: string; path: string; rootId: string }): ScannedImageRecord {
  return {
    folder: join(workDir, 'images'),
    filename: overrides.path.split(/[\\/]/).pop() ?? 'image.jpg',
    ext: 'jpg',
    bytes: 1024,
    width: 1200,
    height: 800,
    orientation: 1,
    mtime: 1_700_000_000_000,
    color: '#7c6a4a',
    thumbStatus: 'ready',
    thumbError: null,
    scanToken: 'test-token',
    ...overrides
  }
}

beforeEach(async () => {
  workDir = join(tmpdir(), `noema-db-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(join(workDir, 'images'), { recursive: true })
  await fs.mkdir(join(workDir, 'thumbs'), { recursive: true })
  db = new AtlasDatabase(join(workDir, 'library.db'))
})

afterEach(async () => {
  db?.close()
  db = null
  await new Promise((resolve) => setTimeout(resolve, 120))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

describe('AtlasDatabase', () => {
  it('requires a recoverable snapshot before upgrading a catalogue', async () => {
    const file = join(workDir, 'library.db')
    const backups = join(workDir, 'backups')
    db!.createMoodboard('Before upgrade')
    db!.raw().exec("UPDATE schema_meta SET value = '8' WHERE key = 'version'")
    db!.close()
    db = null
    await fs.writeFile(backups, 'occupied')
    expect(() => new AtlasDatabase(file)).toThrow(/back up the catalogue/)
    await fs.unlink(backups)
    db = new AtlasDatabase(file)
    const files = await fs.readdir(backups)
    expect(files).toHaveLength(1)
    const snapshot = new DatabaseSync(join(backups, files[0]!), { readOnly: true })
    try {
      expect(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
      expect(snapshot.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value).toBe('8')
      expect(snapshot.prepare('SELECT name FROM moodboards').get()?.name).toBe('Before upgrade')
    } finally {
      snapshot.close()
    }
  })
  it('indexes images centrally and persists favorites, ratings and tags across reopen', async () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const path = join(workDir, 'images', 'study-in-amber.jpg')
    const id = imageIdForPath(path)
    db!.upsertScannedImage(record({ id, path, rootId: root.id }))

    const updated = db!.updateImage({ id, favorite: true, rating: 4, tags: ['amber', 'light', 'amber'] })
    expect(updated.favorite).toBe(true)
    expect(updated.rating).toBe(4)
    expect(updated.tags).toEqual(['amber', 'light'])
    expect(updated.reviewedAt).not.toBeNull()
    expect(db!.getStats().favorites).toBe(1)
    expect(db!.getStats().totalBytes).toBe(1024)

    db!.close()
    db = new AtlasDatabase(join(workDir, 'library.db'))
    const reopened = db!.getImage(id)
    expect(reopened?.favorite).toBe(true)
    expect(reopened?.rating).toBe(4)
    expect(reopened?.tags).toEqual(['amber', 'light'])
  })

  it('searches filenames, folders and tags with FTS prefix matching', () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const p1 = join(workDir, 'images', 'Surreal Dreamscape.png')
    const p2 = join(workDir, 'images', 'quiet-harbour.jpg')
    db!.upsertScannedImage(record({ id: imageIdForPath(p1), path: p1, rootId: root.id, filename: 'Surreal Dreamscape.png' }))
    db!.upsertScannedImage(
      record({
        id: imageIdForPath(p2),
        path: p2,
        rootId: root.id,
        filename: 'quiet-harbour.jpg',
        thumbStatus: 'ready'
      })
    )
    db!.updateImage({ id: imageIdForPath(p2), tags: ['harbour', 'dusk'] })

    expect(db!.queryImages({ scope: 'archive', search: 'surr' }).total).toBe(1)
    expect(db!.queryImages({ scope: 'archive', search: 'dusk' }).total).toBe(1)
    expect(db!.queryImages({ scope: 'archive', search: 'images' }).total).toBe(2)
    expect(db!.queryImages({ scope: 'archive', search: 'nothing-here' }).total).toBe(0)
  })

  it('filters review queue, ratings and favorites without deleting archive entries', () => {
    const root = db!.addRoot(join(workDir, 'images'))
    for (let i = 0; i < 5; i += 1) {
      const path = join(workDir, 'images', `image-${i}.jpg`)
      db!.upsertScannedImage(record({ id: imageIdForPath(path), path, rootId: root.id, mtime: 1_700_000_000_000 + i }))
    }
    const ids = db!.queryImages({ scope: 'archive', limit: 20 }).items.map((item) => item.id)
    db!.updateImage({ id: ids[0]!, favorite: true, rating: 5 })
    db!.updateImage({ id: ids[1]!, rating: 3 })

    expect(db!.queryImages({ scope: 'favorites' }).total).toBe(1)
    expect(db!.queryImages({ scope: 'review' }).total).toBe(3)
    expect(db!.queryImages({ scope: 'archive', minRating: 3 }).total).toBe(2)
    expect(db!.queryImages({ scope: 'archive' }).total).toBe(5)
  })

  it('creates, reorders and removes moodboard entries while keeping the image catalogue intact', () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const ids = [0, 1, 2].map((i) => {
      const path = join(workDir, 'images', `board-${i}.jpg`)
      db!.upsertScannedImage(record({ id: imageIdForPath(path), path, rootId: root.id, mtime: 1_700_000_000_000 + i }))
      return imageIdForPath(path)
    })

    const board = db!.createMoodboard('Amber studies')
    db!.addToMoodboard(board.id, ids)
    expect(db!.getMoodboard(board.id)?.images.map((image) => image.id)).toEqual(ids)

    db!.reorderMoodboard(board.id, [ids[2]!, ids[0]!, ids[1]!])
    expect(db!.getMoodboard(board.id)?.images.map((image) => image.id)).toEqual([ids[2], ids[0], ids[1]])
    expect(db!.getMoodboardsForImage(ids[0]!)).toEqual([board.id])

    db!.removeFromMoodboard(board.id, ids[0]!)
    expect(db!.getMoodboard(board.id)?.images.map((image) => image.id)).toEqual([ids[2], ids[1]])
    expect(db!.queryImages({ scope: 'archive' }).total).toBe(3)
    db!.deleteMoodboard(board.id)
    expect(db!.listMoodboards()).toHaveLength(0)
    expect(db!.queryImages({ scope: 'archive' }).total).toBe(3)
  })

  it('persists board layouts beyond the viewport and starts new items at their image proportion', () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const landscapePath = join(workDir, 'images', 'wide.jpg')
    const portraitPath = join(workDir, 'images', 'tall.jpg')
    db!.upsertScannedImage(record({ id: imageIdForPath(landscapePath), path: landscapePath, rootId: root.id, width: 1600, height: 900 }))
    db!.upsertScannedImage(record({ id: imageIdForPath(portraitPath), path: portraitPath, rootId: root.id, width: 700, height: 1400 }))
    const board = db!.createMoodboard('Unlimited')
    const wideId = imageIdForPath(landscapePath)
    const tallId = imageIdForPath(portraitPath)
    db!.addToMoodboard(board.id, [wideId])
    db!.addToMoodboard(board.id, [tallId])

    const placed = db!.updateBoardItem({
      moodboardId: board.id,
      imageId: wideId,
      x: -1.75,
      y: 4.2,
      width: 2.4,
      height: 1.35,
      z: 12
    })
    const wide = placed.images.find((image) => image.id === wideId)
    expect(wide).toMatchObject({ x: -1.75, y: 4.2, layoutWidth: 2.4, layoutHeight: 1.35, z: 12 })

    const tall = placed.images.find((image) => image.id === tallId)!
    const frameAspect = (tall.layoutWidth * 1500) / (tall.layoutHeight * 1000)
    expect(frameAspect).toBeCloseTo(700 / 1400, 2)
  })

  it('removes only catalogue metadata when a source is removed', async () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const path = join(workDir, 'images', 'original-to-preserve.jpg')
    await fs.writeFile(path, 'this is the original file')
    const before = createHash('sha256').update(await fs.readFile(path)).digest('hex')
    db!.upsertScannedImage(record({ id: imageIdForPath(path), path, rootId: root.id }))

    const removedIds = db!.removeRoot(root.id)
    expect(removedIds).toEqual([imageIdForPath(path)])
    expect(db!.queryImages({ scope: 'archive' }).total).toBe(0)
    await expect(fs.stat(path)).resolves.toBeTruthy()
    const after = createHash('sha256').update(await fs.readFile(path)).digest('hex')
    expect(after).toBe(before)
  })

  it('marks unseen files as missing only when a completed scan asks for it', () => {
    const root = db!.addRoot(join(workDir, 'images'))
    const path = join(workDir, 'images', 'kept.jpg')
    const id = imageIdForPath(path)
    db!.upsertScannedImage(record({ id, path, rootId: root.id }))
    expect(db!.getImage(id)?.missing).toBe(false)

    db!.beginScan(root.id)
    db!.finishScan(root.id, 'new-token', false)
    expect(db!.getImage(id)?.missing).toBe(false)

    db!.beginScan(root.id)
    const result = db!.finishScan(root.id, 'new-token', true)
    expect(result.missing).toBe(1)
    expect(db!.getImage(id)?.missing).toBe(true)
    expect(db!.queryImages({ scope: 'archive' }).total).toBe(0)
    expect(db!.queryImages({ scope: 'archive', includeMissing: true }).total).toBe(1)
  })

  it('normalizes tags and Windows paths', () => {
    expect(normalizeTags(['  light ', 'Light', 'warm   amber', ''])).toEqual(['light', 'warm amber'])
    expect(normalizePath('G:/pictures 26/')).toBe('G:\\pictures 26')
    expect(imageIdForPath('G:/Pictures/A.JPG')).toBe(imageIdForPath('g:\\pictures\\a.jpg'))
  })
})

describe('media generation', () => {
  it('writes a preview without changing the original file', async () => {
    const { createThumbnail } = await import('../src/main/media')
    const source = join(workDir, 'images', 'source.png')
    await sharp({
      create: { width: 1600, height: 900, channels: 3, background: '#b98345' }
    })
      .png()
      .toFile(source)
    const sourceBefore = createHash('sha256').update(await fs.readFile(source)).digest('hex')
    const destination = join(workDir, 'thumbs', 'abc.webp')
    const result = await createThumbnail(source, destination)

    expect(result.status).toBe('ready')
    expect(result.width).toBe(1600)
    expect(result.height).toBe(900)
    expect(result.color).toMatch(/^#[0-9a-f]{6}$/)
    const thumb = await fs.stat(destination)
    expect(thumb.size).toBeGreaterThan(0)
    const reader = sharp(destination)
    const metadata = await reader.metadata()
    await reader.destroy()
    expect(metadata.format).toBe('webp')
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(960)
    const sourceAfter = createHash('sha256').update(await fs.readFile(source)).digest('hex')
    expect(sourceAfter).toBe(sourceBefore)
  })
})
