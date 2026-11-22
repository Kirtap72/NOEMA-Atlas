import type { AtlasDatabase, PendingEmbedding } from './db'
import { EMBEDDING_MODEL, Embedder, missingModelFiles, modelDirectory, preprocessImage } from './embedder'
import { thumbnailPath } from './media'
import type { IndexState, IndexStatus } from '../shared/types'

const BATCH_SIZE = 16
/** How many pending images are fetched from the database at once; the queue then works through them. */
const QUEUE_WINDOW = 256
/** Counting every embedded image is a full join, so the totals are cached and refreshed at most this often. */
const STATS_TTL_MS = 3000
const STATUS_INTERVAL_MS = 400

export interface IndexerOptions {
  dataDir: string
  thumbnailsDir: string
  enabled: boolean
  onStatus: (status: IndexStatus) => void
  /** Called after a batch of embeddings has been stored. */
  onSaved?: () => void
  /** Called when a run has worked through the whole queue (not when it was paused or disabled). */
  onFinished?: () => void
  /** Overridable for tests. */
  loadEmbedder?: (modelDir: string) => Promise<Embedder>
}

/**
 * Background embedding queue. It reads only Atlas's own previews (never the originals), works through
 * images that lack a current embedding, and can be paused, disabled and resumed at any time.
 */
export class Indexer {
  private enabled: boolean
  private paused = false
  private running = false
  private stopped = false
  private embedder: Embedder | null = null
  private state: IndexState = 'idle'
  private message: string | null = null
  private failed = new Set<string>()
  private rate = 0
  private lastEmit = 0
  private modelDir: string
  private idle: Promise<void> = Promise.resolve()
  private loading: Promise<Embedder> | null = null
  private stats = { indexed: 0, eligible: 0 }
  private statsAt = 0

  constructor(
    private db: AtlasDatabase,
    private options: IndexerOptions
  ) {
    this.enabled = options.enabled
    this.modelDir = modelDirectory(options.dataDir)
    this.state = this.computeIdleState()
  }

  private computeIdleState(): IndexState {
    if (!this.enabled) return 'disabled'
    if (missingModelFiles(this.modelDir).length > 0) return 'unavailable'
    return 'idle'
  }

  /** True when visual search can answer queries: switched on and the model files are present. Cheap. */
  get searchable(): boolean {
    return this.enabled && missingModelFiles(this.modelDir).length === 0
  }

  private refreshStats(force = false): void {
    const now = Date.now()
    if (!force && now - this.statsAt < STATS_TTL_MS) return
    this.statsAt = now
    this.stats = this.db.getEmbeddingStats(EMBEDDING_MODEL)
  }

  get status(): IndexStatus {
    this.refreshStats(this.state !== 'running')
    const stats = this.stats
    return {
      state: this.state,
      enabled: this.enabled,
      modelInstalled: missingModelFiles(this.modelDir).length === 0,
      provider: this.embedder?.provider ?? null,
      indexed: stats.indexed,
      total: stats.eligible,
      imagesPerSecond: Math.round(this.rate * 10) / 10,
      message: this.message
    }
  }

  /** Resolves when the current run (if any) has finished. */
  whenIdle(): Promise<void> {
    return this.idle
  }

  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < STATUS_INTERVAL_MS) return
    this.lastEmit = now
    this.options.onStatus(this.status)
  }

  setEnabled(enabled: boolean): IndexStatus {
    this.enabled = enabled
    if (!enabled) {
      if (!this.running) this.state = 'disabled'
      this.message = null
    } else {
      if (!this.running) this.state = this.computeIdleState()
      this.kick()
    }
    this.emit(true)
    return this.status
  }

  pause(): IndexStatus {
    this.paused = true
    if (this.running) this.state = 'paused'
    this.emit(true)
    return this.status
  }

  resume(): IndexStatus {
    this.paused = false
    this.kick()
    this.emit(true)
    return this.status
  }

  /** Starts work if there is any. Safe to call as often as you like. */
  kick(): void {
    if (this.running || this.stopped || !this.enabled || this.paused) return
    if (missingModelFiles(this.modelDir).length > 0) {
      this.state = 'unavailable'
      this.emit(true)
      return
    }
    if (this.db.getPendingEmbeddings(EMBEDDING_MODEL, 1, this.failed).length === 0) {
      if (this.state !== 'error') this.state = 'idle'
      this.emit(true)
      this.options.onFinished?.()
      return
    }
    this.running = true
    this.idle = this.run().finally(() => {
      this.running = false
      this.emit(true)
    })
  }

  /** The loaded model, starting it on first use. Shared by indexing and search. */
  ensureEmbedder(): Promise<Embedder> {
    if (this.embedder) return Promise.resolve(this.embedder)
    if (!this.loading) {
      this.loading = (this.options.loadEmbedder ?? ((dir) => Embedder.load(dir)))(this.modelDir)
        .then((embedder) => {
          this.embedder = embedder
          return embedder
        })
        .finally(() => {
          this.loading = null
        })
    }
    return this.loading
  }

  private shouldContinue(): boolean {
    return this.enabled && !this.paused && !this.stopped
  }

  private async run(): Promise<void> {
    try {
      if (!this.embedder) {
        this.state = 'loading'
        this.message = 'Starting the image model…'
        this.emit(true)
      }
      await this.ensureEmbedder()
      this.state = 'running'
      this.message = null
      this.emit(true)

      let windowStart = Date.now()
      let windowCount = 0
      let window: PendingEmbedding[] = []
      while (this.shouldContinue()) {
        if (window.length === 0) window = this.db.getPendingEmbeddings(EMBEDDING_MODEL, QUEUE_WINDOW, this.failed)
        if (window.length === 0) break
        const pending = window.splice(0, BATCH_SIZE)

        const prepared = await Promise.all(
          pending.map(async (item) => {
            try {
              return { item, pixels: await preprocessImage(thumbnailPath(this.options.thumbnailsDir, item.id)) }
            } catch {
              this.failed.add(item.id)
              return null
            }
          })
        )
        const ok = prepared.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        if (ok.length > 0) {
          try {
            const vectors = await (this.embedder as Embedder).embedImages(ok.map((entry) => entry.pixels))
            this.db.saveEmbeddings(
              EMBEDDING_MODEL,
              ok.map((entry, index) => ({ id: entry.item.id, mtime: entry.item.mtime, vector: vectors[index]! }))
            )
            windowCount += ok.length
            this.stats = { ...this.stats, indexed: Math.min(this.stats.eligible, this.stats.indexed + ok.length) }
            this.options.onSaved?.()
          } catch (error) {
            for (const entry of ok) this.failed.add(entry.item.id)
            this.message = error instanceof Error ? error.message : 'A batch of images could not be indexed.'
          }
        }
        const elapsed = (Date.now() - windowStart) / 1000
        if (elapsed >= 1) {
          this.rate = windowCount / elapsed
          windowStart = Date.now()
          windowCount = 0
        }
        this.emit()
      }
      this.rate = 0
      const completed = this.shouldContinue()
      this.state = this.paused ? 'paused' : this.enabled ? 'idle' : 'disabled'
      if (completed) this.options.onFinished?.()
    } catch (error) {
      this.state = 'error'
      this.message = error instanceof Error ? error.message : 'The image index could not be started.'
    }
  }

  /** Releases the loaded model (and its file handles) without shutting the indexer down. */
  async unload(): Promise<void> {
    await this.idle.catch(() => undefined)
    const embedder = this.embedder
    this.embedder = null
    await embedder?.dispose()
  }

  async dispose(): Promise<void> {
    this.stopped = true
    await this.idle.catch(() => undefined)
    const embedder = this.embedder
    this.embedder = null
    await embedder?.dispose()
  }
}
