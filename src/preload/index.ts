import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AssistantProgress, AssistantSettingsUpdate } from '../shared/assistant'
import type { AiJob, AiMode, PackageInstallRequest, RuntimeInstallRequest } from '../shared/ai'
import type { DiscoveryOptions, DiscoveryProgress } from '../shared/discovery'
import type { ConceptRequest, EditRequest, ExternalEditSession, RetouchRequest, GenerateRequest, StudioProgress, StudioSettingsUpdate, UpscaleRequest } from '../shared/studio'
import type {
  AddImagesToBoardInput,
  AtlasApi,
  ImageQuery,
  OrganizeProgress,
  OrganizeRequest,
  ReorderBoardInput,
  IndexStatus,
  TastePairMode,
  ModelStatus,
  ScanEvent,
  UpdateBoardItemInput,
  UpdateImageInput
} from '../shared/types'

const api: AtlasApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  listImages: (query: ImageQuery) => ipcRenderer.invoke('images:list', query),
  listImports: () => ipcRenderer.invoke('images:imports'),
  getImage: (id: string) => ipcRenderer.invoke('images:get', id),
  updateImage: (input: UpdateImageInput) => ipcRenderer.invoke('images:update', input),
  revealImage: (id: string) => ipcRenderer.invoke('images:reveal', id),
  chooseFolders: () => ipcRenderer.invoke('folders:choose'),
  addFolders: (paths: string[]) => ipcRenderer.invoke('folders:add', paths),
  rescanRoot: (rootId: string) => ipcRenderer.invoke('folders:rescan', rootId),
  cancelScan: () => ipcRenderer.invoke('folders:cancel-scan'),
  removeRoot: (rootId: string) => ipcRenderer.invoke('folders:remove', rootId),
  listMoodboards: () => ipcRenderer.invoke('moodboards:list'),
  getMoodboard: (id: string) => ipcRenderer.invoke('moodboards:get', id),
  moodboardsForImage: (imageId: string) => ipcRenderer.invoke('moodboards:for-image', imageId),
  createMoodboard: (name: string) => ipcRenderer.invoke('moodboards:create', name),
  renameMoodboard: (id: string, name: string) => ipcRenderer.invoke('moodboards:rename', id, name),
  deleteMoodboard: (id: string) => ipcRenderer.invoke('moodboards:delete', id),
  addToMoodboard: (input: AddImagesToBoardInput) => ipcRenderer.invoke('moodboards:add', input),
  removeFromMoodboard: (moodboardId: string, imageId: string) =>
    ipcRenderer.invoke('moodboards:remove-image', moodboardId, imageId),
  reorderMoodboard: (input: ReorderBoardInput) => ipcRenderer.invoke('moodboards:reorder', input),
  updateBoardItem: (input: UpdateBoardItemInput) => ipcRenderer.invoke('moodboards:update-layout', input),
  chooseOrganizeDestination: () => ipcRenderer.invoke('organize:choose-destination'),
  organize: (request: OrganizeRequest) => ipcRenderer.invoke('organize:execute', request),
  onOrganizeProgress: (callback: (progress: OrganizeProgress) => void) => {
    const listener = (_event: IpcRendererEvent, payload: OrganizeProgress): void => callback(payload)
    ipcRenderer.on('organize:progress', listener)
    return () => ipcRenderer.removeListener('organize:progress', listener)
  },
  openDataFolder: () => ipcRenderer.invoke('app:open-data-folder'),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  listFamilies: () => ipcRenderer.invoke('families:list'),
  rebuildFamilies: () => ipcRenderer.invoke('families:rebuild'),
  assistantSettings: () => ipcRenderer.invoke('assistant:settings'),
  assistantUpdateSettings: (change: AssistantSettingsUpdate) => ipcRenderer.invoke('assistant:update-settings', change),
  assistantTest: () => ipcRenderer.invoke('assistant:test'),
  assistantDetectLocal: () => ipcRenderer.invoke('assistant:detect-local'),
  assistantChats: () => ipcRenderer.invoke('assistant:chats'),
  assistantChat: (id: string) => ipcRenderer.invoke('assistant:chat', id),
  assistantNewChat: () => ipcRenderer.invoke('assistant:new-chat'),
  assistantDeleteChat: (id: string) => ipcRenderer.invoke('assistant:delete-chat', id),
  assistantSend: (chatId: string | null, message: string, context?: { viewingImageId?: string | null }) => ipcRenderer.invoke('assistant:send', chatId, message, context),
  assistantStop: (chatId: string) => ipcRenderer.invoke('assistant:stop', chatId),
  studioSettings: () => ipcRenderer.invoke('studio:settings'),
  studioUpdateSettings: (change: StudioSettingsUpdate) => ipcRenderer.invoke('studio:update-settings', change),
  studioComfyStatus: () => ipcRenderer.invoke('studio:comfy-status'),
  studioComfyChooseFolder: () => ipcRenderer.invoke('studio:comfy-choose-folder'),
  studioComfyPick: (what: 'python' | 'workflows') => ipcRenderer.invoke('studio:comfy-pick', what),
  studioComfyStart: () => ipcRenderer.invoke('studio:comfy-start'),
  studioComfyStop: () => ipcRenderer.invoke('studio:comfy-stop'),
  studioComfyRescan: () => ipcRenderer.invoke('studio:comfy-rescan'),
  onComfyProgress: (callback: (message: string) => void) => {
    const listener = (_event: unknown, payload: { message: string }): void => callback(payload.message)
    ipcRenderer.on('studio:comfy-progress', listener)
    return () => ipcRenderer.removeListener('studio:comfy-progress', listener)
  },
  studioConcept: (request: ConceptRequest) => ipcRenderer.invoke('studio:concept', request),
  studioEstimate: (methodId: string, model: string | undefined, count: number, width: number, height: number) => ipcRenderer.invoke('studio:estimate', methodId, model, count, width, height),
  studioGenerate: (request: GenerateRequest) => ipcRenderer.invoke('studio:generate', request),
  studioStop: (jobId: string) => ipcRenderer.invoke('studio:stop', jobId),
  studioReferencePipelines: () => ipcRenderer.invoke('studio:reference-pipelines'),
  modelsOverview: (simulate?: string | null) => ipcRenderer.invoke('models:overview', simulate ?? null),
  modelsPlan: (id: string, variant?: string | null, simulate?: string | null) => ipcRenderer.invoke('models:plan', id, variant ?? null, simulate ?? null),
  modelsInstall: (id: string, options: { variant?: string | null; consent: boolean }) => ipcRenderer.invoke('models:install', id, options),
  modelsStop: () => ipcRenderer.invoke('models:stop'),
  modelsRemove: (id: string) => ipcRenderer.invoke('models:remove', id),
  modelsVerify: (id: string, deep: boolean) => ipcRenderer.invoke('models:verify', id, deep),
  modelsRescan: (simulate?: string | null) => ipcRenderer.invoke('models:rescan', simulate ?? null),
  studioEdit: (request: EditRequest) => ipcRenderer.invoke('studio:edit', request),
  studioRetouch: (request: RetouchRequest) => ipcRenderer.invoke('studio:retouch', request),
  studioRetouchHold: (hold: string[], release: string[]) => ipcRenderer.invoke('studio:retouch-hold', hold, release),
  studioRegionPreview: (imageId: string, region: unknown) => ipcRenderer.invoke('studio:region-preview', imageId, region),
  studioVersions: (imageId: string) => ipcRenderer.invoke('studio:versions', imageId),
  aiStatus: () => ipcRenderer.invoke('aipkg:status'),
  aiCapabilities: () => ipcRenderer.invoke('aipkg:capabilities'),
  aiSetMode: (mode: AiMode) => ipcRenderer.invoke('aipkg:set-mode', mode),
  aiChooseRoot: () => ipcRenderer.invoke('aipkg:choose-root'),
  aiInstallRuntime: (request: RuntimeInstallRequest) => ipcRenderer.invoke('aipkg:install-runtime', request),
  aiInstallPackages: (request: PackageInstallRequest) => ipcRenderer.invoke('aipkg:install-packages', request),
  aiStop: () => ipcRenderer.invoke('aipkg:stop'),
  aiCheckUpdate: () => ipcRenderer.invoke('aipkg:check-update'),
  aiUpdate: (consent: boolean) => ipcRenderer.invoke('aipkg:update', consent),
  aiVerify: () => ipcRenderer.invoke('aipkg:verify'),
  aiUninstall: () => ipcRenderer.invoke('aipkg:uninstall'),
  onAiProgress: (callback: (job: AiJob) => void) => {
    const listener = (_event: IpcRendererEvent, payload: AiJob): void => callback(payload)
    ipcRenderer.on('studio:ai-progress', listener)
    return () => ipcRenderer.removeListener('studio:ai-progress', listener)
  },
  /** The main process asks the window to open the AI Model Library (for example when the Companion is asked to). */
  onOpenModelLibrary: (callback: (request: { entry?: string; search?: string; category?: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { entry?: string; search?: string; category?: string }): void => callback(payload ?? {})
    ipcRenderer.on('models:open', listener)
    return () => ipcRenderer.removeListener('models:open', listener)
  },
  studioUpscale: (request: UpscaleRequest) => ipcRenderer.invoke('studio:upscale', request),
  studioEditCommit: (pendingId: string) => ipcRenderer.invoke('studio:edit-commit', pendingId),
  studioEditDiscard: (pendingId: string) => ipcRenderer.invoke('studio:edit-discard', pendingId),
  studioGenerations: (boardId?: string) => ipcRenderer.invoke('studio:generations', boardId),
  studioProvenance: (imageId: string) => ipcRenderer.invoke('studio:provenance', imageId),
  studioExternalStart: (imageId: string, editorId: string | null) => ipcRenderer.invoke('studio:external-start', imageId, editorId),
  studioExternalImport: (id: string) => ipcRenderer.invoke('studio:external-import', id),
  studioExternalEnd: (id: string) => ipcRenderer.invoke('studio:external-end', id),
  studioExternalSessions: () => ipcRenderer.invoke('studio:external-sessions'),
  studioExternalCandidates: (id: string) => ipcRenderer.invoke('studio:external-candidates', id),
  studioExternalImportFile: (id: string, path: string) => ipcRenderer.invoke('studio:external-import-file', id, path),
  studioExternalChoose: (id: string) => ipcRenderer.invoke('studio:external-choose', id),
  onStudioExternalEnded: (callback: (payload: { id: string }) => void) => {
    const listener = (_event: IpcRendererEvent, payload: { id: string }): void => callback(payload)
    ipcRenderer.on('studio:external-ended', listener)
    return () => ipcRenderer.removeListener('studio:external-ended', listener)
  },
  studioOpenFolder: () => ipcRenderer.invoke('studio:open-folder'),
  onStudioProgress: (callback: (progress: StudioProgress) => void) => {
    const listener = (_event: IpcRendererEvent, payload: StudioProgress): void => callback(payload)
    ipcRenderer.on('studio:progress', listener)
    return () => ipcRenderer.removeListener('studio:progress', listener)
  },
  onStudioExternal: (callback: (session: ExternalEditSession) => void) => {
    const listener = (_event: IpcRendererEvent, payload: ExternalEditSession): void => callback(payload)
    ipcRenderer.on('studio:external', listener)
    return () => ipcRenderer.removeListener('studio:external', listener)
  },
  discoverDrives: () => ipcRenderer.invoke('discover:drives'),
  discoverChooseFolder: () => ipcRenderer.invoke('discover:choose-folder'),
  discoverStart: (options: DiscoveryOptions) => ipcRenderer.invoke('discover:start', options),
  discoverStop: () => ipcRenderer.invoke('discover:stop'),
  discoverPreview: (paths: string[]) => ipcRenderer.invoke('discover:preview', paths),
  onDiscoverProgress: (callback: (progress: DiscoveryProgress) => void) => {
    const listener = (_event: IpcRendererEvent, payload: DiscoveryProgress): void => callback(payload)
    ipcRenderer.on('discover:progress', listener)
    return () => ipcRenderer.removeListener('discover:progress', listener)
  },
  boardUndoInfo: (boardId: string) => ipcRenderer.invoke('boards:undo-info', boardId),
  boardUndo: (boardId: string) => ipcRenderer.invoke('boards:undo', boardId),
  boardTidy: (boardId: string) => ipcRenderer.invoke('boards:tidy', boardId),
  assistantProposal: (chatId: string, proposalId: string, accept: boolean, options?: unknown) => ipcRenderer.invoke('assistant:proposal', chatId, proposalId, accept, options),
  /** Only answers in the end-to-end test environment. */
  debugCurationRoles: () => ipcRenderer.invoke('assistant:debug-roles'),
  setCompanionView: (view: unknown) => ipcRenderer.invoke('assistant:view', view),
  assistantReviewCuration: (chatId: string, proposalId: string, selection: string[]) => ipcRenderer.invoke('assistant:review-curation', chatId, proposalId, selection),
  onAssistantChatChanged: (callback: (info: { chatId: string }) => void) => {
    const listener = (_event: unknown, info: { chatId: string }): void => callback(info)
    ipcRenderer.on('assistant:chat-changed', listener)
    return () => ipcRenderer.removeListener('assistant:chat-changed', listener)
  },
  onAssistantProgress: (callback: (progress: AssistantProgress) => void) => {
    const listener = (_event: unknown, progress: AssistantProgress): void => callback(progress)
    ipcRenderer.on('assistant:progress', listener)
    return () => ipcRenderer.removeListener('assistant:progress', listener)
  },
  organizerPlans: () => ipcRenderer.invoke('organizer:plans'),
  organizerCount: (scope: unknown) => ipcRenderer.invoke('organizer:count', scope),
  organizerCreate: (name: string, scope: unknown, settings?: unknown) => ipcRenderer.invoke('organizer:create', name, scope, settings),
  organizerPlan: (id: string) => ipcRenderer.invoke('organizer:plan', id),
  organizerStart: (id: string) => ipcRenderer.invoke('organizer:start', id),
  organizerPause: (id: string) => ipcRenderer.invoke('organizer:pause', id),
  organizerCancel: (id: string) => ipcRenderer.invoke('organizer:cancel', id),
  organizerDelete: (id: string) => ipcRenderer.invoke('organizer:delete', id),
  organizerOverview: (id: string) => ipcRenderer.invoke('organizer:overview', id),
  organizerGroupImages: (id: string, kind: string, name: string) => ipcRenderer.invoke('organizer:group-images', id, kind, name),
  organizerImages: (ids: string[]) => ipcRenderer.invoke('organizer:images', ids),
  organizerDuplicates: (id: string, offset?: number) => ipcRenderer.invoke('organizer:duplicates', id, offset),
  organizerRefine: (id: string, ops: unknown) => ipcRenderer.invoke('organizer:refine', id, ops),
  organizerChooseDestination: () => ipcRenderer.invoke('organizer:choose-destination'),
  organizerPreview: (id: string, destination: string, offset?: number, mode?: 'copy' | 'move') => ipcRenderer.invoke('organizer:preview', id, destination, offset, mode),
  organizerExport: (id: string, destination: string, verify?: string, mode?: 'copy' | 'move') => ipcRenderer.invoke('organizer:export', id, destination, verify, mode),
  organizerResumeExport: (id: string) => ipcRenderer.invoke('organizer:resume-export', id),
  organizerPauseExport: (id: string) => ipcRenderer.invoke('organizer:pause-export', id),
  organizerCancelExport: (id: string) => ipcRenderer.invoke('organizer:cancel-export', id),
  organizerReport: (id: string) => ipcRenderer.invoke('organizer:report', id),
  organizerOpenDestination: (id: string) => ipcRenderer.invoke('organizer:open-destination', id),
  onOrganizerProgress: (callback: (progress: import('../shared/organizer').OrganizeProgress) => void) => {
    const listener = (_event: unknown, progress: import('../shared/organizer').OrganizeProgress): void => callback(progress)
    ipcRenderer.on('organizer:progress', listener)
    return () => ipcRenderer.removeListener('organizer:progress', listener)
  },
  onOrganizerChanged: (callback: (info: { planId: string }) => void) => {
    const listener = (_event: unknown, info: { planId: string }): void => callback(info)
    ipcRenderer.on('organizer:changed', listener)
    return () => ipcRenderer.removeListener('organizer:changed', listener)
  },
  listSmartCollections: () => ipcRenderer.invoke('smart:list'),
  previewSmartCollection: (criteria: unknown, limit?: number, offset?: number) => ipcRenderer.invoke('smart:preview', criteria, limit, offset),
  previewSmartCollectionIds: (criteria: unknown) => ipcRenderer.invoke('smart:preview-ids', criteria),
  createSmartCollection: (input: unknown) => ipcRenderer.invoke('smart:create', input),
  updateSmartCollection: (id: string, input: unknown) => ipcRenderer.invoke('smart:update', id, input),
  deleteSmartCollection: (id: string) => ipcRenderer.invoke('smart:delete', id),
  markSmartCollectionViewed: (id: string) => ipcRenderer.invoke('smart:viewed', id),
  smartCollectionImageIds: (id: string) => ipcRenderer.invoke('smart:image-ids', id),
  refreshSmartCollections: () => ipcRenderer.invoke('smart:refresh'),
  onSmartCollectionsChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('smart:changed', listener)
    return () => ipcRenderer.removeListener('smart:changed', listener)
  },
  renameFamily: (id: number, name: string) => ipcRenderer.invoke('families:rename', id, name),
  familyImageIds: (id: number) => ipcRenderer.invoke('families:image-ids', id),
  onFamiliesChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('families:changed', listener)
    return () => ipcRenderer.removeListener('families:changed', listener)
  },
  getModelStatus: () => ipcRenderer.invoke('ai:status'),
  installModel: () => ipcRenderer.invoke('ai:install'),
  cancelModelInstall: () => ipcRenderer.invoke('ai:cancel'),
  declineAi: () => ipcRenderer.invoke('ai:decline'),
  enableAi: () => ipcRenderer.invoke('ai:enable'),
  removeModel: () => ipcRenderer.invoke('ai:remove'),
  onModelStatus: (callback: (status: ModelStatus) => void) => {
    const listener = (_event: IpcRendererEvent, payload: ModelStatus): void => callback(payload)
    ipcRenderer.on('ai:status', listener)
    return () => ipcRenderer.removeListener('ai:status', listener)
  },
  getTasteState: () => ipcRenderer.invoke('taste:state'),
  tasteNextPair: () => ipcRenderer.invoke('taste:next-pair'),
  tasteChoose: (input: { aId: string; bId: string; winnerId: string | null; mode?: TastePairMode }) => ipcRenderer.invoke('taste:choose', input),
  tasteUndo: () => ipcRenderer.invoke('taste:undo'),
  tasteReset: () => ipcRenderer.invoke('taste:reset'),
  tasteRecommend: (limit?: number) => ipcRenderer.invoke('taste:recommend', limit),
  tasteExamples: (dimensionId: string) => ipcRenderer.invoke('taste:examples', dimensionId),
  getReferenceInfo: () => ipcRenderer.invoke('reference:info'),
  getIdentity: () => ipcRenderer.invoke('identity:get'),
  getDiscovery: () => ipcRenderer.invoke('discovery:get'),
  discoveryNextPair: () => ipcRenderer.invoke('discovery:next'),
  discoveryRespond: (input) => ipcRenderer.invoke('discovery:respond', input),
  discoveryUndo: () => ipcRenderer.invoke('discovery:undo'),
  discoveryReset: () => ipcRenderer.invoke('discovery:reset'),
  getCompare: () => ipcRenderer.invoke('compare:get'),
  listJourneys: () => ipcRenderer.invoke('journeys:list'),
  createJourney: (seed) => ipcRenderer.invoke('journeys:create', seed),
  getJourney: (id) => ipcRenderer.invoke('journeys:get', id),
  journeyFeedback: (input) => ipcRenderer.invoke('journeys:feedback', input),
  journeyProgress: (input) => ipcRenderer.invoke('journeys:progress', input),
  deleteJourney: (id) => ipcRenderer.invoke('journeys:delete', id),
  saveDiscovery: (input) => ipcRenderer.invoke('discovery:save', input),
  getHistory: () => ipcRenderer.invoke('history:get'),
  getIndexStatus: () => ipcRenderer.invoke('index:status'),
  setAiEnabled: (enabled: boolean) => ipcRenderer.invoke('index:set-enabled', enabled),
  pauseIndexing: () => ipcRenderer.invoke('index:pause'),
  resumeIndexing: () => ipcRenderer.invoke('index:resume'),
  onIndexStatus: (callback: (status: IndexStatus) => void) => {
    const listener = (_event: IpcRendererEvent, payload: IndexStatus): void => callback(payload)
    ipcRenderer.on('index:status', listener)
    return () => ipcRenderer.removeListener('index:status', listener)
  },
  onScan: (callback: (event: ScanEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: ScanEvent): void => callback(payload)
    ipcRenderer.on('scan:event', listener)
    return () => ipcRenderer.removeListener('scan:event', listener)
  },
  onLibraryChanged: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('library:changed', listener)
    return () => ipcRenderer.removeListener('library:changed', listener)
  },
  onMaximizeChanged: (callback: (maximized: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => callback(maximized)
    ipcRenderer.on('window:maximized', listener)
    return () => ipcRenderer.removeListener('window:maximized', listener)
  }
}

contextBridge.exposeInMainWorld('noema', api)
