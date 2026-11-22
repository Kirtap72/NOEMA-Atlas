/**
 * The maths behind the Taste Compass. Everything here is a pure function over unit-length image embeddings and the
 * user's own choices, so it can be tested without the app. Nothing is a judgement made by a model: the user's
 * choices are the only training signal.
 */

export interface PairRef {
  /** Row of the image the user preferred. */
  w: number
  /** Row of the image the user passed over. */
  l: number
  /** 1 for a direct choice, less for choices inferred from Keep/Pass decisions and ratings. */
  weight: number
  /** True when the pair was picked because the model was unsure about it (so it is a biased sample of the library). */
  adaptive?: boolean
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function dotRows(matrix: Float32Array, dim: number, a: number, b: number): number {
  let sum = 0
  const ia = a * dim
  const ib = b * dim
  for (let i = 0; i < dim; i += 1) sum += matrix[ia + i]! * matrix[ib + i]!
  return sum
}

function dotVec(matrix: Float32Array, dim: number, row: number, vector: Float32Array): number {
  let sum = 0
  const base = row * dim
  for (let i = 0; i < dim; i += 1) sum += matrix[base + i]! * vector[i]!
  return sum
}

export interface TrainOptions {
  /** L2 regularisation. Larger values trust each comparison less. */
  lambda?: number
  iterations?: number
}

/**
 * Bradley–Terry preference model on embeddings: P(a preferred over b) = sigmoid(w·(xa − xb)). Fitted by full-batch
 * accelerated gradient descent on the L2-regularised logistic loss. The score of an image is simply w·x.
 */
export function trainPreferenceModel(
  matrix: Float32Array,
  dim: number,
  pairs: PairRef[],
  options: TrainOptions = {}
): Float32Array {
  const lambda = options.lambda ?? 1
  const iterations = options.iterations ?? 250
  const w = new Float32Array(dim)
  if (pairs.length === 0) return w

  const diffs = new Float32Array(pairs.length * dim)
  let totalWeight = 0
  pairs.forEach((pair, index) => {
    const base = index * dim
    const iw = pair.w * dim
    const il = pair.l * dim
    for (let i = 0; i < dim; i += 1) diffs[base + i] = matrix[iw + i]! - matrix[il + i]!
    totalWeight += pair.weight
  })

  // Step size from a Lipschitz estimate of the loss: sigmoid' <= 1/4, scaled by the mean squared pair difference.
  let meanSquare = 0
  for (let j = 0; j < pairs.length; j += 1) {
    let sum = 0
    for (let i = 0; i < dim; i += 1) sum += diffs[j * dim + i]! ** 2
    meanSquare += sum
  }
  meanSquare /= pairs.length
  const step = 1 / (0.25 * totalWeight * meanSquare + lambda)
  const velocity = new Float32Array(dim)
  const lookahead = new Float32Array(dim)
  const gradient = new Float32Array(dim)
  let momentum = 0
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const nextMomentum = (1 + Math.sqrt(1 + 4 * momentum * momentum)) / 2
    const beta = momentum === 0 ? 0 : (momentum - 1) / nextMomentum
    momentum = nextMomentum
    for (let i = 0; i < dim; i += 1) lookahead[i] = w[i]! + beta * velocity[i]!

    gradient.fill(0)
    for (let j = 0; j < pairs.length; j += 1) {
      const base = j * dim
      let margin = 0
      for (let i = 0; i < dim; i += 1) margin += lookahead[i]! * diffs[base + i]!
      const coefficient = -pairs[j]!.weight / (1 + Math.exp(margin))
      for (let i = 0; i < dim; i += 1) gradient[i]! += coefficient * diffs[base + i]!
    }
    for (let i = 0; i < dim; i += 1) {
      gradient[i]! += lambda * lookahead[i]!
      const next = lookahead[i]! - step * gradient[i]!
      velocity[i] = next - w[i]!
      w[i] = next
    }
  }
  return w
}

/** Score of every image under the model: w·x. */
export function scoreAll(matrix: Float32Array, dim: number, w: Float32Array): Float32Array {
  const rows = dim === 0 ? 0 : Math.floor(matrix.length / dim)
  const scores = new Float32Array(rows)
  for (let row = 0; row < rows; row += 1) scores[row] = dotVec(matrix, dim, row, w)
  return scores
}

/** Fraction of pairs where the model prefers the image the user actually preferred. */
export function pairAccuracy(matrix: Float32Array, dim: number, w: Float32Array, pairs: PairRef[]): number {
  if (pairs.length === 0) return 0
  let correct = 0
  for (const pair of pairs) {
    const diff = dotVec(matrix, dim, pair.w, w) - dotVec(matrix, dim, pair.l, w)
    if (diff > 0) correct += 1
    else if (diff === 0) correct += 0.5
  }
  return correct / pairs.length
}

/**
 * Honest estimate of how well the model predicts the user's next choice: k-fold cross-validation over the direct
 * choices. Returns null when there are too few choices for the number to mean anything.
 */
export function crossValidatedAccuracy(
  matrix: Float32Array,
  dim: number,
  pairs: PairRef[],
  options: TrainOptions & { folds?: number; minPairs?: number; seed?: number } = {}
): number | null {
  const minPairs = options.minPairs ?? 15
  if (pairs.length < minPairs) return null
  const folds = Math.min(options.folds ?? 5, pairs.length)
  const random = mulberry32(options.seed ?? 7)
  const order = pairs.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  let correct = 0
  for (let fold = 0; fold < folds; fold += 1) {
    const train: PairRef[] = []
    const test: PairRef[] = []
    order.forEach((index, position) => (position % folds === fold ? test : train).push(pairs[index]!))
    const w = trainPreferenceModel(matrix, dim, train, { ...options, iterations: options.iterations ?? 150 })
    correct += pairAccuracy(matrix, dim, w, test) * test.length
  }
  return correct / pairs.length
}

export interface PairSelectionInput {
  matrix: Float32Array
  dim: number
  /** The current model, or null before there is anything to learn from. */
  model: Float32Array | null
  /** `min:max` keys of pairs already compared or skipped. */
  seenPairs: ReadonlySet<string>
  /** Rows to avoid for now (shown in the last few rounds). */
  recent: ReadonlySet<number>
  /** How many times each row has been shown, so the whole library gets covered. */
  appearances: Int32Array
  seed: number
  /** Chance of a purely random pair, so the model keeps being tested where it believes it is right. */
  exploration?: number
  candidates?: number
}

export const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`)

/**
 * Picks the next pair to show. Early on it prefers clearly different images from rarely shown corners of the library;
 * once a model exists it prefers the pair the model is least sure about (uncertainty sampling), which is the
 * comparison that teaches it the most. Near-duplicates are never offered: choosing between them says nothing.
 */
export function selectNextPair(input: PairSelectionInput): { a: number; b: number; reason: 'explore' | 'uncertain' | 'random' } | null {
  const { matrix, dim, model, seenPairs, recent, appearances, seed } = input
  const rows = dim === 0 ? 0 : Math.floor(matrix.length / dim)
  if (rows < 2) return null
  const random = mulberry32(seed)
  const candidates = input.candidates ?? 300
  const exploration = input.exploration ?? 0.2
  const randomPick = model !== null && random() < exploration

  let best: { a: number; b: number; score: number } | null = null
  let firstValid: { a: number; b: number } | null = null
  for (let attempt = 0; attempt < candidates; attempt += 1) {
    // Tournament of three: prefer images that have been shown least.
    let a = Math.floor(random() * rows)
    for (let t = 0; t < 2; t += 1) {
      const other = Math.floor(random() * rows)
      if (appearances[other]! < appearances[a]!) a = other
    }
    const b = Math.floor(random() * rows)
    if (a === b || recent.has(a) || recent.has(b) || seenPairs.has(pairKey(a, b))) continue
    const similarity = dotRows(matrix, dim, a, b)
    if (similarity > 0.95) continue
    if (!firstValid) firstValid = { a, b }
    const score =
      model === null
        ? similarity + 0.15 * appearances[a]! + 0.15 * appearances[b]! // least similar first, rarely shown first
        : Math.abs(dotVec(matrix, dim, a, model) - dotVec(matrix, dim, b, model)) + 0.15 * appearances[a]! + 0.15 * appearances[b]!
    if (!best || score < best.score) best = { a, b, score }
  }
  if (!best || !firstValid) return null
  if (randomPick) return { ...firstValid, reason: 'random' }
  return { a: best.a, b: best.b, reason: model === null ? 'explore' : 'uncertain' }
}

/**
 * Greedy maximal-marginal-relevance selection: take the highest scores, but skip images that are near-duplicates
 * of ones already chosen, so a recommendation list shows variety rather than one picture twenty times.
 */
export function diversifiedTop(
  scores: Float32Array,
  matrix: Float32Array,
  dim: number,
  eligible: (row: number) => boolean,
  count: number,
  maxSimilarity = 0.9
): number[] {
  const order: number[] = []
  for (let row = 0; row < scores.length; row += 1) if (eligible(row)) order.push(row)
  order.sort((x, y) => scores[y]! - scores[x]!)
  const chosen: number[] = []
  for (const row of order) {
    if (chosen.length >= count) break
    let tooClose = false
    for (const other of chosen) {
      if (dotRows(matrix, dim, row, other) > maxSimilarity) {
        tooClose = true
        break
      }
    }
    if (!tooClose) chosen.push(row)
  }
  return chosen
}

/** z-score of each image's similarity to a concept direction, relative to the whole library. */
export function conceptZScores(matrix: Float32Array, dim: number, concept: Float32Array): Float32Array {
  const raw = scoreAll(matrix, dim, concept)
  let mean = 0
  for (const value of raw) mean += value
  mean /= Math.max(1, raw.length)
  let variance = 0
  for (const value of raw) variance += (value - mean) ** 2
  const std = Math.sqrt(variance / Math.max(1, raw.length)) || 1
  return raw.map((value) => (value - mean) / std)
}

export interface LeanResult {
  /** Mean difference (in library standard deviations) between the images chosen and the ones passed over. */
  lean: number
  /** 99% bootstrap interval for the lean (wide on purpose: six axes are tested at once). */
  low: number
  high: number
  /** Comparisons in which the two pictures clearly differed on this quality, and how often the user chose the stronger one. */
  clear: number
  agreed: number
}

/**
 * How much more of a quality the user's chosen images show than the ones they passed over. Directly measured from
 * their choices; the bootstrap interval says how much to trust it.
 */
export function leanOf(z: Float32Array, pairs: PairRef[], options: { bootstrap?: number; clearMargin?: number; seed?: number } = {}): LeanResult {
  const clearMargin = options.clearMargin ?? 0.25
  const diffs = pairs.map((pair) => z[pair.w]! - z[pair.l]!)
  const n = diffs.length
  if (n === 0) return { lean: 0, low: 0, high: 0, clear: 0, agreed: 0 }
  const mean = diffs.reduce((sum, value) => sum + value, 0) / n
  let clear = 0
  let agreed = 0
  for (const diff of diffs) {
    if (Math.abs(diff) >= clearMargin) {
      clear += 1
      if (diff > 0) agreed += 1
    }
  }
  const B = options.bootstrap ?? 500
  const random = mulberry32(options.seed ?? 11)
  const samples: number[] = []
  for (let b = 0; b < B; b += 1) {
    let sum = 0
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(random() * n)]!
    samples.push(sum / n)
  }
  samples.sort((x, y) => x - y)
  return {
    lean: mean,
    low: samples[Math.floor(B * 0.005)]!,
    high: samples[Math.min(B - 1, Math.floor(B * 0.995))]!,
    clear,
    agreed
  }
}
