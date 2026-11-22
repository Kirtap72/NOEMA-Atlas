import { randomUUID } from 'node:crypto'
import type { AtlasDatabase } from '../db'
import type { Embedder } from '../embedder'
import { EMBEDDING_MODEL } from '../embedder'
import type { ReferenceCollection } from '../reference'
import { topMatches, type SemanticSearch } from '../semantic'
import type { AssistantBlock } from '../../shared/assistant'
import type { IdentityState, ImageItem, JourneySuggestion, ReferenceWork, TasteState } from '../../shared/types'
import type { ToolSpec } from './providers'
import type { BoardEditor } from '../studio/boardEdit'
import { studioTools } from './studioTools'
import { visionTools, type VisionAttachment } from './visionTools'
import { organizerTools } from './organizerTools'
import { modelTools } from './modelTools'
import type { OrganizerEngine } from '../organizer/engine'
import type { SmartCollections } from '../smartCollections'
import type { CurationService } from '../curationService'
import type { CompanionView } from '../../shared/curation'
import { normalizeCriteria, summarizeCriteria } from '../../shared/smart'

export interface StudioAssistantApi {
  run(imageId: string, steps: import('../../shared/studio').PlanStep[], hooks: { jobId: string; onStep: (text: string) => void }): Promise<import('../../shared/studio').PlanResult>
  stop(jobId: string): void
  versions(imageId: string): { seriesId: string; records: import('../../shared/studio').GenerationRecord[] }
  startExternal(imageId: string, editorId: string | null): Promise<{ editorName: string }>
  editors(): Array<{ id: string; name: string }>
}

/** What the assistant may use. Everything here already exists in Atlas; the assistant adds no data of its own. */
export interface AssistantContext {
  db: AtlasDatabase
  semantic: SemanticSearch | null
  /** True when the image model is on and images have been learned, so visual search works. */
  searchable(): boolean
  reference: ReferenceCollection | null
  identity(): Promise<IdentityState | null>
  taste(): Promise<TasteState | null>
  journeySuggestions(): Promise<JourneySuggestion[]>
  getEmbedder(): Promise<Embedder>
  /** Whether file and folder names may go into what is sent to the model. */
  mayShareNames(): boolean
  /** Looks up everyday-language descriptions of images (subject, mood, style, colour) with the local image model. */
  /** What Atlas can create, edit and upscale right now (the Creative Studio's own report). */
  capabilities?(): Promise<import('../../shared/ai').Capability[]>
  /** The Creative Studio's multi-step runner and version history, for editing plans the user approved. */
  studio?: StudioAssistantApi
  /** Changes to moodboards with undo. */
  boards?: BoardEditor
  /** Smart Collections: the user's own described collections, ranked by how well each image fits. */
  smart?: SmartCollections | null
  /** Evidence-based curation of a selection. */
  curation?: CurationService | null
  /** What the user is looking at in the window right now. */
  view?(): CompanionView
  /** Whether the language model runs on this computer, for deciding if pictures may be attached without asking. */
  vision?: { mode(): { provider: import('../../shared/assistant').AssistantProviderId; staysLocal: boolean; label: string; model: string } }
  /** The Smart Organizer: analysis, refinement and (user-approved) export of picture folders. */
  organizer?: OrganizerEngine | null
  describeVisually?(vectors: Float32Array[]): Promise<Array<{ subject?: string; mood?: string; style?: string; colour?: string }>>
}

/** Per-conversation memory: the short references the model uses for images, so it never sees paths or long ids. */
export class RefBook {
  private byRef = new Map<string, string>()
  private byId = new Map<string, string>()
  private next = 1

  constructor(saved: Record<string, string> = {}) {
    for (const [ref, id] of Object.entries(saved)) {
      this.byRef.set(ref, id)
      this.byId.set(id, ref)
      const n = Number(ref.replace(/^i/, ''))
      if (Number.isFinite(n)) this.next = Math.max(this.next, n + 1)
    }
  }

  refFor(id: string): string {
    const existing = this.byId.get(id)
    if (existing) return existing
    const ref = `i${this.next++}`
    this.byRef.set(ref, id)
    this.byId.set(id, ref)
    return ref
  }

  idFor(ref: unknown): string | null {
    if (typeof ref !== 'string') return null
    return this.byRef.get(ref.trim().toLowerCase().replace(/^#/, '')) ?? null
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.byRef)
  }
}

export interface ToolResult {
  /** What the model sees. Already redacted for the chosen provider. */
  model: unknown
  /** What the user sees in the conversation. */
  blocks: AssistantBlock[]
  /** Pictures for the model to look at. They go in the next user message, because tool messages carry text only. */
  images?: VisionAttachment[]
  visionIntent?: { compare: boolean; detail: 'normal' | 'close'; focus?: string }
}

export interface Tool {
  spec: ToolSpec
  /** Short line shown while the tool runs ("Looking through your library…"). */
  progress: string
  run(args: Record<string, unknown>, session: ToolSession): Promise<ToolResult>
}

export interface ToolSession {
  ctx: AssistantContext
  refs: RefBook
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}
const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.trim().slice(0, max) : '')

function basename(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file
}

/** Index of each image id in the embedding matrix, rebuilt only when the matrix changes. */
const rowCache = new WeakMap<object, Map<string, number>>()
function rowsOf(snapshot: { ids: string[] }): Map<string, number> {
  let map = rowCache.get(snapshot.ids)
  if (!map) {
    map = new Map(snapshot.ids.map((id, i) => [id, i]))
    rowCache.set(snapshot.ids, map)
  }
  return map
}

function familyNameOf(ctx: AssistantContext, imageId: string, families: Map<number, string>, owner: Map<string, number>): string | null {
  const id = owner.get(imageId)
  return id === undefined ? null : (families.get(id) ?? null)
}

/** For each image, the family it belongs to (names only). Built once per tool run. */
function familyIndex(ctx: AssistantContext): { names: Map<number, string>; owner: Map<string, number> } {
  const names = new Map<number, string>()
  const owner = new Map<string, number>()
  try {
    for (const family of ctx.db.listFamilies(EMBEDDING_MODEL, 0)) {
      const name = family.customName ?? family.autoName
      if (name) names.set(family.id, name)
    }
    for (const [id, familyId] of ctx.db.imageFamilyMap(EMBEDDING_MODEL)) owner.set(id, familyId)
  } catch {
    // Families are optional.
  }
  return { names, owner }
}

/** What the model may know about one image. Names of files and folders only when the user allowed it. */
async function describe(ctx: AssistantContext, session: ToolSession, items: ImageItem[], withVisual = true): Promise<Array<Record<string, unknown>>> {
  const { names, owner } = familyIndex(ctx)
  let visual: Array<{ subject?: string; mood?: string; style?: string; colour?: string }> = []
  if (withVisual && ctx.describeVisually && ctx.searchable() && ctx.semantic) {
    const snap = ctx.semantic.snapshot()
    const rows = rowsOf(snap)
    const vectors = items.map((item) => {
      const row = rows.get(item.id)
      return row === undefined ? new Float32Array(0) : snap.matrix.slice(row * snap.dim, (row + 1) * snap.dim)
    })
    try {
      visual = await ctx.describeVisually(vectors)
    } catch {
      visual = []
    }
  }
  const share = ctx.mayShareNames()
  return items.map((item, i) => {
    const entry: Record<string, unknown> = { ref: session.refs.refFor(item.id) }
    const v = visual[i]
    if (v?.subject) entry.looks_like = [v.subject, v.mood, v.style, v.colour].filter(Boolean)
    if (item.tags.length) entry.tags = item.tags.slice(0, 8)
    if (item.favorite) entry.favorite = true
    if (item.rating > 0) entry.rating = item.rating
    if (item.color) entry.dominant_colour = item.color
    if (item.width && item.height) entry.shape = item.width > item.height * 1.15 ? 'landscape format' : item.height > item.width * 1.15 ? 'portrait format' : 'square-ish'
    const family = familyNameOf(ctx, item.id, names, owner)
    if (family) entry.family = family
    if (share) {
      entry.filename = item.filename
      entry.folder = basename(item.folder)
    }
    return entry
  })
}

function workLine(work: ReferenceWork): Record<string, unknown> {
  return {
    title: work.title,
    artist: work.artist || 'unknown',
    date: work.date,
    culture: work.culture,
    museum: work.museumName,
    shelf: work.shelfLabel,
    id: work.id
  }
}

/** The mean of some embedding rows, as a unit vector, or null when none have embeddings. */
function centroidOf(ctx: AssistantContext, ids: string[]): Float32Array | null {
  if (!ctx.semantic) return null
  const snap = ctx.semantic.snapshot()
  const rows = rowsOf(snap)
  const sum = new Float32Array(snap.dim)
  let count = 0
  for (const id of ids) {
    const row = rows.get(id)
    if (row === undefined) continue
    count += 1
    for (let d = 0; d < snap.dim; d += 1) sum[d]! += snap.matrix[row * snap.dim + d]!
  }
  if (count === 0) return null
  let norm = 0
  for (let d = 0; d < snap.dim; d += 1) norm += sum[d]! * sum[d]!
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < snap.dim; d += 1) sum[d]! /= norm
  return sum
}

/** Nearest reference works to a vector, at most two from each shelf so the answer is not one tradition only. */
function nearestWorks(reference: ReferenceCollection, vector: Float32Array, limit: number): ReferenceWork[] {
  const found = topMatches(reference.matrix, reference.dim, vector, Math.min(reference.works.length, limit * 6))
  const picked: ReferenceWork[] = []
  const perShelf = new Map<string, number>()
  const perArtist = new Map<string, number>()
  for (const { row } of found) {
    const work = reference.works[row]!
    if ((perShelf.get(work.shelf) ?? 0) >= 2) continue
    const artist = work.artist.trim().toLowerCase()
    if (artist && (perArtist.get(artist) ?? 0) >= 1) continue
    picked.push(work)
    perShelf.set(work.shelf, (perShelf.get(work.shelf) ?? 0) + 1)
    if (artist) perArtist.set(artist, 1)
    if (picked.length >= limit) break
  }
  return picked
}

function resolveBoard(ctx: AssistantContext, wanted: string): { id: string; name: string } | { error: string } {
  const boards = ctx.db.listMoodboards()
  if (boards.length === 0) return { error: 'There are no moodboards yet.' }
  const q = wanted.trim().toLowerCase()
  if (!q) {
    const latest = [...boards].sort((a, b) => b.updatedAt - a.updatedAt)[0]!
    return { id: latest.id, name: latest.name }
  }
  const exact = boards.find((b) => b.name.toLowerCase() === q || b.id === wanted)
  if (exact) return { id: exact.id, name: exact.name }
  const partial = boards.filter((b) => b.name.toLowerCase().includes(q) || q.includes(b.name.toLowerCase()))
  if (partial.length === 1) return { id: partial[0]!.id, name: partial[0]!.name }
  return { error: `Which moodboard? Known moodboards: ${boards.map((b) => `"${b.name}"`).join(', ')}.` }
}

function idsFromRefs(args: Record<string, unknown>, session: ToolSession, key = 'refs'): { ids: string[]; unknown: string[] } {
  const list = Array.isArray(args[key]) ? (args[key] as unknown[]) : []
  const ids: string[] = []
  const unknown: string[] = []
  for (const ref of list.slice(0, 200)) {
    const id = session.refs.idFor(ref)
    if (id) {
      if (!ids.includes(id)) ids.push(id)
    } else unknown.push(String(ref))
  }
  return { ids, unknown }
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required })

export function buildTools(): Tool[] {
  const tools: Tool[] = [
    {
      progress: 'Looking at your library…',
      spec: {
        name: 'library_overview',
        description: 'Counts and shape of the user\'s library: images, favorites, sources, moodboards, visual families and whether visual search is available. Call this first when you need to know what exists.',
        parameters: obj({})
      },
      async run(_args, { ctx }) {
        const stats = ctx.db.getStats()
        const families = ctx.db.listFamilies(EMBEDDING_MODEL, 0).slice(0, 12)
        const boards = ctx.db.listMoodboards()
        const model = {
          images: stats.images,
          favorites: stats.favorites,
          sources: stats.roots,
          moodboards: boards.map((b) => ({ name: b.name, images: b.imageCount })),
          visual_search_available: ctx.searchable(),
          biggest_families: families.map((f) => ({ name: f.customName ?? f.autoName ?? 'unnamed', images: f.size })),
          reference_collection: ctx.reference ? `${ctx.reference.works.length} public-domain artworks` : 'not available'
        }
        return { model, blocks: [] }
      }
    },
    {
      progress: 'Searching your images…',
      spec: {
        name: 'search_images',
        description:
          'Find images in the user\'s library that match a description (for example "foggy mountain landscape"). Uses visual search by what the images look like when available, otherwise filenames and tags. Returns image references (i1, i2 ...) that can be used with other tools. The images are shown to the user automatically.',
        parameters: obj(
          {
            query: { type: 'string', description: 'What the images should look like, in plain language.' },
            limit: { type: 'integer', description: 'How many images, 1 to 24. Default 12.' },
            favorites_only: { type: 'boolean', description: 'Only search the user\'s favorites.' }
          },
          ['query']
        )
      },
      async run(args, session) {
        const { ctx } = session
        const query = text(args.query, 200)
        if (!query) return { model: { error: 'Give a description to search for.' }, blocks: [] }
        const limit = clampInt(args.limit, 12, 1, 24)
        const scope = args.favorites_only === true ? 'favorites' : 'collection'
        let items: ImageItem[]
        let mode: 'visual' | 'text'
        if (ctx.searchable() && ctx.semantic) {
          items = (await ctx.semantic.query({ scope, search: query, visual: true }, limit, 0)).items
          mode = 'visual'
        } else {
          items = ctx.db.queryImages({ scope, search: query, limit }).items
          mode = 'text'
        }
        const described = await describe(ctx, session, items, false)
        return {
          model: {
            matched_by: mode === 'visual' ? 'what the images look like' : 'filenames and tags only (visual search is off)',
            count: items.length,
            images: described
          },
          blocks: items.length ? [{ type: 'images', label: `Matches for “${query}”`, ids: items.map((i) => i.id), basis: 'library' }] : []
        }
      }
    },
    {
      progress: 'Studying those images…',
      spec: {
        name: 'describe_images',
        description:
          'Describe images by reference (i1, i2 ...): everyday-language subject, mood, style and colour as seen by the local image model, plus tags, rating, family and dominant colour. Use this to ground prompts, comparisons and moodboard ideas in what the images really show.',
        parameters: obj({ refs: { type: 'array', items: { type: 'string' }, description: 'Image references such as "i3".' } }, ['refs'])
      },
      async run(args, session) {
        const { ids, unknown } = idsFromRefs(args, session)
        const items = session.ctx.db.getImagesByIds(ids.slice(0, 24))
        return { model: { images: await describe(session.ctx, session, items), unknown_refs: unknown }, blocks: [] }
      }
    },
    {
      progress: 'Reading your favorites…',
      spec: {
        name: 'favorites_profile',
        description:
          'What the user\'s favorite images have in common: separate groups (a person can love several things), the qualities that reliably mark each group measured against a reference collection of art, and the closest reference works. Tentative when there are few favorites. Never describes dislikes.',
        parameters: obj({})
      },
      async run(_args, session) {
        const { ctx } = session
        const state = await ctx.identity()
        if (!state) return { model: { available: false, reason: 'The reference collection is not available.' }, blocks: [] }
        if (!state.available) return { model: { available: false, reason: state.reason, favorites: state.favorites }, blocks: [] }
        const blocks: AssistantBlock[] = []
        const modes = state.modes.slice(0, 4).map((mode) => {
          const images = mode.examples.filter((e): e is ImageItem => 'filename' in e).slice(0, 6)
          if (images.length) blocks.push({ type: 'images', label: `${mode.label} (${mode.size} favorites)`, ids: images.map((i) => i.id), basis: 'library' })
          if (mode.kindred.length) blocks.push({ type: 'works', label: `Closest in the reference collection to “${mode.label}”`, works: mode.kindred.slice(0, 4) })
          return {
            group: mode.label,
            favorites_in_group: mode.size,
            tentative: mode.tentative,
            reliable_qualities: mode.characteristics.map((c) => c.label),
            closest_reference_works: mode.kindred.slice(0, 4).map(workLine),
            example_images: images.map((i) => session.refs.refFor(i.id))
          }
        })
        return {
          model: {
            available: true,
            favorites: state.favorites,
            tentative: state.tentative,
            overall_reliable_qualities: state.dimensions.filter((d) => d.certain && d.mean > 0).slice(0, 6).map((d) => d.label),
            groups: modes,
            caveat: 'Qualities are measured against a reference collection of public-domain art; how common something is in the library says nothing about taste.'
          },
          blocks
        }
      }
    },
    {
      progress: 'Checking your taste compass…',
      spec: {
        name: 'taste_summary',
        description: 'What the user\'s choices in the Taste comparisons (picking between two images) reveal: qualities they lean towards, with evidence strength. May be unavailable if they have not made comparisons.',
        parameters: obj({})
      },
      async run(_args, { ctx }) {
        const state = await ctx.taste()
        if (!state || !state.available) return { model: { available: false, reason: state?.reason ?? 'The image model is not set up.' }, blocks: [] }
        return {
          model: {
            available: true,
            comparisons: state.compassChoices,
            stage: state.stage,
            leanings: state.dimensions
              .filter((d) => d.certain)
              .slice(0, 8)
              .map((d) => ({ quality: d.label, strength: Number(d.lean.toFixed(2)), comparisons: d.clear })),
            note: 'Only qualities with statistically reliable evidence are listed.'
          },
          blocks: []
        }
      }
    },
    {
      progress: 'Looking through your families…',
      spec: {
        name: 'list_families',
        description: 'The visual families Atlas found (groups of images that look alike), with their names and sizes.',
        parameters: obj({ limit: { type: 'integer' } })
      },
      async run(args, { ctx }) {
        const families = ctx.db.listFamilies(EMBEDDING_MODEL, 0).slice(0, clampInt(args.limit, 20, 1, 40))
        return {
          model: {
            families: families.map((f) => ({
              name: f.customName ?? f.autoName ?? 'unnamed',
              images: f.size,
              named_by_user: Boolean(f.customName),
              common_thread: f.nameInfo?.confidence ?? null,
              keywords: f.nameInfo?.keywords ?? []
            }))
          },
          blocks: []
        }
      }
    },
    {
      progress: 'Opening a family…',
      spec: {
        name: 'family_images',
        description: 'Show the most typical images of one visual family, by its name.',
        parameters: obj({ family: { type: 'string' }, limit: { type: 'integer' } }, ['family'])
      },
      async run(args, session) {
        const { ctx } = session
        const wanted = text(args.family).toLowerCase()
        const families = ctx.db.listFamilies(EMBEDDING_MODEL, 0)
        const family =
          families.find((f) => (f.customName ?? f.autoName ?? '').toLowerCase() === wanted) ??
          families.find((f) => (f.customName ?? f.autoName ?? '').toLowerCase().includes(wanted))
        if (!family) return { model: { error: 'No family with that name.', known: families.slice(0, 15).map((f) => f.customName ?? f.autoName) }, blocks: [] }
        const ids = ctx.db.familyImageIds(family.id).slice(0, clampInt(args.limit, 12, 1, 24))
        const items = ctx.db.getImagesByIds(ids)
        return {
          model: { family: family.customName ?? family.autoName, size: family.size, images: await describe(ctx, session, items, false) },
          blocks: items.length ? [{ type: 'images', label: `Family: ${family.customName ?? family.autoName ?? 'unnamed'}`, ids: items.map((i) => i.id), basis: 'library' }] : []
        }
      }
    },
    {
      progress: 'Opening your moodboards…',
      spec: {
        name: 'list_moodboards',
        description: 'The user\'s moodboards with their sizes.',
        parameters: obj({})
      },
      async run(_args, { ctx }) {
        return { model: { moodboards: ctx.db.listMoodboards().map((b) => ({ name: b.name, images: b.imageCount })) }, blocks: [] }
      }
    },
    {
      progress: 'Reading the moodboard…',
      spec: {
        name: 'moodboard_contents',
        description: 'The images on one moodboard (by name; the most recently changed one if omitted), described, so the assistant can say what the board is about and what it lacks.',
        parameters: obj({ board: { type: 'string' }, limit: { type: 'integer' } })
      },
      async run(args, session) {
        const { ctx } = session
        const board = resolveBoard(ctx, text(args.board))
        if ('error' in board) return { model: board, blocks: [] }
        const detail = ctx.db.getMoodboard(board.id)
        const items = (detail?.images ?? []).slice(0, clampInt(args.limit, 16, 1, 30))
        return {
          model: { board: board.name, total_images: detail?.imageCount ?? 0, images: await describe(ctx, session, items) },
          blocks: []
        }
      }
    },
    {
      progress: 'Finding images that would fit…',
      spec: {
        name: 'suggest_for_moodboard',
        description:
          'Find library images that would complement a moodboard: the closest to its overall look that are not already on it. Does not change the board. To add them, call propose_add_to_moodboard.',
        parameters: obj({ board: { type: 'string' }, limit: { type: 'integer' } })
      },
      async run(args, session) {
        const { ctx } = session
        const board = resolveBoard(ctx, text(args.board))
        if ('error' in board) return { model: board, blocks: [] }
        if (!ctx.searchable() || !ctx.semantic) return { model: { error: 'Visual search is off, so Atlas cannot compare images by how they look. The image model can be set up in the Atlas settings.' }, blocks: [] }
        const detail = ctx.db.getMoodboard(board.id)
        const members = new Set((detail?.images ?? []).map((i) => i.id))
        const centre = centroidOf(ctx, [...members])
        if (!centre) return { model: { error: 'None of the images on this board have been learned by the image model yet.' }, blocks: [] }
        const snap = ctx.semantic.snapshot()
        const limit = clampInt(args.limit, 10, 1, 24)
        const found = topMatches(snap.matrix, snap.dim, centre, limit * 5 + members.size)
        const chosen: number[] = []
        for (const { row } of found) {
          const id = snap.ids[row]!
          if (members.has(id)) continue
          // Skip near-duplicates of something already chosen, so the suggestions vary.
          let duplicate = false
          for (const other of chosen) {
            let dot = 0
            for (let d = 0; d < snap.dim; d += 1) dot += snap.matrix[row * snap.dim + d]! * snap.matrix[other * snap.dim + d]!
            if (dot > 0.96) {
              duplicate = true
              break
            }
          }
          if (duplicate) continue
          chosen.push(row)
          if (chosen.length >= limit) break
        }
        const items = ctx.db.getImagesByIds(chosen.map((r) => snap.ids[r]!)).filter((i) => !i.missing)
        return {
          model: { board: board.name, basis: 'closest to the overall look of the images already on the board', images: await describe(ctx, session, items) },
          blocks: items.length ? [{ type: 'images', label: `Could join “${board.name}”`, ids: items.map((i) => i.id), basis: 'library' }] : []
        }
      }
    },
    {
      progress: 'Comparing with the reference collection…',
      spec: {
        name: 'reference_matches',
        description:
          'Find works in the Atlas Reference Collection (public-domain art from many traditions, with artists, dates and museums) that look closest to the user\'s favorites, a moodboard, a visual family or a text description. This is visual resemblance, not proof of influence. Useful for "which artists might I enjoy".',
        parameters: obj(
          {
            from: { type: 'string', enum: ['favorites', 'moodboard', 'family', 'query'] },
            name: { type: 'string', description: 'Moodboard or family name, when from is moodboard or family.' },
            query: { type: 'string', description: 'A description, when from is query.' },
            limit: { type: 'integer' }
          },
          ['from']
        )
      },
      async run(args, session) {
        const { ctx } = session
        if (!ctx.reference) return { model: { error: 'The reference collection is not available.' }, blocks: [] }
        const limit = clampInt(args.limit, 6, 1, 12)
        const from = text(args.from, 20)
        let vector: Float32Array | null = null
        let label = ''
        if (from === 'favorites') {
          const favorites = ctx.db.queryImages({ scope: 'favorites', limit: 500 }).items
          vector = centroidOf(ctx, favorites.map((i) => i.id))
          label = 'your favorites'
        } else if (from === 'moodboard') {
          const board = resolveBoard(ctx, text(args.name))
          if ('error' in board) return { model: board, blocks: [] }
          vector = centroidOf(ctx, (ctx.db.getMoodboard(board.id)?.images ?? []).map((i) => i.id))
          label = `the moodboard “${board.name}”`
        } else if (from === 'family') {
          const wanted = text(args.name).toLowerCase()
          const family = ctx.db.listFamilies(EMBEDDING_MODEL, 0).find((f) => (f.customName ?? f.autoName ?? '').toLowerCase().includes(wanted))
          if (!family) return { model: { error: 'No family with that name.' }, blocks: [] }
          vector = centroidOf(ctx, ctx.db.familyImageIds(family.id).slice(0, 300))
          label = `the family “${family.customName ?? family.autoName}”`
        } else if (from === 'query') {
          const query = text(args.query)
          if (!query) return { model: { error: 'Give a description.' }, blocks: [] }
          try {
            vector = (await (await ctx.getEmbedder()).embedTexts([query]))[0] ?? null
          } catch {
            return { model: { error: 'The image model is not available to understand that description.' }, blocks: [] }
          }
          label = `“${query}”`
        }
        if (!vector) return { model: { error: 'Atlas has no learned images to compare yet. Visual features need the optional image model.' }, blocks: [] }
        const works = nearestWorks(ctx.reference, vector, limit)
        return {
          model: {
            compared_with: label,
            note: 'Visual resemblance in the reference collection, which is thin on abstraction and contemporary art. Not a claim about influence.',
            works: works.map(workLine)
          },
          blocks: works.length ? [{ type: 'works', label: `Closest to ${label}`, works }] : []
        }
      }
    },
    {
      progress: 'Looking for directions to explore…',
      spec: {
        name: 'journey_ideas',
        description: 'Discovery journeys Atlas could take the user on, with the evidence behind each.',
        parameters: obj({})
      },
      async run(_args, { ctx }) {
        const list = await ctx.journeySuggestions()
        return { model: { journeys: list.slice(0, 6).map((j) => ({ title: j.title, why: j.reason, evidence: j.evidence })) }, blocks: [] }
      }
    },
    {
      progress: 'Preparing a moodboard proposal…',
      spec: {
        name: 'propose_moodboard',
        description:
          'Propose a NEW moodboard made of library images (by reference). Nothing is created until the user presses Accept in the conversation. Always give a short reason.',
        parameters: obj({ name: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, ['name', 'refs'])
      },
      async run(args, session) {
        const { ids, unknown } = idsFromRefs(args, session)
        const name = text(args.name, 80)
        if (!name || ids.length === 0) return { model: { error: 'A moodboard needs a name and at least one known image reference.', unknown_refs: unknown }, blocks: [] }
        const items = session.ctx.db.getImagesByIds(ids.slice(0, 60))
        return {
          model: { status: 'Proposal shown to the user. It is NOT created until they accept it.', images: items.length },
          blocks: [
            {
              type: 'proposal',
              id: randomUUID(),
              title: `Make the moodboard “${name}”`,
              reason: text(args.reason, 300),
              proposal: { kind: 'new-moodboard', name, imageIds: items.map((i) => i.id) },
              status: 'pending'
            }
          ]
        }
      }
    },
    {
      progress: 'Preparing a proposal…',
      spec: {
        name: 'propose_add_to_moodboard',
        description: 'Propose adding library images (by reference) to an EXISTING moodboard. Nothing changes until the user presses Accept.',
        parameters: obj({ board: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, ['board', 'refs'])
      },
      async run(args, session) {
        const board = resolveBoard(session.ctx, text(args.board))
        if ('error' in board) return { model: board, blocks: [] }
        const { ids, unknown } = idsFromRefs(args, session)
        if (ids.length === 0) return { model: { error: 'No known image references given.', unknown_refs: unknown }, blocks: [] }
        const items = session.ctx.db.getImagesByIds(ids.slice(0, 60))
        return {
          model: { status: 'Proposal shown to the user. The board is NOT changed until they accept.', images: items.length },
          blocks: [
            {
              type: 'proposal',
              id: randomUUID(),
              title: `Add ${items.length} image${items.length === 1 ? '' : 's'} to “${board.name}”`,
              reason: text(args.reason, 300),
              proposal: { kind: 'add-to-moodboard', boardId: board.id, boardName: board.name, imageIds: items.map((i) => i.id) },
              status: 'pending'
            }
          ]
        }
      }
    }
  ]
  return [...tools, ...curationTools(), ...studioTools({ text, obj, idsFromRefs, resolveBoard }), ...visionTools({ text, obj, idsFromRefs, resolveBoard }),
    ...organizerTools({ text, obj, idsFromRefs, resolveBoard }), ...modelTools({ text, obj, idsFromRefs, resolveBoard })]
}

/** Tools for the user's Smart Collections and for choosing a few images from many, with reasons. */
function curationTools(): Tool[] {
  const findSmart = (ctx: AssistantContext, wanted: string): { id: string; name: string; criteria: unknown } | { error: string } => {
    const all = ctx.smart?.list() ?? []
    if (all.length === 0) return { error: 'There are no smart collections yet.' }
    const q = wanted.trim().toLowerCase()
    const hit = all.find((c) => c.name.toLowerCase() === q) ?? all.filter((c) => c.name.toLowerCase().includes(q) || q.includes(c.name.toLowerCase()))[0]
    if (!hit) return { error: `No smart collection with that name. Known: ${all.map((c) => `"${c.name}"`).join(', ')}.` }
    return { id: hit.id, name: hit.name, criteria: hit.criteria }
  }
  const tools: Tool[] = [
    {
      progress: 'Seeing what you are looking at…',
      spec: {
        name: 'current_view',
        description:
          'What the user is looking at in the Atlas window right now: a smart collection (with its description, colour and strictness settings, including edits not saved yet), a visual family, or nothing. Call this when the user says "this collection", "these", "the ones I see" or similar.',
        parameters: obj({})
      },
      async run(_args, { ctx }) {
        const view = ctx.view?.() ?? { kind: null }
        if (view.kind === 'smart') {
          const criteria = normalizeCriteria(view.criteria)
          const saved = view.id ? ctx.smart?.get(view.id) : null
          return {
            model: {
              viewing: 'a smart collection',
              name: view.name ?? saved?.name ?? 'an unsaved smart collection',
              saved: Boolean(saved),
              looks_for: summarizeCriteria(criteria),
              images_in_saved_collection: saved?.size ?? null,
              how_to_use: 'Call curate_images with source "current" to choose from exactly what the user sees, in this ranking.'
            },
            blocks: []
          }
        }
        if (view.kind === 'family') return { model: { viewing: 'a visual family', name: view.name, how_to_use: 'Call curate_images with source "current".' }, blocks: [] }
        return { model: { viewing: 'nothing in particular', note: 'The user is not looking at a collection. Ask which collection or description they mean.' }, blocks: [] }
      }
    },
    {
      progress: 'Looking through your smart collections…',
      spec: {
        name: 'list_smart_collections',
        description: 'The user\'s Smart Collections: collections defined by a description of how images look (for example "teal-toned surreal portraits"), with what each looks for and how many images it holds.',
        parameters: obj({})
      },
      async run(_args, { ctx }) {
        const list = ctx.smart?.list() ?? []
        return {
          model: { smart_collections: list.map((c) => ({ name: c.name, looks_for: summarizeCriteria(c.criteria), images: c.size, new_since_last_opened: c.newCount })) },
          blocks: []
        }
      }
    },
    {
      progress: 'Reading the smart collection…',
      spec: {
        name: 'smart_collection_images',
        description:
          'The images of a smart collection in its current ranking, best match first, with how well each fits (0 to 100), shown to the user. Use name "current" for the collection the user has open. Does not choose or judge: for "the best N" call curate_images instead.',
        parameters: obj({ name: { type: 'string', description: 'The collection name, or "current".' }, limit: { type: 'integer', description: '1 to 24. Default 12.' } }, ['name'])
      },
      async run(args, session) {
        const { ctx } = session
        if (!ctx.smart) return { model: { error: 'Smart Collections are not available.' }, blocks: [] }
        const wanted = text(args.name)
        let criteria: unknown
        let label = wanted
        const view = ctx.view?.() ?? { kind: null }
        if (wanted.toLowerCase() === 'current' || wanted === '') {
          if (view.kind !== 'smart') return { model: { error: 'The user is not looking at a smart collection. Ask which one.' }, blocks: [] }
          criteria = view.criteria
          label = view.name ?? 'the open collection'
        } else {
          const found = findSmart(ctx, wanted)
          if ('error' in found) return { model: found, blocks: [] }
          criteria = found.criteria
          label = found.name
        }
        const ranked = await ctx.smart.rank(criteria)
        if (ranked.problem) return { model: { error: ranked.problem }, blocks: [] }
        const limit = clampInt(args.limit, 12, 1, 24)
        const items = ctx.db.getImagesByIds(ranked.ids.slice(0, limit))
        const described = await describe(ctx, session, items, false)
        const matchOf = new Map(ranked.ids.map((id, i) => [id, ranked.match[i]!]))
        return {
          model: {
            collection: label,
            total_matching: ranked.ids.length,
            how_it_matched: ranked.explanation,
            images: described.map((entry, i) => ({ ...entry, match: matchOf.get(items[i]!.id) }))
          },
          blocks: items.length ? [{ type: 'images', label: `“${label}”, best matches first`, ids: items.map((i) => i.id), basis: 'library' }] : []
        }
      }
    },
    {
      progress: 'Curating a selection…',
      spec: {
        name: 'curate_images',
        description:
          'Choose the best N images for a purpose, from a smart collection, a family, the favorites or a search, the way a careful curator would: fit with the description, closeness to THIS user\'s own taste (favorites, Taste choices, ratings), coherence, variety, no near-duplicates, and leaving out technical working images such as software screenshots, wireframes and test renders. There is no universal quality score. Fewer images are proposed when too few are strong. The result is shown to the user as a review panel where they approve, reject or replace single images; nothing is created until they approve. Use this for "the best ten", "pick", "select", "curate" or a moodboard from a collection. Do not use propose_moodboard for those.',
        parameters: obj(
          {
            source: { type: 'string', enum: ['current', 'smart_collection', 'family', 'favorites', 'search'], description: '"current" is what the user has open in the window.' },
            name: { type: 'string', description: 'The smart collection or family name, when source is smart_collection or family.' },
            query: { type: 'string', description: 'A description, when source is search.' },
            count: { type: 'integer', description: 'How many images, 1 to 30. Default 10.' },
            include_technical: { type: 'boolean', description: 'Only when the user explicitly wants technical or working images included.' },
            moodboard_name: { type: 'string', description: 'A name for the proposed moodboard.' }
          },
          ['source']
        )
      },
      async run(args, session) {
        const { ctx } = session
        if (!ctx.curation) return { model: { error: 'Curation is not available.' }, blocks: [] }
        if (!ctx.searchable()) return { model: { error: 'Curating compares images by how they look, which needs the image model. It can be set up in the Atlas settings.' }, blocks: [] }
        const count = clampInt(args.count, 10, 1, 30)
        const source = text(args.source, 24)
        const name = text(args.name, 120)
        let request: Parameters<CurationService['curate']>[0]['source'] | null = null
        const view = ctx.view?.() ?? { kind: null }
        if (source === 'current' || (source === '' && view.kind)) {
          if (view.kind === 'smart') request = { kind: 'smart', id: view.id ?? null, criteria: view.criteria, name: view.name }
          else if (view.kind === 'family' && typeof view.id === 'string') request = { kind: 'family', id: Number(view.id), name: view.name ?? 'this family' }
          else return { model: { error: 'The user is not looking at a collection. Ask which smart collection, family or description they mean.' }, blocks: [] }
        } else if (source === 'smart_collection') {
          const found = findSmart(ctx, name)
          if ('error' in found) return { model: found, blocks: [] }
          request = { kind: 'smart', id: found.id, name: found.name }
        } else if (source === 'family') {
          const wanted = name.toLowerCase()
          const family = ctx.db.listFamilies(EMBEDDING_MODEL, 0).find((f) => (f.customName ?? f.autoName ?? '').toLowerCase().includes(wanted))
          if (!family) return { model: { error: 'No family with that name.' }, blocks: [] }
          request = { kind: 'family', id: family.id, name: family.customName ?? family.autoName ?? 'a family' }
        } else if (source === 'favorites') request = { kind: 'favorites' }
        else if (source === 'search') {
          const query = text(args.query, 200)
          if (!query) return { model: { error: 'Give a description to search for.' }, blocks: [] }
          request = { kind: 'query', text: query }
        } else return { model: { error: 'Choose a source: current, smart_collection, family, favorites or search.' }, blocks: [] }

        const result = await ctx.curation.curate({ source: request, count, includeTechnical: args.include_technical === true, name: text(args.moodboard_name, 80) || undefined })
        if ('error' in result) return { model: { error: result.error }, blocks: [] }
        const p = result.proposal
        if (p.picks.length === 0) {
          return {
            model: { proposed: 0, requested: count, shortfall: p.shortfall ?? 'No candidate was strong enough.', considered: p.considered, left_out: summarize(p.leftOut) },
            blocks: []
          }
        }
        const refFor = (id: string): string => session.refs.refFor(id)
        const named = ctx.db.getImagesByIds(p.picks.map((x) => x.imageId))
        const nameOf = new Map(named.map((i) => [i.id, i.filename]))
        const share = ctx.mayShareNames()
        return {
          model: {
            status: 'A review panel is shown to the user. Nothing is created until they approve; they can reject or replace single images.',
            from: p.source,
            considered: p.considered,
            requested: count,
            proposed: p.picks.length,
            shortfall: p.shortfall,
            taste_basis: p.tasteBasis,
            picks: p.picks.map((x) => ({ ref: refFor(x.imageId), kind: x.role, why: x.reasons, match: x.match, uncertain: x.uncertain, ...(share ? { filename: nameOf.get(x.imageId) } : {}) })),
            left_out: summarize(p.leftOut),
            guidance: 'Describe the selection briefly and honestly. Base remarks only on these reasons. Do not call any image objectively better; say it fits the description and the user\'s own taste. If shortfall is set, say why fewer are proposed.'
          },
          blocks: [
            {
              type: 'proposal',
              id: randomUUID(),
              title: `Review ${p.picks.length} curated image${p.picks.length === 1 ? '' : 's'} for “${p.name}”`,
              reason: p.shortfall ?? `Chosen from ${p.source}.`,
              proposal: p,
              status: 'pending'
            }
          ]
        }
      }
    }
  ]
  return tools
}

function summarize(leftOut: Array<{ why: string }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const entry of leftOut) out[entry.why] = (out[entry.why] ?? 0) + 1
  return out
}

export { describe as describeForModel, centroidOf, nearestWorks, resolveBoard }
