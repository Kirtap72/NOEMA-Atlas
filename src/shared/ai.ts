// Types for the optional AI components of the Creative Studio: how ComfyUI is provided and which capability packages are installed.

export type AiMode = 'none' | 'connect' | 'managed'
export type CapabilityId = 'create' | 'edit' | 'upscale' | 'reference'

export interface LicenseNote {
  name: string
  url: string
  /** One plain sentence on what it means for the user. */
  summary: string
}

export interface PackageFileInfo {
  name: string
  /** ComfyUI's folder for this kind of model, for example "checkpoints". */
  folder: string
  bytes: number
  installed: boolean
  /** Bytes already downloaded of a download that was interrupted. */
  partial: number
}

export interface AiPackageInfo {
  id: CapabilityId
  name: string
  /** What it lets the user do, in plain words. */
  summary: string
  /** Longer explanation of how it works and what to expect. */
  details: string
  files: PackageFileInfo[]
  /** Total download size, counting only files not yet installed. */
  downloadBytes: number
  /** Disk space the package uses when installed. */
  diskBytes: number
  /** A comfortable amount of graphics memory, in gigabytes. */
  vramGB: number
  licenses: LicenseNote[]
  state: 'not-installed' | 'partial' | 'installed'
  /** Other packages it relies on, installed together with it. */
  needs: CapabilityId[]
}

export interface HardwareInfo {
  gpu: { name: string; vendor: 'nvidia' | 'amd' | 'intel' | 'other'; vramGB: number | null; driver: string | null } | null
  platform: string
  /** Whether Atlas can install and run its own ComfyUI on this computer. */
  supported: boolean
  /** In plain words, why not, or a note about speed. */
  note: string | null
}

export interface RuntimeInfo {
  state: 'not-installed' | 'installing' | 'ready' | 'broken'
  version: string | null
  folder: string | null
  /** Bytes the runtime uses on disk (estimated before it is installed). */
  diskBytes: number
  downloadBytes: number
  /** A newer ComfyUI is available than the one installed, or null if unknown or current. */
  updateTo: string | null
  variant: 'nvidia' | 'amd' | 'intel'
}

export interface AiJob {
  kind: 'runtime' | 'packages' | 'update' | 'verify'
  stage: 'preparing' | 'downloading' | 'verifying' | 'unpacking' | 'configuring' | 'starting' | 'done' | 'failed' | 'stopped'
  message: string
  /** What is being worked on right now, for example a file name. */
  item: string | null
  doneBytes: number
  totalBytes: number | null
  /** Overall 0..1 where known. */
  fraction: number | null
  /** Files finished and files in the job. */
  step: number
  steps: number
  /** Bytes per second over the last few seconds. */
  speed: number | null
}

export interface AiStatus {
  mode: AiMode
  hardware: HardwareInfo
  /** The folder Atlas keeps its own AI in (managed mode), and what is free on that drive. */
  root: string | null
  freeBytes: number | null
  /** A suggested folder on the drive with the most free space. */
  suggestedRoot: string | null
  runtime: RuntimeInfo
  packages: AiPackageInfo[]
  job: AiJob | null
  /** The last problem, in plain words. */
  problem: string | null
}

export interface RuntimeInstallRequest {
  /** The folder to keep Atlas's own AI in. */
  root: string
  /** The user agreed to download and install, with these licences and sizes shown. */
  consent: boolean
}

export interface PackageInstallRequest {
  ids: CapabilityId[]
  consent: boolean
}

/** What Atlas can make and edit right now, for the Studio and the companion. */
export interface Capability {
  id: CapabilityId
  label: string
  ready: boolean
  /** The way it will be done, in plain words ("ComfyUI, with your Clarity presets"). */
  how: string | null
  /** The ways available (for choosing between), most suitable first. */
  options: Array<{ id: string; label: string; kind: 'offline' | 'local' | 'cloud'; note: string }>
  /** What is missing, in plain words, and what would fix it. */
  missing: string | null
  /** Which package would fix it, when one would. */
  offer: CapabilityId | null
}
