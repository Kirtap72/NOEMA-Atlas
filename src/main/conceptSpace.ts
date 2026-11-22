import type { Embedder } from './embedder'
import { TASTE_DIMENSIONS, type DimensionSpec } from './tasteDimensions'

/**
 * The twelve measurable qualities, expressed against a fixed yardstick: the reference collection. A z-score here means
 * "how far from typical art in general", so it does not depend on what a particular user happens to own.
 *
 * Each axis direction is (pole A description) − (pole B description), as in the Taste Compass, so the poles are true
 * opposites. Pole B reuses pole A's numbers with the sign reversed.
 */
export class ConceptSpace {
  private directions = new Map<string, Float32Array>()
  private baseline = new Map<string, { mean: number; std: number }>()
  private conceptCache = new Map<string, Float32Array>()

  constructor(
    private getEmbedder: (() => Promise<Embedder>) | null,
    private reference: { matrix: Float32Array; dim: number; poleVectors?: Map<string, Float32Array> }
  ) {}

  private async poleVector(spec: DimensionSpec): Promise<Float32Array> {
    let vector = this.reference.poleVectors?.get(spec.id) ?? this.conceptCache.get(spec.id)
    if (!vector) {
      if (!this.getEmbedder) throw new Error('The text model is needed to measure this quality.')
      const embedder = await this.getEmbedder()
      const vectors = await embedder.embedTexts(spec.prompts)
      const sum = new Float32Array(this.reference.dim)
      for (const v of vectors) for (let i = 0; i < sum.length; i += 1) sum[i]! += v[i]!
      let norm = 0
      for (const value of sum) norm += value * value
      norm = Math.sqrt(norm) || 1
      vector = sum.map((value) => value / norm)
      this.conceptCache.set(spec.id, vector)
    }
    return vector
  }

  private async prepare(): Promise<void> {
    if (this.directions.size > 0) return
    const { matrix, dim } = this.reference
    const rows = Math.floor(matrix.length / dim)
    const axes = Array.from(new Set(TASTE_DIMENSIONS.map((spec) => spec.axis)))
    for (const axis of axes) {
      const a = TASTE_DIMENSIONS.find((spec) => spec.axis === axis && spec.pole === 'a')
      const b = TASTE_DIMENSIONS.find((spec) => spec.axis === axis && spec.pole === 'b')
      if (!a || !b) continue
      const va = await this.poleVector(a)
      const vb = await this.poleVector(b)
      const direction = va.map((value, i) => value - vb[i]!)
      this.directions.set(axis, direction)
      let mean = 0
      const raw = new Float32Array(rows)
      for (let r = 0; r < rows; r += 1) {
        let s = 0
        for (let i = 0; i < dim; i += 1) s += matrix[r * dim + i]! * direction[i]!
        raw[r] = s
        mean += s
      }
      mean /= Math.max(1, rows)
      let variance = 0
      for (const value of raw) variance += (value - mean) ** 2
      this.baseline.set(axis, { mean, std: Math.sqrt(variance / Math.max(1, rows)) || 1 })
    }
  }

  /** z-scores of `rows` embeddings (rows × dim) on every dimension, relative to the reference collection. */
  async zScores(matrix: Float32Array, rows: number): Promise<Map<string, Float32Array>> {
    await this.prepare()
    const { dim } = this.reference
    const out = new Map<string, Float32Array>()
    const perAxis = new Map<string, Float32Array>()
    for (const [axis, direction] of this.directions) {
      const base = this.baseline.get(axis)!
      const z = new Float32Array(rows)
      for (let r = 0; r < rows; r += 1) {
        let s = 0
        for (let i = 0; i < dim; i += 1) s += matrix[r * dim + i]! * direction[i]!
        z[r] = (s - base.mean) / base.std
      }
      perAxis.set(axis, z)
    }
    for (const spec of TASTE_DIMENSIONS) {
      const z = perAxis.get(spec.axis)
      if (!z) continue
      out.set(spec.id, spec.pole === 'a' ? z : z.map((v) => -v))
    }
    return out
  }

  /** Reference z-scores, computed once. */
  private referenceZ: Map<string, Float32Array> | null = null
  async referenceScores(): Promise<Map<string, Float32Array>> {
    if (!this.referenceZ) {
      const rows = Math.floor(this.reference.matrix.length / this.reference.dim)
      this.referenceZ = await this.zScores(this.reference.matrix, rows)
    }
    return this.referenceZ
  }
}
