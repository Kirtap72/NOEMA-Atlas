import { CATEGORIES, filesFor, requirementsFor, totalBytes, type CatalogEntry, type CategoryId, type Requirements } from './catalog'
import type { HardwareProfile } from './hardware'

// Whether a model suits a computer, and why. Rules, not guesses: each answer names the requirement that decided it, and a model
// is only called recommended when the computer has the memory it is comfortable in. Speed claims come only from tests that were
// actually run (listed in the entry), never from the requirements.

import { FIT_LABEL, type Fit, type FitLevel } from '../../shared/modelLibrary'
export * from '../../shared/modelLibrary'
const RANK: Record<FitLevel, number> = { recommended: 4, works: 3, slow: 2, 'too-big': 1, incompatible: 0 }

function memoryWords(p: HardwareProfile): string {
  return p.modelMemoryGB === null ? 'no usable graphics memory' : p.primary?.memoryKind === 'unified' ? `${p.modelMemoryGB} GB of unified memory available to models` : `${p.modelMemoryGB} GB of graphics memory`
}

/** Whether a test's hardware description is this kind of computer (same graphics card model). */
export function testedOn(entry: CatalogEntry, p: HardwareProfile): CatalogEntry['verification']['checks'] {
  const gpu = p.primary?.name.toLowerCase() ?? ''
  const model = /(rtx|gtx)\s*(\d{3,4})/i.exec(gpu)
  const spark = /spark|gb10/i.test(gpu)
  return entry.verification.checks.filter((c) => {
    const h = c.hardware.toLowerCase()
    if (p.simulated) return false
    if (spark) return /spark|gb10/.test(h)
    return model ? h.includes(`${model[1]!.toLowerCase()} ${model[2]}`) || h.includes(`${model[1]!.toLowerCase()}${model[2]}`) : false
  })
}

function assessOne(entry: CatalogEntry, reqs: Requirements, p: HardwareProfile, bytes: number): { level: FitLevel; reasons: string[] } {
  const reasons: string[] = []
  const gpu = p.primary
  if (reqs.os && reqs.os.length > 0 && !reqs.os.includes(p.os.platform)) return { level: 'incompatible', reasons: [`Built for ${reqs.os.join(' or ')}, and this computer runs ${p.os.platform}.`] }
  // The model files themselves do not care about the processor; the runtime that loads them does. On another architecture the
  // model can still be used through a ComfyUI set up by the official instructions, but nothing here has been tested that way.
  const archCaveat = entry.runtime === 'comfyui' && reqs.archs && reqs.archs.length > 0 && !reqs.archs.includes(p.arch === 'other' ? 'x64' : p.arch)
  if (entry.runtime === 'comfyui' && !gpu) return { level: 'incompatible', reasons: ['This kind of model needs a graphics card, and none was found.'] }
  if (reqs.gpuFamilies && reqs.gpuFamilies.length > 0 && gpu && !reqs.gpuFamilies.includes(gpu.family)) {
    return { level: 'incompatible', reasons: [`Needs ${reqs.gpuFamilies.includes('blackwell') ? 'an RTX 50-series (Blackwell) card' : `a ${reqs.gpuFamilies.join(' or ')} graphics card`}; this one is ${gpu.series ?? gpu.name}.`] }
  }
  if (reqs.precision && gpu && !p.precisions[reqs.precision]) {
    if (reqs.precision === 'fp16') return { level: 'incompatible', reasons: ['Needs half-precision maths, which this card does not have.'] }
    return { level: 'incompatible', reasons: [`Needs ${reqs.precision.toUpperCase()} maths in hardware, which this card does not have.`] }
  }
  const mem = p.modelMemoryGB
  const min = reqs.minMemoryGB ?? 0
  const rec = reqs.recommendedMemoryGB ?? min
  let level: FitLevel
  if (entry.runtime !== 'comfyui' && mem === null) {
    // Language models can run on the processor, slowly.
    level = p.ramGB >= Math.max(rec, min) + 4 ? 'slow' : 'too-big'
    reasons.push(level === 'slow' ? 'No graphics card was found, so it would run on the processor.' : 'Not enough memory to run it on the processor.')
  } else if (mem === null) {
    level = 'incompatible'
  } else if (mem >= rec * 0.95) {
    // Cards report slightly less than their nominal size (a 16 GB card shows 15.9), so a small tolerance is applied.
    level = 'recommended'
    reasons.push(`${memoryWords(p)}, more than the ${rec || 'minimum'} GB it is comfortable in.`)
  } else if (mem >= min * 0.95) {
    level = rec > min && mem < (min + rec) / 2 ? 'slow' : 'works'
    reasons.push(`${memoryWords(p)}; it needs at least ${min} GB and is comfortable with ${rec} GB.${level === 'slow' ? ' Parts of it will be moved between graphics and system memory.' : ''}`)
  } else if (entry.runtime === 'comfyui' && mem >= 4 && p.ramGB * 0.7 >= bytes / 1024 ** 3 + 4 && p.primary?.memoryKind === 'dedicated') {
    level = 'slow'
    reasons.push(`It needs ${min} GB and this card has ${mem} GB, so most of it would sit in system memory (${p.ramGB} GB) and run slowly.`)
  } else {
    level = 'too-big'
    reasons.push(`It needs at least ${min} GB and this computer has ${memoryWords(p)}.`)
  }
  if (archCaveat) {
    reasons.push(`Atlas’s own setup for this model is built for ${reqs.archs!.join(' or ')} computers and this one is ${p.arch}. The model can still run in a ComfyUI that you set up with the official instructions for ${p.arch}, but Atlas has not tested that.`)
    if (level === 'recommended') level = 'works'
  }
  if (reqs.precision === 'bf16' && gpu && !p.precisions.bf16) reasons.push('This card has no native bf16, so it is computed in a slower way.')
  if (gpu && gpu.family === 'turing' && bytes > 6 * 1024 ** 3 && level !== 'too-big') reasons.push('Cards of the RTX 20 generation compute large models more slowly than newer ones.')
  if (p.runtime.managedComfy === 'unsupported' && entry.runtime === 'comfyui') reasons.push('Atlas cannot install ComfyUI on this computer itself; connect a ComfyUI that is running (see the instructions).')
  return { level, reasons }
}

/** How well an entry suits a computer, choosing the best build among its variants. */
export function assess(entry: CatalogEntry, p: HardwareProfile): Fit {
  const options: Array<{ id: string | null; label: string | null; result: ReturnType<typeof assessOne>; bytes: number }> = []
  if (entry.variants?.length) {
    for (const v of entry.variants) {
      const bytes = totalBytes(v.files)
      options.push({ id: v.id, label: v.label, result: assessOne(entry, requirementsFor(entry, v.id), p, bytes), bytes })
    }
  } else {
    const bytes = totalBytes(filesFor(entry)) || entry.install.approxBytes || 0
    options.push({ id: null, label: null, result: assessOne(entry, requirementsFor(entry), p, bytes), bytes })
  }
  options.sort((a, b) => RANK[b.result.level] - RANK[a.result.level] || a.bytes - b.bytes)
  const best = options[0]!
  const tests = testedOn(entry, p)
  return {
    level: best.result.level,
    label: FIT_LABEL[best.result.level],
    variant: best.id,
    variantLabel: best.label,
    reasons: best.result.reasons,
    testedHere: tests.length > 0,
    testedNote: tests.length > 0 ? tests.map((t) => `${t.result} (${t.hardware}, ${t.date})`).join('; ') : null
  }
}

// ---- recommending --------------------------------------------------------------------------------------------------------------

export function categoriesForTask(text: string): CategoryId[] {
  const t = text.toLowerCase()
  const out: CategoryId[] = []
  const has = (re: RegExp): boolean => re.test(t)
  if (has(/photo\w*|realis\w*|portrait|lifelike|camera/)) out.push('photoreal')
  if (has(/surreal|painterly|painting|artistic|stylis\w+|illustrat\w+|dream/)) out.push('artistic')
  if (has(/edit|inpaint|remove|retouch|change|repair|replace|extend/)) out.push('editing')
  if (has(/reference|moodboard|my pictures|these pictures|style of|composition of|use .{0,20}images?/)) out.push('reference')
  if (has(/upscal\w+|enlarg\w+|sharpen|detail|resolution|4k|8k/)) out.push('upscaling')
  if (has(/look at|describe|understand|vision|caption|analy[sz]e|search my|find pictures/)) out.push('understanding')
  if (out.length === 0 || has(/generat\w+|create|make|new picture|text to image/)) out.push('generation')
  return Array.from(new Set(out))
}

export interface Preferences {
  /** Results will be used commercially: leave out non-commercial licences. */
  commercial?: boolean
  /** Do not suggest anything larger than this download. */
  maxDownloadGB?: number
  /** Only models that run on this computer. */
  localOnly?: boolean
  /** Prefer tested models over documented ones. Default true. */
  preferVerified?: boolean
}

export interface Recommendation {
  entry: CatalogEntry
  fit: Fit
  score: number
  why: string[]
  installed: boolean
}

export function recommend(entries: CatalogEntry[], p: HardwareProfile, ask: { categories?: CategoryId[]; provides?: string[]; preferences?: Preferences }, installedIds: Set<string> = new Set()): Recommendation[] {
  const prefs = ask.preferences ?? {}
  const out: Recommendation[] = []
  for (const entry of entries) {
    if (ask.categories?.length && !entry.categories.some((c) => ask.categories!.includes(c))) continue
    if (ask.provides?.length && !entry.provides.some((x) => ask.provides!.includes(x))) continue
    if (prefs.commercial && entry.licence.commercialUse === 'no') continue
    const fit = assess(entry, p)
    if (fit.level === 'incompatible' || fit.level === 'too-big') continue
    const files = filesFor(entry, fit.variant)
    const bytes = totalBytes(files) || entry.install.approxBytes || 0
    if (prefs.maxDownloadGB !== undefined && bytes / 1e9 > prefs.maxDownloadGB && !installedIds.has(entry.id)) continue
    const why: string[] = [fit.label]
    let score = RANK[fit.level] * 10
    const verified = entry.verification.status
    if (verified === 'verified') { score += 8; why.push('tested and verified') } else if (verified === 'documented') { score += 3; why.push('documented, not tested by Atlas') } else why.push('experimental')
    if (prefs.preferVerified === false) score -= verified === 'verified' ? 8 : 0
    if (fit.testedHere) { score += 6; why.push('tested on this kind of graphics card') }
    if (installedIds.has(entry.id)) { score += 4; why.push('already installed') }
    if (entry.licence.commercialUse === 'yes') score += 1
    score -= Math.min(4, bytes / 1e9 / 10)
    if (fit.variantLabel) why.push(`best build: ${fit.variantLabel}`)
    out.push({ entry, fit, score, why, installed: installedIds.has(entry.id) })
  }
  return out.sort((a, b) => b.score - a.score)
}

export const CATEGORY_IDS = Object.keys(CATEGORIES) as CategoryId[]
