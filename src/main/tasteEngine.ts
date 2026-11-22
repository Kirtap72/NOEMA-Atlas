import type { AtlasDatabase } from './db'
import type { Embedder } from './embedder'
import type { SemanticSearch } from './semantic'
import type { TechnicalGuard } from './guard'
import { TASTE_DIMENSIONS } from './tasteDimensions'
import {
  type PairRef,
  conceptZScores,
  crossValidatedAccuracy,
  diversifiedTop,
  dotRows,
  leanOf,
  mulberry32,
  pairKey,
  scoreAll,
  selectNextPair,
  trainPreferenceModel
} from './taste'
import type {
  TasteDimension,
  TasteExamples,
  TastePair,
  TastePairMode,
  TasteRecommendation,
  TasteRecommendations,
  TasteStage,
  TasteState,
  TasteStep
} from '../shared/types'

/** Choices needed before recommendations unlock. */
export const UNLOCK_CHOICES = 8
/** Fewest learned images for the Taste Compass to make sense. */
export const MIN_IMAGES = 12
/** Random pairs first: uncertainty sampling only helps once the model has something to be uncertain about. */
const WARM_CHOICES = 20
const EXPLORATION = 0.5
const MAX_DECISION_PAIRS = 300
const MAX_RATING_PAIRS = 150
const DECISION_WEIGHT = 0.5
const RATING_WEIGHT = 0.35
const RECENT_ROUNDS = 6

interface Context {
  version: number
  ids: string[]
  dim: number
  matrix: Float32Array
  rowOf: Map<string, number>
}

interface Training {
  direct: PairRef[]
  decisions: PairRef[]
  ratings: PairRef[]
  skipped: number
  seen: Set<string>
  appearances: Int32Array
  recent: Set<number>
  winners: Set<number>
  shown: Set<number>
}

/**
 * Learns a person's taste from what they choose. The only inputs are their own comparisons and their existing
 * Keep/Pass decisions and ratings; embeddings give each image a position, and nothing else is judged by a model.
 */
export class TasteEngine {
  private context: Context | null = null
  private version = 0
  private modelCache: { key: string; w: Float32Array } | null = null
  private zCache = new Map<string, Float32Array>()
  private zVersion = -1
  private conceptCache = new Map<string, Float32Array>()
  private accuracyCache: { choices: number; value: number | null } = { choices: -1, value: null }
  private accuracyTimer: NodeJS.Timeout | null = null

  constructor(
    private db: AtlasDatabase,
    private semantic: SemanticSearch,
    private getEmbedder: () => Promise<Embedder>,
    /** True when the AI features are switched on and the model is installed. */
    private isAvailable: () => boolean,
    /** Keeps screenshots and technical images out of comparisons. Optional. */
    private guard: TechnicalGuard | null = null
  ) {}

  private excludedCache = new Map<number, Set<number>>()

  /** Rows that look like screenshots or technical images rather than finished work. */
  private async exclusions(context: Context): Promise<Set<number>> {
    const cached = this.excludedCache.get(context.version)
    if (cached) return cached
    this.excludedCache.clear()
    const set = new Set<number>()
    if (this.guard) {
      try {
        const mask = await this.guard.mask(context.matrix, context.dim, context.ids.length)
        mask.forEach((flag, row) => {
          if (flag) set.add(row)
        })
      } catch {
        // Without the guard, nothing is excluded.
      }
    }
    this.excludedCache.set(context.version, set)
    return set
  }

  // ---- context ----------------------------------------------------------------------------------

  private load(): Context {
    const snapshot = this.semantic.snapshot()
    if (!this.context || this.context.ids !== snapshot.ids) {
      this.version += 1
      const rowOf = new Map<string, number>()
      snapshot.ids.forEach((id, row) => rowOf.set(id, row))
      this.context = { version: this.version, ids: snapshot.ids, dim: snapshot.dim, matrix: snapshot.matrix, rowOf }
      this.modelCache = null
    }
    return this.context
  }

  private training(context: Context): Training {
    const direct: PairRef[] = []
    const seen = new Set<string>()
    const appearances = new Int32Array(context.ids.length)
    const winners = new Set<number>()
    const shown = new Set<number>()
    const recentRows: number[] = []
    let skipped = 0
    const rows = this.db.listTasteComparisons()
    for (const comparison of rows) {
      const a = context.rowOf.get(comparison.a)
      const b = context.rowOf.get(comparison.b)
      if (a === undefined || b === undefined) continue
      seen.add(pairKey(a, b))
      appearances[a]! += 1
      appearances[b]! += 1
      shown.add(a)
      shown.add(b)
      recentRows.push(a, b)
      if (comparison.winner === null) {
        skipped += 1
        continue
      }
      const winner = comparison.winner === comparison.a ? a : b
      const loser = winner === a ? b : a
      direct.push({ w: winner, l: loser, weight: 1, adaptive: comparison.mode === 'uncertain' })
      winners.add(winner)
    }

    const signals = this.db.getDecisionSignals()
    const rowsOf = (ids: string[]): number[] =>
      ids.map((id) => context.rowOf.get(id)).filter((row): row is number => row !== undefined)
    const keeps = rowsOf(signals.keeps)
    const passes = rowsOf(signals.passes)
    const random = mulberry32(4242)
    const decisions: PairRef[] = []
    if (keeps.length > 0 && passes.length > 0) {
      const total = Math.min(MAX_DECISION_PAIRS, keeps.length * passes.length)
      for (let i = 0; i < total; i += 1) {
        decisions.push({
          w: keeps[Math.floor(random() * keeps.length)]!,
          l: passes[Math.floor(random() * passes.length)]!,
          weight: DECISION_WEIGHT
        })
      }
    }
    const rated = signals.rated
      .map((entry) => ({ row: context.rowOf.get(entry.id), rating: entry.rating }))
      .filter((entry): entry is { row: number; rating: number } => entry.row !== undefined)
    const ratings: PairRef[] = []
    if (rated.length >= 2) {
      for (let i = 0; i < MAX_RATING_PAIRS * 4 && ratings.length < MAX_RATING_PAIRS; i += 1) {
        const x = rated[Math.floor(random() * rated.length)]!
        const y = rated[Math.floor(random() * rated.length)]!
        if (x.rating - y.rating >= 2) ratings.push({ w: x.row, l: y.row, weight: RATING_WEIGHT })
      }
    }
    return {
      direct,
      decisions,
      ratings,
      skipped,
      seen,
      appearances,
      recent: new Set(recentRows.slice(-RECENT_ROUNDS * 2)),
      winners,
      shown
    }
  }

  private allPairs(training: Training): PairRef[] {
    return [...training.direct, ...training.decisions, ...training.ratings]
  }

  private model(context: Context, training: Training, iterations: number): Float32Array | null {
    const pairs = this.allPairs(training)
    if (pairs.length === 0) return null
    const key = `${context.version}|${training.direct.length}|${training.decisions.length}|${training.ratings.length}|${iterations}`
    if (this.modelCache?.key === key) return this.modelCache.w
    const w = trainPreferenceModel(context.matrix, context.dim, pairs, { lambda: 0.1, iterations })
    this.modelCache = { key, w }
    return w
  }

  // ---- concepts ----------------------------------------------------------------------------------

  /**
   * One z-scored measurement per axis, from "pole B" to "pole A": how much more an image resembles the description of
   * pole A than that of pole B, relative to the rest of the library. Using the contrast between the two poles removes
   * what the two descriptions share (both are about light, say), so the poles are true opposites and a petal grows
   * only when the user's choices move towards that end. Pole B uses the same numbers with the sign reversed.
   */
  private async zScores(context: Context): Promise<Map<string, Float32Array>> {
    if (this.zVersion === context.version && this.zCache.size === TASTE_DIMENSIONS.length) return this.zCache
    const embedder = await this.getEmbedder()
    const poleVector = async (spec: (typeof TASTE_DIMENSIONS)[number]): Promise<Float32Array> => {
      let vector = this.conceptCache.get(spec.id)
      if (!vector) {
        const vectors = await embedder.embedTexts(spec.prompts)
        const sum = new Float32Array(context.dim)
        for (const v of vectors) for (let i = 0; i < context.dim; i += 1) sum[i]! += v[i]!
        let norm = 0
        for (const value of sum) norm += value * value
        norm = Math.sqrt(norm) || 1
        vector = sum.map((value) => value / norm)
        this.conceptCache.set(spec.id, vector)
      }
      return vector
    }
    const fresh = new Map<string, Float32Array>()
    const axes = Array.from(new Set(TASTE_DIMENSIONS.map((spec) => spec.axis)))
    for (const axis of axes) {
      const a = TASTE_DIMENSIONS.find((spec) => spec.axis === axis && spec.pole === 'a')
      const b = TASTE_DIMENSIONS.find((spec) => spec.axis === axis && spec.pole === 'b')
      if (!a || !b) continue
      const va = await poleVector(a)
      const vb = await poleVector(b)
      const direction = va.map((value, i) => value - vb[i]!)
      const z = conceptZScores(context.matrix, context.dim, direction)
      fresh.set(a.id, z)
      fresh.set(b.id, z.map((value) => -value))
    }
    this.zCache = fresh
    this.zVersion = context.version
    return fresh
  }

  // ---- public API --------------------------------------------------------------------------------

  private stageOf(choices: number): TasteStage {
    if (choices < UNLOCK_CHOICES) return 'start'
    if (choices < 25) return 'sketch'
    if (choices < 60) return 'growing'
    return 'steady'
  }

  private emptyState(reason: string | null, embedded: number): TasteState {
    return {
      available: false,
      reason,
      embedded,
      choices: 0,
      excluded: 0,
      compassChoices: 0,
      skipped: 0,
      inferred: { decisions: 0, ratings: 0 },
      accuracy: null,
      accuracyChoices: 0,
      stage: 'start',
      unlocksAt: UNLOCK_CHOICES,
      canRecommend: false,
      dimensions: TASTE_DIMENSIONS.map((spec) => ({
        id: spec.id,
        axis: spec.axis,
        axisLabel: spec.axisLabel,
        pole: spec.pole,
        label: spec.label,
        description: spec.description,
        lean: 0,
        low: 0,
        high: 0,
        certain: false,
        clear: 0,
        agreed: 0
      }))
    }
  }

  async state(): Promise<TasteState> {
    if (!this.isAvailable()) return this.emptyState('The optional AI features are switched off.', 0)
    const context = this.load()
    if (context.ids.length < MIN_IMAGES) {
      return this.emptyState(
        context.ids.length === 0
          ? 'Atlas has not learned any images yet.'
          : `Atlas has learned ${context.ids.length} images so far; it needs at least ${MIN_IMAGES}.`,
        context.ids.length
      )
    }
    const training = this.training(context)
    const z = await this.zScores(context)
    // The compass uses real decisions only: Keep/Pass, and direct choices between pairs that were not picked for being hard.
    // (Hard pairs are great for learning but a biased sample of the library, so they would blur what the compass measures.)
    const unbiased = training.direct.filter((pair) => !pair.adaptive)
    const compassPairs = [...unbiased, ...training.decisions]
    const dimensions: TasteDimension[] = TASTE_DIMENSIONS.map((spec) => {
      const result = leanOf(z.get(spec.id)!, compassPairs, { bootstrap: 500 })
      const enough = compassPairs.length >= 6
      return {
        id: spec.id,
        axis: spec.axis,
        axisLabel: spec.axisLabel,
        pole: spec.pole,
        label: spec.label,
        description: spec.description,
        lean: result.lean,
        low: result.low,
        high: result.high,
        certain: enough && (result.low > 0 || result.high < 0),
        clear: result.clear,
        agreed: result.agreed
      }
    })
    const choices = training.direct.length
    this.scheduleAccuracy(context, training)
    return {
      available: true,
      reason: null,
      embedded: context.ids.length,
      choices,
      excluded: (await this.exclusions(context)).size,
      compassChoices: unbiased.length,
      skipped: training.skipped,
      inferred: { decisions: training.decisions.length, ratings: training.ratings.length },
      accuracy: this.accuracyCache.value,
      accuracyChoices: Math.max(0, this.accuracyCache.choices),
      stage: this.stageOf(choices),
      unlocksAt: UNLOCK_CHOICES,
      canRecommend: this.allPairs(training).length >= UNLOCK_CHOICES,
      dimensions
    }
  }

  /** Cross-validation is the slow part, so it runs just after a reply, not before it. */
  private scheduleAccuracy(context: Context, training: Training): void {
    const n = training.direct.length
    if (n < 15 || this.accuracyCache.choices === n || this.accuracyTimer) return
    if (this.accuracyCache.choices >= 0 && n - this.accuracyCache.choices < 3) return
    this.accuracyTimer = setTimeout(() => {
      this.accuracyTimer = null
      try {
        const value = crossValidatedAccuracy(context.matrix, context.dim, training.direct, {
          lambda: 0.1,
          iterations: 100,
          minPairs: 15
        })
        this.accuracyCache = { choices: n, value }
      } catch {
        // Accuracy is informational only.
      }
    }, 30)
  }

  private toPair(context: Context, aRow: number, bRow: number, round: number, mode: TastePairMode): TastePair | null {
    const items = this.db.getImagesByIds([context.ids[aRow]!, context.ids[bRow]!])
    if (items.length !== 2) return null
    return { a: items[0]!, b: items[1]!, round, mode }
  }

  async nextPair(): Promise<TastePair | null> {
    if (!this.isAvailable()) return null
    const context = this.load()
    if (context.ids.length < MIN_IMAGES) return null
    const training = this.training(context)
    const excluded = await this.exclusions(context)
    const choices = training.direct.length
    const rounds = choices + training.skipped
    const model = choices >= WARM_CHOICES ? this.model(context, training, 100) : null
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = selectNextPair({
        matrix: context.matrix,
        dim: context.dim,
        model,
        seenPairs: training.seen,
        recent: new Set([...training.recent, ...excluded]),
        appearances: training.appearances,
        seed: 13 + rounds * 7919 + attempt,
        exploration: EXPLORATION
      })
      if (!next) return null
      const mode: TastePairMode = model === null ? 'warm' : next.reason
      const pair = this.toPair(context, next.a, next.b, rounds + 1, mode)
      if (pair) return pair
    }
    return null
  }

  async choose(aId: string, bId: string, winnerId: string | null, mode: string | null = null): Promise<TasteStep> {
    if (!this.isAvailable()) throw new Error('The optional AI features are switched off.')
    if (aId === bId) throw new Error('Choose between two different images.')
    this.db.addTasteComparison(aId, bId, winnerId, mode)
    return { state: await this.state(), next: await this.nextPair() }
  }

  async undo(): Promise<TasteStep> {
    const removed = this.db.undoTasteComparison()
    const state = await this.state()
    if (!removed) return { state, next: await this.nextPair() }
    // Show the undone pair again so the user can answer differently.
    const items = this.db.getImagesByIds([removed.a, removed.b])
    const rounds = state.choices + state.skipped + 1
    return {
      state,
      next: items.length === 2 ? { a: items[0]!, b: items[1]!, round: rounds, mode: (removed.mode as TastePairMode | null) ?? 'random' } : await this.nextPair()
    }
  }

  async reset(): Promise<TasteState> {
    this.db.resetTaste()
    this.modelCache = null
    this.accuracyCache = { choices: -1, value: null }
    return this.state()
  }

  async recommend(limit = 24): Promise<TasteRecommendations> {
    if (!this.isAvailable()) return { items: [], trainedOn: 0, message: 'The optional AI features are switched off.' }
    const context = this.load()
    const training = this.training(context)
    const pairs = this.allPairs(training)
    if (pairs.length < UNLOCK_CHOICES) {
      const need = UNLOCK_CHOICES - pairs.length
      return {
        items: [],
        trainedOn: pairs.length,
        message: `Make ${need} more comparison${need === 1 ? '' : 's'} and Atlas can start suggesting images.`
      }
    }
    const w = this.model(context, training, 250)
    if (!w) return { items: [], trainedOn: 0, message: null }
    const scores = scoreAll(context.matrix, context.dim, w)

    const signals = this.db.getDecisionSignals()
    const keepRows = new Set<number>()
    for (const id of signals.keeps) {
      const row = context.rowOf.get(id)
      if (row !== undefined) keepRows.add(row)
    }
    const passRows = new Set<number>()
    for (const id of signals.passes) {
      const row = context.rowOf.get(id)
      if (row !== undefined) passRows.add(row)
    }
    // Suggest things the user has not already judged.
    const excluded = await this.exclusions(context)
    const eligible = (row: number): boolean => !training.shown.has(row) && !keepRows.has(row) && !passRows.has(row) && !excluded.has(row)
    const chosen = diversifiedTop(scores, context.matrix, context.dim, eligible, limit)

    const sorted = Array.from(scores).sort((x, y) => x - y)
    const percentileOf = (score: number): number => {
      let low = 0
      let high = sorted.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (sorted[mid]! < score) low = mid + 1
        else high = mid
      }
      return Math.round((low / sorted.length) * 1000) / 10
    }
    const liked = new Set<number>([...training.winners, ...keepRows])
    const likedRows = Array.from(liked).slice(-400)
    const images = this.db.getImagesByIds(chosen.map((row) => context.ids[row]!))
    const byId = new Map(images.map((image) => [image.id, image]))
    const items: TasteRecommendation[] = []
    for (const row of chosen) {
      const image = byId.get(context.ids[row]!)
      if (!image) continue
      let because: TasteRecommendation['because'] = null
      let best = -1
      let bestRow = -1
      for (const other of likedRows) {
        const similarity = dotRows(context.matrix, context.dim, row, other)
        if (similarity > best) {
          best = similarity
          bestRow = other
        }
      }
      if (bestRow >= 0) because = this.db.getImage(context.ids[bestRow]!)
      items.push({ image, percentile: percentileOf(scores[row]!), because })
    }
    return { items, trainedOn: pairs.length, message: null }
  }

  /**
   * Where the Taste comparisons place each image among the whole library, 0 (least preferred) to 1 (most), or null
   * until enough comparisons were made. It reflects the person's own choices only.
   */
  async preferenceOf(ids: string[]): Promise<{ trainedOn: number; percentile: Map<string, number> } | null> {
    if (!this.isAvailable()) return null
    const context = this.load()
    const training = this.training(context)
    const pairs = this.allPairs(training)
    if (pairs.length < UNLOCK_CHOICES) return null
    const w = this.model(context, training, 250)
    if (!w) return null
    const scores = scoreAll(context.matrix, context.dim, w)
    const sorted = Array.from(scores).sort((x, y) => x - y)
    const percentile = new Map<string, number>()
    for (const id of ids) {
      const row = context.rowOf.get(id)
      if (row === undefined) continue
      let low = 0
      let high = sorted.length
      while (low < high) {
        const mid = (low + high) >> 1
        if (sorted[mid]! < scores[row]!) low = mid + 1
        else high = mid
      }
      percentile.set(id, sorted.length === 0 ? 0.5 : low / sorted.length)
    }
    return { trainedOn: pairs.length, percentile }
  }

  async examples(dimensionId: string): Promise<TasteExamples> {
    const spec = TASTE_DIMENSIONS.find((entry) => entry.id === dimensionId)
    if (!spec || !this.isAvailable()) return { dimensionId, yours: [], library: [] }
    const context = this.load()
    const z = (await this.zScores(context)).get(spec.id)
    if (!z) return { dimensionId, yours: [], library: [] }
    const training = this.training(context)
    const winners = new Set<number>(training.winners)
    const yoursRows = diversifiedTop(z, context.matrix, context.dim, (row) => winners.has(row), 6)
    const libraryRows = diversifiedTop(z, context.matrix, context.dim, () => true, 6)
    const toItems = (rows: number[]) => this.db.getImagesByIds(rows.map((row) => context.ids[row]!))
    return { dimensionId, yours: toItems(yoursRows), library: toItems(libraryRows) }
  }
}
