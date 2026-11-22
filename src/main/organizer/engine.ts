import { randomUUID } from 'node:crypto'
import { promises as fs, constants as fsConstants, existsSync, mkdirSync, statSync } from 'node:fs'
import { hashFile } from '../fileHash'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { AtlasDatabase } from '../db'
import { normalizePath } from '../db'
import { EMBEDDING_MODEL, type Embedder } from '../embedder'
import { exifOfFile } from '../exifHeader'
import { clusterFamilies, loadVocabulary, type FamilyDraft } from '../families'
import { computeBaseline, nameFamily, uniqueNames, type FamilyName, type VocabVectors } from '../familyNames'
import {
  DEFAULT_SETTINGS,
  KIND_LABELS,
  ORGANIZE_KINDS,
  type DuplicateGroupInfo,
  type DuplicatePolicy,
  type ExportReport,
  type OrganizeCategory,
  type OrganizeKind,
  type OrganizeKindGroup,
  type OrganizeOverview,
  type OrganizePhase,
  type OrganizePlanInfo,
  type OrganizePreview,
  type OrganizeProgress,
  type OrganizeScope,
  type OrganizeSettings,
  type StructurePreset
} from '../../shared/organizer'
import type { ImageItem } from '../../shared/types'
import { OrganizerStore, type ItemRow, type PlanRow } from './store'
import { categoryKey, chooseBest, placeItems, placementOf, planOperations, selectItems, type OrganizeItem } from './structure'

// The Smart Organizer's brain. It reads the pictures of a scope (never writes them), tells kinds of pictures apart,
// groups them by subject and style, finds copies and versions, and proposes a folder structure. Every batch is saved, so
// an analysis or an export can be paused, survive a crash and carry on.

export type RoleName = 'finished' | 'technical' | 'experimental' | 'unclear'

export interface OrganizerDeps {
  db: AtlasDatabase
  /** The image model's text side, for the picture-or-artwork test, the user's own categories and the folder names. */
  embedder: () => Promise<Pick<Embedder, 'embedTexts'>>
  /** Evidence on whether a picture is a finished work, a technical image, an experiment or unclear. */
  roles?: (items: ImageItem[]) => Promise<Map<string, { role: RoleName; reasons: string[] }>>
  progress?: (progress: OrganizeProgress) => void
  /** Free bytes where a path is (overridable for tests). */
  freeBytes?: (path: string) => Promise<number | null>
  /** Called when a plan changed, so the window and the companion can refresh. */
  changed?: (planId: string) => void
  /** Pictures read at a time. */
  batch?: number
  /** The camera named in a file's EXIF data, if any (overridable for tests). */
  camera?: (path: string) => Promise<string | null>
}

/** The camera (make and model) named in EXIF data, read from the file header only. */
export function cameraOfExif(exif: Buffer | undefined): string | null {
  if (!exif || exif.length < 12) return null
  try {
    const o = exif.toString('latin1', 0, 6) === 'Exif\u0000\u0000' ? 6 : 0
    const le = exif.toString('latin1', o, o + 2) === 'II'
    const u16 = (p: number): number => (le ? exif.readUInt16LE(p) : exif.readUInt16BE(p))
    const u32 = (p: number): number => (le ? exif.readUInt32LE(p) : exif.readUInt32BE(p))
    const ifd = o + u32(o + 4)
    const count = Math.min(u16(ifd), 200)
    let make = ''
    let model = ''
    for (let i = 0; i < count; i += 1) {
      const e = ifd + 2 + i * 12
      const tag = u16(e)
      if ((tag !== 0x10f && tag !== 0x110) || u16(e + 2) !== 2) continue
      const n = u32(e + 4)
      const at = n <= 4 ? e + 8 : o + u32(e + 8)
      const text = exif.toString('latin1', at, at + Math.min(n, 100)).replace(/\u0000[\s\S]*$/, '').trim()
      if (tag === 0x10f) make = text
      else model = text
    }
    const full = model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`
    return full.trim() || null
  } catch {
    return null
  }
}

/** The camera of a photograph, from the first bytes of the file only: no image library is involved, so a damaged file cannot harm the application. */
async function cameraOfFile(path: string): Promise<string | null> {
  if (!/\.(jpe?g|tiff?|webp|png)$/i.test(path)) return null
  return cameraOfExif(exifOfFile(path) ?? undefined)
}

const PHOTO_PROMPTS = [
  'a photograph taken with a camera',
  'a candid photo of real people',
  'a snapshot photo of a real place',
  'a documentary photograph',
  'a photo of a real object on a table',
  'landscape photography of nature'
]
const ART_PROMPTS = [
  'a painting',
  'a drawing or an illustration',
  'digital art',
  'a 3D render',
  'concept art',
  'an oil painting on canvas',
  'a stylised artwork',
  'abstract art',
  'a surreal artwork',
  'an engraving or a print'
]

/** What working images look like: software, sheets of test renders, diagrams and maps. Calibrated on a real library. */
const TECH_PROMPTS = [
  'a screenshot of a software user interface',
  'a technical diagram with text and labels',
  'a grid of test renders side by side for comparison',
  'a grayscale height map or texture sheet',
  'a chart or graph with numbers',
  'a page of text'
]
/** What a technical picture must look MORE like than: the finished-picture descriptions. */
const NOT_TECH_PROMPTS = [...ART_PROMPTS, 'a cozy photorealistic scene', 'a portrait of a person', 'a landscape']
/** A picture counts as technical when it resembles the working descriptions this much more than the picture descriptions. */
export const TECH_MARGIN = 0.035

/** How far the picture-or-artwork margin must go before Atlas says one or the other (between the two it is “uncertain”). */
export const PHOTO_MARGIN = { photograph: 0.02, artwork: 0.0 }

const NEAR_DUPLICATE = 0.95
const RELATED_VERSION = 0.9

const dot = (a: Float32Array, ao: number, b: Float32Array, bo: number, dim: number): number => {
  let s = 0
  for (let i = 0; i < dim; i += 1) s += a[ao + i]! * b[bo + i]!
  return s
}

export interface KindInput {
  role: RoleName | null
  reasons: string[]
  /** The best photograph prompt's similarity minus the best artwork prompt's, or null without an image-model reading. */
  photoMargin: number | null
  /** The camera that took the picture, from its own EXIF data (a generated or exported image usually has none). */
  camera?: string | null
  /** How much more the picture looks like a screenshot, diagram or test sheet than like a finished picture, or null. */
  techMargin?: number | null
}

/** The kind of a picture from the evidence. Pure, so the rules can be tested and tuned. */
export function decideKind(input: KindInput): { kind: OrganizeKind; why: string } {
  if (input.role === 'technical') return { kind: 'technical', why: input.reasons.length ? `looks like a working image: ${input.reasons.slice(0, 2).join('; ')}` : 'looks like a technical working image' }
  if (input.camera) return { kind: 'photograph', why: `has camera data (${input.camera})` }
  if (input.role === 'experimental') return { kind: 'experiment', why: input.reasons.length ? input.reasons[0]! : 'reads as an experiment or exploration' }
  if (input.role === 'unclear') return { kind: 'uncertain', why: input.reasons.length ? `unclear: ${input.reasons.slice(0, 2).join('; ')}` : 'mixed signals about what kind of image this is' }
  if (input.techMargin !== null && input.techMargin !== undefined && input.techMargin >= TECH_MARGIN && !input.camera) return { kind: 'technical', why: 'looks like a screenshot, diagram, map or sheet of test renders rather than a finished picture' }
  if (input.photoMargin === null) return { kind: 'uncertain', why: 'the image model has not looked at it yet, so only its file facts were used' }
  // Without camera data a photographic look is not proof of a photograph: realistic generated images look the same to the image model.
  if (input.photoMargin >= PHOTO_MARGIN.photograph) return { kind: 'uncertain', why: 'looks photographic but has no camera data: a photo with its details removed, or a realistic generated image' }
  if (input.photoMargin <= PHOTO_MARGIN.artwork) return { kind: 'artwork', why: 'looks more like a painting, drawing, render or other made image than like a photograph' }
  return { kind: 'uncertain', why: 'sits between photograph and artwork' }
}

/** Two file names that are versions of one another: the same name with a suffix such as _v2, -edit, (1), _upscaled, _final. */
export function relatedNames(a: string, b: string): boolean {
  const strip = (f: string): string =>
    f
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[\s_\-.]*(\(\d+\)|copy( \d+)?|kopia( \d+)?|v\d+|final\d*|edit(ed)?|retouch(ed)?|upscal(e|ed)|up|hd|\d+x|[12]x|x[24]|topaz.*|photoshop|ps|crop(ped)?|resized?|small|large|bloom.*)$/g, '')
      .replace(/[\s_\-.]*(\(\d+\)|v\d+|final\d*|edit(ed)?|upscal(e|ed)|\d+x)$/g, '')
  const sa = strip(a)
  const sb = strip(b)
  if (sa.length < 4 || sb.length < 4) return false
  return sa === sb || (Math.min(sa.length, sb.length) >= 8 && (sa.startsWith(sb) || sb.startsWith(sa)))
}

interface RefineBase {
  planId: string
}
export type RefineOp =
  | { op: 'structure'; value: StructurePreset }
  | { op: 'duplicates'; value: DuplicatePolicy }
  | { op: 'rename'; from: string; to: string; kind?: OrganizeKind }
  | { op: 'merge'; from: string[]; into: string; kind?: OrganizeKind }
  | { op: 'exclude'; kind: OrganizeKind }
  | { op: 'include'; kind: OrganizeKind }
  | { op: 'custom'; name: string; description: string }
  | { op: 'remove_custom'; name: string }
  | { op: 'move'; imageIds: string[]; category?: string; kind?: OrganizeKind }
  | { op: 'min_group'; value: number }
  /** Check exactly these groups (`kind|folder name`); an empty list checks none. */
  | { op: 'select'; keys: string[] }
  /** Treat every picture Atlas called `from` as `to` (for example all uncertain ones as artwork). */
  | { op: 'reclassify'; from: OrganizeKind; to: OrganizeKind }
export type { RefineBase }

export class OrganizerEngine {
  readonly store: OrganizerStore
  private jobs = new Map<string, AbortController>()
  private textCache = new Map<string, Float32Array>()
  private pauseRequested = new Set<string>()

  constructor(private deps: OrganizerDeps) {
    this.store = new OrganizerStore(deps.db)
    // A plan that was working when Atlas stopped is not working now: it waits to be resumed.
    for (const plan of this.store.plans()) {
      if (plan.status === 'analyzing') this.store.updatePlan(plan.id, { status: 'paused', message: 'Interrupted. It continues where it stopped.' })
      if (plan.status === 'exporting') this.store.updatePlan(plan.id, { status: 'export-paused', message: 'Interrupted. It continues where it stopped.' })
    }
  }

  // ---- plans ----------------------------------------------------------------------------------------------------------

  createPlan(name: string, scope: OrganizeScope, settings: Partial<OrganizeSettings> = {}): OrganizePlanInfo {
    const merged: OrganizeSettings = { ...DEFAULT_SETTINGS, ...settings, renames: { ...(settings.renames ?? {}) }, merges: { ...(settings.merges ?? {}) }, custom: [...(settings.custom ?? [])], overrides: { ...(settings.overrides ?? {}) }, excludeKinds: [...(settings.excludeKinds ?? [])] }
    const plan = this.store.createPlan(name.trim().slice(0, 80) || 'Organization', scope, merged)
    return this.info(plan)
  }

  info(plan: PlanRow): OrganizePlanInfo {
    const total = this.store.countItems(plan.id)
    const progress: OrganizeProgress | null = ['analyzing', 'paused', 'exporting', 'export-paused'].includes(plan.status) ? { planId: plan.id, status: plan.status, phase: plan.phase, done: plan.done, total: plan.total, message: plan.message } : null
    return {
      id: plan.id,
      name: plan.name,
      status: plan.status,
      scope: plan.scope,
      settings: plan.settings,
      total,
      progress,
      understood: this.store.countItems(plan.id, 'AND model_read = 1'),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      destination: plan.destination
    }
  }

  plans(): OrganizePlanInfo[] {
    return this.store.plans().map((p) => this.info(p))
  }

  plan(id: string): OrganizePlanInfo | null {
    const p = this.store.plan(id)
    return p ? this.info(p) : null
  }

  deletePlan(id: string): void {
    this.cancel(id)
    this.store.deletePlan(id)
  }

  isRunning(id: string): boolean {
    return this.jobs.has(id)
  }

  private report(plan: PlanRow, status: OrganizeProgress['status'], phase: OrganizePhase, done: number, total: number, message: string): void {
    this.store.updatePlan(plan.id, { status, phase, done, total, message })
    this.deps.progress?.({ planId: plan.id, status, phase, done, total, message })
  }

  // ---- scope ----------------------------------------------------------------------------------------------------------

  private scopeSql(scope: OrganizeScope): { where: string; params: Array<string | number> } {
    const parts: string[] = []
    const params: Array<string | number> = []
    if (scope.rootIds?.length) {
      parts.push(`root_id IN (${scope.rootIds.map(() => '?').join(',')})`)
      params.push(...scope.rootIds)
    }
    if (scope.folders?.length) {
      const likes: string[] = []
      for (const folder of scope.folders) {
        const norm = normalizePath(folder).replace(/[\\/]+$/, '')
        likes.push("(path LIKE ? ESCAPE '\\' OR folder = ?)")
        params.push(`${norm.replace(/[\\%_]/g, (c) => `\\${c}`)}\\%`, norm)
      }
      parts.push(`(${likes.join(' OR ')})`)
    }
    if (scope.imageIds?.length) {
      parts.push(`id IN (${scope.imageIds.map(() => '?').join(',')})`)
      params.push(...scope.imageIds)
    }
    // No limits given means the whole library.
    return { where: parts.length ? `AND (${parts.join(' OR ')})` : '', params }
  }

  /** How many pictures a scope covers right now (for the “analyze” button). */
  countScope(scope: OrganizeScope): number {
    const { where, params } = this.scopeSql(scope)
    return Number((this.deps.db.raw().prepare(`SELECT COUNT(*) AS n FROM images WHERE missing = 0 ${where}`).get(...params) as { n: number }).n)
  }

  // ---- analysis -------------------------------------------------------------------------------------------------------

  /** Starts (or resumes) the analysis in the background. Reads pictures, writes nothing outside Atlas's own database. */
  start(planId: string): void {
    const plan = this.store.plan(planId)
    if (!plan) throw new Error('That organization no longer exists.')
    if (this.jobs.has(planId)) return
    const controller = new AbortController()
    this.jobs.set(planId, controller)
    this.pauseRequested.delete(planId)
    void this.analyse(planId, controller.signal)
      .catch((error: unknown) => {
        const p = this.store.plan(planId)
        if (p) this.report(p, 'failed', p.phase, p.done, p.total, error instanceof Error ? error.message : 'The analysis stopped unexpectedly.')
      })
      .finally(() => {
        this.jobs.delete(planId)
        this.deps.changed?.(planId)
      })
  }

  /** Stops after the current batch; everything done so far is kept and `start` continues from it. */
  pause(planId: string): void {
    this.pauseRequested.add(planId)
    this.jobs.get(planId)?.abort()
  }

  cancel(planId: string): void {
    this.pauseRequested.delete(planId)
    this.jobs.get(planId)?.abort()
    const plan = this.store.plan(planId)
    if (plan && (plan.status === 'analyzing' || plan.status === 'paused')) this.store.updatePlan(planId, { status: 'cancelled', message: 'Cancelled.' })
  }

  private async yieldLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  private async analyse(planId: string, signal: AbortSignal): Promise<void> {
    let plan = this.store.plan(planId)!
    const batchSize = this.deps.batch ?? 300
    const stopped = (): boolean => signal.aborted
    const finishPaused = (): void => {
      const p = this.store.plan(planId)!
      if (this.pauseRequested.has(planId)) this.report(p, 'paused', p.phase, p.done, p.total, 'Paused. It continues where it stopped.')
    }
    // 1. The files: the facts about every picture in the scope, then the files that could be exact copies.
    this.report(plan, 'analyzing', 'facts', 0, 0, 'Listing the pictures…')
    const { where, params } = this.scopeSql(plan.scope)
    const db = this.deps.db.raw()
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM images WHERE missing = 0 ${where}`).get(...params) as { n: number }).n)
    let listed = this.store.countItems(planId)
    // The library can still list pictures whose files were deleted or moved since its last scan. They cannot be copied, and
    // asking the image library about them is what once brought the application down, so they are left out and counted.
    let notOnDisk = 0
    for (let offset = 0; offset < total; offset += batchSize) {
      if (stopped()) return finishPaused()
      if (listed >= total && offset === 0) break
      const rows = db.prepare(`SELECT id, path, filename, ext, bytes, width, height, mtime FROM images WHERE missing = 0 ${where} ORDER BY path LIMIT ? OFFSET ?`).all(...params, batchSize, offset) as Array<{ id: string; path: string; filename: string; ext: string; bytes: number; width: number; height: number; mtime: number }>
      const present = rows.filter((r) => existsSync(r.path))
      notOnDisk += rows.length - present.length
      this.store.insertFacts(planId, present.map((r) => ({ id: r.id, path: r.path, filename: r.filename, ext: r.ext, bytes: r.bytes, width: r.width, height: r.height, year: new Date(r.mtime).getFullYear() })))
      this.report(plan, 'analyzing', 'facts', Math.min(total, offset + rows.length), total, `Listed ${Math.min(total, offset + rows.length)} of ${total} pictures`)
      await this.yieldLoop()
    }
    plan = this.store.plan(planId)!
    // Files with the same size as another may be exact copies: only those are read, to compare them byte for byte.
    const toHash = this.store.sharedSizes(planId).length
    if (toHash > 0) {
      let hashed = 0
      for (;;) {
        if (stopped()) return finishPaused()
        const batch = this.store.itemsToHash(planId, 40)
        if (batch.length === 0) break
        const done: Array<{ id: string; hash: string }> = []
        for (const item of batch) {
          try {
            done.push({ id: item.id, hash: await hashFile(item.path) })
          } catch {
            done.push({ id: item.id, hash: `unreadable:${item.id}` })
          }
        }
        this.store.setHashes(planId, done)
        hashed += done.length
        this.report(plan, 'analyzing', 'facts', hashed, hashed + 1, `Comparing files that could be exact copies (${hashed})`)
        await this.yieldLoop()
      }
    }

    // 2. What kind of picture each one is.
    const textVectors = await this.kindVectors()
    const matrix = this.deps.db.loadEmbeddingMatrix(EMBEDDING_MODEL)
    const rowOf = new Map(matrix.ids.map((id, i) => [id, i]))
    const pending = this.store.countItems(planId, 'AND stage < 2')
    let understood = 0
    for (;;) {
      if (stopped()) return finishPaused()
      const batch = this.store.items(planId, 'AND stage < 2', batchSize)
      if (batch.length === 0) break
      const images = this.deps.db.getImagesByIds(batch.map((b) => b.id))
      const roles = this.deps.roles ? await this.deps.roles(images).catch(() => new Map()) : new Map()
      const cameras = new Map<string, string | null>()
      await Promise.all(batch.map(async (item) => cameras.set(item.id, await (this.deps.camera ?? cameraOfFile)(item.path).catch(() => null))))
      const out = batch.map((item) => {
        const row = rowOf.get(item.id)
        let margin: number | null = null
        let techMargin: number | null = null
        if (row !== undefined && textVectors && textVectors.dim === matrix.dim) {
          let photo = -Infinity
          let art = -Infinity
          for (const v of textVectors.photo) photo = Math.max(photo, dot(matrix.matrix, row * matrix.dim, v, 0, matrix.dim))
          for (const v of textVectors.art) art = Math.max(art, dot(matrix.matrix, row * matrix.dim, v, 0, matrix.dim))
          margin = photo - art
          let tech = -Infinity
          let notTech = -Infinity
          for (const v of textVectors.tech) tech = Math.max(tech, dot(matrix.matrix, row * matrix.dim, v, 0, matrix.dim))
          for (const v of textVectors.notTech) notTech = Math.max(notTech, dot(matrix.matrix, row * matrix.dim, v, 0, matrix.dim))
          techMargin = tech - notTech
        }
        const evidence = roles.get(item.id)
        const decision = decideKind({ role: evidence?.role ?? null, reasons: evidence?.reasons ?? [], photoMargin: margin, techMargin, camera: cameras.get(item.id) ?? null })
        return { id: item.id, kind: decision.kind, why: decision.why, modelRead: row !== undefined }
      })
      this.store.setUnderstanding(planId, out)
      understood += batch.length
      this.report(plan, 'analyzing', 'understanding', understood, pending, `Looked at ${understood} of ${pending} pictures`)
      await this.yieldLoop()
    }

    // 3. Grouping by subject and style.
    if (stopped()) return finishPaused()
    this.report(plan, 'analyzing', 'grouping', 0, 1, 'Grouping the pictures…')
    await this.group(planId, matrix, signal)
    if (stopped()) return finishPaused()

    // 4. Copies and versions.
    this.report(plan, 'analyzing', 'duplicates', 0, 1, 'Looking for copies and versions…')
    await this.findDuplicates(planId, matrix, signal)
    if (stopped()) return finishPaused()
    const last = this.store.plan(planId)!
    const analysed = this.store.countItems(planId)
    const left = notOnDisk > 0 ? notOnDisk : Math.max(0, total - analysed)
    this.report(last, 'ready', 'done', analysed, analysed, `Ready: ${analysed} pictures analysed.${left > 0 ? ` ${left} more listed in your library are no longer at their location and were left out.` : ''}`)
  }

  private async kindVectors(): Promise<{ photo: Float32Array[]; art: Float32Array[]; tech: Float32Array[]; notTech: Float32Array[]; dim: number } | null> {
    try {
      const embedder = await this.deps.embedder()
      const photo = await embedder.embedTexts(PHOTO_PROMPTS)
      const art = await embedder.embedTexts(ART_PROMPTS)
      const tech = await embedder.embedTexts(TECH_PROMPTS)
      const notTech = await embedder.embedTexts(NOT_TECH_PROMPTS)
      return { photo, art, tech, notTech, dim: photo[0]?.length ?? 0 }
    } catch {
      return null
    }
  }

  /** Subject and style folders, named from what the pictures of each group share. */
  private async group(planId: string, matrix: { ids: string[]; dim: number; matrix: Float32Array }, signal: AbortSignal): Promise<void> {
    const plan = this.store.plan(planId)!
    const items = this.store.items(planId)
    const rowOf = new Map(matrix.ids.map((id, i) => [id, i]))
    const dim = matrix.dim
    const updates: Array<{ id: string; subject: string | null; confidence: OrganizeItem['subjectConfidence']; cluster: number | null }> = []
    const assigned = new Set<string>()
    let vocab: VocabVectors | null = null
    let embedder: Pick<Embedder, 'embedTexts'> | null = null
    try {
      embedder = await this.deps.embedder()
    } catch {
      embedder = null
    }
    // The user's own categories first: a picture that clearly fits one goes there and is not clustered.
    const custom = plan.settings.custom
    if (custom.length > 0 && embedder && dim > 0) {
      const vectors = await embedder.embedTexts(custom.map((c) => c.description || c.name))
      const embedded = items.filter((i) => rowOf.has(i.id))
      const sims = custom.map((_c, ci) => embedded.map((i) => dot(matrix.matrix, rowOf.get(i.id)! * dim, vectors[ci]!, 0, dim)))
      const stats = sims.map((s) => {
        const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)
        const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length)) || 1e-6
        return { mean, sd }
      })
      embedded.forEach((item, n) => {
        let best = -1
        let bestZ = 1.5
        custom.forEach((_c, ci) => {
          const z = (sims[ci]![n]! - stats[ci]!.mean) / stats[ci]!.sd
          if (z > bestZ) {
            bestZ = z
            best = ci
          }
        })
        if (best >= 0) {
          assigned.add(item.id)
          updates.push({ id: item.id, subject: custom[best]!.name, confidence: 'custom', cluster: null })
        }
      })
    }
    // Then the rest, within each kind of picture.
    const byKind = new Map<OrganizeKind, ItemRow[]>()
    for (const item of items) {
      if (assigned.has(item.id)) continue
      const list = byKind.get(item.kind) ?? []
      list.push(item)
      byKind.set(item.kind, list)
    }
    let clusterId = 0
    if (embedder && dim > 0) {
      try {
        const v = await loadVocabulary(embedder as Embedder)
        if (v.dim === dim) vocab = { ...v, baseline: computeBaseline(matrix.matrix, matrix.ids.length, v) }
      } catch {
        vocab = null
      }
    }
    for (const kind of ORGANIZE_KINDS) {
      // Technical pictures are not sorted by subject: they are collected as they are. Uncertain ones are grouped too,
      // so that they have subject folders if the user decides to treat them as artwork or photographs.
      if (kind === 'technical') continue
      const members = (byKind.get(kind) ?? []).filter((i) => rowOf.has(i.id))
      for (const item of byKind.get(kind) ?? []) if (!rowOf.has(item.id)) updates.push({ id: item.id, subject: null, confidence: null, cluster: null })
      if (members.length === 0) continue
      const local = new Float32Array(members.length * dim)
      members.forEach((m, i) => local.set(matrix.matrix.subarray(rowOf.get(m.id)! * dim, (rowOf.get(m.id)! + 1) * dim), i * dim))
      const minSize = Math.max(2, plan.settings.minGroup)
      const lrow = new Map(members.map((x, i) => [x.id, i]))
      const nameOf = (d: FamilyDraft): FamilyName => {
        const m = d.members.slice(0, 400)
        const block = new Float32Array(m.length * dim)
        m.forEach((member, i) => block.set(local.subarray(lrow.get(member.id)! * dim, (lrow.get(member.id)! + 1) * dim), i * dim))
        return nameFamily(block, m.length, vocab!, { cohesion: d.cohesion })
      }
      let drafts = await clusterFamilies(members.map((m) => m.id), dim, local, { minSize })
      if (signal.aborted) return
      let names: FamilyName[] | null = vocab ? drafts.map(nameOf) : null
      if (vocab && names) {
        // A big group with no common thread is split once more, so folders say something about what is in them.
        const refined: FamilyDraft[] = []
        const refinedNames: FamilyName[] = []
        for (let d = 0; d < drafts.length; d += 1) {
          const draft = drafts[d]!
          if (names[d]!.confidence === 'mixed' && draft.members.length >= Math.max(24, minSize * 6)) {
            const sub = new Float32Array(draft.members.length * dim)
            draft.members.forEach((member, i) => sub.set(local.subarray(lrow.get(member.id)! * dim, (lrow.get(member.id)! + 1) * dim), i * dim))
            const parts = await clusterFamilies(draft.members.map((m) => m.id), dim, sub, { minSize, seed: 77 })
            const partNames = parts.map(nameOf)
            if (parts.length >= 2 && partNames.some((n) => n.confidence !== 'mixed')) {
              // Pictures the second pass leaves out stay in the first group.
              const covered = new Set(parts.flatMap((p) => p.members.map((m) => m.id)))
              const rest = draft.members.filter((m) => !covered.has(m.id))
              parts.forEach((part, i) => {
                refined.push(part)
                refinedNames.push(partNames[i]!)
              })
              if (rest.length > 0) {
                refined.push({ ...draft, members: rest })
                refinedNames.push(names[d]!)
              }
              continue
            }
          }
          refined.push(draft)
          refinedNames.push(names[d]!)
        }
        drafts = refined
        names = refinedNames
      }
      const finalNames = names ? uniqueNames(names) : drafts.map((_d, i) => `Group ${i + 1}`)
      const inCluster = new Set<string>()
      drafts.forEach((draft, d) => {
        clusterId += 1
        for (const member of draft.members) {
          inCluster.add(member.id)
          updates.push({ id: member.id, subject: finalNames[d]!, confidence: names ? names[d]!.confidence : 'loose', cluster: clusterId })
        }
      })
      for (const m of members) if (!inCluster.has(m.id)) updates.push({ id: m.id, subject: null, confidence: null, cluster: null })
    }
    // Technical pictures: no subject folders.
    for (const kind of ['technical'] as OrganizeKind[]) for (const item of byKind.get(kind) ?? []) updates.push({ id: item.id, subject: null, confidence: null, cluster: null })
    for (let i = 0; i < updates.length; i += 500) {
      this.store.setSubjects(planId, updates.slice(i, i + 500))
      await this.yieldLoop()
    }
  }

  /** Exact copies (same bytes), near-identical pictures and versions of one another, each group with a suggested best. */
  private async findDuplicates(planId: string, matrix: { ids: string[]; dim: number; matrix: Float32Array }, signal: AbortSignal): Promise<void> {
    const items = this.store.items(planId)
    this.store.clearDuplicates(planId)
    const parent = new Map<string, string>()
    const find = (x: string): string => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)!
      let c = x
      while (parent.get(c) !== r) {
        const next = parent.get(c)!
        parent.set(c, r)
        c = next
      }
      return r
    }
    const union = (a: string, b: string): void => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    for (const i of items) parent.set(i.id, i.id)
    const edge = new Map<string, 'exact' | 'near' | 'versions'>()
    const strength = { exact: 3, near: 2, versions: 1 }
    const mark = (a: string, b: string, type: 'exact' | 'near' | 'versions'): void => {
      union(a, b)
      for (const key of [a, b]) {
        const cur = edge.get(key)
        if (!cur || strength[type] > strength[cur]) edge.set(key, type)
      }
    }
    // Exact copies: the same hash.
    const byHash = new Map<string, ItemRow[]>()
    for (const i of items) if (i.hash && !i.hash.startsWith('unreadable:')) byHash.set(i.hash, [...(byHash.get(i.hash) ?? []), i])
    for (const list of byHash.values()) for (let k = 1; k < list.length; k += 1) mark(list[0]!.id, list[k]!.id, 'exact')
    // Near copies and versions: pictures that look alike, compared only within their own neighbourhood (same subject group).
    const dim = matrix.dim
    const rowOf = new Map(matrix.ids.map((id, i) => [id, i]))
    const blocks = new Map<string, ItemRow[]>()
    for (const i of items) {
      if (!rowOf.has(i.id)) continue
      const key = `${i.kind}:${i.cluster ?? 'none'}`
      blocks.set(key, [...(blocks.get(key) ?? []), i])
    }
    // Pictures outside any group are compared with every other loose picture of the same kind in manageable runs.
    let blockCount = 0
    for (const list of blocks.values()) {
      if (signal.aborted) return
      for (let a = 0; a < list.length; a += 1) {
        const ra = rowOf.get(list[a]!.id)! * dim
        const ia = list[a]!
        for (let b = a + 1; b < list.length; b += 1) {
          const ib = list[b]!
          const sim = dot(matrix.matrix, ra, matrix.matrix, rowOf.get(ib.id)! * dim, dim)
          if (sim < RELATED_VERSION) continue
          const ar = ia.width / Math.max(1, ia.height)
          const br = ib.width / Math.max(1, ib.height)
          const sameShape = Math.abs(ar - br) / Math.max(ar, br) < 0.06
          if (sim >= NEAR_DUPLICATE && sameShape) mark(ia.id, ib.id, 'near')
          else if (relatedNames(ia.filename, ib.filename) && sim >= RELATED_VERSION) mark(ia.id, ib.id, 'versions')
        }
      }
      blockCount += 1
      if (blockCount % 10 === 0) await this.yieldLoop()
    }
    // Names alone: the same picture saved at another size under a related name, even when pictures are far apart in grouping.
    const groups = new Map<string, ItemRow[]>()
    for (const i of items) {
      const root = find(i.id)
      groups.set(root, [...(groups.get(root) ?? []), i])
    }
    const meta = new Map(this.deps.db.getImagesByIds(items.map((i) => i.id).slice(0, 100_000)).map((x) => [x.id, x]))
    const rows: Array<{ id: string; group: string; type: 'exact' | 'near' | 'versions'; best: boolean }> = []
    let n = 0
    for (const list of groups.values()) {
      if (list.length < 2) continue
      n += 1
      const members = list.map((m) => {
        const x = meta.get(m.id)
        return { id: m.id, width: m.width, height: m.height, bytes: m.bytes, favorite: x?.favorite ?? false, rating: x?.rating ?? 0, decision: x?.decision ?? null, mtime: x?.mtime ?? 0 }
      })
      const { best } = chooseBest(members)
      const types = list.map((m) => edge.get(m.id) ?? 'versions')
      const type: 'exact' | 'near' | 'versions' = types.every((t) => t === 'exact') ? 'exact' : types.includes('versions') ? 'versions' : 'near'
      const id = `g${String(n).padStart(4, '0')}`
      for (const m of list) rows.push({ id: m.id, group: id, type, best: m.id === best.id })
    }
    for (let i = 0; i < rows.length; i += 500) this.store.setDuplicates(planId, rows.slice(i, i + 500))
  }

  // ---- overview and refinement ------------------------------------------------------------------------------------------

  private itemsOf(planId: string): OrganizeItem[] {
    return this.store.items(planId)
  }

  overview(planId: string): OrganizeOverview {
    const plan = this.store.plan(planId)
    if (!plan) throw new Error('That organization no longer exists.')
    const items = this.itemsOf(planId)
    const settings = plan.settings
    type Acc = { name: string; key: string; count: number; conf: OrganizeCategory['confidence']; ids: ItemRow[] }
    const byKind = new Map<OrganizeKind, Map<string, Acc>>()
    for (const item of items) {
      const p = placementOf(item, settings)
      const map = byKind.get(p.kind) ?? new Map<string, Acc>()
      const acc = map.get(p.name) ?? { name: p.name, key: p.key, count: 0, conf: item.subjectConfidence, ids: [] }
      acc.count += 1
      acc.ids.push(item as ItemRow)
      map.set(p.name, acc)
      byKind.set(p.kind, map)
    }
    const kinds: OrganizeKindGroup[] = ORGANIZE_KINDS.map((kind) => {
      const map = byKind.get(kind) ?? new Map<string, Acc>()
      const categories: OrganizeCategory[] = Array.from(map.values())
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .map((a) => ({
          name: a.name,
          key: a.key,
          count: a.count,
          confidence: a.conf,
          note: a.conf === 'custom' ? 'Your own category.' : a.conf === 'mixed' ? 'No clear common thread: a mix.' : a.conf === 'loose' ? 'A loose group: most of these share this.' : a.conf === 'clear' ? 'Most of these share this.' : '',
          sampleIds: [...a.ids].sort((x, y) => y.width * y.height - x.width * x.height).slice(0, 4).map((x) => x.id)
        }))
      return { kind, label: KIND_LABELS[kind], count: categories.reduce((s, c) => s + c.count, 0), excluded: settings.excludeKinds.includes(kind), categories }
    }).filter((k) => k.count > 0)
    const groups = this.duplicateGroups(planId, 8)
    const dupItems = items.filter((i) => i.dupGroup)
    const types = new Map<string, 'exact' | 'near' | 'versions'>()
    for (const i of dupItems) if (i.dupGroup && i.dupType) types.set(i.dupGroup, i.dupType)
    const count = (t: string): number => Array.from(types.values()).filter((x) => x === t).length
    const chosenItems = selectItems(items, settings)
    const folders = new Map<string, number>()
    for (const item of placeItems(chosenItems, settings)) {
      if (item.action !== 'copy') continue
      const path = item.folder.join('/') || '(the destination folder itself)'
      folders.set(path, (folders.get(path) ?? 0) + 1)
    }
    const present = new Set(kinds.flatMap((k) => k.categories.map((c) => `${k.kind}|${c.name}`)))
    const keys = (settings.selection ?? []).filter((k) => present.has(k))
    const chosenBytes = chosenItems.reduce((n, i) => n + i.bytes, 0)
    return {
      plan: this.info(plan),
      kinds,
      duplicates: { groups: types.size, extras: dupItems.filter((i) => !i.isBest).length, exact: count('exact'), near: count('near'), versions: count('versions'), sample: groups },
      withoutModel: items.filter((i) => !i.modelRead).length,
      tree: Array.from(folders, ([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
      selection: { keys, groups: keys.length, pictures: chosenItems.length, bytes: chosenBytes, all: false }
    }
  }

  /** The pictures of one group (a final folder within a kind), largest first, so they can be looked at and compared. */
  groupImageIds(planId: string, kind: OrganizeKind, name: string, limit = 400): string[] {
    const plan = this.store.plan(planId)
    if (!plan) throw new Error('That organization no longer exists.')
    return this.itemsOf(planId)
      .filter((i) => {
        const p = placementOf(i, plan.settings)
        return p.kind === kind && p.name === name
      })
      .sort((a, b) => b.width * b.height - a.width * a.height || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((i) => i.id)
  }

  duplicateGroups(planId: string, limit = 50, offset = 0): DuplicateGroupInfo[] {
    const items = this.store.items(planId, 'AND dup_group IS NOT NULL')
    const groups = new Map<string, ItemRow[]>()
    for (const i of items) groups.set(i.dupGroup!, [...(groups.get(i.dupGroup!) ?? []), i])
    const meta = new Map(this.deps.db.getImagesByIds(items.map((i) => i.id)).map((x) => [x.id, x]))
    return Array.from(groups.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(offset, offset + limit)
      .map(([id, list]) => {
        const best = list.find((i) => i.isBest) ?? list[0]!
        const members = list.map((m) => {
          const x = meta.get(m.id)
          return { id: m.id, width: m.width, height: m.height, bytes: m.bytes, favorite: x?.favorite ?? false, rating: x?.rating ?? 0, decision: x?.decision ?? null, mtime: x?.mtime ?? 0 }
        })
        return { id, type: best.dupType ?? 'near', bestId: best.id, why: chooseBest(members).why, memberIds: [best.id, ...list.filter((m) => m.id !== best.id).map((m) => m.id)] }
      })
  }

  /** Applies the changes the user (or the companion for them) asked for. Nothing is copied; the structure is re-planned. */
  refine(planId: string, ops: RefineOp[]): { overview: OrganizeOverview; messages: string[] } {
    const plan = this.store.plan(planId)
    if (!plan) throw new Error('That organization no longer exists.')
    const settings: OrganizeSettings = { ...plan.settings, selection: [...(plan.settings.selection ?? [])], kindMap: { ...plan.settings.kindMap }, renames: { ...plan.settings.renames }, merges: { ...plan.settings.merges }, custom: [...plan.settings.custom], overrides: { ...plan.settings.overrides }, excludeKinds: [...plan.settings.excludeKinds] }
    const messages: string[] = []
    const items = this.itemsOf(planId)
    const categories = (kind?: OrganizeKind): Array<{ kind: OrganizeKind; key: string; name: string; count: number }> => {
      const seen = new Map<string, { kind: OrganizeKind; key: string; name: string; count: number }>()
      for (const item of items) {
        const p = placementOf(item, settings)
        if (kind && p.kind !== kind) continue
        const k = `${p.kind}|${p.name}`
        const cur = seen.get(k) ?? { kind: p.kind, key: p.key, name: p.name, count: 0 }
        cur.count += 1
        seen.set(k, cur)
      }
      return Array.from(seen.values())
    }
    const find = (name: string, kind?: OrganizeKind): Array<{ kind: OrganizeKind; key: string; name: string; count: number }> => categories(kind).filter((c) => c.name.toLowerCase() === name.trim().toLowerCase() || c.key === name)
    let regroup = false
    for (const op of ops) {
      if (op.op === 'structure') {
        settings.structure = op.value
        messages.push(`Arranged as: ${op.value}.`)
      } else if (op.op === 'duplicates') {
        settings.duplicates = op.value
        messages.push(`Duplicates and versions: ${op.value}.`)
      } else if (op.op === 'exclude') {
        if (!settings.excludeKinds.includes(op.kind)) settings.excludeKinds.push(op.kind)
        messages.push(`${KIND_LABELS[op.kind]} will not be exported.`)
      } else if (op.op === 'include') {
        settings.excludeKinds = settings.excludeKinds.filter((k) => k !== op.kind)
        messages.push(`${KIND_LABELS[op.kind]} will be exported.`)
      } else if (op.op === 'reclassify') {
        if (op.from === op.to) delete settings.kindMap[op.from]
        else settings.kindMap[op.from] = op.to
        messages.push(op.from === op.to ? `${KIND_LABELS[op.from]} are treated as what Atlas found.` : `Everything Atlas called “${KIND_LABELS[op.from]}” is now treated as ${KIND_LABELS[op.to]}.`)
      } else if (op.op === 'min_group') {
        settings.minGroup = Math.max(1, Math.min(50, Math.round(op.value)))
        messages.push(`Folders with fewer than ${settings.minGroup} pictures are collected in “Other”.`)
      } else if (op.op === 'select') {
        const present = new Set(categories().map((c) => `${c.kind}|${c.name}`))
        settings.selection = Array.from(new Set(op.keys.filter((k) => present.has(k))))
        messages.push(settings.selection.length ? `${settings.selection.length} folder${settings.selection.length === 1 ? ' is' : 's are'} checked: only ${settings.selection.length === 1 ? 'it is' : 'they are'} included.` : 'Nothing is checked.')
      } else if (op.op === 'rename') {
        const hits = find(op.from, op.kind)
        const to = op.to.trim().slice(0, 80)
        if (hits.length === 0) messages.push(`There is no folder called “${op.from}”.`)
        else if (!to) messages.push('The new name is empty.')
        else for (const h of hits) {
          settings.renames[h.key] = to
          delete settings.merges[h.key]
          // A checked group stays checked under its new name.
          settings.selection = (settings.selection ?? []).map((k) => (k === `${h.kind}|${h.name}` ? `${h.kind}|${to}` : k))
          messages.push(`“${h.name}” is now “${to}” (${h.count} pictures).`)
        }
      } else if (op.op === 'merge') {
        const into = op.into.trim().slice(0, 80)
        for (const from of op.from) {
          const hits = find(from, op.kind)
          if (hits.length === 0) messages.push(`There is no folder called “${from}”.`)
          for (const h of hits) {
            settings.merges[h.key] = into
            settings.selection = (settings.selection ?? []).map((k) => (k === `${h.kind}|${h.name}` ? `${h.kind}|${into}` : k))
            messages.push(`“${h.name}” (${h.count} pictures) is folded into “${into}”.`)
          }
        }
      } else if (op.op === 'custom') {
        const name = op.name.trim().slice(0, 80)
        if (name) {
          settings.custom = [...settings.custom.filter((c) => c.name.toLowerCase() !== name.toLowerCase()), { name, description: op.description.trim().slice(0, 300) }]
          regroup = true
          messages.push(`Added your category “${name}”: pictures that clearly fit “${op.description.trim() || name}” go there.`)
        }
      } else if (op.op === 'remove_custom') {
        settings.custom = settings.custom.filter((c) => c.name.toLowerCase() !== op.name.trim().toLowerCase())
        regroup = true
        messages.push(`Removed your category “${op.name}”.`)
      } else if (op.op === 'move') {
        const ids = op.imageIds.filter((id) => items.some((i) => i.id === id))
        for (const id of ids) settings.overrides[id] = { ...settings.overrides[id], ...(op.kind ? { kind: op.kind } : {}), ...(op.category ? { subject: op.category.trim().slice(0, 80) } : {}) }
        messages.push(`Placed ${ids.length} picture${ids.length === 1 ? '' : 's'}${op.category ? ` in “${op.category}”` : ''}${op.kind ? ` as ${KIND_LABELS[op.kind]}` : ''}.`)
      }
    }
    settings.selection = Array.from(new Set(settings.selection ?? []))
    this.store.updatePlan(planId, { settings })
    if (regroup) {
      // The user's own categories change which pictures are clustered: regroup (quick, no files are read).
      void this.regroup(planId).finally(() => this.deps.changed?.(planId))
    } else this.deps.changed?.(planId)
    return { overview: this.overview(planId), messages }
  }

  /** Groups again after the categories changed. */
  async regroup(planId: string): Promise<void> {
    const matrix = this.deps.db.loadEmbeddingMatrix(EMBEDDING_MODEL)
    const controller = new AbortController()
    await this.group(planId, matrix, controller.signal)
    await this.findDuplicates(planId, matrix, controller.signal)
  }

  // ---- preview ---------------------------------------------------------------------------------------------------------

  private existing(): (path: string) => { size: number; mtimeMs: number } | null {
    return (path) => {
      try {
        const st = statSync(path)
        return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null
      } catch {
        return null
      }
    }
  }

  private async identicalFiles(src: string, dst: string): Promise<boolean> {
    const [sourceHash, destinationHash] = await Promise.all([hashFile(src), hashFile(dst)])
    return sourceHash === destinationHash
  }

  async preview(planId: string, destination: string, sampleSize = 200, offset = 0, mode: 'copy' | 'move' = 'copy'): Promise<OrganizePreview> {
    const plan = this.store.plan(planId)
    if (!plan) throw new Error('That organization no longer exists.')
    const dest = this.checkDestination(plan, destination)
    const all = this.itemsOf(planId)
    // Only what is checked. Nothing checked means nothing is included.
    const items = selectItems(all, plan.settings)
    const plannedOps = await planOperations(items, plan.settings, dest, this.existing(), (src, dst) => this.identicalFiles(src, dst).catch(() => false))
    const keys = plan.settings.selection ?? []
    const copy = plannedOps.ops.filter((o) => o.action === 'copy')
    const free = await (this.deps.freeBytes ?? defaultFreeBytes)(dest)
    const warnings = [...plannedOps.warnings]
    // Copying needs room for every file. A move inside one drive only renames (no room needed); across drives it copies first.
    const destRoot = parse(dest).root.toLowerCase()
    const need = mode === 'move' ? plannedOps.ops.filter((o) => o.action === 'copy' && parse(o.from).root.toLowerCase() !== destRoot).reduce((n, o) => n + o.bytes, 0) : plannedOps.copyBytes
    // A little headroom for the report file and the file system.
    const enough = free === null ? true : free > need + 50 * 1024 * 1024
    if (free === null) warnings.push('Atlas could not read the free space at that location. Check it before exporting.')
    if (!enough) warnings.push(`There is not enough free space: ${fmtBytes(need)} is needed and ${fmtBytes(free ?? 0)} is free.`)
    if (parse(dest).root.toLowerCase() === resolve(dest).toLowerCase()) warnings.push('The destination is the root of a drive. A folder of its own keeps the exported pictures together.')
    if (plannedOps.skipped.excluded > 0) warnings.push(`${plannedOps.skipped.excluded} pictures are left out because of the kinds you excluded.`)
    if (mode === 'move') {
      // A move relocates the originals. Say what that means for the space, and for drives, before anything happens.
      const missing = items.filter((i) => !existsSync(i.path)).length
      if (missing > 0) warnings.push(`${missing} of these pictures are no longer at their place; they cannot be moved and will be reported.`)
      const srcDrives = new Set(items.map((i) => parse(i.path).root.toLowerCase()))
      if (!srcDrives.has(parse(dest).root.toLowerCase())) warnings.push('The destination is on another drive: each picture is copied, checked byte for byte, recorded in the library, and only then removed from its old place.')
      warnings.push('Moving keeps each picture’s place in the library: favorites, moodboards, ratings and version links stay with it.')
    }
    return {
      planId,
      destination: dest,
      mode,
      selectedPictures: items.length,
      selectedGroups: keys.length,
      everything: false,
      total: items.length,
      copy: copy.length,
      copyBytes: need,
      skipped: plannedOps.skipped,
      freeBytes: free,
      enoughSpace: enough,
      conflicts: plannedOps.conflicts.slice(0, 200),
      warnings,
      sample: plannedOps.ops.slice(offset, offset + sampleSize).map(({ dest: _d, ...rest }) => rest),
      tree: plannedOps.tree
    }
  }

  /** The destination must be a folder Atlas may write into, and never inside the pictures being organized (that would copy a folder into itself). */
  checkDestination(plan: PlanRow, destination: string): string {
    if (!destination || typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('Choose a destination folder.')
    const dest = resolve(destination)
    const normDest = normalizePath(dest).toLowerCase()
    const roots = this.deps.db.listRoots()
    const covered = plan.scope.rootIds?.length ? roots.filter((r) => plan.scope.rootIds!.includes(r.id)) : plan.scope.all || (!plan.scope.folders?.length && !plan.scope.imageIds?.length) ? roots : []
    for (const root of covered) {
      const r = normalizePath(root.path).toLowerCase()
      if (normDest === r || normDest.startsWith(`${r}\\`) || normDest.startsWith(`${r}/`)) throw new Error(`The destination is inside “${root.name}”, which is part of what is being organized. Choose a folder outside it.`)
    }
    for (const folder of plan.scope.folders ?? []) {
      const r = normalizePath(folder).toLowerCase().replace(/[\\/]+$/, '')
      if (normDest === r || normDest.startsWith(`${r}\\`) || normDest.startsWith(`${r}/`)) throw new Error('The destination is inside a folder that is being organized. Choose a folder outside it.')
    }
    return dest
  }

  // ---- export (copy, with a journal) ------------------------------------------------------------------------------------

  /** Starts copying. Every step is written to the journal first, so an interrupted export can be resumed. */
  async startExport(planId: string, destination: string, options: { verify?: 'size' | 'hash'; mode?: 'copy' | 'move' } = {}): Promise<void> {
    const plan = this.store.plan(planId)
    if (!plan) throw new Error('That organization no longer exists.')
    if (!['ready', 'done', 'cancelled', 'export-paused'].includes(plan.status)) throw new Error('Finish the analysis before exporting.')
    if (this.jobs.has(planId)) return
    const mode: 'copy' | 'move' = options.mode === 'move' ? 'move' : 'copy'
    if ((plan.settings.selection ?? []).length === 0) throw new Error('Nothing is selected. Check the folders you want to copy or move first.')
    const preview = await this.preview(planId, destination, 0, 0, mode)
    if (!preview.enoughSpace) throw new Error(preview.warnings.find((w) => w.startsWith('There is not enough')) ?? 'There is not enough free space.')
    const dest = preview.destination
    mkdirSync(dest, { recursive: true })
    const planned = await planOperations(selectItems(this.itemsOf(planId), plan.settings), plan.settings, dest, this.existing(), (src, dst) => this.identicalFiles(src, dst).catch(() => false))
    if (this.jobs.has(planId)) return
    const renamedTo = new Set(planned.conflicts.map((c) => join(dest, c.renamedTo).toLowerCase()))
    this.store.replaceOps(
      planId,
      planned.ops
        .filter((o) => o.action === 'copy' || o.action === 'skip-same')
        .map((o) => ({ imageId: o.imageId, src: o.from, dst: o.dest, bytes: o.bytes, status: o.action === 'skip-same' ? ('skipped' as const) : ('pending' as const), renamed: renamedTo.has(o.dest.toLowerCase()) }))
    )
    this.store.updatePlan(planId, { settings: { ...plan.settings, exportMode: mode }, destination: dest, verification: mode === 'move' || options.verify === 'hash' ? 'hash' : 'size', status: 'exporting', phase: 'done', done: 0, total: preview.copy, message: mode === 'move' ? 'Moving…' : 'Copying…' })
    this.runExport(planId)
  }

  /** Continues an interrupted or paused export from its journal. */
  resumeExport(planId: string): void {
    const plan = this.store.plan(planId)
    if (!plan || !plan.destination) throw new Error('There is no export to resume.')
    if (this.jobs.has(planId)) return
    this.store.updatePlan(planId, { status: 'exporting', message: 'Copying…' })
    this.runExport(planId)
  }

  pauseExport(planId: string): void {
    this.pauseRequested.add(planId)
    this.jobs.get(planId)?.abort()
  }

  cancelExport(planId: string): void {
    this.pauseRequested.delete(planId)
    this.jobs.get(planId)?.abort()
    const plan = this.store.plan(planId)
    if (plan && (plan.status === 'exporting' || plan.status === 'export-paused')) this.store.updatePlan(planId, { status: 'cancelled', message: 'Cancelled. Completed transfers stay at the destination.' })
  }

  private runExport(planId: string): void {
    const controller = new AbortController()
    this.jobs.set(planId, controller)
    this.pauseRequested.delete(planId)
    void this.copyAll(planId, controller.signal)
      .catch((error: unknown) => {
        const p = this.store.plan(planId)
        if (p) this.report(p, 'failed', 'done', p.done, p.total, error instanceof Error ? error.message : 'The export stopped unexpectedly.')
      })
      .finally(() => {
        this.jobs.delete(planId)
        this.deps.changed?.(planId)
      })
  }

  private async copyAll(planId: string, signal: AbortSignal): Promise<void> {
    const plan = this.store.plan(planId)!
    const verifyHash = plan.verification === 'hash'
    const moving = plan.settings.exportMode === 'move'
    const total = this.store.opCounts(planId)
    const grand = total.pending + total.copied + total.verified + total.failed + total.copying
    let done = total.verified + total.copied + total.failed
    const startedBytes = this.store.opBytes(planId, ['verified', 'copied'])
    let bytes = startedBytes
    for (;;) {
      if (signal.aborted) {
        const p = this.store.plan(planId)!
        if (this.pauseRequested.has(planId)) this.report(p, 'export-paused', 'done', done, grand, 'Paused. Pictures already copied are kept; it continues where it stopped.')
        return
      }
      const batch = this.store.ops(planId, ['pending', 'copying'], 25)
      if (batch.length === 0) break
      for (const op of batch) {
        if (signal.aborted) break
        this.store.setOp(planId, op.seq, 'copying')
        try {
          if (moving) {
            const note = await this.moveOne(op.imageId, op.src, op.dst, op.bytes, op.status === 'copying')
            this.store.setOp(planId, op.seq, 'verified', note ?? undefined)
          } else {
            if (!(op.status === 'copying' && existsSync(op.dst) && await this.identicalFiles(op.src, op.dst))) {
              await this.copyOne(op.src, op.dst, op.bytes, verifyHash)
            }
            this.store.setOp(planId, op.seq, 'verified')
          }
          bytes += op.bytes
        } catch (error) {
          this.store.setOp(planId, op.seq, 'failed', error instanceof Error ? error.message.slice(0, 300) : 'The copy failed.')
        }
        done += 1
        if (done % 10 === 0) this.report(plan, 'exporting', 'done', done, grand, `Copied ${done} of ${grand} (${fmtBytes(bytes)})`)
      }
      await this.yieldLoop()
    }
    const final = this.store.opCounts(planId)
    if (signal.aborted) {
      if (this.pauseRequested.has(planId)) this.report(plan, 'export-paused', 'done', done, grand, 'Paused. Completed transfers are kept.')
      return
    }
    const failed = final.failed
    const last = this.store.plan(planId)!
    const verb = moving ? 'moved' : 'copied'
    this.report(last, 'done', 'done', grand, grand, failed > 0 ? `Finished with ${failed} that could not be ${verb}.` : `Finished: ${final.verified} pictures ${verb} and checked.`)
    await this.writeReport(planId).catch(() => undefined)
  }

  /**
   * One move. The picture keeps its identity in the library (favorites, moodboards, ratings, versions all refer to it), so the record is
   * pointed at the new place instead of being replaced. Order matters and every step can be repeated after an interruption:
   *   1. already moved earlier (the record points at the destination and the original is gone): nothing to do;
   *   2. the file is brought to the destination: renamed on the same drive, copied and compared byte for byte across drives (never overwriting);
   *   3. the library record is updated;
   *   4. only then the original is removed. If that fails the picture is safe at both places and the note says so.
   * Returns a note when something deserves the user's attention.
   */
  private async moveOne(imageId: string, src: string, dst: string, expected: number, recovering: boolean): Promise<string | null> {
    const record = this.deps.db.getImage(imageId)
    const samePlace = (a: string, b: string): boolean => normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase()
    if (!record) throw new Error('The picture is no longer in the library.')
    if (recovering && samePlace(record.path, dst) && existsSync(dst)) {
      return existsSync(src) ? 'The original path is occupied after an interruption. Its file was kept.' : null
    }
    if (!samePlace(record.path, src)) throw new Error('The picture has already moved since the analysis.')
    let st: Awaited<ReturnType<typeof fs.stat>> | null = null
    try {
      st = await fs.stat(src)
    } catch {
      st = null
    }
    if (!st) {
      // The original is gone. If the file is already at the destination at the right size, an interruption came between the move and the
      // library update: finish that update, so the library does not end up pointing at a path that no longer exists.
      const there = existsSync(dst) ? await fs.stat(dst).catch(() => null) : null
      if (!recovering || !there || there.size !== expected || Math.floor(there.mtimeMs) !== record.mtime) throw new Error('The original is no longer where it was.')
      const rootId = this.deps.db.getRootForDestination(dirname(dst))
      this.deps.db.relocateImage(imageId, { path: dst, rootId, bytes: there.size, mtime: Math.floor(there.mtimeMs) })
      return null
    }
    if (st.size !== expected) throw new Error('The original changed since the analysis (its size is different).')
    if (this.deps.db.isPathIndexed(dst, imageId)) throw new Error('The library already has another picture at the destination path.')
    await fs.mkdir(dirname(dst), { recursive: true })
    const sameDrive = parse(src).root.toLowerCase() === parse(dst).root.toLowerCase()
    if (recovering && existsSync(dst)) {
      // An earlier attempt got this far: accept the file only if it is exactly the original.
      const there = await fs.stat(dst)
      if (there.size !== st.size || !(await this.identicalFiles(src, dst))) throw new Error('A different file with this name is already at the destination, so nothing was overwritten.')
    } else if (sameDrive) {
      // Creating a link reserves the destination without replacing a racing file.
      try {
        await fs.link(src, dst)
      } catch (error) {
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await this.copyOne(src, dst, expected, true)
      }
    } else {
      await this.copyOne(src, dst, expected, true)
    }
    const rootId = this.deps.db.getRootForDestination(dirname(dst))
    const info = await fs.stat(dst)
    try {
      this.deps.db.relocateImage(imageId, { path: dst, rootId, bytes: info.size, mtime: Math.floor(info.mtimeMs) })
    } catch (error) {
      throw new Error(`The library could not be updated (${error instanceof Error ? error.message : 'unknown error'}). The source and destination were kept.`)
    }
    try {
      const current = await fs.stat(src)
      if (current.ino !== st.ino || current.mtimeMs !== st.mtimeMs || current.size !== st.size) return 'The source changed during the move. Both files were kept.'
      await fs.unlink(src)
    } catch {
      return 'The picture is safe in its new place and in the library, but the original file could not be removed; it is still at the old place.'
    }
    return null
  }

  /** One copy: to a temporary name, checked, then given its real name. Nothing is ever overwritten, and the original is only read. */
  private async copyOne(src: string, dst: string, expected: number, verifyHash: boolean): Promise<void> {
    let st
    try {
      st = await fs.stat(src)
    } catch {
      throw new Error('The original is no longer where it was.')
    }
    if (st.size !== expected) throw new Error('The original changed since the analysis (its size is different).')
    await fs.mkdir(dirname(dst), { recursive: true })
    const part = join(dirname(dst), `.noema-${randomUUID()}.noema-part`)
    await fs.copyFile(src, part, fsConstants.COPYFILE_EXCL)
    try {
      if ((await fs.stat(part)).size !== st.size) throw new Error('The copy has a different size than the original.')
      if (verifyHash && !(await this.identicalFiles(src, part))) throw new Error('The copy does not match the original (checked byte by byte).')
      await fs.utimes(part, st.atime, st.mtime).catch(() => undefined)
      try {
        await fs.link(part, dst)
      } catch (error) {
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await fs.copyFile(part, dst, fsConstants.COPYFILE_EXCL)
        if (verifyHash && !(await this.identicalFiles(part, dst))) throw new Error('The destination did not pass verification.')
      }
    } finally {
      await fs.rm(part, { force: true })
    }
  }

  /** A small record of what was copied from where, saved next to the pictures. */
  private async writeReport(planId: string): Promise<void> {
    const plan = this.store.plan(planId)
    if (!plan?.destination) return
    const report = this.report2(planId)
    const ops = this.store.ops(planId, ['verified', 'skipped', 'failed', 'copied'])
    const payload = { atlas: 'NOEMA Atlas', note: report.mode === 'move' ? 'Move results are listed for each picture.' : 'Copy results are listed for each picture. Originals were kept.', plan: plan.name, finishedAt: new Date().toISOString(), summary: report, files: ops.map((o) => ({ from: o.src, to: o.dst, bytes: o.bytes, status: o.status, ...(o.error ? { error: o.error } : {}) })) }
    await fs.writeFile(join(plan.destination, 'NOEMA-Atlas-organization.json'), JSON.stringify(payload, null, 1), { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error
      await fs.writeFile(join(plan.destination!, `NOEMA-Atlas-organization-${randomUUID()}.json`), JSON.stringify(payload, null, 1), { flag: 'wx' })
    })
  }

  report2(planId: string): ExportReport {
    const plan = this.store.plan(planId)
    if (!plan) throw new Error('That organization no longer exists.')
    const counts = this.store.opCounts(planId)
    const failures = this.store.ops(planId, ['failed'], 50).map((o) => ({ from: o.src, to: o.dst, error: o.error ?? 'failed' }))
    const total = counts.pending + counts.copying + counts.copied + counts.verified + counts.skipped + counts.failed
    return {
      planId,
      destination: plan.destination ?? '',
      startedAt: plan.createdAt,
      finishedAt: plan.status === 'done' ? plan.updatedAt : null,
      total,
      verified: counts.verified,
      copied: counts.copied + counts.verified,
      skipped: counts.skipped,
      failed: counts.failed,
      bytes: this.store.opBytes(planId, ['verified', 'copied']),
      verification: plan.verification,
      mode: plan.settings.exportMode === 'move' ? 'move' : 'copy',
      moved: plan.settings.exportMode === 'move' ? counts.verified : 0,
      failures,
      renamed: this.store.renamedOps(planId),
      status: plan.status === 'exporting' ? 'running' : plan.status === 'export-paused' ? 'paused' : plan.status === 'cancelled' ? 'cancelled' : plan.status === 'failed' ? 'failed' : 'done'
    }
  }
}

export const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)

async function defaultFreeBytes(path: string): Promise<number | null> {
  // The nearest folder that exists (the destination may not have been created yet).
  let dir = path
  for (let i = 0; i < 12 && !existsSync(dir); i += 1) dir = dirname(dir)
  try {
    const s = await fs.statfs(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

export { categoryKey }
