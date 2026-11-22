import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { basename, dirname, join, parse, resolve, sep } from 'node:path'
import type { AiJob, AiMode, AiPackageInfo, AiStatus, CapabilityId, HardwareInfo, LicenseNote, PackageFileInfo, RuntimeInfo } from '../../shared/ai'
import { DownloadError, download, partPath, sha256Of, type FetchFn } from './downloader'

// Atlas's own, separate ComfyUI: where it lives, what it is made of, and how optional capability packages are added to it.
// Nothing here touches any other ComfyUI installation: Atlas writes only inside the folder the user chose for it.

export const RUNTIME_REPO = 'comfyanonymous/ComfyUI'

interface RuntimeAsset {
  variant: 'nvidia' | 'amd' | 'intel'
  name: string
  /** Pinned from the release the code was written against, used when GitHub cannot be asked. */
  fallback: { tag: string; sha256: string; bytes: number }
}
const RUNTIME_ASSETS: Record<'nvidia' | 'amd' | 'intel', RuntimeAsset> = {
  nvidia: { variant: 'nvidia', name: 'ComfyUI_windows_portable_nvidia.7z', fallback: { tag: 'v0.46.0', sha256: '6a5255c7ec01fdc54bdbd8e4507073cf6acda2fbeea74ae1829a50681af5fac6', bytes: 1_989_000_000 } },
  amd: { variant: 'amd', name: 'ComfyUI_windows_portable_amd.7z', fallback: { tag: 'v0.46.0', sha256: '00f42ed58381e194892b74e9085d4d5666fac1aab8f021094c3a745e9b52ad97', bytes: 1_624_000_000 } },
  intel: { variant: 'intel', name: 'ComfyUI_windows_portable_intel.7z', fallback: { tag: 'v0.46.0', sha256: 'db902d46c7ccf9627e4e0b7a45d52a2fc2b0b4d5dccb7052acfbc3d6124dc4d8', bytes: 1_447_000_000 } }
}
/** What the unpacked portable ComfyUI takes on disk, roughly (the archive is compressed). */
const RUNTIME_DISK_FACTOR = 3.2

const OPENRAIL: LicenseNote = {
  name: 'CreativeML Open RAIL-M',
  url: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
  summary: 'Free to use, including commercially, but you agree not to use it to harm people or to break the law. The full list of restrictions is in the licence.'
}
const BSD3: LicenseNote = { name: 'BSD 3-Clause', url: 'https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE', summary: 'Free to use and share, including commercially, with the copyright notice kept.' }
const GPL3: LicenseNote = { name: 'GPL 3.0 (ComfyUI)', url: 'https://github.com/comfyanonymous/ComfyUI/blob/master/LICENSE', summary: 'ComfyUI is free software. Atlas runs it as a separate program and does not change it.' }

export interface PackFile {
  key: string
  name: string
  folder: string
  url: string
  bytes: number
  sha256: string
}
const FILES: Record<string, PackFile> = {
  sd15: { key: 'sd15', name: 'v1-5-pruned-emaonly-fp16.safetensors', folder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors', bytes: 2_132_696_762, sha256: 'e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916' },
  tile: { key: 'tile', name: 'control_v11f1e_sd15_tile_fp16.safetensors', folder: 'controlnet', url: 'https://huggingface.co/comfyanonymous/ControlNet-v1-1_fp16_safetensors/resolve/main/control_v11f1e_sd15_tile_fp16.safetensors', bytes: 722_601_104, sha256: '2f31868eedb243a77932e3c63907a6ba0a2058b6d65b5c27b89ee1b7f618ea33' },
  esrgan: { key: 'esrgan', name: 'RealESRGAN_x4plus.pth', folder: 'upscale_models', url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth', bytes: 67_040_989, sha256: '4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1' }
}

interface PackDef {
  id: CapabilityId
  name: string
  summary: string
  details: string
  files: string[]
  vramGB: number
  licenses: LicenseNote[]
  needs: CapabilityId[]
}
export const PACKAGES: PackDef[] = [
  {
    id: 'create',
    name: 'Create pictures',
    summary: 'Make new artwork from a prompt and your moodboards, on this computer, free.',
    details: 'Installs Stable Diffusion 1.5, a general-purpose image model that runs well on 6 GB of graphics memory. It makes pictures of about 512 to 768 pixels on a side, which the upscaling package can then enlarge. It paints in a broad, painterly range of styles, not photographic perfection.',
    files: ['sd15'],
    vramGB: 6,
    licenses: [OPENRAIL],
    needs: []
  },
  {
    id: 'edit',
    name: 'Edit pictures',
    summary: 'Change the atmosphere, light or style of a picture while keeping its composition.',
    details: 'Adds a ControlNet “tile” model that holds on to the structure of your picture while the image model repaints it from your description. The strength slider decides how much changes. Needs the Create package.',
    files: ['tile'],
    vramGB: 6,
    licenses: [OPENRAIL],
    needs: ['create']
  },
  {
    id: 'upscale',
    name: 'Creative upscaling',
    summary: 'Enlarge pictures and add believable detail, not just more pixels.',
    details: 'Adds Real-ESRGAN for the enlargement and uses the same ControlNet and image model for a gentle detail pass. Large results are made in tiles to fit in 8 GB of graphics memory. If you already have Clarity presets in your own ComfyUI, connect that instead: Atlas runs them exactly as tuned. Needs the Create and Edit packages.',
    files: ['esrgan', 'tile'],
    vramGB: 8,
    licenses: [BSD3, OPENRAIL],
    needs: ['create', 'edit']
  }
]

export interface AiDeps {
  /** Atlas's own data folder; settings live under it. */
  dataDir: string
  fetchImpl?: FetchFn
  broadcast?: (channel: string, payload?: unknown) => void
  /** Asks the Studio to use this ComfyUI (called when the runtime is ready). */
  useRuntime(folder: string, args: string[], port: number): void
  /** Starts the runtime, checks that it answers and stops it again. Returns a problem in plain words, or null. */
  verifyRuntime?(): Promise<string | null>
  /** Called after models were added, so the Studio rereads the installation. */
  modelsChanged?(): void
  /** Overridable for tests. */
  hardware?: () => Promise<HardwareInfo>
  extract?: (archive: string, dest: string, onFiles: (count: number) => void, signal: AbortSignal) => Promise<void>
  freeBytes?: (path: string) => Promise<number | null>
  latestRelease?: (variant: 'nvidia' | 'amd' | 'intel') => Promise<{ tag: string; url: string; sha256: string | null; bytes: number | null } | null>
  /** Replaces a catalogue entry (tests use small stand-in files). */
  fileFor?: (file: PackFile) => PackFile
  port?: number
}

interface Stored {
  mode: AiMode
  root: string | null
  runtime: { tag: string; folder: string; variant: 'nvidia' | 'amd' | 'intel' } | null
  /** Files Atlas installed into its own models folder: key -> proof. */
  installed: Record<string, { name: string; folder: string; bytes: number; sha256: string; at: number; owned?: boolean }>
  /** Folders of runtimes that were replaced by an update, kept until the user removes them. */
  previous: string[]
}

const DEFAULTS: Stored = { mode: 'none', root: null, runtime: null, installed: {}, previous: [] }
const MANAGED_PORT = 8191

const run = (file: string, args: string[], timeout = 8000): Promise<string> =>
  new Promise((resolveRun) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => resolveRun(error ? '' : String(stdout)))
  })

/** The graphics card, in plain terms. Reads only; nothing is installed or changed. */
export async function detectHardware(): Promise<HardwareInfo> {
  if (process.platform !== 'win32') return { gpu: null, platform: process.platform, supported: false, note: 'Atlas installs its own ComfyUI on Windows only. On this system, connect an existing ComfyUI or use a cloud service.' }
  const smi = (await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])).trim().split(/\r?\n/)[0] ?? ''
  if (smi) {
    const [name, mem, driver] = smi.split(',').map((s) => s.trim())
    const vram = Number(mem)
    const vramGB = Number.isFinite(vram) ? Math.round((vram / 1024) * 10) / 10 : null
    return {
      gpu: { name: name ?? 'NVIDIA graphics card', vendor: 'nvidia', vramGB, driver: driver ?? null },
      platform: 'win32',
      supported: true,
      note: vramGB !== null && vramGB < 6 ? `This card has ${vramGB} GB of graphics memory. Pictures will work but slowly, and the upscaling package may run out of memory on larger sizes.` : null
    }
  }
  const names = (await run('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "|"'])).trim().split('|').filter(Boolean)
  const amd = names.find((n) => /amd|radeon/i.test(n))
  const intel = names.find((n) => /intel/i.test(n))
  if (amd) return { gpu: { name: amd, vendor: 'amd', vramGB: null, driver: null }, platform: 'win32', supported: true, note: 'AMD cards work with Atlas’s ComfyUI, but support is newer and slower than NVIDIA.' }
  if (intel) return { gpu: { name: intel, vendor: 'intel', vramGB: null, driver: null }, platform: 'win32', supported: true, note: 'Intel graphics works but is slow. A dedicated graphics card is recommended for making pictures.' }
  return { gpu: null, platform: 'win32', supported: false, note: 'Atlas did not find a graphics card it can use. You can still use cloud image services, or connect a ComfyUI that runs elsewhere.' }
}

/** Free space on the drive that holds `path`. */
export async function freeSpace(path: string): Promise<number | null> {
  try {
    let probe = resolve(path)
    while (!existsSync(probe) && parse(probe).root !== probe) probe = resolve(probe, '..')
    const s = await statfs(probe)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return null
  }
}

/** Unpacks a 7z archive with the tar that ships with Windows 10 and 11, reporting how many files have appeared. */
export function extractWithTar(archive: string, dest: string, onFiles: (count: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolveRun, reject) => {
    mkdirSync(dest, { recursive: true })
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    const child = spawn(tar, ['-xvf', archive, '-C', dest], { windowsHide: true })
    let count = 0
    let tail = ''
    const onData = (chunk: Buffer): void => {
      const text = tail + chunk.toString('utf8')
      const lines = text.split(/\r?\n/)
      tail = lines.pop() ?? ''
      count += lines.length
      onFiles(count)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const stop = (): void => {
      child.kill()
    }
    signal.addEventListener('abort', stop, { once: true })
    child.on('error', (error) => reject(new Error(`Windows could not unpack the download (${error.message}).`)))
    child.on('close', (code) => {
      signal.removeEventListener('abort', stop)
      if (signal.aborted) reject(new DownloadError('Stopped.'))
      else if (code === 0) resolveRun()
      else reject(new Error('Windows could not unpack the download. The file may be damaged; starting the installation again downloads it afresh.'))
    })
  })
}

async function githubLatest(variant: 'nvidia' | 'amd' | 'intel', fetchImpl: FetchFn): Promise<{ tag: string; url: string; sha256: string | null; bytes: number | null } | null> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${RUNTIME_REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
    if (!response.ok) return null
    const body = (await response.json()) as { tag_name?: string; assets?: Array<{ name: string; size: number; digest?: string; browser_download_url: string }> }
    const asset = body.assets?.find((a) => a.name === RUNTIME_ASSETS[variant].name)
    if (!asset || !body.tag_name) return null
    return { tag: body.tag_name, url: asset.browser_download_url, sha256: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null, bytes: asset.size }
  } catch {
    return null
  }
}

export class AiPackages {
  private data: Stored
  private job: AiJob | null = null
  private controller: AbortController | null = null
  private problem: string | null = null
  private cachedHardware: HardwareInfo | null = null
  private updateTag: string | null = null
  private working = false

  constructor(private deps: AiDeps) {
    mkdirSync(join(deps.dataDir, 'studio'), { recursive: true })
    this.data = this.load()
  }

  private get file(): string {
    return join(this.deps.dataDir, 'studio', 'ai.json')
  }
  private fetchFn(): FetchFn {
    return this.deps.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit))
  }
  private load(): Stored {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stored>
        return { ...DEFAULTS, ...raw, installed: raw.installed ?? {}, previous: raw.previous ?? [] }
      }
    } catch {
      // A damaged file is replaced by the defaults; nothing else depends on it.
    }
    return structuredClone(DEFAULTS)
  }
  private save(): void {
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(temp, this.file)
  }

  get mode(): AiMode {
    return this.data.mode
  }
  setMode(mode: AiMode): void {
    this.data.mode = mode
    this.save()
  }
  get managedRoot(): string | null {
    return this.data.root
  }
  get busy(): boolean {
    return this.working
  }

  // ---- paths -----------------------------------------------------------------------------------------------------------

  private modelsDir(root = this.data.root): string {
    return join(root!, 'models')
  }
  private workDir(root = this.data.root): string {
    return join(root!, 'work')
  }
  private fileOf(key: string): PackFile {
    const file = FILES[key]!
    return this.deps.fileFor ? this.deps.fileFor(file) : file
  }
  private isInstalled(key: string): boolean {
    const proof = this.data.installed[key]
    if (!proof || !this.data.root) return false
    const path = join(this.modelsDir(), proof.folder, proof.name)
    try {
      return statSync(path).size === proof.bytes
    } catch {
      return false
    }
  }
  private partialBytes(key: string): number {
    if (!this.data.root) return 0
    const file = this.fileOf(key)
    try {
      return statSync(partPath(join(this.modelsDir(), file.folder, file.name))).size
    } catch {
      return 0
    }
  }

  // ---- catalogue files (the AI Model Library) -----------------------------------------------------------------------------
  //
  // The Model Library describes models as data (sources, sizes, checksums). These methods install and remove such files in the
  // same way, and with the same safety, as the built-in packages: only into Atlas's own models folder, each file checked
  // against its published checksum, interrupted downloads resume, and nothing outside what Atlas installed is ever touched.

  /** Whether a file is installed by Atlas in its own models folder (present and the right size). */
  isFileInstalled(file: { key: string; name: string; folder: string; bytes: number }): boolean {
    if (!this.data.root) return false
    try {
      return statSync(join(this.modelsDir(), file.folder, file.name)).size === file.bytes
    } catch {
      return false
    }
  }
  /** Bytes of an interrupted download of this file, so the remaining size can be shown. */
  partialBytesOfFile(file: { name: string; folder: string }): number {
    if (!this.data.root) return 0
    try {
      return statSync(partPath(join(this.modelsDir(), file.folder, file.name))).size
    } catch {
      return 0
    }
  }
  /** Keys of the files this Atlas installed (built-in packages and the library). */
  installedKeys(): string[] {
    return Object.keys(this.data.installed).filter((k) => this.isInstalled(k))
  }
  get modelsFolder(): string | null {
    return this.data.root ? this.modelsDir() : null
  }
  get isManaged(): boolean {
    return this.data.mode === 'managed' && Boolean(this.data.root) && Boolean(this.data.runtime)
  }

  /**
   * Downloads and verifies catalogue files into Atlas's managed ComfyUI. The caller has shown the sizes and licences and got
   * the user's yes (`consent`). Stops cleanly on request; starting again continues where it left off.
   */
  async installFiles(files: PackFile[], consent: boolean): Promise<AiStatus> {
    if (!consent) throw new Error('Please confirm that you agree to the downloads and the licences first.')
    if (!this.isManaged) throw new Error('Atlas can add models only to the ComfyUI it manages itself. Install Atlas’s own ComfyUI first. Atlas never writes into another ComfyUI installation.')
    if (this.working) throw new Error('Something is already being installed.')
    const todo = files.filter((f) => !this.isFileInstalled(f))
    const needed = todo.reduce((s, f) => s + f.bytes - this.partialBytesOfFile(f), 0)
    const free = await (this.deps.freeBytes ?? freeSpace)(this.data.root!)
    if (free !== null && free < needed * 1.05) throw new Error(`There is not enough room on that drive: ${(needed / 1e9).toFixed(1)} GB is needed and ${(free / 1e9).toFixed(1)} GB is free.`)
    this.working = true
    this.problem = null
    this.controller = new AbortController()
    const signal = this.controller.signal
    try {
      const total = todo.reduce((s, f) => s + f.bytes, 0)
      let completed = 0
      let lastBytes = 0
      let lastTime = Date.now()
      let speed: number | null = null
      for (const [index, file] of todo.entries()) {
        this.emit({ kind: 'packages', stage: 'downloading', message: `Downloading ${file.name}…`, item: file.name, step: index + 1, steps: todo.length, totalBytes: total, doneBytes: completed })
        const dest = join(this.modelsDir(), file.folder, file.name)
        mkdirSync(join(this.modelsDir(), file.folder), { recursive: true })
        const downloaded = await download({
          url: file.url,
          dest,
          sha256: file.sha256,
          size: file.bytes,
          fetchImpl: this.fetchFn(),
          signal,
          onProgress: (done) => {
            const now = Date.now()
            if (now - lastTime > 1500) {
              speed = Math.round(((completed + done - lastBytes) / (now - lastTime)) * 1000)
              lastBytes = completed + done
              lastTime = now
            }
            this.emit({ kind: 'packages', stage: 'downloading', message: `Downloading ${file.name}…`, item: file.name, step: index + 1, steps: todo.length, totalBytes: total, doneBytes: completed + done, fraction: total ? (completed + done) / total : null, speed })
          }
        })
        completed += file.bytes
        this.data.installed[file.key] = { name: file.name, folder: file.folder, bytes: file.bytes, sha256: file.sha256, at: Date.now(), owned: !downloaded.reused }
        this.save()
      }
      this.emit({ kind: 'packages', stage: 'done', message: todo.length === 0 ? 'Everything is already installed.' : 'Installed and verified.', step: todo.length, steps: todo.length, fraction: 1, totalBytes: total, doneBytes: total })
      this.deps.modelsChanged?.()
    } catch (error) {
      this.fail('packages', error, signal.aborted)
      if (!signal.aborted) throw error instanceof Error ? error : new Error('The installation failed.')
    } finally {
      this.working = false
      this.controller = null
    }
    return this.status()
  }

  /** Deletes files this Atlas installed. Refuses anything it did not install itself and anything outside its models folder. */
  async removeFiles(files: Array<{ key: string; name: string; folder: string }>): Promise<{ removed: string[]; skipped: string[] }> {
    if (this.working) throw new Error('Wait until the current installation has finished, or stop it first.')
    const removed: string[] = []
    const skipped: string[] = []
    const root = this.data.root ? this.modelsDir() : null
    for (const file of files) {
      const proof = this.data.installed[file.key]
      if (!root || !proof || proof.owned !== true || proof.name !== file.name || proof.folder !== file.folder) {
        skipped.push(file.name)
        continue
      }
      const path = join(root, proof.folder, proof.name)
      if (!existsSync(path) || !realpathSync(path).toLowerCase().startsWith(join(realpathSync(this.data.root!), 'models').toLowerCase() + sep) || await sha256Of(path) !== proof.sha256) {
        skipped.push(file.name)
        continue
      }
      rmSync(path, { force: true })
      delete this.data.installed[file.key]
      removed.push(file.name)
    }
    this.save()
    this.deps.modelsChanged?.()
    return { removed, skipped }
  }

  /** Re-reads the files of installed catalogue entries; with `deep`, recomputes every checksum (slow for large models). */
  async verifyInstalled(files: Array<{ key: string; name: string; folder: string; bytes: number; sha256: string }>, deep: boolean, onFile?: (name: string) => void): Promise<string[]> {
    const problems: string[] = []
    for (const f of files) {
      if (!this.data.installed[f.key]) continue
      onFile?.(f.name)
      if (!this.isFileInstalled(f)) {
        problems.push(`${f.name} is missing or the wrong size.`)
        continue
      }
      if (deep) {
        const { createHash } = await import('node:crypto')
        const { createReadStream } = await import('node:fs')
        const hash = createHash('sha256')
        await new Promise<void>((resolveRun, reject) => {
          const stream = createReadStream(join(this.modelsDir(), f.folder, f.name))
          stream.on('data', (chunk) => hash.update(chunk))
          stream.on('error', reject)
          stream.on('end', () => resolveRun())
        })
        if (hash.digest('hex') !== f.sha256) problems.push(`${f.name} is damaged (its checksum does not match the official one). Install it again to fetch a clean copy.`)
      }
    }
    return problems
  }

  // ---- status ----------------------------------------------------------------------------------------------------------

  private async hardware(): Promise<HardwareInfo> {
    this.cachedHardware ??= await (this.deps.hardware ?? detectHardware)()
    return this.cachedHardware
  }

  private variantFor(hw: HardwareInfo): 'nvidia' | 'amd' | 'intel' {
    return hw.gpu?.vendor === 'amd' ? 'amd' : hw.gpu?.vendor === 'intel' ? 'intel' : 'nvidia'
  }

  packageInfos(): AiPackageInfo[] {
    const needsOf = (id: CapabilityId): CapabilityId[] => PACKAGES.find((p) => p.id === id)!.needs
    return PACKAGES.map((def) => {
      const files: PackageFileInfo[] = def.files.map((key) => ({ name: this.fileOf(key).name, folder: this.fileOf(key).folder, bytes: this.fileOf(key).bytes, installed: this.isInstalled(key), partial: this.isInstalled(key) ? 0 : this.partialBytes(key) }))
      const missing = files.filter((f) => !f.installed)
      return {
        id: def.id,
        name: def.name,
        summary: def.summary,
        details: def.details,
        files,
        downloadBytes: missing.reduce((s, f) => s + f.bytes - f.partial, 0),
        diskBytes: files.reduce((s, f) => s + f.bytes, 0),
        vramGB: def.vramGB,
        licenses: def.licenses,
        state: missing.length === 0 ? 'installed' : missing.length < files.length || files.some((f) => f.partial > 0) ? 'partial' : 'not-installed',
        needs: needsOf(def.id)
      }
    })
  }

  async status(): Promise<AiStatus> {
    const hw = await this.hardware()
    const variant = this.variantFor(hw)
    const asset = RUNTIME_ASSETS[variant]
    const runtimeFolder = this.data.runtime && existsSync(this.data.runtime.folder) ? this.data.runtime.folder : null
    const root = this.data.root
    const suggested = this.suggestedRoot(await this.driveCandidates())
    const runtime: RuntimeInfo = {
      state: this.job && this.job.kind === 'runtime' && !['done', 'failed', 'stopped'].includes(this.job.stage) ? 'installing' : this.data.runtime ? (runtimeFolder ? 'ready' : 'broken') : 'not-installed',
      version: this.data.runtime?.tag ?? null,
      folder: runtimeFolder,
      downloadBytes: asset.fallback.bytes,
      diskBytes: Math.round(asset.fallback.bytes * RUNTIME_DISK_FACTOR),
      updateTo: this.updateTag && this.data.runtime && this.updateTag !== this.data.runtime.tag ? this.updateTag : null,
      variant
    }
    return {
      mode: this.data.mode,
      hardware: hw,
      root,
      freeBytes: root ? await (this.deps.freeBytes ?? freeSpace)(root) : null,
      suggestedRoot: suggested,
      runtime,
      packages: this.packageInfos(),
      job: this.job,
      problem: this.problem
    }
  }

  /** The drive with the most free space that is not the system drive, then the system drive. */
  private async driveCandidates(): Promise<Array<{ path: string; free: number; system: boolean }>> {
    if (process.platform !== 'win32') return []
    const out: Array<{ path: string; free: number; system: boolean }> = []
    const system = (process.env.SystemDrive ?? 'C:').toUpperCase()
    for (let code = 67; code <= 90; code += 1) {
      const letter = String.fromCharCode(code)
      const path = `${letter}:\\`
      if (!existsSync(path)) continue
      const free = await (this.deps.freeBytes ?? freeSpace)(path)
      if (free !== null) out.push({ path, free, system: `${letter}:` === system })
    }
    return out
  }
  private suggestedRoot(drives: Array<{ path: string; free: number; system: boolean }>): string | null {
    const best = [...drives].sort((a, b) => Number(a.system) - Number(b.system) || b.free - a.free)[0]
    return best ? join(best.path, 'NOEMA Atlas AI') : null
  }

  // ---- progress --------------------------------------------------------------------------------------------------------

  private emit(patch: Partial<AiJob> & Pick<AiJob, 'kind' | 'stage' | 'message'>): void {
    this.job = { item: null, doneBytes: 0, totalBytes: null, fraction: null, step: 0, steps: 0, speed: null, ...(this.job && this.job.kind === patch.kind && !['done', 'failed', 'stopped'].includes(this.job.stage) ? { step: this.job.step, steps: this.job.steps } : {}), ...patch }
    this.deps.broadcast?.('studio:ai-progress', this.job)
  }

  stop(): void {
    this.controller?.abort()
  }

  // ---- the runtime -----------------------------------------------------------------------------------------------------

  private check(root: string, needBytes: number): string | null {
    const normal = resolve(root)
    if (!normal || parse(normal).root === normal) return 'Choose a folder, not a whole drive. Atlas will keep everything inside it.'
    if (existsSync(normal) && readdirSync(normal).length > 0 && !existsSync(join(normal, 'atlas-ai.json')) && this.data.root !== normal) {
      return 'That folder is not empty and was not made by Atlas. Choose an empty folder or a new one so nothing of yours is touched.'
    }
    void needBytes
    return null
  }

  /**
   * Installs Atlas's own ComfyUI into `root`. It downloads the official portable build (checked against its published
   * checksum), unpacks it beside a shared models folder, and points Atlas at it. Stopped or interrupted downloads resume.
   */
  async installRuntime(rootInput: string, consent: boolean): Promise<AiStatus> {
    if (!consent) throw new Error('Please confirm that you agree to the download and the licences first.')
    if (this.working) throw new Error('Something is already being installed.')
    const root = resolve(rootInput)
    const hw = await this.hardware()
    if (!hw.supported) throw new Error(hw.note ?? 'Atlas cannot install its own ComfyUI on this computer.')
    const variant = this.variantFor(hw)
    const asset = RUNTIME_ASSETS[variant]
    const problem = this.check(root, 0)
    if (problem) throw new Error(problem)
    const release = (await (this.deps.latestRelease ?? ((v) => githubLatest(v, this.fetchFn())))(variant)) ?? { tag: asset.fallback.tag, url: `https://github.com/${RUNTIME_REPO}/releases/download/${asset.fallback.tag}/${asset.name}`, sha256: asset.fallback.sha256, bytes: null }
    const free = await (this.deps.freeBytes ?? freeSpace)(root)
    const needed = Math.round((release.bytes ?? asset.fallback.bytes) * (1 + RUNTIME_DISK_FACTOR))
    if (free !== null && free < needed) throw new Error(`There is not enough room on that drive: about ${(needed / 1e9).toFixed(1)} GB is needed during the installation and ${(free / 1e9).toFixed(1)} GB is free. Choose another drive.`)

    this.working = true
    this.problem = null
    this.controller = new AbortController()
    const signal = this.controller.signal
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, 'atlas-ai.json'), JSON.stringify({ madeBy: 'NOEMA Atlas', note: 'Atlas keeps its own ComfyUI and models here. Safe to delete only through Atlas.', at: Date.now() }, null, 2))
      for (const d of ['runtime', 'models', 'work', 'downloads']) mkdirSync(join(root, d), { recursive: true })
      this.emit({ kind: 'runtime', stage: 'preparing', message: 'Getting ready…', steps: 3, step: 0 })
      const archive = join(root, 'downloads', asset.name)
      let lastBytes = 0
      let lastTime = Date.now()
      let speed: number | null = null
      await download({
        url: release.url,
        dest: archive,
        sha256: release.sha256 ?? asset.fallback.sha256,
        size: release.bytes,
        fetchImpl: this.fetchFn(),
        signal,
        onProgress: (done, total) => {
          const now = Date.now()
          if (now - lastTime > 1500) {
            speed = Math.round(((done - lastBytes) / (now - lastTime)) * 1000)
            lastBytes = done
            lastTime = now
          }
          this.emit({ kind: 'runtime', stage: 'downloading', message: 'Downloading ComfyUI…', item: asset.name, doneBytes: done, totalBytes: total, fraction: total ? done / total / 3 : null, step: 1, steps: 3, speed })
        }
      })
      this.emit({ kind: 'runtime', stage: 'unpacking', message: 'Unpacking ComfyUI… this takes a few minutes.', item: asset.name, step: 2, steps: 3, fraction: 0.34 })
      const staging = mkdtempSync(join(root, 'runtime', '.unpack-'))
      await (this.deps.extract ?? extractWithTar)(archive, staging, (count) => this.emit({ kind: 'runtime', stage: 'unpacking', message: `Unpacking ComfyUI… ${count.toLocaleString()} files`, item: asset.name, step: 2, steps: 3, fraction: Math.min(0.66, 0.34 + (count / 60000) * 0.32) }), signal)
      const inner = readdirSync(staging).find((n) => existsSync(join(staging, n, 'ComfyUI', 'main.py'))) ?? ''
      if (!inner) throw new Error('The unpacked download does not look like ComfyUI. It was removed; starting again downloads it afresh.')
      const folder = this.newRuntimeFolder(root, release.tag)
      renameSync(join(staging, inner), folder)
      rmSync(staging, { recursive: true, force: true })
      this.emit({ kind: 'runtime', stage: 'configuring', message: 'Setting up…', step: 3, steps: 3, fraction: 0.7 })
      this.configureRuntime(folder, root)
      const old = this.data.root === root ? this.data : structuredClone(DEFAULTS)
      this.data = { ...old, mode: 'managed', root, runtime: { tag: release.tag, folder, variant }, previous: old.runtime ? [...old.previous, old.runtime.folder] : old.previous }
      this.save()
      this.deps.useRuntime(folder, this.launchArgs(root), this.deps.port ?? MANAGED_PORT)
      if (this.deps.verifyRuntime) {
        this.emit({ kind: 'runtime', stage: 'starting', message: 'Starting ComfyUI once to check that it works…', step: 3, steps: 3, fraction: 0.85 })
        const why = await this.deps.verifyRuntime()
        if (why) throw new Error(why)
      }
      rmSync(archive, { force: true })
      this.emit({ kind: 'runtime', stage: 'done', message: 'ComfyUI is installed and works.', step: 3, steps: 3, fraction: 1 })
    } catch (error) {
      this.fail('runtime', error, signal.aborted)
      if (!signal.aborted) throw error instanceof Error ? error : new Error('The installation failed.')
    } finally {
      this.working = false
      this.controller = null
    }
    return this.status()
  }

  private fail(kind: AiJob['kind'], error: unknown, stopped: boolean): void {
    const message = stopped ? 'Stopped. Starting it again continues where it left off.' : error instanceof Error ? error.message : 'The installation failed.'
    if (!stopped) this.problem = message
    this.emit({ kind, stage: stopped ? 'stopped' : 'failed', message })
  }

  private launchArgs(root: string): string[] {
    return ['--output-directory', join(this.workDir(root), 'output'), '--input-directory', join(this.workDir(root), 'input'), '--temp-directory', join(this.workDir(root), 'temp'), '--user-directory', join(this.workDir(root), 'user')]
  }

  private newRuntimeFolder(root: string, tag: string): string {
    if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error('The runtime release name is invalid.')
    const folder = join(root, 'runtime', `ComfyUI-${tag}`)
    return existsSync(folder) ? folder + '-' + randomUUID() : folder
  }

  /** Writes the one file ComfyUI reads to find the shared models folder. Only ever inside Atlas's own runtime. */
  private configureRuntime(folder: string, root: string): void {
    for (const d of ['output', 'input', 'temp', 'user']) mkdirSync(join(this.workDir(root), d), { recursive: true })
    const models = this.modelsDir(root).replace(/\\/g, '/')
    for (const d of ['checkpoints', 'controlnet', 'upscale_models', 'vae', 'loras', 'text_encoders', 'diffusion_models']) mkdirSync(join(this.modelsDir(root), d), { recursive: true })
    const yaml = ['# Written by NOEMA Atlas. Models live outside the runtime so that updating ComfyUI never moves them.', 'atlas_models:', `    base_path: ${models}/`, '    checkpoints: checkpoints', '    controlnet: controlnet', '    upscale_models: upscale_models', '    vae: vae', '    loras: loras', '    text_encoders: text_encoders', '    diffusion_models: diffusion_models', ''].join('\n')
    writeFileSync(join(folder, 'ComfyUI', 'extra_model_paths.yaml'), yaml, 'utf8')
  }

  // ---- packages --------------------------------------------------------------------------------------------------------

  /** The packages to install for the ones asked for, with everything they need, in a sensible order. */
  expand(ids: CapabilityId[]): CapabilityId[] {
    const wanted = new Set<CapabilityId>()
    const add = (id: CapabilityId): void => {
      for (const need of PACKAGES.find((p) => p.id === id)?.needs ?? []) add(need)
      wanted.add(id)
    }
    ids.forEach(add)
    return PACKAGES.map((p) => p.id).filter((id) => wanted.has(id))
  }

  async installPackages(ids: CapabilityId[], consent: boolean): Promise<AiStatus> {
    if (!consent) throw new Error('Please confirm that you agree to the downloads and the licences first.')
    if (this.data.mode !== 'managed' || !this.data.root || !this.data.runtime) throw new Error('Atlas can add models only to the ComfyUI it manages itself. Install Atlas’s own ComfyUI first. Atlas never writes into another ComfyUI installation.')
    if (this.working) throw new Error('Something is already being installed.')
    const packs = this.expand(ids)
    const keys = Array.from(new Set(packs.flatMap((id) => PACKAGES.find((p) => p.id === id)!.files))).filter((key) => !this.isInstalled(key))
    const needed = keys.reduce((s, k) => s + this.fileOf(k).bytes - this.partialBytes(k), 0)
    const free = await (this.deps.freeBytes ?? freeSpace)(this.data.root)
    if (free !== null && free < needed * 1.05) throw new Error(`There is not enough room on that drive: ${(needed / 1e9).toFixed(1)} GB is needed and ${(free / 1e9).toFixed(1)} GB is free.`)
    this.working = true
    this.problem = null
    this.controller = new AbortController()
    const signal = this.controller.signal
    try {
      const total = keys.reduce((s, k) => s + this.fileOf(k).bytes, 0)
      let completedBytes = 0
      let lastBytes = 0
      let lastTime = Date.now()
      let speed: number | null = null
      for (const [index, key] of keys.entries()) {
        const file = this.fileOf(key)
        this.emit({ kind: 'packages', stage: 'downloading', message: `Downloading ${file.name}…`, item: file.name, step: index + 1, steps: keys.length, totalBytes: total, doneBytes: completedBytes })
        const dest = join(this.modelsDir(), file.folder, file.name)
        const downloaded = await download({
          url: file.url,
          dest,
          sha256: file.sha256,
          size: file.bytes,
          fetchImpl: this.fetchFn(),
          signal,
          onProgress: (done) => {
            const now = Date.now()
            if (now - lastTime > 1500) {
              speed = Math.round(((completedBytes + done - lastBytes) / (now - lastTime)) * 1000)
              lastBytes = completedBytes + done
              lastTime = now
            }
            this.emit({ kind: 'packages', stage: 'downloading', message: `Downloading ${file.name}…`, item: file.name, step: index + 1, steps: keys.length, totalBytes: total, doneBytes: completedBytes + done, fraction: (completedBytes + done) / total, speed })
          }
        })
        completedBytes += file.bytes
        this.data.installed[key] = { name: file.name, folder: file.folder, bytes: file.bytes, sha256: file.sha256, at: Date.now(), owned: !downloaded.reused }
        this.save()
      }
      this.emit({ kind: 'packages', stage: 'done', message: keys.length === 0 ? 'Everything is already installed.' : 'Installed and verified.', step: keys.length, steps: keys.length, fraction: 1, totalBytes: total, doneBytes: total })
      this.deps.modelsChanged?.()
    } catch (error) {
      this.fail('packages', error, signal.aborted)
      if (!signal.aborted) throw error instanceof Error ? error : new Error('The installation failed.')
    } finally {
      this.working = false
      this.controller = null
    }
    return this.status()
  }

  // ---- updates ---------------------------------------------------------------------------------------------------------

  async checkForUpdate(): Promise<string | null> {
    if (!this.data.runtime) return null
    const latest = await (this.deps.latestRelease ?? ((v) => githubLatest(v, this.fetchFn())))(this.data.runtime.variant)
    this.updateTag = latest && latest.tag !== this.data.runtime.tag ? latest.tag : null
    return this.updateTag
  }

  /**
   * Installs the newer ComfyUI next to the current one, checks that it starts, and only then switches. The old runtime is
   * kept (the models are shared and untouched) until the user removes it, so a bad update can be undone by switching back.
   */
  async updateRuntime(consent: boolean): Promise<AiStatus> {
    if (!consent) throw new Error('Please confirm the update first.')
    const current = this.data.runtime
    if (!current || !this.data.root) throw new Error('There is no ComfyUI installed by Atlas to update.')
    const root = this.data.root
    const before = { ...current }
    const latest = await (this.deps.latestRelease ?? ((v) => githubLatest(v, this.fetchFn())))(current.variant)
    if (!latest || latest.tag === current.tag) throw new Error('ComfyUI is already up to date.')
    const asset = RUNTIME_ASSETS[current.variant]
    this.working = true
    this.controller = new AbortController()
    const signal = this.controller.signal
    try {
      const archive = join(root, 'downloads', asset.name)
      await download({ url: latest.url, dest: archive, sha256: latest.sha256, size: latest.bytes, fetchImpl: this.fetchFn(), signal, onProgress: (done, total) => this.emit({ kind: 'update', stage: 'downloading', message: `Downloading ComfyUI ${latest.tag}…`, item: asset.name, doneBytes: done, totalBytes: total, fraction: total ? done / total / 2 : null }) })
      const staging = mkdtempSync(join(root, 'runtime', '.unpack-'))
      this.emit({ kind: 'update', stage: 'unpacking', message: 'Unpacking the new ComfyUI beside the old one…', fraction: 0.5 })
      await (this.deps.extract ?? extractWithTar)(archive, staging, () => undefined, signal)
      const inner = readdirSync(staging).find((n) => existsSync(join(staging, n, 'ComfyUI', 'main.py'))) ?? ''
      if (!inner) throw new Error('The update does not look like ComfyUI, so it was discarded. Your current ComfyUI is unchanged.')
      const folder = this.newRuntimeFolder(root, latest.tag)
      renameSync(join(staging, inner), folder)
      rmSync(staging, { recursive: true, force: true })
      this.configureRuntime(folder, root)
      this.data.runtime = { tag: latest.tag, folder, variant: current.variant }
      this.save()
      this.deps.useRuntime(folder, this.launchArgs(root), this.deps.port ?? MANAGED_PORT)
      if (this.deps.verifyRuntime) {
        this.emit({ kind: 'update', stage: 'starting', message: 'Checking that the new ComfyUI starts…', fraction: 0.85 })
        const why = await this.deps.verifyRuntime()
        if (why) throw new Error(why)
      }
      this.data.previous = Array.from(new Set([...this.data.previous, before.folder]))
      this.save()
      rmSync(archive, { force: true })
      this.updateTag = null
      this.emit({ kind: 'update', stage: 'done', message: `Updated to ComfyUI ${latest.tag}. The previous version is kept until you remove it.`, fraction: 1 })
    } catch (error) {
      // Switch back: the old runtime is still there and still works.
      this.data.runtime = before
      this.save()
      this.deps.useRuntime(before.folder, this.launchArgs(root), this.deps.port ?? MANAGED_PORT)
      this.fail('update', error, signal.aborted)
      if (!signal.aborted) throw error instanceof Error ? new Error(`${error.message} Your previous ComfyUI is unchanged and still in use.`) : new Error('The update failed. Your previous ComfyUI is unchanged.')
    } finally {
      this.working = false
      this.controller = null
    }
    return this.status()
  }

  // ---- housekeeping ----------------------------------------------------------------------------------------------------

  /** Re-checks everything Atlas installed: files present with the right size. Returns what is wrong, in plain words. */
  verifyFiles(): string[] {
    const problems: string[] = []
    if (this.data.runtime && !existsSync(join(this.data.runtime.folder, 'ComfyUI', 'main.py'))) problems.push('The ComfyUI that Atlas installed is missing or damaged.')
    for (const [key, proof] of Object.entries(this.data.installed)) {
      if (!this.isInstalled(key)) problems.push(`${proof.name} is missing or the wrong size. Install the package again to fetch it.`)
    }
    return problems
  }

  /** Removes what Atlas itself installed (its runtime, previous runtimes and the models it added). Nothing else is touched. */
  async uninstall(): Promise<void> {
    if (this.working) throw new Error('Wait until the current installation has finished, or stop it first.')
    const root = this.data.root
    if (!root || !existsSync(join(root, 'atlas-ai.json'))) throw new Error('There is nothing installed by Atlas to remove.')
    for (const folder of new Set([...(this.data.runtime ? [this.data.runtime.folder] : []), ...this.data.previous])) {
      if (!existsSync(folder)) continue
      if (dirname(realpathSync(folder)).toLowerCase() !== join(realpathSync(root), 'runtime').toLowerCase()) throw new Error('The runtime is outside the managed folder.')
      const retained = join(root, 'retained')
      mkdirSync(retained, { recursive: true })
      renameSync(folder, join(retained, basename(folder) + '-' + randomUUID()))
    }
    await this.removeFiles(Object.entries(this.data.installed).map(([key, proof]) => ({ key, name: proof.name, folder: proof.folder })))
    this.data = { ...DEFAULTS, mode: 'none', root }
    this.save()
  }
}
