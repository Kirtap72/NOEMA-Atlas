import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'

let dir = ''
let db: AtlasDatabase

const minute = 60_000
const T0 = 1_800_000_000_000

function add(name: string, rootId: string, mtime: number, addedAt: number): string {
  const path = join(dir, 'pics', name)
  const record: ScannedImageRecord = { id: imageIdForPath(path), rootId, path, folder: join(dir, 'pics'), filename: name, ext: 'png', bytes: 10, width: 100, height: 100, orientation: 1, mtime, color: '#777777', thumbStatus: 'ready', thumbError: null, scanToken: 't' }
  db.upsertScannedImage(record)
  db.raw().prepare('UPDATE images SET added_at = ? WHERE id = ?').run(addedAt, record.id)
  return record.id
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noema-recent-'))
  db = new AtlasDatabase(join(dir, 'library.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('recently added', () => {
  it('shows pictures in the order Atlas indexed them, newest first, whatever the dates of the files are', () => {
    const root = db.addRoot(join(dir, 'pics'))
    // An old photograph imported just now, and a new file imported long ago.
    const oldFileNewImport = add('old-photo.png', root.id, T0 - 900 * 24 * 60 * minute, T0 + 10 * minute)
    const newFileOldImport = add('new-file.png', root.id, T0, T0 - 5 * 24 * 60 * minute)
    const page = db.queryImages({ scope: 'collection', sort: 'recent', limit: 10 })
    expect(page.items.map((i) => i.id)).toEqual([oldFileNewImport, newFileOldImport])
  })

  it('finds the imports: pictures indexed close together are one import, newest first, with their sources', () => {
    const a = db.addRoot(join(dir, 'pics'))
    const b = db.addRoot(join(dir, 'more'))
    for (let i = 0; i < 5; i += 1) add(`old-${i}.png`, a.id, T0, T0 - 3 * 24 * 60 * minute + i * 1000) // an import three days ago
    for (let i = 0; i < 181; i += 1) add(`new-${i}.png`, b.id, T0 - 4000 * minute, T0 + i * 800) // the latest: 181 pictures in a couple of minutes
    const batches = db.listImportBatches(5)
    expect(batches).toHaveLength(2)
    expect(batches[0]!.count).toBe(181)
    expect(batches[1]!.count).toBe(5)
    expect(batches[0]!.roots).toEqual([b.name])
    expect(batches[0]!.from).toBeLessThan(batches[0]!.to)
    expect(batches[0]!.to).toBeGreaterThan(batches[1]!.to)
  })

  it('shows one import as a collection, with the usual filters still working', () => {
    const root = db.addRoot(join(dir, 'pics'))
    const idsLatest: string[] = []
    for (let i = 0; i < 12; i += 1) idsLatest.push(add(`latest-${i}.png`, root.id, T0 - i * 1000, T0 + i * 1000))
    for (let i = 0; i < 30; i += 1) add(`earlier-${i}.png`, root.id, T0, T0 - 2 * 24 * 60 * minute + i * 1000)
    const batch = db.listImportBatches(3)[0]!
    const page = db.queryImages({ scope: 'collection', sort: 'recent', addedFrom: batch.from, addedTo: batch.to, limit: 100 })
    expect(page.items).toHaveLength(12)
    expect(page.items[0]!.id).toBe(idsLatest[11]) // newest first within the import
    // The same filters as the Collection: search, rating.
    db.updateImage({ id: idsLatest[3]!, rating: 5 })
    const rated = db.queryImages({ scope: 'collection', sort: 'recent', addedFrom: batch.from, addedTo: batch.to, minRating: 5, limit: 100 })
    expect(rated.items.map((i) => i.id)).toEqual([idsLatest[3]])
    const named = db.queryImages({ scope: 'collection', sort: 'recent', addedFrom: batch.from, addedTo: batch.to, search: 'latest-7', limit: 100 })
    expect(named.items.map((i) => i.filename)).toEqual(['latest-7.png'])
  })
})
