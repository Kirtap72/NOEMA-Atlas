import type { EditLevel, RegionName } from '../../shared/studio'
import { regionFromInstruction as regionFromWords } from '../../shared/regionWords'

// Reading what a person asks for in an edit: how far it may go, which part it concerns and what the picture should
// become. Used by the offline companion, by the tools of language models (as a safety net for their arguments) and by
// the Edit tab's hints. Nothing here changes a picture.

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, a: 1, an: 1, ett: 1, två: 2, tre: 3, fyra: 4 }

/** How far the wording lets the edit go, or null when it does not say. */
export function levelFromText(text: string): EditLevel | null {
  const t = text.toLowerCase()
  if (/\b(radical|reinterpret\w*|reimagin\w*|completely|totally|wildly|transform\w*|entirely different|bold)\b/.test(t)) return 'radical'
  if (/\b(subtle|subtly|slight\w*|a (?:little|touch|bit)|gentl\w+|polish|enhance|touch up|clean up|tidy)\b/.test(t)) return 'subtle'
  if (/\b(creative|stylis\w+|keep|preserve|but)\b/.test(t)) return 'creative'
  return null
}

/** "three artistic interpretations" gives 3. */
export function countFromText(text: string): number | null {
  const m = /\b(\d|one|two|three|four|två|tre|fyra)\s+(?:different\s+|artistic\s+|creative\s+)?(?:variations?|versions?|interpretations?|alternatives?|options?|takes?|variants?|tolkningar|versioner)\b/i.exec(text)
  if (!m) return null
  const n = /^\d$/.test(m[1]!) ? Number(m[1]) : NUMBER_WORDS[m[1]!.toLowerCase()]
  return n ? Math.max(1, Math.min(4, n)) : null
}

/** The part of the picture the wording is about ("the sky"), when it names one. */
export const regionFromInstruction = regionFromWords

const POLITE = /^(?:(?:please|hey|ok|okay|now)[,\s]+)?(?:(?:can|could|would) you\s+)?(?:i (?:want|would like|'d like) (?:you )?to\s+)?(?:try to\s+)?/i

/**
 * Turns an instruction into a description the image model can use. "Replace the sky with something more mysterious"
 * becomes "mysterious, sky". What is to be kept ("but keep the architecture") is dropped from the description, because
 * the structure is held by the tile ControlNet and the mask, not by words.
 */
export function imagePromptFromInstruction(instruction: string): string {
  let t = instruction.trim().replace(POLITE, '').replace(/[.!]+$/, '')
  t = t.replace(/[,;]?\s*\b(?:but|while|and)\s+(?:please\s+)?(?:keep|preserve|retain|leave|maintain|don'?t (?:change|touch))\b.*$/i, '')
  t = t.replace(/[,;]?\s*\b(?:without (?:changing|touching|altering))\b.*$/i, '')
  const swap = /\b(?:replace|swap|change|turn|transform|convert)\s+(?:the\s+|this\s+|that\s+|my\s+)?(.+?)\s+(?:with|into|to|for)\s+(.+)$/i.exec(t)
  if (swap) {
    const target = swap[1]!.trim()
    const desired = swap[2]!.replace(/^(?:something|anything|a|an|some)\s+/i, '').replace(/\b(?:more|much more|even more)\s+/i, '').trim()
    return `${desired}, ${target}`.slice(0, 600)
  }
  const make = /^(?:make|give|add|render)\s+(?:the\s+|this\s+|it\s+|that\s+)?(.*)$/i.exec(t)
  if (make && make[1]) {
    const rest = make[1].replace(/^(?:more|much more|a bit more|slightly more)\s+/i, '').replace(/^(?:it|this|everything)\s+/i, '').trim()
    return rest.slice(0, 600) || t.slice(0, 600)
  }
  return t.slice(0, 600)
}
