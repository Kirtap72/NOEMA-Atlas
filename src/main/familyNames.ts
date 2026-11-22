import { SUBJECT_GROUPS, type TermKind, type VocabTerm } from './familyVocabulary'

export type NameConfidence = 'clear' | 'loose' | 'mixed'

export interface FamilyName {
  /** The name shown, e.g. "Misty mountain scenes", or "Mixed images" when the group has no clear common thread. */
  name: string
  confidence: NameConfidence
  /** The most telling descriptions, strongest first, for display as keywords. */
  keywords: string[]
  /** One sentence explaining what the name rests on (always including how many images agree). */
  note: string
  /** Ids of the vocabulary terms the name is built from, for keeping names stable across regroupings. */
  basis: string[]
}

export interface VocabVectors {
  terms: VocabTerm[]
  /** terms.length × dim unit vectors. */
  vectors: Float32Array
  dim: number
  /**
   * Mean similarity of each term over the whole library. Subtracting it ("calibration") stops terms the model likes for
   * almost every image from being chosen for every family, so names reflect what sets a family apart.
   */
  baseline?: Float32Array
}

/** Average similarity of every vocabulary term over (a sample of) the library. */
export function computeBaseline(library: Float32Array, rows: number, vocab: Pick<VocabVectors, 'terms' | 'vectors' | 'dim'>, maxRows = 2500): Float32Array {
  const { dim, terms, vectors } = vocab
  const baseline = new Float32Array(terms.length)
  const step = Math.max(1, Math.floor(rows / maxRows))
  let used = 0
  for (let r = 0; r < rows; r += step) {
    used += 1
    for (let t = 0; t < terms.length; t += 1) {
      let dot = 0
      for (let d = 0; d < dim; d += 1) dot += library[r * dim + d]! * vectors[t * dim + d]!
      baseline[t]! += dot
    }
  }
  for (let t = 0; t < terms.length; t += 1) baseline[t]! /= Math.max(1, used)
  return baseline
}

interface Scored {
  term: VocabTerm
  /** Mean probability mass over the members. */
  mean: number
  /** Share of members for which this term is the best description in its group. */
  share: number
  /** The same share without any calibration: does the model also think so on its own? */
  rawShare: number
}

interface GroupScore {
  id: string
  label: string
  /** Share of members whose best subject belongs to this group. */
  share: number
  mean: number
  best: Scored
}

/** Temperature for turning similarities into probabilities within one group of descriptions. */
const SCALE = 160
/** How much of the library-wide bias to remove: what a picture IS depends less on the library than how it is set apart. */
const CALIBRATION: Record<TermKind, number> = { subject: 0.5, atmosphere: 1, style: 1, colour: 1 }

const SHARE_CLEAR = 0.45
const SHARE_SPECIFIC = 0.35
const SHARE_SECOND = 0.25
const SHARE_MODIFIER = 0.5

function scoreKind(members: Float32Array, n: number, vocab: VocabVectors, kind: TermKind): { terms: Scored[]; groups: GroupScore[] } {
  const { dim } = vocab
  const indices = vocab.terms.map((t, i) => (t.kind === kind ? i : -1)).filter((i) => i >= 0)
  const mean = new Float64Array(indices.length)
  const wins = new Float64Array(indices.length)
  const rawWins = new Float64Array(indices.length)
  const logits = new Float64Array(indices.length)
  const alpha = CALIBRATION[kind]
  for (let m = 0; m < n; m += 1) {
    let max = -Infinity
    let best = 0
    let rawMax = -Infinity
    let rawBest = 0
    for (let k = 0; k < indices.length; k += 1) {
      let dot = 0
      const base = indices[k]! * dim
      for (let d = 0; d < dim; d += 1) dot += members[m * dim + d]! * vocab.vectors[base + d]!
      logits[k] = (dot - alpha * (vocab.baseline?.[indices[k]!] ?? 0)) * SCALE
      if (logits[k]! > max) {
        max = logits[k]!
        best = k
      }
      if (dot > rawMax) {
        rawMax = dot
        rawBest = k
      }
    }
    rawWins[rawBest]! += 1 / n
    let sum = 0
    for (let k = 0; k < indices.length; k += 1) {
      logits[k] = Math.exp(logits[k]! - max)
      sum += logits[k]!
    }
    for (let k = 0; k < indices.length; k += 1) mean[k]! += logits[k]! / sum / n
    wins[best]! += 1 / n
  }
  const terms = indices
    .map((index, k) => ({ term: vocab.terms[index]!, mean: mean[k]!, share: wins[k]!, rawShare: rawWins[k]! }))
    .sort((a, b) => b.mean - a.mean)
  const groups = new Map<string, GroupScore>()
  for (const t of terms) {
    const g = t.term.group
    if (!g) continue
    const cur = groups.get(g) ?? { id: g, label: SUBJECT_GROUPS[g] ?? g, share: 0, mean: 0, best: t }
    cur.share += t.share
    cur.mean += t.mean
    if (t.mean > cur.best.mean) cur.best = t
    groups.set(g, cur)
  }
  return { terms, groups: Array.from(groups.values()).sort((a, b) => b.share - a.share) }
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * Names a family from what its images have in common, by asking the local image model which everyday descriptions fit
 * each image best (zero-shot) and keeping only what a clear share of the family agrees on. A group without a clear common
 * thread is called "Mixed images" rather than being given a confident name it does not deserve.
 */
export function nameFamily(members: Float32Array, n: number, vocab: VocabVectors, options: { cohesion?: number } = {}): FamilyName {
  const subjects = scoreKind(members, n, vocab, 'subject')
  const moods = scoreKind(members, n, vocab, 'atmosphere').terms
  const styles = scoreKind(members, n, vocab, 'style').terms
  const colours = scoreKind(members, n, vocab, 'colour').terms

  // Small groups need a larger share to agree before they get a name.
  const small = n < 5
  const shareClear = small ? 0.67 : SHARE_CLEAR
  const cohesion = options.cohesion ?? 1
  const loosePenalty = cohesion < 0.7 ? 0.1 : 0

  /** The wording for a subject group: the specific subject when one clearly dominates it, otherwise the broad kind. */
  const wording = (g: GroupScore): { label: string; specific: boolean; id: string } => {
    // A specific subject is named only when it clearly dominates its group; "mountain scenes" for half forests would mislead.
    const specific = g.best.share >= SHARE_SPECIFIC && g.best.share >= 0.65 * g.share && g.best.mean >= 0.5 * g.mean
    return specific ? { label: g.best.term.label, specific: true, id: g.best.term.id } : { label: g.label, specific: false, id: g.id }
  }
  const g1 = subjects.groups[0]
  const g2 = subjects.groups[1]
  const primary = g1 && g1.share >= shareClear + loosePenalty && g1.mean >= 0.25 ? g1 : null
  const secondary = primary && g2 && g2.share >= SHARE_SECOND && g2.share >= primary.share * 0.6 ? g2 : null

  // At most one modifier: the atmosphere, style or colour that most of the group shares.
  const modifiers = [moods[0], styles[0], colours[0]]
    // A modifier must be distinctive for this family AND something the model sees on its own: otherwise a term that is merely
    // "above the library average" (for instance "futuristic" in a library of old paintings) would be named.
    .filter((m): m is Scored => Boolean(m) && m!.share >= SHARE_MODIFIER && m!.mean >= 0.3 && m!.rawShare >= 0.25)
    .filter((m) => m.term.id !== 'photo') // "photographic landscapes" says nothing
    .sort((a, b) => b.share - a.share)
  const modifier = modifiers[0] ?? null

  const keywords = [subjects.terms[0], subjects.terms[1], moods[0], styles[0], colours[0]]
    .filter((x): x is Scored => Boolean(x) && !x!.term.generic)
    .filter((x) => x.share >= 0.2 && x.mean >= 0.1)
    .sort((a, b) => b.share - a.share)
    .slice(0, 4)
    .map((x) => x.term.label)
  const count = (share: number): number => Math.round(share * n)

  if (primary && secondary) {
    const a = wording(primary)
    const b = wording(secondary)
    return {
      name: capital(a.label === b.label ? a.label : `${a.label} and ${b.label}`),
      confidence: 'loose',
      keywords: keywords.length ? keywords : [a.label, b.label],
      note: `A mix of two kinds of image: about ${count(primary.share)} of ${n} are ${a.label} and ${count(secondary.share)} are ${b.label}.`,
      basis: [a.id, b.id]
    }
  }
  if (primary) {
    const w = wording(primary)
    const name = modifier ? `${modifier.term.adjective ?? modifier.term.label} ${w.label}` : w.label
    const parts = [`${count(primary.share)} of ${n} images are ${w.label}`]
    if (modifier) parts.push(`${count(modifier.share)} share a ${modifier.term.kind === 'colour' ? 'colour' : modifier.term.kind === 'style' ? 'style' : 'mood'} that fits "${modifier.term.adjective ?? modifier.term.label}"`)
    return {
      name: capital(name),
      confidence: primary.share >= 0.6 && w.specific ? 'clear' : 'loose',
      keywords,
      note: `Named from what the family has in common: ${parts.join(' and ')}.`,
      basis: modifier ? [w.id, modifier.term.id] : [w.id]
    }
  }
  if (modifier && modifier.share >= Math.max(0.6, shareClear)) {
    return {
      name: capital(modifier.term.label),
      confidence: 'loose',
      keywords,
      note: `No single subject stands out. ${count(modifier.share)} of ${n} images fit "${modifier.term.label}".`,
      basis: [modifier.term.id]
    }
  }
  return {
    name: 'Mixed images',
    confidence: 'mixed',
    keywords,
    note: `These images look alike overall but share no single subject, mood or style that most of them agree on${keywords.length ? ` (the strongest threads are ${keywords.slice(0, 3).join(', ')})` : ''}.`,
    basis: []
  }
}

/**
 * Makes names unique: when two families would share a name, the later ones get a distinguishing second thread
 * (their next-best keyword) or a number.
 */
export function uniqueNames(names: FamilyName[]): string[] {
  const seen = new Map<string, number>()
  return names.map((entry) => {
    const key = entry.name.toLowerCase()
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count === 1) return entry.name
    const extra = entry.keywords.find((k) => !entry.name.toLowerCase().includes(k.toLowerCase()))
    return extra && count === 2 ? `${entry.name} (${extra})` : `${entry.name} (${count})`
  })
}
