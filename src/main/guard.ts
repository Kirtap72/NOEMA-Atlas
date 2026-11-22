import type { Embedder } from './embedder'
import type { ReferenceCollection } from './reference'

const TECH_PROMPTS = [
  'a screenshot of a computer screen or software interface',
  'a document, chart, diagram or page of text',
  'a user interface mockup with buttons and labels',
  'a technical test image, a failed render or an image full of glitches and artifacts'
]
const ART_PROMPTS = ['a finished artwork', 'a photograph of a place or a person', 'a painting or illustration']

/**
 * Keeps accidental screenshots, interface captures and technical test images out of taste comparisons, where an
 * unrelated kind of image teaches the wrong thing. The yardstick is the reference collection of finished artworks: an
 * image is left out only when it looks more "technical" than 99.5% of those artworks.
 */
export class TechnicalGuard {
  private threshold: number | null = null
  private tech: Float32Array | null = null
  private art: Float32Array | null = null

  constructor(
    private reference: ReferenceCollection | null,
    private getEmbedder: () => Promise<Embedder>
  ) {}

  private async vectors(dim: number): Promise<{ tech: Float32Array; art: Float32Array }> {
    if (this.tech && this.art) return { tech: this.tech, art: this.art }
    const packTech = this.reference?.poleVectors.get('guard-tech')
    const packArt = this.reference?.poleVectors.get('guard-art')
    if (packTech && packArt) {
      this.tech = packTech
      this.art = packArt
    } else {
      const embedder = await this.getEmbedder()
      const average = async (prompts: string[]): Promise<Float32Array> => {
        const vs = await embedder.embedTexts(prompts)
        const sum = new Float32Array(dim)
        for (const v of vs) for (let i = 0; i < dim; i += 1) sum[i]! += v[i]!
        let n = 0
        for (const x of sum) n += x * x
        n = Math.sqrt(n) || 1
        return sum.map((x) => x / n)
      }
      this.tech = await average(TECH_PROMPTS)
      this.art = await average(ART_PROMPTS)
    }
    return { tech: this.tech, art: this.art }
  }

  private margins(matrix: Float32Array, dim: number, rows: number, tech: Float32Array, art: Float32Array): Float32Array {
    const out = new Float32Array(rows)
    for (let r = 0; r < rows; r += 1) {
      let a = 0
      let b = 0
      for (let i = 0; i < dim; i += 1) {
        a += matrix[r * dim + i]! * tech[i]!
        b += matrix[r * dim + i]! * art[i]!
      }
      out[r] = a - b
    }
    return out
  }

  /** 1 for each image that looks like a screenshot or technical image rather than a finished artwork. */
  async mask(matrix: Float32Array, dim: number, rows: number): Promise<Uint8Array> {
    const { tech, art } = await this.vectors(dim)
    if (this.threshold === null) {
      if (this.reference) {
        const ref = this.margins(this.reference.matrix, this.reference.dim, this.reference.works.length, tech, art)
        const sorted = Array.from(ref).sort((a, b) => a - b)
        this.threshold = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))]!
      } else {
        this.threshold = Infinity // Without a yardstick nothing is excluded: no guessing.
      }
    }
    const margins = this.margins(matrix, dim, rows, tech, art)
    const out = new Uint8Array(rows)
    for (let r = 0; r < rows; r += 1) out[r] = margins[r]! > this.threshold ? 1 : 0
    return out
  }
}
