import sharp from './safeSharp'
import type { AtlasDatabase } from './db'
import type { Embedder } from './embedder'
import type { IdentityEngine } from './identity'
import { thumbnailPath } from './media'
import type { ReferenceCollection } from './reference'
import type { SemanticSearch } from './semantic'
import type { SmartCollections } from './smartCollections'
import type { TasteEngine } from './tasteEngine'
import {
  curate,
  decideRole,
  filenameHint,
  isScreenSize,
  looksLikeInterface,
  pixelFacts,
  type CurationCandidate,
  type PixelFacts,
  type RoleDecision
} from './curation'
import type { CuratedProposalData, CompanionView } from '../shared/curation'
import type { ImageItem } from '../shared/types'
import { normalizeCriteria } from '../shared/smart'

const TECHNICAL: Array<{ prompt: string; kind: string }> = [
  { prompt: 'a screenshot of 3D modeling software with a viewport, toolbars and side panels', kind: 'a 3D software screenshot' },
  { prompt: 'a screenshot of a computer program interface with menus, buttons and panels', kind: 'a software interface screenshot' },
  { prompt: 'an untextured grey clay render or a wireframe of a 3D model', kind: 'an untextured or wireframe render' },
  { prompt: 'a technical diagram, blueprint or schematic', kind: 'a technical diagram' },
  { prompt: 'a screenshot of a node graph or a code editor', kind: 'a node graph or code screenshot' },
  { prompt: 'a texture map, UV layout or material test sheet', kind: 'a texture or test sheet' },
  { prompt: 'a plain grey 3D test scene with default lighting', kind: 'a default 3D test scene' },
  { prompt: 'a grid of small thumbnails or a contact sheet', kind: 'a contact sheet' }
]
const FINISHED = [
  'a finished painting',
  'a polished digital illustration',
  'a professional photograph',
  'a finished artwork with a deliberate composition',
  'a cinematic still image',
  'a drawing or print by an artist'
]
const EXPERIMENTAL = [
  'an abstract experimental artwork',
  'glitch art or generative pattern art',
  'an expressive mixed-media experiment',
  'abstract shapes and textures made with code'
]

export interface CurationRequest {
  /** What to choose from. */
  source:
    | { kind: 'smart'; id?: string | null; criteria?: unknown; name?: string }
    | { kind: 'family'; id: number; name: string }
    | { kind: 'favorites' }
    | { kind: 'query'; text: string }
    | { kind: 'ids'; ids: string[]; label: string }
  count: number
  includeTechnical?: boolean
  name?: string
}

export interface CurationDeps {
  db: () => AtlasDatabase
  semantic: () => SemanticSearch | null
  embedder: () => Promise<Embedder>
  reference: () => ReferenceCollection | null
  smart: () => SmartCollections | null
  identity: () => IdentityEngine | null
  taste: () => TasteEngine | null
  thumbnailsDir: string
}

interface RoleVectors {
  tech: Float32Array[]
  finished: Float32Array[]
  experimental: Float32Array[]
  /** For each kind of technical image, the sorted margins of the finished reference artworks, for percentiles. */
  refTech: number[][]
  refExp: number[]
  /** Without the reference collection: the same, from a sample of the user's own library. */
  libTech: number[][]
}

function dot(a: ArrayLike<number>, aOffset: number, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < b.length; i += 1) sum += a[aOffset + i]! * b[i]!
  return sum
}

function percentileIn(sorted: number[], value: number): number {
  if (sorted.length === 0) return 0
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid]! < value) low = mid + 1
    else high = mid
  }
  return (low / sorted.length) * 100
}

/** Gathers the evidence from Atlas's own systems and hands it to the curation engine. Reads only; changes nothing. */
export class CurationService {
  private vectors: RoleVectors | null = null
  private pixelCache = new Map<string, PixelFacts | null>()
  /** What the user is looking at in the window. Set by the window, read by the assistant. */
  view: CompanionView = { kind: null }

  constructor(private deps: CurationDeps) {}

  private async roleVectors(dim: number): Promise<RoleVectors> {
    if (this.vectors) return this.vectors
    const embedder = await this.deps.embedder()
    const embed = (texts: string[]): Promise<Float32Array[]> => embedder.embedTexts(texts)
    const tech = await embed(TECHNICAL.map((t) => t.prompt))
    const finished = await embed(FINISHED)
    const experimental = await embed(EXPERIMENTAL)
    const base = { tech, finished, experimental }
    const reference = this.deps.reference()
    const refTech: number[][] = tech.map(() => [])
    const refExp: number[] = []
    if (reference && reference.dim === dim) {
      for (let r = 0; r < reference.works.length; r += 1) {
        const m = this.margins(reference.matrix, r * dim, base)
        m.techBy.forEach((value, k) => refTech[k]!.push(value))
        refExp.push(m.exp)
      }
      for (const list of refTech) list.sort((a, b) => a - b)
      refExp.sort((a, b) => a - b)
    }
    const libTech: number[][] = tech.map(() => [])
    const snap = this.deps.semantic()?.snapshot()
    if (refExp.length === 0 && snap && snap.dim === dim) {
      const stride = Math.max(1, Math.floor(snap.ids.length / 1500))
      for (let r = 0; r < snap.ids.length; r += stride) this.margins(snap.matrix, r * dim, base).techBy.forEach((value, k) => libTech[k]!.push(value))
      for (const list of libTech) list.sort((a, b) => a - b)
    }
    this.vectors = { ...base, refTech, refExp, libTech }
    return this.vectors
  }

  /**
   * Each kind of technical image has its own margin over the finished and experimental prompts, and is compared with
   * its own distribution: some descriptions are simply close to many pictures, and must not count more for that.
   */
  private margins(matrix: ArrayLike<number>, offset: number, v: { tech: Float32Array[]; finished: Float32Array[]; experimental: Float32Array[] }): { techBy: number[]; exp: number } {
    let finBest = -Infinity
    for (const vector of v.finished) finBest = Math.max(finBest, dot(matrix, offset, vector))
    let expBest = -Infinity
    for (const vector of v.experimental) expBest = Math.max(expBest, dot(matrix, offset, vector))
    const other = Math.max(finBest, expBest)
    return { techBy: v.tech.map((vector) => dot(matrix, offset, vector) - other), exp: expBest - finBest }
  }

  private async pixels(item: ImageItem): Promise<PixelFacts | null> {
    const key = `${item.id}:${item.mtime}`
    if (this.pixelCache.has(key)) return this.pixelCache.get(key)!
    let facts: PixelFacts | null = null
    try {
      const { data, info } = await sharp(thumbnailPath(this.deps.thumbnailsDir, item.id), { failOn: 'none' })
        .resize(64, 64, { fit: 'inside' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true })
      facts = pixelFacts(data, info.width, info.height)
    } catch {
      facts = null
    }
    if (this.pixelCache.size > 4000) this.pixelCache.clear()
    this.pixelCache.set(key, facts)
    return facts
  }

  /** What kind of image each one appears to be, with the evidence. */
  async roles(items: ImageItem[]): Promise<Map<string, RoleDecision & { kind: string | null; evidence?: unknown }>> {
    const out = new Map<string, RoleDecision & { kind: string | null; evidence?: unknown }>()
    const semantic = this.deps.semantic()
    const snap = semantic?.snapshot()
    const rowOf = new Map<string, number>()
    snap?.ids.forEach((id, row) => rowOf.set(id, row))
    const vectors = snap && snap.dim > 0 ? await this.roleVectors(snap.dim).catch(() => null) : null
    const haveReference = (vectors?.refExp.length ?? 0) > 0
    for (const item of items) {
      let technicalPercentile: number | null = null
      let experimentalPercentile: number | null = null
      let technicalKind: string | null = null
      const row = rowOf.get(item.id)
      if (vectors && snap && row !== undefined) {
        const m = this.margins(snap.matrix, row * snap.dim, vectors)
        // The strongest kind: the percentile of this image's margin for each kind of technical image, among finished reference artworks.
        const lists = haveReference ? vectors.refTech : vectors.libTech
        let best = -1
        m.techBy.forEach((value, k) => {
          const p = percentileIn(lists[k]!, value)
          if (p > (technicalPercentile ?? -1)) {
            technicalPercentile = p
            best = k
          }
        })
        technicalKind = best >= 0 ? (TECHNICAL[best]?.kind ?? null) : null
        if (haveReference) experimentalPercentile = percentileIn(vectors.refExp, m.exp)
        // Without the reference collection the yardstick is the user's own library, which may be full of such images,
        // so the image model alone can only make an image "unclear": it never decides without a telling name or size.
        else technicalPercentile = Math.min(95, technicalPercentile ?? 0)
      }
      const pixelsOf = await this.pixels(item)
      const evidence = {
        technicalPercentile,
        technicalKind,
        experimentalPercentile,
        filename: filenameHint(item.filename, item.folder),
        screenSize: isScreenSize(item.width, item.height, item.ext),
        interfacePixels: looksLikeInterface(pixelsOf)
      }
      const decision = decideRole(evidence)
      out.set(item.id, { ...decision, kind: technicalKind, evidence: { ...evidence, pixels: pixelsOf } })
    }
    return out
  }

  private async source(request: CurationRequest): Promise<{ label: string; ids: string[]; match: Map<string, number> | null; description: string | null; outside?: Set<string> } | { error: string }> {
    const db = this.deps.db()
    const src = request.source
    if (src.kind === 'smart') {
      const smart = this.deps.smart()
      if (!smart) return { error: 'Smart Collections are not available.' }
      let criteria: unknown = src.criteria
      let name = src.name ?? ''
      if (src.id) {
        const saved = smart.get(src.id)
        if (!saved) return { error: 'That smart collection no longer exists.' }
        criteria = criteria ?? saved.criteria
        name = name || saved.name
      }
      if (!criteria) return { error: 'There is no smart collection to read.' }
      const settings = normalizeCriteria(criteria)
      const ranked = await smart.rank(settings)
      if (ranked.problem) return { error: ranked.problem }
      const match = new Map(ranked.ids.map((id, i) => [id, ranked.match[i]!]))
      const ids = ranked.ids.slice()
      // Also look just beyond the collection, at the loosest setting, so strong images that narrowly miss it can be offered as alternatives.
      const outside = new Set<string>()
      {
        const loose = await smart.rank(settings, { loose: true })
        loose.ids.forEach((id, i) => {
          if (!match.has(id) && outside.size < 60) {
            outside.add(id)
            ids.push(id)
            match.set(id, Math.max(55, Math.min(loose.match[i]!, 74)))
          }
        })
      }
      return { label: name ? `the smart collection “${name}”` : 'your description', ids, match, description: ranked.explanation, outside }
    }
    if (src.kind === 'family') {
      return { label: `the family “${src.name}”`, ids: db.familyImageIds(src.id).slice(0, 400), match: null, description: null }
    }
    if (src.kind === 'favorites') {
      return { label: 'your favorites', ids: db.queryImages({ scope: 'favorites', limit: 400 }).items.map((i) => i.id), match: null, description: null }
    }
    if (src.kind === 'ids') return { label: src.label, ids: src.ids.slice(0, 400), match: null, description: null }
    const semantic = this.deps.semantic()
    if (!semantic) return { error: 'Visual search is not available.' }
    const ranking = await semantic.rank({ text: src.text })
    if (ranking.ids.length === 0) return { error: `Nothing in the library matches “${src.text}”.` }
    const hi = ranking.scores[0]!
    const lo = ranking.scores[ranking.scores.length - 1]!
    const span = Math.max(1e-6, hi - lo)
    return {
      label: `a search for “${src.text}”`,
      ids: ranking.ids,
      match: new Map(ranking.ids.map((id, i) => [id, Math.round(55 + (45 * (ranking.scores[i]! - lo)) / span)])),
      description: null
    }
  }

  async curate(request: CurationRequest): Promise<{ proposal: CuratedProposalData } | { error: string }> {
    const db = this.deps.db()
    const semantic = this.deps.semantic()
    if (!semantic) return { error: 'Curating needs the image model, which is not available.' }
    const found = await this.source(request)
    if ('error' in found) return found
    const snap = semantic.snapshot()
    const rowOf = new Map<string, number>()
    snap.ids.forEach((id, row) => rowOf.set(id, row))
    const ids = found.ids.filter((id) => rowOf.has(id)).slice(0, 460)
    if (ids.length === 0) return { error: 'None of these images have been learned by the image model yet.' }
    const items = db.getImagesByIds(ids).filter((item) => !item.missing)
    const byId = new Map(items.map((item) => [item.id, item]))
    const ordered = ids.map((id) => byId.get(id)).filter((item): item is ImageItem => Boolean(item))
    if (ordered.length === 0) return { error: 'None of these images are present any more.' }

    // What kind of image each one is, from evidence.
    const roles = await this.roles(ordered)

    // The user's taste: closeness to favorite groups, and what the Taste comparisons prefer.
    const modes = await this.deps.identity()?.modeCentroids().catch(() => []) ?? []
    const vecs = ordered.map((item) => snap.matrix.slice(rowOf.get(item.id)! * snap.dim, (rowOf.get(item.id)! + 1) * snap.dim))
    let modePercentile: Array<number | null> = ordered.map(() => null)
    let nearMode: Array<string | null> = ordered.map(() => null)
    if (modes.length > 0) {
      const best = vecs.map((v) => {
        let top = -1
        let label: string | null = null
        for (const m of modes) {
          const s = dot(v, 0, m.centroid)
          if (s > top) {
            top = s
            label = m.label
          }
        }
        return { top, label }
      })
      const sorted = best.map((b) => b.top).sort((a, b) => a - b)
      modePercentile = best.map((b) => percentileIn(sorted, b.top) / 100)
      // "Close" in absolute terms, not only relative to the other candidates.
      const sample: number[] = []
      const stride = Math.max(1, Math.floor(snap.ids.length / 1500))
      for (let r = 0; r < snap.ids.length; r += stride) {
        let top = -1
        for (const m of modes) top = Math.max(top, dot(snap.matrix, r * snap.dim, m.centroid))
        sample.push(top)
      }
      sample.sort((a, b) => a - b)
      const p80 = sample[Math.floor(sample.length * 0.8)] ?? 1
      nearMode = best.map((b) => (b.top >= p80 ? b.label : null))
    }
    const compass = await this.deps.taste()?.preferenceOf(ordered.map((i) => i.id)).catch(() => null)
    const candidates: CurationCandidate[] = ordered.map((item, i) => {
      const role = roles.get(item.id)
      return {
        id: item.id,
        match: found.match?.get(item.id) ?? null,
        filename: item.filename,
        favorite: item.favorite,
        rating: item.rating,
        decision: item.decision ?? null,
        role: role?.role ?? 'finished',
        roleReasons: role?.reasons ?? [],
        modePercentile: modePercentile[i] ?? null,
        nearMode: nearMode[i] ?? null,
        compassPercentile: compass ? (compass.percentile.get(item.id) ?? null) : null,
        outside: found.outside?.has(item.id) ?? false
      }
    })

    const result = curate({ candidates, vectors: vecs, count: request.count, includeTechnical: request.includeTechnical })
    const name = (request.name ?? '').trim() || (request.source.kind === 'smart' && request.source.name ? request.source.name : 'Curated selection')
    return {
      proposal: {
        kind: 'curated-moodboard',
        name: name.slice(0, 80),
        source: found.label,
        imageIds: result.picks.map((p) => p.imageId),
        picks: result.picks,
        alternatives: result.alternatives,
        leftOut: result.leftOut.slice(0, 80),
        requested: result.requested,
        shortfall: result.shortfall,
        tasteBasis: result.tasteBasis,
        considered: ordered.length
      }
    }
  }
}

