import type { AtlasDatabase } from './db'
import { EMBEDDING_MODEL, type Embedder } from './embedder'
import type { ImageItem, ImagePage, ImageQuery } from '../shared/types'

/** Only this many best matches are kept per search; beyond that, similarity is noise. */
export const SEMANTIC_RESULT_LIMIT = 400

interface Matrix {
  ids: string[]
  dim: number
  matrix: Float32Array
}

export interface Ranking {
  ids: string[]
  scores: number[]
}

/** Keeps the `limit` highest scores from a flat matrix-vector product without sorting everything. */
export function topMatches(
  matrix: Float32Array,
  dim: number,
  query: Float32Array,
  limit: number,
  skip: number = -1
): Array<{ row: number; score: number }> {
  const rows = dim === 0 ? 0 : Math.floor(matrix.length / dim)
  const best: Array<{ row: number; score: number }> = []
  for (let row = 0; row < rows; row += 1) {
    if (row === skip) continue
    let score = 0
    const base = row * dim
    for (let i = 0; i < dim; i += 1) score += matrix[base + i]! * query[i]!
    if (best.length === limit && score <= best[best.length - 1]!.score) continue
    let low = 0
    let high = best.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (best[mid]!.score >= score) low = mid + 1
      else high = mid
    }
    best.splice(low, 0, { row, score })
    if (best.length > limit) best.pop()
  }
  return best
}

/** Natural-language and "more like this" search over the stored image embeddings. */
export class SemanticSearch {
  private cache: Matrix | null = null
  private queryCache = new Map<string, Float32Array>()
  private rankCache = new Map<string, Ranking>()

  constructor(
    private db: AtlasDatabase,
    private getEmbedder: () => Promise<Embedder>
  ) {}

  /** Call when embeddings were added or the library changed. */
  invalidate(): void {
    this.cache = null
    this.rankCache.clear()
  }

  /** The embedding matrix, shared with other features (taste) so it is loaded once per change. */
  snapshot(): Matrix {
    return this.matrix()
  }

  private matrix(): Matrix {
    if (!this.cache) this.cache = this.db.loadEmbeddingMatrix(EMBEDDING_MODEL)
    return this.cache
  }

  private async textVector(text: string): Promise<Float32Array> {
    const key = text.trim().toLowerCase()
    const hit = this.queryCache.get(key)
    if (hit) return hit
    const embedder = await this.getEmbedder()
    const [vector] = await embedder.embedTexts([key])
    if (!vector) throw new Error('The query could not be understood.')
    this.queryCache.set(key, vector)
    if (this.queryCache.size > 64) this.queryCache.delete(this.queryCache.keys().next().value as string)
    return vector
  }

  /** The embedding of a description, cached; used by Smart Collections as well as by search. */
  embedText(text: string): Promise<Float32Array> {
    return this.textVector(text)
  }

  async rank(input: { text?: string; similarTo?: string }): Promise<Ranking> {
    const key = input.similarTo ? `similar:${input.similarTo}` : `text:${(input.text ?? '').trim().toLowerCase()}`
    const cached = this.rankCache.get(key)
    if (cached) return cached

    const { ids, dim, matrix } = this.matrix()
    let ranking: Ranking = { ids: [], scores: [] }
    if (ids.length > 0) {
      if (input.similarTo) {
        const row = ids.indexOf(input.similarTo)
        if (row < 0) throw new Error('That image has not been indexed yet.')
        const found = topMatches(matrix, dim, matrix.slice(row * dim, (row + 1) * dim), SEMANTIC_RESULT_LIMIT, row)
        ranking = { ids: found.map((m) => ids[m.row]!), scores: found.map((m) => m.score) }
      } else if (input.text?.trim()) {
        const found = topMatches(matrix, dim, await this.textVector(input.text), SEMANTIC_RESULT_LIMIT)
        ranking = { ids: found.map((m) => ids[m.row]!), scores: found.map((m) => m.score) }
      }
    }
    this.rankCache.set(key, ranking)
    if (this.rankCache.size > 24) this.rankCache.delete(this.rankCache.keys().next().value as string)
    return ranking
  }

  /** The `images:list` shape, so the existing feed, grid and lightbox work unchanged. */
  async query(query: ImageQuery, limit: number, offset: number): Promise<ImagePage> {
    const ranking = await this.rank({ text: query.search, similarTo: query.similarTo })
    const filtered: ImageItem[] = this.db.getImagesByIds(ranking.ids).filter((item) => {
      if (item.missing && !query.includeMissing) return false
      if (query.rootId && !this.db.imageInRoot(item.id, query.rootId)) return false
      if (query.minRating && item.rating < query.minRating) return false
      if (query.exactRating && item.rating !== query.exactRating) return false
      if (query.decision && item.decision !== query.decision) return false
      if (query.unreviewed && item.reviewedAt !== null) return false
      if (query.scope === 'favorites' && !item.favorite) return false
      if (typeof query.addedFrom === 'number' && item.addedAt < query.addedFrom) return false
      if (typeof query.addedTo === 'number' && item.addedAt > query.addedTo) return false
      return true
    })
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit }
  }
}
