import type { AiJob } from '../../shared/ai'
import type { ModelInventory } from '../studio/comfyModels'
import type { AiPackages } from '../studio/aiPackages'
import { freeSpace } from '../studio/aiPackages'
import { BUILT_IN } from './catalog/index'
import { filesFor, loadCatalog, requirementsFor, totalBytes, type LoadedCatalog } from './catalog'
import { assess } from './fit'
import { detectProfile, SIMULATED, simulatedProfile } from './hardware'
import { OllamaClient } from './ollama'
import type { CatalogEntry, CatalogFile, EntryFileState, EntryStateKind, EntryView, Fit, HardwareProfile, InstallPlan, InstallWay, LibraryOverview } from '../../shared/modelLibrary'

// The AI Model Library: reads the catalogue, the computer and what is installed, and offers install, remove and verify through
// the installer Atlas already has (verified downloads, resume, cancel, progress). It adds nothing that runs by itself:
//  * nothing is downloaded without the user's yes, with sizes, licences and free space shown first;
//  * Atlas writes only into the ComfyUI it manages itself; a ComfyUI of the user's (here or on the network) is only read, and the
//    official steps are shown instead, with that computer's folders filled in;
//  * no third-party installation script is ever run.

export interface ComfyView {
  inventory: ModelInventory | null
  kind: 'managed' | 'local' | 'remote' | 'none'
  folder: string | null
  /** The folder that holds the models folder (where the user would put files). */
  dataFolder: string | null
  version: string | null
  note: string | null
}

export interface LibraryDeps {
  ai: AiPackages
  /** Where user-added definitions live (the model-library folder of Atlas's data folder). */
  userCatalogDir: string
  hardware?: () => Promise<HardwareProfile>
  comfy: () => ComfyView
  /** Model file names of a running ComfyUI that is not on this computer's disk (asked through its API), or null. */
  remoteNames?: () => Promise<string[] | null>
  ollama: OllamaClient
  /** Whether Atlas's own image-understanding model is installed. */
  atlasModelInstalled?: () => boolean
  broadcast?: (channel: string, payload?: unknown) => void
  freeBytes?: (path: string) => Promise<number | null>
  /** For tests: replaces the built-in catalogue (its files may be served from this computer). */
  builtIn?: unknown[]
  allowLocalHttp?: boolean
}

const FOLDER_CATEGORY: Record<string, Array<keyof ModelInventory['byCategory']>> = {
  checkpoints: ['checkpoints'],
  diffusion_models: ['diffusion'],
  unet: ['diffusion'],
  vae: ['vae'],
  text_encoders: ['textEncoders'],
  clip: ['textEncoders'],
  loras: ['loras'],
  controlnet: ['controlnet'],
  upscale_models: ['upscale']
}

const gb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`)

export class ModelLibrary {
  private loaded: LoadedCatalog | null = null
  private realProfile: HardwareProfile | null = null
  private pulling: AbortController | null = null
  private pullJob: AiJob | null = null

  constructor(private deps: LibraryDeps) {}

  // ---- the catalogue and the computer ----------------------------------------------------------------------------------------

  catalog(): LoadedCatalog {
    this.loaded ??= loadCatalog(this.deps.builtIn ?? BUILT_IN, this.deps.userCatalogDir, { allowLocalHttp: this.deps.allowLocalHttp })
    return this.loaded
  }
  reload(): LoadedCatalog {
    this.loaded = null
    return this.catalog()
  }
  entry(id: string): CatalogEntry {
    const e = this.catalog().entries.find((x) => x.id === id)
    if (!e) throw new Error('That model is not in the catalogue.')
    return e
  }

  async profile(simulate?: string | null): Promise<HardwareProfile> {
    if (simulate) {
      const sim = simulatedProfile(simulate)
      if (sim) return sim
    }
    this.realProfile ??= await (this.deps.hardware ?? detectProfile)()
    return this.realProfile
  }
  /** Reads the computer again (after a driver update, for example). */
  async refreshProfile(): Promise<HardwareProfile> {
    this.realProfile = null
    return this.profile()
  }

  // ---- what is installed ----------------------------------------------------------------------------------------------------------

  private async externalNames(): Promise<Set<string>> {
    const view = this.deps.comfy()
    const names = new Set<string>()
    for (const list of Object.values(view.inventory?.byCategory ?? {})) for (const n of list) names.add(n.toLowerCase().replace(/\\/g, '/').split('/').pop()!)
    if (names.size === 0 && this.deps.remoteNames) for (const n of (await this.deps.remoteNames()) ?? []) names.add(n.toLowerCase().split(/[\\/]/).pop()!)
    return names
  }

  private fileStates(files: CatalogFile[], external: Set<string>): EntryFileState[] {
    return files.map((f): EntryFileState => {
      if (this.deps.ai.isFileInstalled(f)) return { key: f.key, name: f.name, folder: f.folder, bytes: f.bytes, status: 'installed', partialBytes: 0 }
      const partial = this.deps.ai.partialBytesOfFile(f)
      if (partial > 0) return { key: f.key, name: f.name, folder: f.folder, bytes: f.bytes, status: 'partial', partialBytes: partial }
      if (external.has(f.name.toLowerCase())) return { key: f.key, name: f.name, folder: f.folder, bytes: f.bytes, status: 'found', partialBytes: 0 }
      return { key: f.key, name: f.name, folder: f.folder, bytes: f.bytes, status: 'missing', partialBytes: 0 }
    })
  }

  private async stateOf(entry: CatalogEntry, fit: Fit, external: Set<string>, ollama: string[] | null): Promise<EntryView['state']> {
    if (entry.runtime === 'atlas-onnx') {
      const ok = this.deps.atlasModelInstalled?.() ?? false
      return { kind: ok ? 'installed' : 'not-installed', files: [], where: ok ? 'Atlas’s own model folder' : null, note: null }
    }
    if (entry.runtime === 'ollama') {
      if (ollama === null) return { kind: 'unknown', files: [], where: null, note: 'Ollama is not running, so Atlas cannot see which models it has.' }
      const has = ollama.some((t) => t.toLowerCase() === (entry.install.pullName!.includes(':') ? entry.install.pullName! : `${entry.install.pullName}:latest`).toLowerCase())
      return { kind: has ? 'installed' : 'not-installed', files: [], where: has ? 'your Ollama' : null, note: null }
    }
    // A model with several builds counts as installed when any build is; otherwise the build that suits this computer is described.
    const candidates = entry.variants?.length ? entry.variants.map((v) => ({ id: v.id, files: v.files })) : [{ id: null as string | null, files: entry.files }]
    const scored = candidates.map((c) => ({ id: c.id, states: this.fileStates(c.files, external) }))
    const pick = scored.find((s) => s.states.length > 0 && s.states.every((f) => f.status === 'installed' || f.status === 'found')) ?? scored.find((s) => s.id === fit.variant) ?? scored[0]
    const states = pick?.states ?? []
    if (states.length === 0) return { kind: 'unknown', files: [], where: null, note: null }
    const all = states.every((f) => f.status === 'installed' || f.status === 'found')
    const some = states.some((f) => f.status !== 'missing')
    const byAtlas = states.some((f) => f.status === 'installed')
    const kind: EntryStateKind = all ? (byAtlas ? 'installed' : 'found-in-comfyui') : some ? 'partial' : 'not-installed'
    const view = this.deps.comfy()
    return { kind, files: states, where: all ? (byAtlas ? 'Atlas’s own models folder' : view.folder ? `your ComfyUI (${view.folder})` : 'a connected ComfyUI') : null, note: null }
  }

  // ---- the way it can be installed ----------------------------------------------------------------------------------------------------

  private wayFor(entry: CatalogEntry, profile: HardwareProfile, ollamaUp: boolean): { way: InstallWay; note: string | null } {
    if (entry.install.mode === 'atlas') return { way: 'atlas-model', note: null }
    if (entry.install.mode === 'ollama') return ollamaUp ? { way: 'ollama', note: 'Atlas asks your own Ollama to download it, after you agree.' } : { way: 'manual', note: 'Ollama is not running. Install Ollama from ollama.com and start it, then Atlas can download this for you.' }
    if (entry.install.mode === 'manual') return { way: 'manual', note: entry.install.manualReason ?? null }
    // managed
    const view = this.deps.comfy()
    if (profile.runtime.managedComfy === 'unsupported' && !this.deps.ai.isManaged) return { way: 'manual', note: profile.runtime.managedComfyReason }
    if (this.deps.ai.isManaged) return { way: 'atlas', note: null }
    if (this.deps.ai.mode === 'connect' || view.kind === 'local' || view.kind === 'remote') {
      return { way: 'manual', note: 'Atlas is connected to a ComfyUI that is yours, and Atlas never writes into it. The official steps below put the files in its folders; then press “Check my ComfyUI”.' }
    }
    return { way: 'unavailable', note: 'Set up AI first: Atlas can install its own ComfyUI from the Studio settings, or you can connect one you already have.' }
  }

  // ---- plans ------------------------------------------------------------------------------------------------------------------------------

  /** Every entry that must be installed with this one, dependencies first. */
  private expand(entry: CatalogEntry, seen = new Set<string>()): CatalogEntry[] {
    if (seen.has(entry.id)) return []
    seen.add(entry.id)
    const out: CatalogEntry[] = []
    for (const dep of entry.dependsOn) {
      const d = this.catalog().entries.find((e) => e.id === dep)
      if (d) out.push(...this.expand(d, seen))
    }
    out.push(entry)
    return out
  }

  private async makePlan(entry: CatalogEntry, variantId: string | null, profile: HardwareProfile, external: Set<string>): Promise<InstallPlan> {
    const entries = this.expand(entry)
    const files: InstallPlan['files'] = []
    const seenKeys = new Set<string>()
    const licences: InstallPlan['licences'] = []
    const warnings: string[] = []
    for (const e of entries) {
      const fit = assess(e, profile)
      const v = e.id === entry.id ? variantId ?? fit.variant : fit.variant
      for (const f of filesFor(e, v)) {
        if (seenKeys.has(f.key)) continue
        seenKeys.add(f.key)
        const installed = this.deps.ai.isFileInstalled(f)
        files.push({ key: f.key, name: f.name, folder: f.folder, bytes: f.bytes, url: f.url, entryId: e.id, needed: !installed })
        if (!installed && external.has(f.name.toLowerCase())) warnings.push(`${f.name} was found in your own ComfyUI; Atlas’s own copy would be a separate download.`)
      }
      licences.push({ entryId: e.id, name: e.licence.name, url: e.licence.url, commercialUse: e.licence.commercialUse, acceptance: e.licence.acceptance })
      if (e.licence.commercialUse === 'no') warnings.push(`${e.name}: the licence (${e.licence.name}) does not allow commercial use.`)
      else if (e.licence.commercialUse === 'conditions') warnings.push(`${e.name}: the licence (${e.licence.name}) has conditions on use. Read it before you agree.`)
      const f2 = assess(e, profile)
      if (f2.level === 'slow') warnings.push(`${e.name}: ${f2.reasons[0] ?? 'it will run slowly on this computer.'}`)
    }
    const todo = files.filter((f) => f.needed)
    const root = this.deps.ai.managedRoot
    return {
      entries: entries.map((e) => ({ id: e.id, name: e.name })),
      files,
      downloadBytes: todo.reduce((s, f) => s + f.bytes, 0),
      diskBytes: files.reduce((s, f) => s + f.bytes, 0),
      freeBytes: root ? await (this.deps.freeBytes ?? freeSpace)(root) : null,
      destination: this.deps.ai.modelsFolder,
      licences,
      warnings
    }
  }

  private instructionsFor(entry: CatalogEntry, variantId: string | null, profile: HardwareProfile): string[] {
    const view = this.deps.comfy()
    const out: string[] = []
    const models = view.dataFolder ? `${view.dataFolder}\\models` : 'ComfyUI\\models'
    if (profile.runtime.managedComfy === 'unsupported' && profile.arch === 'arm64') {
      out.push('This is a Windows-on-Arm computer. Atlas cannot install ComfyUI here (see the hardware panel). Set ComfyUI up with its official instructions for Windows on Arm (https://github.com/comfyanonymous/ComfyUI), or run it on another computer and connect to it from the Studio settings.')
    }
    if (entry.install.mode === 'managed') {
      const files = filesFor(entry, variantId)
      for (const f of files) out.push(`Download ${f.name} (${gb(f.bytes)}) from ${f.url} and put it in ${models}\\${f.folder}. Its SHA-256 checksum should be ${f.sha256}.`)
      for (const dep of entry.dependsOn) out.push(`First install “${this.catalog().entries.find((e) => e.id === dep)?.name ?? dep}”.`)
      out.push('Restart ComfyUI, then press “Check my ComfyUI” in Atlas’s Model Library. Atlas lists the model as found when it sees the files.')
    }
    for (const line of entry.install.instructions ?? []) out.push(line)
    return out
  }

  // ---- the overview ---------------------------------------------------------------------------------------------------------------------------

  async overview(simulate?: string | null): Promise<LibraryOverview> {
    const profile = await this.profile(simulate)
    const cat = this.catalog()
    const external = await this.externalNames()
    const tags = await this.deps.ollama.tags()
    const view = this.deps.comfy()
    const root = this.deps.ai.managedRoot
    const entries: EntryView[] = []
    for (const entry of cat.entries) {
      const fit = assess(entry, profile)
      const state = await this.stateOf(entry, fit, external, tags)
      const { way, note } = this.wayFor(entry, profile, tags !== null)
      const plan = way === 'atlas' || (entry.install.mode === 'managed' && way === 'manual') ? await this.makePlan(entry, fit.variant, profile, external) : null
      const installedIds = new Set<string>()
      void installedIds
      const missing = entry.dependsOn.filter((d) => {
        const dep = cat.entries.find((e) => e.id === d)
        if (!dep) return true
        const depStates = this.fileStates(filesFor(dep, assess(dep, profile).variant), external)
        return depStates.length > 0 && !depStates.every((f) => f.status === 'installed' || f.status === 'found')
      })
      entries.push({ entry, fit, state, way, wayNote: note, plan, instructions: way === 'manual' || way === 'atlas-model' || entry.install.mode === 'manual' ? this.instructionsFor(entry, fit.variant, profile) : [], missingDependencies: missing })
    }
    return {
      hardware: profile,
      simulations: Object.entries(SIMULATED).map(([id, v]) => ({ id, label: v.label })),
      mode: this.deps.ai.mode,
      root,
      freeBytes: root ? await (this.deps.freeBytes ?? freeSpace)(root) : null,
      comfy: { connected: view.kind !== 'none', kind: view.kind, folder: view.folder, version: view.version, note: view.note },
      ollama: { running: tags !== null, models: tags ?? [] },
      entries,
      problems: cat.problems,
      userFolder: this.deps.userCatalogDir,
      userEntries: cat.userIds
    }
  }

  // ---- doing things ------------------------------------------------------------------------------------------------------------------------------

  /** What installing this would do, without doing anything. */
  async plan(id: string, variant?: string | null, simulate?: string | null): Promise<InstallPlan> {
    const entry = this.entry(id)
    const profile = await this.profile(simulate)
    return this.makePlan(entry, variant ?? assess(entry, profile).variant, profile, await this.externalNames())
  }

  /** Installs a model (and what it needs) into Atlas's own ComfyUI, or into Ollama. Needs the user's yes. */
  async install(id: string, options: { variant?: string | null; consent: boolean }): Promise<LibraryOverview> {
    if (!options.consent) throw new Error('Please confirm that you agree to the downloads and the licences first.')
    const entry = this.entry(id)
    const profile = await this.profile()
    const tags = await this.deps.ollama.tags()
    const { way, note } = this.wayFor(entry, profile, tags !== null)
    if (way === 'ollama') {
      await this.pull(entry.install.pullName!)
      return this.overview()
    }
    if (way !== 'atlas') throw new Error(note ?? 'Atlas cannot install this one itself. Follow the steps shown for it.')
    const variant = options.variant ?? assess(entry, profile).variant
    const plan = await this.makePlan(entry, variant, profile, await this.externalNames())
    const todo = plan.files.filter((f) => f.needed)
    await this.deps.ai.installFiles(todo.map((f) => ({ key: f.key, name: f.name, folder: f.folder, url: f.url, bytes: f.bytes, sha256: this.sha(f.entryId, f.key) })), true)
    return this.overview()
  }

  private sha(entryId: string, key: string): string {
    const e = this.entry(entryId)
    const all = [...e.files, ...(e.variants ?? []).flatMap((v) => v.files)]
    return all.find((f) => f.key === key)!.sha256
  }

  private async pull(name: string): Promise<void> {
    if (this.pulling) throw new Error('Something is already being downloaded.')
    this.pulling = new AbortController()
    const signal = this.pulling.signal
    const emit = (patch: Partial<AiJob> & Pick<AiJob, 'stage' | 'message'>): void => {
      this.pullJob = { kind: 'packages', item: name, doneBytes: 0, totalBytes: null, fraction: null, step: 1, steps: 1, speed: null, ...patch }
      this.deps.broadcast?.('studio:ai-progress', this.pullJob)
    }
    try {
      emit({ stage: 'downloading', message: `Asking Ollama to download ${name}…` })
      let last = Date.now()
      let lastBytes = 0
      let speed: number | null = null
      await this.deps.ollama.pull(name, (done, total, status) => {
        const now = Date.now()
        if (now - last > 1500 && done > lastBytes) {
          speed = Math.round(((done - lastBytes) / (now - last)) * 1000)
          last = now
          lastBytes = done
        }
        emit({ stage: /verif|writing/i.test(status) ? 'verifying' : 'downloading', message: status ? `Ollama: ${status}` : `Downloading ${name}…`, doneBytes: done, totalBytes: total, fraction: total ? done / total : null, speed })
      }, signal)
      emit({ stage: 'done', message: `${name} is installed in Ollama.`, fraction: 1 })
    } catch (error) {
      emit({ stage: signal.aborted ? 'stopped' : 'failed', message: signal.aborted ? 'Stopped. Starting it again continues where it left off.' : error instanceof Error ? error.message : 'The download failed.' })
      if (!signal.aborted) throw error
    } finally {
      this.pulling = null
    }
  }

  stop(): void {
    this.deps.ai.stop()
    this.pulling?.abort()
  }

  /** Deletes the files Atlas installed for a model, except what another installed model still needs. */
  async remove(id: string): Promise<{ removed: string[]; kept: string[]; overview: LibraryOverview }> {
    const entry = this.entry(id)
    if (entry.runtime !== 'comfyui') throw new Error(entry.runtime === 'ollama' ? `Remove it with Ollama itself (ollama rm ${entry.install.pullName}). Atlas does not delete models inside Ollama.` : 'This model is part of Atlas itself and is not removed here.')
    const profile = await this.profile()
    const external = await this.externalNames()
    const cat = this.catalog()
    // Another installed model that depends on this one blocks the removal.
    for (const other of cat.entries) {
      if (other.id === id || !other.dependsOn.includes(id)) continue
      const otherStates = this.fileStates(filesFor(other, assess(other, profile).variant), external)
      if (otherStates.length > 0 && otherStates.every((f) => f.status === 'installed')) throw new Error(`“${other.name}” needs this model. Remove it first.`)
    }
    const mine = [...entry.files, ...(entry.variants ?? []).flatMap((v) => v.files)].filter((f) => this.deps.ai.isFileInstalled(f))
    // Files that another installed model also uses stay.
    const usedElsewhere = new Set<string>()
    for (const other of cat.entries) {
      if (other.id === id) continue
      const theirs = filesFor(other, assess(other, profile).variant)
      // Only a model that is itself installed holds on to a shared file; a half-removed one does not.
      if (theirs.length === 0 || !theirs.every((f) => this.deps.ai.isFileInstalled(f))) continue
      for (const f of theirs) usedElsewhere.add(f.key)
    }
    const legacy = new Set(this.deps.ai.installedKeys())
    void legacy
    const toRemove = mine.filter((f) => !usedElsewhere.has(f.key))
    const kept = mine.filter((f) => usedElsewhere.has(f.key)).map((f) => f.name)
    const result = await this.deps.ai.removeFiles(toRemove)
    return { removed: result.removed, kept: [...kept, ...result.skipped], overview: await this.overview() }
  }

  /** Checks the files Atlas installed for a model: present and the right size, and with `deep` the checksum too. */
  async verify(id: string, deep: boolean): Promise<string[]> {
    const entry = this.entry(id)
    const files = [...entry.files, ...(entry.variants ?? []).flatMap((v) => v.files)]
    return this.deps.ai.verifyInstalled(files, deep)
  }

  /** Total size of what a model needs, for display. */
  sizeOf(entry: CatalogEntry, variant?: string | null): number {
    return totalBytes(filesFor(entry, variant)) || entry.install.approxBytes || 0
  }
  requirements(entry: CatalogEntry, variant?: string | null): ReturnType<typeof requirementsFor> {
    return requirementsFor(entry, variant)
  }
}
