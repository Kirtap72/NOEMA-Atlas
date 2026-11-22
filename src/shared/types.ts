import type { AiJob, AiMode, AiStatus, Capability, PackageInstallRequest, RuntimeInstallRequest } from './ai'
import type { CompanionView } from './curation'
import type { DuplicateGroupInfo, DuplicatePolicy, ExportReport, OrganizeOverview, OrganizePlanInfo, OrganizePreview, OrganizeProgress as SmartOrganizeProgress, OrganizeScope, OrganizeSettings } from './organizer'
import type { SmartCollection, SmartCollectionInput, SmartCriteria, SmartPreview } from './smart'
import type { DiscoveryOptions, DiscoveryProgress, DiscoveryResult, DriveInfo } from './discovery'
import type { InstallPlan, LibraryOverview } from './modelLibrary'
import type { ArtworkConcept, ComfyStatus, ConceptRequest, EditRegion, EditRequest, ExternalCandidate, ExternalEditSession, GenerateRequest, GenerationRecord, ProvenanceInfo, ReferencePipelineInfo, RetouchRequest, StudioEstimate, StudioProgress, StudioResult, StudioSettings, StudioSettingsUpdate, UpscaleRequest } from './studio'
import type {
  AssistantChat,
  AssistantChatSummary,
  AssistantProgress,
  AssistantReply,
  AssistantSettings,
  AssistantSettingsUpdate,
  AssistantTestResult,
  LocalServer
} from './assistant'

export type ImageScope = 'collection' | 'favorites' | 'archive' | 'review' | 'moodboard'

export type ImageSort = 'curated' | 'recent' | 'captured' | 'rating' | 'name' | 'folder' | 'size'

export type ImageDecision = 'keep' | 'pass'

export interface ImageItem {
  id: string
  filename: string
  folder: string
  path: string
  ext: string
  bytes: number
  width: number
  height: number
  mtime: number
  addedAt: number
  favorite: boolean
  favoriteAt: number | null
  rating: number
  tags: string[]
  reviewedAt: number | null
  decision: ImageDecision | null
  missing: boolean
  color: string | null
  thumbStatus: 'ready' | 'error' | 'pending'
  thumbUrl: string
  fullUrl: string
}

export interface ImageQuery {
  scope: ImageScope
  search?: string
  rootId?: string | null
  minRating?: number
  exactRating?: number
  decision?: ImageDecision
  unreviewed?: boolean
  includeMissing?: boolean
  sort?: ImageSort
  limit?: number
  offset?: number
  moodboardId?: string
  /** Treat `search` as a description of what the images look like, matched against the image embeddings. */
  visual?: boolean
  /** Find images that look like this one. Takes precedence over `search`. */
  similarTo?: string
  /** Only images in this family, most typical first. */
  familyId?: number
  /** Only images in this smart collection, best match first. */
  smartId?: string
  /** Only images Atlas indexed between these times (milliseconds), whatever the dates of the files themselves. */
  addedFrom?: number
  addedTo?: number
}

/** A group of pictures Atlas indexed close together: one import or scan. */
export interface ImportBatch {
  from: number
  to: number
  count: number
  roots: string[]
}

export interface ImageFamily {
  id: number
  size: number
  /** Mean similarity of the members to the family centre, 0 to 1. Higher means more alike. */
  cohesion: number
  covers: ImageItem[]
  /** The name shown: the user's own name if they chose one, otherwise the automatic one, otherwise null (not named yet). */
  name: string | null
  /** The name Atlas made from what the images share. */
  autoName: string | null
  /** The name the user gave, or null. */
  customName: string | null
  /** How sure the automatic name is: 'mixed' means the images share no single subject, mood or style. */
  nameConfidence: 'clear' | 'loose' | 'mixed' | null
  /** The strongest things the images have in common. */
  keywords: string[]
  /** One sentence on what the automatic name is based on. */
  nameNote: string | null
}

export interface FamilyList {
  families: ImageFamily[]
  building: boolean
  /** Images that were clustered, and how many are embedded now. */
  clustered: number
  embedded: number
}

export interface ImagePage {
  items: ImageItem[]
  total: number
  offset: number
  limit: number
}

export interface RootFolder {
  id: string
  path: string
  name: string
  addedAt: number
  lastScanAt: number | null
  imageCount: number
  missingCount: number
  scanning: boolean
}

export interface Moodboard {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  imageCount: number
  coverIds: string[]
}

export interface MoodboardDetail extends Moodboard {
  images: MoodboardImage[]
}

export interface BoardPlacement {
  x: number
  y: number
  width: number
  height: number
  z?: number
}

export interface MoodboardImage extends ImageItem {
  x: number
  y: number
  layoutWidth: number
  layoutHeight: number
  z: number
}

export interface BoardImagePlacement extends BoardPlacement {
  imageId: string
}

export interface LibraryStats {
  images: number
  favorites: number
  unreviewed: number
  missing: number
  roots: number
  moodboards: number
  totalBytes: number
}

export interface Bootstrap {
  stats: LibraryStats
  roots: RootFolder[]
  moodboards: Moodboard[]
  scan: ScanState | null
  app: AppInfo
}

export interface AppInfo {
  version: string
  dataDir: string
  libraryDb: string
  thumbnailsDir: string
  platform: string
}

export type ScanPhase = 'queued' | 'walking' | 'processing' | 'finalizing' | 'done' | 'cancelled' | 'error'

export interface ScanState {
  rootId: string
  rootName: string
  phase: ScanPhase
  queued: number
  discovered: number
  processed: number
  added: number
  updated: number
  skipped: number
  errors: number
  currentFile: string | null
  message: string | null
  startedAt: number
  finishedAt: number | null
}

export interface ScanEvent {
  state: ScanState
  error?: string
}

export type IndexState = 'unavailable' | 'disabled' | 'idle' | 'loading' | 'running' | 'paused' | 'error'

export interface IndexStatus {
  state: IndexState
  enabled: boolean
  modelInstalled: boolean
  provider: 'directml' | 'cpu' | null
  indexed: number
  total: number
  imagesPerSecond: number
  message: string | null
}

export type ModelInstallState = 'idle' | 'downloading' | 'verifying' | 'installed' | 'error' | 'cancelled'

/** The user's decision about Atlas's local AI features. Nothing is downloaded or run before they choose. */
export type AiChoice = 'unset' | 'enabled' | 'declined'

export interface ModelStatus {
  state: ModelInstallState
  installed: boolean
  choice: AiChoice
  receivedBytes: number
  totalBytes: number
  bytesPerSecond: number
  currentFile: string | null
  error: string | null
  modelDir: string
}

export type TasteStage = 'start' | 'sketch' | 'growing' | 'steady'

export interface TasteDimension {
  id: string
  axis: string
  axisLabel: string
  pole: 'a' | 'b'
  label: string
  description: string
  /** How much more of this quality the images you chose show than the ones you passed over, in library standard deviations. */
  lean: number
  /** 99% interval for `lean`. */
  low: number
  high: number
  /** True when the interval excludes zero: the signal is more than chance. */
  certain: boolean
  /** Comparisons where the two pictures clearly differed on this quality, and how often you chose the stronger one. */
  clear: number
  agreed: number
}

export interface TasteState {
  /** False when the AI features are off, the model is missing, or too few images have been learned. */
  available: boolean
  reason: string | null
  embedded: number
  /** Direct choices, skipped pairs, and pairs inferred from existing Keep/Pass decisions and star ratings. */
  choices: number
  /** How many of them are unbiased (not picked because they were hard) and therefore feed the compass. */
  compassChoices: number
  /** Library images left out of comparisons because they look like screenshots or technical images. */
  excluded: number
  skipped: number
  inferred: { decisions: number; ratings: number }
  /** Cross-validated accuracy at predicting your choices, or null while there are too few. */
  accuracy: number | null
  accuracyChoices: number
  stage: TasteStage
  /** Direct choices needed before recommendations unlock. */
  unlocksAt: number
  canRecommend: boolean
  dimensions: TasteDimension[]
}

/** How a pair was picked. 'uncertain' pairs are chosen because Atlas is unsure, so they are left out of the compass. */
export type TastePairMode = 'warm' | 'explore' | 'random' | 'uncertain'

export interface TastePair {
  a: ImageItem
  b: ImageItem
  round: number
  mode: TastePairMode
}

export interface TasteStep {
  state: TasteState
  next: TastePair | null
}

export interface TasteRecommendation {
  image: ImageItem
  /** Where this image ranks among the whole library by your learned taste (100 = the very top). */
  percentile: number
  /** The image you chose that this one looks most like. */
  because: ImageItem | null
}

export interface TasteRecommendations {
  items: TasteRecommendation[]
  trainedOn: number
  message: string | null
}

export interface TasteExamples {
  dimensionId: string
  /** Images you chose that show this quality most. */
  yours: ImageItem[]
  /** What the quality looks like across your library. */
  library: ImageItem[]
}

// ---- Artistic discovery (reference collection, identity, discovered taste, journeys) ----------------------------

export interface ReferenceWork {
  id: string
  title: string
  artist: string
  artistInfo: string
  date: string
  culture: string
  period: string
  classification: string
  medium: string
  department: string
  credit: string
  museum: 'aic' | 'cma' | 'met'
  museumName: string
  objectUrl: string
  shelf: string
  shelfLabel: string
  group: string
  region: number
  /** Position on the map of the collection, 0 to 1. */
  x: number
  y: number
  width: number
  height: number
  imageUrl: string
  license: string
}

export interface ReferenceInfo {
  available: boolean
  name: string
  version: string
  works: number
  shelves: Array<{ id: string; label: string; group: string; count: number }>
  regions: Array<{ id: number; label: string; count: number }>
  museums: Array<{ code: string; name: string; policy: string; works: number }>
  license: { id: string; name: string; url: string }
}

/** One measured quality (the same twelve as the Taste Compass) for a profile, with the evidence behind it. */
export interface ProfileDimension {
  id: string
  label: string
  axis: string
  axisLabel: string
  pole: 'a' | 'b'
  /** Average position of the images, in standard deviations relative to the reference collection (0 = typical of art in general). */
  mean: number
  low: number
  high: number
  /** True when the 99% interval excludes zero and the effect is not trivially small. */
  certain: boolean
  n: number
}

export interface ProfileMode {
  id: number
  label: string
  size: number
  /** Share of the profile's images that fall in this mode, 0 to 1. */
  share: number
  tentative: boolean
  examples: Array<ImageItem | ReferenceWork>
  /** The qualities this mode shows reliably, strongest first. */
  characteristics: ProfileDimension[]
  /** Reference works that look closest to this mode, with their own provenance. */
  kindred: ReferenceWork[]
  /** Museum shelves the closest reference works come from. */
  kindredShelves: Array<{ id: string; label: string; count: number }>
}

export interface IdentityState {
  available: boolean
  reason: string | null
  favorites: number
  /** Favorites whose embeddings exist, and favorites Atlas has not learned yet. */
  learned: number
  pending: number
  tentative: boolean
  modes: ProfileMode[]
  dimensions: ProfileDimension[]
}

export type DiscoveryResponse = 'prefer' | 'both' | 'neither' | 'undecided'
export type DiscoveryPhase = 'orient' | 'refine' | 'mode' | 'stretch'

export interface DiscoveryPair {
  a: ReferenceWork
  b: ReferenceWork
  round: number
  phase: DiscoveryPhase
}

export interface DiscoveryState {
  available: boolean
  reason: string | null
  counts: { prefer: number; both: number; neither: number; undecided: number; likes: number; dislikes: number; saves: number }
  /** Answers that carry information about taste (everything except "can't decide"). */
  informative: number
  stage: 'start' | 'sketch' | 'growing' | 'steady'
  /** Cross-validated accuracy of predicting new answers, or null while there are too few. */
  accuracy: number | null
  accuracyAnswers: number
  modes: ProfileMode[]
  dimensions: ProfileDimension[]
  coverage: { worksSeen: number; worksTotal: number; regionsSeen: number; regionsTotal: number }
  /** True when there is enough to offer a Discovery Journey. */
  canJourney: boolean
}

export interface DiscoveryStep {
  state: DiscoveryState
  next: DiscoveryPair | null
}

export type RegionStatus = 'shared' | 'identity' | 'discovered' | 'promising' | 'unexplored' | 'passed'

export interface CompareRegion {
  id: number
  label: string
  count: number
  /** Your favorites that sit in this region, and the works you liked or passed on while exploring. */
  favorites: number
  liked: number
  passed: number
  seen: number
  /** Average predicted appeal for this region, as a percentile of the whole collection, when a model exists. */
  appeal: number | null
  status: RegionStatus
  examples: ReferenceWork[]
  centre: { x: number; y: number }
}

export type DimensionRelation = 'shared' | 'identity' | 'discovered' | 'divergent' | 'unclear'

export interface CompareDimension {
  /** The axis is shown as one row; positive values lean towards `label` (pole A), negative towards `oppositeLabel` (pole B). */
  id: string
  label: string
  oppositeLabel: string
  axisLabel: string
  pole: 'a' | 'b'
  identity: ProfileDimension | null
  discovered: ProfileDimension | null
  relation: DimensionRelation
  /** A plain-language statement of what the evidence supports, always including its limits. */
  statement: string
  identityExamples: ImageItem[]
  discoveredExamples: ReferenceWork[]
}

export interface MapPoint {
  x: number
  y: number
  id: string
  kind: 'favorite' | 'liked' | 'passed'
}

export interface CompareState {
  available: boolean
  reason: string | null
  identity: IdentityState
  discovery: DiscoveryState
  dimensions: CompareDimension[]
  regions: CompareRegion[]
  points: MapPoint[]
  /** Reference works for the map: position and shelf only, so the whole collection can be drawn. */
  map: Array<{ id: string; x: number; y: number; region: number }>
  headline: string[]
}

export interface JourneyWork {
  work: ReferenceWork
  /** Why this work is here, as measured facts and museum metadata. Never an art-historical claim. */
  why: string[]
  /** 'familiar' sits near what you have told Atlas; 'stretch' deliberately goes beyond it. */
  role: 'familiar' | 'neighbour' | 'quality' | 'stretch' | 'tour'
}

export interface JourneyChapter {
  title: string
  intro: string
  stretch: boolean
  works: JourneyWork[]
}

export interface Journey {
  id: string
  createdAt: number
  title: string
  subtitle: string
  seed: { kind: 'tour' | 'mode' | 'identity' | 'emerging' | 'unexplored' | 'work'; label: string; ref?: string | number }
  chapters: JourneyChapter[]
  /** Facts about how it was made, for honesty: which evidence it used and how much of it goes beyond known taste. */
  basis: string[]
  /** 0 to 1: the share of works outside regions you have already confirmed. */
  explorationShare: number
  feedback: Record<string, 'like' | 'dislike' | 'save'>
  progress: number
  finished: boolean
}

export interface JourneySuggestion {
  seed: Journey['seed']
  title: string
  reason: string
  /** How sure Atlas is that this direction matters to you. */
  evidence: string
}

export interface HistorySnapshot {
  id: number
  at: number
  identity: { favorites: number; dimensions: Array<{ id: string; mean: number; certain: boolean }>; modes: number }
  discovered: { answers: number; dimensions: Array<{ id: string; mean: number; certain: boolean }>; modes: number }
  /** Discoveries (works liked, saved or preferred) since the previous snapshot. */
  discoveries: ReferenceWork[]
  reconstructed: boolean
}

export interface HistoryState {
  snapshots: HistorySnapshot[]
  /** Dimensions whose position moved clearly between the first and latest snapshot, with the sign of the change. */
  changes: Array<{ id: string; label: string; profile: 'identity' | 'discovered'; from: number; to: number }>
  note: string
}

export interface SavedDiscovery {
  imageId: string
  path: string
  work: ReferenceWork
}

export interface UpdateImageInput {
  id: string
  favorite?: boolean
  rating?: number
  tags?: string[]
  reviewed?: boolean
  decision?: ImageDecision | null
}

export interface AddImagesToBoardInput {
  moodboardId: string
  imageIds: string[]
  placements?: BoardImagePlacement[]
}

export interface ReorderBoardInput {
  moodboardId: string
  imageIds: string[]
}

export interface UpdateBoardItemInput {
  moodboardId: string
  imageId: string
  x: number
  y: number
  width: number
  height: number
  z?: number
}

export type OrganizeMode = 'copy' | 'move'

export type OrganizeSelection =
  | { kind: 'keep' }
  | { kind: 'pass' }
  | { kind: 'stars'; minRating: number }
  | { kind: 'all' }
  | { kind: 'manual'; ids: string[] }

export interface OrganizeRequest {
  selection: OrganizeSelection
  destination: string
  mode: OrganizeMode
}

export interface OrganizeItemResult {
  id: string
  filename: string
  status: 'copied' | 'moved' | 'skipped' | 'failed'
  destinationPath?: string
  finalName?: string
  renamed?: boolean
  error?: string
}

export interface OrganizeProgress {
  processed: number
  total: number
  currentFile: string | null
  mode: OrganizeMode
  copied: number
  moved: number
  renamed: number
  skipped: number
  failed: number
}

export interface OrganizeResult {
  mode: OrganizeMode
  destination: string
  total: number
  copied: number
  moved: number
  renamed: number
  skipped: number
  failed: number
  items: OrganizeItemResult[]
}

export interface FolderAddResult {
  roots: RootFolder[]
  /** Folders that became new sources. */
  added: string[]
  /** Folders that already were sources. */
  existing: string[]
  rejected: Array<{ path: string; reason: string }>
  /** Folders that lie inside a source Atlas already has: they are part of it, and that source is checked again. */
  covered?: Array<{ path: string; rootId: string; rootName: string }>
  /** The sources that were queued for scanning, with the name to use when reporting what was found. */
  scanning?: Array<{ rootId: string; rootName: string; why: 'added' | 'existing' | 'covered' }>
  /** The folder dialog was closed without choosing anything. */
  canceled?: boolean
}

export type ThemePreference = 'dark' | 'light' | 'system'

export interface AtlasApi {
  bootstrap(): Promise<Bootstrap>
  listImages(query: ImageQuery): Promise<ImagePage>
  /** The most recent imports (pictures indexed close together), newest first. */
  listImports(): Promise<ImportBatch[]>
  getImage(id: string): Promise<ImageItem | null>
  updateImage(input: UpdateImageInput): Promise<ImageItem>
  revealImage(id: string): Promise<void>
  chooseFolders(): Promise<FolderAddResult>
  addFolders(paths: string[]): Promise<FolderAddResult>
  rescanRoot(rootId: string): Promise<void>
  cancelScan(): Promise<void>
  removeRoot(rootId: string): Promise<void>
  listMoodboards(): Promise<Moodboard[]>
  getMoodboard(id: string): Promise<MoodboardDetail | null>
  moodboardsForImage(imageId: string): Promise<string[]>
  createMoodboard(name: string): Promise<Moodboard>
  renameMoodboard(id: string, name: string): Promise<Moodboard>
  deleteMoodboard(id: string): Promise<void>
  addToMoodboard(input: AddImagesToBoardInput): Promise<Moodboard>
  removeFromMoodboard(moodboardId: string, imageId: string): Promise<Moodboard>
  reorderMoodboard(input: ReorderBoardInput): Promise<Moodboard>
  updateBoardItem(input: UpdateBoardItemInput): Promise<MoodboardDetail>
  chooseOrganizeDestination(): Promise<string | null>
  organize(request: OrganizeRequest): Promise<OrganizeResult>
  onOrganizeProgress(callback: (progress: OrganizeProgress) => void): () => void
  openDataFolder(): Promise<void>
  windowMinimize(): void
  windowToggleMaximize(): void
  windowClose(): void
  windowIsMaximized(): Promise<boolean>
  listFamilies(): Promise<FamilyList>
  rebuildFamilies(): Promise<FamilyList>
  assistantSettings(): Promise<AssistantSettings>
  assistantUpdateSettings(change: AssistantSettingsUpdate): Promise<AssistantSettings>
  assistantTest(): Promise<AssistantTestResult>
  assistantDetectLocal(): Promise<LocalServer[]>
  assistantChats(): Promise<AssistantChatSummary[]>
  assistantChat(id: string): Promise<AssistantChat | null>
  assistantNewChat(): Promise<AssistantChat>
  assistantDeleteChat(id: string): Promise<void>
  /** `context.viewingImageId`: the picture open in a viewer, so "this picture" means it (its name only; pixels are never sent without consent). */
  assistantSend(chatId: string | null, message: string, context?: { viewingImageId?: string | null }): Promise<AssistantReply>
  assistantStop(chatId: string): Promise<void>
  assistantProposal(chatId: string, proposalId: string, accept: boolean, options?: { selection?: string[]; name?: string; boardId?: string | null }): Promise<AssistantChat>
  studioSettings(): Promise<StudioSettings>
  studioUpdateSettings(change: StudioSettingsUpdate): Promise<StudioSettings>
  studioComfyStatus(): Promise<ComfyStatus>
  /** Opens the folder dialog for the user's ComfyUI installation and saves the choice. */
  studioComfyChooseFolder(): Promise<StudioSettings>
  studioComfyPick(what: 'python' | 'workflows'): Promise<StudioSettings>
  /** Connects to ComfyUI if it is running, otherwise starts it. */
  studioComfyStart(): Promise<StudioSettings>
  /** Stops ComfyUI, but only if Atlas started it. */
  studioComfyStop(): Promise<StudioSettings>
  studioComfyRescan(): Promise<StudioSettings>
  onComfyProgress(callback: (message: string) => void): () => void
  studioConcept(request: ConceptRequest): Promise<ArtworkConcept>
  studioEstimate(methodId: string, model: string | undefined, count: number, width: number, height: number): Promise<StudioEstimate>
  studioGenerate(request: GenerateRequest): Promise<StudioResult>
  studioStop(jobId: string): Promise<void>
  studioReferencePipelines(): Promise<ReferencePipelineInfo[]>
  modelsOverview(simulate?: string | null): Promise<LibraryOverview>
  modelsPlan(id: string, variant?: string | null, simulate?: string | null): Promise<InstallPlan>
  modelsInstall(id: string, options: { variant?: string | null; consent: boolean }): Promise<LibraryOverview>
  modelsStop(): Promise<void>
  modelsRemove(id: string): Promise<{ removed: string[]; kept: string[]; overview: LibraryOverview }>
  modelsVerify(id: string, deep: boolean): Promise<string[]>
  modelsRescan(simulate?: string | null): Promise<LibraryOverview>
  studioEdit(request: EditRequest): Promise<StudioResult>
  studioRetouch(request: RetouchRequest): Promise<StudioResult>
  onOpenModelLibrary(callback: (request: { entry?: string; search?: string; category?: string }) => void): () => void
  /** Marks finished retouch steps (kept in memory so they can be undone to) and lets go of ones no longer needed. */
  studioRetouchHold(hold: string[], release: string[]): Promise<{ held: number }>
  studioRegionPreview(imageId: string, region: EditRegion): Promise<{ overlayUrl: string; coverage: number; how: string }>
  studioVersions(imageId: string): Promise<{ seriesId: string; records: GenerationRecord[] }>
  aiStatus(): Promise<AiStatus>
  aiCapabilities(): Promise<Capability[]>
  aiSetMode(mode: AiMode): Promise<AiStatus>
  aiChooseRoot(): Promise<string | null>
  aiInstallRuntime(request: RuntimeInstallRequest): Promise<AiStatus>
  aiInstallPackages(request: PackageInstallRequest): Promise<AiStatus>
  aiStop(): Promise<void>
  aiCheckUpdate(): Promise<AiStatus>
  aiUpdate(consent: boolean): Promise<AiStatus>
  aiVerify(): Promise<string[]>
  aiUninstall(): Promise<AiStatus>
  onAiProgress(callback: (job: AiJob) => void): () => void
  studioUpscale(request: UpscaleRequest): Promise<StudioResult>
  studioEditCommit(pendingId: string): Promise<StudioResult>
  studioEditDiscard(pendingId: string): Promise<void>
  studioGenerations(boardId?: string): Promise<GenerationRecord[]>
  studioProvenance(imageId: string): Promise<ProvenanceInfo | null>
  studioExternalStart(imageId: string, editorId: string | null): Promise<ExternalEditSession>
  studioExternalImport(id: string): Promise<ExternalEditSession>
  studioExternalEnd(id: string): Promise<void>
  studioExternalSessions(): Promise<ExternalEditSession[]>
  studioExternalCandidates(id: string): Promise<ExternalCandidate[]>
  studioExternalImportFile(id: string, path: string): Promise<ExternalEditSession>
  /** Opens a file dialog and imports what the user picks; null when they cancel. */
  studioExternalChoose(id: string): Promise<ExternalEditSession | null>
  onStudioExternalEnded(callback: (payload: { id: string }) => void): () => void
  studioOpenFolder(): Promise<string>
  onStudioProgress(callback: (progress: StudioProgress) => void): () => void
  onStudioExternal(callback: (session: ExternalEditSession) => void): () => void
  discoverDrives(): Promise<{ drives: DriveInfo[]; excluded: string[] }>
  discoverChooseFolder(): Promise<string | null>
  discoverStart(options: DiscoveryOptions): Promise<DiscoveryResult>
  discoverStop(): Promise<void>
  discoverPreview(paths: string[]): Promise<string[]>
  onDiscoverProgress(callback: (progress: DiscoveryProgress) => void): () => void
  boardUndoInfo(boardId: string): Promise<{ id: string; label: string; createdAt: number } | null>
  boardUndo(boardId: string): Promise<boolean>
  boardTidy(boardId: string): Promise<void>
  organizerPlans(): Promise<OrganizePlanInfo[]>
  organizerCount(scope: OrganizeScope): Promise<number>
  organizerCreate(name: string, scope: OrganizeScope, settings?: Partial<Pick<OrganizeSettings, 'structure'>> & { duplicates?: DuplicatePolicy }): Promise<OrganizePlanInfo | null>
  organizerPlan(id: string): Promise<OrganizePlanInfo | null>
  organizerStart(id: string): Promise<OrganizePlanInfo | null>
  organizerPause(id: string): Promise<void>
  organizerCancel(id: string): Promise<void>
  organizerDelete(id: string): Promise<void>
  organizerOverview(id: string): Promise<OrganizeOverview>
  organizerGroupImages(id: string, kind: string, name: string): Promise<ImageItem[]>
  organizerImages(ids: string[]): Promise<ImageItem[]>
  organizerDuplicates(id: string, offset?: number): Promise<DuplicateGroupInfo[]>
  organizerRefine(id: string, ops: unknown[]): Promise<{ overview: OrganizeOverview; messages: string[] }>
  organizerChooseDestination(): Promise<string | null>
  organizerPreview(id: string, destination: string, offset?: number, mode?: 'copy' | 'move'): Promise<OrganizePreview>
  organizerExport(id: string, destination: string, verify?: 'size' | 'hash', mode?: 'copy' | 'move'): Promise<OrganizePlanInfo | null>
  organizerResumeExport(id: string): Promise<OrganizePlanInfo | null>
  organizerPauseExport(id: string): Promise<void>
  organizerCancelExport(id: string): Promise<void>
  organizerReport(id: string): Promise<ExportReport>
  organizerOpenDestination(id: string): Promise<string>
  onOrganizerProgress(callback: (progress: SmartOrganizeProgress) => void): () => void
  onOrganizerChanged(callback: (info: { planId: string }) => void): () => void
  onAssistantProgress(callback: (progress: AssistantProgress) => void): () => void
  onAssistantChatChanged(callback: (info: { chatId: string }) => void): () => void
  /** Gives a family your own name; an empty name returns it to the automatic one. */
  renameFamily(id: number, name: string): Promise<FamilyList>
  /** Ids of every image in a family that is still present, most typical first. */
  familyImageIds(id: number): Promise<string[]>
  onFamiliesChanged(callback: () => void): () => void
  listSmartCollections(): Promise<SmartCollection[]>
  /** Shows what a description matches right now, without saving anything. */
  previewSmartCollection(criteria: SmartCriteria, limit?: number, offset?: number): Promise<SmartPreview>
  /** Ids of every image the description matches right now, best first. */
  previewSmartCollectionIds(criteria: SmartCriteria): Promise<string[]>
  createSmartCollection(input: SmartCollectionInput): Promise<SmartCollection>
  updateSmartCollection(id: string, input: Partial<SmartCollectionInput>): Promise<SmartCollection>
  deleteSmartCollection(id: string): Promise<boolean>
  /** Marks the collection as seen, which clears its "new" count. */
  markSmartCollectionViewed(id: string): Promise<SmartCollection | null>
  smartCollectionImageIds(id: string): Promise<string[]>
  refreshSmartCollections(): Promise<SmartCollection[]>
  onSmartCollectionsChanged(callback: () => void): () => void
  /** Tells the companion what the user is looking at, so "this collection" can be understood. */
  setCompanionView(view: CompanionView): Promise<void>
  /** Test hook: the evidence used to tell working images from finished work. Only answers in the test environment. */
  debugCurationRoles(): Promise<unknown>
  /** Remembers which images the user currently keeps in a curated proposal while reviewing. */
  assistantReviewCuration(chatId: string, proposalId: string, selection: string[]): Promise<void>
  getModelStatus(): Promise<ModelStatus>
  installModel(): Promise<ModelStatus>
  cancelModelInstall(): Promise<ModelStatus>
  declineAi(): Promise<ModelStatus>
  enableAi(): Promise<ModelStatus>
  removeModel(): Promise<ModelStatus>
  onModelStatus(callback: (status: ModelStatus) => void): () => void
  getTasteState(): Promise<TasteState>
  tasteNextPair(): Promise<TastePair | null>
  tasteChoose(input: { aId: string; bId: string; winnerId: string | null; mode?: TastePairMode }): Promise<TasteStep>
  tasteUndo(): Promise<TasteStep>
  tasteReset(): Promise<TasteState>
  tasteRecommend(limit?: number): Promise<TasteRecommendations>
  tasteExamples(dimensionId: string): Promise<TasteExamples>
  getReferenceInfo(): Promise<ReferenceInfo>
  getIdentity(): Promise<IdentityState>
  getDiscovery(): Promise<DiscoveryState>
  discoveryNextPair(): Promise<DiscoveryPair | null>
  discoveryRespond(input: { aId: string; bId: string; response: DiscoveryResponse; winnerId?: string | null }): Promise<DiscoveryStep>
  discoveryUndo(): Promise<DiscoveryStep>
  discoveryReset(): Promise<DiscoveryState>
  getCompare(): Promise<CompareState>
  listJourneys(): Promise<{ journeys: Journey[]; suggestions: JourneySuggestion[] }>
  createJourney(seed: Journey['seed']): Promise<Journey>
  getJourney(id: string): Promise<Journey | null>
  journeyFeedback(input: { journeyId: string; workId: string; feedback: 'like' | 'dislike' | 'clear' }): Promise<Journey>
  journeyProgress(input: { journeyId: string; progress: number; finished?: boolean }): Promise<Journey>
  deleteJourney(id: string): Promise<void>
  saveDiscovery(input: { workId: string; favorite?: boolean; moodboardId?: string; journeyId?: string }): Promise<SavedDiscovery>
  getHistory(): Promise<HistoryState>
  getIndexStatus(): Promise<IndexStatus>
  setAiEnabled(enabled: boolean): Promise<IndexStatus>
  pauseIndexing(): Promise<IndexStatus>
  resumeIndexing(): Promise<IndexStatus>
  onIndexStatus(callback: (status: IndexStatus) => void): () => void
  onScan(callback: (event: ScanEvent) => void): () => void
  onLibraryChanged(callback: () => void): () => void
  onMaximizeChanged(callback: (maximized: boolean) => void): () => void
}

export const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.avif',
  '.heic',
  '.heif',
  '.jxl'
] as const
