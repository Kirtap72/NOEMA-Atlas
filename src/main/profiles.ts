/** Pure helpers shared by the artistic-identity and discovered-taste profiles. */
import { dotRows, mulberry32 } from './taste'
import type { DimensionSpec } from './tasteDimensions'
import type { ProfileDimension } from '../shared/types'

/**
 * Where a set of images sits on each quality, relative to the reference collection (0 = typical of art in general).
 * `valuesByDimension` holds one z-score per member image. A quality is called out only when it is both statistically
 * reliable (99% bootstrap interval excludes zero) and not trivially small, and there are enough images to say so.
 */
export function describeSet(
  specs: DimensionSpec[],
  valuesByDimension: Map<string, Float32Array>,
  options: { minMembers?: number; minEffect?: number; bootstrap?: number; seed?: number } = {}
): ProfileDimension[] {
  const minMembers = options.minMembers ?? 5
  const minEffect = options.minEffect ?? 0.3
  const B = options.bootstrap ?? 500
  return specs.map((spec) => {
    const values = valuesByDimension.get(spec.id) ?? new Float32Array(0)
    const n = values.length
    if (n === 0) {
      return { id: spec.id, label: spec.label, axis: spec.axis, axisLabel: spec.axisLabel, pole: spec.pole, mean: 0, low: 0, high: 0, certain: false, n: 0 }
    }
    let mean = 0
    for (const v of values) mean += v
    mean /= n
    const random = mulberry32(options.seed ?? 17)
    const samples: number[] = []
    for (let b = 0; b < B; b += 1) {
      let sum = 0
      for (let i = 0; i < n; i += 1) sum += values[Math.floor(random() * n)]!
      samples.push(sum / n)
    }
    samples.sort((x, y) => x - y)
    const low = samples[Math.floor(B * 0.005)]!
    const high = samples[Math.min(B - 1, Math.floor(B * 0.995))]!
    const certain = n >= minMembers && (low > 0 || high < 0) && Math.abs(mean) >= minEffect
    return { id: spec.id, label: spec.label, axis: spec.axis, axisLabel: spec.axisLabel, pole: spec.pole, mean, low, high, certain, n }
  })
}

export interface Cluster {
  members: number[]
  centroid: Float32Array
}

function kmeans(matrix: Float32Array, dim: number, rows: number[], k: number, seed: number): { assign: Int32Array; centroids: Float32Array[]; score: number } {
  const random = mulberry32(seed)
  const n = rows.length
  const centroids: Float32Array[] = []
  centroids.push(matrix.slice(rows[Math.floor(random() * n)]! * dim, (rows[Math.floor(random() * n)]! + 1) * dim))
  const first = rows[Math.floor(random() * n)]!
  centroids[0] = matrix.slice(first * dim, (first + 1) * dim)
  const nearest = new Float32Array(n).fill(-2)
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1]!
    let total = 0
    const weights = new Float32Array(n)
    for (let i = 0; i < n; i += 1) {
      let s = 0
      for (let d = 0; d < dim; d += 1) s += matrix[rows[i]! * dim + d]! * last[d]!
      nearest[i] = Math.max(nearest[i]!, s)
      weights[i] = Math.max(0, 1 - nearest[i]!) ** 2
      total += weights[i]!
    }
    let pick = random() * total
    let chosen = n - 1
    for (let i = 0; i < n; i += 1) {
      pick -= weights[i]!
      if (pick <= 0) {
        chosen = i
        break
      }
    }
    centroids.push(matrix.slice(rows[chosen]! * dim, (rows[chosen]! + 1) * dim))
  }
  const assign = new Int32Array(n).fill(-1)
  let score = 0
  for (let iteration = 0; iteration < 25; iteration += 1) {
    let changed = 0
    score = 0
    for (let i = 0; i < n; i += 1) {
      let best = 0
      let bestScore = -2
      for (let c = 0; c < k; c += 1) {
        let s = 0
        for (let d = 0; d < dim; d += 1) s += matrix[rows[i]! * dim + d]! * centroids[c]![d]!
        if (s > bestScore) {
          bestScore = s
          best = c
        }
      }
      score += bestScore
      if (assign[i] !== best) {
        assign[i] = best
        changed += 1
      }
    }
    if (changed === 0) break
    const sums = Array.from({ length: k }, () => new Float32Array(dim))
    const counts = new Int32Array(k)
    for (let i = 0; i < n; i += 1) {
      counts[assign[i]!] = (counts[assign[i]!] ?? 0) + 1
      for (let d = 0; d < dim; d += 1) sums[assign[i]!]![d]! += matrix[rows[i]! * dim + d]!
    }
    for (let c = 0; c < k; c += 1) {
      if (counts[c] === 0) continue
      let norm = 0
      for (let d = 0; d < dim; d += 1) norm += sums[c]![d]! ** 2
      norm = Math.sqrt(norm) || 1
      centroids[c] = sums[c]!.map((v) => v / norm)
    }
  }
  return { assign, centroids, score }
}

/** Mean cosine-distance silhouette of a clustering. */
function silhouette(matrix: Float32Array, dim: number, rows: number[], assign: Int32Array, k: number): number {
  const n = rows.length
  if (k < 2) return 0
  let total = 0
  for (let i = 0; i < n; i += 1) {
    const sums = new Float64Array(k)
    const counts = new Int32Array(k)
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue
      sums[assign[j]!]! += 1 - dotRows(matrix, dim, rows[i]!, rows[j]!)
      counts[assign[j]!] = (counts[assign[j]!] ?? 0) + 1
    }
    const own = assign[i]!
    if ((counts[own] ?? 0) === 0) continue
    const a = sums[own]! / counts[own]!
    let b = Infinity
    for (let c = 0; c < k; c += 1) if (c !== own && (counts[c] ?? 0) > 0) b = Math.min(b, sums[c]! / counts[c]!)
    if (!Number.isFinite(b)) continue
    total += (b - a) / Math.max(a, b, 1e-9)
  }
  return total / n
}

/**
 * Finds separate groups ("modes") among a set of images. A person can love several unrelated things, so a single
 * average would describe none of them. Splits only when the groups are clearly separated and none is tiny; otherwise
 * returns one group. Deterministic.
 */
export function findModes(
  matrix: Float32Array,
  dim: number,
  rows: number[],
  options: { maxModes?: number; minSilhouette?: number; minSize?: number; seed?: number; maxCentroidSimilarity?: number } = {}
): Cluster[] {
  const n = rows.length
  const centroidOf = (members: number[]): Float32Array => {
    const sum = new Float32Array(dim)
    for (const r of members) for (let d = 0; d < dim; d += 1) sum[d]! += matrix[r * dim + d]!
    let norm = 0
    for (const v of sum) norm += v * v
    norm = Math.sqrt(norm) || 1
    return sum.map((v) => v / norm)
  }
  const single: Cluster[] = [{ members: rows.slice(), centroid: centroidOf(rows) }]
  const minSize = options.minSize ?? Math.max(3, Math.ceil(n * 0.12))
  if (n < minSize * 2) return single
  const maxModes = Math.min(options.maxModes ?? 6, Math.floor(n / minSize))
  const minSilhouette = options.minSilhouette ?? 0.1
  let best: { k: number; assign: Int32Array; sil: number } | null = null
  for (let k = 2; k <= maxModes; k += 1) {
    let top: { assign: Int32Array; score: number } | null = null
    for (let restart = 0; restart < 4; restart += 1) {
      const result = kmeans(matrix, dim, rows, k, (options.seed ?? 29) + restart * 101 + k)
      if (!top || result.score > top.score) top = result
    }
    const assign = top!.assign
    const sizes = new Int32Array(k)
    for (const a of assign) sizes[a] = (sizes[a] ?? 0) + 1
    if (Array.from(sizes).some((s) => s < minSize)) continue
    const sil = silhouette(matrix, dim, rows, assign, k)
    if (!best || sil > best.sil + 0.01) best = { k, assign, sil }
  }
  if (!best || best.sil < minSilhouette) return single
  const clusters: Cluster[] = Array.from({ length: best.k }, () => ({ members: [] as number[], centroid: new Float32Array(dim) }))
  rows.forEach((row, i) => clusters[best!.assign[i]!]!.members.push(row))
  for (const cluster of clusters) cluster.centroid = centroidOf(cluster.members)
  // Groups carved out of one coherent set always have nearly identical centres; genuinely separate tastes do not.
  const maxCentroidSimilarity = options.maxCentroidSimilarity ?? 0.9
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      let s2 = 0
      for (let d = 0; d < dim; d += 1) s2 += clusters[i]!.centroid[d]! * clusters[j]!.centroid[d]!
      if (s2 > maxCentroidSimilarity) return single
    }
  }
  return clusters.sort((a, b) => b.members.length - a.members.length)
}

/** Members closest to a centroid, with near-duplicates skipped, for showing as examples. */
export function representatives(matrix: Float32Array, dim: number, members: number[], centroid: Float32Array, count: number, maxSimilarity = 0.93): number[] {
  const scored = members.map((row) => {
    let s = 0
    for (let d = 0; d < dim; d += 1) s += matrix[row * dim + d]! * centroid[d]!
    return { row, s }
  })
  scored.sort((x, y) => y.s - x.s)
  const out: number[] = []
  for (const { row } of scored) {
    if (out.length >= count) break
    if (out.some((other) => dotRows(matrix, dim, row, other) > maxSimilarity)) continue
    out.push(row)
  }
  return out
}
