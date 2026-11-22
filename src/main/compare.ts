import type { ConceptSpace } from './conceptSpace'
import type { DiscoveryEngine } from './discovery'
import type { IdentityData, IdentityEngine } from './identity'
import type { ReferenceCollection } from './reference'
import { TASTE_DIMENSIONS } from './tasteDimensions'
import type {
  CompareDimension,
  CompareRegion,
  CompareState,
  DimensionRelation,
  DiscoveryState,
  IdentityState,
  ImageItem,
  MapPoint,
  ProfileDimension,
  ReferenceWork,
  RegionStatus
} from '../shared/types'
import type { AtlasDatabase } from './db'

const strength = (v: number): string => {
  const a = Math.abs(v)
  return a < 0.5 ? 'slightly' : a < 1 ? 'clearly' : 'strongly'
}

function statementFor(
  names: { a: string; b: string },
  identity: ProfileDimension | null,
  discovered: ProfileDimension | null,
  relation: DimensionRelation,
  identityState: IdentityState,
  discovery: DiscoveryState
): string {
  const towards = (mean: number): string => (mean >= 0 ? names.a : names.b)
  const lim = (): string => {
    const bits: string[] = []
    if (identityState.learned < 10) bits.push(`only ${identityState.learned} favorites`)
    if (discovery.informative < 24) bits.push(`${discovery.informative} exploration answers so far`)
    return bits.length ? ` Evidence is still thin (${bits.join(', ')}).` : ''
  }
  switch (relation) {
    case 'shared':
      return `Both your favorites and the works you enjoyed while exploring lean ${strength(Math.min(Math.abs(identity!.mean), Math.abs(discovered!.mean)))} towards ${towards(identity!.mean)}. Two independent sources agree.${lim()}`
    case 'divergent':
      return `Your favorites lean towards ${towards(identity!.mean)}, while the works you enjoyed while exploring lean towards ${towards(discovered!.mean)}. This may be a real difference between what you collect and what draws you now.${lim()}`
    case 'identity':
      return `${towards(identity!.mean)} shows in your favorites (${strength(identity!.mean)}) but exploration has not confirmed it yet.${lim()}`
    case 'discovered':
      return `${towards(discovered!.mean)} appears in the works you enjoyed while exploring (${strength(discovered!.mean)}) but not (yet) among your favorites: a possible new direction.${lim()}`
    default:
      return `Not enough evidence about ${names.a} versus ${names.b} either way.${lim()}`
  }
}

/**
 * Puts the two independent profiles side by side: where they agree, where only one speaks, and which directions in
 * the reference collection neither has touched. Every conclusion carries the evidence behind it; where evidence is thin
 * it says so. Nothing here ranks one taste above another.
 */
export class CompareEngine {
  constructor(
    private db: AtlasDatabase,
    private reference: ReferenceCollection,
    private concepts: ConceptSpace,
    private identity: IdentityEngine,
    private discovery: DiscoveryEngine
  ) {}

  /** Map position of a library image: the average of its closest reference works. */
  private project(vectors: Float32Array, dim: number, count: number): Array<{ x: number; y: number }> {
    const { matrix, works } = this.reference
    const out: Array<{ x: number; y: number }> = []
    for (let i = 0; i < count; i += 1) {
      const top: Array<{ r: number; s: number }> = []
      for (let r = 0; r < works.length; r += 1) {
        let s = 0
        for (let d = 0; d < dim; d += 1) s += vectors[i * dim + d]! * matrix[r * dim + d]!
        if (top.length < 5 || s > top[top.length - 1]!.s) {
          top.push({ r, s })
          top.sort((a, b) => b.s - a.s)
          if (top.length > 5) top.pop()
        }
      }
      let wsum = 0
      let x = 0
      let y = 0
      for (const t of top) {
        const w = Math.exp(8 * t.s)
        wsum += w
        x += works[t.r]!.x * w
        y += works[t.r]!.y * w
      }
      out.push({ x: x / wsum, y: y / wsum })
    }
    return out
  }

  private nearestRegion(vector: Float32Array, dim: number): number {
    let best = 0
    let bestScore = -2
    this.reference.centroids.forEach((c, region) => {
      let s = 0
      for (let d = 0; d < dim; d += 1) s += vector[d]! * c[d]!
      if (s > bestScore) {
        bestScore = s
        best = region
      }
    })
    return best
  }

  async state(preIdentity?: IdentityData): Promise<CompareState> {
    const identityData = preIdentity ?? (await this.identity.compute())
    const identity = identityData.state
    const discovery = await this.discovery.state()
    const ev = this.discovery.evidence()
    const scores = this.discovery.scores(ev)
    const percentiles = scores ? this.discovery.percentiles(scores) : null
    const works = this.reference.works
    const refZ = await this.concepts.referenceScores()

    // ---- dimensions: one row per axis (its two poles are mirror images of each other) --------------------
    const axes = Array.from(new Set(TASTE_DIMENSIONS.map((spec) => spec.axis)))
    const dimensions: CompareDimension[] = axes.map((axis) => {
      const specA = TASTE_DIMENSIONS.find((spec) => spec.axis === axis && spec.pole === 'a')!
      const specB = TASTE_DIMENSIONS.find((spec) => spec.axis === axis && spec.pole === 'b')!
      const idDim = identity.available ? (identity.dimensions.find((d) => d.id === specA.id) ?? null) : null
      const dcDim = discovery.dimensions.find((d) => d.id === specA.id) ?? null
      const idc = idDim?.certain ?? false
      const dcc = dcDim?.certain ?? false
      let relation: DimensionRelation = 'unclear'
      if (idc && dcc) relation = Math.sign(idDim!.mean) === Math.sign(dcDim!.mean) ? 'shared' : 'divergent'
      else if (idc) relation = 'identity'
      else if (dcc) relation = 'discovered'

      // Examples: the favorites and liked works that show most of the pole each profile leans towards.
      let identityExamples: ImageItem[] = []
      const idZ = identityData.z.get(specA.id)
      if (idZ && idDim && idc) {
        const sign = idDim.mean >= 0 ? 1 : -1
        const order = Array.from(idZ.keys()).sort((a, b) => sign * (idZ[b]! - idZ[a]!))
        identityExamples = this.db.getImagesByIds(order.slice(0, 3).map((i) => identityData.ids[i]!))
      }
      let discoveredExamples: ReferenceWork[] = []
      const rz = refZ.get(specA.id)
      if (rz && dcDim && dcc) {
        const sign = dcDim.mean >= 0 ? 1 : -1
        discoveredExamples = Array.from(ev.liked)
          .sort((a, b) => sign * (rz[b]! - rz[a]!))
          .slice(0, 3)
          .map((r) => works[r]!)
      }
      return {
        id: specA.id,
        label: specA.label,
        oppositeLabel: specB.label,
        axisLabel: specA.axisLabel,
        pole: 'a' as const,
        identity: idDim,
        discovered: dcDim,
        relation,
        statement: statementFor({ a: specA.label, b: specB.label }, idDim, dcDim, relation, identity, discovery),
        identityExamples,
        discoveredExamples
      }
    })
    const lean = (d: CompareDimension): string => {
      const mean = d.relation === 'discovered' ? d.discovered!.mean : (d.identity?.mean ?? 0)
      return mean >= 0 ? d.label : d.oppositeLabel
    }

    // ---- regions ----------------------------------------------------------------------------------
    const favoriteRegion: number[] = []
    for (let i = 0; i < identityData.ids.length; i += 1) {
      favoriteRegion.push(this.nearestRegion(identityData.vectors.subarray(i * identityData.dim, (i + 1) * identityData.dim), identityData.dim))
    }
    const regions: CompareRegion[] = this.reference.regions.map((region) => {
      const members = works.map((w, r) => (w.region === region.id ? r : -1)).filter((r) => r >= 0)
      const favorites = favoriteRegion.filter((r) => r === region.id).length
      const liked = members.filter((r) => ev.liked.has(r)).length
      const passed = members.filter((r) => ev.passed.has(r)).length
      const seen = members.filter((r) => ev.shown.has(r)).length
      const appeal = percentiles && members.length ? members.reduce((s, r) => s + percentiles[r]!, 0) / members.length : null
      let status: RegionStatus = 'unexplored'
      if (favorites > 0 && liked > 0) status = 'shared'
      else if (favorites > 0) status = 'identity'
      else if (liked > 0) status = 'discovered'
      else if (passed >= 2 && passed > liked) status = 'passed'
      // "Little explored": a work or two was shown while mapping the collection, but nothing here was ever liked.
      else if (seen <= 2 && appeal !== null && appeal >= 65) status = 'promising'
      const centre = this.reference.centroids[region.id]!
      const typical = members
        .map((r) => {
          let s = 0
          for (let d = 0; d < this.reference.dim; d += 1) s += this.reference.matrix[r * this.reference.dim + d]! * centre[d]!
          return { r, s }
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, 4)
        .map((t) => works[t.r]!)
      const cx = members.reduce((s, r) => s + works[r]!.x, 0) / Math.max(1, members.length)
      const cy = members.reduce((s, r) => s + works[r]!.y, 0) / Math.max(1, members.length)
      return { id: region.id, label: region.label, count: region.count, favorites, liked, passed, seen, appeal, status, examples: typical, centre: { x: cx, y: cy } }
    })

    // ---- map points ---------------------------------------------------------------------------------
    const points: MapPoint[] = []
    const projected = this.project(identityData.vectors, identityData.dim || this.reference.dim, identityData.ids.length)
    projected.forEach((p, i) => points.push({ x: p.x, y: p.y, id: identityData.ids[i]!, kind: 'favorite' }))
    for (const r of ev.liked) points.push({ x: works[r]!.x, y: works[r]!.y, id: works[r]!.id, kind: 'liked' })
    for (const r of ev.passed) points.push({ x: works[r]!.x, y: works[r]!.y, id: works[r]!.id, kind: 'passed' })

    // ---- headline: a few plain statements, each with its limits -----------------------------------------
    const headline: string[] = []
    const shared = dimensions.filter((d) => d.relation === 'shared')
    const fresh = dimensions.filter((d) => d.relation === 'discovered')
    const fav = dimensions.filter((d) => d.relation === 'identity')
    const promising = regions.filter((r) => r.status === 'promising')
    if (!identity.available) headline.push(identity.reason ?? 'Your favorites are not available yet.')
    if (discovery.informative < 8) headline.push('Explore a few comparisons to give the second profile something to say.')
    if (shared.length > 0) headline.push(`Your favorites and your discoveries agree on ${shared.map(lean).join(', ')}.`)
    if (fresh.length > 0) headline.push(`Exploration points towards ${fresh.map(lean).join(', ')}, which your favorites do not show yet.`)
    if (fav.length > 0 && discovery.informative >= 24) headline.push(`${fav.map(lean).join(', ')} shows in your favorites but not in what you chose while exploring.`)
    if (promising.length > 0) headline.push(`${promising.length} area${promising.length === 1 ? '' : 's'} of the collection you have not seen look promising for you (${promising.slice(0, 2).map((r) => r.label).join('; ')}). This is a prediction, not a fact.`)
    if (headline.length === 0) headline.push('Neither profile has enough evidence for a confident conclusion yet. Both improve with every favorite and every answer.')

    return {
      available: true,
      reason: null,
      identity,
      discovery,
      dimensions,
      regions,
      points,
      map: works.map((w) => ({ id: w.id, x: w.x, y: w.y, region: w.region })),
      headline
    }
  }
}
