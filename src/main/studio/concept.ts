import type { ImageItem } from '../../shared/types'
import { ASPECTS, type ArtworkConcept, type AspectChoice, type ConceptRequest, type RefRole } from '../../shared/studio'

/** What the local image model sees in one picture, in everyday words. Empty when it is not available. */
export interface VisualNotes {
  subject?: string
  mood?: string
  style?: string
  colour?: string
}

const NAMED: Array<[string, number, number, number]> = [
  ['deep black', 12, 12, 14], ['charcoal', 54, 56, 60], ['slate grey', 110, 118, 128], ['silver', 190, 192, 196], ['ivory', 238, 232, 216],
  ['crimson', 170, 30, 50], ['rust', 160, 70, 40], ['burnt orange', 205, 100, 40], ['amber', 225, 160, 50], ['gold', 214, 178, 80],
  ['olive', 120, 120, 50], ['moss green', 80, 110, 60], ['emerald', 30, 140, 90], ['sage', 150, 170, 140], ['teal', 30, 120, 125],
  ['turquoise', 60, 180, 185], ['sky blue', 130, 175, 220], ['deep blue', 30, 55, 120], ['indigo', 60, 50, 130], ['violet', 120, 80, 160],
  ['rose', 215, 120, 150], ['dusty pink', 205, 160, 165], ['umber brown', 105, 75, 50], ['sand', 205, 185, 145], ['cream', 245, 235, 205]
]

/** Names a colour in words a person (or an image model) would use. */
export function colourName(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 'neutral'
  const n = parseInt(m[1]!, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  let best = NAMED[0]!
  let bestD = Infinity
  for (const c of NAMED) {
    const d = (c[1] - r) ** 2 + (c[2] - g) ** 2 + (c[3] - b) ** 2
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best[0]
}

export function aspectFor(width: number, height: number): AspectChoice {
  const ratio = width / Math.max(1, height)
  if (ratio > 1.55) return 'wide'
  if (ratio > 1.15) return 'landscape'
  if (ratio < 0.87) return 'portrait'
  return 'square'
}

const top = (values: Array<string | undefined>, count: number): string[] => {
  const tally = new Map<string, number>()
  for (const v of values) if (v) tally.set(v, (tally.get(v) ?? 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([k]) => k)
}

const VARIATIONS = [
  'seen at dusk, with long soft shadows',
  'wrapped in morning mist',
  'from a high, distant viewpoint',
  'under a dramatic, stormy sky',
  'in quiet, snow-covered stillness',
  'in the warm, low light just after sunrise'
]

const STOP = /^(create|make|paint|draw|generate|produce|design|build|give me|i want|i'd like|please|can you|could you|skapa|gör|måla)\b[\s,]*/i

/** Cleans the user's request so it reads as a subject, not as an instruction. */
function cleanIntent(text: string): string {
  let t = text.trim().replace(/\s+/g, ' ')
  t = t.replace(/\b(inspired by|based on|from|using|use|med)\b[^.]*\b(moodboard|board|images?|pictures?|mood board)\b[^.]*\.?/gi, ' ')
  t = t.replace(STOP, '').replace(/^(a|an|me a|me an|ett|en)\s+(new\s+)?/i, '').replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '')
  return t
}

/**
 * Reads a moodboard and what the user wants from it, and develops an artistic concept: a prompt, what to avoid, a
 * palette and a few directions to try. It works offline, from the colours and from the local image model's notes.
 * A language model, when connected, can write a better prompt; this is the dependable starting point.
 */
export function developConcept(request: ConceptRequest, images: ImageItem[], notes: Record<string, VisualNotes>, boardName: string): ArtworkConcept {
  const withRole = (role: RefRole): ImageItem[] => images.filter((i) => request.roles[i.id]?.includes(role))
  const atmosphere = withRole('atmosphere')
  const subject = withRole('subject')
  const colour = withRole('colour')
  const composition = withRole('composition')
  // When the user has not assigned anything, the whole board speaks for everything.
  const everything = images
  const note = (list: ImageItem[], key: keyof VisualNotes): string[] => list.map((i) => notes[i.id]?.[key]).filter((v): v is string => Boolean(v))

  const moodWords = top(note(atmosphere.length ? atmosphere : everything, 'mood'), 2)
  const styleWords = top(note(atmosphere.length ? atmosphere : everything, 'style'), 2)
  const subjectWords = top(note(subject.length ? subject : everything, 'subject'), 2)
  const paletteSource = colour.length ? colour : everything
  const palette = [...new Set(paletteSource.map((i) => i.color).filter((c): c is string => Boolean(c)))].slice(0, 5)
  const paletteNames = [...new Set(palette.map(colourName))].slice(0, 3)

  const lead = composition[0] ?? subject[0] ?? images[0]
  const aspect: AspectChoice = request.aspect ?? (lead ? aspectFor(lead.width, lead.height) : 'landscape')
  const size = ASPECTS[aspect]
  const orientation = aspect === 'wide' ? 'a wide panoramic composition' : aspect === 'landscape' ? 'a horizontal composition' : aspect === 'portrait' ? 'a tall vertical composition' : 'a balanced square composition'

  const intent = cleanIntent(request.intent) || 'an original artwork'
  const parts = [intent.charAt(0).toUpperCase() + intent.slice(1)]
  if (subjectWords.length && !subjectWords.some((w) => intent.toLowerCase().includes(w.toLowerCase()))) parts.push(`with ${subjectWords.join(' and ')}`)
  const sentence: string[] = [parts.join(' ')]
  if (moodWords.length) sentence.push(`${moodWords.join(', ')} atmosphere`)
  if (styleWords.length) sentence.push(`${styleWords.join(', ')} style`)
  if (paletteNames.length) sentence.push(`colour palette of ${paletteNames.join(', ')}`)
  sentence.push(orientation)
  const prompt = `${sentence.join(', ')}, cohesive, richly detailed, painterly light`

  const lines: string[] = []
  const names = (list: ImageItem[]): string => `${list.length} picture${list.length === 1 ? '' : 's'}`
  if (atmosphere.length || moodWords.length) lines.push(`Atmosphere comes from ${names(atmosphere.length ? atmosphere : everything)}${moodWords.length ? `: ${moodWords.join(', ')}` : ''}.`)
  if (composition.length) lines.push(`Composition follows ${composition[0]!.filename}: ${aspect}.`)
  if (colour.length || paletteNames.length) lines.push(`Colours: ${paletteNames.length ? paletteNames.join(', ') : 'taken from the board'}${colour.length ? ` (from ${names(colour)})` : ''}.`)
  if (subject.length) lines.push(`Subject hints from ${names(subject)}${subjectWords.length ? `: ${subjectWords.join(', ')}` : ''}.`)
  if (lines.length === 0) lines.push('No roles were chosen, so the whole board speaks for everything.')

  const seedOffset = (request.intent.length + images.length) % VARIATIONS.length
  const variations = [0, 1, 2].map((n) => `${prompt}, ${VARIATIONS[(seedOffset + n * 2) % VARIATIONS.length]}`)
  const title = intent === 'an original artwork' ? `${boardName} — new work` : intent.split(' ').slice(0, 5).join(' ').replace(/^./, (c) => c.toUpperCase())

  return {
    title,
    summary: `A ${aspect} piece from “${boardName}”: ${[...moodWords, ...paletteNames].slice(0, 4).join(', ') || 'the spirit of the board'}.`,
    prompt,
    negative: 'text, watermark, logo, signature, frame, low quality, blurry, deformed, oversaturated',
    palette,
    aspect,
    width: size.width,
    height: size.height,
    notes: lines,
    variations
  }
}
