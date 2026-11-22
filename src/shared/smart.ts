/**
 * Smart Collections: a collection defined by a description of how images look, not by a list of files.
 * Everything here is plain data and pure functions, shared by the main process (matching) and the window (editing).
 */
import type { ImageItem } from './types'

export type ColourId = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink' | 'warm' | 'cool'
export type ToneId = 'any' | 'dark' | 'bright'
export type VividnessId = 'any' | 'vivid' | 'muted' | 'mono'
export type ShapeId = 'any' | 'portrait' | 'landscape' | 'square'

export const COLOUR_OPTIONS: Array<{ id: ColourId; label: string; swatch: string }> = [
  { id: 'red', label: 'Red', swatch: '#c2453b' },
  { id: 'orange', label: 'Orange', swatch: '#d9833a' },
  { id: 'yellow', label: 'Yellow', swatch: '#d8b948' },
  { id: 'green', label: 'Green', swatch: '#5f9a5b' },
  { id: 'teal', label: 'Teal', swatch: '#2f9a96' },
  { id: 'blue', label: 'Blue', swatch: '#3f6fb5' },
  { id: 'purple', label: 'Purple', swatch: '#7d5aa8' },
  { id: 'pink', label: 'Pink', swatch: '#cf6f9a' },
  { id: 'warm', label: 'Warm tones', swatch: 'linear-gradient(135deg,#c2453b,#d9833a,#d8b948)' },
  { id: 'cool', label: 'Cool tones', swatch: 'linear-gradient(135deg,#5f9a5b,#2f9a96,#3f6fb5)' }
]

export const TONE_OPTIONS: Array<{ id: ToneId; label: string }> = [
  { id: 'any', label: 'Any light' },
  { id: 'dark', label: 'Dark' },
  { id: 'bright', label: 'Bright' }
]

export const VIVIDNESS_OPTIONS: Array<{ id: VividnessId; label: string }> = [
  { id: 'any', label: 'Any colour strength' },
  { id: 'vivid', label: 'Vivid' },
  { id: 'muted', label: 'Muted' },
  { id: 'mono', label: 'Black and white' }
]

export const SHAPE_OPTIONS: Array<{ id: ShapeId; label: string }> = [
  { id: 'any', label: 'Any shape' },
  { id: 'portrait', label: 'Upright' },
  { id: 'landscape', label: 'Wide' },
  { id: 'square', label: 'Square' }
]

export interface SmartCriteria {
  /** What the images look like, in the user's own words. Matched by the local image model. */
  text: string
  /** Things the images must not look like (optional). */
  avoid: string
  /** Colours to measure in the pixels, in addition to the description. */
  colours: ColourId[]
  tone: ToneId
  vividness: VividnessId
  shape: ShapeId
  /** Images the user pinned with "more like this": always in the collection, and they steer the match. */
  likes: string[]
  /** Images the user ruled out with "not like this": never in the collection, and they steer the match away. */
  dislikes: string[]
  /** 0 (relaxed, many results) to 100 (strict, only the closest). */
  strictness: number
}

export const DEFAULT_STRICTNESS = 50

export function emptyCriteria(): SmartCriteria {
  return { text: '', avoid: '', colours: [], tone: 'any', vividness: 'any', shape: 'any', likes: [], dislikes: [], strictness: DEFAULT_STRICTNESS }
}

const COLOUR_IDS = new Set<string>(COLOUR_OPTIONS.map((option) => option.id))

/** Cleans anything that arrives from outside (the window, a saved file) into valid criteria. */
export function normalizeCriteria(input: unknown): SmartCriteria {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '')
  const ids = (value: unknown, max: number): string[] =>
    Array.isArray(value) ? Array.from(new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length < 80))).slice(0, max) : []
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback)
  const strictness = Number.isFinite(raw.strictness) ? Math.max(0, Math.min(100, Math.round(Number(raw.strictness)))) : DEFAULT_STRICTNESS
  const dislikes = ids(raw.dislikes, 300)
  return {
    text: text(raw.text, 240),
    avoid: text(raw.avoid, 160),
    colours: ids(raw.colours, 4).filter((id): id is ColourId => COLOUR_IDS.has(id)),
    tone: pick(raw.tone, ['any', 'dark', 'bright'] as const, 'any'),
    vividness: pick(raw.vividness, ['any', 'vivid', 'muted', 'mono'] as const, 'any'),
    shape: pick(raw.shape, ['any', 'portrait', 'landscape', 'square'] as const, 'any'),
    likes: ids(raw.likes, 300).filter((id) => !dislikes.includes(id)),
    dislikes,
    strictness
  }
}

/** True when the criteria say nothing that could match against (nothing typed, nothing chosen). */
export function criteriaAreEmpty(criteria: SmartCriteria): boolean {
  return (
    criteria.text === '' &&
    criteria.likes.length === 0 &&
    criteria.colours.length === 0 &&
    criteria.tone === 'any' &&
    criteria.vividness === 'any' &&
    criteria.shape === 'any'
  )
}

interface Detected {
  colours: ColourId[]
  tone: ToneId
  vividness: VividnessId
}

const COLOUR_WORDS: Array<[ColourId, string[]]> = [
  ['red', ['red', 'crimson', 'scarlet', 'burgundy', 'maroon']],
  ['orange', ['orange', 'amber', 'rust', 'copper']],
  ['yellow', ['yellow', 'mustard', 'lemon']],
  ['green', ['green', 'emerald', 'olive', 'moss', 'forest green']],
  ['teal', ['teal', 'turquoise', 'aqua', 'cyan']],
  ['blue', ['blue', 'navy', 'cobalt', 'azure', 'sapphire']],
  ['purple', ['purple', 'violet', 'lavender', 'lilac', 'plum']],
  ['pink', ['pink', 'magenta', 'rose', 'blush', 'fuchsia']],
  ['warm', ['warm', 'golden', 'sunset', 'sunlit', 'glowing']],
  ['cool', ['cool', 'cold', 'icy', 'frosty', 'wintry']]
]
const TONE_WORDS: Array<[ToneId, string[]]> = [
  ['dark', ['dark', 'night', 'nocturnal', 'noir', 'shadowy', 'low key', 'dim']],
  ['bright', ['bright', 'airy', 'high key', 'sunny', 'luminous', 'light and airy']]
]
const VIVIDNESS_WORDS: Array<[VividnessId, string[]]> = [
  ['mono', ['black and white', 'black white', 'monochrome', 'greyscale', 'grayscale', 'b&w', 'bw']],
  ['vivid', ['vivid', 'saturated', 'colourful', 'colorful', 'vibrant', 'neon']],
  ['muted', ['muted', 'pastel', 'faded', 'desaturated', 'washed out']]
]

function hasWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')
  return new RegExp(`(^|[^a-z])${escaped}(s|ed)?($|[^a-z])`).test(text)
}

/**
 * Reads the measurable words out of a description: "teal-toned surreal portraits" gives teal, "warm cinematic
 * interiors" gives warm tones. The window shows these as chips the user can remove, so nothing is hidden.
 * Words that only describe a feeling or a subject ("melancholic", "surreal", "portraits") stay with the image model.
 */
export function detectAesthetics(description: string): Detected {
  const text = ` ${description.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ')} `.replace(/ toned /g, ' ')
  const colours: ColourId[] = []
  for (const [id, words] of COLOUR_WORDS) if (words.some((word) => hasWord(text, word))) colours.push(id)
  let tone: ToneId = 'any'
  for (const [id, words] of TONE_WORDS) if (tone === 'any' && words.some((word) => hasWord(text, word))) tone = id
  let vividness: VividnessId = 'any'
  for (const [id, words] of VIVIDNESS_WORDS) if (vividness === 'any' && words.some((word) => hasWord(text, word))) vividness = id
  // "black and white" and "white" are not a colour to measure; "warm" with a named hue is just that hue.
  const narrowed = colours.filter((id) => !(id === 'warm' && colours.some((c) => ['red', 'orange', 'yellow'].includes(c))) && !(id === 'cool' && colours.some((c) => ['green', 'teal', 'blue', 'purple'].includes(c))))
  return { colours: narrowed.slice(0, 3), tone, vividness }
}

/**
 * The part of the description left for the image model. Words that are measured in the pixels (a colour, dark,
 * black and white) are taken out: "teal-toned landscapes" is matched as "landscapes" plus measured teal, because the
 * pixels know for certain whether a picture is teal and the model only guesses. A word whose chip was switched off
 * stays in the description.
 */
export function semanticText(criteria: SmartCriteria): string {
  let text = ` ${criteria.text.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ')} `.replace(/ toned /g, ' ')
  const words: string[] = []
  for (const [id, list] of COLOUR_WORDS) if (criteria.colours.includes(id)) words.push(...list)
  for (const [id, list] of TONE_WORDS) if (criteria.tone === id) words.push(...list)
  for (const [id, list] of VIVIDNESS_WORDS) if (criteria.vividness === id) words.push(...list)
  // Longest first, so "black and white" goes before "white".
  for (const word of words.sort((a, b) => b.length - a.length)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')
    text = text.replace(new RegExp(`(^|[^a-z])${escaped}(s|ed)?(?=$|[^a-z])`, 'g'), '$1 ')
  }
  return text.replace(/\s+/g, ' ').replace(/^(and|with|in|of|the|a)\s+/, '').trim()
}

/** What a collection looks for, in one plain line, for lists and for the assistant. */
export function summarizeCriteria(criteria: SmartCriteria): string {
  const parts: string[] = []
  if (criteria.text) parts.push(`“${criteria.text}”`)
  const measured: string[] = []
  for (const colour of criteria.colours) measured.push(COLOUR_OPTIONS.find((option) => option.id === colour)?.label.toLowerCase() ?? colour)
  if (criteria.tone !== 'any') measured.push(`${criteria.tone} tone`)
  if (criteria.vividness !== 'any') measured.push(criteria.vividness === 'mono' ? 'black and white' : `${criteria.vividness} colour`)
  if (measured.length) parts.push(`measured: ${measured.join(', ')}`)
  if (criteria.shape !== 'any') parts.push(`${criteria.shape} shape`)
  if (criteria.avoid) parts.push(`not like “${criteria.avoid}”`)
  if (criteria.likes.length) parts.push(`${criteria.likes.length} pinned`)
  if (criteria.dislikes.length) parts.push(`${criteria.dislikes.length} ruled out`)
  return `${parts.join('; ') || 'no description'} (${strictnessWord(criteria.strictness).toLowerCase()})`
}

/** How the matching treats the strictness slider, in words for the window. */
export function strictnessWord(strictness: number): string {
  if (strictness <= 20) return 'Very relaxed: lots of loosely related images'
  if (strictness <= 40) return 'Relaxed: a wide net'
  if (strictness <= 60) return 'Balanced'
  if (strictness <= 80) return 'Strict: close matches'
  return 'Very strict: only the closest matches'
}

export interface SmartCollection {
  id: string
  name: string
  criteria: SmartCriteria
  createdAt: number
  updatedAt: number
  /** How many images match right now. */
  size: number
  /** Images that joined after the collection was last opened. */
  newCount: number
  /** Up to three images shown on the card, best matches first. */
  covers: ImageItem[]
  /** When the matches were last worked out. */
  refreshedAt: number | null
}

export interface SmartPreview {
  /** The best matches in this page, with how well each fits (0 to 100). */
  items: Array<ImageItem & { match: number }>
  total: number
  offset: number
  limit: number
  /** What the matching did, in plain words, for display above the results. */
  explanation: string
  /** False when the description needs the image model and it is not available; colour and shape still work. */
  semantic: boolean
  /** Why nothing was matched, if that is the case. */
  problem: string | null
}

export interface SmartCollectionInput {
  name: string
  criteria: SmartCriteria
}
