/**
 * Everything Atlas knows about the user's ComfyUI: which installation it is, what models and workflows it has, whether
 * it is running, and what is missing in plain words. Nothing here changes the user's ComfyUI folders or settings.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ComfyStatus, ComfyWorkflowSummary } from '../../shared/studio'
import { ComfyLauncher, ComfyStartError, type Connection, type FetchFn, type LaunchOptions } from './comfyLauncher'
import { identifyInstall, suggestInstalls, type ComfyInstall } from './comfyInstall'
import { CATEGORY_LABEL, scanModels, type ModelCategory, type ModelInventory } from './comfyModels'
import { convertUiToApi, isApiFormat, isUiFormat, scanWorkflows, type ApiWorkflow, type ObjectInfo, type WorkflowInfo, type UiWorkflow } from './comfyWorkflows'

export interface ManagerDeps {
  fetchImpl: FetchFn
  appData?: string
  localAppData?: string
  home?: string
  launcher?: ComfyLauncher
}

export interface ManagerSettings {
  folder: string | null
  /** An address the user set by hand (advanced). */
  url: string | null
  autoStart: boolean
  /** A Python chosen for this installation (for example a virtual environment outside the ComfyUI folder). */
  python?: string | null
  /** A fixed port. When set, only this port is used. */
  port?: number | null
  /** Extra start options. */
  args?: string[]
  /** Folders with workflow files outside the installation. */
  workflowFolders?: string[]
  /** Extra start options added for one run only (not saved). */
  extraArgs?: string[]
}

const launchOf = (settings: ManagerSettings): LaunchOptions => ({ python: settings.python ?? null, port: settings.port ?? null, args: settings.args ?? [], extraArgs: settings.extraArgs ?? [] })

export class ComfyManager {
  readonly launcher: ComfyLauncher
  private install: ComfyInstall | null = null
  private installFolder: string | null = null
  private inventory: ModelInventory | null = null
  private workflows: WorkflowInfo[] = []
  private problem: string | null = null
  private extraWorkflowFolders: string[] = []
  private lastRunning: { url: string; managed: boolean } | null = null

  constructor(private deps: ManagerDeps) {
    this.launcher = deps.launcher ?? new ComfyLauncher({ fetchImpl: deps.fetchImpl })
  }

  // ---- the installation ---------------------------------------------------------------------------------------------

  /** Reads the chosen folder again (the user may have added models or workflows). */
  load(folder: string | null, options: { python?: string | null; workflowFolders?: string[] } = {}): void {
    this.problem = null
    this.extraWorkflowFolders = (options.workflowFolders ?? []).filter(Boolean)
    if (!folder) {
      this.install = null
      this.installFolder = null
      this.inventory = null
      this.workflows = []
      return
    }
    const result = identifyInstall(folder, { appData: this.deps.appData, python: options.python })
    if ('problem' in result) {
      this.install = null
      this.installFolder = folder
      this.inventory = null
      this.workflows = []
      this.problem = result.problem
      return
    }
    this.install = result.install
    this.installFolder = folder
    this.rescan()
  }

  rescan(): void {
    if (!this.install) return
    this.inventory = scanModels({ dataFolder: this.install.dataFolder, extraConfigs: this.install.extraConfigFiles })
    const workflowFolders = [join(this.install.dataFolder, 'user', 'default', 'workflows'), join(this.install.serverFolder, 'user', 'default', 'workflows')]
    const own = scanWorkflows(Array.from(new Set(workflowFolders)), this.inventory)
    // Folders outside the installation are often a project's own (with manifests and settings beside the workflows).
    const outside = scanWorkflows(this.extraWorkflowFolders, this.inventory, { hideNonWorkflows: true })
    const seen = new Set(own.map((w) => w.file.toLowerCase()))
    const rank: Record<string, number> = { generate: 0, edit: 1, upscale: 2, other: 3, video: 4, audio: 5 }
    this.workflows = [...own, ...outside.filter((w) => !seen.has(w.file.toLowerCase()))].sort((a, b) => Number(b.runnable) - Number(a.runnable) || rank[a.kind]! - rank[b.kind]! || a.name.localeCompare(b.name))
  }

  get current(): ComfyInstall | null {
    return this.install
  }

  /** Why the chosen folder was not accepted, if it was not. */
  get problemNow(): string | null {
    return this.problem
  }

  get inventoryNow(): ModelInventory | null {
    return this.inventory
  }

  workflowById(id: string | null | undefined): WorkflowInfo | null {
    return id ? (this.workflows.find((w) => w.id === id) ?? null) : null
  }

  allWorkflows(): WorkflowInfo[] {
    return this.workflows
  }

  suggestions(): ComfyInstall[] {
    return suggestInstalls({ localAppData: this.deps.localAppData, home: this.deps.home, appData: this.deps.appData })
  }

  // ---- what is missing, in plain words ---------------------------------------------------------------------------------

  /** Whether the standard graph can run: it needs a checkpoint. */
  get hasCheckpoint(): boolean {
    return (this.inventory?.byCategory.checkpoints.length ?? 0) > 0
  }

  /** The reasons pictures cannot be made yet, in simple language. Empty when something can be made. */
  needs(selected: WorkflowInfo | null): string[] {
    if (!this.install) return this.problem ? [this.problem] : ['Choose your ComfyUI folder once, and Atlas will do the rest.']
    if (selected?.runnable) return []
    if (this.hasCheckpoint) return []
    const out: string[] = []
    if (selected && !selected.runnable && selected.why) out.push(`The workflow you chose cannot run yet. ${selected.why}`)
    const ready = this.workflows.filter((w) => w.runnable && (w.kind === 'generate' || w.kind === 'edit'))
    if (ready.length > 0) return out
    out.push('ComfyUI has no model Atlas can use yet. Atlas needs either a checkpoint file in ComfyUI’s models\\checkpoints folder, or one of your workflows with all of its models installed.')
    const nearlyReady = this.workflows.filter((w) => !w.runnable && (w.kind === 'generate' || w.kind === 'edit') && w.missing.length > 0).slice(0, 3)
    for (const w of nearlyReady) out.push(`“${w.name}” is only missing ${w.missing.slice(0, 2).map((m) => `“${m.name}”`).join(' and ')}${w.missing.length > 2 ? ' and more' : ''}.`)
    return out
  }

  // ---- connection -----------------------------------------------------------------------------------------------------

  /** Cheap: is something answering right now (ours or the user's)? */
  async probe(settings: ManagerSettings): Promise<{ url: string; managed: boolean } | null> {
    const managed = this.launcher.managedUrl
    if (settings.port) {
      // A fixed port: only that address is this ComfyUI.
      const fixed = `http://127.0.0.1:${settings.port}`
      const hit = await this.launcher.probeUrl(fixed)
      this.lastRunning = hit ? { url: fixed, managed: Boolean(managed && fixed === managed) } : null
      return this.lastRunning
    }
    const preferred = [settings.url, this.install ? `http://127.0.0.1:${this.install.defaultPort}` : null].filter((u): u is string => Boolean(u))
    const url = await this.launcher.findRunning(managed ? [managed, ...preferred] : preferred)
    this.lastRunning = url ? { url, managed: Boolean(managed && url === managed) } : null
    return this.lastRunning
  }

  /** Connects to the running ComfyUI, or starts it from the installation. */
  async connect(settings: ManagerSettings, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<Connection> {
    const running = await this.probe(settings)
    if (running) return running
    if (!this.install) {
      throw new ComfyStartError('ComfyUI is not running, and no ComfyUI folder has been chosen. Choose it once in the Studio settings and Atlas will start it for you.')
    }
    if (!settings.autoStart) throw new ComfyStartError('ComfyUI is not running. Start it from the Studio settings, or turn on “Start ComfyUI when needed”.')
    const connection = await this.launcher.ensureRunning(this.install, { preferredUrl: settings.url ?? undefined, onProgress, signal, launch: launchOf(settings) })
    this.lastRunning = connection
    return connection
  }

  stop(): boolean {
    this.lastRunning = null
    return this.launcher.stop()
  }

  stopAndWait(): Promise<boolean> {
    this.lastRunning = null
    return this.launcher.stopAndWait()
  }

  /** The node definitions of the running ComfyUI, needed to turn the editor's workflow files into runnable ones. */
  async objectInfo(url: string): Promise<ObjectInfo> {
    const response = await this.deps.fetchImpl(`${url.replace(/\/+$/, '')}/object_info`)
    if (!response.ok) throw new Error('ComfyUI did not describe its nodes.')
    return (await response.json()) as ObjectInfo
  }

  /** A workflow ready to run: used as it is when it is in the API format, converted when it is the editor's format. */
  async prepare(info: WorkflowInfo, url: string): Promise<ApiWorkflow> {
    const workflow = await this.prepareRaw(info, url)
    const missing = await this.missingNodes(workflow, url)
    if (missing.length > 0) {
      throw new Error(`“${info.name}” needs ${missing.length === 1 ? 'a ComfyUI node' : 'ComfyUI nodes'} that ${missing.length === 1 ? 'is' : 'are'} not installed here: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' and more' : ''}. They come from custom nodes, which Atlas never installs. Install them in ComfyUI’s custom_nodes folder, or use ComfyUI itself to add them.`)
    }
    return workflow
  }

  private async prepareRaw(info: WorkflowInfo, url: string): Promise<ApiWorkflow> {
    let data: unknown
    try {
      data = JSON.parse(readFileSync(info.file, 'utf8')) as unknown
    } catch {
      throw new Error(`The workflow “${info.name}” could not be read.`)
    }
    if (isApiFormat(data)) return data
    if (isUiFormat(data)) {
      const converted = convertUiToApi(data as UiWorkflow, await this.objectInfo(url))
      if ('problem' in converted) throw new Error(`“${info.name}”: ${converted.problem}`)
      return converted.prompt
    }
    throw new Error(`“${info.name}” is not a ComfyUI workflow.`)
  }

  /** The nodes a workflow uses that the running ComfyUI does not have (custom nodes that are not installed). */
  async missingNodes(workflow: ApiWorkflow, url: string): Promise<string[]> {
    try {
      const info = await this.objectInfo(url)
      return Array.from(new Set(Object.values(workflow).map((n) => n.class_type))).filter((type) => !(type in info))
    } catch {
      return []
    }
  }

  // ---- what the window shows -----------------------------------------------------------------------------------------

  /** How ComfyUI will be started, in a form the window can show and the user can change. */
  private launchView(settings: ManagerSettings): NonNullable<ComfyStatus['launch']> {
    const install = this.install!
    const found = install.launch?.kind === 'python' ? install.launch.python : null
    const python = settings.python && existsSync(settings.python) ? settings.python : found
    return {
      kind: install.launch?.kind ?? 'none',
      python: install.launch?.kind === 'python' ? python : null,
      pythonChosen: Boolean(settings.python),
      port: settings.port ?? null,
      effectivePort: settings.port ?? install.defaultPort,
      args: settings.args ?? [],
      profiles: install.profiles.map((p) => ({ name: p.name, file: p.file, port: p.port, args: p.args }))
    }
  }

  async status(settings: ManagerSettings, selected: WorkflowInfo | null): Promise<ComfyStatus> {
    const running = await this.probe(settings)
    const starting = this.launcher.isStarting
    const summary = (w: WorkflowInfo): ComfyWorkflowSummary => ({ id: w.id, name: w.name, kind: w.kind, format: w.format, runnable: w.runnable, why: w.why, missing: w.missing.map((m) => m.name) })
    const needs = this.needs(selected)
    const counts: Record<string, number> = {}
    if (this.inventory) for (const category of Object.keys(CATEGORY_LABEL) as ModelCategory[]) counts[category] = this.inventory.byCategory[category].length
    const modelSummary = this.inventory
      ? this.inventory.total === 0
        ? 'No model files found yet.'
        : `${this.inventory.total} model file${this.inventory.total === 1 ? '' : 's'}: ${(Object.keys(CATEGORY_LABEL) as ModelCategory[])
            .filter((c) => counts[c]! > 0)
            .slice(0, 5)
            .map((c) => `${counts[c]} ${CATEGORY_LABEL[c]}`)
            .join(', ')}${this.inventory.families.length ? `. Looks like ${this.inventory.families.slice(0, 4).join(', ')}.` : ''}`
      : null
    let state: ComfyStatus['state']
    let headline: string
    let detail: string | null = null
    if (!this.install && !running) {
      state = this.problem ? 'problem' : 'not-set-up'
      headline = this.problem ? 'This folder is not ComfyUI' : 'ComfyUI is not set up yet'
      detail = this.problem ?? 'Choose your ComfyUI folder once. After that Atlas starts and uses ComfyUI by itself.'
    } else if (starting) {
      state = 'starting'
      headline = 'Starting ComfyUI…'
      detail = this.launcher.logTail(1)[0] ?? 'This can take a minute the first time.'
    } else if (running) {
      state = 'running'
      headline = running.managed ? 'ComfyUI is running (started by Atlas)' : 'Connected to ComfyUI that is already running'
      detail = running.managed ? 'Atlas will close it when Atlas closes.' : 'Atlas does not start another copy and will leave it running.'
    } else if (this.launcher.failure) {
      state = 'problem'
      headline = 'ComfyUI could not start'
      detail = this.launcher.failure
    } else if (this.install?.launchProblem) {
      state = 'problem'
      headline = 'Atlas cannot start this ComfyUI'
      detail = this.install.launchProblem
    } else {
      state = 'stopped'
      headline = settingsAuto(settings) ? 'ComfyUI is ready to start when needed' : 'ComfyUI is not running'
      detail = settingsAuto(settings) ? 'Atlas starts it by itself when you make a picture.' : 'Start it here, or turn on automatic start.'
    }
    return {
      state,
      headline,
      detail,
      url: running?.url ?? null,
      startedByAtlas: Boolean(running?.managed),
      install: this.install ? { folder: this.install.folder, kind: this.install.kind, name: this.install.name, version: this.install.version } : null,
      models: this.inventory ? { total: this.inventory.total, summary: modelSummary ?? '', counts, families: this.inventory.families } : null,
      workflows: this.workflows.filter((w) => w.kind !== 'video' && w.kind !== 'audio').map(summary),
      hiddenWorkflows: this.workflows.filter((w) => w.kind === 'video' || w.kind === 'audio').length,
      needs,
      canMakePictures: this.install ? needs.length === 0 : Boolean(running),
      log: this.launcher.logTail(8),
      launch: this.install ? this.launchView(settings) : null,
      workflowFolders: this.extraWorkflowFolders,
      suggestedWorkflowFolders: this.install ? this.install.workflowFolderSuggestions.filter((f) => !this.extraWorkflowFolders.some((e) => e.toLowerCase() === f.toLowerCase())) : [],
      suggestions: this.install ? [] : this.suggestions().map((s) => ({ folder: s.folder, kind: s.kind, name: s.name }))
    }
  }
}

function settingsAuto(settings: ManagerSettings): boolean {
  return settings.autoStart
}
