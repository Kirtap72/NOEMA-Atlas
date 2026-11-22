import type { AtlasDatabase, SmartCollectionRow } from './db'
import { describeFile, encodeHues } from './imageStats'
import { thumbnailPath } from './media'
import { match, needsModel, toMeasured, type MatchResult } from './smartMatch'
import type { SemanticSearch } from './semantic'
import { COLOUR_OPTIONS, semanticText, criteriaAreEmpty, normalizeCriteria, strictnessWord, type SmartCollection, type SmartCollectionInput, type SmartCriteria, type SmartPreview } from '../shared/smart'

const COLOUR_LABEL = new Map(COLOUR_OPTIONS.map((option) => [option.id as string, option.label.toLowerCase()]))

/** Measures the colour of every image once, in the background, from Atlas's own previews. */
export class ImageStatsWorker {
  private running = false
  private failed = new Set<string>()
  private idle: Promise<void> = Promise.resolve()

  constructor(
    private db: AtlasDatabase,
    private thumbnailsDir: string,
    private onFinished: () => void
  ) {}

  whenIdle(): Promise<void> {
    return this.idle
  }

  kick(): void {
    if (this.running) return
    if (this.db.getPendingImageStats(1, this.failed).length === 0) return
    this.running = true
    this.idle = this.run().finally(() => {
      this.running = false
    })
  }

  private async run(): Promise<void> {
    try {
      for (;;) {
        const batch = this.db.getPendingImageStats(48, this.failed)
        if (batch.length === 0) break
        const rows = await Promise.all(
          batch.map(async (item) => {
            try {
              const stats = await describeFile(thumbnailPath(this.thumbnailsDir, item.id))
              return { id: item.id, mtime: item.mtime, lightness: stats.lightness, contrast: stats.contrast, saturation: stats.saturation, hues: encodeHues(stats.hues) }
            } catch {
              this.failed.add(item.id)
              return null
            }
          })
        )
        this.db.saveImageStats(rows.filter((row): row is NonNullable<typeof row> => row !== null))
        // Let the window breathe between batches.
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    } finally {
      this.onFinished()
    }
  }
}

export interface SmartServiceOptions {
  /** True when the image model is installed and switched on. */
  modelReady: () => boolean
  /** Called when the matches of any collection changed. */
  onChanged: () => void
}

/** Saved descriptions of how images look, matched against the library whenever it changes. */
export class SmartCollections {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private db: AtlasDatabase,
    private semantic: SemanticSearch,
    private options: SmartServiceOptions
  ) {}

  private async run(criteria: SmartCriteria, loose = false): Promise<MatchResult & { problem: string | null }> {
    const wantsModel = needsModel(criteria)
    if (criteriaAreEmpty(criteria)) {
      return { members: [], considered: 0, nothingFits: false, unmeasured: 0, cutoff: null, semantic: false, problem: null }
    }
    if (wantsModel && !this.options.modelReady()) {
      return {
        members: [],
        considered: 0,
        nothingFits: false,
        unmeasured: 0,
        cutoff: null,
        semantic: false,
        problem: 'Describing images in words needs the optional image model. Colour, tone and shape still work without it.'
      }
    }
    const { ids, dim, matrix } = this.semantic.snapshot()
    if (wantsModel && ids.length === 0) {
      return { members: [], considered: 0, nothingFits: false, unmeasured: 0, cutoff: null, semantic: true, problem: 'Atlas has not learned any images yet.' }
    }
    const spoken = semanticText(criteria)
    const text = spoken ? await this.semantic.embedText(spoken) : null
    const avoid = criteria.avoid && wantsModel ? await this.semantic.embedText(criteria.avoid) : null
    const stats = new Map(Array.from(this.db.loadImageStats(), ([id, row]) => [id, toMeasured(row)] as const))
    const shapes = this.db.loadImageShapes()
    const result = match({ ids, dim, matrix, text, avoid, stats, shapes, criteria, loose })
    return { ...result, problem: null }
  }

  /** A plain-words account of what the matching did, shown above the preview. */
  explain(criteria: SmartCriteria, result: MatchResult): string {
    const parts: string[] = []
    const spoken = semanticText(criteria)
    if (spoken) parts.push(`how the images look for “${spoken}”`)
    else if (criteria.likes.length > 0) parts.push(`the ${criteria.likes.length} image${criteria.likes.length === 1 ? '' : 's'} you pinned`)
    const measured: string[] = []
    for (const colour of criteria.colours) measured.push(`${COLOUR_LABEL.get(colour) ?? colour} colour`)
    if (criteria.tone !== 'any') measured.push(`${criteria.tone} tone`)
    if (criteria.vividness !== 'any') measured.push(criteria.vividness === 'mono' ? 'black and white' : `${criteria.vividness} colour`)
    if (measured.length > 0) parts.push(`measured ${measured.join(', ')}`)
    if (criteria.shape !== 'any') parts.push(`${criteria.shape === 'portrait' ? 'upright' : criteria.shape} shape`)
    const lead = parts.length > 0 ? `Matching ${parts.join(', plus ')}.` : 'Nothing to match yet.'
    const tail = result.nothingFits ? ' Nothing in your library looks much like this description; try different words.' : result.unmeasured > 0 ? ` Colour is still being measured for ${result.unmeasured} image${result.unmeasured === 1 ? '' : 's'}.` : ''
    return `${lead} ${strictnessWord(criteria.strictness)}.${tail}`
  }

  /** The full ranking for some criteria, best first, with how well each image fits (0 to 100). */
  async rank(input: unknown, options: { loose?: boolean } = {}): Promise<{ ids: string[]; match: number[]; explanation: string; problem: string | null; semantic: boolean }> {
    const criteria = normalizeCriteria(input)
    const result = await this.run(criteria, options.loose === true)
    return {
      ids: result.members.map((member) => member.id),
      match: result.members.map((member) => member.match),
      explanation: this.explain(criteria, result),
      problem: result.problem,
      semantic: result.semantic
    }
  }

  async preview(input: unknown, limit: number, offset: number): Promise<SmartPreview> {
    const criteria = normalizeCriteria(input)
    const result = await this.run(criteria)
    const slice = result.members.slice(offset, offset + limit)
    const items = this.db.getImagesByIds(slice.map((member) => member.id))
    const byId = new Map(slice.map((member) => [member.id, member.match]))
    return {
      items: items.map((item) => ({ ...item, match: byId.get(item.id) ?? 0 })),
      total: result.members.length,
      offset,
      limit,
      explanation: this.explain(criteria, result),
      semantic: result.semantic,
      problem: result.problem
    }
  }

  /** Every image id that matches, best first (for "select all" and "make a moodboard" on an unsaved preview). */
  async previewIds(input: unknown): Promise<string[]> {
    const result = await this.run(normalizeCriteria(input))
    return result.members.map((member) => member.id)
  }

  private toCollection(row: SmartCollectionRow): SmartCollection {
    const covers = this.db.queryImages({ scope: 'archive', smartId: row.id, limit: 3, offset: 0 }).items
    return {
      id: row.id,
      name: row.name,
      criteria: normalizeCriteria(safeJson(row.criteria)),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      size: row.size,
      newCount: row.newCount,
      covers,
      refreshedAt: row.refreshedAt
    }
  }

  list(): SmartCollection[] {
    return this.db.listSmartCollections().map((row) => this.toCollection(row))
  }

  get(id: string): SmartCollection | null {
    const row = this.db.getSmartCollection(id)
    return row ? this.toCollection(row) : null
  }

  async create(input: SmartCollectionInput): Promise<SmartCollection> {
    const criteria = normalizeCriteria(input?.criteria)
    if (criteriaAreEmpty(criteria)) throw new Error('Describe the images you want, or choose a colour, before saving.')
    const name = typeof input?.name === 'string' && input.name.trim() ? input.name : criteria.text || 'Untitled collection'
    const id = this.db.createSmartCollection(name, JSON.stringify(criteria))
    await this.refresh(id, true)
    this.options.onChanged()
    return this.get(id)!
  }

  async update(id: string, input: Partial<SmartCollectionInput>): Promise<SmartCollection> {
    const current = this.db.getSmartCollection(id)
    if (!current) throw new Error('That collection no longer exists.')
    const change: { name?: string; criteria?: string } = {}
    if (typeof input.name === 'string') change.name = input.name
    let recompute = false
    if (input.criteria !== undefined) {
      const criteria = normalizeCriteria(input.criteria)
      if (criteriaAreEmpty(criteria)) throw new Error('A collection needs a description or a colour.')
      change.criteria = JSON.stringify(criteria)
      recompute = change.criteria !== current.criteria
    }
    this.db.updateSmartCollection(id, change)
    if (recompute) await this.refresh(id, true)
    this.options.onChanged()
    return this.get(id)!
  }

  remove(id: string): boolean {
    const removed = this.db.deleteSmartCollection(id)
    if (removed) this.options.onChanged()
    return removed
  }

  markViewed(id: string): SmartCollection | null {
    this.db.markSmartViewed(id)
    this.options.onChanged()
    return this.get(id)
  }

  /** Recomputes one collection. Runs one at a time so results never overwrite each other out of order. */
  refresh(id: string, silent = false): Promise<void> {
    const task = this.chain.then(async () => {
      const row = this.db.getSmartCollection(id)
      if (!row) return
      const criteria = normalizeCriteria(safeJson(row.criteria))
      const result = await this.run(criteria)
      // Keep the previous matches when the model is unavailable, rather than emptying a collection.
      if (result.problem) return
      this.db.replaceSmartMembers(id, result.members.map((member) => ({ id: member.id, score: member.score })), silent)
    })
    this.chain = task.catch(() => undefined)
    return task
  }

  /** After images were added, learned or removed: bring every collection up to date. */
  async refreshAll(): Promise<void> {
    const before = new Map(this.db.listSmartCollections().map((row) => [row.id, row.size + ':' + row.newCount]))
    for (const row of this.db.listSmartCollections()) await this.refresh(row.id).catch(() => undefined)
    const after = this.db.listSmartCollections()
    if (after.some((row) => before.get(row.id) !== row.size + ':' + row.newCount)) this.options.onChanged()
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
