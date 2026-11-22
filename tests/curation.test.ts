import { describe, expect, it } from 'vitest'
import { curate, decideRole, filenameHint, isScreenSize, looksLikeInterface, pixelFacts, type CurationCandidate } from '../src/main/curation'

const DIM = 16

function unit(values: number[]): Float32Array {
  const norm = Math.hypot(...values) || 1
  return Float32Array.from(values.map((v) => v / norm))
}

/** Deterministic pseudo-random number in -1..1 for (n, d). */
function hashNoise(n: number, d: number): number {
  const x = Math.sin((n + 1) * 12.9898 + (d + 1) * 78.233) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

/** A vector leaning on one axis with individual noise (seeded by n). */
function near(axis: number, n: number, noise = 0.55): Float32Array {
  return unit(Array.from({ length: DIM }, (_x, d) => (d === axis ? 1 : noise * hashNoise(n, d))))
}

describe('evidence that an image is a working image', () => {
  it('reads telling file and folder names, and not ordinary ones', () => {
    expect(filenameHint('Screenshot 2026-11-03 141501.png', 'D:\\bilder')).toContain('screen capture')
    expect(filenameHint('Skärmbild 2026.png', 'D:\\x')).toContain('screen capture')
    expect(filenameHint('scene_viewport_final.png', 'D:\\x')).toContain('3D software')
    expect(filenameHint('rock_uv_map.png', 'D:\\x')).toContain('technical pass')
    expect(filenameHint('portrait of anna.png', 'D:\\Blender renders\\wip')).not.toBeNull()
    expect(filenameHint('misty harbour.jpg', 'D:\\art\\finished')).toBeNull()
    expect(filenameHint('capturing light.jpg', 'D:\\art')).toBeNull()
  })

  it('knows common screen sizes, but only for PNG or BMP', () => {
    expect(isScreenSize(1920, 1080, 'png')).toBe(true)
    expect(isScreenSize(1080, 1920, '.png')).toBe(true)
    expect(isScreenSize(1920, 1080, 'jpg')).toBe(false)
    expect(isScreenSize(1900, 1070, 'png')).toBe(false)
  })

  it('tells interface-like pixels (flat panels) from a painting', () => {
    const w = 64
    const ui = new Uint8Array(w * w * 3)
    for (let i = 0; i < w * w; i += 1) ui.set([38, 38, 40], i * 3) // dark grey panel
    for (let y = 20; y < 50; y += 1) for (let x = 14; x < 50; x += 1) ui.set([(x * 5) % 255, (y * 7) % 255, 120], (y * w + x) * 3) // a busy viewport
    const painting = new Uint8Array(w * w * 3)
    for (let i = 0; i < w * w; i += 1) painting.set([(i * 37) % 255, (i * 91) % 255, (i * 53) % 255], i * 3)
    expect(looksLikeInterface(pixelFacts(ui, w, w))).toBe(true)
    expect(looksLikeInterface(pixelFacts(painting, w, w))).toBe(false)
    expect(looksLikeInterface(null)).toBe(false)
  })

  it('combines votes: the model counts most, names and sizes only support it', () => {
    const none = { technicalPercentile: 20, technicalKind: null, experimentalPercentile: 30, filename: null, screenSize: false, interfacePixels: false }
    expect(decideRole(none).role).toBe('finished')
    expect(decideRole({ ...none, technicalPercentile: 99.5, technicalKind: 'a 3D software screenshot' }).role).toBe('technical')
    expect(decideRole({ ...none, technicalPercentile: 95 }).role).toBe('unclear')
    // Glitch art looks like software artefacts to the model: with experimental evidence and nothing else, it is an experiment.
    expect(decideRole({ ...none, technicalPercentile: 96, experimentalPercentile: 95 }).role).toBe('experimental')
    expect(decideRole({ ...none, technicalPercentile: 96, experimentalPercentile: 95, filename: 'the file name suggests a screen capture' }).role).toBe('technical')
    expect(decideRole({ ...none, filename: 'the file name suggests a screen capture' }).role).toBe('unclear')
    expect(decideRole({ ...none, filename: 'the file name suggests a screen capture', screenSize: true }).role).toBe('technical')
    expect(decideRole({ ...none, screenSize: true, interfacePixels: true }).role).toBe('unclear')
    expect(decideRole({ ...none, experimentalPercentile: 96 }).role).toBe('experimental')
    const reasons = decideRole({ ...none, technicalPercentile: 99.5, technicalKind: 'a 3D software screenshot', filename: 'the file name suggests 3D software' }).reasons
    expect(reasons.join(' ')).toContain('3D software screenshot')
  })
})

function candidate(id: string, change: Partial<CurationCandidate> = {}): CurationCandidate {
  return { id, match: 80, filename: `${id}.jpg`, favorite: false, rating: 0, decision: null, role: 'finished', roleReasons: [], modePercentile: null, nearMode: null, compassPercentile: null, ...change }
}

/** A mixed collection: finished work in three moods, technical screenshots that rank very high, experiments, near-duplicates, weak matches. */
function mixed(): { candidates: CurationCandidate[]; vectors: Float32Array[] } {
  const candidates: CurationCandidate[] = []
  const vectors: Float32Array[] = []
  const add = (c: CurationCandidate, v: Float32Array): void => {
    candidates.push(c)
    vectors.push(v)
  }
  for (let i = 0; i < 18; i += 1) add(candidate(`art-${i}`, { match: 70 + ((i * 7) % 25) }), near(i % 3, i))
  for (let i = 0; i < 6; i += 1) {
    add(candidate(`tech-${i}`, { match: 96, role: 'technical', roleReasons: ['the image model reads it as a 3D software screenshot', 'the file name suggests a screen capture'] }), near(4, 40 + i, 0.3))
  }
  for (let i = 0; i < 3; i += 1) add(candidate(`exp-${i}`, { match: 82, role: 'experimental' }), near(5 + i, 60 + i))
  for (let i = 0; i < 4; i += 1) add(candidate(`dup-${i}`, { match: 90 }), near(0, 0)) // the same picture as art-0
  for (let i = 0; i < 5; i += 1) add(candidate(`weak-${i}`, { match: 38 }), near(9, 80 + i))
  return { candidates, vectors }
}

describe('curating a mixed collection', () => {
  it('keeps technical screenshots out even when they rank highest, and says why', () => {
    const { candidates, vectors } = mixed()
    const result = curate({ candidates, vectors, count: 10 })
    expect(result.picks).toHaveLength(10)
    expect(result.picks.some((p) => p.imageId.startsWith('tech-'))).toBe(false)
    expect(result.picks.some((p) => p.imageId.startsWith('weak-'))).toBe(false)
    const technical = result.leftOut.filter((l) => l.why === 'technical')
    expect(technical).toHaveLength(6)
    expect(technical[0]!.detail).toContain('3D software screenshot')
  })

  it('drops near-duplicates, and finds no two picks that are the same picture', () => {
    const { candidates, vectors } = mixed()
    const result = curate({ candidates, vectors, count: 12 })
    const index = new Map(candidates.map((c, i) => [c.id, i]))
    const ids = result.picks.map((p) => p.imageId)
    for (let a = 0; a < ids.length; a += 1) {
      for (let b = a + 1; b < ids.length; b += 1) {
        let dot = 0
        for (let d = 0; d < DIM; d += 1) dot += vectors[index.get(ids[a]!)!]![d]! * vectors[index.get(ids[b]!)!]![d]!
        expect(dot).toBeLessThan(0.95)
      }
    }
    expect(result.leftOut.some((l) => l.why === 'duplicate')).toBe(true)
  })

  it('keeps experimental images and does not penalise them for being unusual', () => {
    const { candidates, vectors } = mixed()
    const result = curate({ candidates, vectors, count: 14 })
    const experimental = result.picks.filter((p) => p.role === 'experimental')
    expect(experimental.length).toBeGreaterThan(0)
    expect(experimental[0]!.reasons.join(' ')).toContain('not penalised')
  })

  it('proposes fewer images when too few are strong, and explains it', () => {
    const { candidates, vectors } = mixed()
    const result = curate({ candidates, vectors, count: 30 })
    expect(result.picks.length).toBeLessThan(30)
    expect(result.shortfall).toContain('technical')
    expect(result.shortfall).toContain('rather propose fewer')
    // Everything proposed fits the description reasonably.
    for (const pick of result.picks) expect(pick.match ?? 100).toBeGreaterThanOrEqual(55)
  })

  it('varies the selection across the moods instead of repeating one', () => {
    const { candidates, vectors } = mixed()
    const result = curate({ candidates, vectors, count: 8 })
    const moods = new Set(result.picks.filter((p) => p.imageId.startsWith('art-')).map((p) => Number(p.imageId.split('-')[1]) % 3))
    expect(moods.size).toBe(3)
  })

  it('prefers what this user favors, without inventing reasons for the rest', () => {
    const { candidates, vectors } = mixed()
    candidates.forEach((c) => {
      if (c.id.startsWith('art-')) c.match = 80
    })
    candidates[7]!.favorite = true
    candidates[7]!.modePercentile = 0.95
    candidates[7]!.nearMode = 'Misty landscapes'
    for (const c of candidates) if (c.id !== candidates[7]!.id && c.id.startsWith('art-')) c.modePercentile = 0.3
    const result = curate({ candidates, vectors, count: 3 })
    expect(result.picks[0]!.imageId).toBe(candidates[7]!.id)
    expect(result.picks[0]!.reasons.join(' ')).toContain('favorite')
    expect(result.picks[0]!.reasons.join(' ')).toContain('Misty landscapes')
    const other = result.picks.find((p) => p.imageId !== candidates[7]!.id)!
    expect(other.reasons.join(' ')).not.toContain('favorite')
    expect(result.tasteBasis).toContain('not a measure of quality')
  })

  it('does not propose images the user passed on, and says so', () => {
    const { candidates, vectors } = mixed()
    candidates[0]!.decision = 'pass'
    const result = curate({ candidates, vectors, count: 10 })
    expect(result.picks.some((p) => p.imageId === candidates[0]!.id)).toBe(false)
    expect(result.leftOut.find((l) => l.imageId === candidates[0]!.id)!.why).toBe('passed')
  })

  it('gives the user alternatives to swap in and still lets technical images be asked for', () => {
    const { candidates, vectors } = mixed()
    const result = curate({ candidates, vectors, count: 6 })
    expect(result.alternatives.length).toBeGreaterThan(2)
    const picked = new Set(result.picks.map((p) => p.imageId))
    expect(result.alternatives.every((a) => !picked.has(a.imageId))).toBe(true)
    const withTechnical = curate({ candidates, vectors, count: 6, includeTechnical: true })
    expect(withTechnical.picks.some((p) => p.imageId.startsWith('tech-'))).toBe(true)
  })

  it('offers images just outside the collection only as alternatives, never as the first picks', () => {
    const { candidates, vectors } = mixed()
    for (let i = 0; i < 4; i += 1) {
      candidates.push(candidate(`near-${i}`, { match: 70, outside: true }))
      vectors.push(near(10 + i, 300 + i))
    }
    const result = curate({ candidates, vectors, count: 8 })
    expect(result.picks.some((p) => p.imageId.startsWith('near-'))).toBe(false)
    const offered = result.alternatives.filter((p) => p.imageId.startsWith('near-'))
    expect(offered.length).toBeGreaterThan(0)
    expect(offered[0]!.reasons[0]).toContain('just outside this collection')
    const few = curate({ candidates, vectors, count: 30 })
    expect(few.shortfall).toContain('More good choices')
    expect(result.leftOut.some((l) => l.imageId.startsWith('near-'))).toBe(false)
  })

  it('says plainly when there is nothing to learn the user\'s taste from', () => {
    const { candidates, vectors } = mixed()
    const result = curate({ candidates, vectors, count: 5 })
    expect(result.tasteBasis).toContain('no favorites')
  })

  it('handles an empty or tiny collection without padding', () => {
    expect(curate({ candidates: [], vectors: [], count: 10 }).picks).toEqual([])
    const one = curate({ candidates: [candidate('a')], vectors: [near(0, 1)], count: 10 })
    expect(one.picks).toHaveLength(1)
    expect(one.shortfall).not.toBeNull()
  })
})
