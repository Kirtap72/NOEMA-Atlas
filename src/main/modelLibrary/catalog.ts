import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The AI Model Library catalogue: what models and workflows exist, where they officially come from, what they need and what has
// actually been tested. It is DATA, not code: every entry is a small JSON file (src/main/modelLibrary/catalog/*.json, built in) and
// more can be added without changing the application by putting .json files into the `model-library` folder of Atlas's data
// folder (a file may hold one entry or a list; an entry with an existing id replaces the built-in one). Entries are validated
// when they are read; a damaged or incomplete entry is skipped and reported, never trusted.

export * from '../../shared/modelLibrary'
import { CATALOG_SCHEMA, CATEGORIES, type CatalogEntry, type CatalogFile, type CategoryId, type Provides, type Requirements, type Variant, type Verification } from '../../shared/modelLibrary'
void CATEGORIES
void ({} as Provides)
void ({} as Verification)

// ---- validation ---------------------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/
const SHA = /^[0-9a-f]{64}$/
const SAFE_NAME = /^[^\\/:*?"<>|\0]+$/
const FOLDERS = new Set(['checkpoints', 'diffusion_models', 'unet', 'vae', 'text_encoders', 'clip', 'loras', 'controlnet', 'upscale_models', 'clip_vision', 'style_models', 'embeddings', 'model_patches'])

/** Tests may allow files served from this computer; real entries are always https. */
export interface ValidateOptions {
  allowLocalHttp?: boolean
}

function checkFile(f: unknown, where: string, errors: string[], opts: ValidateOptions = {}): CatalogFile | null {
  if (!isObject(f)) {
    errors.push(`${where}: not an object`)
    return null
  }
  const problems: string[] = []
  if (!str(f.key) || !ID.test(f.key)) problems.push('key')
  if (!str(f.name) || !SAFE_NAME.test(f.name) || f.name.startsWith('.')) problems.push('name')
  if (!str(f.folder) || !FOLDERS.has(f.folder)) problems.push('folder')
  if (!str(f.url) || !(/^https:\/\//.test(f.url) || (opts.allowLocalHttp && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(f.url)))) problems.push('url (https only)')
  if (!num(f.bytes) || f.bytes <= 0) problems.push('bytes')
  if (!str(f.sha256) || !SHA.test(f.sha256)) problems.push('sha256 (64 hex characters)')
  if (problems.length) {
    errors.push(`${where}: ${problems.join(', ')}`)
    return null
  }
  return f as unknown as CatalogFile
}

/** Checks one entry as it was read from a file. Returns the entry, or why it was refused. */
export function validateEntry(raw: unknown, origin = 'entry', opts: ValidateOptions = {}): { entry: CatalogEntry | null; errors: string[] } {
  const errors: string[] = []
  if (!isObject(raw)) return { entry: null, errors: [`${origin}: not an object`] }
  const id = raw.id
  const label = `${origin} (${typeof id === 'string' ? id : '?'})`
  if (raw.schema !== CATALOG_SCHEMA) errors.push(`${label}: schema must be ${CATALOG_SCHEMA}`)
  if (!str(id) || !ID.test(id)) errors.push(`${label}: id must be lowercase letters, digits, dots, dashes`)
  for (const k of ['name', 'summary', 'details', 'version'] as const) if (!str(raw[k])) errors.push(`${label}: ${k} is required`)
  const categories = Array.isArray(raw.categories) ? raw.categories.filter((c): c is CategoryId => typeof c === 'string' && c in CATEGORIES) : []
  if (categories.length === 0) errors.push(`${label}: at least one known category is required`)
  if (!['comfyui', 'ollama', 'atlas-onnx'].includes(String(raw.runtime))) errors.push(`${label}: runtime must be comfyui, ollama or atlas-onnx`)
  const source = raw.source
  if (!isObject(source) || !str(source.name) || !str(source.url) || !/^https:\/\//.test(String(source.url))) errors.push(`${label}: the official source (name and https url) is required`)
  const licence = raw.licence
  if (!isObject(licence) || !str(licence.name) || !str(licence.url) || !str(licence.summary) || !['yes', 'conditions', 'no'].includes(String(licence.commercialUse))) errors.push(`${label}: licence needs name, url, summary and commercialUse`)
  const verification = raw.verification
  if (!isObject(verification) || !['verified', 'documented', 'experimental'].includes(String(verification.status))) errors.push(`${label}: verification.status must be verified, documented or experimental`)
  else if (verification.status === 'verified' && !(Array.isArray(verification.checks) && verification.checks.length > 0)) errors.push(`${label}: a verified entry must list the tests it passed`)
  const install = raw.install
  if (!isObject(install) || !['managed', 'manual', 'ollama', 'atlas'].includes(String(install.mode))) errors.push(`${label}: install.mode must be managed, manual, ollama or atlas`)
  const files: CatalogFile[] = []
  for (const [i, f] of (Array.isArray(raw.files) ? raw.files : []).entries()) {
    const ok = checkFile(f, `${label}: files[${i}]`, errors, opts)
    if (ok) files.push(ok)
  }
  const variants: Variant[] = []
  if (raw.variants !== undefined) {
    for (const [i, v] of (Array.isArray(raw.variants) ? raw.variants : []).entries()) {
      if (!isObject(v) || !str(v.id) || !str(v.label)) {
        errors.push(`${label}: variants[${i}] needs id and label`)
        continue
      }
      const vf: CatalogFile[] = []
      for (const [j, f] of (Array.isArray(v.files) ? v.files : []).entries()) {
        const ok = checkFile(f, `${label}: variants[${i}].files[${j}]`, errors, opts)
        if (ok) vf.push(ok)
      }
      variants.push({ id: v.id as string, label: v.label as string, files: vf, requirements: isObject(v.requirements) ? (v.requirements as Partial<Requirements>) : undefined, note: typeof v.note === 'string' ? v.note : undefined })
    }
  }
  const keys = new Set<string>()
  for (const f of [...files, ...variants.flatMap((v) => v.files)]) {
    const id2 = `${f.folder}/${f.name}`
    if (keys.has(`k:${f.key}`) && !variants.length) errors.push(`${label}: duplicate file key ${f.key}`)
    keys.add(`k:${f.key}`)
    void id2
  }
  const needsFiles = isObject(install) && (install.mode === 'managed')
  if (needsFiles && files.length === 0 && variants.length === 0) errors.push(`${label}: a managed entry must list its files`)
  if (isObject(install) && install.mode === 'manual' && !(Array.isArray(install.instructions) && install.instructions.length > 0)) errors.push(`${label}: a manual entry must give instructions`)
  if (isObject(install) && install.mode === 'ollama' && !str(install.pullName)) errors.push(`${label}: an ollama entry needs the model name to pull`)
  if (errors.length) return { entry: null, errors }
  const r = raw as unknown as CatalogEntry
  return {
    entry: {
      ...r,
      categories,
      capabilities: Array.isArray(r.capabilities) ? r.capabilities.filter((c) => isObject(c) && str((c as { id: unknown }).id)) : [],
      files,
      variants: variants.length ? variants : undefined,
      requirements: isObject(r.requirements) ? r.requirements : {},
      dependsOn: Array.isArray(r.dependsOn) ? r.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      workflows: Array.isArray(r.workflows) ? r.workflows : [],
      provides: Array.isArray(r.provides) ? r.provides : [],
      verification: { ...r.verification, checks: Array.isArray(r.verification.checks) ? r.verification.checks : [] }
    },
    errors: []
  }
}

// ---- loading --------------------------------------------------------------------------------------------------------------------------

export interface LoadedCatalog {
  entries: CatalogEntry[]
  /** Entries that were refused, with the reasons, so a person adding one can fix it. */
  problems: string[]
  /** Ids that came from the user's folder. */
  userIds: string[]
}

export function loadCatalog(builtIn: unknown[], userDir?: string | null, opts: ValidateOptions = {}): LoadedCatalog {
  const byId = new Map<string, CatalogEntry>()
  const problems: string[] = []
  const userIds: string[] = []
  const add = (raw: unknown, origin: string, user: boolean): void => {
    const { entry, errors } = validateEntry(raw, origin, user ? {} : opts)
    if (!entry) return void problems.push(...errors)
    if (user) userIds.push(entry.id)
    byId.set(entry.id, entry)
  }
  builtIn.forEach((raw, i) => add(raw, `built-in ${i + 1}`, false))
  if (userDir && existsSync(userDir)) {
    for (const name of readdirSync(userDir).filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
      try {
        const parsed = JSON.parse(readFileSync(join(userDir, name), 'utf8')) as unknown
        for (const [i, raw] of (Array.isArray(parsed) ? parsed : [parsed]).entries()) add(raw, `${name}${Array.isArray(parsed) ? `[${i}]` : ''}`, true)
      } catch {
        problems.push(`${name}: not valid JSON`)
      }
    }
  }
  // An entry that depends on something that is not in the catalogue cannot be installed completely.
  for (const e of byId.values()) for (const d of e.dependsOn) if (!byId.has(d)) problems.push(`${e.id}: depends on “${d}”, which is not in the catalogue`)
  return { entries: [...byId.values()].filter((e) => !e.deprecated), problems, userIds }
}

/** The files to install for an entry: those of the chosen variant, or the entry's own. */
export function filesFor(entry: CatalogEntry, variantId?: string | null): CatalogFile[] {
  const variant = variantId ? entry.variants?.find((v) => v.id === variantId) : null
  return variant ? variant.files : entry.files
}

export function requirementsFor(entry: CatalogEntry, variantId?: string | null): Requirements {
  const variant = variantId ? entry.variants?.find((v) => v.id === variantId) : null
  return { ...entry.requirements, ...(variant?.requirements ?? {}) }
}

export const totalBytes = (files: CatalogFile[]): number => files.reduce((s, f) => s + f.bytes, 0)
