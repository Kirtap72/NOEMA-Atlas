// Types shared by the Creative Studio (main process and interface): turning moodboards into new artwork, editing
// images non-destructively, and keeping track of what was made from what.

export type RefRole = 'atmosphere' | 'composition' | 'colour' | 'material' | 'subject'
export const REF_ROLES: RefRole[] = ['composition', 'atmosphere', 'colour', 'material', 'subject']
/** How strongly a reference picture should shape the result when its pictures are given to the image model. */
export type RefInfluence = 'subtle' | 'balanced' | 'strong'

export type AspectChoice = 'square' | 'landscape' | 'portrait' | 'wide'

/** One way of making or editing pictures. Methods are modular: a method says what it can do and what it costs. */
export interface StudioMethod {
  id: 'blend' | 'comfyui' | 'openai'
  name: string
  kind: 'offline' | 'local' | 'cloud'
  description: string
  /** Whether it can be used right now, and if not, why in plain words. */
  available: boolean
  reason: string | null
  canGenerate: boolean
  canEdit: boolean
  /** True when the user's prompt or pictures leave this computer. */
  leavesComputer: boolean
  /** Rough price in US dollars for one picture, or null when it is free. */
  costPerImage: number | null
  models: string[]
  model: string
  /** Friendly names for entries of `models` that are not file names (workflows). */
  modelLabels?: Record<string, string>
}

export interface StudioExternalEditor {
  id: string
  name: string
  path: string
}

export interface ComfyWorkflowSummary {
  id: string
  name: string
  kind: 'generate' | 'edit' | 'upscale' | 'video' | 'audio' | 'other'
  format: 'api' | 'ui'
  /** Atlas can run it now. */
  runnable: boolean
  /** In plain words, what stops it (or a useful note). */
  why: string | null
  missing: string[]
}

/** How ComfyUI stands, for the setup panel and the status line. All of it is worked out without changing anything. */
export interface ComfyStatus {
  state: 'not-set-up' | 'stopped' | 'starting' | 'running' | 'problem'
  /** One plain sentence for the status badge. */
  headline: string
  detail: string | null
  url: string | null
  startedByAtlas: boolean
  install: { folder: string; kind: 'portable' | 'source' | 'desktop'; name: string; version: string | null } | null
  models: { total: number; summary: string; counts: Record<string, number>; families: string[] } | null
  workflows: ComfyWorkflowSummary[]
  /** Workflows that make video or sound, which Atlas does not list. */
  hiddenWorkflows: number
  /** What is missing for making pictures, in simple language. Empty when something can be made. */
  needs: string[]
  canMakePictures: boolean
  log: string[]
  /** ComfyUI installations found on this computer, offered when none is chosen yet. */
  suggestions: Array<{ folder: string; kind: 'portable' | 'source' | 'desktop'; name: string }>
  /** How Atlas starts this ComfyUI (null until an installation is chosen). */
  launch: {
    kind: 'python' | 'exe' | 'none'
    /** The Python that will be used, when it starts with Python. */
    python: string | null
    /** True when the user chose that Python (otherwise Atlas found it next to the installation). */
    pythonChosen: boolean
    /** A fixed port the user chose, or null for the installation's usual one. */
    port: number | null
    effectivePort: number
    args: string[]
    /** Start scripts found beside the installation, which Atlas can copy the port and options from. Never run. */
    profiles: Array<{ name: string; file: string; port: number | null; args: string[] }>
  } | null
  /** Folders with workflows outside the installation that Atlas reads. */
  workflowFolders: string[]
  /** Folders beside the installation that look like they hold workflows. */
  suggestedWorkflowFolders: string[]
}

export interface StudioSettings {
  methods: StudioMethod[]
  comfy: ComfyStatus
  comfyFolder: string | null
  comfyAutoStart: boolean
  comfyPython: string | null
  comfyPort: number | null
  comfyArgs: string[]
  comfyWorkflowFolders: string[]
  /** The workflows the user chose for making, editing and upscaling pictures (null: Atlas's own standard graph). */
  comfyWorkflowId: string | null
  comfyEditWorkflowId: string | null
  comfyUpscaleWorkflowId: string | null
  approvedComfyUrl?: string | null
  comfyUrl: string
  comfyWorkflow: string | null
  cloudKeySet: boolean
  cloudModel: string
  /** Monthly limit for paid services, in US dollars. 0 means: never use paid services. */
  monthlyBudget: number
  spentThisMonth: number
  editors: StudioExternalEditor[]
  studioFolder: string
}

export interface StudioSettingsUpdate {
  comfyFolder?: string | null
  comfyAutoStart?: boolean
  comfyPython?: string | null
  comfyPort?: number | null
  comfyArgs?: string[]
  comfyWorkflowFolders?: string[]
  /** Adopt the port and start options of a start script found beside the installation. */
  comfyUseProfile?: string
  comfyWorkflowId?: string | null
  comfyEditWorkflowId?: string | null
  comfyUpscaleWorkflowId?: string | null
  approvedComfyUrl?: string | null
  comfyUrl?: string
  comfyWorkflow?: string | null
  cloudKey?: string
  cloudModel?: string
  monthlyBudget?: number
  editors?: StudioExternalEditor[]
}

export interface ConceptRequest {
  moodboardId: string
  /** What the user wants, in their own words. */
  intent: string
  /** Which pictures contribute what. A picture may have several roles. */
  roles: Record<string, RefRole[]>
  aspect?: AspectChoice
}

export interface ArtworkConcept {
  title: string
  summary: string
  prompt: string
  negative: string
  palette: string[]
  aspect: AspectChoice
  width: number
  height: number
  /** One line per role saying how it was understood, so the user can see what Atlas made of the board. */
  notes: string[]
  /** Other directions worth trying, each a complete prompt. */
  variations: string[]
}

export interface GenerateRequest {
  /** Chosen by the interface so it can follow this job's progress. */
  jobId?: string
  methodId: StudioMethod['id']
  model?: string
  moodboardId: string | null
  title: string
  prompt: string
  negative: string
  width: number
  height: number
  count: number
  seed?: number
  roles: Record<string, RefRole[]>
  /** How strongly each reference shapes the result (reference pictures given to the model). Balanced when missing. */
  influence?: Record<string, RefInfluence>
  /** 'images' gives the reference pictures themselves to a model that can use them, 'description' uses only their description and colours. Automatic when missing. */
  referenceMode?: 'auto' | 'images' | 'description'
  /** A previous result this is a variation or refinement of. */
  parentId?: string | null
  seriesId?: string | null
  /** How far to move away from the starting picture, 0 to 1 (used when refining and by methods that start from a picture). */
  strength?: number
  /** The most the user agreed to pay, in US dollars. The request is refused if the price is higher. */
  approvedCost: number
  /** The user agreed that the prompt (and, for edits, the picture) is sent to the cloud service. */
  approvedUpload: boolean
}

/** How far an edit may go: polish the photograph, change the look while keeping what matters, or reinterpret it. */
export type EditLevel = 'subtle' | 'creative' | 'radical'
export const EDIT_LEVELS: Record<EditLevel, { label: string; note: string; strength: number }> = {
  subtle: { label: 'Subtle', note: 'Photographic polish. Structure and detail stay as they are.', strength: 0.2 },
  creative: { label: 'Creative', note: 'Changes the look and mood, keeps the important elements.', strength: 0.55 },
  radical: { label: 'Radical', note: 'A bold artistic reinterpretation. Only loosely held to the original.', strength: 0.9 }
}

/** What a reference picture may lend to an edit. Lighting, colour and atmosphere are applied to the pixels; the rest is not (see docs). */
export type ReferenceAspect = 'lighting' | 'colour' | 'atmosphere'
export const REFERENCE_ASPECTS: Record<ReferenceAspect, string> = { lighting: 'Light and contrast', colour: 'Colours', atmosphere: 'Atmosphere (light, colour and haze)' }

export type RegionName = 'sky' | 'top' | 'bottom' | 'left' | 'right' | 'center' | 'background' | 'foreground'

/** Which part of the picture an edit may change. Everything else is kept exactly as it is. */
export interface EditRegion {
  /** A part found by Atlas by name, for example the sky. */
  named?: RegionName
  /** A rectangle or ellipse, in fractions of the picture (0 to 1). */
  shape?: { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number }
  /** The user's own painting: a PNG (data URL) the size of any proportion of the picture; white is changed. */
  maskPng?: string
  /** Swap the selection: change everything except it. */
  invert?: boolean
  /** Softness of the edge in pixels at full size (0 to 80). */
  feather?: number
}

export interface EditReferences {
  imageIds: string[]
  aspects: ReferenceAspect[]
  /** 0 to 1: how much of the reference's look to take. */
  amount?: number
  /** 'look' measures their light and colour and applies it to the pixels; 'images' gives the pictures themselves to a model that can use them. */
  conditioning?: 'look' | 'images'
  /** With 'images': what each reference is for (atmosphere when missing) and how strongly it shapes the result. */
  roles?: Record<string, RefRole[]>
  influence?: Record<string, RefInfluence>
}

export interface EditRequest {
  jobId?: string
  imageId: string
  methodId: StudioMethod['id']
  model?: string
  /** What to change, in the user's own words. */
  instruction: string
  /** 0 = barely, 1 = strongly. */
  strength: number
  approvedCost: number
  approvedUpload: boolean
  /** When true, only a small preview is made and nothing is saved to the library. */
  previewOnly?: boolean
  /** A ComfyUI workflow of the user's own to run on the picture (for example an upscaling workflow). */
  workflowId?: string | null
  level?: EditLevel
  /** A ready description of the result for the image model (written by Atlas or the companion); otherwise made from the instruction. */
  prompt?: string
  region?: EditRegion
  references?: EditReferences
  /** How many alternatives to make (1 to 4), each with its own seed. */
  count?: number
  seed?: number
}

/** The retouching tools. Remove takes something out, heal repairs a flaw, blur softens, sharpen restores detail, tone lightens or darkens. */
export type RetouchTool = 'remove' | 'heal' | 'blur' | 'sharpen' | 'tone'
export const RETOUCH_TOOLS: Record<RetouchTool, { label: string; note: string }> = {
  remove: { label: 'Remove', note: 'Paint over what should go; the area is rebuilt from what surrounds it.' },
  heal: { label: 'Heal', note: 'Repair a blemish, seam or flaw so it takes the tone and texture of its surroundings.' },
  blur: { label: 'Blur', note: 'Soften harsh edges, artificial texture or oversharpened detail.' },
  sharpen: { label: 'Sharpen', note: 'Bring back detail without halos or noise.' },
  tone: { label: 'Dodge & burn', note: 'Lighten or darken with a soft brush, keeping colours true.' }
}

export interface RetouchRequest {
  jobId?: string
  imageId: string
  tool: RetouchTool
  /** The part to work on: painted (maskPng), a shape or a name. White in a painted mask is worked on. */
  region: EditRegion
  /** Blur: how much to soften, 0 to 1. Remove: how far past the painted edge to reach, 0 to 1. */
  strength: number
  /** Tone only: lighten (dodge) or darken (burn). */
  tone?: 'lighten' | 'darken'
  /** Blur only: keep strong edges and smooth only what lies between them (guided filter). */
  edgeAware?: boolean
  /** Remove only: how to fill. 'local' reconstructs from the surroundings on this computer, 'comfyui' repaints with an inpainting model, 'openai' asks the cloud. */
  method?: 'local' | 'comfyui' | 'openai'
  /** Remove only: what should be there instead, when the surroundings do not say it (for example "grass"). */
  hint?: string
  /**
   * Remove with ComfyUI only: start the model from Atlas's own rebuild of the area (which already continues the surrounding texture) and let it
   * refine that, instead of painting the area from nothing. Default on.
   */
  seedLocal?: boolean
  model?: string
  seed?: number
  approvedCost?: number
  approvedUpload?: boolean
  /** Make the preview this many pixels on the long side (default 1600). */
  previewEdge?: number
  /**
   * The preview (pendingId) of an earlier, finished step to continue from. The tool then works on THAT result, so every finished
   * step keeps its own mask, settings and pixels and later steps can never re-compute it. Without it the picture file itself is used.
   */
  baseId?: string
}

/** One alternative of an edit, held in memory until the user keeps it. */
export interface EditAlternative {
  previewUrl: string
  pendingId: string
  summary: string
}

export interface GenerationRecord {
  id: string
  kind: 'generation' | 'edit' | 'external' | 'upscale'
  imageId: string | null
  title: string
  moodboardId: string | null
  moodboardName: string
  sourceImageIds: string[]
  roles: Record<string, RefRole[]>
  prompt: string
  negative: string
  methodId: string
  model: string
  seed: number | null
  width: number
  height: number
  costUsd: number
  parentId: string | null
  seriesId: string | null
  note: string
  createdAt: number
}

export interface StudioEstimate {
  count: number
  costUsd: number
  free: boolean
  leavesComputer: boolean
  overBudget: boolean
  message: string
}

export interface StudioProgress {
  jobId: string
  stage: 'preparing' | 'working' | 'saving' | 'done' | 'failed'
  message: string
  /** 0..1 when known. */
  fraction: number | null
  /** Pictures already finished, so they can be shown while the rest is made. */
  done: number
  total: number
}

export interface StudioResult {
  ok: boolean
  message: string
  records: GenerationRecord[]
  /** Edits: a picture to look at before deciding. It is kept only in memory until the user chooses to keep it. */
  previewUrl?: string
  pendingId?: string
  /** All alternatives when more than one was asked for (the first is also in previewUrl and pendingId). */
  alternatives?: EditAlternative[]
  /** The part of the picture that was changed, as a small overlay picture, when a region was used. */
  regionUrl?: string
  /** What was understood and done, in plain words. */
  summary?: string
}

export interface ProvenanceInfo {
  record: GenerationRecord
  /** The pictures it came from, so the interface can show them. */
  sources: Array<{ id: string; thumbUrl: string; filename: string; roles: RefRole[] }>
  /** Pictures in the same series, oldest first. */
  series: GenerationRecord[]
}

/** One result that came back from an external program (a save, or a file the user chose), kept as a version in the library. */
/** What one way of using reference pictures can do, for the interface and the companion. */
export interface ReferencePipelineInfo {
  id: 'flux2-klein' | 'openai-images' | 'atlas-blend'
  name: string
  kind: 'local' | 'cloud' | 'offline'
  available: boolean
  reason: string | null
  maxReferences: number
  can: Record<RefRole | 'identity', 'good' | 'partial' | 'weak' | 'none'>
  summary: string
  speed: string
}

export interface ExternalVersion {
  imageId: string
  recordId: string
  at: number
  width: number
  height: number
  /** The name of the file it came from. */
  fileName: string
  origin: 'saved' | 'chosen'
  /** True when the file was a Photoshop document and its flattened picture was imported (the layers stay in the user's file). */
  flattened: boolean
}

/**
 * A picture opened in another program. Atlas works on a copy, watches it, and brings every distinct save back as a new
 * version linked to the original. `imported` is only ever set after the new picture is saved, readable and in the library.
 */
export interface ExternalEditSession {
  id: string
  sourceImageId: string
  editorName: string
  /** The program from the Studio settings it was opened in, or null for the default program. */
  editorId: string | null
  workingFile: string
  startedAt: number
  status: 'open' | 'importing' | 'imported' | 'error'
  /** The newest version that came back, or null. */
  importedImageId: string | null
  /** Every version this session brought back, oldest first. */
  versions: ExternalVersion[]
  /** One plain sentence about where things stand (waiting, saving, nothing new, what went wrong). */
  message: string
  error?: string
}

/** A recently changed file Atlas found that might be the result of an external edit saved elsewhere. */
export interface ExternalCandidate {
  path: string
  name: string
  folder: string
  modifiedAt: number
  size: number
  /** Its name resembles the picture being edited. */
  likely: boolean
}

export const ASPECTS: Record<AspectChoice, { width: number; height: number; label: string }> = {
  square: { width: 1024, height: 1024, label: 'Square' },
  landscape: { width: 1216, height: 832, label: 'Landscape' },
  portrait: { width: 832, height: 1216, label: 'Portrait' },
  wide: { width: 1344, height: 768, label: 'Wide' }
}

/** What the detail pass should treat with care. Each changes the strength and the wording of the pass. */
export type DetailSubject = 'general' | 'vegetation' | 'architecture' | 'faces' | 'texture'
export const DETAIL_SUBJECTS: Record<DetailSubject, { label: string; note: string }> = {
  general: { label: 'Anything', note: 'Balanced detail.' },
  vegetation: { label: 'Vegetation', note: 'Leaves, grass and branches get natural fine structure.' },
  architecture: { label: 'Architecture', note: 'Straight lines, edges and materials stay exact.' },
  faces: { label: 'Faces and people', note: 'Very gentle, so likeness and expression stay.' },
  texture: { label: 'Texture and materials', note: 'Stone, fabric, wood and metal grain.' }
}

export interface UpscaleRequest {
  jobId?: string
  /** What the picture mostly shows, so the detail pass suits it (only used by Atlas's own detail upscaling). */
  subject?: DetailSubject
  imageId: string
  /** A ComfyUI upscaling workflow (for example a Clarity preset), or null for a plain enlargement that needs no model. */
  workflowId: string | null
  /** The length of the longer side of the result, in pixels. */
  targetLongEdge: number
}

/** The largest size Atlas will make, so a typing slip cannot ask for something the computer cannot hold. */
export const MAX_UPSCALE_EDGE = 16384
export const MAX_UPSCALE_PIXELS = 150_000_000

/** One step of a multi-step creative process that the companion prepares and the user approves as a whole. */
export interface PlanStep {
  op: 'edit' | 'detail' | 'upscale' | 'remove' | 'heal' | 'blur' | 'sharpen' | 'tone'
  /** What the user sees: "Replace the sky with something more mysterious". */
  label: string
  /** The picture the step starts from: the one the plan began with, or the result of the step before (the default). */
  from?: 'source' | 'previous'
  instruction?: string
  prompt?: string
  level?: EditLevel
  region?: EditRegion
  references?: EditReferences
  /** Alternatives to make from the same start (edits). The first one carries on to the next step. */
  count?: number
  subject?: DetailSubject
  /** Retouching steps: 0 to 1. */
  strength?: number
  edgeAware?: boolean
  tone?: 'lighten' | 'darken'
  targetLongEdge?: number
  /** A ComfyUI upscaling preset (a Clarity preset, for example); leave out for Atlas's own detail upscaling. */
  workflowId?: string | null
}

export interface PlanResult {
  ok: boolean
  message: string
  records: GenerationRecord[]
  steps: Array<{ label: string; ok: boolean; message: string; recordIds: string[]; imageIds: string[] }>
}
