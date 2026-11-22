/**
 * Starting ComfyUI when it is needed, and connecting to it when it is already running. Atlas only ever stops an
 * instance that Atlas itself started; an instance the user started is never touched.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ComfyInstall } from './comfyInstall'

export class ComfyStartError extends Error {}

export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<Response>

export interface LauncherDeps {
  fetchImpl: FetchFn
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
  /** Stops a process and everything it started. */
  kill?: (child: ChildProcess) => void
  isPortFree?: (port: number) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
  /** How long to wait for ComfyUI to come up, in milliseconds. */
  startTimeoutMs?: number
}

/** What the user (or the project's start script) decided about how to start this installation. */
export interface LaunchOptions {
  /** A Python to use instead of the one found with the installation. */
  python?: string | null
  /** A fixed port. When set, Atlas uses only this port: it connects to what answers there, or starts on it. */
  port?: number | null
  /** Extra start options, such as --fp16-unet. */
  args?: string[]
  /** Folders ComfyUI should use for its pictures, so a test or a careful user can keep the installation itself untouched. */
  extraArgs?: string[]
}

export interface Connection {
  url: string
  /** True when this Atlas session started it (and so may stop it). */
  managed: boolean
}

const PORTS_TO_TRY = [8188, 8000, 8189, 8001]

/**
 * The environment a project-style Python (a virtual environment with a cache folder beside it) is normally started in:
 * no user-site packages leaking in, UTF-8, and model caches kept next to the project. Only set when the folders exist.
 */
export function projectEnvironment(python: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (basename(dirname(python)).toLowerCase() !== 'scripts') return env
  const venvRoot = dirname(dirname(python))
  env.PYTHONNOUSERSITE = '1'
  env.PYTHONUTF8 = '1'
  const cache = join(dirname(venvRoot), 'cache')
  if (existsSync(cache)) {
    env.HF_HOME = join(cache, 'huggingface')
    env.TORCH_HOME = join(cache, 'torch')
    env.XDG_CACHE_HOME = cache
  }
  return env
}

/** Plain-language reasons from what ComfyUI printed. */
export function explainStartFailure(log: string[], code: number | null, port: number | null): string {
  const text = log.join('\n')
  if (/address already in use|WinError 10048|only one usage of each socket|EADDRINUSE/i.test(text)) {
    return `Another program is already using the address ComfyUI wanted${port ? ` (port ${port})` : ''}. Close it, or start ComfyUI yourself and Atlas will connect to it.`
  }
  if (/Found no NVIDIA driver|Torch not compiled with CUDA|CUDA error: no kernel image|no CUDA|AssertionError: Torch/i.test(text)) {
    return 'ComfyUI could not use the graphics card. Update the graphics driver, or start ComfyUI once yourself in its CPU mode.'
  }
  if (/out of memory/i.test(text)) return 'The graphics card ran out of memory while ComfyUI was starting. Close other programs that use it, then try again.'
  const missing = /No module named ['"]([^'"]+)['"]/.exec(text)
  if (missing) return `ComfyUI’s Python is missing a package (${missing[1]}). Start ComfyUI once yourself so it can finish its own setup, then try again.`
  const last = [...log].reverse().find((line) => line.trim() && !/^\s*$/.test(line))
  return `ComfyUI stopped while starting${code !== null ? ` (code ${code})` : ''}.${last ? ` It said: ${last.trim().slice(0, 160)}` : ''}`
}

async function probe(fetchImpl: FetchFn, url: string, timeoutMs = 900): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${url}/system_stats`, { signal: controller.signal })
      if (!response.ok) return false
      const data = (await response.json()) as { system?: unknown; devices?: unknown }
      return Boolean(data && (data.system || data.devices))
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

function portOf(url: string): number | null {
  try {
    return Number(new URL(url).port) || null
  } catch {
    return null
  }
}

export class ComfyLauncher {
  private child: ChildProcess | null = null
  private log: string[] = []
  private readyUrl: string | null = null
  private starting: Promise<Connection> | null = null
  private lastFailure: string | null = null

  constructor(private deps: LauncherDeps) {}

  /** The last lines ComfyUI printed while Atlas was starting it. */
  logTail(lines = 12): string[] {
    return this.log.slice(-lines)
  }

  get failure(): string | null {
    return this.lastFailure
  }

  get isStarting(): boolean {
    return this.starting !== null
  }

  /** The address Atlas started, if it is still running. */
  get managedUrl(): string | null {
    return this.child && !this.child.killed && this.child.exitCode === null ? this.readyUrl : null
  }

  /** Whether a ComfyUI answers at exactly this address. */
  probeUrl(url: string): Promise<boolean> {
    return probe(this.deps.fetchImpl, url.replace(/\/+$/, ''))
  }

  /** Looks for a ComfyUI that is already answering, on the usual addresses. Never starts anything. */
  async findRunning(preferred: string[] = []): Promise<string | null> {
    const candidates = [...preferred, ...PORTS_TO_TRY.map((p) => `http://127.0.0.1:${p}`)]
    const seen = new Set<string>()
    for (const url of candidates) {
      const clean = url.replace(/\/+$/, '')
      if (seen.has(clean)) continue
      seen.add(clean)
      if (await probe(this.deps.fetchImpl, clean)) return clean
    }
    return null
  }

  private portIsFree(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(port, '127.0.0.1')
    })
  }

  private async freePort(from: number): Promise<number> {
    const isFree =
      this.deps.isPortFree ??
      ((port: number) =>
        new Promise<boolean>((resolve) => {
          const server = createServer()
          server.once('error', () => resolve(false))
          server.once('listening', () => server.close(() => resolve(true)))
          server.listen(port, '127.0.0.1')
        }))
    for (let port = from; port < from + 40; port += 1) if (await isFree(port)) return port
    return from
  }

  /**
   * Returns a connection to ComfyUI: the one that is already running if there is one, otherwise a new one that Atlas
   * starts from the installation. Waits until it answers.
   */
  ensureRunning(install: ComfyInstall, options: { preferredUrl?: string; onProgress?: (message: string) => void; signal?: AbortSignal; launch?: LaunchOptions } = {}): Promise<Connection> {
    if (this.starting) return this.starting
    this.starting = this.run(install, options).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async run(install: ComfyInstall, options: { preferredUrl?: string; onProgress?: (message: string) => void; signal?: AbortSignal; launch?: LaunchOptions }): Promise<Connection> {
    const say = options.onProgress ?? (() => undefined)
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    this.lastFailure = null

    // 1. Already running (ours or the user's): connect, never start a second one.
    const managed = this.managedUrl
    if (managed && (await probe(this.deps.fetchImpl, managed))) return { url: managed, managed: true }
    const fixedPort = options.launch?.port ?? null
    if (fixedPort) {
      // A port was chosen on purpose: only that address counts. Another ComfyUI on a different port is not this one.
      const url = `http://127.0.0.1:${fixedPort}`
      if (await probe(this.deps.fetchImpl, url)) return { url, managed: false }
    } else {
      const running = await this.findRunning(options.preferredUrl ? [options.preferredUrl] : [`http://127.0.0.1:${install.defaultPort}`])
      if (running) return { url: running, managed: false }
    }

    // 2. Start it.
    if (!install.launch) throw new ComfyStartError(install.launchProblem ?? 'Atlas cannot start this ComfyUI.')
    const spawnFn = this.deps.spawn ?? nodeSpawn
    const baseEnv = { ...(this.deps.env ?? process.env), PYTHONIOENCODING: 'utf-8' }
    let command: string
    let args: string[]
    let cwd: string
    let port: number | null = null
    let extraEnv: NodeJS.ProcessEnv = {}
    if (install.launch.kind === 'python') {
      if (fixedPort) {
        const isFree = this.deps.isPortFree ?? ((p: number) => this.portIsFree(p))
        if (!(await isFree(fixedPort))) {
          this.lastFailure = `Port ${fixedPort} is used by another program that is not ComfyUI. Close that program, or choose another port for this ComfyUI in the Studio settings.`
          throw new ComfyStartError(this.lastFailure)
        }
        port = fixedPort
      } else {
        port = await this.freePort(install.defaultPort)
      }
      const testPython = process.env.NOEMA_E2E === '1' ? process.env.NOEMA_COMFY_PYTHON : undefined
      const chosenPython = options.launch?.python && existsSync(options.launch.python) ? options.launch.python : install.launch.python
      command = testPython || chosenPython
      if (!testPython && chosenPython !== 'python' && !existsSync(chosenPython)) {
        this.lastFailure = `The Python for this ComfyUI cannot be found (${chosenPython}). Choose it again in the Studio settings.`
        throw new ComfyStartError(this.lastFailure)
      }
      if (!testPython) extraEnv = projectEnvironment(command)
      args = [
        ...(install.launch.usesEmbeddedPython && !testPython ? ['-s'] : []),
        install.launch.script,
        '--listen',
        '127.0.0.1',
        '--port',
        String(port),
        '--disable-auto-launch',
        ...(install.kind === 'portable' && !testPython ? ['--windows-standalone-build'] : []),
        ...(options.launch?.args ?? []),
        ...(options.launch?.extraArgs ?? [])
      ]
      cwd = install.kind === 'portable' ? install.folder : install.serverFolder
    } else {
      command = install.launch.exe
      args = []
      cwd = dirname(install.launch.exe)
    }
    say('Starting ComfyUI. The first start can take a minute while it loads.')
    const env = { ...baseEnv, ...extraEnv }
    this.log = []
    let exited: { code: number | null } | null = null
    let spawnError: Error | null = null
    const useShell = /\.(cmd|bat)$/i.test(command)
    const child = spawnFn(command, args, { cwd, env, windowsHide: install.launch.kind === 'python', stdio: ['ignore', 'pipe', 'pipe'], shell: useShell })
    this.child = child
    const take = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.log.push(line.slice(0, 300))
      }
      if (this.log.length > 300) this.log.splice(0, this.log.length - 300)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('exit', (code) => {
      exited = { code }
    })

    const started = Date.now()
    const timeout = this.deps.startTimeoutMs ?? 240_000
    const ports = port ? [port] : fixedPort ? [fixedPort] : [8000, 8001, 8002, 8188, 8189]
    for (;;) {
      if (options.signal?.aborted) {
        this.stop()
        throw new ComfyStartError('Starting ComfyUI was stopped.')
      }
      for (const p of ports) {
        const url = `http://127.0.0.1:${p}`
        if (await probe(this.deps.fetchImpl, url)) {
          this.readyUrl = url
          return { url, managed: true }
        }
      }
      if (spawnError) {
        this.child = null
        const code = (spawnError as NodeJS.ErrnoException).code
        this.lastFailure =
          code === 'ENOENT'
            ? `Windows could not start “${command}”. The installation may have been moved or removed. Choose the ComfyUI folder again.`
            : `ComfyUI could not be started: ${(spawnError as Error).message}`
        throw new ComfyStartError(this.lastFailure)
      }
      if (exited) {
        this.child = null
        // The Desktop app may hand over to an instance that was already starting: look once more before giving up.
        const late = fixedPort ? ((await probe(this.deps.fetchImpl, `http://127.0.0.1:${fixedPort}`)) ? `http://127.0.0.1:${fixedPort}` : null) : await this.findRunning()
        if (late) return { url: late, managed: false }
        this.lastFailure = explainStartFailure(this.log, (exited as { code: number | null }).code, port)
        throw new ComfyStartError(this.lastFailure)
      }
      const seconds = Math.round((Date.now() - started) / 1000)
      if (Date.now() - started > timeout) {
        this.lastFailure = `ComfyUI did not answer within ${Math.round(timeout / 60_000)} minutes. It may still be loading models. Check its window, then try again.`
        throw new ComfyStartError(this.lastFailure)
      }
      if (seconds % 5 === 0) say(`Starting ComfyUI… ${seconds}s${this.log.length ? ` (${this.log[this.log.length - 1]!.slice(0, 70)})` : ''}`)
      await sleep(700)
    }
  }

  /** Stops ComfyUI (only one Atlas started) and waits until it no longer answers, so the status that follows is true. */
  async stopAndWait(timeoutMs = 8000): Promise<boolean> {
    const url = this.readyUrl
    const stopped = this.stop()
    if (stopped && url) {
      const end = Date.now() + timeoutMs
      while (Date.now() < end && (await probe(this.deps.fetchImpl, url, 400))) await new Promise((r) => setTimeout(r, 250))
    }
    return stopped
  }

  /** Stops ComfyUI, but only if Atlas started it. Returns whether something was stopped. */
  stop(): boolean {
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.child = null
      return false
    }
    const kill =
      this.deps.kill ??
      ((c: ChildProcess) => {
        if (process.platform === 'win32' && c.pid) nodeSpawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true })
        else c.kill()
      })
    kill(child)
    this.child = null
    this.readyUrl = null
    return true
  }
}

export { portOf }
