import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, screen, shell, type Rectangle } from 'electron'
import { AtlasDatabase } from './db'
import { registerMediaProtocol } from './protocol'
import { ScanManager, isPathInsideOrEqual, validateFolder } from './scanner'
import { SourceWatcher } from './sourceWatcher'
import { removeThumbnail } from './media'
import { organizeImages } from './organizer'
import { Indexer } from './indexer'
import { SemanticSearch } from './semantic'
import { rebuildFamilies } from './families'
import { ImageStatsWorker, SmartCollections } from './smartCollections'
import { normalizeCriteria } from '../shared/smart'
import { TasteEngine } from './tasteEngine'
import { ReferenceCollection, emptyReferenceInfo } from './reference'
import { ConceptSpace } from './conceptSpace'
import { DiscoveryEngine } from './discovery'
import { IdentityEngine } from './identity'
import { CompareEngine } from './compare'
import { JourneyEngine } from './journeys'
import { HistoryEngine } from './history'
import { saveDiscoveryToLibrary } from './discoveries'
import { TechnicalGuard } from './guard'
import { EMBEDDING_MODEL, modelDirectory } from './embedder'
import { ModelInstaller } from './modelInstaller'
import { registerAssistant } from './assistant/register'
import { registerStudio } from './studio/register'
import { registerOrganizer } from './organizer/register'
import type { OrganizerEngine } from './organizer/engine'
import type { AiChoice, FamilyList, ModelStatus } from '../shared/types'
import type {
  AddImagesToBoardInput,
  BoardImagePlacement,
  Bootstrap,
  FolderAddResult,
  ImageDecision,
  ImagePage,
  ImageQuery,
  ImageSort,
  OrganizeProgress,
  OrganizeRequest,
  ReorderBoardInput,
  RootFolder,
  ScanEvent,
  UpdateBoardItemInput,
  UpdateImageInput
} from '../shared/types'

import { installCrashGuard } from './crashGuard'

app.setName('NOEMA Atlas')
if (process.env.NOEMA_USER_DATA_DIR) {
  app.setPath('userData', process.env.NOEMA_USER_DATA_DIR)
}
if (process.platform === 'win32') {
  app.setAppUserModelId('studio.noema.atlas')
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'noema',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let database: AtlasDatabase | null = null
let scans: ScanManager | null = null
let sourceWatcher: SourceWatcher | null = null
let indexer: Indexer | null = null
let semantic: SemanticSearch | null = null
let taste: TasteEngine | null = null
let reference: ReferenceCollection | null = null
let discovery: DiscoveryEngine | null = null
let identityEngine: IdentityEngine | null = null
let compareEngine: CompareEngine | null = null
let journeys: JourneyEngine | null = null
let history: HistoryEngine | null = null
let buildingFamilies = false
let smartCollections: SmartCollections | null = null
let organizerEngine: OrganizerEngine | null = null
let statsWorker: ImageStatsWorker | null = null
let smartTimer: ReturnType<typeof setTimeout> | null = null
let modelInstaller: ModelInstaller | null = null
let aiChoice: AiChoice = 'unset'
let lastScanKick = 0
let thumbnailsDir = ''
let dataDir = ''
let libraryDbPath = ''
let closing = false
let organizing = false

const gotLock = process.env.NOEMA_E2E === '1' ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  installCrashGuard(app.getPath('userData'))
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
}

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1440, height: 920 }
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>
    if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height)) return fallback
    const width = Math.max(1040, Math.min(3840, Number(raw.width)))
    const height = Math.max(700, Math.min(2400, Number(raw.height)))
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      const bounds: Rectangle = { x: Number(raw.x), y: Number(raw.y), width, height }
      const display = screen.getDisplayMatching(bounds)
      if (display.workArea.width > 0) return { ...bounds, maximized: Boolean(raw.maximized) }
    }
    return { width, height, maximized: Boolean(raw.maximized) }
  } catch {
    return fallback
  }
}

function saveWindowState(): void {
  if (!mainWindow) return
  try {
    const bounds = mainWindow.isMaximized() ? mainWindow.getNormalBounds() : mainWindow.getBounds()
    const state: WindowState = { ...bounds, maximized: mainWindow.isMaximized() }
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // Window geometry is a convenience, never a reason to fail shutdown.
  }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * The user's decision about the local AI features. A library that already has the model installed (an earlier
 * version, or the install script) keeps working; a new one starts as "unset" and Atlas asks before downloading.
 */
function loadAiChoice(modelInstalled: boolean): AiChoice {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { aiChoice?: unknown; aiEnabled?: unknown }
    if (raw.aiChoice === 'enabled' || raw.aiChoice === 'declined') return raw.aiChoice
    if (raw.aiEnabled === false) return 'declined'
  } catch {
    // No settings yet.
  }
  if (modelInstalled) return 'enabled'
  // Automated test runs must never be interrupted by the first-run question.
  if (process.env.NOEMA_E2E === '1' && process.env.NOEMA_E2E_AI !== '1') return 'declined'
  return 'unset'
}

function saveAiChoice(choice: AiChoice): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(settingsPath(), JSON.stringify({ aiChoice: choice }, null, 2), 'utf8')
  } catch {
    // A setting that cannot be saved falls back to its default next launch.
  }
}

function setAiChoice(choice: AiChoice): ModelStatus {
  aiChoice = choice
  if (choice !== 'unset') saveAiChoice(choice)
  indexer?.setEnabled(choice === 'enabled' && Boolean(modelInstaller?.installed))
  const status = modelInstaller!.status
  broadcast('ai:status', status)
  return status
}

function familyList(): FamilyList {
  const info = database!.getFamilyBuildInfo(EMBEDDING_MODEL)
  return {
    families: database!.listFamilies(EMBEDDING_MODEL).map((family) => ({
      id: family.id,
      size: family.size,
      cohesion: family.cohesion,
      covers: family.covers,
      name: family.customName ?? family.autoName,
      autoName: family.autoName,
      customName: family.customName,
      nameConfidence: family.nameInfo?.confidence ?? null,
      keywords: family.nameInfo?.keywords ?? [],
      nameNote: family.nameInfo?.note ?? null
    })),
    building: buildingFamilies,
    clustered: info?.clustered ?? 0,
    embedded: database!.getEmbeddingStats(EMBEDDING_MODEL).indexed
  }
}

async function buildFamilies(): Promise<void> {
  if (!database || buildingFamilies) return
  buildingFamilies = true
  broadcast('families:changed')
  try {
    await rebuildFamilies(database, () => indexer!.ensureEmbedder())
  } catch {
    // Families are a convenience; a failed rebuild leaves the previous result in place.
  } finally {
    buildingFamilies = false
    broadcast('families:changed')
  }
}

/** Brings every smart collection up to date shortly after the library changed (new, learned or removed images). */
function refreshSmartSoon(): void {
  if (!smartCollections) return
  if (smartTimer) clearTimeout(smartTimer)
  smartTimer = setTimeout(() => {
    smartTimer = null
    void smartCollections?.refreshAll().catch(() => undefined)
  }, 1500)
}

/** Rebuild automatically when indexing finished and the saved families no longer match the library. */
function refreshFamiliesIfStale(): void {
  if (!database || (scans && scans.scanningIds.size > 0)) return
  const embedded = database.getEmbeddingStats(EMBEDDING_MODEL).indexed
  if (embedded === 0) return
  const info = database.getFamilyBuildInfo(EMBEDDING_MODEL)
  if (!info || info.clustered !== embedded || database.familiesLackNames(EMBEDDING_MODEL)) void buildFamilies()
}

function referenceDir(): string {
  if (process.env.NOEMA_REFERENCE_DIR) return process.env.NOEMA_REFERENCE_DIR
  return app.isPackaged ? join(process.resourcesPath, 'reference') : join(app.getAppPath(), 'reference')
}

function needReference(): ReferenceCollection {
  if (!reference || !discovery) throw new Error('The reference collection is not installed.')
  return reference
}

/** Records a snapshot of the profiles when enough has changed. Never blocks or fails the caller. */
function snapshotSoon(): void {
  void history?.snapshotIfDue().catch(() => undefined)
}

function broadcast(channel: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function notifyChanged(): void {
  broadcast('library:changed')
}

function appInfo() {
  return {
    version: app.getVersion(),
    dataDir,
    libraryDb: libraryDbPath,
    thumbnailsDir,
    platform: process.platform
  }
}

function makeBootstrap(): Bootstrap {
  if (!database || !scans) throw new Error('Atlas is still starting.')
  return {
    stats: database.getStats(),
    roots: database.listRoots(scans.scanningIds),
    moodboards: database.listMoodboards(),
    scan: scans.scanState,
    app: appInfo()
  }
}

async function addFoldersToAtlas(inputPaths: string[]): Promise<FolderAddResult> {
  if (!database || !scans) throw new Error('Atlas is still starting.')
  const paths = Array.from(new Set(inputPaths.filter((entry) => typeof entry === 'string' && entry.trim())))
  if (paths.length > 24) throw new Error('Please add up to 24 folders at a time.')

  const result: FolderAddResult = { roots: [], added: [], existing: [], rejected: [], covered: [], scanning: [] }
  const roots = database.listRoots()
  const accepted: Array<{ root: RootFolder; why: 'added' | 'existing' | 'covered' }> = []

  for (const candidate of paths) {
    try {
      const validation = await validateFolder(candidate)
      if (!validation.ok) {
        result.rejected.push({ path: candidate, reason: validation.reason ?? 'This folder cannot be used.' })
        continue
      }
      const normalized = validation.path
      const existing = roots.find((root) => root.path.toLowerCase() === normalized.toLowerCase())
      if (existing) {
        result.existing.push(normalized)
        accepted.push({ root: existing, why: 'existing' })
        continue
      }

      // A folder inside a source is already part of that source. It is not an error and it is not ignored:
      // the source is checked again so anything new in the folder is imported, and the user is told so.
      const parent = roots.find((root) => isPathInsideOrEqual(root.path, normalized))
      if (parent) {
        result.covered!.push({ path: normalized, rootId: parent.id, rootName: parent.name })
        accepted.push({ root: parent, why: 'covered' })
        continue
      }

      // A folder that contains sources would scan the same images twice, so it is declined with the reason.
      const inside = roots.filter((root) => isPathInsideOrEqual(normalized, root.path))
      if (inside.length > 0) {
        const names = inside.slice(0, 3).map((root) => `“${root.name}”`).join(', ')
        result.rejected.push({
          path: normalized,
          reason: `This folder contains ${inside.length === 1 ? 'a source' : `${inside.length} sources`} Atlas already has (${names}${inside.length > 3 ? ' and more' : ''}). Remove ${inside.length === 1 ? 'it' : 'them'} in Sources first, or choose a folder that does not contain your other sources.`
        })
        continue
      }

      const root = database.addRoot(normalized)
      roots.push(root)
      result.added.push(normalized)
      accepted.push({ root, why: 'added' })
    } catch (error) {
      console.error('[atlas] could not add folder', candidate, error)
      result.rejected.push({
        path: candidate,
        reason: `Atlas could not save this source: ${error instanceof Error ? error.message.slice(0, 160) : 'an unexpected error'}.`
      })
    }
  }

  for (const { root, why } of accepted) {
    scans.enqueue(root)
    sourceWatcher?.sync((database?.listRoots() ?? []).map((r) => ({ id: r.id, path: r.path })))
    if (!result.scanning!.some((entry) => entry.rootId === root.id)) result.scanning!.push({ rootId: root.id, rootName: root.name, why })
  }
  result.roots = database.listRoots(scans.scanningIds)
  notifyChanged()
  return result
}

function registerIpc(): void {
  if (!database || !scans) throw new Error('Atlas is still starting.')

  ipcMain.handle('app:bootstrap', () => makeBootstrap())

  ipcMain.handle('images:imports', () => database!.listImportBatches(12))
  ipcMain.handle('images:list', async (_event, query: ImageQuery): Promise<ImagePage> => {
    const safeScope = ['collection', 'favorites', 'archive', 'review', 'moodboard'].includes(query?.scope)
      ? query.scope
      : 'collection'
    const visualText = typeof query?.search === 'string' ? query.search.trim().slice(0, 240) : ''
    const similarTo = typeof query?.similarTo === 'string' ? query.similarTo.slice(0, 80) : ''
    if (query?.visual && (visualText || similarTo) && indexer!.searchable) {
      return semantic!.query(
        {
          ...query,
          scope: safeScope as ImageQuery['scope'],
          search: visualText,
          similarTo: similarTo || undefined,
          rootId: typeof query?.rootId === 'string' ? query.rootId.slice(0, 80) : null,
          minRating: Number.isFinite(query?.minRating) ? Number(query.minRating) : 0,
          exactRating: Number.isFinite(query?.exactRating) ? Number(query.exactRating) : undefined,
          decision: query?.decision === 'keep' || query?.decision === 'pass' ? query.decision : undefined,
          unreviewed: Boolean(query?.unreviewed),
          includeMissing: Boolean(query?.includeMissing),
          addedFrom: Number.isFinite(query?.addedFrom) ? Number(query.addedFrom) : undefined,
          addedTo: Number.isFinite(query?.addedTo) ? Number(query.addedTo) : undefined
        },
        Number.isFinite(query?.limit) ? Math.max(1, Math.min(500, Number(query.limit))) : 120,
        Number.isFinite(query?.offset) ? Math.max(0, Number(query.offset)) : 0
      )
    }
    const sorts: ImageSort[] = ['curated', 'recent', 'captured', 'rating', 'name', 'folder', 'size']
    return database!.queryImages({
      scope: safeScope as ImageQuery['scope'],
      search: typeof query?.search === 'string' ? query.search.slice(0, 240) : '',
      rootId: typeof query?.rootId === 'string' ? query.rootId.slice(0, 80) : null,
      minRating: Number.isFinite(query?.minRating) ? Math.max(0, Math.min(5, Number(query.minRating))) : 0,
      exactRating: Number.isFinite(query?.exactRating) ? Math.max(1, Math.min(5, Number(query.exactRating))) : undefined,
      decision: query?.decision === 'keep' || query?.decision === 'pass' ? query.decision : undefined,
      unreviewed: Boolean(query?.unreviewed),
      includeMissing: Boolean(query?.includeMissing),
      sort: sorts.includes(query?.sort as ImageSort) ? (query.sort as ImageSort) : undefined,
      limit: Number.isFinite(query?.limit) ? Number(query.limit) : 120,
      offset: Number.isFinite(query?.offset) ? Number(query.offset) : 0,
      moodboardId: typeof query?.moodboardId === 'string' ? query.moodboardId.slice(0, 80) : undefined,
      familyId: Number.isInteger(query?.familyId) ? Number(query.familyId) : undefined,
      smartId: typeof query?.smartId === 'string' ? query.smartId.slice(0, 80) : undefined,
      addedFrom: Number.isFinite(query?.addedFrom) ? Number(query.addedFrom) : undefined,
      addedTo: Number.isFinite(query?.addedTo) ? Number(query.addedTo) : undefined
    })
  })

  ipcMain.handle('images:get', (_event, id: string) =>
    typeof id === 'string' ? database!.getImage(id) : null
  )

  ipcMain.handle('images:update', (_event, input: UpdateImageInput) => {
    if (!input || typeof input.id !== 'string') throw new Error('A valid image is required.')
    const tags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 24)
      : undefined
    const item = database!.updateImage({
      id: input.id,
      favorite: typeof input.favorite === 'boolean' ? input.favorite : undefined,
      rating: Number.isFinite(input.rating) ? Number(input.rating) : undefined,
      tags,
      reviewed: typeof input.reviewed === 'boolean' ? input.reviewed : undefined,
      decision:
        input.decision === 'keep' || input.decision === 'pass' || input.decision === null
          ? (input.decision as ImageDecision | null)
          : undefined
    })
    notifyChanged()
    return item
  })

  ipcMain.handle('images:reveal', async (_event, id: string) => {
    if (typeof id !== 'string') return
    const filePath = database!.getImagePath(id)
    if (filePath) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('folders:choose', async (): Promise<FolderAddResult> => {
    if (!mainWindow) throw new Error('The Atlas window is not available.')
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for Atlas',
      message: 'Atlas reads this folder and writes only previews and metadata of its own.',
      buttonLabel: 'Add to Atlas',
      properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
    })
    if (selection.canceled || selection.filePaths.length === 0) {
      return { roots: database!.listRoots(scans!.scanningIds), added: [], existing: [], rejected: [], covered: [], scanning: [], canceled: true }
    }
    return addFoldersToAtlas(selection.filePaths)
  })

  ipcMain.handle('folders:add', (_event, paths: string[]) => {
    if (!Array.isArray(paths)) throw new Error('A list of folders is required.')
    return addFoldersToAtlas(paths)
  })

  ipcMain.handle('folders:rescan', (_event, rootId: string) => {
    if (typeof rootId !== 'string') throw new Error('A source is required.')
    const root = database!.getRoot(rootId)
    if (!root) throw new Error('That source is no longer in Atlas.')
    scans!.enqueue(root)
    notifyChanged()
  })

  ipcMain.handle('folders:cancel-scan', () => {
    scans!.cancelAll()
  })

  ipcMain.handle('folders:remove', async (_event, rootId: string) => {
    if (typeof rootId !== 'string') throw new Error('A source is required.')
    if (scans!.scanningIds.has(rootId)) throw new Error('Stop the scan before removing this source.')
    const root = database!.getRoot(rootId)
    if (!root) return
    const imageIds = database!.getImageIdsForRoot(rootId)
    database!.removeRoot(rootId)
    sourceWatcher?.sync(database!.listRoots().map((r) => ({ id: r.id, path: r.path })))
    await Promise.all(imageIds.map((id) => removeThumbnail(thumbnailsDir, id)))
    notifyChanged()
  })

  ipcMain.handle('moodboards:list', () => database!.listMoodboards())

  ipcMain.handle('moodboards:get', (_event, id: string) =>
    typeof id === 'string' ? database!.getMoodboard(id) : null
  )

  ipcMain.handle('moodboards:for-image', (_event, imageId: string) =>
    typeof imageId === 'string' ? database!.getMoodboardsForImage(imageId) : []
  )

  ipcMain.handle('moodboards:create', (_event, name: string) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Give the moodboard a name.')
    const board = database!.createMoodboard(name)
    notifyChanged()
    return board
  })

  ipcMain.handle('moodboards:rename', (_event, id: string, name: string) => {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error('A name is required.')
    const board = database!.renameMoodboard(id, name)
    notifyChanged()
    return board
  })

  ipcMain.handle('moodboards:delete', (_event, id: string) => {
    if (typeof id !== 'string') return
    database!.deleteMoodboard(id)
    notifyChanged()
  })

  ipcMain.handle('moodboards:add', (_event, input: AddImagesToBoardInput) => {
    if (!input || typeof input.moodboardId !== 'string' || !Array.isArray(input.imageIds)) {
      throw new Error('Choose some images and a moodboard.')
    }
    const placements: BoardImagePlacement[] = Array.isArray(input.placements)
      ? input.placements
          .filter(
            (placement): placement is BoardImagePlacement =>
              Boolean(placement) &&
              typeof placement.imageId === 'string' &&
              Number.isFinite(placement.x) &&
              Number.isFinite(placement.y) &&
              Number.isFinite(placement.width) &&
              Number.isFinite(placement.height)
          )
          .slice(0, 500)
      : []
    const board = database!.addToMoodboard(
      input.moodboardId,
      input.imageIds.filter((id): id is string => typeof id === 'string').slice(0, 500),
      placements
    )
    notifyChanged()
    return board
  })

  ipcMain.handle('moodboards:update-layout', (_event, input: UpdateBoardItemInput) => {
    if (
      !input ||
      typeof input.moodboardId !== 'string' ||
      typeof input.imageId !== 'string' ||
      !Number.isFinite(input.x) ||
      !Number.isFinite(input.y) ||
      !Number.isFinite(input.width) ||
      !Number.isFinite(input.height)
    ) {
      throw new Error('Invalid moodboard position.')
    }
    const board = database!.updateBoardItem({
      moodboardId: input.moodboardId,
      imageId: input.imageId,
      x: Number(input.x),
      y: Number(input.y),
      width: Number(input.width),
      height: Number(input.height),
      z: Number.isFinite(input.z) ? Number(input.z) : undefined
    })
    notifyChanged()
    return board
  })

  ipcMain.handle('moodboards:remove-image', (_event, boardId: string, imageId: string) => {
    if (typeof boardId !== 'string' || typeof imageId !== 'string') throw new Error('Invalid moodboard change.')
    const board = database!.removeFromMoodboard(boardId, imageId)
    notifyChanged()
    return board
  })

  ipcMain.handle('moodboards:reorder', (_event, input: ReorderBoardInput) => {
    if (!input || typeof input.moodboardId !== 'string' || !Array.isArray(input.imageIds)) {
      throw new Error('Invalid moodboard order.')
    }
    const board = database!.reorderMoodboard(
      input.moodboardId,
      input.imageIds.filter((id): id is string => typeof id === 'string').slice(0, 1000)
    )
    notifyChanged()
    return board
  })

  ipcMain.handle('families:list', () => familyList())
  ipcMain.handle('families:rename', (_event, id: unknown, name: unknown) => {
    if (!Number.isInteger(id) || typeof name !== 'string') throw new Error('Choose a family and a name.')
    if (!database!.renameFamily(Number(id), name)) throw new Error('That family no longer exists.')
    return familyList()
  })
  ipcMain.handle('families:image-ids', (_event, id: unknown) => {
    if (!Number.isInteger(id)) throw new Error('Choose a family.')
    return database!.familyImageIds(Number(id))
  })
  ipcMain.handle('smart:list', () => smartCollections!.list())
  ipcMain.handle('smart:preview', (_event, criteria: unknown, limit?: unknown, offset?: unknown) =>
    smartCollections!.preview(
      criteria,
      Number.isFinite(limit) ? Math.max(1, Math.min(200, Number(limit))) : 60,
      Number.isFinite(offset) ? Math.max(0, Number(offset)) : 0
    )
  )
  ipcMain.handle('smart:preview-ids', (_event, criteria: unknown) => smartCollections!.previewIds(criteria))
  ipcMain.handle('smart:create', (_event, input: unknown) => {
    const value = (input ?? {}) as { name?: unknown; criteria?: unknown }
    return smartCollections!.create({ name: typeof value.name === 'string' ? value.name : '', criteria: normalizeCriteria(value.criteria) })
  })
  ipcMain.handle('smart:update', (_event, id: unknown, input: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a collection.')
    const value = (input ?? {}) as { name?: unknown; criteria?: unknown }
    return smartCollections!.update(id, {
      name: typeof value.name === 'string' ? value.name : undefined,
      criteria: value.criteria !== undefined ? normalizeCriteria(value.criteria) : undefined
    })
  })
  ipcMain.handle('smart:delete', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a collection.')
    return smartCollections!.remove(id)
  })
  ipcMain.handle('smart:viewed', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a collection.')
    return smartCollections!.markViewed(id)
  })
  ipcMain.handle('smart:image-ids', (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a collection.')
    return database!.smartImageIds(id)
  })
  ipcMain.handle('smart:refresh', async () => {
    statsWorker?.kick()
    await statsWorker?.whenIdle()
    await smartCollections!.refreshAll()
    return smartCollections!.list()
  })
  ipcMain.handle('families:rebuild', async () => {
    await buildFamilies()
    return familyList()
  })

  ipcMain.handle('reference:info', () => reference?.info() ?? emptyReferenceInfo())
  ipcMain.handle('identity:get', () => {
    needReference()
    return identityEngine!.state()
  })
  ipcMain.handle('discovery:get', () => {
    needReference()
    return discovery!.state()
  })
  ipcMain.handle('discovery:next', () => {
    needReference()
    return discovery!.nextPair()
  })
  ipcMain.handle('discovery:respond', async (_event, input: { aId: string; bId: string; response: string; winnerId?: string | null }) => {
    needReference()
    if (!input || typeof input.aId !== 'string' || typeof input.bId !== 'string') throw new Error('Choose between two works.')
    const response = ['prefer', 'both', 'neither', 'undecided'].includes(input.response) ? (input.response as 'prefer' | 'both' | 'neither' | 'undecided') : null
    if (!response) throw new Error('Unknown answer.')
    const step = await discovery!.respond(input.aId, input.bId, response, typeof input.winnerId === 'string' ? input.winnerId : null)
    snapshotSoon()
    return step
  })
  ipcMain.handle('discovery:undo', () => {
    needReference()
    return discovery!.undo()
  })
  ipcMain.handle('discovery:reset', () => {
    needReference()
    return discovery!.reset()
  })
  ipcMain.handle('compare:get', () => {
    needReference()
    return compareEngine!.state()
  })
  ipcMain.handle('journeys:list', async () => {
    needReference()
    return { journeys: journeys!.list(), suggestions: await journeys!.suggestions() }
  })
  ipcMain.handle('journeys:create', async (_event, seed: { kind: string; label: string; ref?: string | number }) => {
    needReference()
    const kinds = ['tour', 'mode', 'identity', 'emerging', 'unexplored', 'work']
    if (!seed || !kinds.includes(seed.kind)) throw new Error('Unknown journey.')
    return journeys!.create({ kind: seed.kind as 'tour', label: String(seed.label ?? '').slice(0, 120), ref: seed.ref })
  })
  ipcMain.handle('journeys:get', (_event, id: string) => {
    needReference()
    return typeof id === 'string' ? journeys!.get(id) : null
  })
  ipcMain.handle('journeys:feedback', async (_event, input: { journeyId: string; workId: string; feedback: string }) => {
    needReference()
    if (!input || !['like', 'dislike', 'clear'].includes(input.feedback)) throw new Error('Unknown feedback.')
    const journey = await journeys!.feedback(String(input.journeyId), String(input.workId), input.feedback as 'like' | 'dislike' | 'clear')
    snapshotSoon()
    return journey
  })
  ipcMain.handle('journeys:progress', (_event, input: { journeyId: string; progress: number; finished?: boolean }) => {
    needReference()
    return journeys!.progress(String(input.journeyId), Number(input.progress) || 0, input.finished === true)
  })
  ipcMain.handle('journeys:delete', (_event, id: string) => {
    needReference()
    if (typeof id === 'string') journeys!.remove(id)
  })
  ipcMain.handle('discovery:save', async (_event, input: { workId: string; favorite?: boolean; moodboardId?: string; journeyId?: string }) => {
    const ref = needReference()
    const work = ref.work(String(input?.workId))
    if (!work) throw new Error('That work is not in the reference collection.')
    const saved = await saveDiscoveryToLibrary(
      { db: database!, reference: ref, dataDir, thumbnailsDir },
      work,
      { favorite: input.favorite === true, moodboardId: typeof input.moodboardId === 'string' ? input.moodboardId : undefined, journeyId: input.journeyId ?? null }
    )
    await discovery!.feedback(work.id, 'save', input.journeyId ? `journey:${input.journeyId}` : 'explore')
    notifyChanged()
    indexer?.kick()
    snapshotSoon()
    return saved
  })
  ipcMain.handle('history:get', () => {
    needReference()
    return history!.state()
  })

  ipcMain.handle('taste:state', () => taste!.state())
  ipcMain.handle('taste:next-pair', () => taste!.nextPair())
  ipcMain.handle('taste:choose', (_event, input: { aId: string; bId: string; winnerId: string | null; mode?: string }) => {
    if (!input || typeof input.aId !== 'string' || typeof input.bId !== 'string') throw new Error('Choose between two images.')
    const winner = typeof input.winnerId === 'string' ? input.winnerId : null
    const mode = ['warm', 'explore', 'random', 'uncertain'].includes(String(input.mode)) ? String(input.mode) : null
    return taste!.choose(input.aId, input.bId, winner, mode)
  })
  ipcMain.handle('taste:undo', () => taste!.undo())
  ipcMain.handle('taste:reset', () => taste!.reset())
  ipcMain.handle('taste:recommend', (_event, limit?: number) =>
    taste!.recommend(Number.isFinite(limit) ? Math.max(1, Math.min(60, Number(limit))) : 24)
  )
  ipcMain.handle('taste:examples', (_event, dimensionId: string) =>
    taste!.examples(typeof dimensionId === 'string' ? dimensionId.slice(0, 40) : '')
  )

  ipcMain.handle('ai:status', () => modelInstaller!.status)
  ipcMain.handle('ai:install', () => {
    // Called only from the consent dialog or the settings panel: the user has asked for the download.
    void modelInstaller!
      .install()
      .then(() => {
        setAiChoice('enabled')
        semantic?.invalidate()
        indexer?.kick()
      })
      .catch(() => undefined)
    return modelInstaller!.status
  })
  ipcMain.handle('ai:cancel', () => {
    modelInstaller!.cancel()
    return modelInstaller!.status
  })
  ipcMain.handle('ai:decline', () => {
    modelInstaller!.cancel()
    return setAiChoice('declined')
  })
  ipcMain.handle('ai:enable', () => {
    if (!modelInstaller!.installed) throw new Error('The image model is not installed yet.')
    return setAiChoice('enabled')
  })
  ipcMain.handle('ai:remove', async () => {
    indexer!.setEnabled(false)
    await indexer!.unload()
    await modelInstaller!.remove()
    semantic?.invalidate()
    return setAiChoice('declined')
  })

  ipcMain.handle('index:status', () => indexer!.status)
  ipcMain.handle('index:set-enabled', (_event, enabled: boolean) => {
    if (enabled === true && modelInstaller!.installed) setAiChoice('enabled')
    else if (enabled !== true) setAiChoice('declined')
    return indexer!.status
  })
  ipcMain.handle('index:pause', () => indexer!.pause())
  ipcMain.handle('index:resume', () => indexer!.resume())

  ipcMain.handle('app:open-data-folder', async () => {
    await shell.openPath(dataDir)
  })

  ipcMain.handle('organize:choose-destination', async (): Promise<string | null> => {
    if (!mainWindow) throw new Error('The Atlas window is not available.')
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for these images',
      message: 'Choose an existing folder, or create one. Atlas will never overwrite files.',
      buttonLabel: 'Choose folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    })
    if (selection.canceled || selection.filePaths.length === 0) return null
    return selection.filePaths[0] ?? null
  })

  ipcMain.handle('organize:execute', async (_event, request: OrganizeRequest) => {
    if (organizing) throw new Error('A filing operation is already running.')
    if (!request || (request.mode !== 'copy' && request.mode !== 'move')) {
      throw new Error('Choose whether to copy or move the images.')
    }
    if (typeof request.destination !== 'string' || !request.destination.trim()) {
      throw new Error('Choose a destination folder first.')
    }
    if (scans!.scanningIds.size > 0) {
      throw new Error('Wait for the current scan to finish before filing images.')
    }
    const selection = request.selection
    if (!selection || !['keep', 'pass', 'stars', 'all', 'manual'].includes(selection.kind)) {
      throw new Error('Choose which images to file.')
    }
    if (selection.kind === 'stars') {
      const minRating = Number(selection.minRating)
      if (!Number.isFinite(minRating) || minRating < 1 || minRating > 5) {
        throw new Error('Choose a valid star rating.')
      }
    }
    if (selection.kind === 'manual') {
      if (!Array.isArray(selection.ids) || selection.ids.length === 0) {
        throw new Error('Select at least one image.')
      }
      if (selection.ids.length > 10_000) throw new Error('Please file fewer images at a time.')
    }
    organizing = true
    try {
      const safeRequest: OrganizeRequest = {
        mode: request.mode,
        destination: request.destination,
        selection:
          selection.kind === 'stars'
            ? { kind: 'stars', minRating: Math.max(1, Math.min(5, Math.round(Number(selection.minRating)))) }
            : selection.kind === 'manual'
              ? { kind: 'manual', ids: selection.ids.filter((id): id is string => typeof id === 'string').slice(0, 10_000) }
              : selection
      }
      const result = await organizeImages(database!, safeRequest, {
        onProgress: (progress: OrganizeProgress) => broadcast('organize:progress', progress)
      })
      if (result.moved > 0) notifyChanged()
      return result
    } finally {
      organizing = false
    }
  })

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
}

function createWindow(): void {
  const state = loadWindowState()
  mainWindow = new BrowserWindow({
    ...state,
    width: state.width,
    height: state.height,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    frame: false,
    backgroundColor: '#0f100d',
    title: 'NOEMA Atlas',
    icon: existsSync(join(__dirname, '../../build/icon.ico')) ? join(__dirname, '../../build/icon.ico') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  })

  if (state.maximized) mainWindow.maximize()
  Menu.setApplicationMenu(null)
  mainWindow.setMenuBarVisibility(false)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('maximize', () => broadcast('window:maximized', true))
  mainWindow.on('unmaximize', () => broadcast('window:maximized', false))
  mainWindow.on('close', () => saveWindowState())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL()
    if (url !== current) event.preventDefault()
  })

  const rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function start(): Promise<void> {
  dataDir = app.getPath('userData')
  thumbnailsDir = join(dataDir, 'thumbnails')
  libraryDbPath = join(dataDir, 'library.db')
  mkdirSync(thumbnailsDir, { recursive: true })

  database = new AtlasDatabase(libraryDbPath)
  scans = new ScanManager(database, thumbnailsDir, {
    onEvent: (event: ScanEvent) => {
      broadcast('scan:event', event)
      if (event.state.phase === 'processing') statsWorker?.kick()
      // Start learning images while the folder is still being read, so search works almost immediately.
      const now = Date.now()
      if (event.state.phase === 'processing' && now - lastScanKick > 2500) {
        lastScanKick = now
        indexer?.kick()
      }
    },
    onChanged: () => {
      notifyChanged()
      semantic?.invalidate()
      indexer?.kick()
      statsWorker?.kick()
      refreshSmartSoon()
    }
  })
  // New pictures in the watched folders are noticed by themselves a few seconds after the files stop changing; "Check again" always works too.
  // (The end-to-end tests drive scanning by hand, so the watcher stays off there unless asked for.)
  if (process.env.NOEMA_E2E !== '1' || process.env.NOEMA_E2E_WATCH === '1') {
    sourceWatcher = new SourceWatcher((rootId) => {
      const root = database?.getRoot(rootId)
      if (root && scans) scans.enqueue(root, true)
    })
    const syncWatchers = (): void => sourceWatcher?.sync((database?.listRoots() ?? []).map((r) => ({ id: r.id, path: r.path })))
    syncWatchers()
    const syncTimer = setInterval(syncWatchers, 45_000)
    syncTimer.unref?.()
  }
  modelInstaller = new ModelInstaller({
    modelDir: modelDirectory(dataDir),
    choice: () => aiChoice,
    baseUrl: process.env.NOEMA_MODEL_BASE_URL || undefined,
    onStatus: (status) => broadcast('ai:status', status)
  })
  aiChoice = loadAiChoice(modelInstaller.installed)
  indexer = new Indexer(database, {
    dataDir,
    thumbnailsDir,
    enabled: aiChoice === 'enabled',
    onStatus: (status) => broadcast('index:status', status),
    onSaved: () => semantic?.invalidate(),
    onFinished: () => {
      refreshFamiliesIfStale()
      refreshSmartSoon()
    }
  })
  semantic = new SemanticSearch(database, () => indexer!.ensureEmbedder())
  smartCollections = new SmartCollections(database, semantic, {
    modelReady: () => aiChoice === 'enabled' && Boolean(modelInstaller?.installed),
    onChanged: () => broadcast('smart:changed')
  })
  statsWorker = new ImageStatsWorker(database, thumbnailsDir, () => refreshSmartSoon())
  reference = ReferenceCollection.load(referenceDir())
  taste = new TasteEngine(
    database,
    semantic,
    () => indexer!.ensureEmbedder(),
    () => aiChoice === 'enabled' && Boolean(modelInstaller?.installed),
    new TechnicalGuard(reference, () => indexer!.ensureEmbedder())
  )

  if (reference) {
    const concepts = new ConceptSpace(() => indexer!.ensureEmbedder(), reference)
    discovery = new DiscoveryEngine(database, reference, concepts)
    identityEngine = new IdentityEngine(database, semantic, reference, concepts, () => aiChoice === 'enabled' && Boolean(modelInstaller?.installed))
    compareEngine = new CompareEngine(database, reference, concepts, identityEngine, discovery)
    journeys = new JourneyEngine(database, reference, concepts, discovery, identityEngine)
    history = new HistoryEngine(database, reference, identityEngine, discovery)
  }
  registerMediaProtocol(database, thumbnailsDir, (id) => reference?.imagePath(id) ?? null)
  registerIpc()
  registerAssistant({
    dataDir,
    db: () => database!,
    semantic: () => semantic,
    reference: () => reference,
    identity: () => identityEngine,
    taste: () => taste,
    journeys: () => journeys,
    aiOn: () => aiChoice === 'enabled' && Boolean(modelInstaller?.installed),
    embedder: () => indexer!.ensureEmbedder(),
    embeddedCount: () => database!.getEmbeddingStats(EMBEDDING_MODEL).indexed,
    broadcast,
    notifyChanged,
    smart: () => smartCollections,
    thumbnailsDir,
    capabilities: () => (studioApi ? studioApi.studio.capabilities() : Promise.resolve([])),
    studio: () => studioApi?.studio ?? null,
    organizer: () => organizerEngine
  })
  const studioApi = registerStudio({
    dataDir,
    db: () => database!,
    semantic: () => semantic,
    scans: () => scans,
    aiOn: () => aiChoice === 'enabled' && Boolean(modelInstaller?.installed),
    embedder: () => indexer!.ensureEmbedder(),
    atlasModelInstalled: () => Boolean(modelInstaller?.installed),
    broadcast,
    notifyChanged
  })
  organizerEngine = registerOrganizer({
    dataDir,
    db: () => database!,
    semantic: () => semantic,
    reference: () => reference,
    identity: () => identityEngine,
    taste: () => taste,
    smart: () => smartCollections,
    embedder: () => indexer!.ensureEmbedder(),
    thumbnailsDir,
    broadcast
  }).engine
  createWindow()
  indexer.kick()
  statsWorker.kick()
  // Warm up visual search in the background so the first query is as fast as the rest.
  if (indexer.searchable && database.getEmbeddingStats(EMBEDDING_MODEL).indexed > 0) {
    void semantic.rank({ text: 'warm up' }).catch(() => undefined)
  }

  const seed = process.env.NOEMA_E2E_SEED
  if (seed && process.env.NOEMA_E2E === '1') {
    const folders = seed
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (folders.length > 0) await addFoldersToAtlas(folders)
  }
}

app.whenReady().then(() => {
  void start().catch((error: unknown) => {
    dialog.showErrorBox(
      'NOEMA Atlas could not start',
      error instanceof Error ? error.message : 'An unexpected error occurred while opening the library.'
    )
    app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && database) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (closing) return
  closing = true
  sourceWatcher?.close()
  scans?.cancelAll()
  const finish = (): void => {
    try {
      database?.close()
    } catch {
      // The library is already durable; a close failure should not block quitting.
    }
  }
  if (indexer) {
    // Let the current embedding batch finish so the database is not closed underneath it.
    event.preventDefault()
    void indexer
      .dispose()
      .catch(() => undefined)
      .finally(() => {
        finish()
        app.quit()
      })
  } else {
    finish()
  }
})
