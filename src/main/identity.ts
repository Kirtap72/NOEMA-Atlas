import type { AtlasDatabase } from './db'
import type { ConceptSpace } from './conceptSpace'
import { describeSet, findModes, representatives } from './profiles'
import type { ReferenceCollection } from './reference'
import type { SemanticSearch } from './semantic'
import { dotRows } from './taste'
import { TASTE_DIMENSIONS } from './tasteDimensions'
import type { IdentityState, ImageItem, ProfileDimension, ProfileMode, ReferenceWork } from '../shared/types'

export const MIN_FAVORITES = 3

export interface IdentityData {
  state: IdentityState
  /** Rows (in the library matrix) of the favorites that have embeddings. */
  rows: number[]
  ids: string[]
  /** One centroid (in the shared embedding space) per mode, in the same order as `state.modes`. */
  centroids: Float32Array[]
  /** The favorites' embeddings (ids.length × dim) and their z-scores per quality, aligned with `ids`. */
  vectors: Float32Array
  z: Map<string, Float32Array>
  dim: number
}

/**
 * "My Artistic Identity": what the images the user explicitly marked as favorites have in common, measured against
 * the reference collection so that the result does not depend on what else is in the library. It only ever describes
 * favorites. How common a style is in the rest of the library is not evidence about taste, and the absence of a
 * style among favorites is never read as dislike.
 */
export class IdentityEngine {
  constructor(
    private db: AtlasDatabase,
    private semantic: SemanticSearch,
    private reference: ReferenceCollection,
    private concepts: ConceptSpace,
    /** True when the image model is installed and the AI features are on, so library embeddings exist. */
    private libraryAvailable: () => boolean
  ) {}

  private empty(reason: string, favorites = 0, learned = 0): IdentityState {
    return { available: false, reason, favorites, learned, pending: Math.max(0, favorites - learned), tentative: true, modes: [], dimensions: [] }
  }

  /** The reference works closest to a vector, from different shelves where possible. */
  private kindredOf(vector: Float32Array, count: number): { works: ReferenceWork[]; shelves: Array<{ id: string; label: string; count: number }> } {
    const { matrix, dim, works } = this.reference
    const scored = works.map((_, r) => {
      let s = 0
      for (let i = 0; i < dim; i += 1) s += matrix[r * dim + i]! * vector[i]!
      return { r, s }
    })
    scored.sort((x, y) => y.s - x.s)
    const picked: number[] = []
    const perShelf = new Map<string, number>()
    for (const { r } of scored) {
      if (picked.length >= count) break
      const shelf = works[r]!.shelf
      if ((perShelf.get(shelf) ?? 0) >= 2) continue
      if (picked.some((o) => dotRows(matrix, dim, r, o) > 0.93)) continue
      picked.push(r)
      perShelf.set(shelf, (perShelf.get(shelf) ?? 0) + 1)
    }
    const tally = new Map<string, { label: string; count: number }>()
    for (const { r } of scored.slice(0, 15)) {
      const w = works[r]!
      tally.set(w.shelf, { label: w.shelfLabel, count: (tally.get(w.shelf)?.count ?? 0) + 1 })
    }
    return {
      works: picked.map((r) => works[r]!),
      shelves: Array.from(tally.entries()).map(([id, v]) => ({ id, label: v.label, count: v.count })).sort((a, b) => b.count - a.count).slice(0, 3)
    }
  }

  /** Identity as of a moment: only favorites marked at or before `at` (used for history). */
  async compute(at: number | null = null): Promise<IdentityData> {
    const favorites = this.db.listFavorites().filter((f) => at === null || (f.favoriteAt ?? 0) <= at)
    if (!this.libraryAvailable()) {
      return { state: this.empty('Identity needs the optional image model to look at your favorites.', favorites.length), rows: [], ids: [], centroids: [], vectors: new Float32Array(0), z: new Map(), dim: 0 }
    }
    if (favorites.length < MIN_FAVORITES) {
      const state = this.empty(
        favorites.length === 0
          ? 'Mark a few images as favorites (the heart) and Atlas will show what they have in common.'
          : `You have ${favorites.length} favorite${favorites.length === 1 ? '' : 's'}. Atlas needs at least ${MIN_FAVORITES} to say anything.`,
        favorites.length
      )
      return { state, rows: [], ids: [], centroids: [], vectors: new Float32Array(0), z: new Map(), dim: 0 }
    }
    const lib = this.semantic.snapshot()
    const rowOf = new Map<string, number>()
    lib.ids.forEach((id, row) => rowOf.set(id, row))
    const ids: string[] = []
    const rows: number[] = []
    for (const f of favorites) {
      const row = rowOf.get(f.id)
      if (row !== undefined) {
        ids.push(f.id)
        rows.push(row)
      }
    }
    if (rows.length < MIN_FAVORITES) {
      return { state: this.empty('Atlas is still learning your favorites.', favorites.length, rows.length), rows, ids, centroids: [], vectors: new Float32Array(0), z: new Map(), dim: 0 }
    }

    const z = await this.concepts.zScores(
      (() => {
        const out = new Float32Array(rows.length * lib.dim)
        rows.forEach((row, i) => out.set(lib.matrix.subarray(row * lib.dim, (row + 1) * lib.dim), i * lib.dim))
        return out
      })(),
      rows.length
    )
    const wholeDims: ProfileDimension[] = describeSet(TASTE_DIMENSIONS, z, { minMembers: 5 })

    // Separate preferences: cluster the favorites among themselves (indices into `rows`).
    const local = new Float32Array(rows.length * lib.dim)
    rows.forEach((row, i) => local.set(lib.matrix.subarray(row * lib.dim, (row + 1) * lib.dim), i * lib.dim))
    const clusters = findModes(local, lib.dim, rows.map((_, i) => i), { maxModes: 6, minSize: 4 })
    const imageById = new Map<string, ImageItem>()
    for (const item of this.db.getImagesByIds(ids)) imageById.set(item.id, item)

    const modes: ProfileMode[] = clusters.map((cluster, id) => {
      const values = new Map<string, Float32Array>()
      for (const spec of TASTE_DIMENSIONS) values.set(spec.id, Float32Array.from(cluster.members.map((m) => z.get(spec.id)![m]!)))
      const dims = describeSet(TASTE_DIMENSIONS, values, { minMembers: 5 })
      // Each axis has two mirrored poles; list only the pole this group leans towards.
      const characteristics = dims.filter((d) => d.certain && d.mean > 0).sort((x, y) => y.mean - x.mean)
      const exampleIdx = representatives(local, lib.dim, cluster.members, cluster.centroid, 6)
      const examples = exampleIdx.map((i) => imageById.get(ids[i]!)).filter((x): x is ImageItem => Boolean(x))
      const { works, shelves } = this.kindredOf(cluster.centroid, 6)
      const label =
        characteristics.length > 0
          ? characteristics.slice(0, 2).map((d) => d.label).join(' · ')
          : (shelves[0]?.label ?? 'A group of favorites')
      return {
        id,
        label,
        size: cluster.members.length,
        share: cluster.members.length / rows.length,
        tentative: cluster.members.length < 5,
        examples,
        characteristics,
        kindred: works,
        kindredShelves: shelves
      }
    })

    return {
      state: {
        available: true,
        reason: null,
        favorites: favorites.length,
        learned: rows.length,
        pending: favorites.length - rows.length,
        tentative: rows.length < 10,
        modes,
        dimensions: wholeDims
      },
      rows,
      ids,
      centroids: clusters.map((c) => c.centroid),
      vectors: local,
      z,
      dim: lib.dim
    }
  }

  async state(): Promise<IdentityState> {
    return (await this.compute()).state
  }

  /** The user's separate favorite groups, each with its label and its centre in the shared embedding space. */
  async modeCentroids(): Promise<Array<{ label: string; size: number; centroid: Float32Array }>> {
    const data = await this.compute()
    return data.centroids.map((centroid, i) => ({ label: data.state.modes[i]?.label ?? 'a group of favorites', size: data.state.modes[i]?.size ?? 0, centroid }))
  }
}
