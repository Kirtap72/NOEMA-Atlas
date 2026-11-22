import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, sep } from 'node:path'
import sharp from './safeSharp'
import { IMAGE_EXTENSIONS } from '../shared/types'
import type { DiscoveredCollection, DiscoveryOptions, DiscoveryProgress, DriveInfo } from '../shared/discovery'

// Finds folders of pictures across whole drives, read-only. Nothing is opened for writing, nothing is indexed, and
// nothing is added to Atlas until the user has looked at what was found and chosen it.

const IMAGE_EXT = new Set<string>(IMAGE_EXTENSIONS)

/** Folders that hold the operating system, programs, caches and developer tooling, never someone's pictures. */
export const DEFAULT_EXCLUDED_NAMES = [
  'windows', 'windows.old', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', 'recovery',
  'appdata', 'application data', 'node_modules', '.git', '.svn', '.hg', '.cache', 'cache', 'caches', 'temp', 'tmp', '__pycache__',
  'site-packages', 'venv', '.venv', 'env', '.npm', '.cargo', '.rustup', '.gradle', '.m2', '.nuget', '.vscode', '.idea', 'dist-packages',
  'steamapps', 'winsxs', 'drivers', 'inetpub', 'msocache', 'config.msi', '$windows.~bt', '$windows.~ws', 'perflogs', 'onedrivetemp',
  'library', 'node-gyp', 'gems', 'vendor', 'bower_components', '.next', '.nuxt', 'unity', 'unrealengine', 'packagecache', 'webcache'
]

/** Names that show a folder is software, not a collection: icons, sprites and assets of programs. */
const SOFTWARE_MARKERS = ['package.json', 'pyvenv.cfg', 'cmakelists.txt', 'pom.xml', 'build.gradle', 'cargo.toml', 'setup.py', 'manifest.json', 'app.asar', 'electron.exe']
const SOFTWARE_EXT = new Set(['.dll', '.exe', '.so', '.dylib', '.pak', '.asar', '.jar', '.pyc', '.lib'])
const MIN_BYTES = 30_000

export async function listDrives(): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = []
  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code)
      const path = `${letter}:\\`
      try {
        await fs.access(path)
        drives.push({ path, label: `${letter}:` , isSystem: letter === (process.env.SystemDrive ?? 'C:')[0] })
      } catch {
        // Not present.
      }
    }
  } else {
    drives.push({ path: '/', label: '/', isSystem: true })
  }
  return drives
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()

/** True for the drive roots and the user's top folders, which are too broad to be one collection. */
function tooBroad(path: string): boolean {
  const n = norm(path)
  const home = norm(homedir())
  const users = norm(dirname(homedir()))
  return n === '' || n === norm(parse(path).root) || n === home || n === users || /^[a-z]:$/.test(n)
}

function isExcluded(path: string, excludedNames: Set<string>, excludedPaths: string[]): boolean {
  const name = basename(path).toLowerCase()
  if (excludedNames.has(name)) return true
  const n = norm(path)
  return excludedPaths.some((e) => n === e || n.startsWith(e + sep.toLowerCase()) || n.startsWith(`${e}\\`) || n.startsWith(`${e}/`))
}

export interface FolderFinding {
  path: string
  images: number
  bytes: number
  samples: string[]
  newest: number
}

/**
 * Groups folders that hold pictures into collections: when a folder has several picture-folders below it (a year of
 * trips, an artist's series) the parent is offered as one collection instead of a long list of fragments.
 */
export function groupCollections(findings: FolderFinding[], inAtlas: (path: string) => boolean): DiscoveredCollection[] {
  const byPath = new Map(findings.map((f) => [f.path, f]))
  // Folders that sit side by side under one parent (a year of trips, a series) become one collection, one level up.
  const siblings = new Map<string, FolderFinding[]>()
  for (const f of findings) {
    const parent = dirname(f.path)
    if (parent === f.path || tooBroad(parent)) continue
    siblings.set(parent, [...(siblings.get(parent) ?? []), f])
  }
  const taken = new Set<string>()
  const result: DiscoveredCollection[] = []
  for (const [parent, members] of siblings) {
    if (members.length < 2) continue
    const own = byPath.get(parent)
    members.forEach((m) => taken.add(m.path))
    if (own) taken.add(own.path)
    result.push(collect(parent, [...members, ...(own ? [own] : [])], members.length + (own ? 1 : 0), inAtlas))
  }
  for (const f of findings) if (!taken.has(f.path)) result.push(collect(f.path, [f], 1, inAtlas))
  return result.sort((a, b) => Number(a.inAtlas) - Number(b.inAtlas) || b.images - a.images)
}

function collect(path: string, group: FolderFinding[], folders: number, inAtlas: (p: string) => boolean): DiscoveredCollection {
  const samples: string[] = []
  // Spread the samples across the member folders so the preview is representative.
  for (let i = 0; samples.length < 4 && i < 4; i += 1) for (const g of group) if (g.samples[i] && samples.length < 4) samples.push(g.samples[i]!)
  return {
    path,
    name: basename(path) || path,
    images: group.reduce((s, g) => s + g.images, 0),
    bytes: group.reduce((s, g) => s + g.bytes, 0),
    folders,
    samples,
    newest: Math.max(...group.map((g) => g.newest)),
    inAtlas: inAtlas(path)
  }
}

/** Walks the chosen drives and folders. Cancel with the signal; it stops promptly. */
export async function discover(
  options: DiscoveryOptions,
  signal: AbortSignal,
  onProgress: (progress: DiscoveryProgress) => void,
  inAtlas: (path: string) => boolean = () => false
): Promise<{ collections: DiscoveredCollection[]; scannedFolders: number; skippedFolders: number; cancelled: boolean }> {
  const excludedNames = new Set(DEFAULT_EXCLUDED_NAMES.map((n) => n.toLowerCase()))
  for (const name of options.includeNames ?? []) excludedNames.delete(name.toLowerCase())
  const excludedPaths = options.excludePaths.map(norm)
  const findings: FolderFinding[] = []
  let scanned = 0
  let skipped = 0
  let found = 0
  let lastEmit = 0
  let current = ''
  const minImages = Math.max(1, options.minImages)
  const emit = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastEmit < 150) return
    lastEmit = now
    onProgress({ scannedFolders: scanned, skippedFolders: skipped, imagesFound: found, collectionsFound: findings.length, current })
  }

  const queue: string[] = [...options.roots]
  const maxFolders = 400_000
  while (queue.length > 0 && !signal.aborted && scanned < maxFolders) {
    const dir = queue.pop()!
    current = dir
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      skipped += 1
      continue
    }
    scanned += 1
    const files = entries.filter((e) => e.isFile())
    // Software folders: skip the whole subtree, whatever pictures are in it.
    const lowerNames = new Set(files.map((f) => f.name.toLowerCase()))
    const softwareFiles = files.filter((f) => SOFTWARE_EXT.has(extOf(f.name))).length
    if (SOFTWARE_MARKERS.some((m) => lowerNames.has(m)) || softwareFiles >= 3) {
      skipped += 1
      continue
    }
    const pictures = files.filter((f) => IMAGE_EXT.has(extOf(f.name)))
    if (pictures.length >= minImages) {
      let bytes = 0
      let newest = 0
      let big = 0
      const bigOnes: string[] = []
      for (const file of pictures) {
        const full = join(dir, file.name)
        try {
          const stat = await fs.stat(full)
          if (stat.size < MIN_BYTES) continue
          big += 1
          bytes += stat.size
          newest = Math.max(newest, stat.mtimeMs)
          if (bigOnes.length < 12) bigOnes.push(full)
        } catch {
          // The file vanished while scanning.
        }
      }
      if (big >= minImages) {
        // Sample a few evenly, then drop pictures that are tiny (icons and thumbnails) after a quick look at their size.
        const samples: string[] = []
        for (const path of bigOnes) {
          if (samples.length >= 4) break
          try {
            const meta = await sharp(path, { failOn: 'none' }).metadata()
            if (Math.min(meta.width ?? 0, meta.height ?? 0) >= 300) samples.push(path)
          } catch {
            // Unreadable: not a useful sample.
          }
        }
        if (samples.length > 0) {
          findings.push({ path: dir, images: big, bytes, samples, newest })
          found += big
        }
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (isExcluded(full, excludedNames, excludedPaths)) {
        skipped += 1
        continue
      }
      queue.push(full)
    }
    emit()
    // Let the interface breathe on very large drives.
    if (scanned % 40 === 0) await new Promise((r) => setImmediate(r))
  }
  emit(true)
  return { collections: groupCollections(findings, inAtlas), scannedFolders: scanned, skippedFolders: skipped, cancelled: signal.aborted }
}

const extOf = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i).toLowerCase()
}

/** Small previews of a few pictures, made in memory from read-only files, so a collection can be judged before indexing. */
export async function previewSamples(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of paths.slice(0, 6)) {
    try {
      const buffer = await sharp(path, { failOn: 'none' }).rotate().resize(220, 160, { fit: 'cover' }).jpeg({ quality: 72 }).toBuffer()
      out.push(`data:image/jpeg;base64,${buffer.toString('base64')}`)
    } catch {
      // Skip pictures that cannot be read.
    }
  }
  return out
}
