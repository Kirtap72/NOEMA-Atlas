import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import { EMBEDDING_MODEL, type Embedder } from '../src/main/embedder'
import { SemanticSearch } from '../src/main/semantic'
import {
  type PairRef,
  conceptZScores,
  crossValidatedAccuracy,
  diversifiedTop,
  dotRows,
  leanOf,
  mulberry32,
  pairAccuracy,
  pairKey,
  scoreAll,
  selectNextPair,
  trainPreferenceModel
} from '../src/main/taste'
import { TASTE_DIMENSIONS } from '../src/main/tasteDimensions'
import { TasteEngine } from '../src/main/tasteEngine'

sharp.cache(false)

// ---- synthetic library ----------------------------------------------------------------------------

const DIM = 24

function unit(values: number[]): Float32Array {
  const n = Math.hypot(...values) || 1
  return Float32Array.from(values.map((v) => v / n))
}

/** Random unit vectors, plus a hidden "taste" direction the simulated user cares about. */
function makeLibrary(rows: number, seed = 1): { matrix: Float32Array; taste: Float32Array } {
  const random = mulberry32(seed)
  const gauss = (): number => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random())
  const matrix = new Float32Array(rows * DIM)
  for (let r = 0; r < rows; r += 1) matrix.set(unit(Array.from({ length: DIM }, gauss)), r * DIM)
  return { matrix, taste: unit(Array.from({ length: DIM }, gauss)) }
}

function simulateChoices(matrix: Float32Array, taste: Float32Array, count: number, seed: number, noise = 6): PairRef[] {
  const rows = matrix.length / DIM
  const random = mulberry32(seed)
  const pairs: PairRef[] = []
  while (pairs.length < count) {
    const a = Math.floor(random() * rows)
    const b = Math.floor(random() * rows)
    if (a === b) continue
    const margin = scoreAll(matrix, DIM, taste)
    const p = 1 / (1 + Math.exp(-noise * (margin[a]! - margin[b]!)))
    pairs.push(random() < p ? { w: a, l: b, weight: 1 } : { w: b, l: a, weight: 1 })
  }
  return pairs
}

describe('preference model', () => {
  it('learns a hidden taste from noisy comparisons and improves with more of them', () => {
    const { matrix, taste } = makeLibrary(400)
    const truth: PairRef[] = []
    const scores = scoreAll(matrix, DIM, taste)
    const random = mulberry32(5)
    while (truth.length < 800) {
      const a = Math.floor(random() * 400)
      const b = Math.floor(random() * 400)
      if (a !== b && Math.abs(scores[a]! - scores[b]!) > 0.1) truth.push(scores[a]! > scores[b]! ? { w: a, l: b, weight: 1 } : { w: b, l: a, weight: 1 })
    }
    const pairs = simulateChoices(matrix, taste, 150, 21)
    const accuracy = (n: number): number => pairAccuracy(matrix, DIM, trainPreferenceModel(matrix, DIM, pairs.slice(0, n), { lambda: 0.1 }), truth)
    const few = accuracy(6)
    const many = accuracy(150)
    expect(many).toBeGreaterThan(0.85)
    expect(many).toBeGreaterThan(few)
    // The learned direction points the same way as the real one.
    const w = trainPreferenceModel(matrix, DIM, pairs, { lambda: 0.1 })
    const cosine = Array.from(w).reduce((s, v, i) => s + v * taste[i]!, 0) / Math.hypot(...Array.from(w))
    expect(cosine).toBeGreaterThan(0.8)
  })

  it('returns a neutral model without data and ignores weightless history gracefully', () => {
    const { matrix } = makeLibrary(20)
    expect(Array.from(trainPreferenceModel(matrix, DIM, [])).every((v) => v === 0)).toBe(true)
  })

  it('reports an honest cross-validated accuracy, and none when there is too little data', () => {
    const { matrix, taste } = makeLibrary(300)
    const pairs = simulateChoices(matrix, taste, 120, 8)
    expect(crossValidatedAccuracy(matrix, DIM, pairs.slice(0, 10))).toBeNull()
    const accuracy = crossValidatedAccuracy(matrix, DIM, pairs, { lambda: 0.1 })!
    expect(accuracy).toBeGreaterThan(0.62)
    expect(accuracy).toBeLessThanOrEqual(1)
    // Random choices give chance-level accuracy: the number cannot be inflated.
    const random = mulberry32(2)
    const noise: PairRef[] = Array.from({ length: 120 }, () => ({ w: Math.floor(random() * 300), l: Math.floor(random() * 300), weight: 1 })).filter((p) => p.w !== p.l)
    const chance = crossValidatedAccuracy(matrix, DIM, noise, { lambda: 0.1 })!
    expect(chance).toBeLessThan(accuracy - 0.05)
  })
})

describe('choosing the next pair', () => {
  const { matrix, taste } = makeLibrary(300, 3)
  const base = () => ({
    matrix,
    dim: DIM,
    model: null as Float32Array | null,
    seenPairs: new Set<string>(),
    recent: new Set<number>(),
    appearances: new Int32Array(300),
    seed: 1
  })

  it('never offers near-duplicates, repeats, or recently shown images, and is deterministic', () => {
    // Make row 1 a near-duplicate of row 0.
    const m = matrix.slice()
    m.set(m.subarray(0, DIM), DIM)
    const seen = new Set<string>([pairKey(10, 11)])
    for (let seed = 0; seed < 80; seed += 1) {
      const next = selectNextPair({ ...base(), matrix: m, seed, seenPairs: seen, recent: new Set([5, 6]) })!
      expect(next.a).not.toBe(next.b)
      expect(dotRows(m, DIM, next.a, next.b)).toBeLessThanOrEqual(0.95)
      expect(seen.has(pairKey(next.a, next.b))).toBe(false)
      expect([next.a, next.b]).not.toContain(5)
      expect([next.a, next.b]).not.toContain(6)
    }
    expect(selectNextPair({ ...base(), seed: 9 })).toEqual(selectNextPair({ ...base(), seed: 9 }))
  })

  it('prefers the pairs the model is least sure about once it has a model', () => {
    const model = taste
    const margin = (a: number, b: number): number => Math.abs(dotRows(matrix, DIM, a, a) * 0 + Array.from({ length: DIM }, (_, i) => (matrix[a * DIM + i]! - matrix[b * DIM + i]!) * model[i]!).reduce((s, v) => s + v, 0))
    let picked = 0
    let random = 0
    const rng = mulberry32(4)
    for (let seed = 0; seed < 60; seed += 1) {
      const next = selectNextPair({ ...base(), model, seed, exploration: 0 })!
      picked += margin(next.a, next.b)
      random += margin(Math.floor(rng() * 300), Math.floor(rng() * 300))
    }
    expect(picked / 60).toBeLessThan((random / 60) * 0.5)
  })

  it('covers rarely shown images first', () => {
    const appearances = new Int32Array(300).fill(5)
    for (let i = 0; i < 20; i += 1) appearances[i] = 0
    let fresh = 0
    for (let seed = 0; seed < 50; seed += 1) {
      const next = selectNextPair({ ...base(), appearances, seed })!
      if (next.a < 20 || next.b < 20) fresh += 1
    }
    expect(fresh).toBeGreaterThan(35)
  })
})

describe('diversity and compass measurements', () => {
  it('drops near-duplicates from a ranked list', () => {
    const m = new Float32Array(4 * 2)
    m.set([1, 0, 0.999, 0.04, 0, 1, -1, 0])
    const scores = Float32Array.from([4, 3, 2, 1])
    expect(diversifiedTop(scores, m, 2, () => true, 3, 0.95)).toEqual([0, 2, 3])
    expect(diversifiedTop(scores, m, 2, (r) => r !== 0, 2, 0.95)).toEqual([1, 2])
  })

  it('measures what the chosen images have more of, with an interval that excludes chance', () => {
    const rows = 200
    const random = mulberry32(6)
    const z = Float32Array.from({ length: rows }, () => random() * 4 - 2)
    const pairs: PairRef[] = []
    while (pairs.length < 60) {
      const a = Math.floor(random() * rows)
      const b = Math.floor(random() * rows)
      if (a !== b) pairs.push(z[a]! > z[b]! ? { w: a, l: b, weight: 1 } : { w: b, l: a, weight: 1 })
    }
    const strong = leanOf(z, pairs)
    expect(strong.lean).toBeGreaterThan(0.8)
    expect(strong.low).toBeGreaterThan(0)
    expect(strong.agreed).toBe(strong.clear) // always picked the stronger one
    const coin: PairRef[] = pairs.map((p) => (random() < 0.5 ? p : { w: p.l, l: p.w, weight: 1 }))
    const none = leanOf(z, coin)
    expect(none.low).toBeLessThan(0)
    expect(none.high).toBeGreaterThan(0)
    expect(leanOf(z, [])).toMatchObject({ lean: 0, clear: 0 })
  })

  it('z-scores concept similarity over the whole library', () => {
    const { matrix } = makeLibrary(100, 9)
    const z = conceptZScores(matrix, DIM, unit(Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0))))
    const mean = z.reduce((s, v) => s + v, 0) / z.length
    const variance = z.reduce((s, v) => s + (v - mean) ** 2, 0) / z.length
    expect(Math.abs(mean)).toBeLessThan(1e-4)
    expect(variance).toBeCloseTo(1, 2)
  })
})

// ---- the engine, against a real database and fake embeddings --------------------------------------

let workDir = ''
let db: AtlasDatabase | null = null
let rootId = ''

const DARK_INDEX = TASTE_DIMENSIONS.findIndex((d) => d.id === 'dark')
const BRIGHT_INDEX = TASTE_DIMENSIONS.findIndex((d) => d.id === 'bright')

/**
 * Fake text model: every dimension gets its own axis; "dark" and "bright" are axes 0 and 1. Image vectors are
 * built from those axes plus noise, so "dark" images really are the ones aligned with the dark concept.
 */
function fakeEmbedder(): Embedder {
  return {
    embedTexts: async (texts: string[]) =>
      texts.map((text) => {
        const index = TASTE_DIMENSIONS.findIndex((d) => d.prompts.includes(text))
        const v = new Array(DIM).fill(0)
        v[index >= 0 ? index : DIM - 1] = 1
        return unit(v)
      })
  } as unknown as Embedder
}

async function populate(count: number): Promise<{ ids: string[]; darkness: number[] }> {
  const random = mulberry32(31)
  const ids: string[] = []
  const darkness: number[] = []
  for (let i = 0; i < count; i += 1) {
    const path = join(workDir, 'images', `img-${i}.png`)
    const id = imageIdForPath(path)
    db!.upsertScannedImage({ id, rootId, path, folder: join(workDir, 'images'), filename: `img-${i}.png`, ext: 'png', bytes: 1, width: 10, height: 10, orientation: 1, mtime: 1_700_000_000_000 + i, color: '#000', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
    const dark = random()
    const v = new Array(DIM).fill(0).map(() => (random() - 0.5) * 0.6)
    v[DARK_INDEX] = (v[DARK_INDEX] ?? 0) + dark * 2
    v[BRIGHT_INDEX] = (v[BRIGHT_INDEX] ?? 0) + (1 - dark) * 2
    db!.saveEmbeddings(EMBEDDING_MODEL, [{ id, mtime: 1_700_000_000_000 + i, vector: unit(v) }])
    ids.push(id)
    darkness.push(dark)
  }
  return { ids, darkness }
}

beforeEach(async () => {
  workDir = join(tmpdir(), `noema-taste-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(join(workDir, 'images'), { recursive: true })
  db = new AtlasDatabase(join(workDir, 'library.db'))
  rootId = db.addRoot(join(workDir, 'images')).id
})

afterEach(async () => {
  db?.close()
  db = null
  await new Promise((r) => setTimeout(r, 100))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

describe('TasteEngine', () => {
  const make = (available = true) => {
    const semantic = new SemanticSearch(db!, async () => fakeEmbedder())
    return new TasteEngine(db!, semantic, async () => fakeEmbedder(), () => available)
  }

  it('is unavailable (and says why) when the AI features are off or too few images are learned', async () => {
    await populate(5)
    expect((await make(false).state()).available).toBe(false)
    const few = await make(true).state()
    expect(few.available).toBe(false)
    expect(few.reason).toMatch(/at least/)
    expect(await make(false).nextPair()).toBeNull()
  })

  it('learns a user who prefers dark images: the compass, the recommendations and the saved history', async () => {
    const { ids, darkness } = await populate(120)
    const engine = make()
    const darknessOf = new Map(ids.map((id, i) => [id, darkness[i]!]))

    let step = { state: await engine.state(), next: await engine.nextPair() }
    expect(step.state.available).toBe(true)
    expect(step.state.choices).toBe(0)
    expect(step.state.stage).toBe('start')
    expect(step.state.canRecommend).toBe(false)
    expect((await engine.recommend()).message).toMatch(/more comparison/)

    for (let round = 0; round < 40; round += 1) {
      const pair = step.next!
      expect(pair.a.id).not.toBe(pair.b.id)
      const winner = darknessOf.get(pair.a.id)! >= darknessOf.get(pair.b.id)! ? pair.a : pair.b
      step = await engine.choose(pair.a.id, pair.b.id, winner.id)
    }
    expect(step.state.choices).toBe(40)
    expect(step.state.stage).toBe('growing')
    expect(step.state.canRecommend).toBe(true)

    const dark = step.state.dimensions.find((d) => d.id === 'dark')!
    const bright = step.state.dimensions.find((d) => d.id === 'bright')!
    expect(dark.lean).toBeGreaterThan(0.5)
    expect(dark.certain).toBe(true)
    expect(dark.agreed / Math.max(1, dark.clear)).toBeGreaterThan(0.9)
    expect(bright.lean).toBeLessThan(-0.5)
    expect(bright.certain).toBe(true)
    // An unrelated quality shows no reliable lean.
    const unrelated = step.state.dimensions.filter((d) => !['dark', 'bright'].includes(d.id))
    expect(unrelated.filter((d) => d.certain && Math.abs(d.lean) > 0.5).length).toBeLessThanOrEqual(1)

    const recommendations = await engine.recommend(12)
    expect(recommendations.items.length).toBeGreaterThan(5)
    const meanDark = recommendations.items.reduce((s, r) => s + darknessOf.get(r.image.id)!, 0) / recommendations.items.length
    expect(meanDark).toBeGreaterThan(0.75)
    expect(recommendations.items.every((r) => r.percentile > 60)).toBe(true)
    // Already-compared images are not "recommended".
    const shown = new Set(db!.listTasteComparisons().flatMap((c) => [c.a, c.b]))
    expect(recommendations.items.some((r) => shown.has(r.image.id))).toBe(false)
    expect(recommendations.items[0]!.because).not.toBeNull()

    const examples = await engine.examples('dark')
    expect(examples.yours.length).toBeGreaterThan(0)
    expect(examples.library.length).toBe(6)
    expect(examples.library.every((img) => darknessOf.get(img.id)! > 0.8)).toBe(true)

    // The learned history survives a restart: a new engine over the same database sees it.
    const again = await make().state()
    expect(again.choices).toBe(40)
    expect(again.dimensions.find((d) => d.id === 'dark')!.lean).toBeCloseTo(dark.lean, 6)
  })

  it('supports skipping, undoing and resetting', async () => {
    await populate(40)
    const engine = make()
    const first = (await engine.nextPair())!
    let step = await engine.choose(first.a.id, first.b.id, null)
    expect(step.state.choices).toBe(0)
    expect(step.state.skipped).toBe(1)
    expect(`${step.next!.a.id}:${step.next!.b.id}`).not.toBe(`${first.a.id}:${first.b.id}`)

    step = await engine.choose(step.next!.a.id, step.next!.b.id, step.next!.a.id)
    expect(step.state.choices).toBe(1)
    const undone = await engine.undo()
    expect(undone.state.choices).toBe(0)
    expect(undone.next).not.toBeNull() // the undone pair is offered again

    await engine.choose(undone.next!.a.id, undone.next!.b.id, undone.next!.b.id)
    const reset = await engine.reset()
    expect(reset.choices).toBe(0)
    expect(reset.skipped).toBe(0)
    expect(db!.listTasteComparisons()).toEqual([])
  })

  it('also learns from existing Keep and Pass decisions, never from unreviewed images', async () => {
    const { ids, darkness } = await populate(80)
    const engine = make()
    ids.forEach((id, i) => {
      if (darkness[i]! > 0.85) db!.updateImage({ id, favorite: true })
      else if (darkness[i]! < 0.15) db!.updateImage({ id, decision: 'pass' })
    })
    const state = await engine.state()
    expect(state.choices).toBe(0)
    expect(state.inferred.decisions).toBeGreaterThan(0)
    expect(state.canRecommend).toBe(true)
    expect(state.dimensions.find((d) => d.id === 'dark')!.lean).toBeGreaterThan(0.5)
    // Rejecting an invalid winner is a hard error rather than silent corruption.
    expect(() => db!.addTasteComparison(ids[0]!, ids[1]!, ids[2]!)).toThrow()
  })

  it('keeps pairs that were picked because they were hard out of the compass, but learns from them', async () => {
    const { ids, darkness } = await populate(100)
    const engine = make()
    const darkOf = new Map(ids.map((id, i) => [id, darkness[i]!]))
    let step = { state: await engine.state(), next: await engine.nextPair() }
    const modes = new Set<string>()
    for (let round = 0; round < 70; round += 1) {
      const pair = step.next!
      modes.add(pair.mode)
      const winner = darkOf.get(pair.a.id)! >= darkOf.get(pair.b.id)! ? pair.a : pair.b
      step = await engine.choose(pair.a.id, pair.b.id, winner.id, pair.mode)
    }
    expect(modes.has('warm')).toBe(true)
    expect(modes.has('uncertain')).toBe(true) // adaptive pairs appear once there is a model
    const state = step.state
    const adaptive = db!.listTasteComparisons().filter((c) => c.mode === 'uncertain').length
    expect(adaptive).toBeGreaterThan(5)
    expect(state.choices).toBe(70)
    expect(state.compassChoices).toBe(70 - adaptive)
    expect(state.dimensions.find((d) => d.id === 'dark')!.certain).toBe(true)
    // Undo keeps the pair's mode so it is still labelled correctly when answered again.
    const undone = await engine.undo()
    expect(['warm', 'explore', 'random', 'uncertain']).toContain(undone.next!.mode)
  })

  it('removes comparisons together with their images', async () => {
    await populate(30)
    const engine = make()
    const pair = (await engine.nextPair())!
    await engine.choose(pair.a.id, pair.b.id, pair.a.id)
    expect(db!.listTasteComparisons().length).toBe(1)
    db!.removeRoot(rootId)
    expect(db!.listTasteComparisons()).toEqual([])
  })
})
