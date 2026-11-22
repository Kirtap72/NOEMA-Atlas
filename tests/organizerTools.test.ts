import { promises as fs, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import { EMBEDDING_MODEL } from '../src/main/embedder'
import { OrganizerEngine } from '../src/main/organizer/engine'
import { RefBook, buildTools, type AssistantContext, type Tool } from '../src/main/assistant/tools'
import { respondBasics } from '../src/main/assistant/basics'

const DIM = 24
const unit = (v: number[]): Float32Array => {
  const n = Math.hypot(...v) || 1
  return Float32Array.from(v.map((x) => x / n))
}
const noise = (n: number, d: number): number => {
  const x = Math.sin(n * 12.9898 + d * 78.233) * 43758.5453
  return x - Math.floor(x)
}
const vec = (subject: number, n: number): Float32Array => unit(Array.from({ length: DIM }, (_v, d) => (d === subject ? 1 : 0) + (d === 9 ? 0.9 : 0) + (d >= 12 ? 0.9 * noise(n, d) : 0)))
const embedder = { async embedTexts(texts: string[]): Promise<Float32Array[]> { return texts.map(() => unit(Array.from({ length: DIM }, (_v, d) => (d === 9 ? 1 : 0)))) } }

describe('the organizer tools of the companion', () => {
  let work = ''
  let db: AtlasDatabase
  let engine: OrganizerEngine
  let tools: Tool[]
  let ctx: AssistantContext
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ model: Record<string, unknown>; blocks: Array<Record<string, unknown>> }> => {
    const tool = tools.find((t) => t.spec.name === name)!
    return (await tool.run(args, { ctx, refs: new RefBook() })) as never
  }
  const waitReady = async (id: string): Promise<void> => {
    const end = Date.now() + 15000
    while (Date.now() < end) {
      if (engine.plan(id)!.status === 'ready') return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('not ready')
  }

  beforeEach(async () => {
    work = join(tmpdir(), `noema-orgtools-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const src = join(work, 'Holiday')
    await fs.mkdir(src, { recursive: true })
    db = new AtlasDatabase(join(work, 'library.db'))
    db.addRoot(src)
    for (let i = 0; i < 18; i += 1) {
      const path = join(src, `pic-${i}.png`)
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: i * 10, g: 80, b: 120 } } }).png().toFile(path)
      const st = statSync(path)
      db.upsertScannedImage({ id: imageIdForPath(path), rootId: db.listRoots()[0]!.id, path, folder: src, filename: `pic-${i}.png`, ext: 'png', bytes: st.size, width: 64, height: 48, orientation: 1, mtime: 1_700_000_000_000, color: '#777777', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
      db.saveEmbeddings(EMBEDDING_MODEL, [{ id: imageIdForPath(path), mtime: 1_700_000_000_000, vector: vec(i % 3, i + 1) }])
    }
    engine = new OrganizerEngine({ db, embedder: async () => embedder, roles: async (items) => new Map(items.map((i) => [i.id, { role: 'finished' as const, reasons: [] }])), freeBytes: async () => 1e12, batch: 6 })
    ctx = { db, organizer: engine } as unknown as AssistantContext
    tools = buildTools()
  })

  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined)
  })

  it('starts, shows, refines and offers an export that waits for the user', async () => {
    const started = await call('organize_start', { source: 'holiday', name: 'Holiday sort' })
    expect(started.model.pictures).toBe(18)
    const planId = String(started.model.plan_id)

    // Before the analysis ends the model is told so, and not given a grouping to invent from.
    const early = await call('organize_export', { plan_id: planId })
    expect(JSON.stringify(early.model)).toMatch(/NOT_READY/)
    expect(early.blocks).toHaveLength(0)

    await waitReady(planId)
    const overview = await call('organize_overview', { plan_id: planId })
    expect(overview.model.pictures).toBe(18)
    expect((overview.model.kinds as unknown[]).length).toBeGreaterThan(0)

    const refined = await call('organize_refine', { operations: [{ op: 'structure', value: 'flat' }, { op: 'duplicates', value: 'keep-all' }, { op: 'bogus' }] })
    expect((refined.model.applied as string[]).length).toBeGreaterThan(0)
    expect(engine.plan(planId)!.settings.structure).toBe('flat')
    expect(engine.plan(planId)!.settings.duplicates).toBe('keep-all')

    const offer = await call('organize_export')
    expect(offer.blocks).toHaveLength(1)
    expect(offer.blocks[0]).toMatchObject({ type: 'proposal', status: 'pending', proposal: { kind: 'organize-export', planId } })
    expect(JSON.stringify(offer.model)).toMatch(/WAITING_FOR_THE_USER/)
    // Nothing was copied: the source folder still holds exactly its 18 originals and nothing else.
    expect(await fs.readdir(join(work, 'Holiday'))).toHaveLength(18)
  })

  it('refuses an unknown source and says which exist', async () => {
    const result = await call('organize_start', { source: 'nowhere at all' })
    expect(String(result.model.error)).toContain('Holiday')
  })

  it('starts from a plain sentence in basic mode', async () => {
    const answer = await respondBasics({ text: 'organize my pictures into folders', lastImageIds: [] }, tools, { ctx, refs: new RefBook() })
    expect(engine.plans()).toHaveLength(1)
    expect(JSON.stringify(answer.blocks)).toMatch(/Nothing is copied or moved/)
  })
})
