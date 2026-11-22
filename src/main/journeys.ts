import { randomUUID } from 'node:crypto'
import type { AtlasDatabase } from './db'
import type { ConceptSpace } from './conceptSpace'
import type { DiscoveryEngine } from './discovery'
import type { IdentityEngine } from './identity'
import type { ReferenceCollection } from './reference'
import { dotRows, mulberry32 } from './taste'
import { TASTE_DIMENSIONS } from './tasteDimensions'
import type {
  Journey,
  JourneyChapter,
  JourneySuggestion,
  JourneyWork,
  ProfileDimension,
  ReferenceWork
} from '../shared/types'

interface Context {
  seen: Set<number>
  liked: Set<number>
  passed: Set<number>
  scores: Float32Array | null
  percentiles: Float32Array | null
  refZ: Map<string, Float32Array>
  informative: number
  accuracy: number | null
}

const f2 = (v: number): string => v.toFixed(2)
const list = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/**
 * Builds Artistic Discovery Journeys: short, themed walks through the reference collection that start from something the
 * user already responds to and deliberately travel beyond it. Everything shown as an explanation is either a measured
 * visual fact (similarity, a quality's z-score) or museum metadata. Journeys never claim historical influence.
 */
export class JourneyEngine {
  constructor(
    private db: AtlasDatabase,
    private reference: ReferenceCollection,
    private concepts: ConceptSpace,
    private discovery: DiscoveryEngine,
    private identity: IdentityEngine
  ) {}

  private async context(): Promise<Context> {
    const ev = this.discovery.evidence()
    const scores = this.discovery.scores(ev)
    const state = await this.discovery.state()
    return {
      seen: ev.shown,
      liked: ev.liked,
      passed: ev.passed,
      scores,
      percentiles: scores ? this.discovery.percentiles(scores) : null,
      refZ: await this.concepts.referenceScores(),
      informative: ev.informative,
      accuracy: state.accuracy
    }
  }

  private similarities(anchor: Float32Array): Float32Array {
    const { matrix, dim, works } = this.reference
    const out = new Float32Array(works.length)
    for (let r = 0; r < works.length; r += 1) {
      let s = 0
      for (let i = 0; i < dim; i += 1) s += matrix[r * dim + i]! * anchor[i]!
      out[r] = s
    }
    return out
  }

  /** Greedy pick: highest score first, skipping near-duplicates and (optionally) repeated shelves. */
  private pick(order: number[], count: number, used: Set<number>, ctx: Context, shelfCap = 2): number[] {
    const out: number[] = []
    const perShelf = new Map<string, number>()
    for (const row of order) {
      if (out.length >= count) break
      if (used.has(row) || ctx.passed.has(row)) continue
      const shelf = this.reference.works[row]!.shelf
      if ((perShelf.get(shelf) ?? 0) >= shelfCap) continue
      if ([...out, ...used].some((o) => dotRows(this.reference.matrix, this.reference.dim, row, o) > 0.9)) continue
      out.push(row)
      perShelf.set(shelf, (perShelf.get(shelf) ?? 0) + 1)
    }
    return out
  }

  private dateRange(rows: number[]): string {
    const years = rows
      .flatMap((r) => {
        const m = this.reference.works[r]!.date.match(/\d{3,4}/g)
        return m ? m.map(Number) : []
      })
      .filter((y) => y > 0 && y < 2100)
    if (years.length < 2) return ''
    return `${Math.min(...years)}–${Math.max(...years)}`
  }

  private describeRows(rows: number[]): string {
    const cultures = Array.from(new Set(rows.map((r) => this.reference.works[r]!.culture).filter(Boolean))).slice(0, 4)
    const shelves = Array.from(new Set(rows.map((r) => this.reference.works[r]!.shelfLabel))).slice(0, 3)
    const range = this.dateRange(rows)
    const parts: string[] = []
    if (shelves.length) parts.push(list(shelves))
    if (cultures.length) parts.push(`from ${list(cultures)}`)
    if (range) parts.push(`dated roughly ${range}`)
    return parts.join(', ')
  }

  /** Measured facts and museum metadata for one work, never claims of influence. */
  private whyFor(row: number, role: JourneyWork['role'], anchorLabel: string, sim: Float32Array | null, ctx: Context, dim: { spec: (typeof TASTE_DIMENSIONS)[number]; sign: number } | null, earlier: number[]): string[] {
    const w = this.reference.works[row]!
    const why: string[] = []
    if (sim) {
      const s = sim[row]!
      const word = s >= 0.8 ? 'very close' : s >= 0.65 ? 'close' : s >= 0.5 ? 'related' : 'distant'
      why.push(`Overall look: ${word} to ${anchorLabel} (similarity ${f2(s)}, where 1 would be identical).`)
    }
    if (dim) {
      const z = (ctx.refZ.get(dim.spec.id)?.[row] ?? 0) * 1
      if (Math.abs(z) >= 0.8) why.push(`${dim.spec.label}: ${f2(z)} standard deviations ${z >= 0 ? 'beyond' : 'below'} typical art in the collection.`)
    }
    // The strongest measured quality of this work, whatever the journey's theme.
    let top: { label: string; z: number } | null = null
    for (const spec of TASTE_DIMENSIONS) {
      const z = ctx.refZ.get(spec.id)?.[row] ?? 0
      if (!top || Math.abs(z) > Math.abs(top.z)) top = { label: spec.label, z }
    }
    if (top && Math.abs(top.z) >= 1.2 && top.z > 0 && !why.some((l) => l.startsWith(top!.label))) why.push(`Most distinctive quality: ${top.label} (${f2(top.z)} standard deviations).`)
    // One museum-metadata link at most: the same maker, else the same culture in another medium.
    const recent = earlier.slice(-4).map((e) => this.reference.works[e]!)
    const sameMaker = w.artist ? recent.find((o) => o.artist === w.artist) : undefined
    const sameCulture = w.culture ? recent.find((o) => o.culture === w.culture && o.shelf !== w.shelf) : undefined
    if (sameMaker) why.push(`Same maker as “${sameMaker.title}”: ${w.artist}.`)
    else if (sameCulture) why.push(`Also ${w.culture}, like “${sameCulture.title}”, in a different medium (${w.classification || w.group}).`)
    if (role === 'stretch' && ctx.percentiles) why.push(`Atlas predicts this is in the top ${Math.max(1, Math.round(100 - ctx.percentiles[row]!))}% of the collection for you${ctx.accuracy !== null ? ` (its predictions of your answers have been right ${Math.round(ctx.accuracy * 100)}% of the time)` : ' (an early guess, based on few answers)'}.`)
    if (role === 'stretch' && !ctx.percentiles) why.push('Chosen to take you somewhere new; Atlas does not yet know enough about your taste to predict whether you will like it.')
    return why.slice(0, 4)
  }

  private makeWorks(rows: number[], role: JourneyWork['role'], anchorLabel: string, sim: Float32Array | null, ctx: Context, dim: { spec: (typeof TASTE_DIMENSIONS)[number]; sign: number } | null, earlier: number[]): JourneyWork[] {
    const out: JourneyWork[] = []
    const so_far = earlier.slice()
    for (const row of rows) {
      out.push({ work: this.reference.works[row]!, why: this.whyFor(row, role, anchorLabel, sim, ctx, dim, so_far), role })
      so_far.push(row)
    }
    return out
  }

  // ---- journeys ---------------------------------------------------------------------------------

  private async fromAnchor(
    anchor: Float32Array,
    label: string,
    dims: ProfileDimension[],
    ctx: Context,
    seed: Journey['seed'],
    title: string,
    random: () => number
  ): Promise<Journey> {
    const rows = this.reference.works.length
    const sim = this.similarities(anchor)
    const all = Array.from({ length: rows }, (_, r) => r)
    const used = new Set<number>()
    const chapters: JourneyChapter[] = []
    const flat: number[] = []

    // The quality that characterises the seed: the strongest reliable one, else the anchor's own most extreme.
    let dim: { spec: (typeof TASTE_DIMENSIONS)[number]; sign: number } | null = null
    const best = dims.filter((d) => d.certain).sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))[0]
    if (best) dim = { spec: TASTE_DIMENSIONS.find((s) => s.id === best.id)!, sign: best.mean >= 0 ? 1 : -1 }
    else {
      const anchorZ = await this.concepts.zScores(anchor, 1)
      let top: { id: string; z: number } | null = null
      for (const [id, z] of anchorZ) if (!top || Math.abs(z[0]!) > Math.abs(top.z)) top = { id, z: z[0]! }
      if (top && Math.abs(top.z) >= 0.6) dim = { spec: TASTE_DIMENSIONS.find((s) => s.id === top!.id)!, sign: top.z >= 0 ? 1 : -1 }
    }

    // 1. Where you are.
    const familiarOrder = all.slice().sort((a, b) => sim[b]! - 0.12 * (ctx.seen.has(b) ? 1 : 0) - (sim[a]! - 0.12 * (ctx.seen.has(a) ? 1 : 0)))
    const familiar = this.pick(familiarOrder, 3, used, ctx)
    familiar.forEach((r) => used.add(r))
    chapters.push({
      title: 'Where you are',
      intro: `The works in the collection that look closest to ${label}: ${this.describeRows(familiar)}. A place to begin.`,
      stretch: false,
      works: this.makeWorks(familiar, 'familiar', label, sim, ctx, dim, flat)
    })
    flat.push(...familiar)

    // 2. Neighbouring traditions: near, but from other shelves and cultures.
    const usedShelves = new Set(familiar.map((r) => this.reference.works[r]!.shelf))
    const usedCultures = new Set(familiar.map((r) => this.reference.works[r]!.culture))
    const neighbourOrder = all
      .filter((r) => sim[r]! < 0.92)
      .sort((a, b) => {
        const score = (r: number): number => sim[r]! - (usedShelves.has(this.reference.works[r]!.shelf) ? 0.2 : 0) - (usedCultures.has(this.reference.works[r]!.culture) ? 0.08 : 0) - (ctx.seen.has(r) ? 0.08 : 0)
        return score(b) - score(a)
      })
      .slice(0, 120)
    const neighbours = this.pick(neighbourOrder, 3, used, ctx, 1)
    neighbours.forEach((r) => used.add(r))
    chapters.push({
      title: 'Neighbouring traditions',
      intro: `Close in appearance but from other corners of the collection: ${this.describeRows(neighbours)}.`,
      stretch: false,
      works: this.makeWorks(neighbours, 'neighbour', label, sim, ctx, dim, flat)
    })
    flat.push(...neighbours)

    // 3. The same quality in different worlds.
    if (dim) {
      const z = ctx.refZ.get(dim.spec.id)!
      const order = all
        .filter((r) => sim[r]! >= 0.28 && sim[r]! <= 0.8 && dim!.sign * z[r]! >= 1)
        .sort((a, b) => dim!.sign * (z[b]! - z[a]!) - (ctx.seen.has(b) ? 0.4 : 0) + (ctx.seen.has(a) ? 0.4 : 0))
      const quality = this.pick(order, 3, used, ctx, 1)
      if (quality.length > 0) {
        quality.forEach((r) => used.add(r))
        chapters.push({
          title: `${dim.sign >= 0 ? dim.spec.label : `The opposite of ${dim.spec.label}`}, across the collection`,
          intro: `${dim.spec.description} Each of these shows it clearly: ${this.describeRows(quality)}. The measure compares every image's look with short descriptions of the quality; it describes pictures, it does not rank them.`,
          stretch: false,
          works: this.makeWorks(quality, 'quality', label, sim, ctx, dim, flat)
        })
        flat.push(...quality)
      }
    }

    // 4. Beyond what you have confirmed: the deliberate stretch.
    const confirmed = new Set<number>()
    for (const r of ctx.liked) confirmed.add(this.reference.works[r]!.region)
    const known = Array.from(ctx.liked)
    const stretchScore = (r: number): number => {
      let maxLiked = 0
      for (const k of known) maxLiked = Math.max(maxLiked, dotRows(this.reference.matrix, this.reference.dim, r, k))
      const novelty = known.length ? 1 - maxLiked : 1 - sim[r]!
      const appeal = ctx.percentiles ? ctx.percentiles[r]! / 100 : dim ? Math.max(0, (dim.sign * (ctx.refZ.get(dim.spec.id)![r] ?? 0)) / 3) : random() * 0.3
      return appeal + 0.5 * novelty - (ctx.seen.has(r) ? 0.3 : 0)
    }
    const stretchOrder = all
      .filter((r) => sim[r]! < 0.6 && !confirmed.has(this.reference.works[r]!.region))
      .sort((a, b) => stretchScore(b) - stretchScore(a))
      .slice(0, 80)
    const stretch = this.pick(stretchOrder, 3, used, ctx, 1)
    stretch.forEach((r) => used.add(r))
    if (stretch.length > 0) {
      chapters.push({
        title: 'Beyond what you have told me',
        intro: `A deliberate step outside the regions of the collection you have confirmed: ${this.describeRows(stretch)}. Some of these may not suit you. Telling Atlas so is just as useful as telling it you love one.`,
        stretch: true,
        works: this.makeWorks(stretch, 'stretch', label, sim, ctx, dim, flat)
      })
      flat.push(...stretch)
    }

    // 5. A contrast, so the sense of the quality sharpens either way.
    if (dim) {
      const z = ctx.refZ.get(dim.spec.id)!
      const opposite = all
        .filter((r) => -dim!.sign * z[r]! >= 1 && !confirmed.has(this.reference.works[r]!.region))
        .sort((a, b) => (ctx.percentiles ? ctx.percentiles[b]! - ctx.percentiles[a]! : -dim!.sign * (z[b]! - z[a]!)))
        .slice(0, 60)
      const contrast = this.pick(opposite, 2, used, ctx, 1)
      if (contrast.length > 0) {
        chapters.push({
          title: 'A contrast',
          intro: `The opposite end of the same scale (${dim.sign >= 0 ? 'the opposite of ' : ''}${dim.spec.label}). Included so your sense of it gets sharper, whether you like these or not.`,
          stretch: true,
          works: this.makeWorks(contrast, 'stretch', label, sim, ctx, null, flat)
        })
        flat.push(...contrast)
      }
    }

    const total = flat.length
    const outside = flat.filter((r) => !confirmed.has(this.reference.works[r]!.region)).length
    const basis: string[] = [
      ctx.informative > 0 ? `Built from ${ctx.informative} of your answers and ratings, plus the collection's own visual similarity.` : 'Built only from the collection\'s own visual similarity: Atlas has no answers from you yet.',
      `${outside} of ${total} works lie outside regions you have confirmed, on purpose, so the journey does not just repeat your known taste.`,
      'Visual connections are measured by comparing images, with museum details shown as given. Atlas does not claim that one artist influenced another.'
    ]
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      title,
      subtitle: `${total} works in ${chapters.length} chapters`,
      seed,
      chapters,
      basis,
      explorationShare: total ? outside / total : 0,
      feedback: {},
      progress: 0,
      finished: false
    }
  }

  private tour(ctx: Context, random: () => number): Journey {
    const works = this.reference.works
    const byGroup = (groups: string[]): number[] => works.map((w, r) => (groups.includes(w.group) ? r : -1)).filter((r) => r >= 0)
    const regionTypical = (rows: number[]): number[] => {
      const best = new Map<number, { r: number; s: number }>()
      for (const r of rows) {
        const c = this.reference.centroids[works[r]!.region]!
        let s = 0
        for (let i = 0; i < this.reference.dim; i += 1) s += this.reference.matrix[r * this.reference.dim + i]! * c[i]!
        const cur = best.get(works[r]!.region)
        if (!cur || s > cur.s) best.set(works[r]!.region, { r, s })
      }
      return Array.from(best.values()).map((v) => v.r)
    }
    const themes: Array<{ title: string; intro: string; groups: string[] }> = [
      { title: 'Painting, from many places', intro: 'Painted works from different centuries and continents.', groups: ['painting'] },
      { title: 'On paper', intro: 'Prints and drawings: the quieter, more intimate side of art.', groups: ['print', 'drawing'] },
      { title: 'Light and place', intro: 'Photographs and architecture: how people have framed the world and what they have built in it.', groups: ['photograph', 'architecture'] },
      { title: 'Form in space', intro: 'Sculpture from antiquity to the modern era.', groups: ['sculpture'] },
      { title: 'Pattern, craft and design', intro: 'Objects and textiles, where making and beauty meet.', groups: ['object', 'textile'] }
    ]
    const used = new Set<number>()
    const chapters: JourneyChapter[] = []
    for (const theme of themes) {
      const typical = regionTypical(byGroup(theme.groups)).sort(() => random() - 0.5)
      const picked = this.pick(typical, 3, used, ctx, 1)
      picked.forEach((r) => used.add(r))
      if (picked.length === 0) continue
      chapters.push({
        title: theme.title,
        intro: `${theme.intro} ${this.describeRows(picked)}.`,
        stretch: false,
        works: picked.map((r) => ({
          work: works[r]!,
          role: 'tour',
          why: [`A typical work from the "${works[r]!.shelfLabel}" part of the collection, chosen so each chapter shows a different corner.`, ...(works[r]!.culture ? [`${works[r]!.culture}, ${works[r]!.date || 'date unknown'}.`] : [])]
        }))
      })
    }
    const total = chapters.reduce((s, c) => s + c.works.length, 0)
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      title: 'A first walk through the collection',
      subtitle: `${total} works in ${chapters.length} chapters`,
      seed: { kind: 'tour', label: 'A walk through the whole collection' },
      chapters,
      basis: ['A general tour that does not depend on your taste.', 'Tell Atlas what you like while you walk, and later journeys start from that.', 'Every work is public domain or CC0, with its museum and credit shown.'],
      explorationShare: 1,
      feedback: {},
      progress: 0,
      finished: false
    }
  }

  async create(seed: Journey['seed']): Promise<Journey> {
    const ctx = await this.context()
    const random = mulberry32(Date.now() % 100000)
    let journey: Journey
    if (seed.kind === 'tour') journey = this.tour(ctx, random)
    else if (seed.kind === 'mode' || seed.kind === 'emerging') {
      const modes = await this.discovery.modes()
      const centroids = this.discovery.modeCentroids()
      const index = Number(seed.ref ?? 0)
      const mode = modes[index]
      if (!mode || !centroids[index]) throw new Error('That direction is no longer in your discoveries.')
      const label = `what you enjoyed (${mode.label})`
      journey = await this.fromAnchor(centroids[index]!, label, mode.characteristics, ctx, { ...seed, label: mode.label }, seed.kind === 'emerging' ? `An emerging direction: ${mode.label}` : `Beyond ${mode.label}`, random)
    } else if (seed.kind === 'identity') {
      const data = await this.identity.compute()
      const index = Number(seed.ref ?? 0)
      const mode = data.state.modes[index]
      const anchor = data.centroids[index]
      if (!mode || !anchor) throw new Error('That group of favorites is not available.')
      journey = await this.fromAnchor(anchor, `your favorites (${mode.label})`, mode.characteristics, ctx, { ...seed, label: mode.label }, `From your favorites: ${mode.label}`, random)
    } else if (seed.kind === 'unexplored') {
      const region = this.reference.regions.find((r) => r.id === Number(seed.ref))
      const centroid = region ? this.reference.centroids[region.id] : null
      if (!region || !centroid) throw new Error('That part of the collection was not found.')
      journey = await this.fromAnchor(centroid, `“${region.label}”`, [], ctx, { ...seed, label: region.label }, `Unexplored: ${region.label}`, random)
    } else {
      const row = this.reference.rowOf.get(String(seed.ref))
      if (row === undefined) throw new Error('That work is not in the collection.')
      const w = this.reference.works[row]!
      const anchor = this.reference.matrix.slice(row * this.reference.dim, (row + 1) * this.reference.dim)
      journey = await this.fromAnchor(anchor, `“${w.title}”`, [], ctx, { ...seed, label: w.title }, `More like “${w.title}”`, random)
    }
    this.persist(journey)
    return journey
  }

  private persist(journey: Journey): void {
    this.db.saveJourney(journey.id, journey.title, JSON.stringify(journey), journey.progress, journey.finished)
  }

  list(): Journey[] {
    return this.db.listJourneyRows().map((row) => {
      const journey = JSON.parse(row.payload) as Journey
      journey.progress = row.progress
      journey.finished = row.finished === 1
      return journey
    })
  }

  get(id: string): Journey | null {
    const row = this.db.getJourneyRow(id)
    if (!row) return null
    const journey = JSON.parse(row.payload) as Journey
    journey.progress = row.progress
    journey.finished = row.finished === 1
    return journey
  }

  async feedback(journeyId: string, workId: string, feedback: 'like' | 'dislike' | 'clear'): Promise<Journey> {
    const journey = this.get(journeyId)
    if (!journey) throw new Error('That journey no longer exists.')
    const context = `journey:${journeyId}`
    this.db.deleteDiscoveryFeedback(context, workId)
    if (feedback === 'clear') delete journey.feedback[workId]
    else {
      journey.feedback[workId] = feedback
      await this.discovery.feedback(workId, feedback, context)
    }
    this.persist(journey)
    return journey
  }

  progress(journeyId: string, progress: number, finished?: boolean): Journey {
    const journey = this.get(journeyId)
    if (!journey) throw new Error('That journey no longer exists.')
    journey.progress = Math.max(journey.progress, Math.max(0, Math.floor(progress)))
    if (finished) journey.finished = true
    this.persist(journey)
    return journey
  }

  remove(id: string): void {
    this.db.deleteJourney(id)
  }

  /** Directions worth offering a journey for, each with the evidence for it and its limits. */
  async suggestions(): Promise<JourneySuggestion[]> {
    const out: JourneySuggestion[] = []
    const discovery = await this.discovery.state()
    const identityData = await this.identity.compute()
    const identity = identityData.state
    const existing = this.list()
    const has = (kind: string, ref: unknown): boolean => existing.some((j) => j.seed.kind === kind && String(j.seed.ref ?? '') === String(ref ?? '') && !j.finished)

    if (!existing.some((j) => j.seed.kind === 'tour')) {
      out.push({
        seed: { kind: 'tour', label: 'A walk through the whole collection' },
        title: 'A first walk through the collection',
        reason: discovery.informative === 0 && !identity.available ? 'A good way to begin: five themed rooms across periods and media, whatever you already collect.' : 'A general tour, independent of your taste.',
        evidence: 'No personal data needed.'
      })
    }
    discovery.modes.forEach((mode, index) => {
      if (mode.size < 3 || has('mode', index) || has('emerging', index)) return
      const centroid = this.discovery.modeCentroids()[index]
      let nearestIdentity = -1
      identityData.centroids.forEach((c) => {
        if (centroid) nearestIdentity = Math.max(nearestIdentity, dotRows(c, c.length, 0, 0) * 0 + c.reduce((s, v, i) => s + v * centroid[i]!, 0))
      })
      const emerging = identity.available && nearestIdentity < 0.72
      out.push({
        seed: { kind: emerging ? 'emerging' : 'mode', label: mode.label, ref: index },
        title: emerging ? `An emerging direction: ${mode.label}` : `Beyond ${mode.label}`,
        reason: emerging
          ? `You enjoyed ${mode.size} works here while exploring, and nothing among your favorites is close to them yet. It may be a new interest.`
          : `You enjoyed ${mode.size} works with this look. The journey goes from there towards things you have not seen.`,
        evidence: `${mode.size} liked works${mode.tentative ? ' (tentative: fewer than 5)' : ''}; ${discovery.informative} answers in total.`
      })
    })
    identity.modes.forEach((mode, index) => {
      if (has('identity', index)) return
      out.push({
        seed: { kind: 'identity', label: mode.label, ref: index },
        title: `From your favorites: ${mode.label}`,
        reason: `${mode.size} of your favorites form this group. The journey shows its neighbours in art history and then steps beyond.`,
        evidence: `${mode.size} favorites${mode.tentative ? ' (tentative: fewer than 5)' : ''}.`
      })
    })
    // Always offer to leave the comfort zone once there is something to compare against.
    if (discovery.informative >= 10) {
      const regions = this.reference.regions
      const evidence = this.discovery.evidence()
      // A region counts as explored once something there was liked, passed on twice or more, or seen three times or more.
      const seen = new Set<number>()
      const perRegion = new Map<number, { shown: number; liked: number; passed: number }>()
      for (const r of evidence.shown) {
        const region = this.reference.works[r]!.region
        const cur = perRegion.get(region) ?? { shown: 0, liked: 0, passed: 0 }
        cur.shown += 1
        if (evidence.liked.has(r)) cur.liked += 1
        if (evidence.passed.has(r)) cur.passed += 1
        perRegion.set(region, cur)
      }
      for (const [region, c] of perRegion) if (c.liked > 0 || c.passed >= 2 || c.shown >= 3) seen.add(region)
      const percentiles = (() => {
        const s = this.discovery.scores()
        return s ? this.discovery.percentiles(s) : null
      })()
      const candidates = regions
        .filter((r) => !seen.has(r.id))
        .map((r) => {
          const rows = this.reference.works.map((w, i) => (w.region === r.id ? i : -1)).filter((i) => i >= 0)
          const appeal = percentiles ? rows.reduce((s, i) => s + percentiles[i]!, 0) / rows.length : 0
          return { r, appeal }
        })
        .sort((a, b) => b.appeal - a.appeal)
      const top = candidates[0]
      if (top && !has('unexplored', top.r.id)) {
        out.push({
          seed: { kind: 'unexplored', label: top.r.label, ref: top.r.id },
          title: `Unexplored: ${top.r.label}`,
          reason: `You have not seen anything from this part of the collection. Atlas predicts it may suit you (around the ${Math.round(top.appeal)}th percentile), which is a guess to be tested, not a fact.`,
          evidence: `No evidence from you yet; the prediction rests on ${discovery.informative} answers${discovery.accuracy !== null ? ` and is right about ${Math.round(discovery.accuracy * 100)}% of the time on your past answers` : ''}.`
        })
      }
    }
    return out
  }

  /** Works the user has saved from a journey (for the history view). */
  workFor(id: string): ReferenceWork | null {
    return this.reference.work(id)
  }
}
