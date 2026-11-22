import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'
import { EMBEDDING_MODEL, type Embedder } from '../src/main/embedder'
import { SemanticSearch } from '../src/main/semantic'
import { SmartCollections } from '../src/main/smartCollections'
import { CurationService } from '../src/main/curationService'
import { AssistantEngine } from '../src/main/assistant/engine'
import { AssistantSettingsStore, type SecretBox } from '../src/main/assistant/settings'
import { RefBook, buildTools, type AssistantContext } from '../src/main/assistant/tools'
import { emptyCriteria } from '../src/shared/smart'
import type { AssistantBlock } from '../src/shared/assistant'
import type { CuratedProposalData } from '../src/shared/curation'

const DIM = 12
const unit = (values: number[]): Float32Array => {
  const norm = Math.hypot(...values) || 1
  return Float32Array.from(values.map((v) => v / norm))
}
const axis = (i: number, noise = 0, extra: Record<number, number> = {}): Float32Array =>
  unit(Array.from({ length: DIM }, (_x, d) => (d === i ? 1 : 0.3 * Math.sin(noise * 12.9898 + d * 78.233)) + (extra[d] ?? 0)))

/** A pure direction, for the image model's answers. */
const pure = (i: number): Float32Array => unit(Array.from({ length: DIM }, (_x, d) => (d === i ? 1 : 0)))

const fakeBox: SecretBox = {
  available: () => true,
  encrypt: (text) => Buffer.from(text, 'utf8'),
  decrypt: (data) => Buffer.from(data).toString('utf8')
}

describe('curating from a Smart Collection through the companion', () => {
  let workDir = ''
  let db: AtlasDatabase | null = null
  let rootId = ''
  let counter = 0
  let semantic: SemanticSearch | null = null
  let smart: SmartCollections | null = null
  let curation: CurationService | null = null
  let engine: AssistantEngine | null = null
  const kinds: Record<string, string> = {}

  /** The local image model, as a test double: each description lands on its own axis. */
  const embedder = {
    async embedTexts(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) =>
        /screenshot|interface|wireframe|diagram|node graph|texture map|test scene|thumbnails/i.test(t)
          ? pure(6)
          : /painting|illustration|photograph|artwork|cinematic|drawing/i.test(t)
            ? pure(7)
            : /abstract|glitch|mixed-media|generative/i.test(t)
              ? pure(3)
              : /fog|mist|forest|landscape/i.test(t)
                ? pure(0)
                : /city|street/i.test(t)
                  ? pure(1)
                  : pure(9)
      )
    }
  } as unknown as Embedder

  function add(filename: string, vector: Float32Array, kind: string, size: [number, number] = [1400, 1000], extra: Partial<ScannedImageRecord> = {}): string {
    counter += 1
    const path = join(workDir, 'images', filename)
    const record: ScannedImageRecord = {
      id: imageIdForPath(path),
      rootId,
      path,
      folder: join(workDir, 'images'),
      filename,
      ext: filename.split('.').pop()!,
      bytes: 1000,
      width: size[0],
      height: size[1],
      orientation: 1,
      mtime: 1_700_000_000_000,
      color: '#777777',
      thumbStatus: 'ready',
      thumbError: null,
      scanToken: 't',
      ...extra
    }
    db!.upsertScannedImage(record)
    db!.saveEmbeddings(EMBEDDING_MODEL, [{ id: record.id, mtime: record.mtime, vector }])
    kinds[record.id] = kind
    return record.id
  }

  beforeEach(async () => {
    workDir = join(tmpdir(), `noema-curate-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(workDir, 'images'), { recursive: true })
    db = new AtlasDatabase(join(workDir, 'library.db'))
    rootId = db.addRoot(join(workDir, 'images')).id
    counter = 0
    for (const key of Object.keys(kinds)) delete kinds[key]
    // Finished landscapes (three moods), technical screenshots that rank very high for "landscape", experiments, other subjects.
    for (let i = 0; i < 14; i += 1) add(`landscape ${i}.jpg`, axis(0, i + 1), 'finished')
    for (let i = 0; i < 5; i += 1) add(`Screenshot 2026-11-0${i + 1} 14${i}501.png`, axis(0, 50 + i, { 0: 0.25, 6: 0.2 }), 'technical', [1920, 1080])
    add('terrain_viewport_final.png', axis(0, 70, { 0: 0.25, 6: 0.2 }), 'technical', [2560, 1440])
    for (let i = 0; i < 3; i += 1) add(`glitch study ${i}.png`, axis(0, 90 + i, { 0: 0.15, 3: 0.35 }), 'experimental', [1600, 1200])
    for (let i = 0; i < 3; i += 1) add(`city ${i}.jpg`, axis(1, 120 + i), 'other')
    // The rest of a library: many pictures of other things, so a landscape description is a minority match.
    for (let i = 0; i < 40; i += 1) add(`other ${i}.jpg`, axis(8 + (i % 4), 200 + i), 'other')
    add('wip_forest.jpg', axis(0, 140), 'unclear')
    semantic = new SemanticSearch(db, async () => embedder)
    smart = new SmartCollections(db, semantic, { modelReady: () => true, onChanged: () => undefined })
    curation = new CurationService({
      db: () => db!,
      semantic: () => semantic,
      embedder: async () => embedder,
      reference: () => null,
      smart: () => smart,
      identity: () => null,
      taste: () => null,
      thumbnailsDir: join(workDir, 'thumbs')
    })
    const store = new AssistantSettingsStore(join(workDir, 'assistant'), fakeBox)
    const ctx: AssistantContext = {
      db: db!,
      semantic,
      searchable: () => true,
      reference: null,
      identity: async () => null,
      taste: async () => null,
      journeySuggestions: async () => [],
      getEmbedder: async () => embedder,
      mayShareNames: () => false,
      smart,
      curation,
      view: () => curation!.view
    }
    engine = new AssistantEngine({
      dir: join(workDir, 'assistant'),
      settings: store,
      ctx,
      fetchImpl: async () => {
        throw new Error('no network')
      }
    })
  })

  afterEach(async () => {
    db?.close()
    db = null
    await fs.rm(workDir, { recursive: true, force: true })
  })

  const proposalOf = (blocks: AssistantBlock[]): { id: string; proposal: CuratedProposalData; status: string } => {
    const block = blocks.find((b) => b.type === 'proposal')
    if (!block || block.type !== 'proposal' || block.proposal.kind !== 'curated-moodboard') throw new Error('no curated proposal')
    return { id: block.id, proposal: block.proposal, status: block.status }
  }

  it('lets the companion see Smart Collections and what the user has open, including unsaved settings', async () => {
    const saved = await smart!.create({ name: 'Foggy landscapes', criteria: { ...emptyCriteria(), text: 'foggy landscape' } })
    const session = { ctx: { db: db!, semantic, searchable: () => true, reference: null, identity: async () => null, taste: async () => null, journeySuggestions: async () => [], getEmbedder: async () => embedder, mayShareNames: () => false, smart, curation, view: () => curation!.view } as AssistantContext, refs: new RefBook() }
    const tools = buildTools()
    const run = (name: string, args: Record<string, unknown> = {}) => tools.find((t) => t.spec.name === name)!.run(args, session)

    const list = (await run('list_smart_collections')).model as { smart_collections: Array<{ name: string; looks_for: string; images: number }> }
    expect(list.smart_collections[0]!.name).toBe('Foggy landscapes')
    expect(list.smart_collections[0]!.looks_for).toContain('foggy landscape')

    expect(((await run('current_view')).model as { viewing: string }).viewing).toBe('nothing in particular')
    curation!.view = { kind: 'smart', id: saved.id, name: 'Foggy landscapes', criteria: { ...saved.criteria, strictness: 80, colours: ['teal'] } }
    const view = (await run('current_view')).model as { viewing: string; looks_for: string }
    expect(view.viewing).toBe('a smart collection')
    expect(view.looks_for).toContain('teal')
    expect(view.looks_for).toContain('strict')

    const images = await run('smart_collection_images', { name: 'Foggy landscapes', limit: 6 })
    const model = images.model as { collection: string; images: Array<{ match: number }>; total_matching: number }
    expect(model.collection).toBe('Foggy landscapes')
    expect(model.images.length).toBe(6)
    expect(model.images[0]!.match).toBeGreaterThanOrEqual(model.images.at(-1)!.match)
    expect(images.blocks[0]).toMatchObject({ type: 'images' })
  })

  it('curates the open collection: screenshots stay out, fewer are proposed when needed, and nothing is made before approval', async () => {
    const saved = await smart!.create({ name: 'Foggy landscapes', criteria: { ...emptyCriteria(), text: 'foggy landscape', strictness: 0 } })
    curation!.view = { kind: 'smart', id: saved.id, name: saved.name, criteria: saved.criteria }
    const boardsBefore = db!.listMoodboards().length

    const reply = await engine!.send(null, 'Pick the ten best images from this collection for a moodboard')
    const { proposal } = proposalOf(reply.chat.messages.at(-1)!.blocks)
    expect(db!.listMoodboards()).toHaveLength(boardsBefore)
    expect(proposal.picks.length).toBeGreaterThan(0)
    expect(proposal.picks.length).toBeLessThanOrEqual(10)
    // No technical screenshot among the picks, although they rank as high as anything.
    expect(proposal.picks.every((p) => kinds[p.imageId] !== 'technical')).toBe(true)
    const technicalLeft = proposal.leftOut.filter((l) => l.why === 'technical').map((l) => kinds[l.imageId])
    expect(technicalLeft.length).toBe(6)
    expect(proposal.leftOut.find((l) => l.why === 'technical')!.detail).toMatch(/file name|screen/)
    // Every pick comes with reasons, and the user's taste is described honestly.
    expect(proposal.picks.every((p) => p.reasons.length > 0)).toBe(true)
    expect(proposal.tasteBasis).toContain('no favorites')
    expect(proposal.source).toContain('Foggy landscapes')
    // The message says what was left out.
    const text = reply.chat.messages.at(-1)!.blocks.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join(' ')
    expect(text).toContain('technical working images')
    expect(text).toContain('Review them below')
  })

  it('shows the work-in-progress file as uncertain rather than judging it', async () => {
    const saved = await smart!.create({ name: 'Foggy landscapes', criteria: { ...emptyCriteria(), text: 'foggy landscape', strictness: 0 } })
    curation!.view = { kind: 'smart', id: saved.id, name: saved.name, criteria: saved.criteria }
    const result = await curation!.curate({ source: { kind: 'smart', id: saved.id }, count: 30 })
    if ('error' in result) throw new Error(result.error)
    const wip = [...result.proposal.picks, ...result.proposal.alternatives].find((p) => kinds[p.imageId] === 'unclear')
    if (wip) {
      expect(wip.uncertain).toBe(true)
      expect(wip.reasons.join(' ')).toContain('working image')
    }
    // Asking for far more than exists proposes fewer, with the reason.
    expect(result.proposal.picks.length).toBeLessThan(30)
    expect(result.proposal.shortfall).toContain('technical')
  })

  it('applies exactly what the user approved: rejected images stay out, a replacement or an added image comes in', async () => {
    const saved = await smart!.create({ name: 'Foggy landscapes', criteria: { ...emptyCriteria(), text: 'foggy landscape', strictness: 0 } })
    curation!.view = { kind: 'smart', id: saved.id, name: saved.name, criteria: saved.criteria }
    const reply = await engine!.send(null, 'curate 5 images from this collection')
    const { id, proposal } = proposalOf(reply.chat.messages.at(-1)!.blocks)
    expect(proposal.picks).toHaveLength(5)
    const [first, second, third, fourth, fifth] = proposal.picks.map((p) => p.imageId)
    const replacement = proposal.alternatives[0]!.imageId
    // The user rejects the first, replaces the second with an alternative, and adds a technical image anyway.
    const technicalId = proposal.leftOut.find((l) => l.why === 'technical')!.imageId
    const chosen = [replacement, third!, fourth!, fifth!, technicalId]
    engine!.reviewCuration(reply.chat.id, id, chosen)
    const remembered = proposalOf(engine!.getChat(reply.chat.id)!.messages.at(-1)!.blocks).proposal
    expect(remembered.selection).toEqual(chosen)

    // A forged id that was never proposed is ignored.
    const applied = engine!.respondToProposal(reply.chat.id, id, true, { selection: [...chosen, 'not-a-real-image'], name: 'My foggy five' })
    const boards = db!.listMoodboards()
    expect(boards).toHaveLength(1)
    expect(boards[0]!.name).toBe('My foggy five')
    expect(boards[0]!.imageCount).toBe(5)
    const board = db!.getMoodboard(boards[0]!.id)!
    const onBoard = new Set(board.images.map((i) => i.id))
    expect(onBoard.has(first!)).toBe(false)
    expect(onBoard.has(second!)).toBe(false)
    expect(onBoard.has(replacement)).toBe(true)
    expect(onBoard.has(technicalId)).toBe(true)
    const final = proposalOf(applied.messages.at(-1)!.blocks)
    expect(final.status).toBe('applied')
    // A second accept changes nothing.
    engine!.respondToProposal(reply.chat.id, id, true, { selection: chosen })
    expect(db!.listMoodboards()).toHaveLength(1)
  })

  it('can add the approved images to an existing moodboard instead, and a dismissed proposal creates nothing', async () => {
    const saved = await smart!.create({ name: 'Foggy landscapes', criteria: { ...emptyCriteria(), text: 'foggy landscape' } })
    curation!.view = { kind: 'smart', id: saved.id, name: saved.name, criteria: saved.criteria }
    const board = db!.createMoodboard('Existing')
    const reply = await engine!.send(null, 'select the best 4 from this collection')
    const { id, proposal } = proposalOf(reply.chat.messages.at(-1)!.blocks)
    engine!.respondToProposal(reply.chat.id, id, true, { selection: proposal.imageIds.slice(0, 3), boardId: board.id })
    expect(db!.getMoodboard(board.id)!.imageCount).toBe(3)
    expect(db!.listMoodboards()).toHaveLength(1)

    const again = await engine!.send(reply.chat.id, 'curate 4 more from this collection')
    const second = proposalOf(again.chat.messages.at(-1)!.blocks)
    engine!.respondToProposal(again.chat.id, second.id, false)
    expect(db!.listMoodboards()).toHaveLength(1)
    expect(db!.getMoodboard(board.id)!.imageCount).toBe(3)
  })

  it('asks which collection when the user is not looking at one and there are several', async () => {
    await smart!.create({ name: 'Foggy landscapes', criteria: { ...emptyCriteria(), text: 'foggy landscape' } })
    await smart!.create({ name: 'City streets', criteria: { ...emptyCriteria(), text: 'city street' } })
    const reply = await engine!.send(null, 'Pick the best ten images from my smart collection')
    const blocks = reply.chat.messages.at(-1)!.blocks
    expect(blocks.some((b) => b.type === 'proposal')).toBe(false)
    expect(blocks.map((b) => (b.type === 'text' ? b.text : '')).join(' ')).toContain('Which collection')
    // Naming one works.
    const named = await engine!.send(reply.chat.id, 'Pick the best 5 images from "City streets"')
    expect(proposalOf(named.chat.messages.at(-1)!.blocks).proposal.source).toContain('City streets')
  })

  it('leaves the library as it was: no image is changed by looking or curating', async () => {
    const saved = await smart!.create({ name: 'Foggy landscapes', criteria: { ...emptyCriteria(), text: 'foggy landscape' } })
    curation!.view = { kind: 'smart', id: saved.id, name: saved.name, criteria: saved.criteria }
    const before = JSON.stringify(db!.queryImages({ scope: 'archive', limit: 500 }).items.map((i) => [i.id, i.favorite, i.rating, i.tags]))
    await engine!.send(null, 'curate 8 images from this collection')
    const after = JSON.stringify(db!.queryImages({ scope: 'archive', limit: 500 }).items.map((i) => [i.id, i.favorite, i.rating, i.tags]))
    expect(after).toBe(before)
    expect(db!.listMoodboards()).toHaveLength(0)
  })
})
