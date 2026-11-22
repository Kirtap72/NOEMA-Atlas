/**
 * Artistic curation: from many candidates, propose a few, and say why, from evidence.
 *
 * What it uses
 *  - relevance: how well each image fits the description (a Smart Collection's own ranking, or a search);
 *  - the user's taste: closeness to their favorite groups, their Taste comparisons, favorites, ratings and Keep/Pass;
 *  - kind of image: a finished work, an experiment, or a technical working image (a software screenshot, a test
 *    render, a texture sheet), judged from the image model, the file name, the picture's size and its pixels;
 *  - coherence and variety: the picks should belong together without repeating each other; near-duplicates are dropped.
 *
 * What it does not do: it has no score for "quality" or "beauty". Experimental and unusual images are never penalised
 * for being unusual. When too few candidates are strong it proposes fewer instead of padding the list.
 */
import type { CuratedLeftOut, CuratedPick, CurationRole } from '../shared/curation'

// ---- evidence about what kind of image it is ----------------------------------------------------------------------

const FILENAME_HINTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /screen[ _-]?shot|screen[ _-]?capture|screen[ _-]?grab|skärmbild|skärmdump|snip(?:ping)?[ _-]?tool|(?<![a-z])capture(?![a-z])/i, label: 'a screen capture' },
  { pattern: /viewport|blender|maya|cinema[ _-]?4d|c4d|unreal|unity|houdini|zbrush|substance|3ds[ _-]?max|marmoset/i, label: '3D software' },
  { pattern: /wire[ _-]?frame|clay[ _-]?render|untextured|(?<![a-z])uv(?![a-z])|texture[ _-]?(?:map|sheet|test)|normal[ _-]?map|depth[ _-]?map|(?<![a-z])ao[ _-]?map(?![a-z])|matcap|node[ _-]?graph/i, label: 'a technical pass or map' },
  { pattern: /test[ _-]?render|render[ _-]?test|(?<![a-z])wip(?![a-z])|work[ _-]?in[ _-]?progress|placeholder|(?<![a-z])tmp(?![a-z])|(?<![a-z])temp(?![a-z])|untitled|(?<![a-z])draft(?![a-z])/i, label: 'a work-in-progress or test file' }
]

/** A file name or folder name that says the picture is a working image. */
export function filenameHint(filename: string, folder: string): string | null {
  const folderName = folder.split(/[\\/]/).filter(Boolean).pop() ?? ''
  for (const { pattern, label } of FILENAME_HINTS) {
    if (pattern.test(filename)) return `the file name suggests ${label}`
    if (pattern.test(folderName)) return `it sits in a folder named “${folderName}”, which suggests ${label}`
  }
  return null
}

const SCREEN_SIZES = new Set(
  [
    '1024x768', '1280x720', '1280x800', '1280x1024', '1366x768', '1440x900', '1536x864', '1600x900', '1680x1050', '1920x1080',
    '1920x1200', '2048x1152', '2560x1080', '2560x1440', '2560x1600', '2880x1800', '3000x2000', '3440x1440', '3840x1600', '3840x2160', '5120x2880'
  ].flatMap((size) => [size, size.split('x').reverse().join('x')])
)

/** A PNG or BMP of exactly a common screen size. Weak evidence on its own: many artworks are 1920 by 1080. */
export function isScreenSize(width: number, height: number, ext: string): boolean {
  const e = ext.replace('.', '').toLowerCase()
  return (e === 'png' || e === 'bmp') && SCREEN_SIZES.has(`${width}x${height}`)
}

export interface PixelFacts {
  /** Share of small blocks with almost no variation: interface panels, flat backgrounds. */
  flatShare: number
  /** Share of pixels in the single most common colour. */
  topColourShare: number
}

/** Interface-like pixels from a small RGB sample (three bytes per pixel). Pure, so it can be tested. */
export function pixelFacts(data: Uint8Array, width: number, height: number, block = 4): PixelFacts {
  const counts = new Map<number, number>()
  let flat = 0
  let blocks = 0
  for (let by = 0; by + block <= height; by += block) {
    for (let bx = 0; bx + block <= width; bx += block) {
      let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
      for (let y = by; y < by + block; y += 1) {
        for (let x = bx; x < bx + block; x += 1) {
          const i = (y * width + x) * 3
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
          if (r < minR) minR = r
          if (r > maxR) maxR = r
          if (g < minG) minG = g
          if (g > maxG) maxG = g
          if (b < minB) minB = b
          if (b > maxB) maxB = b
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
      }
      blocks += 1
      if (maxR - minR < 8 && maxG - minG < 8 && maxB - minB < 8) flat += 1
    }
  }
  const total = Math.max(1, width * height)
  let top = 0
  for (const n of counts.values()) if (n > top) top = n
  return { flatShare: blocks === 0 ? 0 : flat / blocks, topColourShare: top / total }
}

export function looksLikeInterface(pixels: PixelFacts | null): boolean {
  return pixels !== null && pixels.flatShare >= 0.5 && pixels.topColourShare >= 0.25
}

export interface RoleEvidence {
  /** Where the image model puts this image between "technical working image" and "finished work", as a percentile of finished reference artworks (0 to 100): how technical-looking it is compared with them. */
  technicalPercentile: number | null
  /** The kind of technical image the model thinks it is closest to, in words. */
  technicalKind: string | null
  /** Percentile (0 to 100) of experimental-looking among the finished reference artworks. */
  experimentalPercentile: number | null
  filename: string | null
  screenSize: boolean
  interfacePixels: boolean
}

export interface RoleDecision {
  role: CurationRole
  /** Higher means more sure the image is technical. 3 or more makes it technical. */
  technicalVotes: number
  /** Each thing that spoke for "technical". */
  reasons: string[]
}

/** The votes: the image model counts most, a telling file name counts as much, size and pixels only support. */
export function decideRole(evidence: RoleEvidence): RoleDecision {
  let votes = 0
  let modelVotes = 0
  const reasons: string[] = []
  const p = evidence.technicalPercentile
  if (p !== null && p >= 99) {
    modelVotes = 3
    reasons.push(`the image model reads it as ${evidence.technicalKind ?? 'a technical image'} more strongly than it does almost any finished reference artwork`)
  } else if (p !== null && p >= 94) {
    modelVotes = 2
    reasons.push(`the image model sees signs of ${evidence.technicalKind ?? 'a technical image'}`)
  }
  votes += modelVotes
  if (evidence.filename) {
    votes += 2
    reasons.push(evidence.filename)
  }
  if (evidence.screenSize) {
    votes += 1
    reasons.push('it is a PNG of exactly a common screen size')
  }
  if (evidence.interfacePixels) {
    votes += 1
    reasons.push('large flat, panel-like areas, as in a software interface')
  }
  let role: CurationRole
  const experimental = evidence.experimentalPercentile !== null && evidence.experimentalPercentile >= 85
  if (votes >= 3) role = 'technical'
  // Glitch art and generative experiments can look like software artefacts to the model. When only the model has doubts and
  // the image reads as experimental too, it is treated as an experiment, which is never penalised.
  else if (votes === modelVotes && votes > 0 && experimental) role = 'experimental'
  else if (votes === 2) role = 'unclear'
  else if (evidence.experimentalPercentile !== null && evidence.experimentalPercentile >= 90) role = 'experimental'
  else role = 'finished'
  return { role, technicalVotes: votes, reasons }
}

// ---- choosing --------------------------------------------------------------------------------------------------------

export interface CurationCandidate {
  id: string
  /** How well it fits the description, 0 to 100 (a Smart Collection's match). Null when there is no description. */
  match: number | null
  filename: string
  favorite: boolean
  rating: number
  decision: 'keep' | 'pass' | null
  role: CurationRole
  roleReasons: string[]
  /** 0 to 1: how close to this user's favorite groups, compared with the other candidates. Null without favorites. */
  modePercentile: number | null
  /** The favorite group it is closest to, when it is clearly close. */
  nearMode: string | null
  /** 0 to 1: how high the Taste comparisons put it. Null without a trained compass. */
  compassPercentile: number | null
  /** Just outside the collection (it matches only at a looser setting): offered as an alternative, never proposed first. */
  outside?: boolean
}

export interface CurationInput {
  candidates: CurationCandidate[]
  /** One unit vector per candidate, in the same order. */
  vectors: Float32Array[]
  count: number
  /** Whether technical working images may be proposed. They are left out by default. */
  includeTechnical?: boolean
  /** Candidates must fit the description at least this well (0 to 100). */
  minMatch?: number
}

export interface CurationOutput {
  picks: CuratedPick[]
  alternatives: CuratedPick[]
  leftOut: CuratedLeftOut[]
  requested: number
  shortfall: string | null
  tasteBasis: string
}

const DUPLICATE = 0.95
const TOO_ALIKE = 0.86

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!
  return sum
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function curate(input: CurationInput): CurationOutput {
  const { candidates, vectors } = input
  const count = Math.max(1, Math.min(60, Math.round(input.count)))
  const minMatch = input.minMatch ?? 55
  const hasTaste = candidates.some((c) => c.modePercentile !== null || c.compassPercentile !== null)
  const wRel = hasTaste ? 0.55 : 0.85
  const wTaste = hasTaste ? 0.3 : 0

  const leftOut: CuratedLeftOut[] = []
  interface Scored {
    index: number
    c: CurationCandidate
    composite: number
    taste: number | null
  }
  const pool: Scored[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!
    if (c.decision === 'pass') {
      leftOut.push({ imageId: c.id, why: 'passed', detail: 'you passed on this image in the Review Room', role: c.role })
      continue
    }
    if (c.role === 'technical' && !input.includeTechnical) {
      leftOut.push({ imageId: c.id, why: 'technical', detail: c.roleReasons.length ? `looks like a working image: ${c.roleReasons.slice(0, 2).join('; ')}` : 'looks like a technical working image', role: c.role })
      continue
    }
    if (c.match !== null && c.match < minMatch && !c.outside) {
      leftOut.push({ imageId: c.id, why: 'weak', detail: `only a loose match (${Math.round(c.match)} of 100)`, role: c.role })
      continue
    }
    const relevance = c.match === null ? 0.7 : c.match / 100
    if (c.outside) {
      // Kept apart: eligible only as an alternative.
    }
    const tasteParts = [c.modePercentile, c.compassPercentile].filter((v): v is number => v !== null)
    const taste = tasteParts.length ? tasteParts.reduce((a, b) => a + b, 0) / tasteParts.length : null
    let composite = wRel * relevance + wTaste * (taste ?? 0.5)
    if (c.favorite) composite += 0.08
    if (c.rating >= 4) composite += 0.05
    if (c.decision === 'keep') composite += 0.04
    if (c.role === 'unclear') composite -= 0.08
    pool.push({ index: i, c, composite, taste })
  }
  pool.sort((a, b) => b.composite - a.composite)

  // Strong enough: close to the best candidate, so a weak tail is not used to fill the list.
  const top = pool[0]?.composite ?? 0
  const floor = Math.max(hasTaste ? 0.5 : 0.5, top - 0.3)

  const picked: Scored[] = []
  const reasonsOf = new Map<string, string[]>()
  const alike = new Map<string, number>()
  const remaining = pool.slice()
  const droppedDuplicates: string[] = []
  const alternatives: Scored[] = []

  const centroid = (): Float32Array | null => {
    if (picked.length === 0) return null
    const sum = new Float32Array(vectors[0]?.length ?? 0)
    for (const p of picked) for (let d = 0; d < sum.length; d += 1) sum[d]! += vectors[p.index]![d]!
    let n = 0
    for (const v of sum) n += v * v
    n = Math.sqrt(n) || 1
    return sum.map((v) => v / n)
  }

  // Maximal marginal relevance: take the best candidate that is not a repeat of one already chosen, and that sits
  // with the rest. Variety is rewarded only up to the point of incoherence.
  const choose = (limit: number, relaxed: boolean, which: 'inside' | 'outside' | 'any' = 'any'): Scored[] => {
    const out: Scored[] = []
    while (out.length < limit && remaining.length > 0) {
      const centre = centroid()
      let bestAt = -1
      let bestGain = -Infinity
      for (let r = 0; r < remaining.length; r += 1) {
        const cand = remaining[r]!
        if (which === 'inside' && cand.c.outside) continue
        if (which === 'outside' && !cand.c.outside) continue
        if (!relaxed && (cand.composite < floor || cand.c.outside)) continue
        if (relaxed && cand.composite < floor - (cand.c.outside ? 0.25 : 0.12)) continue
        let maxSim = 0
        for (const p of [...picked, ...out]) maxSim = Math.max(maxSim, dot(vectors[cand.index]!, vectors[p.index]!))
        if (maxSim >= DUPLICATE) {
          droppedDuplicates.push(cand.c.id)
          remaining.splice(r, 1)
          r -= 1
          leftOut.push({ imageId: cand.c.id, why: 'duplicate', detail: `almost identical to another candidate (${Math.round(maxSim * 100)}% alike)`, role: cand.c.role })
          continue
        }
        let gain = cand.composite
        if (maxSim > TOO_ALIKE) gain -= 1.2 * ((maxSim - TOO_ALIKE) / (DUPLICATE - TOO_ALIKE))
        if (centre && picked.length >= 2) {
          const toCentre = dot(vectors[cand.index]!, centre)
          if (toCentre < 0.5) gain -= 0.25
          else gain += 0.1 * toCentre
        }
        if (gain > bestGain) {
          bestGain = gain
          bestAt = r
        }
      }
      if (bestAt < 0) break
      const chosen = remaining.splice(bestAt, 1)[0]!
      out.push(chosen)
      if (!relaxed) picked.push(chosen)
      else alternatives.push(chosen)
    }
    return out
  }

  choose(count, false)
  // Alternatives: the next best choices, a little more permissive, for the user to swap in.
  choose(Math.max(6, Math.min(12, count)), true, 'inside')
  // A few images just outside the collection are offered too, in their own places, so they cannot crowd out the rest.
  choose(4, true, 'outside')

  // Whatever is left over and strong enough was simply not needed; the weak remainder is reported as weak.
  for (const r of remaining) {
    if (r.c.outside) continue
    leftOut.push({ imageId: r.c.id, why: 'weak', detail: r.composite < floor ? 'fits less well than the images chosen' : 'not needed once the choice was complete', role: r.c.role })
  }

  const centreAll = centroid()
  const toPick = (s: Scored, isAlternative: boolean): CuratedPick => {
    const c = s.c
    const reasons: string[] = []
    if (c.match !== null) reasons.push(c.match >= 85 ? `a close match for the description (${Math.round(c.match)} of 100)` : `a good match for the description (${Math.round(c.match)} of 100)`)
    if (c.nearMode) reasons.push(`close to your favorite group “${c.nearMode}”`)
    else if (c.modePercentile !== null && c.modePercentile >= 0.75) reasons.push('among the candidates closest to your favorites')
    if (c.compassPercentile !== null && c.compassPercentile >= 0.8) reasons.push('your Taste comparisons lean towards images like this')
    if (c.favorite) reasons.push('you marked it as a favorite')
    else if (c.rating >= 4) reasons.push(`you rated it ${c.rating} stars`)
    else if (c.decision === 'keep') reasons.push('you kept it in the Review Room')
    if (c.role === 'experimental') reasons.push('an experimental piece, kept for variety and not penalised for being unusual')
    if (c.role === 'unclear') reasons.push(`mixed signs of a working image: ${c.roleReasons[0] ?? 'see the image'}`)
    if (!isAlternative && centreAll) {
      const near = picked.filter((p) => p.c.id !== c.id).reduce((m, p) => Math.max(m, dot(vectors[s.index]!, vectors[p.index]!)), 0)
      if (picked.length > 1 && near < 0.75) reasons.push('adds variety: noticeably different from the other picks')
    }
    if (c.outside) reasons.unshift('just outside this collection: it fits only at a looser setting')
    if (reasons.length === 0) reasons.push('fits the description')
    return { imageId: c.id, role: c.role, reasons: reasons.slice(0, 4), match: c.match, uncertain: c.role === 'unclear' }
  }
  void reasonsOf
  void alike

  const picks = picked.map((s) => toPick(s, false))
  const alts = alternatives.map((s) => toPick(s, true))

  let shortfall: string | null = null
  if (picks.length < count) {
    const tech = leftOut.filter((l) => l.why === 'technical').length
    const weak = leftOut.filter((l) => l.why === 'weak').length
    const dup = droppedDuplicates.length
    const passed = leftOut.filter((l) => l.why === 'passed').length
    const parts: string[] = []
    if (tech) parts.push(`${plural(tech, 'candidate')} look${tech === 1 ? 's' : ''} like technical working images`)
    if (weak) parts.push(`${plural(weak, 'candidate')} fit${weak === 1 ? 's' : ''} the description only loosely`)
    if (dup) parts.push(`${plural(dup, 'candidate')} repeat${dup === 1 ? 's' : ''} a stronger one`)
    if (passed) parts.push(`${plural(passed, 'candidate')} you passed on`)
    shortfall = `I found only ${plural(picks.length, 'strong candidate')} for ${plural(count, 'place')}${parts.length ? `: ${parts.join(', ')}` : ''}. I would rather propose fewer than fill the board with weak choices.`
    const outsideOffered = alternatives.filter((s) => s.c.outside).length
    if (outsideOffered > 0) shortfall += ` ${plural(outsideOffered, 'more image')} fit${outsideOffered === 1 ? 's' : ''} the description only at a looser setting and ${outsideOffered === 1 ? 'is' : 'are'} offered under “More good choices”.`
  }

  const tasteParts: string[] = []
  if (candidates.some((c) => c.modePercentile !== null)) tasteParts.push('how close each image is to your favorite groups')
  if (candidates.some((c) => c.compassPercentile !== null)) tasteParts.push('what your Taste comparisons prefer')
  if (candidates.some((c) => c.favorite || c.rating >= 4 || c.decision === 'keep')) tasteParts.push('your favorites, ratings and Keep decisions')
  const tasteBasis = tasteParts.length
    ? `Chosen for fit with the description and with ${tasteParts.join(', ')}. This is your taste, not a measure of quality.`
    : 'You have no favorites or Taste choices to learn from yet, so this choice rests on the description and on how well the images belong together. It is not a measure of quality.'

  return { picks, alternatives: alts, leftOut, requested: count, shortfall, tasteBasis }
}
