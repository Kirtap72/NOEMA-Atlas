/** Reads which model files a ComfyUI installation has, straight from its folders. Read-only. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export type ModelCategory = 'checkpoints' | 'diffusion' | 'vae' | 'textEncoders' | 'loras' | 'controlnet' | 'upscale'

/** ComfyUI's own folder names for each kind of model. */
export const MODEL_FOLDERS: Record<ModelCategory, string[]> = {
  checkpoints: ['checkpoints'],
  diffusion: ['diffusion_models', 'unet'],
  vae: ['vae'],
  textEncoders: ['text_encoders', 'clip'],
  loras: ['loras'],
  controlnet: ['controlnet'],
  upscale: ['upscale_models']
}

export const CATEGORY_LABEL: Record<ModelCategory, string> = {
  checkpoints: 'checkpoints',
  diffusion: 'diffusion models',
  vae: 'VAE files',
  textEncoders: 'text encoders',
  loras: 'LoRAs',
  controlnet: 'ControlNets',
  upscale: 'upscale models'
}

const MODEL_EXTENSIONS = /\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i
const MAX_FILES = 20_000
const MAX_DEPTH = 4

export interface ModelInventory {
  byCategory: Record<ModelCategory, string[]>
  total: number
  /** The folders that were searched. */
  folders: string[]
  /** Kinds of model recognised from file names, for a one-line summary ("Flux, SDXL"). */
  families: string[]
}

/** A small reader for ComfyUI's extra_model_paths.yaml: `section:` then `key: value` or `key: |` followed by lines. */
export function parseExtraPaths(text: string, configFolder: string): Array<{ base: string | null; paths: Partial<Record<string, string[]>> }> {
  const sections: Array<{ base: string | null; paths: Partial<Record<string, string[]>> }> = []
  let current: { base: string | null; paths: Partial<Record<string, string[]>> } | null = null
  let block: { key: string; indent: number } | null = null
  const unquote = (value: string): string => value.replace(/^["']|["']$/g, '').trim()
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || raw.trim() === '') continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    // Lines of a `key: |` block belong to that key, even when they contain a colon (C:\models).
    if (block && indent > block.indent && current) {
      current.paths[block.key]!.push(unquote(line))
      continue
    }
    block = null
    if (indent === 0 && /^[\w.-]+:\s*$/.test(line)) {
      current = { base: null, paths: {} }
      sections.push(current)
      continue
    }
    if (!current) continue
    const pair = /^([\w.-]+):\s*(.*)$/.exec(line)
    if (!pair) continue
    const key = pair[1]!
    const value = unquote(pair[2]!)
    if (value === '|' || value === '>') {
      block = { key, indent }
      current.paths[key] = []
    } else if (key === 'base_path') current.base = value
    else if (value) current.paths[key] = [value]
  }
  const resolvePath = (value: string, base: string | null): string => (isAbsolute(value) ? value : resolve(base ?? configFolder, value))
  return sections.map((section) => ({
    base: section.base ? resolvePath(section.base, configFolder) : null,
    paths: Object.fromEntries(Object.entries(section.paths).map(([key, list]) => [key, (list ?? []).map((v) => resolvePath(v, section.base ? resolvePath(section.base, configFolder) : configFolder))]))
  }))
}

function walk(folder: string, out: string[], base: string, depth: number): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    const full = join(folder, entry.name)
    if (entry.isDirectory()) walk(full, out, base, depth + 1)
    else if (MODEL_EXTENSIONS.test(entry.name)) out.push(full.slice(base.length + 1).replace(/\\/g, '/'))
  }
}

const FAMILIES: Array<[RegExp, string]> = [
  [/flux[._-]?2|flux2/i, 'Flux 2'],
  [/flux/i, 'Flux'],
  [/qwen/i, 'Qwen-Image'],
  [/sd3|stable[ _-]?diffusion[ _-]?3/i, 'Stable Diffusion 3'],
  [/sdxl|xl[_-]?(?:base|refiner|1\.0)|juggernaut|pony/i, 'SDXL'],
  [/v1-5|sd[ _-]?1\.?5|sd15|dreamshaper|realisticvision/i, 'Stable Diffusion 1.5'],
  [/wan[_ .-]?2|wan2/i, 'Wan video'],
  [/ltx/i, 'LTX video'],
  [/hunyuan/i, 'HunyuanVideo'],
  [/hidream/i, 'HiDream'],
  [/z[_-]?image/i, 'Z-Image']
]

export function familiesOf(names: string[]): string[] {
  const found = new Set<string>()
  for (const name of names) for (const [pattern, label] of FAMILIES) if (pattern.test(name)) {
    found.add(label)
    break
  }
  return Array.from(found)
}

/** Every model file in the model folders of an installation, grouped by kind. */
export function scanModels(options: { dataFolder: string; extraConfigs?: string[] }): ModelInventory {
  const byCategory = Object.fromEntries((Object.keys(MODEL_FOLDERS) as ModelCategory[]).map((c) => [c, [] as string[]])) as Record<ModelCategory, string[]>
  const roots = new Map<string, string>() // folder -> category
  const searched = new Set<string>()
  const consider = (folder: string, category: ModelCategory): void => {
    const key = folder.toLowerCase()
    if (!roots.has(key) && existsSync(folder)) roots.set(key, `${category}|${folder}`)
  }
  for (const [category, names] of Object.entries(MODEL_FOLDERS) as Array<[ModelCategory, string[]]>) {
    for (const name of names) consider(join(options.dataFolder, 'models', name), category)
  }
  for (const file of options.extraConfigs ?? []) {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const section of parseExtraPaths(text, dirname(file))) {
      for (const [category, names] of Object.entries(MODEL_FOLDERS) as Array<[ModelCategory, string[]]>) {
        for (const name of names) {
          for (const path of section.paths[name] ?? []) consider(path, category)
          if (section.base) consider(join(section.base, 'models', name), category)
        }
      }
    }
  }
  const seen = new Set<string>()
  for (const entry of roots.values()) {
    const [category, folder] = entry.split('|') as [ModelCategory, string]
    try {
      if (!statSync(folder).isDirectory()) continue
    } catch {
      continue
    }
    searched.add(folder)
    const files: string[] = []
    walk(folder, files, folder, 0)
    for (const file of files) {
      const key = `${category}|${file.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      byCategory[category].push(file)
    }
  }
  for (const list of Object.values(byCategory)) list.sort((a, b) => a.localeCompare(b))
  const total = Object.values(byCategory).reduce((n, list) => n + list.length, 0)
  return { byCategory, total, folders: Array.from(searched), families: familiesOf([...byCategory.checkpoints, ...byCategory.diffusion]) }
}

/** True when a model file (by name, with or without a sub-folder) exists in any category folder that can hold it. */
export function hasModel(inventory: ModelInventory, name: string, categories?: ModelCategory[]): boolean {
  const wanted = name.replace(/\\/g, '/').toLowerCase()
  const short = wanted.split('/').pop()!
  for (const category of categories ?? (Object.keys(inventory.byCategory) as ModelCategory[])) {
    for (const file of inventory.byCategory[category]) {
      const f = file.toLowerCase()
      if (f === wanted || f.split('/').pop() === short) return true
    }
  }
  return false
}
