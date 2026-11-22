import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, dirname, extname, join } from 'node:path'
import sharp from '../safeSharp'
import type { AtlasDatabase } from '../db'
import type { SecretBox } from '../assistant/settings'
import type { ImageItem, RootFolder } from '../../shared/types'
import {
  ASPECTS,
  type ArtworkConcept,
  type ConceptRequest,
  type EditAlternative,
  type PlanResult,
  type PlanStep,
  type EditRegion,
  type EditRequest,
  type ReferenceAspect,
  EDIT_LEVELS,
  DETAIL_SUBJECTS,
  REFERENCE_ASPECTS,
  type ExternalCandidate,
  type ExternalEditSession,
  type ExternalVersion,
  type GenerateRequest,
  type GenerationRecord,
  type ProvenanceInfo,
  type RefRole,
  type StudioEstimate,
  type StudioExternalEditor,
  type StudioMethod,
  type StudioProgress,
  type StudioResult,
  type StudioSettings,
  type UpscaleRequest,
  MAX_UPSCALE_EDGE,
  MAX_UPSCALE_PIXELS,
  type StudioSettingsUpdate,
  type ComfyStatus,
  type RetouchRequest
} from '../../shared/studio'
import { isLoopback } from '../../shared/network'
import { isPathInsideOrEqual } from '../scanner'
import { applyMood, blendArtwork, readMood, seeded } from './blend'
import { ComfyClient, ComfyError, fillWorkflow, standardWorkflow, type FetchFn } from './comfy'
import { ComfyManager, type ManagerSettings } from './comfyManager'
import { bindWorkflow, retargetUpscale, saveNodeIds } from './comfyWorkflows'
import { MAX_DETAIL_EDGE, MAX_EDIT_EDGE, detailSettings, detailUpscaleWorkflow, esrganWorkflow, inpaintWorkflow, isSd15Name, levelParams, pickAtlasModels, subjectFromText, tileEditWorkflow, workingSize } from './atlasWorkflows'
import { buildRegionMask, compositeThroughMask, maskToPng, regionOverlay, type RegionMask } from './regions'
import { isPsdPath, PsdError, readPsdComposite } from './psd'
import { compileReferencePrompt, pickReferenceModels, prepareReference, referenceBudget, referenceCapabilities, referenceSize, referenceWorkflow, type ReferenceInfluence, type ReferencePipeline, type ReferenceView } from './referenceConditioning'
import { blurredCopy, dilate, fillFromSurroundings, healedCopy, maskBox, sharpenedCopy, tonedCopy } from './retouch'
import { describeLook, lookStats, mergeStats, transferLook } from './referenceTransfer'
import { imagePromptFromInstruction } from './editLanguage'
import type { AiPackages } from './aiPackages'
import type { ModelInventory } from './comfyModels'
import type { Capability } from '../../shared/ai'

/** What edits share between their alternatives: the selected region and the reference look. */
interface EditPrep {
  mask: RegionMask | null
  overlay: string | null
  /** The picture the model starts from: the original, or the original moved towards a reference look. */
  init: Buffer
  look: string
  referenceNote: string
}

/** The id of Atlas's own detail upscaling in the upscale choices (user workflows have their own ids). */
export const ATLAS_DETAIL = 'atlas:detail'
import { homedir } from 'node:os'
import { developConcept, type VisualNotes } from './concept'
import { CLOUD_MODELS, CloudImageError, CloudImages, estimateCloudCost } from './openaiImages'

export interface StudioDeps {
  db: AtlasDatabase
  /** Where finished pictures are kept. Becomes a source in Atlas, so they appear in the library like any other image. */
  studioDir: string
  /** Where Atlas keeps its own settings and working copies. */
  dataDir: string
  box: SecretBox
  fetchImpl: FetchFn
  enqueueScan(root: RootFolder): void
  broadcast(channel: string, payload?: unknown): void
  notifyChanged(): void
  /** Everyday-language notes on pictures, from the local image model. Optional. */
  visualNotes?(ids: string[]): Promise<Record<string, VisualNotes>>
  /** Opens a file in the system's default program. */
  openPath?(path: string): Promise<string>
  /** How long to wait for a new picture to be learned by the library. */
  importWaitMs?: number
  /** For tests: a manager with its own file system view and launcher. */
  comfyManager?: ComfyManager
  /** Asks for the user's attention (a flashing taskbar button and a notice) when an edit comes back while Atlas is in the background. */
  attention?(title: string, body: string): void
  /** How often a watched copy is looked at, and how long it must stay unchanged before it is read. Tests make these short. */
  externalPollMs?: number
  externalSettleMs?: number
  /** For tests: the folder that stands for the user's home when looking for a result saved elsewhere. */
  homeDir?: string
}

/** What a program may save back: the picture types Atlas can read, and Photoshop documents (their flattened picture is read). */
/** The model entry that means "give the reference pictures to FLUX.2 [klein]". */
export const REFERENCE_MODEL_ID = 'reference:flux2-klein'
const EXTERNAL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.avif', '.psd', '.psb'])
/** The saved file is not ready yet (still being written); worth trying again shortly. */
class ExternalNotReady extends Error {}
/** The saved file is a kind Atlas cannot read; trying again will not help. */
class ExternalUnsupported extends Error {}

interface Stored {
  comfyFolder: string | null
  comfyAutoStart: boolean
  comfyPython: string | null
  comfyPort: number | null
  comfyArgs: string[]
  comfyWorkflowFolders: string[]
  comfyWorkflowId: string | null
  comfyEditWorkflowId: string | null
  comfyUpscaleWorkflowId: string | null
  approvedComfyUrl: string | null
  comfyUrl: string
  comfyWorkflow: string | null
  cloudModel: string
  monthlyBudget: number
  spent: { month: string; usd: number }
  editors: StudioExternalEditor[]
  editorsDetected: boolean
}

const DEFAULTS: Stored = {
  comfyFolder: null,
  comfyAutoStart: true,
  comfyPython: null,
  comfyPort: null,
  comfyArgs: [],
  comfyWorkflowFolders: [],
  comfyWorkflowId: null,
  comfyEditWorkflowId: null,
  comfyUpscaleWorkflowId: null,
  approvedComfyUrl: null,
  comfyUrl: 'http://127.0.0.1:8188',
  comfyWorkflow: null,
  cloudModel: 'gpt-image-1',
  monthlyBudget: 0,
  spent: { month: '', usd: 0 },
  editors: [],
  editorsDetected: false
}

const monthKey = (): string => new Date().toISOString().slice(0, 7)
const slug = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'untitled'

const FORBIDDEN_ARGS = /^--(listen|port|disable-auto-launch|enable-cors-header|tls-keyfile|tls-certfile|multi-user|windows-standalone-build)(=|$)/i

/** Start options a person may give ComfyUI. Keeps Atlas's own address and port in charge and refuses anything shell-like. */
export function checkLaunchArgs(args: string[]): string[] {
  if (!Array.isArray(args)) throw new Error('Start options must be a list.')
  const out = args.map((a) => String(a).trim()).filter(Boolean)
  if (out.length > 40) throw new Error('That is too many start options.')
  for (const arg of out) {
    if (/[&|<>^%"`;$\r\n]/.test(arg) || arg.length > 300) throw new Error(`The start option “${arg.slice(0, 40)}” has characters Atlas does not allow.`)
    if (FORBIDDEN_ARGS.test(arg)) throw new Error(`Atlas sets “${arg.split('=')[0]}” itself, so it cannot be a start option.`)
  }
  return out
}

/** 5 or 2.5: whole percent, but one decimal below 10 % so a fine setting is not shown as something else. */
function percentText(strength: number): string {
  const p = strength * 100
  return p < 10 && Math.abs(p - Math.round(p)) > 0.04 ? p.toFixed(1) : String(Math.round(p))
}

interface Pending {
  buffer: Buffer
  request: EditRequest
  source: ImageItem
  cost: number
  model: string
  summary: string
  /** What the saved version is called: "edited", "retouched"… */
  suffix?: string
  /** Retouch steps already applied to reach this picture, oldest first (what the saved version says it was made with). */
  steps?: string[]
  /** Summaries of those steps. */
  summaries?: string[]
  /** A finished retouch step the user may still undo to: kept in memory until released, never evicted to make room. */
  held?: boolean
}

interface ExternalWatch {
  session: ExternalEditSession
  timer: NodeJS.Timeout
  source: ImageItem
  /** The folder of the working copy and the name (without extension) that saved files start with. */
  dir: string
  base: string
  /** Files and their size:time as already handled or present at the start. */
  seen: Map<string, string>
  /** Files that changed and are waiting to stay still before they are read. */
  pending: Map<string, { sig: string; since: number }>
  busy: boolean
  sourceHash: string | null
  importedHashes: Set<string>
  lastRecordId: string | null
  failures: Map<string, number>
  stopAt: number
}

/** Composition references come first (they become "image 1"), then the others in the order given. */
function orderReferences<T extends { roles: RefRole[] }>(refs: T[]): T[] {
  return [...refs].sort((a, b) => Number(b.roles.includes('composition')) - Number(a.roles.includes('composition')))
}

/** The Creative Studio: develops concepts from moodboards, makes and edits pictures through modular methods, and remembers lineage. */
export class Studio {
  private data: Stored
  private cloudKey: string | null = null
  private pending = new Map<string, Pending>()
  private watches = new Map<string, ExternalWatch>()
  private localPlanJobs = new Set<string>()
  private controllers = new Map<string, AbortController>()
  private lastMethods: StudioMethod[] | null = null
  private ai: AiPackages | null = null

  constructor(private deps: StudioDeps) {
    mkdirSync(join(deps.dataDir, 'studio'), { recursive: true })
    mkdirSync(deps.studioDir, { recursive: true })
    this.data = this.load()
    this.cloudKey = this.loadKey()
    this.comfyMgr = deps.comfyManager ?? new ComfyManager({ fetchImpl: deps.fetchImpl, appData: process.env.APPDATA, localAppData: process.env.LOCALAPPDATA, home: homedir() })
    this.reloadComfy()
  }

  /** Reads the chosen installation again with the user's Python and workflow folders. */
  private reloadComfy(): void {
    this.comfyMgr.load(this.data.comfyFolder, { python: this.data.comfyPython, workflowFolders: this.data.comfyWorkflowFolders })
  }

  private comfyMgr: ComfyManager

  // ---- settings -----------------------------------------------------------------------------------------------------

  private get settingsPath(): string {
    return join(this.deps.dataDir, 'studio', 'settings.json')
  }
  private get keyPath(): string {
    return join(this.deps.dataDir, 'studio', 'cloud-key.bin')
  }

  private load(): Stored {
    try {
      if (existsSync(this.settingsPath)) {
        const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<Stored>
        return {
          comfyFolder: typeof raw.comfyFolder === 'string' && raw.comfyFolder ? raw.comfyFolder : null,
          comfyAutoStart: raw.comfyAutoStart !== false,
          comfyPython: typeof raw.comfyPython === 'string' && raw.comfyPython ? raw.comfyPython : null,
          comfyPort: Number.isInteger(raw.comfyPort) && Number(raw.comfyPort) > 0 ? Number(raw.comfyPort) : null,
          comfyArgs: Array.isArray(raw.comfyArgs) ? raw.comfyArgs.filter((a): a is string => typeof a === 'string') : [],
          comfyWorkflowFolders: Array.isArray(raw.comfyWorkflowFolders) ? raw.comfyWorkflowFolders.filter((a): a is string => typeof a === 'string') : [],
          comfyWorkflowId: typeof raw.comfyWorkflowId === 'string' ? raw.comfyWorkflowId : null,
          comfyEditWorkflowId: typeof raw.comfyEditWorkflowId === 'string' ? raw.comfyEditWorkflowId : null,
          comfyUpscaleWorkflowId: typeof raw.comfyUpscaleWorkflowId === 'string' ? raw.comfyUpscaleWorkflowId : null,
          approvedComfyUrl: typeof raw.comfyUrl === 'string' && raw.approvedComfyUrl === raw.comfyUrl ? raw.comfyUrl : null,
          comfyUrl: typeof raw.comfyUrl === 'string' && raw.comfyUrl ? raw.comfyUrl : DEFAULTS.comfyUrl,
          comfyWorkflow: typeof raw.comfyWorkflow === 'string' ? raw.comfyWorkflow : null,
          cloudModel: CLOUD_MODELS.includes(raw.cloudModel ?? '') ? raw.cloudModel! : DEFAULTS.cloudModel,
          monthlyBudget: Number.isFinite(raw.monthlyBudget) ? Math.max(0, Number(raw.monthlyBudget)) : 0,
          spent: raw.spent && typeof raw.spent.usd === 'number' ? raw.spent : { month: '', usd: 0 },
          editors: Array.isArray(raw.editors) ? raw.editors.filter((e) => e && typeof e.path === 'string' && typeof e.name === 'string') : [],
          editorsDetected: Boolean(raw.editorsDetected)
        }
      }
    } catch {
      // Fall through to defaults.
    }
    return structuredClone(DEFAULTS)
  }

  private loadKey(): string | null {
    try {
      if (!existsSync(this.keyPath) || !this.deps.box.available()) return null
      return this.deps.box.decrypt(readFileSync(this.keyPath))
    } catch {
      return null
    }
  }

  private save(): void {
    const temp = `${this.settingsPath}.tmp`
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.settingsPath)
  }

  private spentThisMonth(): number {
    return this.data.spent.month === monthKey() ? this.data.spent.usd : 0
  }

  private addSpend(usd: number): void {
    if (usd <= 0) return
    this.data.spent = { month: monthKey(), usd: this.spentThisMonth() + usd }
    this.save()
  }

  update(change: StudioSettingsUpdate): void {
    if (change.comfyFolder !== undefined) {
      if (change.comfyFolder === null || change.comfyFolder === '') {
        this.comfyMgr.stop()
        this.data.comfyFolder = null
        this.data.comfyWorkflowId = null
        this.data.comfyEditWorkflowId = null
        this.data.comfyUpscaleWorkflowId = null
        this.data.comfyPython = null
        this.data.comfyPort = null
        this.data.comfyArgs = []
        this.data.comfyWorkflowFolders = []
        this.comfyMgr.load(null)
      } else {
        this.comfyMgr.load(change.comfyFolder, { workflowFolders: this.data.comfyWorkflowFolders })
        const found = this.comfyMgr.current
        if (!found) {
          const problem = this.comfyMgr.problemNow ?? 'That folder is not a ComfyUI installation.'
          this.reloadComfy()
          throw new Error(problem)
        }
        if (change.comfyFolder !== this.data.comfyFolder) {
          // A new installation: take over how its owner starts it (their start script's port and options) and the
          // workflow folders beside it. All of it is shown in the settings and can be changed or removed.
          const profile = found.profiles[0]
          this.data.comfyPython = null
          this.data.comfyPort = profile?.port ?? null
          this.data.comfyArgs = profile ? profile.args : []
          this.data.comfyWorkflowFolders = found.workflowFolderSuggestions.slice(0, 4)
        }
        this.data.comfyFolder = change.comfyFolder
        this.reloadComfy()
        this.data.comfyWorkflowId = null
        this.data.comfyEditWorkflowId = null
        this.data.comfyUpscaleWorkflowId = null
      }
    }
    if (typeof change.comfyAutoStart === 'boolean') this.data.comfyAutoStart = change.comfyAutoStart
    let launchChanged = false
    if (change.comfyPython !== undefined) {
      if (change.comfyPython) {
        const python = change.comfyPython.trim()
        if (!/\.exe$/i.test(python) || !existsSync(python)) throw new Error('That Python cannot be found. Choose the python.exe inside the ComfyUI virtual environment, for example venv\\Scripts\\python.exe.')
        this.data.comfyPython = python
      } else this.data.comfyPython = null
      launchChanged = true
    }
    if (change.comfyPort !== undefined) {
      if (change.comfyPort === null) this.data.comfyPort = null
      else if (Number.isInteger(change.comfyPort) && change.comfyPort >= 1024 && change.comfyPort <= 65535) this.data.comfyPort = change.comfyPort
      else throw new Error('Choose a port between 1024 and 65535, for example 8189.')
      launchChanged = true
    }
    if (change.comfyArgs !== undefined) {
      this.data.comfyArgs = checkLaunchArgs(change.comfyArgs)
      launchChanged = true
    }
    if (change.comfyWorkflowFolders !== undefined) {
      const folders = change.comfyWorkflowFolders.map((f) => String(f).trim()).filter(Boolean).slice(0, 8)
      for (const folder of folders) if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`The workflow folder “${folder}” cannot be found.`)
      this.data.comfyWorkflowFolders = Array.from(new Set(folders))
      launchChanged = true
    }
    if (typeof change.comfyUseProfile === 'string') {
      const profile = this.comfyMgr.current?.profiles.find((p) => p.file.toLowerCase() === change.comfyUseProfile!.toLowerCase())
      if (!profile) throw new Error('That start script is not one Atlas found beside this ComfyUI.')
      this.data.comfyPort = profile.port
      this.data.comfyArgs = profile.args
      launchChanged = true
    }
    if (launchChanged) this.reloadComfy()
    for (const key of ['comfyWorkflowId', 'comfyEditWorkflowId', 'comfyUpscaleWorkflowId'] as const) {
      const value = change[key]
      if (value === undefined) continue
      if (value !== null && !this.comfyMgr.workflowById(value)) throw new Error('That workflow is not in the list any more. Rescan ComfyUI.')
      this.data[key] = value
    }
    if (typeof change.comfyUrl === 'string') {
      const url = change.comfyUrl.trim()
      if (url && !/^https?:\/\//i.test(url)) throw new Error('Give the address of ComfyUI, such as http://127.0.0.1:8188.')
      const next = url || DEFAULTS.comfyUrl
      if (next !== this.data.comfyUrl) this.data.approvedComfyUrl = null
      this.data.comfyUrl = next
    }
    if (change.approvedComfyUrl !== undefined) {
      this.data.approvedComfyUrl = change.approvedComfyUrl === this.data.comfyUrl ? this.data.comfyUrl : null
    }
    if (change.comfyWorkflow !== undefined) {
      if (change.comfyWorkflow) {
        if (!existsSync(change.comfyWorkflow)) throw new Error('That workflow file cannot be found.')
        try {
          JSON.parse(readFileSync(change.comfyWorkflow, 'utf8'))
        } catch {
          throw new Error('That workflow is not valid. Export it from ComfyUI with “Save (API format)”.')
        }
      }
      this.data.comfyWorkflow = change.comfyWorkflow || null
    }
    if (typeof change.cloudModel === 'string' && CLOUD_MODELS.includes(change.cloudModel)) this.data.cloudModel = change.cloudModel
    if (typeof change.monthlyBudget === 'number' && Number.isFinite(change.monthlyBudget)) this.data.monthlyBudget = Math.max(0, Math.min(1000, change.monthlyBudget))
    if (typeof change.cloudKey === 'string') {
      const key = change.cloudKey.trim()
      if (!key) {
        this.cloudKey = null
        try {
          if (existsSync(this.keyPath)) writeFileSync(this.keyPath, Buffer.alloc(0))
        } catch {
          // Nothing to remove.
        }
      } else {
        if (!this.deps.box.available()) throw new Error('This computer cannot store keys safely, so Atlas will not keep one.')
        writeFileSync(this.keyPath, this.deps.box.encrypt(key), { mode: 0o600 })
        this.cloudKey = key
      }
    }
    if (Array.isArray(change.editors)) {
      this.data.editors = change.editors
        .filter((e) => e && typeof e.name === 'string' && typeof e.path === 'string' && /\.(exe|bat|cmd|app)$/i.test(e.path.trim()) && existsSync(e.path.trim()))
        .slice(0, 8)
        .map((e) => ({ id: e.id || randomUUID().slice(0, 8), name: e.name.trim().slice(0, 40) || basename(e.path), path: e.path.trim() }))
      this.data.editorsDetected = true
    }
    this.save()
    this.lastMethods = null
  }

  // ---- methods ------------------------------------------------------------------------------------------------------

  private managerSettings(): ManagerSettings {
    return {
      folder: this.data.comfyFolder,
      url: this.data.comfyUrl !== DEFAULTS.comfyUrl ? this.data.comfyUrl : null,
      autoStart: this.data.comfyAutoStart,
      python: this.data.comfyPython,
      port: this.data.comfyPort,
      args: this.data.comfyArgs,
      workflowFolders: this.data.comfyWorkflowFolders
    }
  }

  /** Points the Studio at the ComfyUI that Atlas installed itself (called by the installer once it is ready). */
  useManagedRuntime(folder: string, args: string[], port: number): void {
    this.data.comfyFolder = folder
    this.data.comfyPython = null
    this.data.comfyPort = port
    this.data.comfyArgs = args
    this.data.comfyWorkflowFolders = []
    this.data.comfyAutoStart = true
    this.save()
    this.reloadComfy()
    this.lastMethods = null
  }

  /** Reads the installation again after models were added to it. */
  modelsChanged(): void {
    this.reloadComfy()
    this.lastMethods = null
  }

  /** Lets the Studio know how ComfyUI is provided, for plain explanations of what is missing. */
  attachAi(ai: AiPackages): void {
    this.ai = ai
  }

  /**
   * What Atlas can create, edit and upscale right now, and what would add more. The Studio, the companion and the setup
   * screens all read this, so they always agree. It reads the installation's folders; nothing is started.
   */
  async capabilities(): Promise<Capability[]> {
    const methods = await this.methods(false)
    const comfy = methods.find((m) => m.id === 'comfyui')
    const cloud = methods.find((m) => m.id === 'openai')
    const models = pickAtlasModels(this.comfyMgr.inventoryNow)
    const workflows = this.comfyMgr.allWorkflows().filter((w) => w.runnable)
    const comfyUp = Boolean(comfy?.available)
    const mode = this.ai?.mode ?? (this.comfyMgr.current ? 'connect' : 'none')
    const fixHint = mode === 'managed' ? 'Add it from the AI setup.' : mode === 'connect' ? 'Your ComfyUI is missing the models for it. Atlas never changes a ComfyUI that is not its own; add them there, or let Atlas install its own.' : 'Set up AI once from the Studio settings.'
    type Opt = Capability['options'][number]
    const create: Opt[] = []
    const comfyKind = comfy?.leavesComputer ? 'cloud' : 'local'
    if (comfyUp && comfy) create.push({ id: 'comfyui', label: comfy.name, kind: comfyKind, note: comfy.description })
    if (cloud?.available) create.push({ id: 'openai', label: 'OpenAI images (paid)', kind: 'cloud', note: 'Sends your prompt; asks first.' })
    const createAi = create.length > 0
    create.push({ id: 'blend', label: 'Atlas Blend', kind: 'offline', note: 'A colour-and-composition study from your references. No AI model.' })
    const edit: Opt[] = []
    for (const w of workflows.filter((x) => x.kind === 'edit')) edit.push({ id: `workflow:${w.id}`, label: `Your workflow: ${w.name}`, kind: comfyKind, note: 'Runs your own ComfyUI workflow on a copy.' })
    if (comfyUp && models?.tile) edit.push({ id: 'comfy-structure', label: 'ComfyUI, keeping the structure', kind: comfyKind, note: 'Repaints from your description while a tile ControlNet holds the composition.' })
    else if (comfyUp && models) edit.push({ id: 'comfy-repaint', label: 'ComfyUI repaint', kind: comfyKind, note: 'Repaints a copy from your description. Install the Edit package to keep the structure firmly.' })
    if (cloud?.available && cloud.canEdit) edit.push({ id: 'openai', label: 'OpenAI image edit (paid)', kind: 'cloud', note: 'Sends the picture; asks first.' })
    const editAi = edit.length > 0
    edit.push({ id: 'blend', label: 'Atlas Blend (mood and light)', kind: 'offline', note: 'Grades colour and light only. Moves no pixels.' })
    const up: Opt[] = []
    for (const w of workflows.filter((x) => x.kind === 'upscale')) up.push({ id: w.id, label: w.name, kind: comfyKind, note: 'Your own preset, run exactly as tuned.' })
    if (comfyUp && models?.esrgan) up.push({ id: ATLAS_DETAIL, label: 'Atlas detail upscale', kind: comfyKind, note: models.tile ? 'Real-ESRGAN plus a gentle detail pass.' : 'Real-ESRGAN enlargement.' })
    const upAi = up.length > 0
    up.push({ id: '', label: 'Plain enlarge', kind: 'offline', note: 'Smooth resampling. Adds no new detail.' })
    const refModels = pickReferenceModels(this.comfyMgr.inventoryNow)
    const refOpts: Opt[] = []
    if (comfyUp && refModels) refOpts.push({ id: 'flux2-klein', label: 'FLUX.2 [klein] with your reference pictures', kind: comfyKind, note: 'The pictures themselves are given to the selected ComfyUI server.' })
    if (cloud?.available && cloud.canEdit) refOpts.push({ id: 'openai', label: 'OpenAI image editing with several pictures (paid)', kind: 'cloud', note: 'Sends the pictures; asks first.' })
    const refAi = refOpts.length > 0
    refOpts.push({ id: 'blend', label: 'Atlas Blend (light, colour, composition study)', kind: 'offline', note: 'No model: combines their light and colour. Invents nothing.' })
    return [
      { id: 'reference', label: 'Use reference pictures', ready: refAi, how: refAi ? refOpts[0]!.label : null, options: refOpts, missing: refAi ? null : `Giving your pictures themselves to an image model needs FLUX.2 [klein] (an optional download of about 16 GB). Atlas Blend still combines their light and colour. ${fixHint}`, offer: refAi ? null : 'reference' },
      { id: 'create', label: 'Create pictures', ready: createAi, how: createAi ? create[0]!.label : null, options: create, missing: createAi ? null : `No AI picture maker is set up yet. Atlas Blend still works, but it cannot invent new subjects. ${fixHint}`, offer: createAi ? null : 'create' },
      { id: 'edit', label: 'Edit pictures', ready: editAi, how: editAi ? edit[0]!.label : null, options: edit, missing: editAi ? null : `AI editing is not set up yet. Atlas Blend can still change mood and light. ${fixHint}`, offer: editAi ? null : 'edit' },
      { id: 'upscale', label: 'Creative upscaling', ready: upAi, how: upAi ? up[0]!.label : null, options: up, missing: upAi ? null : `Detail-adding upscaling is not set up yet. A plain enlargement is available. ${fixHint}`, offer: upAi ? null : 'upscale' }
    ]
  }

  /** What the AI Model Library needs to know about ComfyUI. Read-only. */
  modelLibraryView(): { inventory: ModelInventory | null; kind: 'managed' | 'local' | 'remote' | 'none'; folder: string | null; dataFolder: string | null; version: string | null; note: string | null } {
    const install = this.comfyMgr.current
    if (this.ai?.mode === 'managed') return { inventory: this.comfyMgr.inventoryNow, kind: 'managed', folder: install?.folder ?? null, dataFolder: install?.dataFolder ?? null, version: install?.version ?? null, note: null }
    if (install) return { inventory: this.comfyMgr.inventoryNow, kind: 'local', folder: install.folder, dataFolder: install.dataFolder, version: install.version ?? null, note: null }
    if (this.data.comfyUrl !== DEFAULTS.comfyUrl) return { inventory: null, kind: 'remote', folder: null, dataFolder: null, version: null, note: `Connected over the network to ${this.data.comfyUrl}.` }
    return { inventory: null, kind: 'none', folder: null, dataFolder: null, version: null, note: null }
  }

  /** Model file names of a ComfyUI that is not on this computer, asked through its API (read-only). Null when unreachable. */
  async remoteModelNames(): Promise<string[] | null> {
    try {
      return await new ComfyClient(this.data.comfyUrl, this.deps.fetchImpl).modelNames()
    } catch {
      return null
    }
  }

  /** The state of ComfyUI for the settings panel. Changes nothing. */
  async comfyStatus(): Promise<ComfyStatus> {
    return this.comfyMgr.status(this.managerSettings(), this.comfyMgr.workflowById(this.data.comfyWorkflowId))
  }

  /** Starts (or connects to) ComfyUI now, when the user asks. */
  async comfyStart(): Promise<ComfyStatus> {
    await this.comfyMgr.connect(this.managerSettings(), (message) => this.deps.broadcast('studio:comfy-progress', { message }))
    return this.comfyStatus()
  }

  /** Stops ComfyUI, but only if Atlas started it. */
  async comfyStop(): Promise<ComfyStatus> {
    await this.comfyMgr.stopAndWait()
    return this.comfyStatus()
  }

  comfyRescan(): Promise<ComfyStatus> {
    this.reloadComfy()
    return this.comfyStatus()
  }

  /** A client for a running ComfyUI: connects to the one that is running, or starts it when allowed. */
  private async comfy(jobId?: string, signal?: AbortSignal): Promise<ComfyClient> {
    const settings = this.managerSettings()
    if (!this.comfyMgr.current) {
      // No installation chosen: the old way, a ComfyUI the user started themselves.
      const legacy = new ComfyClient(this.data.comfyUrl, this.deps.fetchImpl)
      if (await legacy.ping()) return this.comfyJobClient(legacy.baseUrl, jobId)
    }
    const connection = await this.comfyMgr.connect(settings, (message) => {
      if (jobId) this.progress(jobId, { stage: 'working', message, fraction: null, done: 0, total: 1 })
    }, signal)
    return this.comfyJobClient(connection.url, jobId)
  }

  private comfyJobClient(url: string, jobId?: string): ComfyClient {
    return new ComfyClient(url, (target, init) => {
      if (!isLoopback(url) && (this.data.approvedComfyUrl !== url || (jobId && this.localPlanJobs.has(jobId)))) {
        throw new ComfyError('This job needs permission to send pictures and prompts to the selected ComfyUI server. Check the address in Advanced ComfyUI settings. Local-only plans cannot use a network server.')
      }
      return this.deps.fetchImpl(target, { ...init, redirect: 'error' })
    })
  }

  /** Whether and how ComfyUI can be used right now: models and workflows come from the installation's folders, so no start is needed to know. */
  private async comfyMethod(): Promise<StudioMethod> {
    const remote = !isLoopback(this.data.comfyUrl)
    const base = {
      id: 'comfyui' as const,
      name: remote ? 'Network ComfyUI' : 'ComfyUI on this computer',
      kind: remote ? 'cloud' as const : 'local' as const,
      description: remote ? `This server can receive prompts and pictures: ${this.data.comfyUrl}` : 'Real AI image making with your own models and workflows, free and private. Atlas starts ComfyUI for you when it is needed. Everything stays on this computer.',
      canGenerate: true,
      canEdit: true,
      leavesComputer: remote,
      costPerImage: null
    }
    const selected = this.comfyMgr.workflowById(this.data.comfyWorkflowId)
    const install = this.comfyMgr.current
    if (this.data.comfyWorkflow) {
      return { ...base, available: await this.comfyReachable(), reason: (await this.comfyReachable()) ? null : 'ComfyUI is not running, and no ComfyUI folder is chosen. Choose it once in the Studio settings.', models: ['Your workflow'], model: 'Your workflow' }
    }
    if (!install) {
      // Not set up. A ComfyUI that happens to be running still works, as before.
      const legacy = new ComfyClient(this.data.comfyUrl, this.deps.fetchImpl)
      if (await legacy.ping()) {
        try {
          const checkpoints = await legacy.checkpoints()
          return { ...base, available: checkpoints.length > 0, reason: checkpoints.length > 0 ? null : 'ComfyUI is running but has no checkpoint models. Choose your ComfyUI folder in the Studio settings so Atlas can also use your workflows.', models: checkpoints, model: checkpoints[0] ?? '' }
        } catch {
          return { ...base, available: false, reason: 'ComfyUI is running, but Atlas could not read its models.', models: [], model: '' }
        }
      }
      return { ...base, available: false, reason: 'Set up ComfyUI once: choose its folder in the Studio settings. After that Atlas starts it by itself.', models: [], model: '' }
    }
    const inventory = this.comfyMgr.inventoryNow
    const ready = this.comfyMgr.allWorkflows().filter((w) => w.runnable && w.kind === 'generate')
    const models: string[] = []
    const labels: Record<string, string> = {}
    for (const w of ready) {
      models.push(`workflow:${w.id}`)
      labels[`workflow:${w.id}`] = `Workflow: ${w.name}`
    }
    // FLUX.2 [klein]: the model that is given the reference pictures themselves (see referenceConditioning.ts).
    if (pickReferenceModels(inventory)) {
      models.push(REFERENCE_MODEL_ID)
      labels[REFERENCE_MODEL_ID] = 'FLUX.2 [klein]: uses your reference pictures'
    }
    for (const name of inventory?.byCategory.checkpoints ?? []) models.push(name)
    const needs = this.comfyMgr.needs(selected)
    const available = models.length > 0 && !install.launchProblem
    let model = ''
    if (selected?.runnable && selected.kind === 'generate') model = `workflow:${selected.id}`
    else model = (inventory?.byCategory.checkpoints[0]) ?? models[0] ?? ''
    return { ...base, available, reason: available ? null : (install.launchProblem ?? needs[0] ?? 'ComfyUI has nothing Atlas can use yet.'), models, model, modelLabels: labels }
  }

  private async comfyReachable(): Promise<boolean> {
    return Boolean(await this.comfyMgr.probe(this.managerSettings())) || Boolean(this.comfyMgr.current)
  }

  async methods(refresh = true): Promise<StudioMethod[]> {
    if (!refresh && this.lastMethods) return this.lastMethods
    const blend: StudioMethod = {
      id: 'blend',
      name: 'Atlas Blend',
      kind: 'offline',
      description: 'Works anywhere, no AI model. Combines the composition, colours and atmosphere of your pictures into a new colour-and-composition study. It does not invent new subjects.',
      available: true,
      reason: null,
      canGenerate: true,
      canEdit: true,
      leavesComputer: false,
      costPerImage: null,
      models: [],
      model: ''
    }
    const comfy = await this.comfyMethod()
    const hasKey = Boolean(this.cloudKey)
    const budgetOn = this.data.monthlyBudget > 0
    const cloud: StudioMethod = {
      id: 'openai',
      name: 'OpenAI images (cloud, optional)',
      kind: 'cloud',
      description: 'Paid cloud image making. Your prompt is sent to OpenAI; for edits, the picture is sent too. Atlas asks every time and keeps to your monthly limit.',
      available: hasKey && budgetOn,
      reason: !hasKey ? 'Add an OpenAI key in the Studio settings to use this.' : !budgetOn ? 'Set a monthly limit above zero to allow paid image making.' : null,
      canGenerate: true,
      canEdit: true,
      leavesComputer: true,
      costPerImage: estimateCloudCost(this.data.cloudModel, 1024, 1024),
      models: CLOUD_MODELS,
      model: this.data.cloudModel
    }
    this.lastMethods = [blend, comfy, cloud]
    return this.lastMethods
  }

  async settings(): Promise<StudioSettings> {
    if (!this.data.editorsDetected) {
      this.data.editors = detectEditors()
      this.data.editorsDetected = true
      this.save()
    }
    return {
      methods: await this.methods(true),
      comfy: await this.comfyStatus(),
      comfyFolder: this.data.comfyFolder,
      comfyAutoStart: this.data.comfyAutoStart,
      comfyPython: this.data.comfyPython,
      comfyPort: this.data.comfyPort,
      comfyArgs: this.data.comfyArgs,
      comfyWorkflowFolders: this.data.comfyWorkflowFolders,
      comfyWorkflowId: this.data.comfyWorkflowId,
      comfyEditWorkflowId: this.data.comfyEditWorkflowId,
      comfyUpscaleWorkflowId: this.data.comfyUpscaleWorkflowId,
      comfyUrl: this.data.comfyUrl,
      approvedComfyUrl: this.data.approvedComfyUrl,
      comfyWorkflow: this.data.comfyWorkflow,
      cloudKeySet: Boolean(this.cloudKey),
      cloudModel: this.data.cloudModel,
      monthlyBudget: this.data.monthlyBudget,
      spentThisMonth: Math.round(this.spentThisMonth() * 1000) / 1000,
      editors: this.data.editors,
      studioFolder: this.deps.studioDir
    }
  }

  estimate(methodId: StudioMethod['id'], model: string | undefined, count: number, width: number, height: number): StudioEstimate {
    const n = Math.max(1, Math.min(8, Math.round(count)))
    if (methodId === 'comfyui' && !isLoopback(this.data.comfyUrl)) {
      return { count: n, costUsd: 0, free: true, leavesComputer: true, overBudget: false, message: `Atlas sends the job and any input pictures to ${this.data.comfyUrl}. Atlas charges nothing.` }
    }
    if (methodId !== 'openai') {
      return { count: n, costUsd: 0, free: true, leavesComputer: false, overBudget: false, message: methodId === 'blend' ? 'Free, and nothing leaves this computer.' : 'Free, and nothing leaves this computer. Time depends on your graphics card.' }
    }
    const each = estimateCloudCost(model ?? this.data.cloudModel, width, height)
    const cost = Math.round(each * n * 1000) / 1000
    const over = this.data.monthlyBudget <= 0 || this.spentThisMonth() + cost > this.data.monthlyBudget + 1e-9
    return {
      count: n,
      costUsd: cost,
      free: false,
      leavesComputer: true,
      overBudget: over,
      message: over
        ? this.data.monthlyBudget <= 0
          ? 'Paid image making is switched off. Set a monthly limit to allow it.'
          : `This would go over your monthly limit ($${this.spentThisMonth().toFixed(2)} of $${this.data.monthlyBudget.toFixed(2)} used).`
        : `About $${cost.toFixed(2)} for ${n} picture${n === 1 ? '' : 's'}. Your prompt is sent to OpenAI. This month: $${this.spentThisMonth().toFixed(2)} of $${this.data.monthlyBudget.toFixed(2)}.`
    }
  }

  // ---- concepts -----------------------------------------------------------------------------------------------------

  async concept(request: ConceptRequest): Promise<ArtworkConcept> {
    const board = this.deps.db.getMoodboard(request.moodboardId)
    if (!board) throw new Error('That moodboard no longer exists.')
    const images = board.images.filter((i) => !i.missing)
    if (images.length === 0) throw new Error('The moodboard has no pictures yet. Add some, then ask Atlas to create from it.')
    let notes: Record<string, VisualNotes> = {}
    try {
      notes = (await this.deps.visualNotes?.(images.map((i) => i.id))) ?? {}
    } catch {
      notes = {}
    }
    return developConcept(request, images, notes, board.name)
  }

  // ---- saving pictures into the library ------------------------------------------------------------------------------

  private ensureRoot(): RootFolder {
    // If the user already has a source that contains the studio folder, use it instead of adding an overlapping one.
    const covering = this.deps.db.listRoots().find((r) => isPathInsideOrEqual(r.path, this.deps.studioDir))
    return covering ?? this.deps.db.addRoot(this.deps.studioDir)
  }

  private async waitForImage(path: string): Promise<string | null> {
    const root = this.ensureRoot()
    const deadline = Date.now() + (this.deps.importWaitMs ?? 60_000)
    while (Date.now() < deadline) {
      const row = this.deps.db.getImageByPath(path)
      if (row) return row.id
      this.deps.enqueueScan(root)
      await new Promise((r) => setTimeout(r, 700))
    }
    return this.deps.db.getImageByPath(path)?.id ?? null
  }

  private async writePicture(buffer: Buffer, dir: string, base: string): Promise<{ path: string; width: number; height: number }> {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${base}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}.png`)
    const meta = await sharp(buffer).metadata()
    writeFileSync(path, buffer, { flag: 'wx' })
    return { path, width: meta.width ?? 0, height: meta.height ?? 0 }
  }

  private insertRecord(record: Omit<GenerationRecord, 'id' | 'createdAt'> & { path: string }): GenerationRecord {
    const id = randomUUID()
    const createdAt = Date.now()
    this.deps.db
      .raw()
      .prepare(
        `INSERT INTO generations(id, kind, image_id, image_path, title, moodboard_id, moodboard_name, source_image_ids, roles, prompt, negative, method_id, model, seed, width, height, cost_usd, parent_id, series_id, note, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, record.kind, record.imageId, record.path, record.title, record.moodboardId, record.moodboardName, JSON.stringify(record.sourceImageIds), JSON.stringify(record.roles), record.prompt, record.negative, record.methodId, record.model, record.seed, record.width, record.height, record.costUsd, record.parentId, record.seriesId, record.note, createdAt)
    const { path: _path, ...rest } = record
    void _path
    return { ...rest, id, createdAt }
  }

  private rowToRecord(row: Record<string, unknown>): GenerationRecord {
    const parse = <T>(text: unknown, fallback: T): T => {
      try {
        return JSON.parse(String(text)) as T
      } catch {
        return fallback
      }
    }
    return {
      id: String(row.id),
      kind: row.kind as GenerationRecord['kind'],
      imageId: (row.image_id as string | null) ?? null,
      title: String(row.title ?? ''),
      moodboardId: (row.moodboard_id as string | null) ?? null,
      moodboardName: String(row.moodboard_name ?? ''),
      sourceImageIds: parse<string[]>(row.source_image_ids, []),
      roles: parse<Record<string, RefRole[]>>(row.roles, {}),
      prompt: String(row.prompt ?? ''),
      negative: String(row.negative ?? ''),
      methodId: String(row.method_id),
      model: String(row.model ?? ''),
      seed: row.seed === null || row.seed === undefined ? null : Number(row.seed),
      width: Number(row.width ?? 0),
      height: Number(row.height ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      parentId: (row.parent_id as string | null) ?? null,
      seriesId: (row.series_id as string | null) ?? null,
      note: String(row.note ?? ''),
      createdAt: Number(row.created_at)
    }
  }

  generations(moodboardId?: string): GenerationRecord[] {
    const rows = moodboardId
      ? this.deps.db.raw().prepare('SELECT * FROM generations WHERE moodboard_id = ? ORDER BY created_at DESC LIMIT 200').all(moodboardId)
      : this.deps.db.raw().prepare('SELECT * FROM generations ORDER BY created_at DESC LIMIT 200').all()
    return (rows as Array<Record<string, unknown>>).map((r) => this.rowToRecord(r))
  }

  provenance(imageId: string): ProvenanceInfo | null {
    const row = this.deps.db.raw().prepare('SELECT * FROM generations WHERE image_id = ? ORDER BY created_at DESC LIMIT 1').get(imageId) as Record<string, unknown> | undefined
    if (!row) return null
    const record = this.rowToRecord(row)
    const sources = this.deps.db
      .getImagesByIds(record.sourceImageIds)
      .map((i) => ({ id: i.id, thumbUrl: i.thumbUrl, filename: i.filename, roles: record.roles[i.id] ?? [] }))
    const series = record.seriesId
      ? (this.deps.db.raw().prepare('SELECT * FROM generations WHERE series_id = ? ORDER BY created_at ASC').all(record.seriesId) as Array<Record<string, unknown>>).map((r) => this.rowToRecord(r))
      : [record]
    return { record, sources, series }
  }

  // ---- generating ----------------------------------------------------------------------------------------------------

  private progress(jobId: string | undefined, p: Omit<StudioProgress, 'jobId'>): void {
    if (jobId) this.deps.broadcast('studio:progress', { jobId, ...p } satisfies StudioProgress)
  }

  stop(jobId: string): void {
    this.controllers.get(jobId)?.abort()
  }

  private checkApproval(methodId: StudioMethod['id'], cost: number, approvedCost: number, approvedUpload: boolean, estimate: StudioEstimate): void {
    if (methodId === 'comfyui' && estimate.leavesComputer && !approvedUpload) throw new Error('Confirm sending this job to the selected ComfyUI server.')
    if (methodId !== 'openai') return
    if (!approvedUpload) throw new Error('Please confirm that you agree to send this to the cloud service.')
    if (estimate.overBudget) throw new Error(estimate.message)
    if (cost > approvedCost + 1e-6) throw new Error(`The price is now about $${cost.toFixed(2)}, more than the $${approvedCost.toFixed(2)} you approved. Please review and approve it again.`)
  }

  private refsFor(request: GenerateRequest): Array<{ image: ImageItem; roles: RefRole[] }> {
    const ids = Object.keys(request.roles)
    const items = this.deps.db.getImagesByIds(ids)
    const byId = new Map(items.map((i) => [i.id, i]))
    return ids.flatMap((id) => (byId.get(id) && !byId.get(id)!.missing ? [{ image: byId.get(id)!, roles: request.roles[id] ?? [] }] : []))
  }

  async generate(request: GenerateRequest): Promise<StudioResult> {
    const jobId = request.jobId ?? randomUUID()
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const count = Math.max(1, Math.min(8, Math.round(request.count || 1)))
    const width = Math.max(256, Math.min(2048, Math.round(request.width)))
    const height = Math.max(256, Math.min(2048, Math.round(request.height)))
    const prompt = request.prompt.trim()
    try {
      if (!prompt) throw new Error('Write or develop a prompt first.')
      const methods = await this.methods(true)
      const method = methods.find((m) => m.id === request.methodId)
      if (!method || !method.canGenerate) throw new Error('That way of making pictures is not available.')
      if (!method.available) throw new Error(method.reason ?? 'That way of making pictures is not available right now.')
      const model = request.model || method.model
      const estimate = this.estimate(request.methodId, model, count, width, height)
      this.checkApproval(request.methodId, estimate.costUsd, request.approvedCost, request.approvedUpload, estimate)

      const board = request.moodboardId ? this.deps.db.getMoodboard(request.moodboardId) : null
      const refs = this.refsFor(request)
      const parent = request.parentId ? this.generations().find((g) => g.id === request.parentId) ?? null : null
      const parentImage = parent?.imageId ? this.deps.db.getImage(parent.imageId) : null
      const seriesId = request.seriesId ?? parent?.seriesId ?? randomUUID()
      const baseSeed = Number.isFinite(request.seed) ? Math.floor(request.seed!) : Math.floor(seeded(Date.now() & 0xffffffff)() * 2 ** 31)
      const records: GenerationRecord[] = []
      this.progress(jobId, { stage: 'preparing', message: 'Getting ready…', fraction: 0, done: 0, total: count })

      for (let n = 0; n < count; n += 1) {
        if (controller.signal.aborted) throw new Error('Stopped.')
        const seed = baseSeed + n * 7919
        this.progress(jobId, { stage: 'working', message: count > 1 ? `Making picture ${n + 1} of ${count}…` : 'Making your picture…', fraction: n / count, done: n, total: count })
        const noteBox = { text: '' }
        const buffers = await this.makeOne({ request, method, model, prompt, width, height, seed, refs, parentImage, controller, jobId, n, count, noteBox })
        this.progress(jobId, { stage: 'saving', message: 'Saving into your library…', fraction: (n + 0.9) / count, done: n, total: count })
        for (const buffer of buffers.slice(0, 1)) {
          const saved = await this.writePicture(buffer, join(this.deps.studioDir, slug(board?.name ?? 'studio')), slug(request.title || 'artwork'))
          const imageId = await this.waitForImage(saved.path)
          const perImage = request.methodId === 'openai' ? estimateCloudCost(model, width, height) : 0
          const record = this.insertRecord({
            kind: 'generation',
            path: saved.path,
            imageId,
            title: request.title.trim().slice(0, 120) || 'Untitled',
            moodboardId: board?.id ?? null,
            moodboardName: board?.name ?? '',
            sourceImageIds: refs.map((r) => r.image.id),
            roles: Object.fromEntries(refs.map((r) => [r.image.id, r.roles])),
            prompt,
            negative: request.negative,
            methodId: request.methodId,
            model,
            seed,
            width: saved.width,
            height: saved.height,
            costUsd: perImage,
            parentId: parent?.id ?? null,
            seriesId,
            note: noteBox.text
          })
          this.addSpend(perImage)
          records.push(record)
          this.deps.notifyChanged()
          this.progress(jobId, { stage: 'working', message: `Picture ${n + 1} is in your library.`, fraction: (n + 1) / count, done: n + 1, total: count })
        }
      }
      this.progress(jobId, { stage: 'done', message: 'Finished.', fraction: 1, done: records.length, total: count })
      return { ok: true, message: records.length === 1 ? 'Your picture is ready.' : `${records.length} pictures are ready.`, records }
    } catch (error) {
      const message = controller.signal.aborted ? 'Stopped.' : friendly(error)
      this.progress(jobId, { stage: 'failed', message, fraction: null, done: 0, total: count })
      return { ok: false, message, records: [] }
    } finally {
      this.controllers.delete(jobId)
    }
  }

  private async makeOne(ctx: {
    request: GenerateRequest
    method: StudioMethod
    model: string
    prompt: string
    width: number
    height: number
    seed: number
    refs: Array<{ image: ImageItem; roles: RefRole[] }>
    parentImage: ImageItem | null
    controller: AbortController
    jobId: string
    n: number
    count: number
    /** One sentence about how the references were used; kept with the picture. */
    noteBox: { text: string }
  }): Promise<Buffer[]> {
    const { request, method, model, prompt, width, height, seed, refs, parentImage, controller } = ctx
    if (method.id === 'blend') {
      const blendRefs = refs.map((r) => ({ path: r.image.path, roles: r.roles }))
      // A variation grows out of its parent: the parent supplies the composition, the references keep colour and atmosphere.
      if (parentImage) {
        for (const r of blendRefs) r.roles = r.roles.filter((role) => role !== 'composition')
        blendRefs.unshift({ path: parentImage.path, roles: ['composition'] })
      }
      if (blendRefs.length === 0) throw new Error('Atlas Blend needs reference pictures. Choose a moodboard with pictures, or use another method.')
      return [await blendArtwork({ refs: blendRefs, width, height, seed, mood: `${prompt} ${request.negative ? '' : ''}`, strength: request.strength ?? 0.6 })]
    }
    if (method.id === 'comfyui') {
      const client = await this.comfy(ctx.jobId, controller.signal)
      const startFrom = parentImage ?? refs.find((r) => r.roles.includes('composition'))?.image ?? null
      let workflow
      let outputNodes: string[] | undefined
      const chosen = model.startsWith('workflow:') ? this.comfyMgr.workflowById(model.slice('workflow:'.length)) : null
      const refModels = pickReferenceModels(this.comfyMgr.inventoryNow)
      // The reference pictures themselves go to FLUX.2 [klein] when it is installed, unless the user chose a workflow, a checkpoint or "description only".
      const explicit = ctx.request.model && ctx.request.model !== REFERENCE_MODEL_ID
      if (refModels && !chosen && !this.data.comfyWorkflow && !explicit && ctx.request.referenceMode !== 'description' && (refs.length > 0 || parentImage || ctx.request.referenceMode === 'images') && (model === REFERENCE_MODEL_ID || !ctx.request.model || ctx.request.referenceMode === 'images')) {
        const made = await this.makeWithReferences(ctx, client, refModels)
        ctx.noteBox.text = made.note
        return made.buffers
      }
      if (chosen) {
        const api = await this.comfyMgr.prepare(chosen, client.baseUrl)
        const wantsImage = Object.values(api).some((n) => n.class_type === 'LoadImage')
        if (wantsImage && !startFrom) throw new Error(`“${chosen.name}” starts from a picture. Give one reference the role “composition”, or refine a picture you already made.`)
        const uploaded = wantsImage && startFrom ? await client.upload(startFrom.path) : undefined
        const bound = bindWorkflow(api, { prompt, negative: request.negative, seed, width, height, image: uploaded, denoise: request.strength ?? 0.7 })
        if (!bound.bound.prompt) throw new Error(`Atlas could not find where the description goes in “${chosen.name}”. Choose another workflow, or export this one from ComfyUI with Save (API format) and use the {{prompt}} placeholder.`)
        workflow = bound.workflow
        outputNodes = saveNodeIds(workflow)
      } else if (this.data.comfyWorkflow) {
        const template = JSON.parse(readFileSync(this.data.comfyWorkflow, 'utf8')) as unknown
        const wantsImage = JSON.stringify(template).includes('{{image}}')
        const uploaded = wantsImage && startFrom ? await client.upload(startFrom.path) : ''
        workflow = fillWorkflow(template, { prompt, negative: request.negative, seed, width, height, checkpoint: model, image: uploaded, denoise: request.strength ?? 0.7 })
      } else {
        if (!model) throw new Error(this.comfyMgr.needs(null)[0] ?? 'ComfyUI has no model Atlas can use yet.')
        const uploaded = parentImage ? await client.upload(parentImage.path) : undefined
        // Stable Diffusion 1.5 models are trained at about 512 to 768 pixels; larger canvases repeat subjects. Make it at their size, then enlarge.
        const dims = isSd15Name(model) ? workingSize(width, height, 768) : { width, height }
        workflow = standardWorkflow({ checkpoint: model, prompt, negative: request.negative, seed, width: dims.width, height: dims.height, image: uploaded, denoise: request.strength ?? 0.65 })
      }
      return client.run({
        workflow,
        outputNodes,
        signal: controller.signal,
        onWait: (seconds) => this.progress(ctx.jobId, { stage: 'working', message: `ComfyUI is working… ${seconds}s`, fraction: null, done: ctx.n, total: ctx.count })
      })
    }
    const key = this.cloudKey
    if (!key) throw new Error('Add an OpenAI key in the Studio settings first.')
    const cloud = new CloudImages('https://api.openai.com/v1', key, this.deps.fetchImpl)
    if (refs.length > 0 && !model.startsWith('dall-e') && request.referenceMode === 'images') {
      // Pictures leave this computer only when the user chose to use them as images (never in automatic mode), and agreed to the upload and the price.
      const ordered = orderReferences(refs)
      const items = ordered.map((r) => ({ roles: r.roles, influence: (request.influence?.[r.image.id] ?? 'balanced') as ReferenceInfluence }))
      const images = await Promise.all(ordered.slice(0, 4).map((r) => sharp(r.image.path, { failOn: 'none' }).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()))
      ctx.noteBox.text = `The cloud service was given ${images.length} reference picture${images.length === 1 ? '' : 's'} (${ordered.slice(0, 4).map((r, i) => `image ${i + 1}: ${r.roles.join(' + ') || 'atmosphere'}`).join('; ')}).`
      return cloud.edit({ model, prompt: compileReferencePrompt(prompt, items.slice(0, 4)), image: images[0]!, images, width, height, signal: controller.signal })
    }
    return cloud.generate({ model, prompt, width, height, count: 1, signal: controller.signal })
  }

  /** Creates a new picture while FLUX.2 [klein] looks at the reference pictures themselves. */
  private async makeWithReferences(ctx: { request: GenerateRequest; prompt: string; width: number; height: number; seed: number; refs: Array<{ image: ImageItem; roles: RefRole[] }>; parentImage: ImageItem | null; controller: AbortController; jobId: string; n: number; count: number }, client: ComfyClient, models: NonNullable<ReturnType<typeof pickReferenceModels>>): Promise<{ buffers: Buffer[]; note: string }> {
    const { request, refs, parentImage } = ctx
    // A variation grows out of its parent: the parent is image 1 (composition and subject), the references follow.
    const list: Array<{ image: ImageItem; roles: RefRole[]; influence: ReferenceInfluence }> = []
    if (parentImage) list.push({ image: parentImage, roles: ['composition', 'subject'], influence: 'strong' })
    for (const r of orderReferences(refs)) {
      const roles = parentImage ? r.roles.filter((x) => x !== 'composition') : r.roles
      list.push({ image: r.image, roles: roles.length ? roles : ['atmosphere'], influence: (request.influence?.[r.image.id] ?? 'balanced') as ReferenceInfluence })
    }
    const used = list.slice(0, 4)
    const size = referenceSize(ctx.width, ctx.height)
    // Each reference is shown for what it is for (a layout sketch, a study of light and colour, a material swatch, or the picture itself).
    const views: ReferenceView[] = []
    const uploaded: string[] = []
    for (const [i, u] of used.entries()) {
      const prepared = await prepareReference(u.image.path, u.roles, u.influence, referenceBudget(used.length, u.influence))
      views.push(prepared.view)
      uploaded.push(await client.uploadBuffer(prepared.png, `ref-${i + 1}-${prepared.view}.png`))
    }
    const prompt = compileReferencePrompt(ctx.prompt, used.map((u, i) => ({ roles: u.roles, influence: u.influence, view: views[i] })))
    const graph = referenceWorkflow({ models, images: uploaded, prompt, seed: ctx.seed, width: size.width, height: size.height, refMegapixels: 2 })
    this.progress(ctx.jobId, { stage: 'working', message: 'FLUX.2 [klein] is looking at your pictures…', fraction: null, done: ctx.n, total: ctx.count })
    const buffers = await client.run({ workflow: graph, outputNodes: saveNodeIds(graph), signal: ctx.controller.signal, onWait: (s) => this.progress(ctx.jobId, { stage: 'working', message: `FLUX.2 [klein] is painting… ${s}s`, fraction: null, done: ctx.n, total: ctx.count }) })
    const parts = used.map((u, i) => `image ${i + 1} (${u.image.filename}): ${u.roles.join(' + ')}, ${u.influence}${views[i] && views[i] !== 'original' ? `, shown to the model as ${views[i] === 'layout' ? 'a layout sketch' : views[i] === 'light' ? 'a study of light and colour' : 'a material swatch'}` : ''}`)
    return { buffers, note: `Made with FLUX.2 [klein], which was given the reference pictures themselves: ${parts.join('; ')}. Prompt given to the model: “${prompt}”` }
  }

  /** Edits a copy while FLUX.2 [klein] looks at the picture itself (image 1) and the reference pictures (image 2 onwards). */
  private async editWithReferences(ctx: { request: EditRequest; source: ImageItem; strength: number; seed: number; jobId: string; controller: AbortController }, client: ComfyClient): Promise<{ buffer: Buffer; summary: string }> {
    const { request, source, controller, jobId } = ctx
    const models = pickReferenceModels(this.comfyMgr.inventoryNow)
    if (!models) throw new Error('Giving the reference pictures themselves to a model needs FLUX.2 [klein]. Add it from the Studio settings, or switch the references to “light and colour only”.')
    const refs = this.deps.db.getImagesByIds(request.references!.imageIds.slice(0, 3)).filter((i) => !i.missing && i.id !== source.id)
    if (refs.length === 0) throw new Error('The reference pictures cannot be found any more.')
    const items = refs.map((i) => ({ roles: (request.references!.roles?.[i.id] ?? ['atmosphere']) as RefRole[], influence: (request.references!.influence?.[i.id] ?? 'balanced') as ReferenceInfluence }))
    const description = (request.prompt?.trim() || request.instruction.trim() || 'the same picture')
    const prompt = compileReferencePrompt(description, items, { editTarget: true })
    const size = referenceSize(source.width, source.height)
    const uploaded = [await client.upload(source.path)]
    for (const r of refs) uploaded.push(await client.upload(r.path))
    const graph = referenceWorkflow({ models, images: uploaded, prompt, seed: ctx.seed, width: size.width, height: size.height, refMegapixels: uploaded.length >= 3 ? 0.6 : 1 })
    this.progress(jobId, { stage: 'working', message: 'FLUX.2 [klein] is looking at your pictures…', fraction: null, done: 0, total: 1 })
    const made = await client.run({ workflow: graph, outputNodes: saveNodeIds(graph), signal: controller.signal, onWait: (s) => this.progress(jobId, { stage: 'working', message: `FLUX.2 [klein] is painting… ${s}s`, fraction: null, done: 0, total: 1 }) })
    const parts = refs.map((r, i) => `image ${i + 2} (${r.filename}): ${items[i]!.roles.join(' + ')}, ${items[i]!.influence}`)
    return { buffer: made[0]!, summary: `FLUX.2 [klein] was given this picture (image 1) and ${refs.length} reference picture${refs.length === 1 ? '' : 's'} themselves — ${parts.join('; ')} — and repainted a copy at ${size.width}×${size.height}. Your original is untouched.` }
  }

  /** What each way of using reference pictures can do, with what is installed right now. For the interface and the companion. */
  async referencePipelines(): Promise<ReferencePipeline[]> {
    const methods = await this.methods(false)
    const cloud = methods.find((m) => m.id === 'openai')
    return referenceCapabilities(pickReferenceModels(this.comfyMgr.inventoryNow), { available: Boolean(cloud?.available && cloud.canEdit), reason: cloud?.reason ?? null })
  }

  // ---- editing (non-destructive) -------------------------------------------------------------------------------------

  async edit(request: EditRequest): Promise<StudioResult> {
    const jobId = request.jobId ?? randomUUID()
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    try {
      const source = this.deps.db.getImage(request.imageId)
      if (!source || source.missing) throw new Error('That picture cannot be found any more.')
      const userWorkflow = request.workflowId ? this.comfyMgr.workflowById(request.workflowId) : null
      if (request.workflowId && !userWorkflow) throw new Error('That ComfyUI workflow is not in the list any more. Rescan ComfyUI in the Studio settings.')
      const hasReferences = Boolean(request.references?.imageIds.length)
      if (!request.instruction.trim() && userWorkflow?.kind !== 'upscale' && !hasReferences) throw new Error('Say what you would like to change.')
      const methods = await this.methods(true)
      const method = methods.find((m) => m.id === (userWorkflow ? 'comfyui' : request.methodId))
      if (!method || !method.canEdit) throw new Error('That method cannot edit pictures.')
      if (!method.available && !userWorkflow) throw new Error(method.reason ?? 'That method is not available right now.')
      const model = request.model || method.model
      const count = Math.max(1, Math.min(4, Math.round(request.count || 1)))
      const estimate = this.estimate(request.methodId, model, count, source.width, source.height)
      this.checkApproval(request.methodId, estimate.costUsd, request.approvedCost, request.approvedUpload, estimate)
      this.progress(jobId, { stage: 'working', message: 'Editing a copy. Your original is not touched.', fraction: null, done: 0, total: count })

      const original = await sharp(source.path, { failOn: 'none' }).rotate().png().toBuffer()
      const strength = Math.max(0, Math.min(1, request.strength))
      const prep = await this.prepareEdit(request, source, original, jobId)
      const alternatives: EditAlternative[] = []
      for (let n = 0; n < count; n += 1) {
        if (controller.signal.aborted) throw new Error('Stopped.')
        if (count > 1) this.progress(jobId, { stage: 'working', message: `Making alternative ${n + 1} of ${count}…`, fraction: n / count, done: n, total: count })
        const seed = (Number.isFinite(request.seed) ? Math.floor(request.seed!) : Math.floor(Math.random() * 2 ** 31)) + n * 7919
        const made = await this.editOnce({ request, source, method, model, original, strength, seed, userWorkflow, prep, jobId, controller, estimateCost: estimate.costUsd / count })
        let buffer = made.buffer
        let summary = made.summary
        if (prep.mask) {
          // Only the chosen part may change: lay the edit over the original through the soft mask, at the original's own size.
          buffer = (await compositeThroughMask(original, buffer, prep.mask)).png
          summary += ` Only ${prep.mask.how} (${Math.round(prep.mask.coverage * 100)}% of the picture) was allowed to change; everything outside it is the original, pixel for pixel.`
        }
        if (prep.referenceNote) summary += ` ${prep.referenceNote}`
        const preview = await sharp(buffer).resize(900, 900, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer()
        const pendingId = randomUUID()
        this.pending.set(pendingId, { buffer, request, source, cost: method.id === 'openai' ? estimate.costUsd / count : 0, model, summary })
        this.trimPending()
        alternatives.push({ previewUrl: `data:image/jpeg;base64,${preview.toString('base64')}`, pendingId, summary })
      }
      this.progress(jobId, { stage: 'done', message: count > 1 ? 'Here are the alternatives.' : 'Here is a preview.', fraction: 1, done: count, total: count })
      const first = alternatives[0]!
      return {
        ok: true,
        message: count > 1 ? `Here are ${count} alternatives. Nothing has been saved yet.` : 'Here is a preview. Nothing has been saved yet.',
        records: [],
        previewUrl: first.previewUrl,
        pendingId: first.pendingId,
        alternatives: count > 1 ? alternatives : undefined,
        regionUrl: prep.overlay ?? undefined,
        summary: first.summary
      }
    } catch (error) {
      const message = controller.signal.aborted ? 'Stopped.' : friendly(error)
      this.progress(jobId, { stage: 'failed', message, fraction: null, done: 0, total: 1 })
      return { ok: false, message, records: [] }
    } finally {
      this.controllers.delete(jobId)
    }
  }

  /** Works out the parts of an edit that every alternative shares: the selected region and the reference look. */
  private async prepareEdit(request: EditRequest, source: ImageItem, original: Buffer, jobId: string): Promise<EditPrep> {
    const prep: EditPrep = { mask: null, overlay: null, init: original, look: '', referenceNote: '' }
    const dims = await sharp(original).metadata()
    if (request.region) {
      this.progress(jobId, { stage: 'working', message: 'Finding the part to change…', fraction: null, done: 0, total: 1 })
      prep.mask = await buildRegionMask(original, request.region, { width: dims.width!, height: dims.height! })
      prep.overlay = await regionOverlay(original, prep.mask)
    }
    const refs = request.references
    // With a model that can use them, reference pictures are given to it as pictures (see editWithReferences); the measured look is for the other methods.
    const picturesToModel = refs?.conditioning === 'images' && request.methodId !== 'blend'
    if (refs && refs.imageIds.length > 0 && !picturesToModel) {
      const items = this.deps.db.getImagesByIds(refs.imageIds.slice(0, 12)).filter((i) => !i.missing && i.id !== source.id)
      if (items.length === 0) throw new Error('The reference pictures cannot be found any more.')
      this.progress(jobId, { stage: 'working', message: 'Reading the look of the reference…', fraction: null, done: 0, total: 1 })
      const stats = mergeStats(await Promise.all(items.map((i) => lookStats(i.path))))
      const aspects = refs.aspects.length > 0 ? refs.aspects : (['atmosphere'] as ReferenceAspect[])
      prep.init = await transferLook(original, stats, aspects, refs.amount ?? 0.75)
      prep.look = describeLook(stats)
      prep.referenceNote = `The ${aspects.map((a) => REFERENCE_ASPECTS[a].toLowerCase()).join(' and ')} of ${items.length === 1 ? 'the reference picture' : `${items.length} reference pictures`} were applied to the pixels before the model worked (${Math.round((refs.amount ?? 0.75) * 100)}%)${prep.look ? `, described to it as “${prep.look}”` : ''}. Composition and material cannot be taken from a reference with the models available here; this picture's own composition is kept.`
    }
    return prep
  }

  /** Makes one alternative of an edit with the chosen method. Returns the picture and one plain sentence about what was done. */
  private async editOnce(ctx: {
    request: EditRequest
    source: ImageItem
    method: StudioMethod
    model: string
    original: Buffer
    strength: number
    seed: number
    userWorkflow: ReturnType<ComfyManager['workflowById']>
    prep: EditPrep
    jobId: string
    controller: AbortController
    estimateCost: number
  }): Promise<{ buffer: Buffer; summary: string }> {
    const { request, source, method, model, original, strength, seed, userWorkflow, prep, jobId, controller } = ctx
    const level = request.level
    const levelNote = level ? `${EDIT_LEVELS[level].label} change. ` : ''
    const description = (request.prompt?.trim() || imagePromptFromInstruction(request.instruction) || 'the same picture').concat(prep.look ? `, ${prep.look}` : '')
    const negative = 'low quality, blurry, deformed, text, watermark'
    if (method.id === 'blend') {
      const mood = readMood(request.instruction, strength)
      if (mood.understood.length === 0 && prep.init === original) throw new Error('Atlas Blend understands moods and looks: mysterious, misty, dreamy, warmer, cooler, brighter, more vivid, muted, black and white, film grain, dramatic. For other changes, use ComfyUI or a cloud method.')
      const base = prep.init
      const buffer = mood.understood.length > 0 ? await applyMood(base, mood, Math.floor(strength * 1000)) : base
      return { buffer, summary: `${levelNote}${mood.understood.length > 0 ? `Made it ${mood.understood.join(', ')}.` : 'Applied the reference look.'} Pixels were graded, not moved, so the architecture and composition are unchanged.` }
    }
    if (method.id === 'comfyui') {
      const client = await this.comfy(jobId, controller.signal)
      if (request.references?.conditioning === 'images' && request.references.imageIds.length > 0) return this.editWithReferences(ctx, client)
      const uploaded = prep.init === original ? await client.upload(source.path) : await client.uploadBuffer(prep.init, 'graded.png')
      const denoise = 0.2 + strength * 0.5
      const editWorkflow = userWorkflow ?? (model.startsWith('workflow:') ? null : this.comfyMgr.workflowById(this.data.comfyEditWorkflowId))
      if (editWorkflow) {
        if (!editWorkflow.runnable) throw new Error(`“${editWorkflow.name}” cannot run yet. ${editWorkflow.why ?? ''}`.trim())
        const api = await this.comfyMgr.prepare(editWorkflow, client.baseUrl)
        const bound = bindWorkflow(api, editWorkflow.kind === 'upscale' ? { image: uploaded } : { prompt: description, negative, seed, image: uploaded, denoise })
        if (!bound.bound.image) throw new Error(`“${editWorkflow.name}” has no step that loads a picture, so Atlas cannot give it yours.`)
        if (editWorkflow.kind !== 'upscale' && request.instruction.trim() && !bound.bound.prompt) throw new Error(`Atlas could not find where the description goes in “${editWorkflow.name}”. Choose another workflow, or an upscaling workflow that needs no description.`)
        const made = await client.run({ workflow: bound.workflow, outputNodes: saveNodeIds(bound.workflow), signal: controller.signal })
        return { buffer: made[0]!, summary: editWorkflow.kind === 'upscale' ? `Your ComfyUI workflow “${editWorkflow.name}” enlarged a copy. Your workflow and your original are untouched.` : `Your ComfyUI workflow “${editWorkflow.name}” changed a copy. Your original is untouched.` }
      }
      if (!model || model.startsWith('workflow:')) throw new Error(this.comfyMgr.needs(null)[0] ?? 'ComfyUI needs a checkpoint model or an editing workflow to change pictures.')
      const onWait = (sec: number): void => this.progress(jobId, { stage: 'working', message: `ComfyUI is working… ${sec}s`, fraction: null, done: 0, total: 1 })
      const atlasModels = this.data.comfyWorkflow ? null : pickAtlasModels(this.comfyMgr.inventoryNow)
      const checkpoint = request.model && request.model !== 'Your workflow' ? request.model : atlasModels?.checkpoint ?? model
      const params = level ? levelParams(level, strength) : null
      if (prep.mask && !this.data.comfyWorkflow) {
        // Selective edit: the model repaints only inside the mask (inpainting); Atlas lays the result over the original afterwards.
        const sd15 = isSd15Name(checkpoint)
        const fill = params?.fill ?? strength > 0.8
        const size = workingSize(source.width, source.height, Math.min(MAX_EDIT_EDGE, sd15 ? (fill ? 768 : 1024) : 1024, Math.max(source.width, source.height)))
        const maskName = await client.uploadBuffer(await maskToPng(prep.mask), 'mask.png')
        const graph = inpaintWorkflow({ checkpoint, image: uploaded, mask: maskName, prompt: description, negative, seed, width: size.width, height: size.height, denoise: params?.denoise ?? 0.25 + strength * 0.6, fill, tile: atlasModels?.tile ?? null, hold: params?.hold ?? 0.8, steps: params?.steps })
        const made = await client.run({ workflow: graph, outputNodes: saveNodeIds(graph), signal: controller.signal, onWait })
        return { buffer: made[0]!, summary: `${levelNote}ComfyUI repainted ${fill ? 'the selected part from scratch' : 'the selected part from what was there'} (inpainting at ${size.width}×${size.height}).` }
      }
      if (atlasModels?.tile && (!request.model || request.model === atlasModels.checkpoint)) {
        // Atlas's own structure-keeping edit: a tile ControlNet holds the composition while the description moves the look.
        const size = workingSize(source.width, source.height, Math.min(MAX_EDIT_EDGE, Math.max(source.width, source.height)))
        const den = params ? params.denoise : 0.25 + strength * 0.5
        const hold = params ? params.hold : 1 - strength * 0.25
        const graph = tileEditWorkflow({ checkpoint: atlasModels.checkpoint, tile: atlasModels.tile, image: uploaded, prompt: description, negative, seed, width: size.width, height: size.height, denoise: den, hold: Math.max(0.2, hold), steps: params?.steps })
        const made = await client.run({ workflow: graph, outputNodes: saveNodeIds(graph), signal: controller.signal, onWait })
        return { buffer: made[0]!, summary: `${levelNote}ComfyUI repainted a copy from your description at ${size.width}×${size.height} while a tile ControlNet held the structure (${Math.round(den * 100)}% may change). The original is untouched.` }
      }
      const workflow = this.data.comfyWorkflow
        ? fillWorkflow(JSON.parse(readFileSync(this.data.comfyWorkflow, 'utf8')) as unknown, { prompt: description, negative: 'low quality, blurry, deformed', seed, width: source.width, height: source.height, checkpoint: model, image: uploaded, denoise })
        : standardWorkflow({ checkpoint: model, prompt: description, negative, seed, width: Math.min(1536, source.width || 1024), height: Math.min(1536, source.height || 1024), image: uploaded, denoise })
      const out = await client.run({ workflow, signal: controller.signal })
      return { buffer: out[0]!, summary: `${levelNote}ComfyUI repainted a copy with a ${Math.round(denoise * 100)}% change from the original.` }
    }
    const key = this.cloudKey
    if (!key) throw new Error('Add an OpenAI key in the Studio settings first.')
    const cloud = new CloudImages('https://api.openai.com/v1', key, this.deps.fetchImpl)
    const small = await sharp(prep.init).resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    if (request.references?.conditioning === 'images' && request.references.imageIds.length > 0) {
      const refItems = this.deps.db.getImagesByIds(request.references.imageIds.slice(0, 3)).filter((i) => !i.missing && i.id !== source.id)
      const items = refItems.map((i) => ({ roles: (request.references!.roles?.[i.id] ?? ['atmosphere']) as RefRole[], influence: (request.references!.influence?.[i.id] ?? 'balanced') as ReferenceInfluence }))
      const images = [small, ...(await Promise.all(refItems.map((i) => sharp(i.path, { failOn: 'none' }).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).png().toBuffer())))]
      const multi = await cloud.edit({ model, prompt: compileReferencePrompt(description, items, { editTarget: true }), image: small, images, width: source.width, height: source.height, signal: controller.signal })
      this.addSpend(ctx.estimateCost)
      return { buffer: multi[0]!, summary: `The cloud service edited a copy that you agreed to send, together with ${refItems.length} reference picture${refItems.length === 1 ? '' : 's'}.` }
    }
    const out = await cloud.edit({ model, prompt: request.instruction, image: small, width: source.width, height: source.height, signal: controller.signal })
    this.addSpend(ctx.estimateCost)
    return { buffer: out[0]!, summary: 'The cloud service edited a copy that you agreed to send.' }
  }

  // ---- retouching: remove and blur --------------------------------------------------------------------------------------

  /**
   * Remove (rebuild the painted part from its surroundings) or blur (soften it). Both work on a copy, lay the result over the
   * original through the soft mask (so everything outside the selection is the original, byte for byte) and keep it in
   * memory as a preview until the user keeps it as a new version.
   */
  async retouch(request: RetouchRequest): Promise<StudioResult> {
    const jobId = request.jobId ?? randomUUID()
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    try {
      const source = this.deps.db.getImage(request.imageId)
      if (!source || source.missing) throw new Error('That picture cannot be found any more.')
      if (!['remove', 'heal', 'blur', 'sharpen', 'tone'].includes(request.tool)) throw new Error('Choose one of the retouching tools.')
      const strength = Math.max(0, Math.min(1, Number.isFinite(request.strength) ? request.strength : 0.5))
      // A step continues from the result of the step before it, never from the file again: what is finished stays exactly as it was.
      let base: Pending | null = null
      if (request.baseId) {
        base = this.pending.get(request.baseId) ?? null
        if (!base || base.source.id !== request.imageId) throw new Error('The earlier step of this retouching is no longer available. Keep it as a version, or undo back to a step that is.')
      }
      const original = base ? base.buffer : await sharp(source.path, { failOn: 'none', limitInputPixels: false }).rotate().png().toBuffer()
      const dims = await sharp(original).metadata()
      this.progress(jobId, { stage: 'working', message: 'Finding the marked area…', fraction: null, done: 0, total: 1 })
      const mask = await buildRegionMask(original, request.region, { width: dims.width!, height: dims.height! })
      const share = `${mask.coverage < 0.01 ? '<1' : Math.round(mask.coverage * 100)}%`
      let buffer: Buffer
      let summary: string
      let cost = 0
      let model = ''
      let methodId: StudioMethod['id'] = 'blend'
      let instruction: string
      let suffix: string
      const grownFor = (): Buffer => dilate(mask.hard, mask.width, mask.height, Math.max(2, Math.round(Math.max(mask.width, mask.height) * 0.004)))
      const softOf = (hard: Buffer): Promise<Buffer> => sharp(hard, { raw: { width: mask.width, height: mask.height, channels: 1 } }).blur(Math.max(1, Math.max(mask.width, mask.height) * 0.0025)).extractChannel(0).raw().toBuffer()
      if (request.tool === 'blur') {
        this.progress(jobId, { stage: 'working', message: 'Softening…', fraction: null, done: 0, total: 1 })
        const soft = await blurredCopy(original, mask, { strength, edgeAware: request.edgeAware === true })
        buffer = (await compositeThroughMask(original, soft, mask)).png
        summary = `Softened ${mask.how} (${share} of the picture) with a ${request.edgeAware ? 'edge-aware blur that keeps strong edges and smooths what lies between them' : 'plain Gaussian blur'} at ${percentText(strength)}% strength, on this computer with no AI model. Everything outside the area is the original, pixel for pixel.`
        instruction = `Soften ${mask.how}${request.edgeAware ? ' (edge-aware)' : ''}, ${percentText(strength)}%`
        suffix = 'softened'
        model = 'Atlas blur'
      } else if (request.tool === 'sharpen') {
        this.progress(jobId, { stage: 'working', message: 'Bringing back detail…', fraction: null, done: 0, total: 1 })
        const sharp2 = await sharpenedCopy(original, mask, strength)
        buffer = (await compositeThroughMask(original, sharp2, mask)).png
        summary = `Sharpened ${mask.how} (${share} of the picture) at ${percentText(strength)}% strength, on this computer with no AI model. Grain-sized detail is not amplified, only brightness is sharpened (no colour fringes) and the result is limited to the local range (no halos). Everything outside the area is the original, pixel for pixel.`
        instruction = `Sharpen ${mask.how}, ${percentText(strength)}%`
        suffix = 'sharpened'
        model = 'Atlas sharpen'
      } else if (request.tool === 'tone') {
        const direction = request.tone === 'darken' ? 'darken' : 'lighten'
        this.progress(jobId, { stage: 'working', message: direction === 'lighten' ? 'Brightening…' : 'Darkening…', fraction: null, done: 0, total: 1 })
        const toned = await tonedCopy(original, mask, strength, direction)
        buffer = (await compositeThroughMask(original, toned, mask)).png
        summary = `${direction === 'lighten' ? 'Brightened (dodged)' : 'Darkened (burned)'} ${mask.how} (${share} of the picture) by about ${(strength * 1.3).toFixed(1)} stops in the mid-tones, on this computer. Black and white stay where they are and colours keep their hue. Everything outside the area is the original, pixel for pixel.`
        instruction = `${direction === 'lighten' ? 'Brighten' : 'Darken'} ${mask.how}, ${percentText(strength)}%`
        suffix = direction === 'lighten' ? 'dodged' : 'burned'
        model = 'Atlas dodge & burn'
      } else if (request.tool === 'heal') {
        this.progress(jobId, { stage: 'working', message: 'Repairing…', fraction: null, done: 0, total: 1 })
        const healed = await healedCopy(original, mask, strength)
        buffer = (await compositeThroughMask(original, healed.png, healed.mask)).png
        summary = `Healed ${mask.how} (${share} of the picture) on this computer with no AI model: ${healed.note} Everything outside the area is the original, pixel for pixel.`
        instruction = `Heal ${mask.how}`
        suffix = 'healed'
        model = 'Atlas heal'
      } else {
        const way = request.method ?? 'local'
        instruction = request.hint?.trim() ? `Remove ${mask.how}, leaving ${request.hint.trim()}` : `Remove ${mask.how}`
        suffix = 'retouched'
        if (way === 'local') {
          this.progress(jobId, { stage: 'working', message: 'Rebuilding the area from its surroundings…', fraction: null, done: 0, total: 1 })
          const filled = await fillFromSurroundings(original, mask, strength)
          buffer = (await compositeThroughMask(original, filled.png, filled.mask)).png
          summary = `Removed ${mask.how} (${share} of the picture) by rebuilding it from the surroundings on this computer, with no AI model: ${filled.note} Everything outside the area is the original, pixel for pixel. For large objects, ComfyUI inpainting gives better results.`
          model = 'Atlas content-aware fill'
        } else if (way === 'comfyui') {
          methodId = 'comfyui'
          const methods = await this.methods(true)
          const method = methods.find((m) => m.id === 'comfyui')
          if (!method || !method.available || !method.canEdit) throw new Error(method?.reason ?? 'ComfyUI is not ready. Set it up in the Studio settings, or use the local fill.')
          const atlasModels = this.data.comfyWorkflow ? null : pickAtlasModels(this.comfyMgr.inventoryNow)
          const checkpoint = request.model || atlasModels?.checkpoint || method.model
          if (!checkpoint || checkpoint.startsWith('workflow:')) throw new Error('ComfyUI needs a checkpoint model to repaint. Set one up in the Studio settings, or use the local fill.')
          model = checkpoint
          const client = await this.comfy(jobId, controller.signal)
          const onWait = (sec: number): void => this.progress(jobId, { stage: 'working', message: `ComfyUI is repainting the area… ${sec}s`, fraction: null, done: 0, total: 1 })
          // Work on the part around the marked area, at the model's own resolution, so a small defect on a large picture keeps its detail.
          const grown = grownFor()
          const hole = maskBox({ ...mask, hard: grown, soft: grown }, 0)!
          const ctxPad = Math.max(48, Math.round(Math.max(hole.x1 - hole.x0, hole.y1 - hole.y0) * 0.8))
          const box = { x0: Math.max(0, hole.x0 - ctxPad), y0: Math.max(0, hole.y0 - ctxPad), x1: Math.min(mask.width - 1, hole.x1 + ctxPad), y1: Math.min(mask.height - 1, hole.y1 + ctxPad) }
          const bw = box.x1 - box.x0 + 1
          const bh = box.y1 - box.y0 + 1
          let crop = await sharp(original).extract({ left: box.x0, top: box.y0, width: bw, height: bh }).png().toBuffer()
          // Seeded: the model refines Atlas's own rebuild of the area instead of painting it from nothing, so the surrounding texture and
          // structure carry through (a model started from blank often invents a smooth or mismatched patch). If the rebuild is not possible
          // (too little picture around the mark) it falls back to the plain way.
          let seeded = false
          if (request.seedLocal !== false) {
            try {
              const local = await fillFromSurroundings(original, mask, strength)
              crop = await sharp(local.png).extract({ left: box.x0, top: box.y0, width: bw, height: bh }).png().toBuffer()
              seeded = true
            } catch {
              seeded = false
            }
          }
          const cropMaskRaw = Buffer.alloc(bw * bh)
          for (let y = 0; y < bh; y += 1) grown.copy(cropMaskRaw, y * bw, (box.y0 + y) * mask.width + box.x0, (box.y0 + y) * mask.width + box.x0 + bw)
          const cropMask = await sharp(cropMaskRaw, { raw: { width: bw, height: bh, channels: 1 } }).png().toBuffer()
          const size = workingSize(bw, bh, isSd15Name(checkpoint) ? 768 : 1024)
          const imageName = await client.uploadBuffer(crop, 'remove-source.png')
          const maskName = await client.uploadBuffer(cropMask, 'remove-mask.png')
          const prompt = request.hint?.trim() ? `${request.hint.trim()}, seamless, natural, matching the surroundings` : 'seamless natural continuation of the surrounding scene, same texture, lighting and colours, clean, nothing added'
          const graph = inpaintWorkflow({ checkpoint, image: imageName, mask: maskName, prompt, negative: 'object, person, animal, text, watermark, logo, signature, frame, border, blurry, deformed, ugly', seed: Number.isFinite(request.seed) ? Math.floor(request.seed!) : Math.floor(Math.random() * 2 ** 31), width: size.width, height: size.height, denoise: seeded ? 0.55 : 1, fill: !seeded, grow: 4, tile: seeded ? (atlasModels?.tile ?? null) : null, hold: seeded ? 0.6 : undefined })
          this.progress(jobId, { stage: 'working', message: 'ComfyUI is repainting the area…', fraction: null, done: 0, total: 1 })
          const made = await client.run({ workflow: graph, outputNodes: saveNodeIds(graph), signal: controller.signal, onWait })
          const patch = await sharp(made[0]!).resize(bw, bh, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()
          const edited = await sharp(original).composite([{ input: patch, left: box.x0, top: box.y0 }]).png().toBuffer()
          const used: RegionMask = { ...mask, hard: grown, soft: await softOf(grown) }
          buffer = (await compositeThroughMask(original, edited, used)).png
          summary = `Removed ${mask.how} (${share} of the picture): ComfyUI repainted the area from what surrounds it (inpainting at ${size.width}×${size.height} on the part around it${seeded ? ', starting from Atlas’s own rebuild of the area' : ''}). Everything outside the area is the original, pixel for pixel.`
        } else {
          methodId = 'openai'
          const methods = await this.methods(true)
          const method = methods.find((m) => m.id === 'openai')
          if (!method || !method.available || !method.canEdit) throw new Error(method?.reason ?? 'The cloud service is not set up. Add a key in the Studio settings, or use the local fill.')
          model = request.model || method.model
          const estimate = this.estimate('openai', model, 1, dims.width!, dims.height!)
          this.checkApproval('openai', estimate.costUsd, request.approvedCost ?? 0, request.approvedUpload === true, estimate)
          const key = this.cloudKey
          if (!key) throw new Error('Add an OpenAI key in the Studio settings first.')
          const cloud = new CloudImages('https://api.openai.com/v1', key, this.deps.fetchImpl)
          const small = await sharp(original).resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()
          const sm = await sharp(small).metadata()
          const grown = grownFor()
          const alpha = await sharp(grown, { raw: { width: mask.width, height: mask.height, channels: 1 } }).resize(sm.width!, sm.height!, { fit: 'fill' }).extractChannel(0).raw().toBuffer()
          const rgba = Buffer.alloc(sm.width! * sm.height! * 4)
          for (let i = 0; i < alpha.length; i += 1) rgba[i * 4 + 3] = alpha[i]! > 127 ? 0 : 255
          const maskPng = await sharp(rgba, { raw: { width: sm.width!, height: sm.height!, channels: 4 } }).png().toBuffer()
          this.progress(jobId, { stage: 'working', message: 'Waiting for the cloud service…', fraction: null, done: 0, total: 1 })
          const out = await cloud.edit({ model, prompt: `Remove the masked object and fill the area so it matches the surroundings${request.hint?.trim() ? `: ${request.hint.trim()}` : ''}. Change nothing else.`, image: small, mask: maskPng, width: dims.width!, height: dims.height!, signal: controller.signal })
          this.addSpend(estimate.costUsd)
          cost = estimate.costUsd
          const used: RegionMask = { ...mask, hard: grown, soft: await softOf(grown) }
          buffer = (await compositeThroughMask(original, out[0]!, used)).png
          summary = `Removed ${mask.how} (${share} of the picture) with the cloud service, which received the picture and the marked area you agreed to send. Everything outside the area is the original, pixel for pixel.`
        }
      }
      const edge = Math.max(512, Math.min(4096, Math.round(request.previewEdge ?? 1600)))
      const preview = await sharp(buffer).resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer()
      const pendingId = randomUUID()
      const steps = [...(base?.steps ?? []), instruction]
      const summaries = [...(base?.summaries ?? []), summary]
      const synthetic: EditRequest = { imageId: request.imageId, methodId, instruction: steps.join(', then '), strength, approvedCost: request.approvedCost ?? 0, approvedUpload: request.approvedUpload === true }
      this.pending.set(pendingId, { buffer, request: synthetic, source, cost: cost + (base?.cost ?? 0), model: base && base.model !== model ? `${base.model}, ${model}` : model, summary: summaries.join('\n'), suffix: base && base.suffix !== suffix ? 'retouched' : suffix, steps, summaries })
      this.trimPending()
      this.progress(jobId, { stage: 'done', message: 'Here is a preview.', fraction: 1, done: 1, total: 1 })
      return { ok: true, message: 'Here is a preview. Nothing has been saved yet.', records: [], previewUrl: `data:image/jpeg;base64,${preview.toString('base64')}`, pendingId, summary }
    } catch (error) {
      const message = controller.signal.aborted ? 'Stopped.' : friendly(error)
      this.progress(jobId, { stage: 'failed', message, fraction: null, done: 0, total: 1 })
      return { ok: false, message, records: [] }
    } finally {
      this.controllers.delete(jobId)
    }
  }

  /** Keeps the memory in check: the oldest previews go first, but a finished retouch step the user can still undo to never does. */
  private trimPending(): void {
    if (this.pending.size <= 24) return
    for (const [key, value] of this.pending) {
      if (this.pending.size <= 24) break
      if (!value.held) this.pending.delete(key)
    }
  }

  /** The retouch workspace marks finished steps (held) and lets go of the ones it no longer needs (released). */
  holdRetouch(hold: string[], release: string[]): { held: number } {
    for (const id of release) this.pending.delete(id)
    for (const id of hold) {
      const p = this.pending.get(id)
      if (p) p.held = true
    }
    let held = 0
    for (const p of this.pending.values()) if (p.held) held += 1
    return { held }
  }

  /** Shows which part a region would change, before anything is made. Nothing is saved. */
  async previewRegion(imageId: string, region: EditRegion): Promise<{ overlayUrl: string; coverage: number; how: string }> {
    const source = this.deps.db.getImage(imageId)
    if (!source || source.missing) throw new Error('That picture cannot be found any more.')
    const original = await sharp(source.path, { failOn: 'none' }).rotate().png().toBuffer()
    const mask = await buildRegionMask(original, region)
    return { overlayUrl: await regionOverlay(original, mask), coverage: mask.coverage, how: mask.how }
  }

  /** Keeps a previewed edit as a new version next to the original. The original file is never changed. */
  async commitEdit(pendingId: string): Promise<StudioResult> {
    const pending = this.pending.get(pendingId)
    if (!pending) return { ok: false, message: 'That preview has expired. Please make the edit again.', records: [] }
    const { source, request } = pending
    const saved = await this.writePicture(pending.buffer, join(this.deps.studioDir, 'edits'), `${slug(source.filename.replace(/\.[^.]+$/, ''))}-edit`)
    const imageId = await this.waitForImage(saved.path)
    const origin = this.provenance(source.id)
    const record = this.insertRecord({
      kind: 'edit',
      path: saved.path,
      imageId,
      title: `${source.filename.replace(/\.[^.]+$/, '')} (${pending.suffix ?? 'edited'})`,
      moodboardId: origin?.record.moodboardId ?? null,
      moodboardName: origin?.record.moodboardName ?? '',
      sourceImageIds: [source.id],
      roles: {},
      prompt: request.instruction,
      negative: '',
      methodId: request.methodId,
      model: pending.model,
      seed: null,
      width: saved.width,
      height: saved.height,
      costUsd: pending.cost,
      parentId: origin?.record.id ?? null,
      seriesId: origin?.record.seriesId ?? `photo-${source.id}`,
      note: pending.summary
    })
    this.pending.delete(pendingId)
    this.deps.notifyChanged()
    return { ok: true, message: 'Saved as a new version. The original is untouched.', records: [record] }
  }

  /**
   * Makes a larger copy of a picture and saves it as a new version linked to the original. The original is never
   * changed. With a ComfyUI upscaling workflow (a Clarity preset, for example) the workflow runs as the user tuned it,
   * apart from the one scale step that is set from the target size. With no workflow the picture is enlarged by plain
   * resampling, which adds no new detail and says so.
   */
  async upscale(request: UpscaleRequest): Promise<StudioResult> {
    const jobId = request.jobId ?? randomUUID()
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    try {
      const source = this.deps.db.getImage(request.imageId)
      if (!source || source.missing) throw new Error('That picture cannot be found any more.')
      const target = Math.round(request.targetLongEdge)
      if (!Number.isFinite(target) || target < 256 || target > MAX_UPSCALE_EDGE) throw new Error(`Choose a size between 256 and ${MAX_UPSCALE_EDGE} pixels on the longer side.`)
      const sourceLong = Math.max(source.width, source.height)
      const scale = target / Math.max(1, sourceLong)
      const finalW = Math.round(source.width * scale)
      const finalH = Math.round(source.height * scale)
      if (finalW * finalH > MAX_UPSCALE_PIXELS) throw new Error('That size is more than this computer can hold in one picture. Choose a smaller size.')
      const atlasChoice = request.workflowId === ATLAS_DETAIL
      const workflow = request.workflowId && !atlasChoice ? this.comfyMgr.workflowById(request.workflowId) : null
      if (request.workflowId && !atlasChoice && !workflow) throw new Error('That upscaling preset is not in the list any more. Rescan ComfyUI in the Studio settings.')
      if (workflow && workflow.kind !== 'upscale') throw new Error(`“${workflow.name}” is not an upscaling workflow.`)
      if (workflow && !workflow.runnable) throw new Error(`“${workflow.name}” cannot run yet. ${workflow.why ?? ''}`.trim())
      this.progress(jobId, { stage: 'working', message: workflow ? `Starting “${workflow.name}” on a copy…` : 'Enlarging a copy…', fraction: null, done: 0, total: 1 })

      let buffer: Buffer
      let note: string
      let methodId: string
      let model: string
      if (atlasChoice) {
        const models = pickAtlasModels(this.comfyMgr.inventoryNow)
        if (!models?.esrgan) throw new Error('Atlas’s detail upscaling needs an enlargement model (Real-ESRGAN). Install the Creative upscaling package, or choose another way.')
        const client = await this.comfy(jobId, controller.signal)
        const uploaded = await client.upload(source.path)
        const snap = (w: number, h: number): { width: number; height: number } => ({ width: Math.max(64, Math.round(w / 8) * 8), height: Math.max(64, Math.round(h / 8) * 8) })
        const size = snap(finalW, finalH)
        const finalLong = Math.max(finalW, finalH)
        const onWait = (seconds: number): void => this.progress(jobId, { stage: 'working', message: `ComfyUI is working… ${seconds}s`, fraction: null, done: 0, total: 1 })
        // The detail pass runs at sizes an 8 GB card can hold. For a larger target it runs at the largest such size and a
        // second plain enlargement takes the result the rest of the way, so the picture still gains its fine detail.
        const detail = Boolean(models.tile) && sourceLong <= MAX_DETAIL_EDGE
        const origin = this.provenance(source.id)
        const subject = request.subject ?? subjectFromText(`${origin?.record.prompt ?? ''} ${origin?.record.title ?? ''}`)
        const tuning = detailSettings(subject)
        let stageNote = ''
        if (detail) {
          const stageScale = Math.min(finalLong, MAX_DETAIL_EDGE) / Math.max(1, sourceLong)
          const stage = finalLong > MAX_DETAIL_EDGE ? snap(source.width * stageScale, source.height * stageScale) : size
          const graph = detailUpscaleWorkflow({ checkpoint: models.checkpoint, tile: models.tile!, esrgan: models.esrgan, image: uploaded, width: stage.width, height: stage.height, seed: Math.floor(Math.random() * 2 ** 31), denoise: tuning.denoise, cfg: tuning.cfg, prompt: tuning.prompt, negative: tuning.negative })
          const first = await client.run({ workflow: graph, outputNodes: saveNodeIds(graph), signal: controller.signal, onWait })
          if (finalLong > MAX_DETAIL_EDGE) {
            this.progress(jobId, { stage: 'working', message: `Detail pass done at ${stage.width}×${stage.height}. Enlarging the rest of the way…`, fraction: null, done: 0, total: 1 })
            const second = await client.uploadBuffer(first[0]!, 'stage.png')
            const finish = esrganWorkflow({ esrgan: models.esrgan, image: second, width: size.width, height: size.height })
            buffer = (await client.run({ workflow: finish, outputNodes: saveNodeIds(finish), signal: controller.signal, onWait }))[0]!
            stageNote = ` (detail pass at ${stage.width}×${stage.height}, then enlarged to ${size.width}×${size.height})`
          } else buffer = first[0]!
        } else {
          const graph = esrganWorkflow({ esrgan: models.esrgan, image: uploaded, width: size.width, height: size.height })
          buffer = (await client.run({ workflow: graph, outputNodes: saveNodeIds(graph), signal: controller.signal, onWait }))[0]!
        }
        note = detail
          ? `Enlarged with Real-ESRGAN, then a gentle detail pass tuned for ${DETAIL_SUBJECTS[subject].label.toLowerCase()} and held in place by a tile ControlNet${stageNote || ` (${size.width}×${size.height})`}. Atlas’s own detail upscaling; your original is untouched.`
          : `Enlarged with Real-ESRGAN and resampled to ${size.width}×${size.height}. ${models.tile ? `Pictures above ${MAX_DETAIL_EDGE}px skip the detail pass to fit in graphics memory.` : 'Install the Edit package to add a detail pass.'}`
        methodId = 'comfyui'
        model = detail ? 'Atlas detail upscale' : 'Real-ESRGAN enlarge'
      } else if (workflow) {
        const client = await this.comfy(jobId, controller.signal)
        const uploaded = await client.upload(source.path)
        const api = await this.comfyMgr.prepare(workflow, client.baseUrl)
        const retargeted = retargetUpscale(api, sourceLong, target)
        const bound = bindWorkflow(retargeted?.workflow ?? api, { image: uploaded })
        if (!bound.bound.image) throw new Error(`“${workflow.name}” has no step that loads a picture, so Atlas cannot give it yours.`)
        const made = await client.run({
          workflow: bound.workflow,
          outputNodes: saveNodeIds(bound.workflow),
          signal: controller.signal,
          onWait: (seconds) => this.progress(jobId, { stage: 'working', message: `“${workflow.name}” is working… ${seconds >= 90 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`}. Detailed presets can take a long while on large pictures.`, fraction: null, done: 0, total: 1 })
        })
        buffer = made[0]!
        const native = await sharp(buffer).metadata()
        note = `Enlarged by “${workflow.name}” in ComfyUI${retargeted ? ` (its scale step set to ${retargeted.scaleBy} for this size)` : ''}. ComfyUI produced ${native.width}×${native.height}${native.width === finalW || native.height === finalH ? '' : `, resampled to ${finalW}×${finalH}`}. Your workflow, the preset and the original are untouched.`
        methodId = 'comfyui'
        model = workflow.name
      } else {
        buffer = await sharp(source.path, { failOn: 'none' }).rotate().png().toBuffer()
        note = `Plain enlargement to ${finalW}×${finalH}. It adds no new detail; choose a ComfyUI preset for that.`
        methodId = 'blend'
        model = 'Plain enlarge'
      }
      this.progress(jobId, { stage: 'saving', message: 'Saving the larger copy…', fraction: 0.95, done: 0, total: 1 })
      const sized = await sharp(buffer, { limitInputPixels: false }).resize(finalW, finalH, { fit: 'fill', kernel: 'lanczos3' }).png({ compressionLevel: 4 }).toBuffer()
      const saved = await this.writePicture(sized, join(this.deps.studioDir, 'upscaled'), `${slug(source.filename.replace(/\.[^.]+$/, ''))}-${finalW}px`)
      const imageId = await this.waitForImage(saved.path)
      const origin = this.provenance(source.id)
      const record = this.insertRecord({
        kind: 'upscale',
        path: saved.path,
        imageId,
        title: `${source.filename.replace(/\.[^.]+$/, '')} (${finalW}×${finalH})`,
        moodboardId: origin?.record.moodboardId ?? null,
        moodboardName: origin?.record.moodboardName ?? '',
        sourceImageIds: [source.id],
        roles: {},
        prompt: '',
        negative: '',
        methodId,
        model,
        seed: null,
        width: saved.width,
        height: saved.height,
        costUsd: 0,
        parentId: origin?.record.id ?? null,
        seriesId: origin?.record.seriesId ?? `photo-${source.id}`,
        note
      })
      this.deps.notifyChanged()
      this.progress(jobId, { stage: 'done', message: 'Finished.', fraction: 1, done: 1, total: 1 })
      return { ok: true, message: `Saved ${finalW}×${finalH} as a new version. The original is untouched.`, records: [record], summary: note }
    } catch (error) {
      const message = controller.signal.aborted ? 'Stopped.' : friendly(error)
      this.progress(jobId, { stage: 'failed', message, fraction: null, done: 0, total: 1 })
      return { ok: false, message, records: [] }
    } finally {
      this.controllers.delete(jobId)
    }
  }

  /** The external programs Atlas knows, for the companion. */
  editorList(): Array<{ id: string; name: string }> {
    return this.data.editors.map((e) => ({ id: e.id, name: e.name }))
  }

  // ---- versions and multi-step plans ---------------------------------------------------------------------------------------

  /** Every version made from the same starting picture, oldest first, with how each came about. Nothing is ever removed. */
  versions(imageId: string): { seriesId: string; records: GenerationRecord[] } {
    const own = this.provenance(imageId)
    const seriesId = own?.record.seriesId ?? `photo-${imageId}`
    const rows = this.deps.db.raw().prepare('SELECT * FROM generations WHERE series_id = ? ORDER BY created_at ASC').all(seriesId) as Array<Record<string, unknown>>
    return { seriesId, records: rows.map((r) => this.rowToRecord(r)) }
  }

  /**
   * Runs the steps of a plan the user approved, one after another, each on the result of the one before (or on the
   * starting picture), and keeps every result as a linked version. Only local methods are used: a plan never uploads a
   * picture or spends money, and the originals are never touched.
   */
  async runPlan(imageId: string, steps: PlanStep[], options: { jobId?: string; onStep?: (text: string) => void } = {}): Promise<PlanResult> {
    const jobId = options.jobId ?? randomUUID()
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const outcome: PlanResult = { ok: true, message: '', records: [], steps: [] }
    const children: string[] = []
    let current = imageId
    try {
      if (steps.length === 0) throw new Error('The plan has no steps.')
      const methods = await this.methods(true)
      const comfy = methods.find((m) => m.id === 'comfyui')
      const useComfy = Boolean(comfy?.available && comfy.canEdit && !comfy.leavesComputer)
      for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i]!
        if (controller.signal.aborted) throw new Error('Stopped.')
        const start = step.from === 'source' ? imageId : current
        options.onStep?.(`Step ${i + 1} of ${steps.length}: ${step.label}`)
        const child = randomUUID()
        children.push(child)
        this.localPlanJobs.add(child)
        // Stopping the plan also stops the step that is running.
        controller.signal.addEventListener('abort', () => this.controllers.get(child)?.abort(), { once: true })
        let made: GenerationRecord[] = []
        let problem = ''
        if (step.op === 'edit') {
          const level = step.level
          const result = await this.edit({
            jobId: child,
            imageId: start,
            methodId: useComfy ? 'comfyui' : 'blend',
            instruction: step.instruction ?? '',
            prompt: step.prompt,
            strength: level ? EDIT_LEVELS[level].strength : 0.55,
            level,
            region: step.region,
            references: step.references,
            count: step.count,
            approvedCost: 0,
            approvedUpload: false
          })
          if (!result.ok) problem = result.message
          else {
            const pendings = result.alternatives?.map((a) => a.pendingId) ?? [result.pendingId!]
            for (const pendingId of pendings) {
              const saved = await this.commitEdit(pendingId)
              if (saved.ok) made.push(...saved.records)
              else problem = saved.message
            }
          }
        } else if (step.op === 'remove' || step.op === 'blur' || step.op === 'heal' || step.op === 'sharpen' || step.op === 'tone') {
          if (!step.region) problem = `“${step.label}” needs a part of the picture (for example the sky or the left side). Paint it in the Retouch tab instead.`
          else {
            const result = await this.retouch({
              jobId: child,
              imageId: start,
              tool: step.op,
              region: step.region,
              tone: step.tone,
              strength: step.strength ?? (step.op === 'blur' || step.op === 'sharpen' || step.op === 'tone' ? 0.5 : 0.4),
              edgeAware: step.edgeAware,
              method: step.op === 'remove' && useComfy ? 'comfyui' : 'local'
            })
            if (!result.ok) problem = result.message
            else {
              const saved = await this.commitEdit(result.pendingId!)
              if (saved.ok) made = saved.records
              else problem = saved.message
            }
          }
        } else {
          const source = this.deps.db.getImage(start)
          if (!source || source.missing) problem = 'That picture cannot be found any more.'
          else {
            const long = Math.max(source.width, source.height)
            const target = step.op === 'detail' ? long : step.targetLongEdge ?? long * 2
            const result = await this.upscale({ jobId: child, imageId: start, workflowId: step.workflowId === undefined ? ATLAS_DETAIL : step.workflowId, targetLongEdge: target, subject: step.subject })
            if (!result.ok) problem = result.message
            else made = result.records
          }
        }
        outcome.steps.push({ label: step.label, ok: !problem && made.length > 0, message: problem || (made.length === 1 ? 'Saved as a new version.' : `Saved ${made.length} new versions.`), recordIds: made.map((r) => r.id), imageIds: made.map((r) => r.imageId).filter((x): x is string => Boolean(x)) })
        if (problem || made.length === 0) {
          outcome.ok = false
          outcome.message = `Stopped at step ${i + 1}: ${problem || 'nothing was made'}`
          break
        }
        outcome.records.push(...made)
        current = made[0]!.imageId ?? current
      }
      if (outcome.ok) outcome.message = `Finished ${steps.length} step${steps.length === 1 ? '' : 's'}. ${outcome.records.length} new version${outcome.records.length === 1 ? ' is' : 's are'} in your library, linked to the original.`
      return outcome
    } catch (error) {
      outcome.ok = false
      outcome.message = controller.signal.aborted ? 'Stopped.' : friendly(error)
      return outcome
    } finally {
      for (const child of children) this.localPlanJobs.delete(child)
      this.controllers.delete(jobId)
    }
  }

  discardEdit(pendingId: string): void {
    this.pending.delete(pendingId)
  }

  // ---- external editors ----------------------------------------------------------------------------------------------
  //
  // A picture is opened in another program as a COPY. Atlas watches that copy (and the files saved next to it, because
  // programs such as Photoshop often "Save As" a PSD or TIFF beside it) and brings every distinct save back as a new
  // version linked to the original. A save is imported only when it has been still for a moment, can be read, differs
  // from the original and from what was already imported, and the copy Atlas made of it is in the library. Only then is
  // it reported as imported.

  /** Opens a COPY of the picture in another program and imports the result as a new version when it is saved. */
  async startExternalEdit(imageId: string, editorId: string | null): Promise<ExternalEditSession> {
    const source = this.deps.db.getImage(imageId)
    if (!source || source.missing) throw new Error('That picture cannot be found any more.')
    const editor = editorId ? this.data.editors.find((e) => e.id === editorId) : null
    if (editorId && !editor) throw new Error('That program is not set up. Add it in the Studio settings.')
    const dir = join(this.deps.dataDir, 'studio', 'external')
    mkdirSync(dir, { recursive: true })
    const id = randomUUID().slice(0, 8)
    const base = `${slug(source.filename.replace(/\.[^.]+$/, ''))}-${id}`
    const working = join(dir, `${base}${extname(source.filename) || '.png'}`)
    copyFileSync(source.path, working)
    const editorName = editor?.name ?? 'your default program'
    const session: ExternalEditSession = { id, sourceImageId: imageId, editorName, editorId: editor?.id ?? null, workingFile: working, startedAt: Date.now(), status: 'open', importedImageId: null, versions: [], message: `Opened in ${editorName}. Save the picture there (Ctrl+S) and it comes back here as a new version.` }
    const watch: ExternalWatch = {
      session,
      source,
      dir,
      base,
      seen: new Map(),
      pending: new Map(),
      busy: false,
      sourceHash: null,
      importedHashes: new Set(),
      lastRecordId: null,
      failures: new Map(),
      stopAt: Date.now() + 8 * 3600_000,
      timer: setInterval(() => void this.checkExternal(id), this.deps.externalPollMs ?? 1500)
    }
    // Whatever is in the folder now is not a result.
    for (const f of this.externalFiles(watch)) watch.seen.set(f.path, f.sig)
    watch.timer.unref?.()
    this.watches.set(id, watch)
    this.deps.broadcast('studio:external', session)
    if (editor) {
      // Batch launchers (.cmd, .bat) need a shell; real programs (.exe) are started directly.
      const batch = /\.(cmd|bat)$/i.test(editor.path)
      const child = batch
        ? spawn(`"${editor.path}" "${working}"`, { detached: true, stdio: 'ignore', shell: true, windowsHide: true })
        : spawn(editor.path, [working], { detached: true, stdio: 'ignore' })
      child.on('error', () => this.setExternal(watch, { status: 'error', error: `Could not start ${editor.name}.`, message: `Could not start ${editor.name}. Check its path in the Studio settings.` }))
      child.unref()
    } else if (this.deps.openPath) {
      await this.deps.openPath(working)
    }
    return session
  }

  /** The working copy and the files the program saved beside it that could be a result (same name, any picture type). */
  private externalFiles(watch: ExternalWatch): Array<{ path: string; sig: string; mtimeMs: number }> {
    const out: Array<{ path: string; sig: string; mtimeMs: number }> = []
    let names: string[] = []
    try {
      names = readdirSync(watch.dir)
    } catch {
      return out
    }
    for (const name of names) {
      const ext = extname(name).toLowerCase()
      if (!EXTERNAL_EXTENSIONS.has(ext)) continue
      if (!name.toLowerCase().startsWith(watch.base.toLowerCase())) continue
      try {
        const full = join(watch.dir, name)
        const st = statSync(full)
        if (st.isFile()) out.push({ path: full, sig: `${st.size}:${Math.round(st.mtimeMs)}`, mtimeMs: st.mtimeMs })
      } catch {
        // gone again
      }
    }
    return out
  }

  private setExternal(watch: ExternalWatch, patch: Partial<ExternalEditSession>): ExternalEditSession {
    watch.session = { ...watch.session, ...patch }
    this.deps.broadcast('studio:external', watch.session)
    return watch.session
  }

  private async checkExternal(id: string): Promise<void> {
    const watch = this.watches.get(id)
    if (!watch || watch.busy) return
    if (Date.now() > watch.stopAt) return this.endExternal(id)
    try {
      for (const f of this.externalFiles(watch)) {
        if (watch.seen.get(f.path) === f.sig) continue
        const wait = watch.pending.get(f.path)
        // A program may still be writing: act only on a file whose size and time have not moved for a while.
        if (!wait || wait.sig !== f.sig) {
          watch.pending.set(f.path, { sig: f.sig, since: Date.now() })
          continue
        }
        if (Date.now() - wait.since < (this.deps.externalSettleMs ?? 1200)) continue
        watch.pending.delete(f.path)
        watch.busy = true
        try {
          const result = await this.importFromFile(watch, f.path, 'saved')
          if (result.kind === 'retry') {
            const n = (watch.failures.get(f.path) ?? 0) + 1
            watch.failures.set(f.path, n)
            if (n >= 8) {
              watch.seen.set(f.path, f.sig)
              this.setExternal(watch, { status: watch.session.versions.length ? 'imported' : 'error', error: result.message, message: result.message })
            }
          } else {
            watch.seen.set(f.path, f.sig)
          }
        } finally {
          watch.busy = false
        }
      }
    } catch {
      // The folder or file is busy; try again on the next tick.
    }
  }

  /** What a file would become: a readable picture and a fingerprint of its pixels. Throws {retry} for files that are not ready. */
  private async readExternalPicture(filePath: string): Promise<{ ext: string; width: number; height: number; hash: string; flattened: boolean; png?: Buffer }> {
    const st = statSync(filePath)
    if (!st.isFile() || st.size === 0) throw new ExternalNotReady('The saved file is empty so far.')
    try {
      if (isPsdPath(filePath)) {
        const psd = await readPsdComposite(filePath)
        const png = await sharp(psd.data, { raw: { width: psd.width, height: psd.height, channels: psd.channels } }).png().toBuffer()
        return { ext: '.png', width: psd.width, height: psd.height, hash: createHash('sha256').update(psd.data).digest('hex'), flattened: true, png }
      }
      // Strict decoding: a file that is still being written (cut short) fails here and is tried again, never imported half-way.
      const meta = await sharp(filePath, { failOn: 'error', limitInputPixels: false }).metadata()
      const raw = await sharp(filePath, { failOn: 'error', limitInputPixels: false }).rotate().ensureAlpha().raw().toBuffer()
      return { ext: extname(filePath).toLowerCase() || '.png', width: meta.width ?? 0, height: meta.height ?? 0, hash: createHash('sha256').update(raw).digest('hex'), flattened: false }
    } catch (error) {
      if (error instanceof PsdError) throw new ExternalUnsupported(error.message)
      const text = error instanceof Error ? error.message : ''
      if (/unsupported image format|not a valid|no decode delegate|unsupported/i.test(text)) throw new ExternalUnsupported('Atlas cannot read this kind of file. In the program, use File › Export or Save a Copy to make a PNG or JPEG, then import that.')
      throw new ExternalNotReady('The saved file is not readable yet.')
    }
  }

  private async sourceFingerprint(watch: ExternalWatch): Promise<string> {
    if (!watch.sourceHash) {
      const raw = await sharp(watch.source.path, { failOn: 'none', limitInputPixels: false }).rotate().ensureAlpha().raw().toBuffer()
      watch.sourceHash = createHash('sha256').update(raw).digest('hex')
    }
    return watch.sourceHash
  }

  private async importFromFile(watch: ExternalWatch, filePath: string, origin: 'saved' | 'chosen'): Promise<{ kind: 'imported' | 'unchanged' | 'repeat' | 'retry' | 'failed'; message: string }> {
    const { source } = watch
    const editor = watch.session.editorName
    const fileName = basename(filePath)
    const fail = (message: string, kind: 'retry' | 'failed'): { kind: 'retry' | 'failed'; message: string } => {
      if (kind === 'failed') this.setExternal(watch, { status: watch.session.versions.length ? 'imported' : 'error', error: message, message })
      return { kind, message }
    }
    this.setExternal(watch, { status: 'importing', error: undefined, message: 'Saving your edit…' })
    let picture: Awaited<ReturnType<Studio['readExternalPicture']>>
    try {
      picture = await this.readExternalPicture(filePath)
    } catch (error) {
      if (error instanceof ExternalUnsupported) return fail(error.message, 'failed')
      this.setExternal(watch, { status: watch.session.versions.length ? 'imported' : 'open', message: 'Your program is still writing the file…' })
      return { kind: 'retry', message: 'The saved file is not readable yet. Atlas will try again in a moment.' }
    }
    const idle = (message: string): void => void this.setExternal(watch, { status: watch.session.versions.length ? 'imported' : 'open', error: undefined, message })
    if (picture.hash === (await this.sourceFingerprint(watch))) {
      const message = origin === 'chosen' ? 'That file is the same picture as the original, so nothing was imported.' : `Saved without changes: the picture still looks like the original, so nothing was imported.`
      idle(message)
      return { kind: 'unchanged', message }
    }
    if (watch.importedHashes.has(picture.hash)) {
      const message = 'That is the picture Atlas already brought back, so no new version was made.'
      idle(message)
      return { kind: 'repeat', message }
    }
    // A copy of the result goes into the Studio folder; the user's own file is only ever read.
    const dir = join(this.deps.studioDir, 'edits')
    mkdirSync(dir, { recursive: true })
    const n = watch.session.versions.length + 1
    const target = join(dir, `${slug(source.filename.replace(/\.[^.]+$/, ''))}-${slug(editor)}-${n}-${randomUUID()}${picture.ext}`)
    try {
      if (picture.png) writeFileSync(target, picture.png, { flag: 'wx' })
      else copyFileSync(filePath, target, constants.COPYFILE_EXCL)
    } catch {
      return fail('Atlas could not save a copy of the edit in its Studio folder. Check that there is free space and that the folder is not read-only.', 'failed')
    }
    // Success is only reported for a file that was really checked: the copy exists, is the size of what was saved, decodes, and has the
    // picture's dimensions. A copy that fails any of this is removed and the user is told exactly that, never "imported".
    try {
      const copied = statSync(target)
      if (!copied.isFile() || copied.size === 0) throw new Error('the copy is empty')
      if (!picture.png && copied.size !== statSync(filePath).size) throw new Error('the copy is not the size of the saved file')
      const check = await sharp(target, { failOn: 'error', limitInputPixels: false }).metadata()
      if (check.width !== picture.width || check.height !== picture.height) throw new Error(`the copy is ${check.width}×${check.height}, not ${picture.width}×${picture.height}`)
    } catch (error) {
      try {
        unlinkSync(target)
      } catch {
        /* nothing to remove */
      }
      return fail(`Atlas copied your edit but could not confirm the copy (${error instanceof Error ? error.message : 'unreadable'}), so nothing was added. Save in the program again, or use “Find my saved file”.`, 'failed')
    }
    const imageId = await this.waitForImage(target)
    const item = imageId ? this.deps.db.getImage(imageId) : null
    if (!imageId || !item || item.missing || !existsSync(target)) {
      return fail('Atlas saved a copy of your edit but it has not appeared in the library yet. Press “Import it now” to try again.', 'failed')
    }
    const origin0 = this.provenance(source.id)
    const record = this.insertRecord({
      kind: 'external',
      path: target,
      imageId,
      title: `${source.filename.replace(/\.[^.]+$/, '')} (${editor}${n > 1 ? ` · save ${n}` : ''})`,
      moodboardId: origin0?.record.moodboardId ?? null,
      moodboardName: origin0?.record.moodboardName ?? '',
      sourceImageIds: [source.id],
      roles: {},
      prompt: '',
      negative: '',
      methodId: 'external',
      model: editor,
      seed: null,
      width: item.width || picture.width,
      height: item.height || picture.height,
      costUsd: 0,
      parentId: watch.lastRecordId ?? origin0?.record.id ?? null,
      seriesId: origin0?.record.seriesId ?? `photo-${source.id}`,
      note: `${origin === 'chosen' ? 'Imported from' : 'Edited in'} ${editor} · session ${watch.session.id} · ${fileName}${picture.flattened ? ' · flattened picture of a Photoshop document (the layers stay in your file)' : ''}`
    })
    watch.lastRecordId = record.id
    watch.importedHashes.add(picture.hash)
    const version: ExternalVersion = { imageId, recordId: record.id, at: Date.now(), width: item.width || picture.width, height: item.height || picture.height, fileName, origin, flattened: picture.flattened }
    this.setExternal(watch, { status: 'imported', importedImageId: imageId, versions: [...watch.session.versions, version], error: undefined, message: `${n > 1 ? `Saved again in ${editor}: version ${n} is in your library` : `Saved in ${editor} and added to your library as a new version`} (${item.width || picture.width}×${item.height || picture.height}, ${statSync(target).size > 1e6 ? `${(statSync(target).size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(statSync(target).size / 1000))} KB`}, checked).` })
    this.deps.notifyChanged()
    this.deps.attention?.('Your edit is back in Atlas', `${editor} saved “${source.filename}”. Atlas made it a new version.`)
    return { kind: 'imported', message: watch.session.message }
  }

  /** "Import it now": looks for a save Atlas has not brought back yet. */
  async importExternal(id: string): Promise<ExternalEditSession> {
    const watch = this.watches.get(id)
    if (!watch) throw new Error('That editing session has ended.')
    if (watch.busy) return watch.session
    const changed = this.externalFiles(watch).filter((f) => f.sig !== watch.seen.get(f.path) || !watch.session.versions.length)
    const newest = this.externalFiles(watch).sort((a, b) => b.mtimeMs - a.mtimeMs).find((f) => f.mtimeMs > watch.session.startedAt - 2000) ?? changed[0]
    if (!newest) throw new Error('Nothing has been saved yet. Save the picture in the program (Ctrl+S), and Atlas picks it up by itself. If you saved it in another folder, use “Find my saved file”.')
    watch.busy = true
    try {
      const result = await this.importFromFile(watch, newest.path, 'saved')
      watch.seen.set(newest.path, newest.sig)
      if (result.kind === 'failed') throw new Error(result.message)
      if (result.kind === 'retry') throw new Error('The program is still writing the file. Try again in a moment.')
    } finally {
      watch.busy = false
    }
    return watch.session
  }

  /** Brings a file the user chose (saved in another folder, or in a format the program chose) back as a new linked version. */
  async importExternalFile(id: string, path: string): Promise<ExternalEditSession> {
    const watch = this.watches.get(id)
    if (!watch) throw new Error('That editing session has ended.')
    if (!path || !existsSync(path)) throw new Error('That file cannot be found.')
    if (!EXTERNAL_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error('Atlas imports PNG, JPEG, WebP, TIFF, BMP, GIF and Photoshop (PSD) files.')
    if (watch.busy) throw new Error('Atlas is still saving the last edit. Try again in a moment.')
    watch.busy = true
    try {
      const result = await this.importFromFile(watch, path, 'chosen')
      if (result.kind !== 'imported') throw new Error(result.message)
    } finally {
      watch.busy = false
    }
    return watch.session
  }

  /** Recently changed pictures in the usual places, newest first, that might be the result saved somewhere else. */
  externalCandidates(id: string): ExternalCandidate[] {
    const watch = this.watches.get(id)
    if (!watch) return []
    const home = this.deps.homeDir ?? homedir()
    const cloud = [process.env['OneDrive'], process.env['OneDriveConsumer'], process.env['OneDriveCommercial']].filter((x): x is string => Boolean(x))
    const bases = [home, ...cloud]
    const folders = new Set<string>([watch.dir, dirname(watch.source.path)])
    for (const b of bases) for (const sub of ['Desktop', 'Downloads', 'Documents', 'Pictures']) folders.add(join(b, sub))
    // A result is saved after the picture was opened; a little slack covers clocks that disagree.
    const since = watch.session.startedAt - 3_000
    const stem = watch.source.filename.replace(/\.[^.]+$/, '').toLowerCase()
    const imported = new Set(watch.session.versions.map((v) => v.fileName.toLowerCase()))
    const found: ExternalCandidate[] = []
    const seenPaths = new Set<string>()
    const scan = (folder: string, depth: number): void => {
      let entries: import('node:fs').Dirent[] = []
      try {
        entries = readdirSync(folder, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries.slice(0, 600)) {
        const full = join(folder, e.name)
        if (e.isDirectory()) {
          if (depth > 0 && !e.name.startsWith('.') && !/^(node_modules|\$RECYCLE|AppData)$/i.test(e.name)) scan(full, depth - 1)
          continue
        }
        if (!EXTERNAL_EXTENSIONS.has(extname(e.name).toLowerCase())) continue
        if (seenPaths.has(full.toLowerCase())) continue
        if (full.toLowerCase() === watch.session.workingFile.toLowerCase()) continue
        if (isPathInsideOrEqual(join(this.deps.studioDir, 'edits'), full)) continue
        try {
          const st = statSync(full)
          if (st.mtimeMs < since || st.size === 0) continue
          if (imported.has(e.name.toLowerCase())) continue
          seenPaths.add(full.toLowerCase())
          const name = e.name.toLowerCase().replace(/\.[^.]+$/, '')
          found.push({ path: full, name: e.name, folder: folder, modifiedAt: Math.round(st.mtimeMs), size: st.size, likely: stem.length >= 5 && (name.includes(stem.slice(0, Math.min(stem.length, 24))) || stem.includes(name.slice(0, 12))) })
        } catch {
          // skip
        }
      }
    }
    // Next to the original, and one folder down (many people save into an "edited" or "export" folder beside it).
    for (const f of folders) scan(f, f === watch.dir ? 0 : 1)
    return found.sort((a, b) => Number(b.likely) - Number(a.likely) || b.modifiedAt - a.modifiedAt).slice(0, 8)
  }

  externalSessions(): ExternalEditSession[] {
    return Array.from(this.watches.values()).map((w) => w.session)
  }

  endExternal(id: string): void {
    const watch = this.watches.get(id)
    if (watch) clearInterval(watch.timer)
    this.watches.delete(id)
    if (watch) this.deps.broadcast('studio:external-ended', { id })
  }

  dispose(): void {
    // ComfyUI is closed only when Atlas started it; one the user started stays as it is.
    this.comfyMgr.stop()
    for (const w of this.watches.values()) clearInterval(w.timer)
    this.watches.clear()
    for (const c of this.controllers.values()) c.abort()
  }
}

function friendly(error: unknown): string {
  if (error instanceof ComfyError || error instanceof CloudImageError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}

/** Finds Photoshop and PhotoCraft in the usual places, so “Edit in…” works without setup where possible. */
export function detectEditors(): StudioExternalEditor[] {
  const found: StudioExternalEditor[] = []
  const roots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Programs') : undefined].filter((r): r is string => Boolean(r))
  const look = (dir: string, depth: number): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      if (/^photoshop\.exe$/i.test(entry)) found.push({ id: 'photoshop', name: 'Photoshop', path: full })
      else if (/photocraft.*\.exe$/i.test(entry) && !/unins|update|crash/i.test(entry)) found.push({ id: 'photocraft', name: 'PhotoCraft', path: full })
      else if (depth > 0 && !entry.includes('.') && /adobe|photoshop|photocraft/i.test(dir + entry)) look(full, depth - 1)
    }
  }
  for (const root of roots) {
    let top: string[] = []
    try {
      top = readdirSync(root)
    } catch {
      continue
    }
    for (const name of top) if (/adobe|photocraft/i.test(name)) look(join(root, name), 3)
  }
  const unique = new Map<string, StudioExternalEditor>()
  for (const e of found) if (!unique.has(e.id)) unique.set(e.id, e)
  return [...unique.values()]
}

export { ASPECTS }
