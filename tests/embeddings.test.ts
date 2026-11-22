import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'
import { EMBEDDING_MODEL, Embedder, MODEL_FILES, missingModelFiles, modelDirectory, preprocessImage } from '../src/main/embedder'
import { Indexer } from '../src/main/indexer'
import type { IndexStatus } from '../src/shared/types'

sharp.cache(false)

let workDir = ''
let db: AtlasDatabase | null = null
let rootId = ''

function record(path: string, overrides: Partial<ScannedImageRecord> = {}): ScannedImageRecord {
  return {
    id: imageIdForPath(path),
    rootId,
    path,
    folder: join(workDir, 'images'),
    filename: path.split(/[\\/]/).pop() ?? 'image.png',
    ext: 'png',
    bytes: 1024,
    width: 64,
    height: 64,
    orientation: 1,
    mtime: 1_700_000_000_000,
    color: '#808080',
    thumbStatus: 'ready',
    thumbError: null,
    scanToken: 'test-token',
    ...overrides
  }
}

async function addImage(name: string, rgb: [number, number, number], overrides: Partial<ScannedImageRecord> = {}): Promise<string> {
  const path = join(workDir, 'images', name)
  const rec = record(path, overrides)
  db!.upsertScannedImage(rec)
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
    .webp()
    .toFile(join(workDir, 'thumbs', `${rec.id}.webp`))
  return rec.id
}

beforeEach(async () => {
  workDir = join(tmpdir(), `noema-embed-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(join(workDir, 'images'), { recursive: true })
  await fs.mkdir(join(workDir, 'thumbs'), { recursive: true })
  db = new AtlasDatabase(join(workDir, 'library.db'))
  rootId = db.addRoot(join(workDir, 'images')).id
})

afterEach(async () => {
  db?.close()
  db = null
  delete process.env.NOEMA_MODELS_DIR
  await new Promise((resolve) => setTimeout(resolve, 120))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const unit = (values: number[]): Float32Array => {
  const v = new Float32Array(values)
  const n = Math.hypot(...values)
  return v.map((x) => x / n)
}

describe('embedding storage', () => {
  it('queues new and changed images, and drops embeddings with their image', async () => {
    const a = await addImage('a.png', [200, 0, 0])
    const b = await addImage('b.png', [0, 0, 200], { mtime: 1_700_000_000_500 })

    expect(db!.getEmbeddingStats(EMBEDDING_MODEL)).toEqual({ eligible: 2, indexed: 0 })
    expect(db!.getPendingEmbeddings(EMBEDDING_MODEL, 10).map((p) => p.id).sort()).toEqual([a, b].sort())
    expect(db!.getPendingEmbeddings(EMBEDDING_MODEL, 10, new Set([a])).map((p) => p.id)).toEqual([b])

    db!.saveEmbeddings(EMBEDDING_MODEL, [
      { id: a, mtime: 1_700_000_000_000, vector: unit([1, 0, 0]) },
      { id: b, mtime: 1_700_000_000_500, vector: unit([0, 1, 0]) }
    ])
    expect(db!.getEmbeddingStats(EMBEDDING_MODEL)).toEqual({ eligible: 2, indexed: 2 })
    expect(db!.getPendingEmbeddings(EMBEDDING_MODEL, 10)).toEqual([])

    const loaded = db!.loadEmbeddingMatrix(EMBEDDING_MODEL)
    expect(loaded.dim).toBe(3)
    expect(loaded.ids.length).toBe(2)
    const row = loaded.ids.indexOf(a)
    expect(Array.from(loaded.matrix.slice(row * 3, row * 3 + 3))).toEqual([1, 0, 0])

    // A file that changed on disk is queued again, and its stale vector is not served.
    db!.upsertScannedImage(record(join(workDir, 'images', 'a.png'), { mtime: 1_700_000_009_999 }))
    expect(db!.getPendingEmbeddings(EMBEDDING_MODEL, 10).map((p) => p.id)).toEqual([a])
    expect(db!.loadEmbeddingMatrix(EMBEDDING_MODEL).ids).toEqual([b])

    // Another model never sees these rows.
    expect(db!.getEmbeddingStats('other-model').indexed).toBe(0)

    db!.removeRoot(rootId)
    expect(db!.getEmbeddingStats(EMBEDDING_MODEL).indexed).toBe(0)
    expect(db!.loadEmbeddingMatrix(EMBEDDING_MODEL).ids).toEqual([])
  })

  it('prefers favourites and rated images when ordering the queue', async () => {
    await addImage('plain.png', [10, 10, 10])
    const loved = await addImage('loved.png', [20, 20, 20])
    db!.updateImage({ id: loved, favorite: true, rating: 5 })
    expect(db!.getPendingEmbeddings(EMBEDDING_MODEL, 1)[0]?.id).toBe(loved)
  })

  it('migrates a version 2 library to version 3 with a backup', async () => {
    db!.close()
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(join(workDir, 'library.db'))
    raw.exec("DROP TABLE embeddings; UPDATE schema_meta SET value = '2' WHERE key = 'version';")
    raw.close()
    db = new AtlasDatabase(join(workDir, 'library.db'))
    expect(db.getEmbeddingStats(EMBEDDING_MODEL)).toEqual({ eligible: 0, indexed: 0 })
    const backups = await fs.readdir(join(workDir, 'backups'))
    expect(backups.some((name) => name.startsWith('library-v2-'))).toBe(true)
  })
})

describe('Indexer', () => {
  async function setup(): Promise<{ modelsRoot: string }> {
    const modelsRoot = join(workDir, 'models')
    process.env.NOEMA_MODELS_DIR = modelsRoot
    const dir = modelDirectory(workDir)
    await fs.mkdir(dir, { recursive: true })
    for (const file of MODEL_FILES) await fs.writeFile(join(dir, file), 'stub')
    return { modelsRoot }
  }

  const fakeEmbedder = (log: number[] = []): Embedder =>
    ({
      provider: 'cpu',
      embedImages: async (batch: Float32Array[]) => {
        log.push(batch.length)
        return batch.map((pixels) => unit([1 + Math.abs(pixels[0]!), 1, 1]))
      },
      embedTexts: async () => [],
      dispose: async () => undefined
    }) as unknown as Embedder

  it('reports "unavailable" without a model and does not touch the queue', async () => {
    process.env.NOEMA_MODELS_DIR = join(workDir, 'nomodels')
    await addImage('a.png', [1, 2, 3])
    const statuses: IndexStatus[] = []
    const indexer = new Indexer(db!, {
      dataDir: workDir,
      thumbnailsDir: join(workDir, 'thumbs'),
      enabled: true,
      onStatus: (s) => statuses.push(s)
    })
    indexer.kick()
    await indexer.whenIdle()
    expect(indexer.status.state).toBe('unavailable')
    expect(indexer.status.modelInstalled).toBe(false)
    expect(indexer.status.indexed).toBe(0)
    await indexer.dispose()
  })

  it('embeds every image in batches, and is idempotent', async () => {
    await setup()
    for (let i = 0; i < 40; i += 1) await addImage(`img-${i}.png`, [i * 5, 100, 50])
    const batches: number[] = []
    const indexer = new Indexer(db!, {
      dataDir: workDir,
      thumbnailsDir: join(workDir, 'thumbs'),
      enabled: true,
      onStatus: () => undefined,
      loadEmbedder: async () => fakeEmbedder(batches)
    })
    indexer.kick()
    await indexer.whenIdle()
    expect(indexer.status).toMatchObject({ state: 'idle', indexed: 40, total: 40, provider: 'cpu' })
    expect(batches.reduce((a, b) => a + b, 0)).toBe(40)
    expect(Math.max(...batches)).toBeLessThanOrEqual(16)

    indexer.kick()
    await indexer.whenIdle()
    expect(batches.reduce((a, b) => a + b, 0)).toBe(40)
    await indexer.dispose()
  })

  it('can be paused, resumed and disabled without losing work, and skips unreadable previews', async () => {
    await setup()
    for (let i = 0; i < 48; i += 1) await addImage(`p-${i}.png`, [i, i, i])
    const broken = await addImage('broken.png', [0, 0, 0])
    await fs.writeFile(join(workDir, 'thumbs', `${broken}.webp`), 'not an image')

    let indexer!: Indexer
    let seen = 0
    let pausedOnce = false
    indexer = new Indexer(db!, {
      dataDir: workDir,
      thumbnailsDir: join(workDir, 'thumbs'),
      enabled: true,
      onStatus: () => undefined,
      loadEmbedder: async () => ({
        ...fakeEmbedder(),
        embedImages: async (batch: Float32Array[]) => {
          seen += batch.length
          if (seen >= 16 && !pausedOnce) {
            pausedOnce = true
            indexer.pause()
          }
          return batch.map(() => unit([1, 1, 1]))
        }
      }) as unknown as Embedder
    })
    indexer.kick()
    await indexer.whenIdle()
    expect(indexer.status.state).toBe('paused')
    const partial = indexer.status.indexed
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(48)

    indexer.resume()
    await indexer.whenIdle()
    expect(indexer.status.indexed).toBe(48) // the broken preview is skipped, not retried forever
    expect(indexer.status.state).toBe('idle')

    indexer.setEnabled(false)
    expect(indexer.status.state).toBe('disabled')
    await indexer.dispose()
  })
})

const realModelDir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'NOEMA Atlas', 'models', EMBEDDING_MODEL)
describe.skipIf(missingModelFiles(realModelDir).length > 0)('SigLIP model (real)', () => {
  it('runs on the GPU or CPU and matches text to colour', async () => {
    const embedder = await Embedder.load(realModelDir)
    try {
      const make = (r: number, g: number, b: number) =>
        sharp({ create: { width: 256, height: 256, channels: 3, background: { r, g, b } } }).png().toBuffer()
      const [red, blue] = await Promise.all([make(210, 20, 20), make(20, 30, 210)].map(async (p) => preprocessImage(await p)))
      const [imgRed, imgBlue] = await embedder.embedImages([red!, blue!])
      const [textRed, textBlue] = await embedder.embedTexts(['a plain red image', 'a plain blue image'])
      const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i]!, 0)
      expect(imgRed!.length).toBe(768)
      expect(dot(imgRed!, textRed!)).toBeGreaterThan(dot(imgRed!, textBlue!))
      expect(dot(imgBlue!, textBlue!)).toBeGreaterThan(dot(imgBlue!, textRed!))
      expect(['directml', 'cpu']).toContain(embedder.provider)
    } finally {
      await embedder.dispose()
    }
  }, 120_000)
})

describe('SemanticSearch', () => {
  it('keeps the best matches in order and skips the query row itself', async () => {
    const { topMatches } = await import('../src/main/semantic')
    const dim = 2
    const m = new Float32Array([1, 0, 0.9, 0.1, 0, 1, -1, 0])
    const best = topMatches(m, dim, new Float32Array([1, 0]), 2)
    expect(best.map((b) => b.row)).toEqual([0, 1])
    expect(topMatches(m, dim, new Float32Array([1, 0]), 2, 0).map((b) => b.row)).toEqual([1, 2])
    expect(topMatches(new Float32Array(0), 0, new Float32Array(0), 5)).toEqual([])
  })

  it('ranks text and similar-image queries and applies library filters', async () => {
    const { SemanticSearch } = await import('../src/main/semantic')
    const a = await addImage('a.png', [1, 1, 1])
    const b = await addImage('b.png', [2, 2, 2])
    const c = await addImage('c.png', [3, 3, 3])
    db!.saveEmbeddings(EMBEDDING_MODEL, [
      { id: a, mtime: 1_700_000_000_000, vector: unit([1, 0, 0]) },
      { id: b, mtime: 1_700_000_000_000, vector: unit([0.9, 0.3, 0]) },
      { id: c, mtime: 1_700_000_000_000, vector: unit([0, 1, 0]) }
    ])
    const embedder = { embedTexts: async () => [unit([1, 0, 0])] } as unknown as Embedder
    const search = new SemanticSearch(db!, async () => embedder)

    const byText = await search.query({ scope: 'archive', search: 'anything' }, 10, 0)
    expect(byText.items.map((i) => i.id)).toEqual([a, b, c])
    expect(byText.total).toBe(3)

    const similar = await search.query({ scope: 'archive', similarTo: c }, 10, 0)
    expect(similar.items.map((i) => i.id)).toEqual([b, a])

    db!.updateImage({ id: b, rating: 4 })
    const rated = await search.query({ scope: 'archive', search: 'x', minRating: 3 }, 10, 0)
    expect(rated.items.map((i) => i.id)).toEqual([b])

    const paged = await search.query({ scope: 'archive', search: 'x' }, 1, 1)
    expect(paged.items.map((i) => i.id)).toEqual([b])
    expect(paged.total).toBe(3)

    await expect(search.query({ scope: 'archive', similarTo: 'nope' }, 10, 0)).rejects.toThrow(/not been indexed/)
  })
})

describe('image families', () => {
  // Three well-separated directions in 8 dimensions, each with small deterministic jitter.
  function syntheticVectors(perGroup: number): { ids: string[]; matrix: Float32Array; group: number[] } {
    const dim = 8
    const ids: string[] = []
    const group: number[] = []
    const rows: number[][] = []
    for (let g = 0; g < 3; g += 1) {
      for (let i = 0; i < perGroup; i += 1) {
        const v = new Array(dim).fill(0)
        v[g] = 1
        v[(g + 3 + (i % 3)) % dim] += 0.08 * ((i % 5) / 5)
        const n = Math.hypot(...v)
        rows.push(v.map((x) => x / n))
        ids.push(`g${g}-${i}`)
        group.push(g)
      }
    }
    return { ids, matrix: new Float32Array(rows.flat()), group }
  }

  it('separates distinct groups, is deterministic, and leaves stragglers unassigned', async () => {
    const { clusterFamilies } = await import('../src/main/families')
    const { ids, matrix } = syntheticVectors(12)
    const first = await clusterFamilies(ids, 8, matrix)
    const second = await clusterFamilies(ids, 8, matrix)
    expect(second.map((f) => f.members.map((m) => m.id))).toEqual(first.map((f) => f.members.map((m) => m.id)))
    // Every family holds images from one source group only.
    for (const family of first) {
      expect(new Set(family.members.map((m) => m.id.split('-')[0])).size).toBe(1)
      expect(family.cohesion).toBeGreaterThan(0.95)
    }
    expect(first.reduce((sum, f) => sum + f.members.length, 0)).toBeGreaterThanOrEqual(30)
    // Largest first, members ordered most typical first.
    expect(first[0]!.members[0]!.score).toBeGreaterThanOrEqual(first[0]!.members.at(-1)!.score)

    expect(await clusterFamilies(ids.slice(0, 3), 8, matrix.slice(0, 24))).toEqual([])
  })

  it('stores families, serves them by id, and drops them with their images', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i += 1) ids.push(await addImage(`f${i}.png`, [i * 10, 0, 0]))
    db!.replaceFamilies(
      EMBEDDING_MODEL,
      [
        { cohesion: 0.9, members: ids.slice(0, 4).map((id, i) => ({ id, score: 0.95 - i * 0.1 })) },
        { cohesion: 0.8, members: ids.slice(4).map((id) => ({ id, score: 0.8 })) }
      ],
      6
    )
    expect(db!.getFamilyBuildInfo(EMBEDDING_MODEL)?.clustered).toBe(6)
    const families = db!.listFamilies(EMBEDDING_MODEL)
    expect(families.map((f) => f.size)).toEqual([4, 2])
    expect(families[0]!.covers.map((c) => c.id)).toEqual(ids.slice(0, 3))

    const page = db!.queryImages({ scope: 'archive', familyId: families[0]!.id, limit: 10 })
    expect(page.total).toBe(4)
    expect(page.items.map((i) => i.id)).toEqual(ids.slice(0, 4)) // most typical first

    // A rebuild replaces the previous result completely.
    db!.replaceFamilies(EMBEDDING_MODEL, [{ cohesion: 0.7, members: ids.map((id) => ({ id, score: 0.7 })) }], 6)
    expect(db!.listFamilies(EMBEDDING_MODEL).map((f) => f.size)).toEqual([6])

    db!.removeRoot(rootId)
    expect(db!.listFamilies(EMBEDDING_MODEL)).toEqual([])
  })
})
