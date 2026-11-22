import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron'
import type { AtlasDatabase } from '../db'
import type { Embedder } from '../embedder'
import type { SemanticSearch } from '../semantic'
import type { ScanManager } from '../scanner'
import { loadVocabulary } from '../families'
import type { SecretBox } from '../assistant/settings'
import type { ConceptRequest, EditRegion, EditReferences, EditRequest, GenerateRequest, RefInfluence, RefRole, ReferenceAspect, RetouchRequest, StudioSettingsUpdate, UpscaleRequest } from '../../shared/studio'
import { Studio } from './studio'
import { AiPackages } from './aiPackages'
import type { AiMode, CapabilityId } from '../../shared/ai'
import type { VisualNotes } from './concept'
import { BoardEditor } from './boardEdit'
import { DEFAULT_EXCLUDED_NAMES, discover, listDrives, previewSamples } from '../drives'
import { isPathInsideOrEqual } from '../scanner'
import { registerModelLibrary } from '../modelLibrary/register'
import type { DiscoveryOptions } from '../../shared/discovery'

export interface StudioWiring {
  dataDir: string
  db: () => AtlasDatabase
  semantic: () => SemanticSearch | null
  scans: () => ScanManager | null
  aiOn: () => boolean
  embedder: () => Promise<Embedder>
  /** Whether Atlas's own image-understanding model is installed (shown in the AI Model Library). */
  atlasModelInstalled?: () => boolean
  broadcast: (channel: string, payload?: unknown) => void
  notifyChanged: () => void
}

const osSecretBox: SecretBox = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data)
}

/** Where finished pictures go: a visible folder, so artists can find their work outside Atlas too. */
export function studioFolder(): string {
  if (process.env.NOEMA_STUDIO_DIR) return process.env.NOEMA_STUDIO_DIR
  try {
    return join(app.getPath('pictures'), 'NOEMA Atlas Studio')
  } catch {
    return join(app.getPath('userData'), 'studio-pictures')
  }
}

const REGION_NAMES = ['sky', 'top', 'bottom', 'left', 'right', 'center', 'background', 'foreground']

/** Checks a region that came from the interface or a tool; anything unexpected is dropped. */
export function cleanRegion(value: unknown): EditRegion | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const num01 = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0)
  const region: EditRegion = {}
  if (typeof v.named === 'string' && REGION_NAMES.includes(v.named)) region.named = v.named as EditRegion['named']
  const sh = v.shape as Record<string, unknown> | undefined
  if (sh && typeof sh === 'object' && (sh.kind === 'rect' || sh.kind === 'ellipse')) region.shape = { kind: sh.kind, x: num01(sh.x), y: num01(sh.y), w: num01(sh.w), h: num01(sh.h) }
  if (typeof v.maskPng === 'string' && v.maskPng.length < 12_000_000) region.maskPng = v.maskPng
  if (v.invert === true) region.invert = true
  if (typeof v.feather === 'number' && Number.isFinite(v.feather)) region.feather = Math.max(0, Math.min(80, v.feather))
  return region.named || region.shape || region.maskPng ? region : undefined
}

export function cleanReferences(value: unknown): EditReferences | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const ids = Array.isArray(v.imageIds) ? v.imageIds.filter((x): x is string => typeof x === 'string').slice(0, 12) : []
  if (ids.length === 0) return undefined
  const aspects = (Array.isArray(v.aspects) ? v.aspects : []).filter((a): a is ReferenceAspect => a === 'lighting' || a === 'colour' || a === 'atmosphere')
  return {
    imageIds: ids,
    aspects: aspects.length ? aspects : ['atmosphere'],
    amount: typeof v.amount === 'number' && Number.isFinite(v.amount) ? Math.max(0, Math.min(1, v.amount)) : undefined,
    conditioning: v.conditioning === 'images' ? 'images' : v.conditioning === 'look' ? 'look' : undefined,
    roles: cleanRoles(v.roles),
    influence: cleanInfluence(v.influence)
  }
}

const ROLE_NAMES = ['atmosphere', 'composition', 'colour', 'material', 'subject'] as const
function cleanRoles(value: unknown): Record<string, RefRole[]> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, RefRole[]> = {}
  for (const [id, roles] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
    if (!Array.isArray(roles)) continue
    const clean = roles.filter((r): r is RefRole => typeof r === 'string' && (ROLE_NAMES as readonly string[]).includes(r))
    if (clean.length) out[id.slice(0, 80)] = Array.from(new Set(clean))
  }
  return Object.keys(out).length ? out : undefined
}
function cleanInfluence(value: unknown): Record<string, RefInfluence> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, RefInfluence> = {}
  for (const [id, v] of Object.entries(value as Record<string, unknown>).slice(0, 24)) if (v === 'subtle' || v === 'balanced' || v === 'strong') out[id.slice(0, 80)] = v
  return Object.keys(out).length ? out : undefined
}

export function registerStudio(wiring: StudioWiring): { studio: Studio; boards: BoardEditor; ai: AiPackages } {
  const db = wiring.db()
  const studio = new Studio({
    db,
    dataDir: wiring.dataDir,
    studioDir: studioFolder(),
    box: osSecretBox,
    fetchImpl: (url, init) => fetch(url, init as RequestInit),
    enqueueScan: (root) => wiring.scans()?.enqueue(root),
    broadcast: wiring.broadcast,
    notifyChanged: wiring.notifyChanged,
    openPath: (path) => shell.openPath(path),
    attention: (title, body) => {
      // The edit came back while the user is in the other program: flash the taskbar button and say so, without taking focus.
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed() || win.isFocused()) return
      win.flashFrame(true)
      win.once('focus', () => win.flashFrame(false))
      try {
        if (Notification.isSupported()) {
          const note = new Notification({ title, body, silent: true })
          note.on('click', () => {
            if (win.isMinimized()) win.restore()
            win.focus()
          })
          note.show()
        }
      } catch {
        // The taskbar flash is enough.
      }
    },
    visualNotes: async (ids) => {
      const semantic = wiring.semantic()
      if (!semantic || !wiring.aiOn()) return {}
      const snap = semantic.snapshot()
      const rows = new Map(snap.ids.map((id, row) => [id, row]))
      const vocab = await loadVocabulary(await wiring.embedder())
      const out: Record<string, VisualNotes> = {}
      for (const id of ids) {
        const row = rows.get(id)
        if (row === undefined || snap.dim !== vocab.dim) continue
        const vector = snap.matrix.slice(row * snap.dim, (row + 1) * snap.dim)
        const best: Record<string, { score: number; label: string }> = {}
        vocab.terms.forEach((term, t) => {
          if (term.generic) return
          let dot = 0
          for (let d = 0; d < vocab.dim; d += 1) dot += vector[d]! * vocab.vectors[t * vocab.dim + d]!
          const cur = best[term.kind]
          if (!cur || dot > cur.score) best[term.kind] = { score: dot, label: term.kind === 'subject' ? term.label : (term.adjective ?? term.label) }
        })
        out[id] = { subject: best.subject?.label, mood: best.atmosphere?.label, style: best.style?.label, colour: best.colour?.label }
      }
      return out
    }
  })
  const boards = new BoardEditor(db, wiring.notifyChanged)

  // Atlas's own ComfyUI and optional capability packages. Everything it writes stays inside the folder the user chooses.
  const ai = new AiPackages({
    dataDir: wiring.dataDir,
    broadcast: wiring.broadcast,
    useRuntime: (folder, args, port) => studio.useManagedRuntime(folder, args, port),
    modelsChanged: () => studio.modelsChanged(),
    verifyRuntime: async () => {
      // Starts the new ComfyUI once, checks that it answers, and closes it again.
      try {
        const status = await studio.comfyStart()
        if (status.state !== 'running') return status.detail ?? status.headline ?? 'ComfyUI did not start.'
        const wasMine = status.startedByAtlas
        if (wasMine) await studio.comfyStop()
        return null
      } catch (error) {
        return error instanceof Error ? error.message : 'ComfyUI did not start.'
      }
    }
  })
  studio.attachAi(ai)
  registerModelLibrary({ dataDir: wiring.dataDir, ai, studio, broadcast: wiring.broadcast, atlasModelInstalled: wiring.atlasModelInstalled })

  const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '')
  const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

  ipcMain.handle('studio:settings', () => studio.settings())
  ipcMain.handle('studio:update-settings', async (_e, change: StudioSettingsUpdate) => {
    if (!change || typeof change !== 'object') throw new Error('Nothing to change.')
    studio.update(change)
    return studio.settings()
  })
  ipcMain.handle('studio:concept', (_e, request: ConceptRequest) => {
    if (!request || typeof request.moodboardId !== 'string') throw new Error('Choose a moodboard.')
    return studio.concept({ moodboardId: request.moodboardId, intent: str(request.intent, 1500), roles: request.roles && typeof request.roles === 'object' ? request.roles : {}, aspect: request.aspect })
  })
  ipcMain.handle('studio:estimate', (_e, methodId: unknown, model: unknown, count: unknown, width: unknown, height: unknown) =>
    studio.estimate(methodId === 'comfyui' || methodId === 'openai' ? methodId : 'blend', str(model, 80) || undefined, num(count, 1), num(width, 1024), num(height, 1024))
  )
  ipcMain.handle('studio:generate', (_e, request: GenerateRequest) => {
    if (!request || typeof request !== 'object') throw new Error('Nothing to make.')
    return studio.generate({
      jobId: str(request.jobId, 60) || undefined,
      methodId: request.methodId === 'comfyui' || request.methodId === 'openai' ? request.methodId : 'blend',
      model: str(request.model, 120) || undefined,
      moodboardId: typeof request.moodboardId === 'string' ? request.moodboardId : null,
      title: str(request.title, 120),
      prompt: str(request.prompt, 3000),
      negative: str(request.negative, 1500),
      width: num(request.width, 1024),
      height: num(request.height, 1024),
      count: num(request.count, 1),
      seed: typeof request.seed === 'number' ? request.seed : undefined,
      roles: cleanRoles(request.roles) ?? {},
      influence: cleanInfluence(request.influence),
      referenceMode: request.referenceMode === 'images' || request.referenceMode === 'description' ? request.referenceMode : 'auto',
      parentId: typeof request.parentId === 'string' ? request.parentId : null,
      seriesId: typeof request.seriesId === 'string' ? request.seriesId : null,
      strength: typeof request.strength === 'number' ? request.strength : undefined,
      approvedCost: num(request.approvedCost, 0),
      approvedUpload: request.approvedUpload === true
    })
  })
  ipcMain.handle('studio:reference-pipelines', () => studio.referencePipelines())
  ipcMain.handle('studio:stop', (_e, jobId: unknown) => studio.stop(str(jobId, 60)))

  // ComfyUI: choose the installation once; Atlas starts and uses it from then on.
  ipcMain.handle('studio:comfy-status', () => studio.comfyStatus())
  ipcMain.handle('studio:comfy-choose-folder', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { title: 'Choose your ComfyUI folder', message: 'Choose the folder that contains ComfyUI.exe, run_nvidia_gpu.bat or main.py. Atlas only reads it.', buttonLabel: 'Use this ComfyUI', properties: ['openDirectory' as const, 'dontAddToRecent' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return studio.settings()
    studio.update({ comfyFolder: picked.filePaths[0]! })
    return studio.settings()
  })
  // Pick the Python of this ComfyUI, or a folder with workflows outside the installation. Only read.
  ipcMain.handle('studio:comfy-pick', async (_e, what: unknown) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const python = what === 'python'
    const options = python
      ? { title: 'Choose the Python for ComfyUI', message: 'Choose python.exe, usually inside the ComfyUI virtual environment (venv\\Scripts\\python.exe). Atlas only starts it.', buttonLabel: 'Use this Python', properties: ['openFile' as const, 'dontAddToRecent' as const], filters: [{ name: 'Python', extensions: ['exe'] }] }
      : { title: 'Add a folder with ComfyUI workflows', message: 'Atlas reads the workflow files (.json) in this folder and the folders inside it. It never changes them.', buttonLabel: 'Add this folder', properties: ['openDirectory' as const, 'dontAddToRecent' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return studio.settings()
    const path = picked.filePaths[0]!
    if (python) studio.update({ comfyPython: path })
    else studio.update({ comfyWorkflowFolders: [...(await studio.settings()).comfyWorkflowFolders, path] })
    return studio.settings()
  })
  ipcMain.handle('studio:comfy-start', async () => {
    await studio.comfyStart()
    return studio.settings()
  })
  ipcMain.handle('studio:comfy-stop', async () => {
    await studio.comfyStop()
    return studio.settings()
  })
  ipcMain.handle('studio:comfy-rescan', async () => {
    await studio.comfyRescan()
    return studio.settings()
  })
  ipcMain.handle('studio:edit', (_e, request: EditRequest) => {
    if (!request || typeof request.imageId !== 'string') throw new Error('Choose a picture.')
    return studio.edit({
      jobId: str(request.jobId, 60) || undefined,
      imageId: request.imageId,
      methodId: request.methodId === 'comfyui' || request.methodId === 'openai' ? request.methodId : 'blend',
      model: str(request.model, 120) || undefined,
      instruction: str(request.instruction, 1500),
      strength: num(request.strength, 0.6),
      approvedCost: num(request.approvedCost, 0),
      approvedUpload: request.approvedUpload === true,
      workflowId: typeof request.workflowId === 'string' ? request.workflowId.slice(0, 40) : null,
      level: request.level === 'subtle' || request.level === 'creative' || request.level === 'radical' ? request.level : undefined,
      prompt: typeof request.prompt === 'string' ? request.prompt.slice(0, 1500) : undefined,
      region: cleanRegion(request.region),
      references: cleanReferences(request.references),
      count: Math.max(1, Math.min(4, Math.round(num(request.count, 1)))),
      seed: Number.isFinite(request.seed) ? Math.floor(request.seed!) : undefined
    })
  })
  ipcMain.handle('studio:retouch', (_e, request: RetouchRequest) => {
    if (!request || typeof request.imageId !== 'string') throw new Error('Choose a picture.')
    const region = cleanRegion(request.region)
    if (!region) throw new Error('Paint over the part to work on.')
    return studio.retouch({
      jobId: str(request.jobId, 60) || undefined,
      imageId: request.imageId,
      tool: (['remove', 'heal', 'blur', 'sharpen', 'tone'] as const).find((t) => t === request.tool) ?? 'remove',
      tone: request.tone === 'darken' ? 'darken' : request.tone === 'lighten' ? 'lighten' : undefined,
      region,
      strength: num(request.strength, 0.5),
      edgeAware: request.edgeAware === true,
      method: request.method === 'comfyui' || request.method === 'openai' ? request.method : 'local',
      hint: str(request.hint, 300) || undefined,
      seedLocal: request.seedLocal !== false,
      model: str(request.model, 120) || undefined,
      seed: Number.isFinite(request.seed) ? Math.floor(request.seed!) : undefined,
      approvedCost: num(request.approvedCost, 0),
      approvedUpload: request.approvedUpload === true,
      previewEdge: num(request.previewEdge, 1600),
      baseId: str(request.baseId, 80) || undefined
    })
  })
  ipcMain.handle('studio:retouch-hold', (_e, hold: unknown, release: unknown) => studio.holdRetouch(Array.isArray(hold) ? hold.filter((x): x is string => typeof x === 'string').slice(0, 100) : [], Array.isArray(release) ? release.filter((x): x is string => typeof x === 'string').slice(0, 100) : []))
  ipcMain.handle('studio:region-preview', (_e, imageId: unknown, region: unknown) => {
    const cleaned = cleanRegion(region)
    if (!cleaned) throw new Error('Choose which part of the picture to change.')
    return studio.previewRegion(str(imageId, 80), cleaned)
  })
  ipcMain.handle('studio:versions', (_e, imageId: unknown) => studio.versions(str(imageId, 80)))
  ipcMain.handle('studio:upscale', (_e, request: UpscaleRequest) => {
    if (!request || typeof request.imageId !== 'string') throw new Error('Choose a picture.')
    return studio.upscale({
      jobId: str(request.jobId, 60) || undefined,
      imageId: request.imageId,
      workflowId: typeof request.workflowId === 'string' && request.workflowId ? request.workflowId.slice(0, 200) : null,
      targetLongEdge: num(request.targetLongEdge, 0),
      subject: ['general', 'vegetation', 'architecture', 'faces', 'texture'].includes(String(request.subject)) ? request.subject : undefined
    })
  })
  ipcMain.handle('studio:edit-commit', (_e, pendingId: unknown) => studio.commitEdit(str(pendingId, 60)))
  ipcMain.handle('studio:edit-discard', (_e, pendingId: unknown) => studio.discardEdit(str(pendingId, 60)))
  ipcMain.handle('studio:generations', (_e, boardId: unknown) => studio.generations(typeof boardId === 'string' ? boardId : undefined))
  ipcMain.handle('studio:provenance', (_e, imageId: unknown) => (typeof imageId === 'string' ? studio.provenance(imageId) : null))
  ipcMain.handle('studio:external-start', (_e, imageId: unknown, editorId: unknown) => studio.startExternalEdit(str(imageId, 80), typeof editorId === 'string' ? editorId : null))
  ipcMain.handle('studio:external-import', (_e, id: unknown) => studio.importExternal(str(id, 40)))
  ipcMain.handle('studio:external-end', (_e, id: unknown) => studio.endExternal(str(id, 40)))
  ipcMain.handle('studio:external-sessions', () => studio.externalSessions())
  ipcMain.handle('studio:external-candidates', (_e, id: unknown) => studio.externalCandidates(str(id, 40)))
  ipcMain.handle('studio:external-import-file', (_e, id: unknown, path: unknown) => studio.importExternalFile(str(id, 40), str(path, 1000)))
  ipcMain.handle('studio:external-choose', async (_e, id: unknown) => {
    // The user points at the file their program saved (in another folder, or in a format it chose).
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { title: 'Choose the file you saved', properties: ['openFile' as const, 'dontAddToRecent' as const], filters: [{ name: 'Pictures and Photoshop files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff', 'bmp', 'gif', 'avif', 'psd', 'psb'] }] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return null
    return studio.importExternalFile(str(id, 40), picked.filePaths[0])
  })
  ipcMain.handle('studio:open-folder', () => shell.openPath(studioFolder()))

  ipcMain.handle('boards:undo-info', (_e, boardId: unknown) => boards.lastSnapshot(str(boardId, 80)))
  ipcMain.handle('boards:undo', (_e, boardId: unknown) => boards.undo(str(boardId, 80)))
  ipcMain.handle('boards:tidy', (_e, boardId: unknown) => boards.arrange(str(boardId, 80), 'tidy'))

  // ---- finding pictures across drives (read-only, preview before anything is indexed) -------------------------------------
  let discovery: AbortController | null = null
  let allowedSamples = new Set<string>()
  ipcMain.handle('discover:drives', async () => {
    // Only for the automated end-to-end test, so it can search a small prepared folder instead of a real drive.
    const test = process.env.NOEMA_E2E === '1' ? process.env.NOEMA_DISCOVER_ROOTS : undefined
    const drives = test ? test.split(';').filter(Boolean).map((path) => ({ path, label: path, isSystem: false })) : await listDrives()
    return { drives, excluded: DEFAULT_EXCLUDED_NAMES }
  })
  ipcMain.handle('discover:choose-folder', async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (!window) return null
    const choice = await dialog.showOpenDialog(window, { title: 'Choose a folder to leave out', properties: ['openDirectory', 'dontAddToRecent'] })
    return choice.canceled ? null : (choice.filePaths[0] ?? null)
  })
  ipcMain.handle('discover:start', async (_e, options: DiscoveryOptions) => {
    if (!options || !Array.isArray(options.roots) || options.roots.length === 0) throw new Error('Choose at least one drive or folder to search.')
    if (discovery) throw new Error('A search is already running.')
    const controller = new AbortController()
    discovery = controller
    try {
      const roots = db.listRoots()
      const result = await discover(
        {
          roots: options.roots.filter((r) => typeof r === 'string').slice(0, 30),
          excludePaths: (Array.isArray(options.excludePaths) ? options.excludePaths : []).filter((r) => typeof r === 'string').slice(0, 200),
          includeNames: Array.isArray(options.includeNames) ? options.includeNames.filter((n) => typeof n === 'string').slice(0, 50) : [],
          minImages: Math.max(1, Math.min(500, num(options.minImages, 8)))
        },
        controller.signal,
        (progress) => wiring.broadcast('discover:progress', progress),
        (path) => roots.some((r) => isPathInsideOrEqual(r.path, path))
      )
      allowedSamples = new Set(result.collections.flatMap((c) => c.samples))
      return result
    } finally {
      discovery = null
    }
  })
  ipcMain.handle('discover:stop', () => discovery?.abort())
  ipcMain.handle('discover:preview', (_e, paths: unknown) => previewSamples(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && allowedSamples.has(p)) : []))

  // ---- the optional AI components: connect, let Atlas install its own, or none ---------------------------------------------
  ipcMain.handle('aipkg:status', () => ai.status())
  ipcMain.handle('aipkg:capabilities', () => studio.capabilities())
  ipcMain.handle('aipkg:set-mode', (_e, mode: unknown) => {
    if (mode !== 'none' && mode !== 'connect' && mode !== 'managed') throw new Error('Choose one of the three ways.')
    ai.setMode(mode as AiMode)
    return ai.status()
  })
  ipcMain.handle('aipkg:choose-root', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { title: 'Where should Atlas keep its AI?', message: 'Choose or create an empty folder, on a drive with plenty of room. Atlas keeps everything it installs inside it.', buttonLabel: 'Use this folder', properties: ['openDirectory' as const, 'createDirectory' as const, 'dontAddToRecent' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]!
  })
  ipcMain.handle('aipkg:install-runtime', async (_e, request: { root?: unknown; consent?: unknown }) => {
    const status = await ai.installRuntime(str(request?.root, 500), request?.consent === true)
    wiring.notifyChanged()
    return status
  })
  ipcMain.handle('aipkg:install-packages', async (_e, request: { ids?: unknown; consent?: unknown }) => {
    const ids = (Array.isArray(request?.ids) ? request.ids : []).filter((i): i is CapabilityId => i === 'create' || i === 'edit' || i === 'upscale')
    return ai.installPackages(ids, request?.consent === true)
  })
  ipcMain.handle('aipkg:stop', () => ai.stop())
  ipcMain.handle('aipkg:check-update', async () => {
    await ai.checkForUpdate()
    return ai.status()
  })
  ipcMain.handle('aipkg:update', (_e, consent: unknown) => ai.updateRuntime(consent === true))
  ipcMain.handle('aipkg:verify', () => ai.verifyFiles())
  ipcMain.handle('aipkg:uninstall', async () => {
    await studio.comfyStop().catch(() => undefined)
    await ai.uninstall()
    studio.update({ comfyFolder: null })
    return ai.status()
  })

  app.on('before-quit', () => studio.dispose())
  return { studio, boards, ai }
}
