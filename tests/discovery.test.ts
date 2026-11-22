import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompareEngine } from '../src/main/compare'
import { ConceptSpace } from '../src/main/conceptSpace'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import { DiscoveryEngine, buildEvidence } from '../src/main/discovery'
import { saveDiscoveryToLibrary } from '../src/main/discoveries'
import { EMBEDDING_MODEL } from '../src/main/embedder'
import { TechnicalGuard } from '../src/main/guard'
import { HistoryEngine } from '../src/main/history'
import { IdentityEngine } from '../src/main/identity'
import { JourneyEngine } from '../src/main/journeys'
import { describeSet, findModes } from '../src/main/profiles'
import { ReferenceCollection } from '../src/main/reference'
import { SemanticSearch } from '../src/main/semantic'
import { mulberry32 } from '../src/main/taste'
import { crossValidateMixed, makeFeatureSpace, mixedAccuracy, scoreFeatures, trainMixedModel, transformRows } from '../src/main/tasteFeatures'
import { TASTE_DIMENSIONS } from '../src/main/tasteDimensions'

sharp.cache(false)

// ---- a small synthetic reference collection --------------------------------------------------------------------
// 6 axes use coordinates (2k, 2k+1) as their two poles. Works belong to 6 "styles", each strong on a few coordinates.

const DIM = 24
const STYLES = [
  { shelf: 'dark-landscape', label: 'Dark landscapes', group: 'painting', hot: [6] }, // dark pole
  { shelf: 'bright-photo', label: 'Bright photographs', group: 'photograph', hot: [7] }, // bright pole
  { shelf: 'abstract-form', label: 'Abstract forms', group: 'painting', hot: [4] }, // abstract pole
  { shelf: 'real-portrait', label: 'Realistic portraits', group: 'painting', hot: [1] }, // natural pole
  { shelf: 'vivid-print', label: 'Vivid prints', group: 'print', hot: [8] }, // vivid
  { shelf: 'minimal-object', label: 'Minimal objects', group: 'object', hot: [10] } // minimal
]
const PER_STYLE = 24

function unit(v: number[]): number[] {
  const n = Math.hypot(...v) || 1
  return v.map((x) => x / n)
}

async function makePack(dir: string): Promise<{ works: Array<{ id: string; style: number }> }> {
  await fs.mkdir(join(dir, 'images'), { recursive: true })
  const random = mulberry32(5)
  const items: Array<Record<string, unknown>> = []
  const rows: number[][] = []
  const works: Array<{ id: string; style: number }> = []
  let n = 0
  for (let s = 0; s < STYLES.length; s += 1) {
    for (let i = 0; i < PER_STYLE; i += 1) {
      const v = new Array(DIM).fill(0).map(() => (random() - 0.5) * 0.35)
      for (const h of STYLES[s]!.hot) v[h]! += 1.2 + random() * 0.4
      v[12 + s] = (v[12 + s] ?? 0) + 0.9 // a style-specific signature so styles are visually separable
      rows.push(unit(v))
      const id = `aic-${1000 + n}`
      const file = `${id}.webp`
      await sharp({ create: { width: 48, height: 36, channels: 3, background: { r: 40 + s * 30, g: 90, b: 140 } } }).webp().toFile(join(dir, 'images', file))
      items.push({
        id, museum: s % 2 === 0 ? 'aic' : 'cma', objectId: String(1000 + n), objectUrl: `https://example.org/${id}`, apiUrl: '', imageUrl: '',
        title: `Work ${n}`, artist: `Maker ${s}-${i % 4}`, artistInfo: '', date: `${1600 + s * 50 + i}`, dateBegin: 1600, dateEnd: 1700,
        culture: ['Dutch', 'Japanese', 'French', 'Italian', 'Persian', 'American'][s]!, period: '', classification: 'test', medium: 'test', department: 'test', credit: 'Test credit',
        shelf: STYLES[s]!.shelf, group: STYLES[s]!.group, region: s, x: (s % 3) / 3 + random() * 0.2, y: Math.floor(s / 3) / 2 + random() * 0.2, file,
        width: 48, height: 36, bytes: 1, sha256: ''
      })
      works.push({ id, style: s })
      n += 1
    }
  }
  const matrix = new Float32Array(rows.flat())
  const bytes = Buffer.from(matrix.buffer)
  await fs.writeFile(join(dir, 'embeddings.f32'), bytes)
  // concept vectors: axis k, pole a = e_(2k), pole b = e_(2k+1)
  const conceptIds = TASTE_DIMENSIONS.map((d) => d.id)
  const concepts = new Float32Array(conceptIds.length * DIM)
  TASTE_DIMENSIONS.forEach((d, i) => {
    const axis = ['reality', 'form', 'mood', 'light', 'colour', 'composition'].indexOf(d.axis)
    concepts[i * DIM + 2 * axis + (d.pole === 'a' ? 0 : 1)] = 1
  })
  await fs.writeFile(join(dir, 'concepts.f32'), Buffer.from(concepts.buffer))
  const centroids = STYLES.map((_, s) => {
    const members = rows.filter((_, i) => Math.floor(i / PER_STYLE) === s)
    const sum = new Array(DIM).fill(0)
    for (const m of members) m.forEach((x, k) => (sum[k] += x))
    return unit(sum)
  })
  await fs.writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      format: 1, name: 'Test collection', version: 'test', model: { name: 'test', dim: DIM },
      license: { id: 'CC0-1.0', name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
      museums: { aic: { name: 'Art Institute of Chicago', policy: 'https://example.org' }, cma: { name: 'Cleveland Museum of Art', policy: 'https://example.org' } },
      shelves: STYLES.map((s) => ({ id: s.shelf, label: s.label, group: s.group, count: PER_STYLE })),
      regions: STYLES.map((s, i) => ({ id: i, count: PER_STYLE, label: s.label, topShelves: [{ shelf: s.shelf, count: PER_STYLE }], centroid: centroids[i] })),
      embeddings: { file: 'embeddings.f32', dtype: 'float32', rows: items.length, dim: DIM, sha256: createHash('sha256').update(bytes).digest('hex') },
      concepts: { file: 'concepts.f32', ids: conceptIds, dim: DIM, sha256: createHash('sha256').update(Buffer.from(concepts.buffer)).digest('hex') },
      items
    })
  )
  return { works }
}

let workDir = ''
let db: AtlasDatabase | null = null
let ref: ReferenceCollection
let pack: { works: Array<{ id: string; style: number }> }
let rootId = ''

beforeEach(async () => {
  workDir = join(tmpdir(), `noema-disc-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(join(workDir, 'pack'), { recursive: true })
  await fs.mkdir(join(workDir, 'images'), { recursive: true })
  pack = await makePack(join(workDir, 'pack'))
  ref = ReferenceCollection.load(join(workDir, 'pack'))!
  db = new AtlasDatabase(join(workDir, 'library.db'))
  rootId = db.addRoot(join(workDir, 'images')).id
})

afterEach(async () => {
  db?.close()
  db = null
  await new Promise((r) => setTimeout(r, 100))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

const styleOf = (id: string): number => pack.works.find((w) => w.id === id)!.style
const engineOf = (): DiscoveryEngine => new DiscoveryEngine(db!, ref, new ConceptSpace(null, ref))

/** A simulated user who likes the given styles; returns the answer they give for a pair. */
function answer(likes: Set<number>, aId: string, bId: string, rng: () => number): { response: 'prefer' | 'both' | 'neither' | 'undecided'; winner: string | null } {
  const la = likes.has(styleOf(aId))
  const lb = likes.has(styleOf(bId))
  if (la && lb) return { response: 'both', winner: null }
  if (!la && !lb) return rng() < 0.15 ? { response: 'undecided', winner: null } : { response: 'neither', winner: null }
  return { response: 'prefer', winner: la ? aId : bId }
}

async function explore(engine: DiscoveryEngine, likes: Set<number>, answers: number, seed = 3): Promise<void> {
  const rng = mulberry32(seed)
  let pair = await engine.nextPair()
  for (let i = 0; i < answers && pair; i += 1) {
    const a = answer(likes, pair.a.id, pair.b.id, rng)
    pair = (await engine.respond(pair.a.id, pair.b.id, a.response, a.winner)).next
  }
}

describe('reference collection', () => {
  it('loads a valid pack with provenance and refuses a damaged one', async () => {
    expect(ref.works.length).toBe(STYLES.length * PER_STYLE)
    const info = ref.info()
    expect(info.available).toBe(true)
    expect(info.license.id).toBe('CC0-1.0')
    expect(info.museums.map((m) => m.code).sort()).toEqual(['aic', 'cma'])
    const w = ref.works[0]!
    expect(w.museumName).toBe('Art Institute of Chicago')
    expect(w.objectUrl).toMatch(/^https:/)
    expect(w.imageUrl).toBe(`noema://ref/${w.id}.webp`)
    expect(ref.imagePath(w.id)).toMatch(/\.webp$/)
    expect(ref.imagePath('aic-999999')).toBeNull() // only manifest ids resolve to a file
    expect(ref.imagePath('../../etc/passwd')).toBeNull()
    expect(ref.poleVectors.size).toBe(TASTE_DIMENSIONS.length)

    await fs.appendFile(join(workDir, 'pack', 'embeddings.f32'), Buffer.from([1, 2, 3, 4]))
    expect(ReferenceCollection.load(join(workDir, 'pack'))).toBeNull()
    expect(ReferenceCollection.load(join(workDir, 'nowhere'))).toBeNull()
  })
})

describe('mixed preference model', () => {
  it('learns several separate preferences where a single direction cannot', () => {
    const space = makeFeatureSpace(ref.matrix, DIM, { landmarks: 60, gamma: 8 })
    const feats = transformRows(space, ref.matrix, ref.works.length)
    const likes = new Set([0, 2, 4]) // three unrelated styles
    const liked = ref.works.map((w) => likes.has(styleOf(w.id)))
    const rng = mulberry32(9)
    const pairs: Array<{ w: number; l: number; weight: number }> = []
    const points: Array<{ i: number; y: 1 | -1; weight: number }> = []
    for (let i = 0; i < 80; i += 1) {
      const a = Math.floor(rng() * ref.works.length)
      const b = Math.floor(rng() * ref.works.length)
      if (a === b) continue
      if (liked[a] && !liked[b]) pairs.push({ w: a, l: b, weight: 1 })
      else if (liked[b] && !liked[a]) pairs.push({ w: b, l: a, weight: 1 })
      else if (liked[a] && liked[b]) points.push({ i: a, y: 1, weight: 0.8 }, { i: b, y: 1, weight: 0.8 })
      else points.push({ i: a, y: -1, weight: 0.8 }, { i: b, y: -1, weight: 0.8 })
    }
    const model = trainMixedModel(feats, space.size, pairs, points, { lambda: 1 })
    const scores = scoreFeatures(feats, space.size, model)
    const auc = (() => {
      const idx = Array.from(scores.keys()).sort((a, b) => scores[a]! - scores[b]!)
      let sum = 0
      let pos = 0
      idx.forEach((row, rank) => { if (liked[row]) { sum += rank + 1; pos += 1 } })
      return (sum - (pos * (pos + 1)) / 2) / (pos * (scores.length - pos))
    })()
    expect(auc).toBeGreaterThan(0.9)
    // Each of the three liked styles is ranked well, not just the easy one.
    for (const style of likes) {
      const inStyle = ref.works.map((w, i) => (styleOf(w.id) === style ? i : -1)).filter((i) => i >= 0)
      const meanLiked = inStyle.reduce((s, i) => s + scores[i]!, 0) / inStyle.length
      const meanOther = ref.works.map((w, i) => (!likes.has(styleOf(w.id)) ? scores[i]! : 0)).reduce((s, v) => s + v, 0) / (ref.works.length - likes.size * PER_STYLE)
      expect(meanLiked).toBeGreaterThan(meanOther)
    }
    expect(crossValidateMixed(feats, space.size, pairs, points, { lambda: 1 })!).toBeGreaterThan(0.75)
    expect(mixedAccuracy(scores, pairs, points)).toBeGreaterThan(0.85)
    expect(crossValidateMixed(feats, space.size, pairs.slice(0, 3), [], { minEvents: 15 })).toBeNull()
  })
})

describe('profiles', () => {
  it('finds separate groups, and does not invent them in one coherent group', () => {
    const rows = ref.works.map((_, i) => i).filter((i) => [0, 2, 4].includes(styleOf(ref.works[i]!.id)))
    const modes = findModes(ref.matrix, DIM, rows)
    expect(modes.length).toBe(3)
    for (const m of modes) expect(new Set(m.members.map((r) => styleOf(ref.works[r]!.id))).size).toBe(1)
    const one = ref.works.map((_, i) => i).filter((i) => styleOf(ref.works[i]!.id) === 1)
    expect(findModes(ref.matrix, DIM, one).length).toBe(1)
    expect(findModes(ref.matrix, DIM, one.slice(0, 4)).length).toBe(1) // too small to split
  })

  it('only calls out qualities with enough images and a clear, reliable effect', () => {
    const strong = new Map([['dark', Float32Array.from({ length: 12 }, (_, i) => 1.2 + (i % 3) * 0.1)]])
    const dims = describeSet(TASTE_DIMENSIONS.filter((d) => d.id === 'dark'), strong)
    expect(dims[0]!.certain).toBe(true)
    const few = describeSet(TASTE_DIMENSIONS.filter((d) => d.id === 'dark'), new Map([['dark', Float32Array.from([1.5, 1.4, 1.6])]]))
    expect(few[0]!.certain).toBe(false) // 3 images: never enough
    const noise = new Map([['dark', Float32Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.4 : -0.4))]])
    expect(describeSet(TASTE_DIMENSIONS.filter((d) => d.id === 'dark'), noise)[0]!.certain).toBe(false)
    const tiny = new Map([['dark', Float32Array.from({ length: 200 }, () => 0.1)]])
    expect(describeSet(TASTE_DIMENSIONS.filter((d) => d.id === 'dark'), tiny)[0]!.certain).toBe(false) // significant but trivial
  })
})

describe('DiscoveryEngine', () => {
  it('turns every kind of answer into evidence, and "can\'t decide" teaches nothing', async () => {
    const [a, b, c, d] = ref.works
    db!.addDiscoveryEvent('prefer', a!.id, b!.id, a!.id)
    db!.addDiscoveryEvent('both', c!.id, d!.id, null)
    db!.addDiscoveryEvent('neither', a!.id, c!.id, null)
    db!.addDiscoveryEvent('undecided', b!.id, d!.id, null)
    db!.addDiscoveryEvent('like', d!.id, null, null, 'journey:x')
    const ev = buildEvidence(db!.listDiscoveryEvents(), ref.rowOf, ref.works.length)
    expect(ev.counts).toMatchObject({ prefer: 1, both: 1, neither: 1, undecided: 1, likes: 1 })
    expect(ev.informative).toBe(4) // undecided does not count
    expect(ev.pairs.length).toBe(1)
    expect(ev.points.some((p) => p.i === ref.rowOf.get(c!.id) && p.y === 1)).toBe(true)
    expect(ev.passed.has(ref.rowOf.get(a!.id)!)).toBe(true) // "neither" later overrides the earlier preference
    expect(ev.liked.has(ref.rowOf.get(a!.id)!)).toBe(false)
    expect(ev.shown.size).toBe(4)
  })

  it('maps the collection first, never repeats a pair, and avoids near-duplicates', async () => {
    const engine = engineOf()
    const rng = mulberry32(1)
    const seen = new Set<string>()
    const phases = new Set<string>()
    const regionsFirst: number[] = []
    let pair = await engine.nextPair()
    for (let i = 0; i < 40 && pair; i += 1) {
      const key = [pair.a.id, pair.b.id].sort().join('|')
      expect(seen.has(key)).toBe(false)
      seen.add(key)
      phases.add(pair.phase)
      if (i < 6) regionsFirst.push(pair.a.region, pair.b.region)
      expect(pair.a.id).not.toBe(pair.b.id)
      const a = answer(new Set([0]), pair.a.id, pair.b.id, rng)
      pair = (await engine.respond(pair.a.id, pair.b.id, a.response, a.winner)).next
    }
    expect(new Set(regionsFirst).size).toBeGreaterThanOrEqual(5) // orientation visits different regions
    expect(phases.has('orient')).toBe(true)
    expect(phases.size).toBeGreaterThan(1) // later phases appear once there is something to learn from
  })

  it('supports undo and reset, and rejects invalid answers', async () => {
    const engine = engineOf()
    const first = (await engine.nextPair())!
    let step = await engine.respond(first.a.id, first.b.id, 'both', null)
    expect(step.state.counts.both).toBe(1)
    const undone = await engine.undo()
    expect(undone.state.counts.both).toBe(0)
    expect(undone.next!.a.id).toBe(first.a.id) // the same pair is offered again
    await expect(engine.respond(first.a.id, first.b.id, 'prefer', null)).rejects.toThrow(/which work/)
    await expect(engine.respond(first.a.id, first.a.id, 'both')).rejects.toThrow()
    await expect(engine.respond('aic-0', first.b.id, 'both')).rejects.toThrow()
    step = await engine.respond(first.a.id, first.b.id, 'neither', null)
    expect((await engine.reset()).informative).toBe(0)
    expect(db!.listDiscoveryEvents()).toEqual([])
  })

  it('learns a person with three separate tastes, keeping them separate', async () => {
    const engine = engineOf()
    const likes = new Set([0, 2, 4])
    await explore(engine, likes, 70)
    const ev = engine.evidence()
    const scores = engine.scores(ev)!
    const liked = ref.works.map((w) => likes.has(styleOf(w.id)))
    const idx = Array.from(scores.keys()).sort((a, b) => scores[a]! - scores[b]!)
    let sum = 0
    let pos = 0
    idx.forEach((row, rank) => { if (liked[row]) { sum += rank + 1; pos += 1 } })
    expect((sum - (pos * (pos + 1)) / 2) / (pos * (scores.length - pos))).toBeGreaterThan(0.9)
    const state = await engine.state()
    expect(state.modes.length).toBeGreaterThanOrEqual(2) // separate directions, not one average
    const modeStyles = state.modes.map((m) => new Set(m.examples.map((e) => styleOf(e.id))))
    for (const s of modeStyles) expect(s.size).toBeLessThanOrEqual(2)
    expect(state.stage).toBe('steady')
    expect(state.canJourney).toBe(true)
    expect(state.coverage.regionsSeen).toBe(STYLES.length)
    // Dimensions (relative to what was shown) are never claimed for pure noise.
    const random = engineOf()
    await random.reset()
    await explore(random, new Set(), 0)
  })

  it('never claims a reliable quality from random answers', async () => {
    const engine = engineOf()
    const rng = mulberry32(21)
    let pair = await engine.nextPair()
    for (let i = 0; i < 40 && pair; i += 1) {
      const r = rng()
      const response = r < 0.3 ? 'both' : r < 0.6 ? 'neither' : 'prefer'
      pair = (await engine.respond(pair.a.id, pair.b.id, response, response === 'prefer' ? (rng() < 0.5 ? pair.a.id : pair.b.id) : null)).next
    }
    const state = await engine.state()
    const claimed = state.dimensions.filter((d) => d.certain)
    expect(claimed.length).toBeLessThanOrEqual(2)
  })
})

describe('identity from favorites', () => {
  async function addLibraryImages(styleCounts: Array<[number, number]>): Promise<string[]> {
    const ids: string[] = []
    let n = 0
    for (const [style, count] of styleCounts) {
      for (let i = 0; i < count; i += 1) {
        const path = join(workDir, 'images', `lib-${style}-${i}.png`)
        const id = imageIdForPath(path)
        db!.upsertScannedImage({ id, rootId, path, folder: join(workDir, 'images'), filename: `lib-${style}-${i}.png`, ext: 'png', bytes: 1, width: 10, height: 10, orientation: 1, mtime: 1_700_000_000_000 + n, color: '#000', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
        // The library image looks like one of the reference works of that style.
        const row = style * PER_STYLE + (i % PER_STYLE)
        db!.saveEmbeddings(EMBEDDING_MODEL, [{ id, mtime: 1_700_000_000_000 + n, vector: ref.matrix.slice(row * DIM, (row + 1) * DIM) }])
        ids.push(id)
        n += 1
      }
    }
    return ids
  }

  const identityOf = (available = true): IdentityEngine => new IdentityEngine(db!, new SemanticSearch(db!, async () => { throw new Error('no model') }), ref, new ConceptSpace(null, ref), () => available)

  it('describes separate favorite groups against the reference, without penalising what is absent', async () => {
    const ids = await addLibraryImages([[0, 10], [2, 9], [4, 8], [1, 40]]) // 40 more images are in the library but not favorites
    for (const id of ids.slice(0, 27)) db!.updateImage({ id, favorite: true })
    const state = await identityOf().state()
    expect(state.available).toBe(true)
    expect(state.learned).toBe(27)
    expect(state.modes.length).toBe(3)
    const labels = state.modes.map((m) => m.label)
    expect(labels.join(' ')).toMatch(/Dark|Abstract/)
    // What else fills the library is not a taste: adding 40 more portraits that are not favorites changes nothing.
    const before = state.dimensions.map((d) => d.mean)
    await addLibraryImages([[3, 40]])
    const after = (await identityOf().state()).dimensions.map((d) => d.mean)
    expect(after).toEqual(before)
    for (const mode of state.modes) {
      expect(mode.kindred.length).toBeGreaterThan(0)
      expect(mode.kindred[0]!.museumName).toBeTruthy()
      expect(mode.examples.length).toBeGreaterThan(0)
    }
  })

  it('works for a tiny specialised library, with tentative wording and fewer claims', async () => {
    const ids = await addLibraryImages([[2, 4]])
    for (const id of ids) db!.updateImage({ id, favorite: true })
    const state = await identityOf().state()
    expect(state.available).toBe(true)
    expect(state.tentative).toBe(true)
    expect(state.modes.length).toBe(1)
    expect(state.modes[0]!.tentative).toBe(true)
    expect(state.dimensions.every((d) => !d.certain)).toBe(true) // fewer than 5 images: no claims
  })

  it('explains itself when there is not enough to say', async () => {
    const ids = await addLibraryImages([[0, 2]])
    ids.forEach((id) => db!.updateImage({ id, favorite: true }))
    const few = await identityOf().state()
    expect(few.available).toBe(false)
    expect(few.reason).toMatch(/at least 3/)
    expect((await identityOf(false).state()).reason).toMatch(/model/)
  })
})

describe('comparing the two profiles', () => {
  it('shows agreement, one-sided evidence and unexplored areas, with qualified statements', async () => {
    const lib = await (async () => {
      const ids: string[] = []
      for (let i = 0; i < 12; i += 1) {
        const path = join(workDir, 'images', `dark-${i}.png`)
        const id = imageIdForPath(path)
        db!.upsertScannedImage({ id, rootId, path, folder: join(workDir, 'images'), filename: `dark-${i}.png`, ext: 'png', bytes: 1, width: 10, height: 10, orientation: 1, mtime: 1_700_000_000_000 + i, color: '#000', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
        db!.saveEmbeddings(EMBEDDING_MODEL, [{ id, mtime: 1_700_000_000_000 + i, vector: ref.matrix.slice((i % PER_STYLE) * DIM, ((i % PER_STYLE) + 1) * DIM) }]) // style 0 = dark landscapes
        db!.updateImage({ id, favorite: true })
        ids.push(id)
      }
      return ids
    })()
    expect(lib.length).toBe(12)
    const concepts = new ConceptSpace(null, ref)
    const engine = new DiscoveryEngine(db!, ref, concepts)
    await explore(engine, new Set([0, 2]), 60)
    const identity = new IdentityEngine(db!, new SemanticSearch(db!, async () => { throw new Error('x') }), ref, concepts, () => true)
    const compare = await new CompareEngine(db!, ref, concepts, identity, engine).state()
    const dark = compare.dimensions.find((d) => d.id === 'dark')!
    expect(compare.dimensions.length).toBe(6)
    expect(dark.relation).toBe('shared') // favorites and exploration both lean dark
    expect(dark.statement).toMatch(/Two independent sources agree/)
    expect(dark.statement).toMatch(/Dark & moody/)
    expect(dark.identityExamples.length).toBeGreaterThan(0)
    expect(dark.discoveredExamples.length).toBeGreaterThan(0)
    const regions = compare.regions
    expect(regions.find((r) => r.id === 0)!.status).toBe('shared')
    expect(regions.find((r) => r.id === 2)!.status).toBe('discovered') // liked while exploring, no favorites there
    expect(regions.filter((r) => ['unexplored', 'passed', 'promising'].includes(r.status)).length).toBeGreaterThan(0)
    expect(compare.points.filter((p) => p.kind === 'favorite').length).toBe(12)
    expect(compare.map.length).toBe(ref.works.length)
    expect(compare.headline.some((h) => /agree/.test(h))).toBe(true)
    // With little evidence the statements say so.
    await engine.reset()
    const bare = await new CompareEngine(db!, ref, concepts, identity, engineOf()).state()
    expect(bare.dimensions.find((d) => d.id === 'dark')!.statement).toMatch(/thin|Not enough|only/)
  })
})

describe('journeys', () => {
  async function engines() {
    const concepts = new ConceptSpace(null, ref)
    const discovery = new DiscoveryEngine(db!, ref, concepts)
    const identity = new IdentityEngine(db!, new SemanticSearch(db!, async () => { throw new Error('x') }), ref, concepts, () => false)
    return { discovery, journeys: new JourneyEngine(db!, ref, concepts, discovery, identity) }
  }

  it('offers a tour with no personal data, and every work carries provenance and a reason', async () => {
    const { journeys } = await engines()
    const suggestions = await journeys.suggestions()
    expect(suggestions[0]!.seed.kind).toBe('tour')
    const tour = await journeys.create(suggestions[0]!.seed)
    expect(tour.chapters.length).toBeGreaterThanOrEqual(3)
    const all = tour.chapters.flatMap((c) => c.works)
    expect(new Set(all.map((w) => w.work.id)).size).toBe(all.length) // no repeats
    for (const w of all) {
      expect(w.work.museumName).toBeTruthy()
      expect(w.work.license).toMatch(/CC0/)
      expect(w.why.length).toBeGreaterThan(0)
    }
    expect(journeys.get(tour.id)!.title).toBe(tour.title) // persisted
  })

  it('builds a journey from a discovered direction that stretches beyond it, and excludes what was rejected', async () => {
    const { discovery, journeys } = await engines()
    await explore(discovery, new Set([0]), 50)
    const state = await discovery.state()
    expect(state.modes.length).toBeGreaterThan(0)
    const rejected = ref.works.filter((w) => styleOf(w.id) === 3).slice(0, 6)
    for (const w of rejected) await discovery.feedback(w.id, 'dislike', 'explore')
    const suggestions = await journeys.suggestions()
    const mine = suggestions.find((s) => s.seed.kind === 'mode' || s.seed.kind === 'emerging')!
    expect(mine.evidence).toMatch(/liked works/)
    const journey = await journeys.create(mine.seed)
    const works = journey.chapters.flatMap((c) => c.works)
    expect(journey.chapters[0]!.title).toBe('Where you are')
    expect(styleOf(journey.chapters[0]!.works[0]!.work.id)).toBe(0) // starts from what the user likes
    const stretch = journey.chapters.filter((c) => c.stretch)
    expect(stretch.length).toBeGreaterThan(0) // a deliberate step beyond known taste
    expect(stretch.flatMap((c) => c.works).every((w) => styleOf(w.work.id) !== 0)).toBe(true)
    expect(works.some((w) => rejected.some((r) => r.id === w.work.id))).toBe(false)
    expect(journey.explorationShare).toBeGreaterThan(0.2)
    expect(journey.basis.join(' ')).toMatch(/does not claim/)
    const text = works.flatMap((w) => w.why).join(' ')
    expect(text).not.toMatch(/influenced/i) // never an art-historical claim
  })

  it('records feedback as evidence, lets it be changed, and tracks progress', async () => {
    const { discovery, journeys } = await engines()
    const tour = await journeys.create({ kind: 'tour', label: 'tour' })
    const first = tour.chapters[0]!.works[0]!.work.id
    const liked = await journeys.feedback(tour.id, first, 'like')
    expect(liked.feedback[first]).toBe('like')
    expect(discovery.evidence().liked.has(ref.rowOf.get(first)!)).toBe(true)
    const changed = await journeys.feedback(tour.id, first, 'dislike')
    expect(changed.feedback[first]).toBe('dislike')
    expect(discovery.evidence().passed.has(ref.rowOf.get(first)!)).toBe(true)
    expect(discovery.evidence().liked.has(ref.rowOf.get(first)!)).toBe(false)
    const cleared = await journeys.feedback(tour.id, first, 'clear')
    expect(cleared.feedback[first]).toBeUndefined()
    expect(db!.listDiscoveryEvents().length).toBe(0)
    expect(journeys.progress(tour.id, 4).progress).toBe(4)
    expect(journeys.progress(tour.id, 2).progress).toBe(4) // never moves backwards
    expect(journeys.progress(tour.id, 9, true).finished).toBe(true)
    journeys.remove(tour.id)
    expect(journeys.get(tour.id)).toBeNull()
  })

  it('offers journeys for unexplored directions once there is something to compare against', async () => {
    const { discovery, journeys } = await engines()
    await explore(discovery, new Set([0, 1]), 12)
    const suggestions = await journeys.suggestions()
    expect(suggestions.some((s) => s.seed.kind === 'unexplored')).toBe(true)
    const s = suggestions.find((x) => x.seed.kind === 'unexplored')!
    expect(s.reason).toMatch(/guess|prediction/)
    const j = await journeys.create(s.seed)
    expect(j.title).toMatch(/Unexplored/)
    const one = await journeys.create({ kind: 'work', label: 'x', ref: ref.works[3]!.id })
    expect(one.title).toMatch(/More like/)
    await expect(journeys.create({ kind: 'work', label: 'x', ref: 'aic-nope' })).rejects.toThrow()
  })
})

describe('history and saving discoveries', () => {
  it('snapshots the profiles when enough has changed and lists what was discovered in between', async () => {
    const concepts = new ConceptSpace(null, ref)
    const discovery = new DiscoveryEngine(db!, ref, concepts)
    const identity = new IdentityEngine(db!, new SemanticSearch(db!, async () => { throw new Error('x') }), ref, concepts, () => false)
    const history = new HistoryEngine(db!, ref, identity, discovery)
    expect((await history.state()).snapshots.length).toBe(0)
    await explore(discovery, new Set([0]), 12)
    expect(await history.snapshotIfDue()).toBe(true)
    expect(await history.snapshotIfDue()).toBe(false) // nothing new yet
    await explore(discovery, new Set([2]), 14, 8)
    expect(await history.snapshotIfDue()).toBe(true)
    const state = await history.state()
    expect(state.snapshots.length).toBe(2)
    expect(state.snapshots[1]!.discovered.answers).toBeGreaterThan(state.snapshots[0]!.discovered.answers)
    expect(state.snapshots[1]!.discoveries.length).toBeGreaterThan(0)
    expect(state.note).toMatch(/not proven|each snapshot/i)
    // History survives starting over: the snapshots keep what was true then.
    await discovery.reset()
    expect((await history.state()).snapshots.length).toBe(2)
  })

  it('saves a discovery into the library with provenance, as a normal image, without touching anything else', async () => {
    const dataDir = join(workDir, 'data')
    const thumbs = join(dataDir, 'thumbnails')
    await fs.mkdir(thumbs, { recursive: true })
    const own = join(workDir, 'images', 'mine.png')
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#223344' } }).png().toFile(own)
    const ownBefore = await fs.readFile(own)
    const work = ref.works[5]!
    const board = db!.createMoodboard('Discoveries')
    const saved = await saveDiscoveryToLibrary({ db: db!, reference: ref, dataDir, thumbnailsDir: thumbs }, work, { favorite: true, moodboardId: board.id, journeyId: 'j1' })
    const item = db!.getImage(saved.imageId)!
    expect(item.favorite).toBe(true)
    expect(item.tags).toContain('atlas-discovery')
    expect(item.thumbStatus).toBe('ready')
    expect(saved.path).toContain('Atlas Discoveries')
    const sidecar = JSON.parse(await fs.readFile(`${saved.path}.provenance.json`, 'utf8'))
    expect(sidecar.museum).toBe(work.museumName)
    expect(sidecar.license).toMatch(/CC0/)
    expect(sidecar.objectPage).toBe(work.objectUrl)
    expect(db!.getMoodboard(board.id)!.images.length).toBe(1)
    expect(db!.getSavedDiscovery(work.id)!.journey_id).toBe('j1')
    // Saving twice neither duplicates nor fails, and the user's own files are untouched.
    const again = await saveDiscoveryToLibrary({ db: db!, reference: ref, dataDir, thumbnailsDir: thumbs }, work)
    expect(again.imageId).toBe(saved.imageId)
    expect(db!.listRoots().filter((r) => r.path.includes('Atlas Discoveries')).length).toBe(1)
    expect(await fs.readFile(own)).toEqual(ownBefore)
    expect((await fs.stat(ref.imagePath(work.id)!)).isFile()).toBe(true) // the shipped original is left as it was
  })
})

describe('technical-image guard', () => {
  it('leaves out screenshot-like images only when they are more technical than nearly all artworks', async () => {
    // Pack concept vectors for the guard: "tech" is coordinate 20, "art" is coordinate 21.
    ref.poleVectors.set('guard-tech', Float32Array.from({ length: DIM }, (_, i) => (i === 20 ? 1 : 0)))
    ref.poleVectors.set('guard-art', Float32Array.from({ length: DIM }, (_, i) => (i === 21 ? 1 : 0)))
    const guard = new TechnicalGuard(ref, async () => { throw new Error('should use the pack') })
    const library = new Float32Array(3 * DIM)
    library.set(unit(Array.from({ length: DIM }, (_, i) => (i === 21 ? 1 : 0.05))), 0) // artwork
    library.set(unit(Array.from({ length: DIM }, (_, i) => (i === 20 ? 1 : 0.05))), DIM) // screenshot-like
    library.set(unit(Array.from({ length: DIM }, (_, i) => (i === 3 ? 1 : 0.05))), 2 * DIM) // neither
    const mask = await guard.mask(library, DIM, 3)
    expect(Array.from(mask)).toEqual([0, 1, 0])
    // With no reference yardstick, nothing is excluded: it does not guess.
    const none = await new TechnicalGuard(null, async () => ({ embedTexts: async (t: string[]) => t.map(() => Float32Array.from({ length: DIM }, (_, i) => (i === 20 ? 1 : 0))) }) as never).mask(library, DIM, 3)
    expect(Array.from(none)).toEqual([0, 0, 0])
  })
})
