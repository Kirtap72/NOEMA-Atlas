import type { AtlasDatabase, DiscoveryEventRow } from './db'
import type { ConceptSpace } from './conceptSpace'
import { type Cluster, describeSet, findModes, representatives } from './profiles'
import type { ReferenceCollection } from './reference'
import { dotRows, mulberry32, pairKey } from './taste'
import {
  type FeatureModel,
  type FeatureSpace,
  type MixedPair,
  type MixedPoint,
  crossValidateMixed,
  makeFeatureSpace,
  scoreFeatures,
  trainMixedModel,
  transformRows
} from './tasteFeatures'
import { TASTE_DIMENSIONS } from './tasteDimensions'
import type {
  DiscoveryPair,
  DiscoveryPhase,
  DiscoveryResponse,
  DiscoveryState,
  DiscoveryStep,
  ProfileMode,
  ReferenceWork
} from '../shared/types'

export const ORIENT_ANSWERS = 14
const MAX_APPEARANCES = 2
const NEAR_DUPLICATE = 0.93

/** Everything the user has told Atlas about the reference collection, in model-ready form. */
export interface Evidence {
  pairs: MixedPair[]
  points: MixedPoint[]
  liked: Set<number>
  passed: Set<number>
  shown: Set<number>
  appearances: Int32Array
  seenPairs: Set<string>
  counts: DiscoveryState['counts']
  informative: number
  events: number
}

const emptyCounts = (): DiscoveryState['counts'] => ({ prefer: 0, both: 0, neither: 0, undecided: 0, likes: 0, dislikes: 0, saves: 0 })

export function buildEvidence(events: DiscoveryEventRow[], rowOf: Map<string, number>, rows: number): Evidence {
  const ev: Evidence = {
    pairs: [],
    points: [],
    liked: new Set(),
    passed: new Set(),
    shown: new Set(),
    appearances: new Int32Array(rows),
    seenPairs: new Set(),
    counts: emptyCounts(),
    informative: 0,
    events: events.length
  }
  const row = (ref: string | null): number | undefined => (ref ? rowOf.get(ref) : undefined)
  for (const e of events) {
    const a = row(e.a_ref)
    const b = row(e.b_ref)
    if (a === undefined) continue
    if (e.kind === 'prefer' || e.kind === 'both' || e.kind === 'neither' || e.kind === 'undecided') {
      if (b === undefined) continue
      ev.shown.add(a)
      ev.shown.add(b)
      ev.appearances[a]! += 1
      ev.appearances[b]! += 1
      ev.seenPairs.add(pairKey(a, b))
      if (e.kind === 'undecided') {
        ev.counts.undecided += 1
        continue
      }
      ev.informative += 1
      if (e.kind === 'prefer') {
        const winner = row(e.winner_ref)
        if (winner === undefined) continue
        const loser = winner === a ? b : a
        ev.pairs.push({ w: winner, l: loser, weight: 1 })
        ev.points.push({ i: winner, y: 1, weight: 0.3 })
        ev.liked.add(winner)
        ev.counts.prefer += 1
      } else if (e.kind === 'both') {
        ev.points.push({ i: a, y: 1, weight: 0.8 }, { i: b, y: 1, weight: 0.8 })
        ev.liked.add(a)
        ev.liked.add(b)
        ev.counts.both += 1
      } else {
        ev.points.push({ i: a, y: -1, weight: 0.8 }, { i: b, y: -1, weight: 0.8 })
        ev.passed.add(a)
        ev.passed.add(b)
        ev.counts.neither += 1
      }
    } else if (e.kind === 'like' || e.kind === 'save') {
      ev.shown.add(a)
      ev.informative += 1
      ev.points.push({ i: a, y: 1, weight: e.kind === 'save' ? 1.5 : 1 })
      ev.liked.add(a)
      ev.passed.delete(a)
      if (e.kind === 'save') ev.counts.saves += 1
      else ev.counts.likes += 1
    } else if (e.kind === 'dislike') {
      ev.shown.add(a)
      ev.informative += 1
      ev.points.push({ i: a, y: -1, weight: 1 })
      ev.passed.add(a)
      ev.liked.delete(a)
      ev.counts.dislikes += 1
    }
  }
  // An image the user later said they dislike is not "liked", and the reverse.
  for (const r of ev.passed) ev.liked.delete(r)
  return ev
}

/**
 * Learns what the user enjoys from comparing and rating works in the reference collection. Answers: prefer A or B,
 * like both, like neither, can't decide. The model is the Taste Compass's pairwise logistic model, extended with radial
 * features so that several separate preferences can coexist.
 */
export class DiscoveryEngine {
  readonly space: FeatureSpace
  private features: Float32Array
  private rows: number
  private evidenceCache: { key: string; ev: Evidence } | null = null
  private modelCache: { key: string; scores: Float32Array; model: FeatureModel } | null = null
  private accuracyCache: { n: number; value: number | null } = { n: -1, value: null }
  private accuracyTimer: NodeJS.Timeout | null = null
  private modesCache: { key: string; modes: ProfileMode[]; centroids: Float32Array[] } | null = null

  constructor(
    private db: AtlasDatabase,
    readonly reference: ReferenceCollection,
    private concepts: ConceptSpace
  ) {
    this.rows = reference.works.length
    this.space = makeFeatureSpace(reference.matrix, reference.dim, { gamma: 8, radialScale: 1.5 })
    this.features = transformRows(this.space, reference.matrix, this.rows)
  }

  // ---- evidence and model ---------------------------------------------------------------------

  evidence(): Evidence {
    const events = this.db.listDiscoveryEvents()
    const key = `${events.length}:${events[events.length - 1]?.id ?? 0}`
    if (this.evidenceCache?.key === key) return this.evidenceCache.ev
    const ev = buildEvidence(events, this.reference.rowOf, this.rows)
    this.evidenceCache = { key, ev }
    return ev
  }

  /** Predicted appeal of every reference work, or null while there is nothing to learn from. */
  scores(ev = this.evidence()): Float32Array | null {
    if (ev.pairs.length + ev.points.length < 4) return null
    const key = `${ev.events}:${ev.pairs.length}:${ev.points.length}`
    if (this.modelCache?.key === key) return this.modelCache.scores
    const model = trainMixedModel(this.features, this.space.size, ev.pairs, ev.points, { lambda: 1, iterations: 250 })
    const scores = scoreFeatures(this.features, this.space.size, model)
    this.modelCache = { key, scores, model }
    return scores
  }

  private scheduleAccuracy(ev: Evidence): void {
    const n = ev.pairs.length + ev.points.length
    if (n < 20 || this.accuracyCache.n === n || this.accuracyTimer) return
    if (this.accuracyCache.n >= 0 && n - this.accuracyCache.n < 4) return
    this.accuracyTimer = setTimeout(() => {
      this.accuracyTimer = null
      try {
        this.accuracyCache = {
          n,
          value: crossValidateMixed(this.features, this.space.size, ev.pairs, ev.points, { lambda: 1, iterations: 100, minEvents: 20 })
        }
      } catch {
        // Informational only.
      }
    }, 30)
  }

  // ---- state ------------------------------------------------------------------------------------

  private work(row: number): ReferenceWork {
    return this.reference.works[row]!
  }

  /** The separate groups among the works the user liked, each described relative to what they were shown. */
  async modes(ev = this.evidence()): Promise<ProfileMode[]> {
    const liked = Array.from(ev.liked)
    const key = `${ev.events}:${liked.length}`
    if (this.modesCache?.key === key) return this.modesCache.modes
    if (liked.length === 0) return []
    const z = await this.concepts.referenceScores()
    const shown = Array.from(ev.shown)
    const shownMean = new Map<string, number>()
    for (const spec of TASTE_DIMENSIONS) {
      const values = z.get(spec.id)!
      let sum = 0
      for (const r of shown) sum += values[r]!
      shownMean.set(spec.id, shown.length ? sum / shown.length : 0)
    }
    const clusters: Cluster[] = findModes(this.reference.matrix, this.reference.dim, liked, { maxModes: 5, minSize: 4 })
    const modes: ProfileMode[] = clusters.map((cluster, id) => {
      const values = new Map<string, Float32Array>()
      for (const spec of TASTE_DIMENSIONS) {
        const all = z.get(spec.id)!
        const mean = shownMean.get(spec.id)!
        values.set(spec.id, Float32Array.from(cluster.members.map((r) => all[r]! - mean)))
      }
      const dims = describeSet(TASTE_DIMENSIONS, values, { minMembers: 5 })
      // Each axis has two mirrored poles; list only the pole this group leans towards.
      const characteristics = dims.filter((d) => d.certain && d.mean > 0).sort((x, y) => y.mean - x.mean)
      const examples = representatives(this.reference.matrix, this.reference.dim, cluster.members, cluster.centroid, 6).map((r) => this.work(r))
      const kindred = this.nearestWorks(cluster.centroid, 6, (r) => !ev.shown.has(r))
      const tally = new Map<string, number>()
      for (const r of cluster.members) tally.set(this.work(r).shelf, (tally.get(this.work(r).shelf) ?? 0) + 1)
      const topShelf = Array.from(tally.entries()).sort((x, y) => y[1] - x[1])[0]
      const shelfLabel = topShelf ? this.work(cluster.members.find((r) => this.work(r).shelf === topShelf[0])!).shelfLabel : ''
      const label =
        characteristics.length > 0
          ? characteristics.slice(0, 2).map((d) => d.label).join(' · ')
          : shelfLabel || 'A first direction'
      const near = this.nearestWorks(cluster.centroid, 12, () => true)
      const shelfTally = new Map<string, { label: string; count: number }>()
      for (const w of near) shelfTally.set(w.shelf, { label: w.shelfLabel, count: (shelfTally.get(w.shelf)?.count ?? 0) + 1 })
      return {
        id,
        label,
        size: cluster.members.length,
        share: cluster.members.length / liked.length,
        tentative: cluster.members.length < 5,
        examples,
        characteristics,
        kindred,
        kindredShelves: Array.from(shelfTally.entries())
          .map(([id2, v]) => ({ id: id2, label: v.label, count: v.count }))
          .sort((x, y) => y.count - x.count)
          .slice(0, 3)
      }
    })
    this.modesCache = { key, modes, centroids: clusters.map((c) => c.centroid) }
    return modes
  }

  /** Centroids of the modes returned by the last call to `modes()`, in the same order. */
  modeCentroids(): Float32Array[] {
    return this.modesCache?.centroids ?? []
  }

  /** The reference works that look most like a vector, skipping near-duplicates of each other. */
  nearestWorks(vector: Float32Array, count: number, allow: (row: number) => boolean, maxSimilarity = 0.93): ReferenceWork[] {
    const { matrix, dim } = this.reference
    const scored: Array<{ row: number; s: number }> = []
    for (let r = 0; r < this.rows; r += 1) {
      if (!allow(r)) continue
      let s = 0
      for (let i = 0; i < dim; i += 1) s += matrix[r * dim + i]! * vector[i]!
      scored.push({ row: r, s })
    }
    scored.sort((x, y) => y.s - x.s)
    const out: number[] = []
    for (const { row } of scored) {
      if (out.length >= count) break
      if (out.some((other) => dotRows(matrix, dim, row, other) > maxSimilarity)) continue
      out.push(row)
    }
    return out.map((r) => this.work(r))
  }

  async state(): Promise<DiscoveryState> {
    const ev = this.evidence()
    const z = await this.concepts.referenceScores()
    const informative = ev.informative
    const stage = informative < 8 ? 'start' : informative < 24 ? 'sketch' : informative < 60 ? 'growing' : 'steady'
    const modes = await this.modes(ev)
    // Whole-profile qualities: the liked works against what was shown.
    const shown = Array.from(ev.shown)
    const liked = Array.from(ev.liked)
    const values = new Map<string, Float32Array>()
    for (const spec of TASTE_DIMENSIONS) {
      const all = z.get(spec.id)!
      let mean = 0
      for (const r of shown) mean += all[r]!
      mean = shown.length ? mean / shown.length : 0
      values.set(spec.id, Float32Array.from(liked.map((r) => all[r]! - mean)))
    }
    const dimensions = describeSet(TASTE_DIMENSIONS, values, { minMembers: 8 })
    this.scheduleAccuracy(ev)
    const regionsSeen = new Set(shown.map((r) => this.work(r).region)).size
    return {
      available: true,
      reason: null,
      counts: ev.counts,
      informative,
      stage,
      accuracy: this.accuracyCache.value,
      accuracyAnswers: Math.max(0, this.accuracyCache.n),
      modes,
      dimensions,
      coverage: { worksSeen: ev.shown.size, worksTotal: this.rows, regionsSeen, regionsTotal: this.reference.regions.length },
      canJourney: informative >= 6
    }
  }

  // ---- choosing what to show ----------------------------------------------------------------------

  private compatible(a: number, b: number, random: () => number): boolean {
    if (dotRows(this.reference.matrix, this.reference.dim, a, b) > NEAR_DUPLICATE) return false
    // Mostly compare like with like (a painting with a painting), so a choice is about the work, not the medium.
    return this.work(a).group === this.work(b).group || random() > 0.75
  }

  private typicalOfRegion(region: number, ev: Evidence, random: () => number): number | null {
    const centre = this.reference.centroids[region]
    if (!centre) return null
    const scored: Array<{ row: number; s: number }> = []
    for (let r = 0; r < this.rows; r += 1) {
      if (this.work(r).region !== region || (ev.appearances[r] ?? 0) >= MAX_APPEARANCES) continue
      let s = 0
      for (let i = 0; i < this.reference.dim; i += 1) s += this.reference.matrix[r * this.reference.dim + i]! * centre[i]!
      scored.push({ row: r, s })
    }
    scored.sort((x, y) => y.s - x.s)
    const top = scored.slice(0, 6)
    return top.length ? top[Math.floor(random() * top.length)]!.row : null
  }

  private pickOrient(ev: Evidence, random: () => number): [number, number] | null {
    const seen = new Map<number, number>()
    for (let i = 0; i < this.reference.regions.length; i += 1) seen.set(i, 0)
    for (const r of ev.shown) seen.set(this.work(r).region, (seen.get(this.work(r).region) ?? 0) + 1)
    const order = Array.from(seen.entries()).sort((x, y) => x[1] - y[1] + (random() - 0.5) * 0.5)
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const r1 = order[Math.floor(random() * Math.min(6, order.length))]![0]
      const r2 = order[Math.floor(random() * Math.min(10, order.length))]![0]
      if (r1 === r2) continue
      const c1 = this.reference.centroids[r1]!
      const c2 = this.reference.centroids[r2]!
      let s = 0
      for (let i = 0; i < c1.length; i += 1) s += c1[i]! * c2[i]!
      if (s > 0.9) continue
      const a = this.typicalOfRegion(r1, ev, random)
      const b = this.typicalOfRegion(r2, ev, random)
      if (a === null || b === null || ev.seenPairs.has(pairKey(a, b)) || dotRows(this.reference.matrix, this.reference.dim, a, b) > NEAR_DUPLICATE) continue
      return [a, b]
    }
    return null
  }

  private pickRefine(ev: Evidence, scores: Float32Array | null, random: () => number): [number, number] | null {
    let best: { a: number; b: number; score: number } | null = null
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const a = Math.floor(random() * this.rows)
      const b = Math.floor(random() * this.rows)
      if (a === b || (ev.appearances[a] ?? 0) >= MAX_APPEARANCES || (ev.appearances[b] ?? 0) >= MAX_APPEARANCES) continue
      if (ev.seenPairs.has(pairKey(a, b)) || !this.compatible(a, b, random)) continue
      const margin = scores ? Math.abs(scores[a]! - scores[b]!) : random()
      const score = margin + 0.12 * ((ev.appearances[a] ?? 0) + (ev.appearances[b] ?? 0))
      if (!best || score < best.score) best = { a, b, score }
    }
    return best ? [best.a, best.b] : null
  }

  private pickWithinMode(ev: Evidence, modes: ProfileMode[], random: () => number): [number, number] | null {
    if (modes.length === 0) return null
    const mode = modes[Math.floor(random() * modes.length)]!
    const centre = mode.examples[0] ? this.reference.rowOf.get(mode.examples[0].id)! : -1
    if (centre < 0) return null
    const near: Array<{ row: number; s: number }> = []
    for (let r = 0; r < this.rows; r += 1) {
      if ((ev.appearances[r] ?? 0) >= MAX_APPEARANCES) continue
      near.push({ row: r, s: dotRows(this.reference.matrix, this.reference.dim, r, centre) })
    }
    near.sort((x, y) => y.s - x.s)
    const pool = near.slice(0, 24)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const a = pool[Math.floor(random() * pool.length)]!.row
      const b = pool[Math.floor(random() * pool.length)]!.row
      if (a === b || ev.seenPairs.has(pairKey(a, b))) continue
      const s = dotRows(this.reference.matrix, this.reference.dim, a, b)
      if (s > NEAR_DUPLICATE || s < 0.45) continue
      return [a, b]
    }
    return null
  }

  private pickStretch(ev: Evidence, scores: Float32Array | null, random: () => number): [number, number] | null {
    // The most unfamiliar works (far from everything the user has seen), above the median appeal when a model exists.
    const known = Array.from(ev.shown)
    if (known.length === 0) return null
    const novelty: Array<{ row: number; n: number }> = []
    let median = -Infinity
    if (scores) median = Array.from(scores).sort((x, y) => x - y)[Math.floor(this.rows / 2)]!
    for (let r = 0; r < this.rows; r += 1) {
      if ((ev.appearances[r] ?? 0) >= 1 || (scores && scores[r]! < median)) continue
      let max = -1
      for (const k of known) max = Math.max(max, dotRows(this.reference.matrix, this.reference.dim, r, k))
      novelty.push({ row: r, n: 1 - max })
    }
    novelty.sort((x, y) => y.n - x.n)
    const pool = novelty.slice(0, 20)
    if (pool.length === 0) return null
    const a = pool[Math.floor(random() * pool.length)]!.row
    const likedList = Array.from(ev.liked)
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const b = likedList.length ? likedList[Math.floor(random() * likedList.length)]! : Math.floor(random() * this.rows)
      if (b === a || ev.seenPairs.has(pairKey(a, b)) || dotRows(this.reference.matrix, this.reference.dim, a, b) > NEAR_DUPLICATE) continue
      return [a, b]
    }
    return null
  }

  async nextPair(): Promise<DiscoveryPair | null> {
    const ev = this.evidence()
    const scores = this.scores(ev)
    const round = ev.informative + ev.counts.undecided + 1
    const random = mulberry32(911 + round * 7919)
    let phase: DiscoveryPhase
    // Map the collection first: keep comparing typical works of different regions until most regions have been seen.
    const regionsSeen = new Set(Array.from(ev.shown).map((r) => this.work(r).region)).size
    const orienting = ev.informative < ORIENT_ANSWERS || regionsSeen < this.reference.regions.length * 0.75
    if (orienting || !scores) phase = 'orient'
    else {
      const roll = random()
      phase = roll < 0.35 ? 'refine' : roll < 0.55 ? 'mode' : roll < 0.75 ? 'stretch' : 'orient'
    }
    const modes = phase === 'mode' ? await this.modes(ev) : []
    const attempts: DiscoveryPhase[] = [phase, 'refine', 'orient']
    for (const candidate of attempts) {
      let pick: [number, number] | null = null
      if (candidate === 'orient') pick = this.pickOrient(ev, random)
      else if (candidate === 'refine') pick = this.pickRefine(ev, scores, random)
      else if (candidate === 'mode') pick = this.pickWithinMode(ev, modes, random)
      else pick = this.pickStretch(ev, scores, random)
      if (pick) {
        // Randomise left and right.
        const [a, b] = random() < 0.5 ? pick : [pick[1], pick[0]]
        return { a: this.work(a), b: this.work(b), round, phase: candidate }
      }
    }
    return null
  }

  // ---- answers -------------------------------------------------------------------------------------

  async respond(aId: string, bId: string, response: DiscoveryResponse, winnerId: string | null = null): Promise<DiscoveryStep> {
    if (!this.reference.rowOf.has(aId) || !this.reference.rowOf.has(bId) || aId === bId) throw new Error('Choose between two different works.')
    if (response === 'prefer' && winnerId !== aId && winnerId !== bId) throw new Error('Say which work you prefer.')
    this.db.addDiscoveryEvent(response, aId, bId, response === 'prefer' ? winnerId : null, 'explore')
    return { state: await this.state(), next: await this.nextPair() }
  }

  /** A like, a dislike or a save of a single work, from a journey or the map. */
  async feedback(workId: string, kind: 'like' | 'dislike' | 'save', context = 'explore'): Promise<void> {
    if (!this.reference.rowOf.has(workId)) throw new Error('That work is not in the reference collection.')
    this.db.addDiscoveryEvent(kind, workId, null, null, context)
  }

  async undo(): Promise<DiscoveryStep> {
    const removed = this.db.undoDiscoveryEvent()
    const state = await this.state()
    const a = removed ? this.reference.work(removed.a_ref) : null
    const b = removed?.b_ref ? this.reference.work(removed.b_ref) : null
    if (a && b) return { state, next: { a, b, round: state.informative + state.counts.undecided + 1, phase: 'refine' } }
    return { state, next: await this.nextPair() }
  }

  async reset(): Promise<DiscoveryState> {
    this.db.resetDiscoveryEvents()
    this.evidenceCache = null
    this.modelCache = null
    this.modesCache = null
    this.accuracyCache = { n: -1, value: null }
    return this.state()
  }

  /** Percentile (0 to 100) of each work's predicted appeal within the collection, or null without a model. */
  percentiles(scores: Float32Array): Float32Array {
    const order = Array.from(scores.keys()).sort((x, y) => scores[x]! - scores[y]!)
    const out = new Float32Array(scores.length)
    order.forEach((row, rank) => {
      out[row] = (rank / Math.max(1, scores.length - 1)) * 100
    })
    return out
  }
}
