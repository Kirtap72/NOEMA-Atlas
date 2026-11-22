/**
 * The matching behind Smart Collections. Pure functions over vectors and numbers, so it can be tested without the
 * image model: the caller supplies the embedded description and the stored image vectors.
 *
 * Two kinds of evidence are combined:
 *  - how close each image is to the description, as the image model sees it (cosine similarity, turned into a
 *    z-score against the rest of the library so "close" means the same thing in a small and a large library);
 *  - measurable colour and shape: hue shares, brightness, colour strength and aspect ratio taken from the pixels.
 * The strictness slider moves the cut-off for both.
 */
import { colourFit, decodeHues, toneFit, vividnessFit, type ImageStats } from './imageStats'
import { semanticText, type SmartCriteria } from '../shared/smart'

export const SMART_MEMBER_LIMIT = 5000

export interface MeasuredImage extends ImageStats {
  width: number
  height: number
}

export interface MatchMember {
  id: string
  /** Higher is a better match. Only the order matters to the database. */
  score: number
  /** 0 to 100, for display. */
  match: number
}

export interface MatchResult {
  members: MatchMember[]
  /** Images that were looked at. */
  considered: number
  /** True when the description is so far from every image that nothing is shown rather than the least bad. */
  nothingFits: boolean
  /** Colour measurements are still being made for this many images. */
  unmeasured: number
  /** Facts about the cut-off, for the explanation. */
  cutoff: { z: number; top: number } | null
  semantic: boolean
}

export interface MatchInput {
  ids: string[]
  dim: number
  matrix: Float32Array
  /** The embedded description; null when there is none or no model. */
  text: Float32Array | null
  avoid: Float32Array | null
  stats: Map<string, MeasuredImage>
  shapes: Map<string, { width: number; height: number }>
  criteria: SmartCriteria
  /** Take everything above the library average, best first: for looking just beyond a collection. */
  loose?: boolean
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += vector[i]! * vector[i]!
  const norm = Math.sqrt(sum) || 1
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / norm
  return out
}

function rowMean(matrix: Float32Array, dim: number, rows: number[]): Float32Array | null {
  if (rows.length === 0) return null
  const out = new Float32Array(dim)
  for (const row of rows) for (let i = 0; i < dim; i += 1) out[i]! += matrix[row * dim + i]!
  for (let i = 0; i < dim; i += 1) out[i]! /= rows.length
  return out
}

function similarities(matrix: Float32Array, dim: number, rows: number, query: Float32Array): Float32Array {
  const out = new Float32Array(rows)
  for (let row = 0; row < rows; row += 1) {
    let score = 0
    const base = row * dim
    for (let i = 0; i < dim; i += 1) score += matrix[base + i]! * query[i]!
    out[row] = score
  }
  return out
}

function zScores(values: Float32Array): { z: Float32Array; top: number } {
  let mean = 0
  for (const value of values) mean += value
  mean /= Math.max(1, values.length)
  let variance = 0
  for (const value of values) variance += (value - mean) * (value - mean)
  const std = Math.max(1e-4, Math.sqrt(variance / Math.max(1, values.length)))
  const z = new Float32Array(values.length)
  let top = -Infinity
  for (let i = 0; i < values.length; i += 1) {
    z[i] = (values[i]! - mean) / std
    if (z[i]! > top) top = z[i]!
  }
  return { z, top }
}

/**
 * How far up from the library average to the very best match an image must reach to be included: 35% when
 * relaxed, 80% when strict. Measuring against the best match (not a fixed number) works whether the description
 * fits two images or half the library.
 */
export function floorFraction(strictness: number): number {
  return 0.35 + (Math.max(0, Math.min(100, strictness)) / 100) * 0.45
}

/** If even the best image is this close to the average, nothing in the library really fits the description. */
export const MIN_TOP_Z = 0.3

/** The lowest fit of each measured colour or tone that still counts. 0.1 when relaxed, 0.6 when strict. */
export function fitCutoff(strictness: number): number {
  return 0.1 + (Math.max(0, Math.min(100, strictness)) / 100) * 0.5
}

export function shapeMatches(shape: SmartCriteria['shape'], width: number, height: number): boolean {
  if (shape === 'any') return true
  if (width <= 0 || height <= 0) return false
  const aspect = width / height
  if (shape === 'portrait') return aspect < 0.87
  if (shape === 'landscape') return aspect > 1.15
  return aspect >= 0.87 && aspect <= 1.15
}

/** True when a description or pinned images need the image model. */
export function needsModel(criteria: SmartCriteria): boolean {
  return semanticText(criteria) !== '' || criteria.likes.length > 0
}

export function match(input: MatchInput): MatchResult {
  const { criteria, stats, shapes } = input
  const strictness = criteria.strictness
  const dislikes = new Set(criteria.dislikes)
  const likes = new Set(criteria.likes)
  const measured: Array<{ kind: 'colour' | 'tone' | 'vividness'; value: string }> = [
    ...criteria.colours.map((value) => ({ kind: 'colour' as const, value })),
    ...(criteria.tone !== 'any' ? [{ kind: 'tone' as const, value: criteria.tone }] : []),
    ...(criteria.vividness !== 'any' ? [{ kind: 'vividness' as const, value: criteria.vividness }] : [])
  ]

  const rows = input.dim === 0 ? 0 : Math.floor(input.matrix.length / input.dim)
  const rowOf = new Map(input.ids.map((id, row) => [id, row]))

  // 1. What the image model thinks. The description, the pinned images and the ruled-out images all steer one direction.
  let z: Float32Array | null = null
  let top = 0
  let nothingFits = false
  const useModel = rows > 0 && (input.text !== null || likes.size > 0)
  if (useModel) {
    const direction = new Float32Array(input.dim)
    if (input.text) for (let i = 0; i < input.dim; i += 1) direction[i]! += input.text[i]!
    const likeMean = rowMean(input.matrix, input.dim, criteria.likes.map((id) => rowOf.get(id)).filter((row): row is number => row !== undefined))
    if (likeMean) for (let i = 0; i < input.dim; i += 1) direction[i]! += (input.text ? 0.7 : 1) * likeMean[i]!
    const scored = zScores(similarities(input.matrix, input.dim, rows, normalize(direction)))
    z = scored.z
    top = scored.top
    nothingFits = top < MIN_TOP_Z
  }
  // Ruled-out images leave the collection, and images that resemble them rank lower; they never move the cut-off.
  let zDislike: Float32Array | null = null
  const dislikeMean = rows > 0 ? rowMean(input.matrix, input.dim, criteria.dislikes.map((id) => rowOf.get(id)).filter((row): row is number => row !== undefined)) : null
  if (dislikeMean) zDislike = zScores(similarities(input.matrix, input.dim, rows, normalize(dislikeMean))).z
  let zAvoid: Float32Array | null = null
  let avoidFloor = Infinity
  if (input.avoid && rows > 0) {
    const scored = zScores(similarities(input.matrix, input.dim, rows, input.avoid))
    zAvoid = scored.z
    if (scored.top >= MIN_TOP_Z) avoidFloor = floorFraction(strictness) * scored.top
  }

  // 2. Which images are candidates at all.
  const universe: string[] = useModel ? input.ids : measured.length > 0 ? Array.from(stats.keys()) : Array.from(shapes.keys())
  // With a measured colour, tone or strength as well, the description has two witnesses and needs to be less sure alone.
  const zFloor = input.loose ? 0 : floorFraction(strictness) * top * (measured.length > 0 ? 0.5 : 1)
  const minFit = fitCutoff(strictness)
  let unmeasured = 0
  const members: MatchMember[] = []

  // When nothing fits, only images the user pinned by hand are still shown.
  for (const id of nothingFits ? universe.filter((candidate) => likes.has(candidate)) : universe) {
    if (dislikes.has(id)) continue
    const row = rowOf.get(id)
    const pinned = likes.has(id)
    const shape = shapes.get(id)
    if (!pinned && !shapeMatches(criteria.shape, shape?.width ?? 0, shape?.height ?? 0)) continue

    let zi = 0
    if (z) {
      if (row === undefined) continue
      zi = z[row]!
      if (!pinned && zi < zFloor) continue
    }

    let fitMean = 0
    if (measured.length > 0) {
      const image = stats.get(id)
      if (!image) {
        if (!pinned) {
          unmeasured += 1
          continue
        }
      } else {
        let sum = 0
        let ok = true
        for (const wanted of measured) {
          const fit =
            wanted.kind === 'colour'
              ? colourFit(image, wanted.value as Parameters<typeof colourFit>[1])
              : wanted.kind === 'tone'
                ? toneFit(image, wanted.value as 'dark' | 'bright')
                : vividnessFit(image, wanted.value as 'vivid' | 'muted' | 'mono')
          sum += fit
          if (fit < minFit) ok = false
        }
        fitMean = sum / measured.length
        if (!ok && !pinned) continue
      }
    }

    let penalty = 0
    if (zAvoid && row !== undefined) {
      const avoided = zAvoid[row]!
      if (!pinned && avoided >= avoidFloor && avoided > zi * 0.8) continue
      penalty = 0.5 * Math.max(0, avoided)
    }

    if (zDislike && row !== undefined) penalty += 0.4 * Math.max(0, zDislike[row]!)
    const score = (z ? zi : 0) + (measured.length > 0 ? 1.5 * fitMean : 0) - penalty + (pinned ? 10 : 0)
    let display: number
    if (z) display = 55 + (45 * (zi - zFloor)) / Math.max(0.5, top - zFloor)
    else if (measured.length > 0) display = 100 * fitMean
    else display = 100
    members.push({ id, score, match: Math.max(1, Math.min(100, Math.round(pinned ? Math.max(display, 90) : display))) })
  }

  members.sort((a, b) => b.score - a.score)
  return {
    members: members.slice(0, SMART_MEMBER_LIMIT),
    considered: universe.length,
    nothingFits,
    unmeasured,
    cutoff: z ? { z: zFloor, top } : null,
    semantic: useModel
  }
}

/** Turns the stored rows of the database into the measured form used above. */
export function toMeasured(row: { lightness: number; contrast: number; saturation: number; hues: Uint8Array; width: number; height: number }): MeasuredImage {
  return { lightness: row.lightness, contrast: row.contrast, saturation: row.saturation, hues: decodeHues(row.hues), width: row.width, height: row.height }
}
