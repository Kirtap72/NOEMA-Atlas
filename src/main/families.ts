import { randomUUID } from 'node:crypto'
import type { ArchivedFamily, AtlasDatabase, FamilyNameInfo, FamilyToSave, StoredFamily } from './db'
import { EMBEDDING_MODEL, type Embedder } from './embedder'
import { FAMILY_VOCABULARY } from './familyVocabulary'
import { computeBaseline, nameFamily, uniqueNames, type FamilyName, type VocabVectors } from './familyNames'

export interface FamilyDraft {
  cohesion: number
  members: Array<{ id: string; score: number }>
  /** Unit-length mean of the members' vectors. */
  centroid: Float32Array
}

export interface ClusterOptions {
  /** Smallest group that counts as a family. Smaller groups are left unassigned. */
  minSize?: number
  maxIterations?: number
  seed?: number
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export function familyCount(n: number): number {
  return Math.max(2, Math.min(120, Math.round(Math.sqrt(n / 2))))
}

/** Centroids are fitted on at most this many images; everything is then assigned to them in one pass. */
const FIT_SAMPLE = 4000

function dot(matrix: Float32Array, row: number, vector: Float32Array, dim: number): number {
  let sum = 0
  const base = row * dim
  for (let i = 0; i < dim; i += 1) sum += matrix[base + i]! * vector[i]!
  return sum
}

/** Spherical k-means on `n` unit vectors. Returns unit-length centroids. */
async function fitCentroids(
  matrix: Float32Array,
  n: number,
  dim: number,
  k: number,
  random: () => number,
  maxIterations: number
): Promise<Float32Array[]> {
  // k-means++ initialisation.
  const centroids: Float32Array[] = []
  const first = Math.floor(random() * n)
  centroids.push(matrix.slice(first * dim, (first + 1) * dim))
  const nearest = new Float32Array(n).fill(-Infinity)
  const weights = new Float32Array(n)
  while (centroids.length < k) {
    const last = centroids[centroids.length - 1]!
    let total = 0
    for (let row = 0; row < n; row += 1) {
      nearest[row] = Math.max(nearest[row]!, dot(matrix, row, last, dim))
      weights[row] = Math.max(0, 1 - nearest[row]!) ** 2
      total += weights[row]!
    }
    let pick = random() * total
    let chosen = n - 1
    for (let row = 0; row < n; row += 1) {
      pick -= weights[row]!
      if (pick <= 0) {
        chosen = row
        break
      }
    }
    centroids.push(matrix.slice(chosen * dim, (chosen + 1) * dim))
    if (centroids.length % 4 === 0) await yieldToEventLoop()
  }

  const assign = new Int32Array(n).fill(-1)
  const score = new Float32Array(n)
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = 0
    for (let row = 0; row < n; row += 1) {
      let best = 0
      let bestScore = -Infinity
      for (let c = 0; c < k; c += 1) {
        const value = dot(matrix, row, centroids[c]!, dim)
        if (value > bestScore) {
          bestScore = value
          best = c
        }
      }
      score[row] = bestScore
      if (assign[row] !== best) {
        assign[row] = best
        changed += 1
      }
      if (row % 500 === 499) await yieldToEventLoop()
    }
    if (changed <= n * 0.005) break

    const sums = Array.from({ length: k }, () => new Float32Array(dim))
    const counts = new Int32Array(k)
    for (let row = 0; row < n; row += 1) {
      const sum = sums[assign[row]!]!
      const base = row * dim
      for (let i = 0; i < dim; i += 1) sum[i]! += matrix[base + i]!
      counts[assign[row]!] = (counts[assign[row]!] ?? 0) + 1
    }
    for (let c = 0; c < k; c += 1) {
      const sum = sums[c]!
      if (counts[c] === 0) {
        // Re-seed an empty cluster with the worst-fitting image.
        let worst = 0
        for (let row = 1; row < n; row += 1) if (score[row]! < score[worst]!) worst = row
        centroids[c] = matrix.slice(worst * dim, (worst + 1) * dim)
        continue
      }
      let norm = 0
      for (let i = 0; i < dim; i += 1) norm += sum[i]! * sum[i]!
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < dim; i += 1) sum[i]! /= norm
      centroids[c] = sum
    }
  }
  return centroids
}

/**
 * Spherical k-means over unit vectors (cosine similarity), seeded so the same library gives the same
 * families. Centroids are fitted on a sample for large libraries, then every image is assigned to its nearest
 * centroid. Yields to the event loop regularly so the interface stays responsive.
 */
export async function clusterFamilies(
  ids: string[],
  dim: number,
  matrix: Float32Array,
  options: ClusterOptions = {}
): Promise<FamilyDraft[]> {
  const n = ids.length
  const minSize = options.minSize ?? 3
  if (n < minSize * 2 || dim === 0) return []
  const k = Math.min(familyCount(n), Math.floor(n / minSize))
  const random = mulberry32(options.seed ?? 20260101)

  let fitMatrix = matrix
  let fitCount = n
  if (n > FIT_SAMPLE) {
    const order = Uint32Array.from({ length: n }, (_, i) => i)
    for (let i = 0; i < FIT_SAMPLE; i += 1) {
      const j = i + Math.floor(random() * (n - i))
      const swap = order[i]!
      order[i] = order[j]!
      order[j] = swap
    }
    fitMatrix = new Float32Array(FIT_SAMPLE * dim)
    for (let i = 0; i < FIT_SAMPLE; i += 1) fitMatrix.set(matrix.subarray(order[i]! * dim, (order[i]! + 1) * dim), i * dim)
    fitCount = FIT_SAMPLE
  }
  const centroids = await fitCentroids(fitMatrix, fitCount, dim, k, random, options.maxIterations ?? 20)

  const assign = new Int32Array(n)
  const score = new Float32Array(n)
  for (let row = 0; row < n; row += 1) {
    let best = 0
    let bestScore = -Infinity
    for (let c = 0; c < k; c += 1) {
      const value = dot(matrix, row, centroids[c]!, dim)
      if (value > bestScore) {
        bestScore = value
        best = c
      }
    }
    assign[row] = best
    score[row] = bestScore
    if (row % 500 === 499) await yieldToEventLoop()
  }

  const groups = new Map<number, Array<{ id: string; score: number; row: number }>>()
  for (let row = 0; row < n; row += 1) {
    const list = groups.get(assign[row]!) ?? []
    list.push({ id: ids[row]!, score: score[row]!, row })
    groups.set(assign[row]!, list)
  }
  const families: FamilyDraft[] = []
  for (const members of groups.values()) {
    if (members.length < minSize) continue
    members.sort((a, b) => b.score - a.score)
    const cohesion = members.reduce((sum, m) => sum + m.score, 0) / members.length
    const centroid = new Float32Array(dim)
    for (const m of members) for (let i = 0; i < dim; i += 1) centroid[i]! += matrix[m.row * dim + i]!
    let norm = 0
    for (let i = 0; i < dim; i += 1) norm += centroid[i]! * centroid[i]!
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < dim; i += 1) centroid[i]! /= norm
    families.push({ cohesion, members: members.map((m) => ({ id: m.id, score: m.score })), centroid })
  }
  families.sort((a, b) => b.members.length - a.members.length || b.cohesion - a.cohesion)
  return families
}

export interface FamilyBuildResult {
  families: number
  images: number
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += a[i]! * b[i]!
  return sum
}

/** A family is the same family again when it still has most of its images, or sits in the same place. */
const MATCH_THRESHOLD = 0.4
/** A renamed family that vanished comes back for a new family that sits this close to where it was. */
const ARCHIVE_MATCH_COSINE = 0.93

/**
 * Pairs each new family with the old family it continues, one to one, strongest overlap first. A pair needs a shared
 * majority of members (Jaccard overlap) or a very similar centre; when a family is split, its largest part keeps it.
 * Returns, for each new family, the index of the old family it continues, or -1.
 */
export function matchFamilies(
  old: Array<{ memberIds: Set<string>; centroid: Float32Array | null }>,
  drafts: Array<{ members: Array<{ id: string }>; centroid: Float32Array }>
): number[] {
  const candidates: Array<{ d: number; o: number; score: number }> = []
  drafts.forEach((draft, d) => {
    const ids = draft.members
    old.forEach((family, o) => {
      let shared = 0
      for (const member of ids) if (family.memberIds.has(member.id)) shared += 1
      const union = ids.length + family.memberIds.size - shared
      const jaccard = union > 0 ? shared / union : 0
      const contained = Math.min(1, shared / Math.max(1, Math.min(ids.length, family.memberIds.size)))
      const near = family.centroid ? Math.max(0, Math.min(1, (cosine(family.centroid, draft.centroid) - 0.85) / 0.13)) : 0
      // Overlap is the main evidence; the centre only helps when some images are shared.
      const score = Math.max(jaccard, shared > 0 ? 0.5 * contained + 0.5 * near * contained : 0)
      if (score >= MATCH_THRESHOLD) candidates.push({ d, o, score })
    })
  })
  candidates.sort((a, b) => b.score - a.score)
  const result = drafts.map(() => -1)
  const taken = new Set<number>()
  for (const c of candidates) {
    if (result[c.d] !== -1 || taken.has(c.o)) continue
    result[c.d] = c.o
    taken.add(c.o)
  }
  return result
}

let vocabCache: { terms: typeof FAMILY_VOCABULARY; vectors: Float32Array; dim: number } | null = null

/** Embeds the vocabulary once per run with the local text model. */
export async function loadVocabulary(embedder: Embedder): Promise<Pick<VocabVectors, 'terms' | 'vectors' | 'dim'>> {
  if (vocabCache) return vocabCache
  const embedded = await embedder.embedTexts(FAMILY_VOCABULARY.map((term) => term.prompt))
  const dim = embedded[0]?.length ?? 0
  const vectors = new Float32Array(embedded.length * dim)
  embedded.forEach((vector, i) => vectors.set(vector, i * dim))
  vocabCache = { terms: FAMILY_VOCABULARY, vectors, dim }
  return vocabCache
}

function toInfo(name: FamilyName): FamilyNameInfo {
  return { confidence: name.confidence, keywords: name.keywords, note: name.note, basis: name.basis }
}

/**
 * Keeps an earlier automatic name while it still describes the family (their main subjects agree), so names do not
 * flicker between regroupings; otherwise takes the freshly made one.
 */
function steadyName(previous: StoredFamily | null, fresh: FamilyName): { name: string; info: FamilyNameInfo } {
  const info = toInfo(fresh)
  if (previous?.autoName && previous.nameInfo && previous.nameInfo.confidence !== 'mixed' && fresh.confidence !== 'mixed') {
    const before = previous.nameInfo.basis[0]
    if (before && info.basis.includes(before)) return { name: previous.autoName.replace(/ \(\S.*\)$| \(\d+\)$/, ''), info: previous.nameInfo }
  }
  return { name: fresh.name, info }
}

/**
 * Clusters the stored embeddings, names the families from what their images share, recognises families from the last
 * grouping (so the user's own names and the identity of each family survive) and replaces the saved result.
 * `getEmbedder` is optional: without the model, families are saved unnamed and shown as "Family NN".
 */
export async function rebuildFamilies(db: AtlasDatabase, getEmbedder?: () => Promise<Embedder>): Promise<FamilyBuildResult> {
  const { ids, dim, matrix } = db.loadEmbeddingMatrix(EMBEDDING_MODEL)
  const drafts = await clusterFamilies(ids, dim, matrix)
  const stored = db.loadStoredFamilies(EMBEDDING_MODEL)
  const archive = db.loadFamilyArchive(EMBEDDING_MODEL)

  // Names from the local model.
  let names: Array<FamilyName | null> = drafts.map(() => null)
  if (getEmbedder && drafts.length > 0) {
    try {
      const vocab = await loadVocabulary(await getEmbedder())
      if (vocab.dim === dim) {
        const baseline = computeBaseline(matrix, ids.length, vocab)
        const full: VocabVectors = { ...vocab, baseline }
        const rowOf = new Map(ids.map((id, i) => [id, i]))
        names = []
        for (const draft of drafts) {
          const m = draft.members.slice(0, 400)
          const block = new Float32Array(m.length * dim)
          m.forEach((member, i) => block.set(matrix.subarray(rowOf.get(member.id)! * dim, (rowOf.get(member.id)! + 1) * dim), i * dim))
          names.push(nameFamily(block, m.length, full, { cohesion: draft.cohesion }))
          if (names.length % 8 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        }
      }
    } catch {
      names = drafts.map(() => null)
    }
  }

  const matched = matchFamilies(stored, drafts)
  const usedArchive = new Set<string>()
  const saved: FamilyToSave[] = drafts.map((draft, i) => {
    const previous = matched[i]! >= 0 ? stored[matched[i]!]! : null
    let stableId = previous?.stableId ?? null
    let customName = previous?.customName ?? null
    if (!previous) {
      // A renamed family that had vanished may have come back.
      let best: ArchivedFamily | null = null
      let bestCos = ARCHIVE_MATCH_COSINE
      for (const entry of archive) {
        if (usedArchive.has(entry.stableId)) continue
        const c = cosine(entry.centroid, draft.centroid)
        if (c >= bestCos) {
          bestCos = c
          best = entry
        }
      }
      if (best) {
        usedArchive.add(best.stableId)
        stableId = best.stableId
        customName = best.customName
      }
    }
    const fresh = names[i]
    const steady = fresh ? steadyName(previous, fresh) : null
    return {
      cohesion: draft.cohesion,
      members: draft.members,
      stableId: stableId ?? randomUUID(),
      autoName: steady?.name ?? null,
      customName,
      nameInfo: steady?.info ?? null,
      centroid: draft.centroid
    }
  })

  // Automatic names must be unique, so two families are never told apart only by position.
  if (names.every((n) => n !== null)) {
    const unique = uniqueNames(saved.map((family, i) => ({ ...names[i]!, name: family.autoName ?? '' })))
    unique.forEach((name, i) => (saved[i]!.autoName = name))
  } else {
    // Without names the column stays empty so the family can be named later.
    for (const family of saved) family.autoName = null
  }

  // Families the user renamed that are not in the new list wait in the archive.
  const keep = new Set(saved.map((family) => family.stableId))
  const toArchive: ArchivedFamily[] = [
    ...archive.filter((entry) => !usedArchive.has(entry.stableId)),
    ...stored
      .filter((family) => family.customName && family.stableId && family.centroid && !keep.has(family.stableId))
      .map((family) => ({ stableId: family.stableId!, customName: family.customName!, centroid: family.centroid! }))
  ]
  db.replaceFamilies(EMBEDDING_MODEL, saved, ids.length, toArchive)
  return { families: drafts.length, images: drafts.reduce((sum, family) => sum + family.members.length, 0) }
}
