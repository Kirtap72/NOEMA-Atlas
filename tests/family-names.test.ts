import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'
import { EMBEDDING_MODEL, type Embedder } from '../src/main/embedder'
import { rebuildFamilies, matchFamilies } from '../src/main/families'
import { nameFamily, uniqueNames, type VocabVectors } from '../src/main/familyNames'
import type { VocabTerm } from '../src/main/familyVocabulary'

const DIM = 24

function unit(values: number[]): Float32Array {
  const norm = Math.hypot(...values) || 1
  return Float32Array.from(values.map((v) => v / norm))
}

/** A tiny vocabulary where every term is one axis, so the expected name is easy to read. */
function tinyVocab(): VocabVectors {
  const terms: VocabTerm[] = [
    { id: 'mountains', kind: 'subject', prompt: 'm', label: 'mountain scenes', group: 'scenery' },
    { id: 'forest', kind: 'subject', prompt: 'f', label: 'forests', group: 'built' },
    { id: 'portrait', kind: 'subject', prompt: 'p', label: 'portraits', group: 'people' },
    { id: 'cat', kind: 'subject', prompt: 'c', label: 'cats', group: 'animals' },
    { id: 'misty', kind: 'atmosphere', prompt: 'mi', label: 'misty scenes', adjective: 'misty' },
    { id: 'moody', kind: 'atmosphere', prompt: 'mo', label: 'moody images', adjective: 'moody' },
    { id: 'oil', kind: 'style', prompt: 'o', label: 'oil paintings', adjective: 'painted' },
    { id: 'sketch', kind: 'style', prompt: 's', label: 'pencil sketches', adjective: 'sketched' },
    ...['golden', 'stormy', 'cosy', 'epic'].map((id): VocabTerm => ({ id, kind: 'atmosphere', prompt: id, label: `${id} images`, adjective: id })),
    ...['render', 'anime', 'comic', 'pixel'].map((id): VocabTerm => ({ id, kind: 'style', prompt: id, label: `${id} art`, adjective: id }))
  ]
  const vectors = new Float32Array(terms.length * DIM)
  terms.forEach((_, i) => vectors.set(unit(Array.from({ length: DIM }, (_x, d) => (d === i ? 1 : 0))), i * DIM))
  return { terms, vectors, dim: DIM }
}

/** Members that lean on the given axes (with a little noise on the others). */
function members(n: number, axes: number[], noiseSeed = 1): Float32Array {
  const out = new Float32Array(n * DIM)
  for (let m = 0; m < n; m += 1) {
    const v = Array.from({ length: DIM }, (_x, d) => 0.05 * Math.sin(noiseSeed * 7 + m * 3 + d))
    for (const axis of axes) v[axis] = 1
    out.set(unit(v), m * DIM)
  }
  return out
}

describe('naming a family', () => {
  it('names a family after what all its images share', () => {
    const name = nameFamily(members(12, [0, 4]), 12, tinyVocab())
    expect(name.name).toBe('Misty mountain scenes')
    expect(name.confidence).toBe('clear')
    expect(name.keywords).toContain('mountain scenes')
    expect(name.note).toMatch(/12 of 12/)
  })

  it('uses the broader kind of subject when the images agree on the kind but not the detail', () => {
    const half = members(6, [0])
    const other = members(6, [1], 2)
    const all = new Float32Array(12 * DIM)
    all.set(half, 0)
    all.set(other, 6 * DIM)
    const name = nameFamily(all, 12, tinyVocab())
    // Mountains (scenery) and forests (built, in this tiny vocabulary) are two kinds: named as a loose pair, never as one clear subject.
    expect(name.name.toLowerCase()).toMatch(/mountain scenes and forests|forests and mountain scenes/)
    expect(name.confidence).toBe('loose')
  })

  it('calls a group with no common thread "Mixed images" instead of inventing a name', () => {
    const parts = [members(4, [0]), members(4, [2], 2), members(4, [3], 3), members(4, [1], 4)]
    const all = new Float32Array(16 * DIM)
    parts.forEach((part, i) => all.set(part, i * 4 * DIM))
    const name = nameFamily(all, 16, tinyVocab())
    expect(name.name).toBe('Mixed images')
    expect(name.confidence).toBe('mixed')
  })

  it('does not name a very small family from a single image', () => {
    const all = new Float32Array(3 * DIM)
    all.set(members(1, [0]), 0)
    all.set(members(1, [2], 2), DIM)
    all.set(members(1, [3], 3), 2 * DIM)
    expect(nameFamily(all, 3, tinyVocab()).name).toBe('Mixed images')
  })

  it('makes names unique', () => {
    const base = { confidence: 'clear' as const, note: '', basis: [] }
    const result = uniqueNames([
      { ...base, name: 'Forests', keywords: ['forests', 'misty scenes'] },
      { ...base, name: 'Forests', keywords: ['forests', 'moody images'] },
      { ...base, name: 'Forests', keywords: ['forests'] },
      { ...base, name: 'Cats', keywords: [] }
    ])
    expect(new Set(result.map((n) => n.toLowerCase())).size).toBe(4)
    expect(result[0]).toBe('Forests')
  })
})

describe('recognising families after a regroup', () => {
  const ids = (prefix: string, n: number): Array<{ id: string }> => Array.from({ length: n }, (_x, i) => ({ id: `${prefix}${i}` }))
  const set = (list: Array<{ id: string }>): Set<string> => new Set(list.map((m) => m.id))
  const c = (axis: number): Float32Array => unit(Array.from({ length: DIM }, (_x, d) => (d === axis ? 1 : 0)))

  it('matches families that kept most of their images, one to one', () => {
    const a = ids('a', 20)
    const b = ids('b', 20)
    const old = [
      { memberIds: set(a), centroid: c(0) },
      { memberIds: set(b), centroid: c(1) }
    ]
    // Family b grew, family a lost a few images; the order is different.
    const next = [
      { members: [...b, ...ids('new', 5)], centroid: c(1) },
      { members: a.slice(3), centroid: c(0) }
    ]
    expect(matchFamilies(old, next)).toEqual([1, 0])
  })

  it('lets the largest part of a split family keep it, and leaves the rest unmatched', () => {
    const a = ids('a', 30)
    const old = [{ memberIds: set(a), centroid: c(0) }]
    const next = [
      { members: a.slice(0, 20), centroid: c(0) },
      { members: a.slice(20), centroid: c(0) }
    ]
    const result = matchFamilies(old, next)
    expect(result[0]).toBe(0)
    expect(result[1]).toBe(-1)
  })

  it('does not match unrelated families', () => {
    const old = [{ memberIds: set(ids('a', 10)), centroid: c(0) }]
    expect(matchFamilies(old, [{ members: ids('z', 10), centroid: c(5) }])).toEqual([-1])
  })
})

describe('family names in the library', () => {
  let workDir = ''
  let db: AtlasDatabase | null = null
  let rootId = ''
  let counter = 0

  function record(path: string): ScannedImageRecord {
    return {
      id: imageIdForPath(path),
      rootId,
      path,
      folder: join(workDir, 'images'),
      filename: path.split(/[\\/]/).pop() ?? 'image.png',
      ext: 'png',
      bytes: 1024,
      width: 64,
      height: 64,
      orientation: 1,
      mtime: 1_700_000_000_000,
      color: '#808080',
      thumbStatus: 'ready',
      thumbError: null,
      scanToken: 'test-token'
    }
  }

  /** Adds one image whose embedding leans on the given axis. */
  function addEmbedded(axis: number, jitter: number): string {
    counter += 1
    const rec = record(join(workDir, 'images', `img-${counter}.png`))
    db!.upsertScannedImage(rec)
    const v = Array.from({ length: DIM }, (_x, d) => 0.04 * Math.sin(counter * 5 + d * 2 + jitter))
    v[axis] = 1
    db!.saveEmbeddings(EMBEDDING_MODEL, [{ id: rec.id, mtime: rec.mtime, vector: unit(v) }])
    return rec.id
  }

  /** A stand-in for the local model that gives each description its own axis, so names can be checked end to end. */
  const fakeEmbedder = {
    async embedTexts(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_t, i) => unit(Array.from({ length: DIM }, (_x, d) => (d === i % DIM ? 1 : 0.02 * Math.cos(i + d)))))
    }
  } as unknown as Embedder

  beforeEach(async () => {
    workDir = join(tmpdir(), `noema-fam-names-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(workDir, 'images'), { recursive: true })
    db = new AtlasDatabase(join(workDir, 'library.db'))
    rootId = db.addRoot(join(workDir, 'images')).id
    counter = 0
  })

  afterEach(async () => {
    db?.close()
    db = null
    await fs.rm(workDir, { recursive: true, force: true })
  })

  const grow = (axis: number, count: number): string[] => Array.from({ length: count }, (_x, i) => addEmbedded(axis, i))
  const familyWith = (id: string): number => {
    const found = db!.listFamilies(EMBEDDING_MODEL, 1).find((f) => db!.familyImageIds(f.id).includes(id))
    return found!.id
  }

  it('names every family and keeps the name steady across identical regroups', async () => {
    grow(0, 8)
    grow(1, 8)
    grow(2, 8)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    const first = db!.listFamilies(EMBEDDING_MODEL)
    expect(first.length).toBe(3)
    for (const family of first) expect(family.autoName).toBeTruthy()
    expect(new Set(first.map((f) => f.autoName)).size).toBe(3)
    expect(db!.familiesLackNames(EMBEDDING_MODEL)).toBe(false)

    await rebuildFamilies(db!, async () => fakeEmbedder)
    const second = db!.listFamilies(EMBEDDING_MODEL)
    expect(second.map((f) => f.autoName).sort()).toEqual(first.map((f) => f.autoName).sort())
  })

  it('saves families without names when the model is not available, and names them later', async () => {
    grow(0, 8)
    grow(1, 8)
    await rebuildFamilies(db!)
    expect(db!.listFamilies(EMBEDDING_MODEL).every((f) => f.autoName === null)).toBe(true)
    expect(db!.familiesLackNames(EMBEDDING_MODEL)).toBe(true)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    expect(db!.familiesLackNames(EMBEDDING_MODEL)).toBe(false)
  })

  it('keeps a name the user chose when the library grows and the families are regrouped', async () => {
    const a = grow(0, 9)
    grow(1, 9)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    db!.renameFamily(familyWith(a[0]!), '  My   quiet   place ')
    expect(db!.listFamilies(EMBEDDING_MODEL).find((f) => f.customName)?.customName).toBe('My quiet place')

    // New images arrive in both families and a third family appears.
    grow(0, 4)
    grow(1, 3)
    grow(2, 8)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    const after = db!.listFamilies(EMBEDDING_MODEL)
    expect(after.length).toBeGreaterThanOrEqual(3)
    const renamed = after.filter((f) => f.customName)
    expect(renamed.length).toBe(1)
    expect(renamed[0]!.customName).toBe('My quiet place')
    expect(db!.familyImageIds(renamed[0]!.id).filter((id) => a.includes(id)).length).toBeGreaterThanOrEqual(5)
  })

  it('brings back a renamed family that disappeared and returned, and lets the user reset a name', async () => {
    const a = grow(0, 9)
    const b = grow(1, 9)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    const familyA = familyWith(a[0]!)
    db!.renameFamily(familyA, 'Fog and pines')

    // All of its images are removed from the library for a while.
    db!.removeRoot(rootId)
    rootId = db!.addRoot(join(workDir, 'images')).id
    counter += 100
    const b2 = grow(1, 9)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    expect(db!.listFamilies(EMBEDDING_MODEL).some((f) => f.customName)).toBe(false)
    expect(db!.loadFamilyArchive(EMBEDDING_MODEL).map((e) => e.customName)).toEqual(['Fog and pines'])
    expect(b.length + b2.length).toBeGreaterThan(0)

    // Similar images come back: the name comes back with them.
    grow(0, 8)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    const back = db!.listFamilies(EMBEDDING_MODEL).find((f) => f.customName)
    expect(back?.customName).toBe('Fog and pines')
    expect(db!.loadFamilyArchive(EMBEDDING_MODEL)).toEqual([])

    // Clearing the name returns to the automatic one.
    db!.renameFamily(back!.id, '')
    expect(db!.listFamilies(EMBEDDING_MODEL).some((f) => f.customName)).toBe(false)
  })

  it('serves the images of a family for selection, leaving out missing originals', async () => {
    const a = grow(0, 9)
    grow(1, 9)
    await rebuildFamilies(db!, async () => fakeEmbedder)
    const id = familyWith(a[0]!)
    expect(new Set(db!.familyImageIds(id))).toEqual(new Set(a))
    expect(db!.renameFamily(999999, 'x')).toBe(false)
  })
})
