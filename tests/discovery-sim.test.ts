import { existsSync, appendFileSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConceptSpace } from '../src/main/conceptSpace'
import { AtlasDatabase } from '../src/main/db'
import { DiscoveryEngine } from '../src/main/discovery'
import { IdentityEngine } from '../src/main/identity'
import { JourneyEngine } from '../src/main/journeys'
import { ReferenceCollection } from '../src/main/reference'
import { SemanticSearch } from '../src/main/semantic'
import { mulberry32, scoreAll, trainPreferenceModel } from '../src/main/taste'

/**
 * Simulated users on the REAL shipped reference collection (1,100+ real artworks and their SigLIP embeddings).
 * A user's taste is defined by the museum shelves they like (metadata the model never sees); 20% of the works on a
 * liked shelf are "not to their taste" and answers are noisy. Skipped when the collection is not built.
 */
const PACK = join(process.cwd(), 'reference')
const HAVE_PACK = existsSync(join(PACK, 'manifest.json'))
const LOG = join(tmpdir(), 'noema-discovery-sim.log')

const PERSONAS: Array<{ name: string; groups: string[][]; minAuc100: number; minAuc40Gain?: number; minLift: number }> = [
  { name: 'overlapping tastes (landscape+prints / prints+Asian)', groups: [['romantic-landscape', 'dutch-landscape', 'european-prints'], ['european-prints', 'ukiyo-e', 'chinese-painting']], minAuc100: 0.82, minAuc40Gain: 0.02, minLift: 2 },
  { name: 'one taste (baroque, renaissance, portraits)', groups: [['baroque', 'renaissance', 'portrait']], minAuc100: 0.85, minLift: 3 },
  { name: 'a small specialised taste (ukiyo-e only)', groups: [['ukiyo-e']], minAuc100: 0.95, minLift: 6 },
  { name: 'three unrelated tastes (romantic landscape / architecture / abstraction)', groups: [['romantic-landscape', 'impressionism', 'post-impressionism'], ['architecture', 'photo-early-modern'], ['abstraction', 'modern-sculpture', 'early-modern']], minAuc100: 0.7, minLift: 1.8 }
]

function auc(scores: Float32Array, liked: boolean[]): number {
  const idx = Array.from(scores.keys()).sort((a, b) => scores[a]! - scores[b]!)
  let sum = 0
  let pos = 0
  idx.forEach((row, rank) => {
    if (liked[row]) {
      sum += rank + 1
      pos += 1
    }
  })
  const neg = scores.length - pos
  return pos && neg ? (sum - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5
}

const pooled = { hits: 0, expected: 0, steps: 0 }

describe.skipIf(!HAVE_PACK)('simulated users on the real reference collection', () => {
  const ref = HAVE_PACK ? ReferenceCollection.load(PACK) : null

  for (const persona of PERSONAS) {
    it(persona.name, async () => {
      const r = ref!
      const dir = join(tmpdir(), `noema-sim-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      await fs.mkdir(dir, { recursive: true })
      const db = new AtlasDatabase(join(dir, 'library.db'))
      try {
        const concepts = new ConceptSpace(null, r)
        const engine = new DiscoveryEngine(db, r, concepts)
        const modeOf = r.works.map((w) => persona.groups.findIndex((g) => g.includes(w.shelf)))
        const liked = r.works.map((_, i) => modeOf[i]! >= 0 && mulberry32(i * 31 + 7)() > 0.2)
        const base = liked.filter(Boolean).length / liked.length
        const rng = mulberry32(77)
        const out: string[] = [`\n== ${persona.name}: ${(base * 100).toFixed(0)}% of the collection is to their taste`]
        let auc40Mixed = 0
        let auc40Linear = 0
        let pair = await engine.nextPair()
        for (let n = 1; n <= 100 && pair; n += 1) {
          const la = liked[r.rowOf.get(pair.a.id)!]!
          const lb = liked[r.rowOf.get(pair.b.id)!]!
          const roll = rng()
          let response: 'prefer' | 'both' | 'neither' | 'undecided'
          if (la && lb) response = roll < 0.8 ? 'both' : 'prefer'
          else if (!la && !lb) response = roll < 0.8 ? 'neither' : roll < 0.9 ? 'undecided' : 'prefer'
          else response = roll < 0.9 ? 'prefer' : 'undecided'
          const winner = response === 'prefer' ? (la && !lb ? pair.a.id : lb && !la ? pair.b.id : rng() < 0.5 ? pair.a.id : pair.b.id) : null
          pair = (await engine.respond(pair.a.id, pair.b.id, response, winner)).next
          if (n === 40 || n === 100) {
            const ev = engine.evidence()
            const mixed = auc(engine.scores(ev)!, liked)
            const linear = auc(scoreAll(r.matrix, r.dim, trainPreferenceModel(r.matrix, r.dim, ev.pairs.map((p) => ({ ...p })), { lambda: 0.1 })), liked)
            out.push(`n=${n}: ranking quality (AUC) mixed model ${mixed.toFixed(3)}, existing linear model ${linear.toFixed(3)}`)
            if (n === 40) {
              auc40Mixed = mixed
              auc40Linear = linear
            } else {
              expect(mixed).toBeGreaterThanOrEqual(persona.minAuc100)
            }
          }
        }
        expect(auc40Mixed).toBeGreaterThanOrEqual(auc40Linear - 0.01) // never worse than the existing linear model
        if (persona.minAuc40Gain) expect(auc40Mixed - auc40Linear).toBeGreaterThanOrEqual(persona.minAuc40Gain)

        // Recommendations: unseen works with the highest predicted appeal.
        const ev = engine.evidence()
        const scores = engine.scores(ev)!
        const top = Array.from(scores.keys()).filter((row) => !ev.shown.has(row)).sort((a, b) => scores[b]! - scores[a]!).slice(0, 24)
        const hit = top.filter((row) => liked[row]).length / 24
        out.push(`top 24 unseen works: ${(hit * 100).toFixed(0)}% to their taste (${(hit / base).toFixed(1)}x the base rate)`)
        expect(hit / base).toBeGreaterThanOrEqual(persona.minLift)

        // Journeys: the opening is familiar, the stretch is a real step beyond, and it still pays off more than chance.
        const identity = new IdentityEngine(db, new SemanticSearch(db, async () => { throw new Error('none') }), r, concepts, () => false)
        const journeys = new JourneyEngine(db, r, concepts, engine, identity)
        const state = await engine.state()
        out.push(`directions found: ${state.modes.length} (${state.modes.map((m) => m.size).join(', ')} liked works)`)
        const suggestions = await journeys.suggestions()
        const seeds = suggestions.filter((s) => s.seed.kind === 'mode' || s.seed.kind === 'emerging')
        expect(seeds.length).toBeGreaterThan(0)
        // More journeys give the stretch comparison some statistical power: also start from single liked works and from unexplored areas.
        const likedRows = Array.from(ev.liked)
        const extraSeeds = [
          ...suggestions.filter((s) => s.seed.kind === 'unexplored'),
          ...[0, 1, 2].map((k) => ({ seed: { kind: 'work' as const, label: 'liked work', ref: r.works[likedRows[Math.floor((likedRows.length * (k + 0.5)) / 3)]!]!.id } }))
        ]
        let opening = 0
        let openingN = 0
        let stretch = 0
        let stretchN = 0
        let share = 0
        const shares: number[] = []
        for (const seed of [...seeds.slice(0, 3), ...extraSeeds]) {
          const j = await journeys.create(seed.seed)
          shares.push(j.explorationShare)
          if (seed.seed.kind === 'unexplored' || seed.seed.kind === 'work') {
            // not an opening-quality measure for these seeds
          } else for (const w of j.chapters[0]!.works) { openingN += 1; if (liked[r.rowOf.get(w.work.id)!]) opening += 1 }
          for (const c of j.chapters.filter((x) => x.stretch)) for (const w of c.works) { stretchN += 1; if (liked[r.rowOf.get(w.work.id)!]) stretch += 1 }
        }
        share = shares.reduce((a, b) => a + b, 0) / shares.length
        // The fair yardstick for a stretch is a random work outside the regions the user has confirmed.
        const confirmed = new Set<number>()
        for (const row of ev.liked) confirmed.add(r.works[row]!.region)
        const outside = r.works.map((w, i) => (!confirmed.has(w.region) ? i : -1)).filter((i) => i >= 0)
        const outsideBase = outside.filter((i) => liked[i]).length / Math.max(1, outside.length)
        out.push(`random works outside confirmed regions: ${(outsideBase * 100).toFixed(1)}% to their taste`)
        out.push(`journeys: opening works to their taste ${(opening / openingN * 100).toFixed(0)}%; stretch works to their taste ${stretchN ? (stretch / stretchN * 100).toFixed(0) : '-'}% (random would be ${(base * 100).toFixed(0)}%); ${(share * 100).toFixed(0)}% of works outside confirmed regions`)
        expect(opening / openingN).toBeGreaterThan(base) // the start is near what they like
        pooled.hits += stretch
        pooled.expected += stretchN * outsideBase
        pooled.steps += stretchN
        expect(share).toBeGreaterThan(0.2) // and it does not stay in the bubble
        appendFileSync(LOG, out.join('\n') + '\n')
      } finally {
        db.close()
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
      }
    }, 600_000)
  }

  it('stretch steps find new tastes more often than random steps out of the comfort zone (pooled over all users)', () => {
    appendFileSync(LOG, `
pooled stretch: ${pooled.hits} works to their taste in ${pooled.steps} stretch steps; a random step outside the confirmed regions would have found ${pooled.expected.toFixed(1)}
`)
    expect(pooled.steps).toBeGreaterThan(20)
    expect(pooled.hits).toBeGreaterThanOrEqual(pooled.expected * 1.2)
  })
})
