/**
 * Finding out what a ComfyUI installation is, from the folder the user points at, without starting anything and without
 * writing anything into it. Three layouts are understood:
 *
 *  - portable: the "ComfyUI_windows_portable" download, with its own python_embeded folder next to a ComfyUI folder;
 *  - source: a ComfyUI folder with main.py (a git clone or a manual install), run with a virtual environment or Python;
 *  - desktop: the ComfyUI Desktop app (ComfyUI.exe), whose models usually live in a separate "base path" chosen at setup.
 *
 * Everything here only reads.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type ComfyKind = 'portable' | 'source' | 'desktop'

export interface ComfyInstall {
  /** The folder the user chose. */
  folder: string
  kind: ComfyKind
  /** A short plain name for the installation. */
  name: string
  version: string | null
  /** The folder with main.py. */
  serverFolder: string
  /** The folder that holds models, input, output, custom_nodes and user. */
  dataFolder: string
  /** Where to start it from. */
  launch: { kind: 'python'; python: string; usesEmbeddedPython: boolean; script: string } | { kind: 'exe'; exe: string } | null
  /** Why it cannot be started by Atlas, in plain words, when it cannot. */
  launchProblem: string | null
  /** Extra places that were configured for models (extra_model_paths.yaml and the Desktop app's own list). */
  extraConfigFiles: string[]
  /** The port the installation normally listens on. */
  defaultPort: number
  /** Start scripts found next to the installation (the project's own way of starting it), read only. */
  profiles: LaunchProfile[]
  /** Folders near the installation that hold workflow files (for example a project's presets). */
  workflowFolderSuggestions: string[]
}

/** How the owner of an installation starts it, read from a start script that sits beside it. Never run by Atlas. */
export interface LaunchProfile {
  name: string
  file: string
  port: number | null
  /** The extra start options (not the address, port or auto-launch, which Atlas sets itself). */
  args: string[]
}

export interface IdentifyOptions {
  /** Where the Desktop app keeps its configuration (%APPDATA%). Overridable for tests. */
  appData?: string
  /** A Python the user chose for this installation (a virtual environment outside the ComfyUI folder, say). */
  python?: string | null
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readVersion(serverFolder: string): string | null {
  try {
    const text = readFileSync(join(serverFolder, 'comfyui_version.py'), 'utf8')
    return /__version__\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ?? null
  } catch {
    return null
  }
}

function venvPython(folder: string): string | null {
  for (const name of ['.venv', 'venv', 'env', '.env']) {
    const candidate = join(folder, name, 'Scripts', 'python.exe')
    if (isFile(candidate)) return candidate
  }
  return null
}

/**
 * Reads a start script (.ps1, .bat, .cmd) and pulls out how it starts ComfyUI: the port and the extra options. Only
 * text is read; the script is never run. Returns null when it does not start ComfyUI's main.py.
 */
export function parseStartScript(text: string, file: string): LaunchProfile | null {
  const lines = text.split(/\r?\n/)
  const index = lines.findIndex((line) => /main\.py/i.test(line) && !/^\s*(#|rem\b|::)/i.test(line) && /--(port|listen|disable-auto-launch)|ArgumentList|python/i.test(line))
  if (index < 0) return null
  const line = lines[index]!
  const after = line.slice(line.toLowerCase().indexOf('main.py') + 7)
  // PowerShell: the argument list ends where the next parameter ( -WorkingDirectory ...) begins.
  const cut = after.search(/\s-[A-Z][A-Za-z]+\b|[|>]/)
  const tokens = (cut >= 0 ? after.slice(0, cut) : after)
    .replace(/['",]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !t.includes('$') && !t.includes('%'))
  let port: number | null = null
  const args: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!
    if (token === '--port') {
      const value = Number(tokens[i + 1])
      if (Number.isInteger(value) && value > 0 && value < 65536) port = value
      i += 1
    } else if (token === '--listen') {
      if (tokens[i + 1] && !tokens[i + 1]!.startsWith('--')) i += 1
    } else if (token === '--disable-auto-launch' || token === '--windows-standalone-build') {
      continue
    } else if (/^--?[A-Za-z]/.test(token) || (args.length > 0 && /^[\w.,:/\\-]+$/.test(token) && /^--/.test(args[args.length - 1]!))) {
      args.push(token)
    }
  }
  const stem = basename(file).replace(/\.(ps1|bat|cmd)$/i, '').replace(/[_-]+/g, ' ').trim()
  return { name: stem, file, port, args }
}

/** Start scripts beside the installation (in its project folder), most plainly named first. */
export function findLaunchProfiles(serverFolder: string): LaunchProfile[] {
  const folders = [dirname(serverFolder), dirname(dirname(serverFolder))]
  const found: LaunchProfile[] = []
  const seen = new Set<string>()
  for (const folder of folders) {
    let entries: string[] = []
    try {
      entries = readdirSync(folder)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!/\.(ps1|bat|cmd)$/i.test(name) || !/comfy/i.test(name)) continue
      const file = join(folder, name)
      if (seen.has(file.toLowerCase())) continue
      seen.add(file.toLowerCase())
      try {
        if (statSync(file).size > 64 * 1024) continue
        const profile = parseStartScript(readFileSync(file, 'utf8'), file)
        if (profile) found.push(profile)
      } catch {
        // Unreadable script: ignore it.
      }
    }
  }
  return found.sort((a, b) => a.file.length - b.file.length || a.file.localeCompare(b.file))
}

/** Folders next to the installation that look like they hold workflow files. Only looks; reads nothing inside. */
export function findWorkflowFolders(serverFolder: string): string[] {
  const out: string[] = []
  const roots = [dirname(dirname(serverFolder)), dirname(serverFolder)]
  const hasJson = (folder: string): boolean => {
    try {
      return readdirSync(folder).some((n) => /^workflow.*\.json$/i.test(n) || /\.json$/i.test(n))
    } catch {
      return false
    }
  }
  for (const root of roots) {
    for (const name of ['presets', 'workflows']) {
      const folder = join(root, name)
      if (!isDir(folder)) continue
      try {
        const children = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory())
        const withWorkflows = children.filter((c) => {
          const inner = join(folder, c.name)
          try {
            return hasJson(inner) || readdirSync(inner, { withFileTypes: true }).some((e) => e.isDirectory() && hasJson(join(inner, e.name)))
          } catch {
            return false
          }
        })
        if (hasJson(folder)) out.push(folder)
        else for (const child of withWorkflows) out.push(join(folder, child.name))
      } catch {
        // Not readable.
      }
    }
  }
  return Array.from(new Set(out)).slice(0, 8)
}

/** The Desktop app's "base path" (where its models, input and output live), from its own configuration. */
export function desktopBasePath(appData: string | undefined): string | null {
  if (!appData) return null
  try {
    const config = JSON.parse(readFileSync(join(appData, 'ComfyUI', 'config.json'), 'utf8')) as { basePath?: string }
    return typeof config.basePath === 'string' && isDir(config.basePath) ? config.basePath : null
  } catch {
    return null
  }
}

/**
 * Works out what `folder` is. Accepts the portable folder, the folder that holds main.py, the Desktop app's folder,
 * or (as a convenience) the folder just above any of them. Returns null with a reason when it is not ComfyUI.
 */
function identifyCore(input: string, options: IdentifyOptions): { install: ComfyInstall } | { problem: string } {
  const folder = resolve(input)
  if (!isDir(folder)) return { problem: 'That folder cannot be opened.' }

  // Portable: python_embeded next to ComfyUI\main.py.
  const portableServer = join(folder, 'ComfyUI')
  if (isFile(join(portableServer, 'main.py')) && isDir(join(folder, 'python_embeded'))) {
    const python = join(folder, 'python_embeded', 'python.exe')
    return {
      install: {
        folder,
        kind: 'portable',
        name: 'ComfyUI (portable)',
        version: readVersion(portableServer),
        serverFolder: portableServer,
        dataFolder: portableServer,
        launch: isFile(python) ? { kind: 'python', python, usesEmbeddedPython: true, script: join(portableServer, 'main.py') } : null,
        launchProblem: isFile(python) ? null : 'This portable folder has no python_embeded\\python.exe, so Atlas cannot start it.',
        extraConfigFiles: [join(portableServer, 'extra_model_paths.yaml')].filter(isFile),
        defaultPort: 8188,
        profiles: [],
        workflowFolderSuggestions: []
      }
    }
  }

  // Desktop app: ComfyUI.exe with the server inside resources\ComfyUI.
  const desktopServer = join(folder, 'resources', 'ComfyUI')
  if (isFile(join(folder, 'ComfyUI.exe')) && isFile(join(desktopServer, 'main.py'))) {
    const hasOwnData = isDir(join(folder, 'models'))
    const base = hasOwnData ? folder : desktopBasePath(options.appData) ?? folder
    const extra = options.appData ? join(options.appData, 'ComfyUI', 'extra_models_config.yaml') : ''
    return {
      install: {
        folder,
        kind: 'desktop',
        name: 'ComfyUI Desktop',
        version: readVersion(desktopServer),
        serverFolder: desktopServer,
        dataFolder: base,
        launch: { kind: 'exe', exe: join(folder, 'ComfyUI.exe') },
        launchProblem: null,
        extraConfigFiles: [extra].filter((f) => f && isFile(f)),
        defaultPort: 8000,
        profiles: [],
        workflowFolderSuggestions: []
      }
    }
  }

  // Source: main.py in the folder itself.
  if (isFile(join(folder, 'main.py')) && isDir(join(folder, 'comfy'))) {
    const python = venvPython(folder) ?? venvPython(dirname(folder))
    return {
      install: {
        folder,
        kind: 'source',
        name: 'ComfyUI',
        version: readVersion(folder),
        serverFolder: folder,
        dataFolder: folder,
        launch: { kind: 'python', python: python ?? 'python', usesEmbeddedPython: false, script: join(folder, 'main.py') },
        launchProblem: null,
        extraConfigFiles: [join(folder, 'extra_model_paths.yaml')].filter(isFile),
        defaultPort: 8188,
        profiles: [],
        workflowFolderSuggestions: []
      }
    }
  }

  // The user picked a folder just above: look one level down.
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      if (!/comfy/i.test(entry.name)) continue
      const inner = identifyCore(join(folder, entry.name), options)
      if ('install' in inner) return inner
    }
  } catch {
    // Not readable: fall through.
  }

  if (isDir(join(folder, 'models')) && isDir(join(folder, 'custom_nodes'))) {
    return { problem: 'This looks like ComfyUI\'s data folder (models and custom nodes), not the program itself. Choose the folder that contains ComfyUI.exe, run_nvidia_gpu.bat or main.py.' }
  }
  return { problem: 'This does not look like a ComfyUI installation. Choose the folder that contains ComfyUI.exe, the portable folder with python_embeded, or the folder with main.py.' }
}

export function identifyInstall(input: string, options: IdentifyOptions = {}): { install: ComfyInstall } | { problem: string } {
  const result = identifyCore(input, options)
  if (!('install' in result)) return result
  const install = result.install
  install.profiles = findLaunchProfiles(install.serverFolder)
  install.workflowFolderSuggestions = findWorkflowFolders(install.serverFolder)
  if (options.python && install.launch?.kind === 'python' && isFile(options.python)) {
    install.launch = { ...install.launch, python: options.python, usesEmbeddedPython: false }
    install.launchProblem = null
  }
  return { install }
}

/** Likely places for an existing installation, for the "found on this computer" suggestions. Only looks at folder names. */
export function suggestInstalls(roots: { localAppData?: string; home?: string; appData?: string; extra?: string[] }): ComfyInstall[] {
  const candidates = new Set<string>()
  const add = (path: string | undefined): void => {
    if (path && isDir(path)) candidates.add(resolve(path))
  }
  if (roots.localAppData) add(join(roots.localAppData, 'Programs', 'ComfyUI'))
  const searchIn = [roots.home, roots.home && join(roots.home, 'Desktop'), roots.home && join(roots.home, 'Documents'), roots.home && join(roots.home, 'Downloads'), 'C:\\', 'D:\\', 'G:\\', ...(roots.extra ?? [])]
  for (const base of searchIn) {
    if (!base || !isDir(base)) continue
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^comfy/i.test(entry.name)) add(join(base, entry.name))
      }
    } catch {
      // Not readable.
    }
  }
  const found: ComfyInstall[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const result = identifyInstall(candidate, { appData: roots.appData })
    if ('install' in result && !seen.has(result.install.serverFolder.toLowerCase())) {
      seen.add(result.install.serverFolder.toLowerCase())
      found.push(result.install)
    }
  }
  return found.slice(0, 6)
}

export { basename }
