import type { RegionName } from './studio'

// Everyday words for the parts of a picture, shared by the offline companion, the language-model tools and the Edit tab.

export const REGION_WORDS: Array<[RegionName, RegExp]> = [
  ['sky', /\b(sky|skies|clouds?|heavens?|himmel)\b/i],
  ['background', /\b(background|backdrop|surroundings|bakgrund)\b/i],
  ['foreground', /\b(foreground|ground|floor|grass|path|förgrund)\b/i],
  ['top', /\b(top|upper|above|överkant)\b/i],
  ['bottom', /\b(bottom|lower|below|underkant)\b/i],
  ['left', /\b(left)\b/i],
  ['right', /\b(right)\b/i],
  ['center', /\b(cent(?:er|re)|middle|subject|main (?:object|figure))\b/i]
]

/** Finds a named part in a phrase like "replace the sky with something more mysterious". The first match wins. */
export function regionFromText(text: string): RegionName | null {
  const lowered = text.toLowerCase()
  let best: { name: RegionName; at: number } | null = null
  for (const [name, re] of REGION_WORDS) {
    const m = re.exec(lowered)
    if (m && (!best || m.index < best.at)) best = { name, at: m.index }
  }
  return best?.name ?? null
}

/** The part the wording says should change; "but keep the sky" says what stays, so those clauses are left out first. */
export function regionFromInstruction(text: string): RegionName | null {
  const cleaned = text.replace(/\b(?:(?:but|while|and)\s+)?(?:keep|preserve|retain|leave|maintain|don'?t (?:change|touch)|without (?:changing|touching|altering))\b[^,.;]*/gi, ' ')
  return regionFromText(cleaned)
}

export const REGION_LABELS: Record<RegionName, string> = { sky: 'Sky', top: 'Top', bottom: 'Bottom', left: 'Left side', right: 'Right side', center: 'Middle', background: 'Background', foreground: 'Foreground' }
