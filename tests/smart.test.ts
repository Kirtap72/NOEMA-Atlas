import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'
import { EMBEDDING_MODEL, type Embedder } from '../src/main/embedder'
import { SemanticSearch } from '../src/main/semantic'
import { SmartCollections } from '../src/main/smartCollections'
import { analyzeRgb, colourFit, encodeHues, toneFit, vividnessFit } from '../src/main/imageStats'
import { fitCutoff, floorFraction, match, shapeMatches, type MeasuredImage } from '../src/main/smartMatch'
import { criteriaAreEmpty, detectAesthetics, emptyCriteria, normalizeCriteria } from '../src/shared/smart'

const DIM = 12

function unit(values: number[]): Float32Array {
  const norm = Math.hypot(...values) || 1
  return Float32Array.from(values.map((v) => v / norm))
}

/** Pixels of one flat colour. */
function flat(r: number, g: number, b: number, n = 64): Uint8Array {
  const out = new Uint8Array(n * 3)
  for (let i = 0; i < n; i += 1) out.set([r, g, b], i * 3)
  return out
}

describe('reading a description', () => {
  it('finds the measurable words and leaves mood and subject to the model', () => {
    expect(detectAesthetics('teal-toned surreal portraits').colours).toEqual(['teal'])
    expect(detectAesthetics('melancholic landscapes')).toEqual({ colours: [], tone: 'any', vividness: 'any' })
    expect(detectAesthetics('warm cinematic interiors').colours).toEqual(['warm'])
    const noir = detectAesthetics('dark moody black and white street photography')
    expect(noir.tone).toBe('dark')
    expect(noir.vividness).toBe('mono')
    expect(detectAesthetics('bright pastel kitchens')).toMatchObject({ tone: 'bright', vividness: 'muted' })
  })

  it('does not take colour words out of other words, and lets a named hue replace "warm"', () => {
    expect(detectAesthetics('a redundant arrangement').colours).toEqual([])
    expect(detectAesthetics('warm orange sunsets').colours).toEqual(['orange'])
    expect(detectAesthetics('Teal and Orange cinematic').colours).toEqual(['orange', 'teal'])
  })

  it('cleans criteria that arrive from outside', () => {
    const value = normalizeCriteria({ text: '  a   b  ', colours: ['teal', 'nope', 'teal'], tone: 'weird', strictness: 900, likes: ['a', 'b'], dislikes: ['b'], shape: 'square' })
    expect(value.text).toBe('a b')
    expect(value.colours).toEqual(['teal'])
    expect(value.tone).toBe('any')
    expect(value.strictness).toBe(100)
    expect(value.likes).toEqual(['a'])
    expect(value.dislikes).toEqual(['b'])
    expect(normalizeCriteria(null)).toEqual(emptyCriteria())
    expect(criteriaAreEmpty(emptyCriteria())).toBe(true)
    expect(criteriaAreEmpty({ ...emptyCriteria(), colours: ['teal'] })).toBe(false)
  })
})

describe('measuring colour', () => {
  it('knows teal from red, and warm from cool', () => {
    const teal = analyzeRgb(flat(20, 150, 150), 64)
    expect(colourFit(teal, 'teal')).toBeGreaterThan(0.9)
    expect(colourFit(teal, 'red')).toBe(0)
    expect(colourFit(teal, 'cool')).toBeGreaterThan(0.7)
    expect(colourFit(teal, 'warm')).toBe(0)
    const orange = analyzeRgb(flat(230, 130, 40), 64)
    expect(colourFit(orange, 'orange')).toBeGreaterThan(0.9)
    expect(colourFit(orange, 'warm')).toBeGreaterThan(0.7)
    expect(colourFit(orange, 'teal')).toBe(0)
  })

  it('tells dark from bright and grey from vivid', () => {
    const dark = analyzeRgb(flat(18, 22, 30), 64)
    const bright = analyzeRgb(flat(240, 235, 225), 64)
    expect(toneFit(dark, 'dark')).toBe(1)
    expect(toneFit(bright, 'dark')).toBe(0)
    expect(toneFit(bright, 'bright')).toBe(1)
    const grey = analyzeRgb(flat(128, 128, 128), 64)
    expect(vividnessFit(grey, 'mono')).toBe(1)
    expect(vividnessFit(grey, 'vivid')).toBe(0)
    const loud = analyzeRgb(flat(255, 20, 20), 64)
    expect(vividnessFit(loud, 'vivid')).toBe(1)
    expect(vividnessFit(loud, 'mono')).toBe(0)
  })

  it('does not count grey or near-black pixels as any hue', () => {
    const stats = analyzeRgb(flat(90, 90, 90), 64)
    expect(Array.from(stats.hues).reduce((a, b) => a + b, 0)).toBe(0)
    expect(colourFit(stats, 'teal')).toBe(0)
  })
})

/** 60 images in three looks on three axes; every third A image is teal, the rest red. */
function synthetic(): { ids: string[]; matrix: Float32Array; stats: Map<string, MeasuredImage>; shapes: Map<string, { width: number; height: number }> } {
  const ids: string[] = []
  const rows: Float32Array[] = []
  const stats = new Map<string, MeasuredImage>()
  const shapes = new Map<string, { width: number; height: number }>()
  for (let i = 0; i < 60; i += 1) {
    const axis = i % 3
    const id = `img-${i}`
    ids.push(id)
    const v = Array.from({ length: DIM }, (_x, d) => 0.03 * Math.sin(i * 3 + d * 5))
    v[axis] = 1
    rows.push(unit(v))
    const teal = axis === 0 && i % 2 === 0
    stats.set(id, { ...analyzeRgb(teal ? flat(20, 150, 150) : flat(190, 50, 40), 64), width: 100, height: i % 5 === 0 ? 150 : 100 })
    shapes.set(id, { width: 100, height: i % 5 === 0 ? 150 : 100 })
  }
  const matrix = new Float32Array(rows.length * DIM)
  rows.forEach((row, index) => matrix.set(row, index * DIM))
  return { ids, matrix, stats, shapes }
}

describe('matching', () => {
  const data = synthetic()
  const text = unit(Array.from({ length: DIM }, (_x, d) => (d === 0 ? 1 : 0)))
  const base: Omit<Parameters<typeof match>[0], 'criteria'> = { ids: data.ids, dim: DIM, matrix: data.matrix, text, avoid: null, stats: data.stats, shapes: data.shapes }
  const run = (change: Partial<ReturnType<typeof emptyCriteria>>, input: Partial<typeof base> = {}) => match({ ...base, ...input, criteria: { ...emptyCriteria(), text: 'x', ...change } })

  it('finds the images that look like the description', () => {
    const result = run({})
    expect(result.members.length).toBeGreaterThan(5)
    expect(result.members.every((m) => Number(m.id.split('-')[1]) % 3 === 0)).toBe(true)
    expect(result.members[0]!.match).toBeGreaterThanOrEqual(result.members.at(-1)!.match)
  })

  it('returns more images when relaxed and fewer when strict', () => {
    const relaxed = run({ strictness: 0 }).members.length
    const strict = run({ strictness: 100 }).members.length
    expect(relaxed).toBeGreaterThanOrEqual(strict)
    expect(floorFraction(0)).toBeLessThan(floorFraction(100))
    expect(fitCutoff(0)).toBeLessThan(fitCutoff(100))
  })

  it('combines the description with a measured colour', () => {
    const teal = run({ colours: ['teal'] })
    expect(teal.members.length).toBeGreaterThan(0)
    // Only the teal images of the first look: even numbers that are multiples of three.
    expect(teal.members.every((m) => Number(m.id.split('-')[1]) % 6 === 0)).toBe(true)
    const red = run({ colours: ['red'] })
    expect(red.members.every((m) => Number(m.id.split('-')[1]) % 6 === 3)).toBe(true)
  })

  it('works from colour alone, without any model', () => {
    const result = match({ ...base, text: null, ids: [], matrix: new Float32Array(0), criteria: { ...emptyCriteria(), colours: ['teal'] } })
    expect(result.semantic).toBe(false)
    expect(result.members.length).toBe(10)
  })

  it('counts images whose colour is not measured yet instead of guessing', () => {
    const partial = new Map(data.stats)
    for (const id of data.ids.slice(0, 30)) partial.delete(id)
    const result = run({ colours: ['teal'] }, { stats: partial })
    expect(result.unmeasured).toBeGreaterThan(0)
    expect(result.members.every((m) => partial.has(m.id))).toBe(true)
  })

  it('keeps pinned images in, rules out the others, and honours shape', () => {
    const pinned = run({ likes: ['img-1'] })
    expect(pinned.members.some((m) => m.id === 'img-1')).toBe(true)
    const ruled = run({ dislikes: ['img-0', 'img-3'] })
    expect(ruled.members.some((m) => m.id === 'img-0' || m.id === 'img-3')).toBe(false)
    const upright = run({ shape: 'portrait' })
    expect(upright.members.length).toBeGreaterThan(0)
    expect(upright.members.every((m) => Number(m.id.split('-')[1]) % 5 === 0)).toBe(true)
    expect(shapeMatches('square', 100, 100)).toBe(true)
    expect(shapeMatches('landscape', 100, 100)).toBe(false)
  })

  it('looks for more like the pinned images when there is no description', () => {
    const result = match({ ...base, text: null, criteria: { ...emptyCriteria(), likes: ['img-2', 'img-5'] } })
    // img-2 and img-5 belong to the third look (axis 2).
    expect(result.members.filter((m) => Number(m.id.split('-')[1]) % 3 === 2).length).toBeGreaterThan(10)
    expect(result.members.slice(0, 2).map((m) => m.id).sort()).toEqual(['img-2', 'img-5'])
  })

  it('drops images that look like the "not like this" description', () => {
    const avoid = unit(Array.from({ length: DIM }, (_x, d) => (d === 0 ? 1 : 0)))
    const withAvoid = run({ avoid: 'x' }, { avoid })
    expect(withAvoid.members.length).toBe(0)
  })
})

describe('saving, refreshing and learning about new images', () => {
  let workDir = ''
  let db: AtlasDatabase | null = null
  let rootId = ''
  let counter = 0
  let changes = 0
  let smart: SmartCollections | null = null
  let semanticSearch: SemanticSearch | null = null
  const raw = (): DatabaseSync => (db as unknown as { db: DatabaseSync }).db

  const fakeEmbedder = {
    async embedTexts(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => unit(Array.from({ length: DIM }, (_x, d) => (d === (t.includes('sea') ? 0 : 1) ? 1 : 0))))
    }
  } as unknown as Embedder

  function add(axis: number, teal: boolean): string {
    counter += 1
    const path = join(workDir, 'images', `img-${counter}.png`)
    const rec: ScannedImageRecord = {
      id: imageIdForPath(path),
      rootId,
      path,
      folder: join(workDir, 'images'),
      filename: `img-${counter}.png`,
      ext: 'png',
      bytes: 1024,
      width: 100,
      height: 100,
      orientation: 1,
      mtime: 1_700_000_000_000,
      color: '#808080',
      thumbStatus: 'ready',
      thumbError: null,
      scanToken: 'test-token'
    }
    db!.upsertScannedImage(rec)
    const v = Array.from({ length: DIM }, (_x, d) => 0.03 * Math.sin(counter * 5 + d))
    v[axis] = 1
    db!.saveEmbeddings(EMBEDDING_MODEL, [{ id: rec.id, mtime: rec.mtime, vector: unit(v) }])
    const stats = analyzeRgb(teal ? flat(20, 150, 150) : flat(190, 50, 40), 64)
    db!.saveImageStats([{ id: rec.id, mtime: rec.mtime, lightness: stats.lightness, contrast: stats.contrast, saturation: stats.saturation, hues: encodeHues(stats.hues) }])
    return rec.id
  }

  beforeEach(async () => {
    workDir = join(tmpdir(), `noema-smart-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(workDir, 'images'), { recursive: true })
    db = new AtlasDatabase(join(workDir, 'library.db'))
    rootId = db.addRoot(join(workDir, 'images')).id
    counter = 0
    changes = 0
    semanticSearch = new SemanticSearch(db, async () => fakeEmbedder)
    smart = new SmartCollections(db, semanticSearch, { modelReady: () => true, onChanged: () => (changes += 1) })
    for (let i = 0; i < 12; i += 1) add(0, i % 2 === 0)
    for (let i = 0; i < 24; i += 1) add(1, false)
  })

  afterEach(async () => {
    db?.close()
    db = null
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('previews without saving anything', async () => {
    const preview = await smart!.preview({ ...emptyCriteria(), text: 'the sea' }, 60, 0)
    expect(preview.total).toBeGreaterThan(5)
    expect(preview.items[0]!.match).toBeGreaterThan(0)
    expect(preview.explanation).toContain('the sea')
    expect(smart!.list()).toHaveLength(0)
  })

  it('saves a collection with its matches and keeps files untouched', async () => {
    const saved = await smart!.create({ name: 'Sea', criteria: { ...emptyCriteria(), text: 'the sea', colours: ['teal'] } })
    expect(saved.name).toBe('Sea')
    expect(saved.size).toBe(6)
    expect(saved.newCount).toBe(0)
    expect(saved.covers.length).toBe(3)
    const page = db!.queryImages({ scope: 'archive', smartId: saved.id, limit: 50, offset: 0 })
    expect(page.total).toBe(6)
    expect(db!.smartImageIds(saved.id)).toHaveLength(6)
  })

  it('adds new matching images automatically and reports them as new until viewed', async () => {
    const saved = await smart!.create({ name: 'Sea', criteria: { ...emptyCriteria(), text: 'the sea', colours: ['teal'] } })
    add(0, true)
    add(0, false) // looks like the sea but is red: not teal
    add(1, true) // teal but not the sea
    semanticSearch!.invalidate()
    await smart!.refreshAll()
    const after = smart!.get(saved.id)!
    expect(after.size).toBe(7)
    expect(after.newCount).toBe(1)
    smart!.markViewed(saved.id)
    expect(smart!.get(saved.id)!.newCount).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  it('removes images that are no longer in the library from the counts', async () => {
    const saved = await smart!.create({ name: 'Sea', criteria: { ...emptyCriteria(), text: 'the sea' } })
    const before = saved.size
    const gone = db!.smartImageIds(saved.id)[0]!
    raw().prepare('UPDATE images SET missing = 1 WHERE id = ?').run(gone)
    expect(smart!.get(saved.id)!.size).toBe(before - 1)
  })

  it('refines and renames a saved collection', async () => {
    const saved = await smart!.create({ name: 'Sea', criteria: { ...emptyCriteria(), text: 'the sea' } })
    const stricter = await smart!.update(saved.id, { name: 'Blue sea', criteria: { ...saved.criteria, colours: ['teal'] } })
    expect(stricter.name).toBe('Blue sea')
    expect(stricter.size).toBe(6)
    expect(stricter.criteria.colours).toEqual(['teal'])
    await expect(smart!.update(saved.id, { criteria: emptyCriteria() })).rejects.toThrow()
  })

  it('refuses an empty description and deletes only the collection', async () => {
    await expect(smart!.create({ name: 'Nothing', criteria: emptyCriteria() })).rejects.toThrow()
    const saved = await smart!.create({ name: 'Sea', criteria: { ...emptyCriteria(), text: 'the sea' } })
    const images = (raw().prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n
    expect(smart!.remove(saved.id)).toBe(true)
    expect(smart!.list()).toHaveLength(0)
    expect((raw().prepare('SELECT COUNT(*) AS n FROM images').get() as { n: number }).n).toBe(images)
    expect((raw().prepare('SELECT COUNT(*) AS n FROM smart_members').get() as { n: number }).n).toBe(0)
  })

  it('keeps the old matches when the model is switched off', async () => {
    const saved = await smart!.create({ name: 'Sea', criteria: { ...emptyCriteria(), text: 'the sea' } })
    const off = new SmartCollections(db!, new SemanticSearch(db!, async () => fakeEmbedder), { modelReady: () => false, onChanged: () => undefined })
    await off.refreshAll()
    expect(off.get(saved.id)!.size).toBe(saved.size)
    const preview = await off.preview({ ...emptyCriteria(), text: 'the sea' }, 10, 0)
    expect(preview.problem).toContain('image model')
    // Colour alone still works without the model.
    const colour = await off.preview({ ...emptyCriteria(), colours: ['teal'] }, 10, 0)
    expect(colour.problem).toBeNull()
    expect(colour.total).toBe(6)
  })
})
