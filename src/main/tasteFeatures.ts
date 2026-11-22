/**
 * Richer taste models on top of the existing Bradley–Terry idea.
 *
 * The Taste Compass fits one straight line through the embedding space (`trainPreferenceModel`). A person who likes
 * romantic landscapes AND minimalist architecture AND abstract sculpture has no single direction: the line lands
 * in the middle and prefers none of them. Here an image is described by its position (the embedding) plus how close
 * it is to a fixed set of *landmark* works spread across the whole collection (radial-basis features, a Nyström-style
 * kernel approximation). A model that is still linear in these features is still convex, trains in milliseconds and
 * has the same pairwise logistic loss, but it can place several separate peaks of preference.
 *
 * Responses other than "A over B" are pointwise: "I like both" is a positive for each image, "neither" a negative
 * for each. They share the same loss, so every kind of answer feeds one model.
 */
import { dotRows, mulberry32 } from './taste'

export interface FeatureSpace {
  dim: number
  landmarks: Float32Array // m × dim
  m: number
  gamma: number
  /** Mean of each radial feature over the collection, so the features are centred. */
  mean: Float32Array
  /** Weight of the raw embedding and of the radial features in the combined description. */
  rawScale: number
  radialScale: number
  /** Length of the combined feature vector. */
  size: number
}

/** Farthest-point sampling: m works that cover the collection as evenly as possible. Deterministic. */
export function selectLandmarks(matrix: Float32Array, dim: number, m: number, seed = 5): Float32Array {
  const rows = Math.floor(matrix.length / dim)
  const count = Math.min(m, rows)
  const random = mulberry32(seed)
  const chosen: number[] = [Math.floor(random() * rows)]
  const best = new Float32Array(rows).fill(-2)
  while (chosen.length < count) {
    const last = chosen[chosen.length - 1]!
    let far = 0
    let farScore = 2
    for (let row = 0; row < rows; row += 1) {
      best[row] = Math.max(best[row]!, dotRows(matrix, dim, row, last))
      if (best[row]! < farScore) {
        farScore = best[row]!
        far = row
      }
    }
    chosen.push(far)
  }
  const out = new Float32Array(count * dim)
  chosen.forEach((row, i) => out.set(matrix.subarray(row * dim, (row + 1) * dim), i * dim))
  return out
}

export function makeFeatureSpace(
  reference: Float32Array,
  dim: number,
  options: { landmarks?: number; gamma?: number; rawScale?: number; radialScale?: number; seed?: number } = {}
): FeatureSpace {
  const landmarks = selectLandmarks(reference, dim, options.landmarks ?? 160, options.seed ?? 5)
  const m = landmarks.length / dim
  const gamma = options.gamma ?? 6
  const space: FeatureSpace = {
    dim,
    landmarks,
    m,
    gamma,
    mean: new Float32Array(m),
    rawScale: options.rawScale ?? 1,
    radialScale: options.radialScale ?? 1.5,
    size: dim + m
  }
  const rows = Math.floor(reference.length / dim)
  const sum = new Float64Array(m)
  for (let r = 0; r < rows; r += 1) {
    for (let j = 0; j < m; j += 1) {
      let dot = 0
      for (let i = 0; i < dim; i += 1) dot += reference[r * dim + i]! * landmarks[j * dim + i]!
      sum[j]! += Math.exp(-gamma * (1 - dot))
    }
  }
  for (let j = 0; j < m; j += 1) space.mean[j] = sum[j]! / Math.max(1, rows)
  return space
}

/** Combined features for `rows` embeddings: [raw embedding · rawScale, centred radial features · radialScale]. */
export function transformRows(space: FeatureSpace, matrix: Float32Array, rows: number): Float32Array {
  const { dim, m, gamma, landmarks, mean, rawScale, radialScale, size } = space
  const out = new Float32Array(rows * size)
  for (let r = 0; r < rows; r += 1) {
    const base = r * size
    for (let i = 0; i < dim; i += 1) out[base + i] = matrix[r * dim + i]! * rawScale
    for (let j = 0; j < m; j += 1) {
      let dot = 0
      for (let i = 0; i < dim; i += 1) dot += matrix[r * dim + i]! * landmarks[j * dim + i]!
      out[base + dim + j] = (Math.exp(-gamma * (1 - dot)) - mean[j]!) * radialScale
    }
  }
  return out
}

export interface MixedPair {
  w: number
  l: number
  weight: number
}
export interface MixedPoint {
  i: number
  /** +1 liked, -1 passed on. */
  y: 1 | -1
  weight: number
}

export interface FeatureModel {
  w: Float32Array
  bias: number
}

/**
 * Convex logistic model over features: pairwise terms log(1 + exp(-(f(a) - f(b)))) and pointwise terms
 * log(1 + exp(-y f(x))) with f(x) = w·x + bias, plus L2 regularisation. Accelerated gradient descent.
 */
export function trainMixedModel(
  features: Float32Array,
  size: number,
  pairs: MixedPair[],
  points: MixedPoint[],
  options: { lambda?: number; iterations?: number } = {}
): FeatureModel {
  const lambda = options.lambda ?? 0.3
  const iterations = options.iterations ?? 250
  const w = new Float32Array(size)
  let bias = 0
  if (pairs.length === 0 && points.length === 0) return { w, bias }

  // Curvature estimate for the step size.
  let curvature = 0
  const rowSquare = (row: number): number => {
    let s = 0
    for (let i = 0; i < size; i += 1) s += features[row * size + i]! ** 2
    return s
  }
  for (const pair of pairs) {
    let s = 0
    for (let i = 0; i < size; i += 1) s += (features[pair.w * size + i]! - features[pair.l * size + i]!) ** 2
    curvature += 0.25 * pair.weight * s
  }
  for (const point of points) curvature += 0.25 * point.weight * (rowSquare(point.i) + 1)
  const step = 1 / (curvature + lambda)

  const velocity = new Float32Array(size)
  let biasVelocity = 0
  const look = new Float32Array(size)
  const gradient = new Float32Array(size)
  let momentum = 0
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = (1 + Math.sqrt(1 + 4 * momentum * momentum)) / 2
    const beta = momentum === 0 ? 0 : (momentum - 1) / next
    momentum = next
    for (let i = 0; i < size; i += 1) look[i] = w[i]! + beta * velocity[i]!
    const lookBias = bias + beta * biasVelocity

    gradient.fill(0)
    let biasGradient = 0
    for (const pair of pairs) {
      let margin = 0
      for (let i = 0; i < size; i += 1) margin += look[i]! * (features[pair.w * size + i]! - features[pair.l * size + i]!)
      const c = -pair.weight / (1 + Math.exp(margin))
      for (let i = 0; i < size; i += 1) gradient[i]! += c * (features[pair.w * size + i]! - features[pair.l * size + i]!)
    }
    for (const point of points) {
      let f = lookBias
      for (let i = 0; i < size; i += 1) f += look[i]! * features[point.i * size + i]!
      const c = (-point.y * point.weight) / (1 + Math.exp(point.y * f))
      for (let i = 0; i < size; i += 1) gradient[i]! += c * features[point.i * size + i]!
      biasGradient += c
    }
    for (let i = 0; i < size; i += 1) {
      gradient[i]! += lambda * look[i]!
      const updated = look[i]! - step * gradient[i]!
      velocity[i] = updated - w[i]!
      w[i] = updated
    }
    const updatedBias = lookBias - step * biasGradient
    biasVelocity = updatedBias - bias
    bias = updatedBias
  }
  return { w, bias }
}

export function scoreFeatures(features: Float32Array, size: number, model: FeatureModel): Float32Array {
  const rows = Math.floor(features.length / size)
  const out = new Float32Array(rows)
  for (let r = 0; r < rows; r += 1) {
    let s = model.bias
    for (let i = 0; i < size; i += 1) s += model.w[i]! * features[r * size + i]!
    out[r] = s
  }
  return out
}

/** Fraction of held-out pairs and points the model gets right. Pairs: winner scores higher. Points: sign matches. */
export function mixedAccuracy(scores: Float32Array, pairs: MixedPair[], points: MixedPoint[]): number {
  let correct = 0
  let total = 0
  for (const pair of pairs) {
    total += 1
    const d = scores[pair.w]! - scores[pair.l]!
    correct += d > 0 ? 1 : d === 0 ? 0.5 : 0
  }
  for (const point of points) {
    total += 1
    correct += scores[point.i]! * point.y > 0 ? 1 : 0
  }
  return total === 0 ? 0 : correct / total
}

/** k-fold cross-validated accuracy for one model configuration. Returns null with too little data. */
export function crossValidateMixed(
  features: Float32Array,
  size: number,
  pairs: MixedPair[],
  points: MixedPoint[],
  options: { lambda?: number; iterations?: number; folds?: number; minEvents?: number; seed?: number } = {}
): number | null {
  const total = pairs.length + points.length
  if (total < (options.minEvents ?? 15)) return null
  const folds = Math.min(options.folds ?? 5, total)
  const random = mulberry32(options.seed ?? 3)
  const events: Array<{ pair?: MixedPair; point?: MixedPoint }> = [...pairs.map((pair) => ({ pair })), ...points.map((point) => ({ point }))]
  for (let i = events.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[events[i], events[j]] = [events[j]!, events[i]!]
  }
  let correct = 0
  for (let fold = 0; fold < folds; fold += 1) {
    const trainPairs: MixedPair[] = []
    const trainPoints: MixedPoint[] = []
    const testPairs: MixedPair[] = []
    const testPoints: MixedPoint[] = []
    events.forEach((event, index) => {
      const test = index % folds === fold
      if (event.pair) (test ? testPairs : trainPairs).push(event.pair)
      else if (event.point) (test ? testPoints : trainPoints).push(event.point)
    })
    const model = trainMixedModel(features, size, trainPairs, trainPoints, { lambda: options.lambda, iterations: options.iterations ?? 120 })
    const scores = scoreFeatures(features, size, model)
    correct += mixedAccuracy(scores, testPairs, testPoints) * (testPairs.length + testPoints.length)
  }
  return correct / total
}
