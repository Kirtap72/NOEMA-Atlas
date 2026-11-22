// The Smart Organizer: analyses a (large) set of pictures, proposes a folder structure with meaningful names, lets the
// user refine it (also by conversation) and exports it by COPYING to a folder of their choice. Originals are never moved,
// renamed or deleted.

export type OrganizeKind = 'artwork' | 'photograph' | 'technical' | 'experiment' | 'uncertain'
export const ORGANIZE_KINDS: OrganizeKind[] = ['artwork', 'photograph', 'experiment', 'technical', 'uncertain']
export const KIND_LABELS: Record<OrganizeKind, string> = {
  artwork: 'Finished artwork',
  photograph: 'Photographs',
  experiment: 'Experiments',
  technical: 'Screenshots and technical images',
  uncertain: 'To review (uncertain)'
}
/** One sentence on what each kind means, shown next to its count. */
export const KIND_NOTES: Record<OrganizeKind, string> = {
  artwork: 'Paintings, illustrations, renders and AI artworks that look finished.',
  photograph: 'Pictures with camera data, or that look like photographs and carry it.',
  experiment: 'Tests, glitches and unusual material that looks like exploration.',
  technical: 'Software screenshots, texture sheets, test renders and other working images.',
  uncertain: 'Atlas could not tell. Often photographic-looking pictures without camera data (a photo with its details removed, or a realistic generated image). Look and decide.'
}

/** How the exported folders are arranged. */
export type StructurePreset = 'kind-subject' | 'subject' | 'year-subject' | 'kind' | 'flat'
export const STRUCTURE_LABELS: Record<StructurePreset, { label: string; example: string }> = {
  'kind-subject': { label: 'Kind, then subject', example: 'Photographs / Misty mountain scenes' },
  subject: { label: 'Subject only', example: 'Misty mountain scenes' },
  'year-subject': { label: 'Year, then subject', example: '2025 / Misty mountain scenes' },
  kind: { label: 'Kind only', example: 'Photographs' },
  flat: { label: 'One folder', example: 'everything together' }
}

/** What to do with copies of the same picture and versions of it. */
export type DuplicatePolicy = 'separate' | 'best-only' | 'keep-all'
export const DUPLICATE_LABELS: Record<DuplicatePolicy, { label: string; note: string }> = {
  separate: { label: 'Best version in place, others set apart', note: 'The best of each group goes where it belongs; the others are copied to “Duplicates and versions”, so nothing is left out.' },
  'best-only': { label: 'Only the best version', note: 'Only the best of each group is copied. The others are listed in the report and stay where they are.' },
  'keep-all': { label: 'Keep every version together', note: 'Every version is copied to the same folder.' }
}

export interface OrganizeScope {
  /** The whole library. */
  all?: boolean
  /** Sources (the folders added to Atlas, drives included) by id. */
  rootIds?: string[]
  /** Folders inside the library, by path (everything under them). */
  folders?: string[]
  /** An explicit set of pictures. */
  imageIds?: string[]
}

export interface CustomCategory {
  /** The folder name. */
  name: string
  /** What belongs in it, in plain words; matched against what the pictures look like. */
  description: string
}

export interface OrganizeSettings {
  structure: StructurePreset
  duplicates: DuplicatePolicy
  /** Kinds that are not exported at all. */
  excludeKinds: OrganizeKind[]
  /** Renames of automatic folder names, keyed `kind|automatic name`. */
  renames: Record<string, string>
  /** Folders folded into another, keyed `kind|automatic name` → target name. */
  merges: Record<string, string>
  /** The user's own categories. */
  custom: CustomCategory[]
  /** Pictures the user placed by hand. */
  overrides: Record<string, { kind?: OrganizeKind; subject?: string }>
  /** Folders with fewer pictures than this are collected in “Other”. */
  minGroup: number
  /** Pictures of one automatic kind that the user decided to treat as another (for example all uncertain ones as artwork). */
  kindMap: Partial<Record<OrganizeKind, OrganizeKind>>
  /**
   * The folders (groups) the user checked, as `kind|folder name`. When there are any, ONLY these are copied or moved; unchecked groups are
   * never included. When there are none, nothing is selected: an empty selection is never read as everything, and copying or moving is refused.
   */
  selection: string[]
  /** What the last export did: copy keeps the originals where they are, move relocates them and keeps their Atlas records. */
  exportMode: 'copy' | 'move'
}

/** The identity of a group in `selection`. */
export const groupKey = (kind: OrganizeKind, name: string): string => `${kind}|${name}`

export const DEFAULT_SETTINGS: OrganizeSettings = {
  structure: 'kind-subject',
  duplicates: 'separate',
  excludeKinds: [],
  renames: {},
  merges: {},
  custom: [],
  overrides: {},
  minGroup: 3,
  kindMap: {},
  selection: [],
  exportMode: 'copy'
}

export type OrganizeStatus = 'draft' | 'analyzing' | 'paused' | 'ready' | 'exporting' | 'export-paused' | 'done' | 'failed' | 'cancelled'

export type OrganizePhase = 'facts' | 'understanding' | 'grouping' | 'duplicates' | 'done'
export const PHASE_LABELS: Record<OrganizePhase, string> = {
  facts: 'Reading the files',
  understanding: 'Telling the kinds of pictures apart',
  grouping: 'Grouping by subject and style',
  duplicates: 'Looking for copies and versions',
  done: 'Done'
}

export interface OrganizeProgress {
  planId: string
  status: OrganizeStatus
  phase: OrganizePhase
  done: number
  total: number
  message: string
}

export interface OrganizePlanInfo {
  id: string
  name: string
  status: OrganizeStatus
  scope: OrganizeScope
  settings: OrganizeSettings
  total: number
  progress: OrganizeProgress | null
  /** How many of the pictures the image model has looked at (the rest are grouped by file facts only). */
  understood: number
  createdAt: number
  updatedAt: number
  destination: string | null
}

export interface OrganizeCategory {
  /** The folder name as it will appear. */
  name: string
  /** The automatic name this came from, for renaming and merging. */
  key: string
  count: number
  confidence: 'clear' | 'loose' | 'mixed' | 'custom' | null
  /** Why it has this name, in a sentence. */
  note: string
  sampleIds: string[]
}

export interface OrganizeKindGroup {
  kind: OrganizeKind
  label: string
  count: number
  excluded: boolean
  categories: OrganizeCategory[]
}

export interface DuplicateGroupInfo {
  id: string
  type: 'exact' | 'near' | 'versions'
  /** The version Atlas suggests keeping, and why. */
  bestId: string
  why: string
  memberIds: string[]
}

export interface OrganizeOverview {
  plan: OrganizePlanInfo
  kinds: OrganizeKindGroup[]
  duplicates: { groups: number; extras: number; exact: number; near: number; versions: number; sample: DuplicateGroupInfo[] }
  /** Pictures without an image-model reading (grouped by file facts only). */
  withoutModel: number
  /** The folder tree that would be exported, as paths with counts (one level of detail per preset). */
  tree: Array<{ path: string; count: number }>
  /** What is checked: the groups, how many pictures they hold and how many bytes. `all` is always false: nothing checked means nothing selected. */
  selection: { keys: string[]; groups: number; pictures: number; bytes: number; all: boolean }
}

export interface OrganizeOpPreview {
  imageId: string
  from: string
  /** The destination relative to the chosen folder. */
  to: string
  bytes: number
  /** Why it is not simply copied. */
  note?: string
  action: 'copy' | 'skip-same' | 'skip-excluded' | 'skip-duplicate'
}

export interface OrganizePreview {
  planId: string
  destination: string
  /** Copy or move, and how many pictures the choice covers (none when nothing is checked). */
  mode: 'copy' | 'move'
  selectedPictures: number
  selectedGroups: number
  /** True when nothing is checked, so all pictures of the plan are included. */
  everything: boolean
  total: number
  copy: number
  copyBytes: number
  skipped: { same: number; excluded: number; duplicates: number }
  /** Free space at the destination, or null when it could not be read. */
  freeBytes: number | null
  enoughSpace: boolean
  /** Files that would have the same name in the same folder, or that exist already. Each is renamed, never overwritten. */
  conflicts: Array<{ to: string; reason: string; renamedTo: string }>
  warnings: string[]
  /** A page of the operations. */
  sample: OrganizeOpPreview[]
  tree: Array<{ path: string; count: number }>
}

export type ExportOpStatus = 'pending' | 'copying' | 'copied' | 'verified' | 'skipped' | 'failed'

export interface ExportReport {
  planId: string
  destination: string
  startedAt: number
  finishedAt: number | null
  total: number
  verified: number
  copied: number
  skipped: number
  failed: number
  bytes: number
  verification: 'size' | 'hash'
  mode: 'copy' | 'move'
  /** Moves only: how many originals were relocated and no longer exist at their old place. */
  moved: number
  failures: Array<{ from: string; to: string; error: string }>
  renamed: number
  status: 'running' | 'paused' | 'done' | 'cancelled' | 'failed'
}
