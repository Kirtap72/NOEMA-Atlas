// Types and labels of the AI Model Library, shared by the main process (which reads hardware and installs models) and the interface
// (which shows the catalogue). Pure data: nothing here touches the computer.

export const CATALOG_SCHEMA = 1

export type CategoryId = 'generation' | 'photoreal' | 'artistic' | 'editing' | 'reference' | 'upscaling' | 'understanding'
export const CATEGORIES: Record<CategoryId, { label: string; blurb: string }> = {
  generation: { label: 'Image generation', blurb: 'Make new pictures from a description.' },
  photoreal: { label: 'Photorealism', blurb: 'Pictures that look photographed.' },
  artistic: { label: 'Artistic and surreal', blurb: 'Painterly, imaginative and stylised images.' },
  editing: { label: 'Editing and inpainting', blurb: 'Change, repair or extend an existing picture.' },
  reference: { label: 'Image references', blurb: 'Use pictures, not just words, to steer a new image.' },
  upscaling: { label: 'Upscaling and detail', blurb: 'Enlarge pictures and add believable detail.' },
  understanding: { label: 'Visual understanding', blurb: 'Models that look at pictures and describe or search them, on this computer.' }
}

/** What a model gives Atlas. The first three are the Studio's existing capabilities; the others are new ones. */
export type Provides = 'create' | 'edit' | 'upscale' | 'reference' | 'search' | 'describe'

export type Verification = 'verified' | 'documented' | 'experimental'
export const VERIFICATION_LABEL: Record<Verification, { label: string; note: string }> = {
  verified: { label: 'Tested and verified', note: 'Atlas ran this on real hardware, and the tests that were run are listed.' },
  documented: { label: 'Documented, untested here', note: 'Its requirements come from the official source. Atlas has not run it on this kind of computer.' },
  experimental: { label: 'Experimental', note: 'It may work, may be slow or unstable, and has not been verified. Try it knowing that.' }
}

export interface CatalogFile {
  /** Unique within the entry. */
  key: string
  name: string
  /** ComfyUI's folder for it, for example "diffusion_models". */
  folder: string
  url: string
  bytes: number
  sha256: string
}

export interface Requirements {
  /** The memory a model needs to run at all (dedicated graphics memory, or the share of unified memory it can use), in GB. */
  minMemoryGB?: number
  /** Where it runs comfortably. */
  recommendedMemoryGB?: number
  /** Architectures it is known to run on. Empty or missing means "not known to be restricted". */
  archs?: Array<'x64' | 'arm64'>
  os?: string[]
  /** Graphics generations it needs (for example a 4-bit model needs Blackwell). Missing means any. */
  gpuFamilies?: string[]
  /** Needs these numeric precisions to be native on the card. */
  precision?: 'fp16' | 'bf16' | 'fp8' | 'fp4'
  /** The oldest ComfyUI that has the nodes the model needs. */
  comfyMin?: string
  /** Custom ComfyUI nodes it needs, by folder name. */
  customNodes?: string[]
  notes?: string
}

export interface Variant {
  id: string
  label: string
  /** The files of this variant; replaces the entry's files. */
  files: CatalogFile[]
  requirements?: Partial<Requirements>
  note?: string
}

export interface CatalogWorkflow {
  /** Atlas's own graph (for example "atlas:reference-flux2"), or a file shipped with the entry. */
  id: string
  name: string
  task: string
}

export interface CatalogEntry {
  schema: number
  id: string
  name: string
  summary: string
  details: string
  categories: CategoryId[]
  capabilities: Array<{ id: string; label: string; level: 'good' | 'partial' | 'weak' }>
  /** The model's own version, as its makers name it. */
  version: string
  runtime: 'comfyui' | 'ollama' | 'atlas-onnx'
  source: { name: string; url: string }
  licence: { name: string; url: string; summary: string; commercialUse: 'yes' | 'conditions' | 'no'; acceptance?: string }
  files: CatalogFile[]
  variants?: Variant[]
  requirements: Requirements
  /** Other entries that must be installed with it. */
  dependsOn: string[]
  workflows: CatalogWorkflow[]
  provides: Provides[]
  verification: {
    status: Verification
    checks: Array<{ hardware: string; date: string; result: string; how: string }>
    note?: string
  }
  install: {
    /** 'managed': Atlas downloads into the ComfyUI it manages. 'manual': official instructions only. 'ollama': pulled with the user's Ollama. 'atlas': Atlas's own model installer. */
    mode: 'managed' | 'manual' | 'ollama' | 'atlas'
    instructions?: string[]
    /** Why Atlas cannot install it itself, when that is so (a licence that needs a login, for example). */
    manualReason?: string
    pullName?: string
    approxBytes?: number
  }
  /** Where Atlas's older Create, Edit and Upscale packages are the same thing, so installed state is shared. */
  legacyPackage?: 'create' | 'edit' | 'upscale'
  added?: string
  deprecated?: boolean
}


export type Arch = 'x64' | 'arm64' | 'other'
export type MemoryKind = 'dedicated' | 'unified' | 'shared' | 'none'
export type GpuFamily = 'blackwell' | 'ada' | 'ampere' | 'turing' | 'pascal' | 'older-nvidia' | 'rdna' | 'intel-arc' | 'integrated' | 'unknown'

export interface GpuInfo {
  name: string
  vendor: 'nvidia' | 'amd' | 'intel' | 'other'
  family: GpuFamily
  /** For example "RTX 50", "RTX 20". */
  series: string | null
  computeCapability: string | null
  /** Dedicated graphics memory in GB; null when the memory is unified or shared. */
  vramGB: number | null
  memoryKind: MemoryKind
  driver: string | null
  /** The newest CUDA the driver supports, when the driver says. */
  cudaDriver: string | null
}

/** Which numeric precisions the card computes natively (a model stored in a precision the card lacks runs slower or not at all). */
export interface Precisions {
  fp16: boolean
  bf16: boolean
  fp8: boolean
  fp4: boolean
}

export interface RuntimeCompat {
  /** Whether Atlas can install and run its own ComfyUI here. */
  managedComfy: 'supported' | 'untested' | 'unsupported'
  managedComfyReason: string
  /** Whether a ComfyUI that is already installed (on this computer or elsewhere) can be used. */
  connectComfy: 'supported' | 'untested' | 'unsupported'
  notes: string[]
}

export type Tier = 'none' | 'entry' | 'mainstream' | 'high' | 'workstation'

export interface HardwareProfile {
  /** Set when the profile is a simulation (a preview of another computer), never for the real one. */
  simulated: string | null
  os: { platform: string; release: string; windowsBuild: number | null }
  /** The architecture of the computer itself. */
  arch: Arch
  /** The architecture Atlas is running as; differs from `arch` when it runs emulated. */
  appArch: Arch
  emulated: boolean
  cpu: { name: string; cores: number }
  ramGB: number
  gpus: GpuInfo[]
  primary: GpuInfo | null
  /** The memory a model can actually use, in GB, and why that number. */
  modelMemoryGB: number | null
  memoryNote: string
  precisions: Precisions
  tier: Tier
  runtime: RuntimeCompat
}

export const TIER_LABEL: Record<Tier, string> = { none: 'No usable graphics card', entry: 'Entry level', mainstream: 'Mainstream', high: 'High performance', workstation: 'Workstation class' }

export type FitLevel = 'recommended' | 'works' | 'slow' | 'too-big' | 'incompatible'
export const FIT_LABEL: Record<FitLevel, string> = {
  recommended: 'Recommended for this computer',
  works: 'Works on this computer',
  slow: 'Works, but slowly',
  'too-big': 'Too large for this computer',
  incompatible: 'Not compatible with this computer'
}
const RANK: Record<FitLevel, number> = { recommended: 4, works: 3, slow: 2, 'too-big': 1, incompatible: 0 }

export interface Fit {
  level: FitLevel
  label: string
  /** The build chosen for this computer, for entries that have several. */
  variant: string | null
  variantLabel: string | null
  /** The requirements that decided it, in plain words (good news first). */
  reasons: string[]
  /** True when a test listed in the entry ran on this kind of graphics card. */
  testedHere: boolean
  /** The tests that ran on this kind of card, when any did. */
  testedNote: string | null
}


// ---- what the interface is shown ----------------------------------------------------------------------------------------------

export type EntryStateKind = 'installed' | 'found-in-comfyui' | 'partial' | 'not-installed' | 'unknown'

export interface EntryFileState {
  key: string
  name: string
  folder: string
  bytes: number
  /** 'installed': by Atlas in its own models folder. 'found': in the ComfyUI Atlas is connected to (not installed by Atlas). */
  status: 'installed' | 'found' | 'partial' | 'missing'
  partialBytes: number
}

export interface InstallPlan {
  /** Entries that will be installed, dependencies first. */
  entries: Array<{ id: string; name: string }>
  files: Array<{ key: string; name: string; folder: string; bytes: number; url: string; entryId: string; needed: boolean }>
  downloadBytes: number
  /** Disk space the files take once installed. */
  diskBytes: number
  /** Free space on the drive that holds Atlas's AI folder, when known. */
  freeBytes: number | null
  /** Where the files will be put. */
  destination: string | null
  licences: Array<{ entryId: string; name: string; url: string; commercialUse: 'yes' | 'conditions' | 'no'; acceptance?: string }>
  /** Things to know before agreeing (replaced files, a slow card, a licence that restricts use). */
  warnings: string[]
}

export type InstallWay = 'atlas' | 'ollama' | 'manual' | 'atlas-model' | 'unavailable'

export interface EntryView {
  entry: CatalogEntry
  fit: Fit
  state: { kind: EntryStateKind; files: EntryFileState[]; where: string | null; note: string | null }
  /** How it can be installed here, and why not when it cannot. */
  way: InstallWay
  wayNote: string | null
  plan: InstallPlan | null
  /** Official steps, with this computer's folders filled in, when Atlas cannot (or should not) install it itself. */
  instructions: string[]
  /** Other entries that are needed and not installed. */
  missingDependencies: string[]
}

export interface LibraryOverview {
  hardware: HardwareProfile
  /** Computers Atlas can preview recommendations for. */
  simulations: Array<{ id: string; label: string }>
  mode: 'none' | 'managed' | 'connect'
  /** Atlas's own AI folder, and what the drive has free. */
  root: string | null
  freeBytes: number | null
  comfy: { connected: boolean; kind: 'managed' | 'local' | 'remote' | 'none'; folder: string | null; version: string | null; note: string | null }
  ollama: { running: boolean; models: string[] }
  entries: EntryView[]
  /** Definitions that were refused, with the reasons. */
  problems: string[]
  userFolder: string | null
  userEntries: string[]
}
