import { createHash } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'
import { EMBEDDING_MODEL, type Embedder } from '../src/main/embedder'
import { SemanticSearch } from '../src/main/semantic'
import { AssistantEngine } from '../src/main/assistant/engine'
import { AnthropicProvider, OpenAiCompatibleProvider, OpenAiResponsesProvider, imageCount, textOf, type FetchLike, type ImagePart } from '../src/main/assistant/providers'
import { AssistantSettingsStore, type SecretBox } from '../src/main/assistant/settings'
import type { AssistantContext } from '../src/main/assistant/tools'
import { focusRect, prepareVisionImages } from '../src/main/assistant/visionTools'
import type { AssistantBlock } from '../src/shared/assistant'

const fakeBox = (): SecretBox => ({ available: () => true, encrypt: (t) => Buffer.from(Buffer.from(t, 'utf8').reverse().map((b) => b ^ 0x5a)), decrypt: (d) => Buffer.from(Buffer.from(d).map((b) => b ^ 0x5a)).reverse().toString('utf8') })
const DIM = 8
const axis0 = (): Float32Array => Float32Array.from({ length: DIM }, (_v, d) => (d === 0 ? 1 : 0))

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('pictures in the wire formats of the providers', () => {
  const part: ImagePart = { type: 'image', mime: 'image/jpeg', base64: Buffer.from('JPEGDATA').toString('base64'), label: 'Picture 1' }
  const capture = (): { fetch: FetchLike; bodies: Array<Record<string, unknown>> } => {
    const bodies: Array<Record<string, unknown>> = []
    const fetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init!.body!) as Record<string, unknown>)
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }], output: [] }) }
    }
    return { fetch, bodies }
  }
  const turn = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Look.' }, part] }

  it('OpenAI chat: image_url with a data URL', async () => {
    const { fetch, bodies } = capture()
    await new OpenAiCompatibleProvider('local', 'http://127.0.0.1:11434/v1', 'llava', null, fetch).complete({ system: 's', turns: [turn], tools: [] })
    const content = (bodies[0]!.messages as Array<{ role: string; content: unknown }>)[1]!.content as Array<Record<string, unknown>>
    expect(content[0]).toEqual({ type: 'text', text: 'Look.' })
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${part.base64}` } })
  })

  it('OpenAI Responses: input_image', async () => {
    const { fetch, bodies } = capture()
    await new OpenAiResponsesProvider('openai', 'https://api.openai.com/v1', 'gpt-6.2-sol', 'k', fetch).complete({ system: 's', turns: [turn], tools: [] })
    const content = (bodies[0]!.input as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content
    expect(content[0]).toEqual({ type: 'input_text', text: 'Look.' })
    expect(content[1]).toEqual({ type: 'input_image', image_url: `data:image/jpeg;base64,${part.base64}` })
  })

  it('Anthropic: image blocks with a base64 source', async () => {
    const { fetch, bodies } = capture()
    await new AnthropicProvider('https://api.anthropic.com', 'claude', 'k', fetch).complete({ system: 's', turns: [turn], tools: [] })
    const content = (bodies[0]!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: part.base64 } })
  })

  it('plain text turns are unchanged, and the helpers read both kinds', () => {
    expect(textOf('hello')).toBe('hello')
    expect(textOf(turn.content)).toContain('[Picture 1]')
    expect(imageCount(turn.content)).toBe(1)
    expect(imageCount('x')).toBe(0)
  })
})

describe('preparing pictures for a model', () => {
  let dir = ''
  beforeEach(async () => {
    dir = join(tmpdir(), `noema-vision-prep-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const quadrants = async (path: string): Promise<void> => {
    const w = 3000
    const h = 2000
    const raw = Buffer.alloc(w * h * 3)
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 3
      const [r, g, b] = y < h / 2 ? (x < w / 2 ? [220, 30, 30] : [30, 200, 40]) : x < w / 2 ? [30, 40, 220] : [230, 210, 30]
      raw[o] = r!; raw[o + 1] = g!; raw[o + 2] = b!
    }
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path)
  }
  const item = (path: string, w: number, h: number): never => ({ id: 'x1', path, filename: 'q.png', width: w, height: h, missing: false }) as never

  it('shrinks to at most the chosen size as JPEG and never touches the original', async () => {
    const path = join(dir, 'q.png')
    await quadrants(path)
    const before = sha(path)
    const [normal] = await prepareVisionImages([item(path, 3000, 2000)], { detail: 'normal', refs: ['i1'] })
    const [close] = await prepareVisionImages([item(path, 3000, 2000)], { detail: 'close', refs: ['i1'] })
    const nm = await sharp(Buffer.from(normal!.part.base64, 'base64')).metadata()
    const cm = await sharp(Buffer.from(close!.part.base64, 'base64')).metadata()
    expect(nm.format).toBe('jpeg')
    expect(Math.max(nm.width!, nm.height!)).toBe(1280)
    expect(Math.max(cm.width!, cm.height!)).toBe(1568)
    expect(normal!.label).toBe('Picture 1 (i1)')
    expect(sha(path)).toBe(before)
  })

  it('a close look cuts the part out of the full-size picture', async () => {
    const path = join(dir, 'q.png')
    await quadrants(path)
    const meanOf = async (focus: Parameters<typeof prepareVisionImages>[1]['focus']): Promise<number[]> => {
      const [a] = await prepareVisionImages([item(path, 3000, 2000)], { detail: 'close', focus, refs: ['i1'] })
      const stats = await sharp(Buffer.from(a!.part.base64, 'base64')).stats()
      return stats.channels.slice(0, 3).map((c) => c.mean)
    }
    const tl = await meanOf({ grid: 'top-left' })
    expect(tl[0]).toBeGreaterThan(180) // red dominates
    expect(tl[1]).toBeLessThan(80)
    const br = await meanOf({ grid: 'bottom-right' })
    expect(br[0]).toBeGreaterThan(180)
    expect(br[2]).toBeLessThan(90) // yellow: no blue
    const rect = await meanOf({ rect: { x: 0.55, y: 0.05, w: 0.4, h: 0.4 } })
    expect(rect[1]).toBeGreaterThan(150) // green
    const [one] = await prepareVisionImages([item(path, 3000, 2000)], { detail: 'close', focus: { grid: 'center' }, refs: ['i1'] })
    expect(one!.note).toMatch(/close look at the center/)
  })

  it('reads focus requests, and ignores nonsense', () => {
    expect(focusRect(undefined)).toBeNull()
    expect(focusRect({ rect: { x: 0.2, y: 0.2, w: 0.001, h: 0.5 } })).toBeNull()
    const g = focusRect({ grid: 'top-right' })!
    expect(g.x).toBeGreaterThan(0.6)
    expect(g.y).toBe(0)
  })
})

interface ModelCall {
  messages: Array<{ role: string; content: unknown }>
  imagesSeen: Array<{ bytes: number; width: number; height: number; mean: number[] }>
}

describe('the companion looking at pictures, end to end', () => {
  let workDir = ''
  let db: AtlasDatabase
  let store: AssistantSettingsStore
  let engine: AssistantEngine
  let calls: ModelCall[] = []
  let paths: string[] = []
  let refuseImages = false
  let mode: 'local' | 'cloud' = 'local'
  let toolAfterLooking = false

  const embedder = { async embedTexts(texts: string[]): Promise<Float32Array[]> { return texts.map(() => axis0()) } } as unknown as Embedder

  const addImage = async (name: string, rgb: [number, number, number]): Promise<void> => {
    const path = join(workDir, 'images', name)
    await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toFile(path)
    const record: ScannedImageRecord = { id: imageIdForPath(path), rootId: db.listRoots()[0]!.id, path, folder: join(workDir, 'images'), filename: name, ext: 'png', bytes: 1000, width: 2400, height: 1600, orientation: 1, mtime: 1_700_000_000_000, color: '#777777', thumbStatus: 'ready', thumbError: null, scanToken: 't' }
    db.upsertScannedImage(record)
    db.saveEmbeddings(EMBEDDING_MODEL, [{ id: record.id, mtime: record.mtime, vector: axis0() }])
    paths.push(path)
  }

  /**
   * A stand-in for the language model server. It follows a fixed script: find the pictures, ask to look at the first two
   * (or to compare them), and, when it is really sent pictures, decode them and describe their colours from the pixels.
   */
  const model: FetchLike = async (url, init) => {
    if (!url.endsWith('/chat/completions')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) }
    const body = JSON.parse(init!.body!) as { messages: ModelCall['messages']; tools?: Array<{ function: { name: string } }> }
    const call: ModelCall = { messages: body.messages, imagesSeen: [] }
    for (const m of body.messages) {
      if (m.role !== 'user' || typeof m.content === 'string') continue
      for (const part of m.content as Array<{ type: string; image_url?: { url: string } }>) {
        if (part.type !== 'image_url') continue
        const bytes = Buffer.from(part.image_url!.url.split(',')[1]!, 'base64')
        const meta = await sharp(bytes).metadata()
        const stats = await sharp(bytes).stats()
        call.imagesSeen.push({ bytes: bytes.length, width: meta.width!, height: meta.height!, mean: stats.channels.slice(0, 3).map((c) => Math.round(c.mean)) })
      }
    }
    calls.push(call)
    const reply = (message: unknown): { ok: boolean; status: number; text: () => Promise<string> } => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message }] }) })
    if (refuseImages && call.imagesSeen.length > 0) return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'This model does not support image input.' } }) }
    const last = body.messages[body.messages.length - 1]!
    const lastText = typeof last.content === 'string' ? last.content : ''
    const approved = JSON.stringify(body.messages).includes('agreed to send you')
    if (toolAfterLooking && approved && last.role === 'tool') return reply({ content: '[library] Nothing more to add.' })
    if (toolAfterLooking && approved && call.imagesSeen.length > 0) return reply({ content: null, tool_calls: [{ id: 'c9', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ query: 'again' }) } }] })
    if (call.imagesSeen.length > 0) {
      const colours = call.imagesSeen.map((i, n) => `Picture ${n + 1} is ${i.mean[0]! > i.mean[2]! ? 'red-dominant' : 'blue-dominant'} (mean ${i.mean.join(',')}, ${i.width}x${i.height})`)
      return reply({ content: `[seen] ${colours.join('. ')}.\n\n[library] The library notes call these atmospheric.\n\n[idea] A warmer palette might unify them.` })
    }
    if (last.role === 'tool') {
      const toolName = (body.messages.find((m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls) as { tool_calls?: Array<{ function: { name: string } }> } | undefined)?.tool_calls?.slice(-1)[0]?.function.name
      if (toolName === 'search_images') {
        const refs = Array.from(lastText.matchAll(/"ref":"(i\d+)"/g)).map((m) => m[1]!)
        const wantsCompare = /compare/i.test(JSON.stringify(body.messages.find((m) => m.role === 'user')))
        const focus = /top-left/.test(JSON.stringify(body.messages.find((m) => m.role === 'user'))) ? { focus_grid: 'top-left', detail: 'close' } : {}
        return reply({ content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: wantsCompare ? 'compare_images' : 'look_at_images', arguments: JSON.stringify({ refs: refs.slice(0, 2), question: 'Analyse the colour and mood.', ...focus }) } }] })
      }
      return reply({ content: 'The pictures are not available to me yet. Once you agree I will look at the colour and mood.' })
    }
    return reply({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_images', arguments: JSON.stringify({ query: 'pictures' }) } }] })
  }

  const makeEngine = (): AssistantEngine => {
    const ctx: AssistantContext = {
      db,
      semantic: new SemanticSearch(db, async () => embedder),
      searchable: () => true,
      reference: null,
      identity: async () => null,
      taste: async () => null,
      journeySuggestions: async () => [],
      getEmbedder: async () => embedder,
      mayShareNames: () => store.mayShareNames(),
      vision: { mode: () => { const v = store.view(); return { provider: v.provider, staysLocal: v.staysLocal, label: v.providerLabel, model: v.model } } }
    }
    return new AssistantEngine({ dir: join(workDir, 'assistant'), settings: store, ctx, fetchImpl: model })
  }

  const configure = (m: 'local' | 'cloud'): void => {
    mode = m
    if (m === 'local') store.update({ provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llava:13b' })
    else store.update({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test', consent: { granted: true, shareNames: false } })
    engine = makeEngine()
  }

  beforeEach(async () => {
    workDir = join(tmpdir(), `noema-vision-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(workDir, 'images'), { recursive: true })
    db = new AtlasDatabase(join(workDir, 'library.db'))
    db.addRoot(join(workDir, 'images'))
    paths = []
    calls = []
    refuseImages = false
    toolAfterLooking = false
    store = new AssistantSettingsStore(join(workDir, 'assistant'), fakeBox())
    await addImage('red.png', [210, 40, 40])
    await addImage('blue.png', [40, 50, 210])
    await addImage('green.png', [40, 200, 60])
  })
  afterEach(async () => {
    db.close()
    await fs.rm(workDir, { recursive: true, force: true })
  })

  const blocksOf = (chat: { messages: Array<{ blocks: AssistantBlock[] }> }): AssistantBlock[] => chat.messages.flatMap((m) => m.blocks)
  const waitFor = async (test: () => boolean, ms = 8000): Promise<void> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('Timed out.')
  }

  it('a model on this computer is given the pictures at once; what it sees is told apart from library notes', async () => {
    configure('local')
    const before = paths.map(sha)
    const reply = await engine.send(null, 'Look closely at these pictures and analyse their mood.')
    const blocks = blocksOf(reply.chat)
    const looked = blocks.find((b) => b.type === 'looked')
    expect(looked).toMatchObject({ type: 'looked', local: true, detail: 'normal' })
    expect((looked as { ids: string[] }).ids).toHaveLength(2)
    // The model really received two JPEG pictures, shrunk, with the right pixels.
    const seen = calls.filter((c) => c.imagesSeen.length > 0)
    expect(seen.length).toBeGreaterThan(0)
    const first = seen[0]!.imagesSeen
    expect(first).toHaveLength(2)
    expect(Math.max(...first.map((i) => Math.max(i.width, i.height)))).toBeLessThanOrEqual(1280)
    // Two different pictures arrived with their own pixels: one red-dominant, one blue-dominant.
    expect(first.map((i) => (i.mean[0]! > i.mean[2]! ? 'red' : 'blue')).sort()).toEqual(['blue', 'red'])
    const answer = reply.chat.messages[reply.chat.messages.length - 1]!.blocks
    expect(answer[0]!.type).toBe('looked') // what was looked at comes first, above the answer
    expect(answer.filter((b) => b.type === 'text').map((b) => (b as { basis: string }).basis)).toEqual(['seen', 'library', 'idea'])
    expect(JSON.stringify(blocks)).toMatch(/red-dominant|blue-dominant/)
    expect(paths.map(sha)).toEqual(before)
  })

  it('a close look at a part sends only that part', async () => {
    configure('local')
    await engine.send(null, 'Look closely at the top-left of these pictures.')
    const seen = calls.find((c) => c.imagesSeen.length > 0)!
    // A close look at one ninth of a 2400x1600 picture: about 880x600 pixels, not the whole picture.
    expect(seen.imagesSeen[0]!.width).toBeLessThan(1000)
    expect(seen.imagesSeen[0]!.width).toBeGreaterThan(700)
  })

  it('compare_images shows the versions side by side and says it compared them', async () => {
    configure('local')
    const reply = await engine.send(null, 'Compare these versions and say which is more coherent.')
    const looked = blocksOf(reply.chat).find((b) => b.type === 'looked') as { compare?: boolean; ids: string[] }
    expect(looked.compare).toBe(true)
    expect(looked.ids).toHaveLength(2)
  })

  it('a cloud model gets NOTHING until the user agrees, and only the approved pictures afterwards', async () => {
    configure('cloud')
    const reply = await engine.send(null, 'Look closely at these pictures and analyse their mood.')
    const blocks = blocksOf(reply.chat)
    // Nothing was sent: no request carried a picture, and nothing says "looked".
    expect(calls.every((c) => c.imagesSeen.length === 0)).toBe(true)
    expect(blocks.some((b) => b.type === 'looked')).toBe(false)
    const proposal = blocks.find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>
    expect(proposal.proposal.kind).toBe('look')
    expect(proposal.status).toBe('pending')
    expect(proposal.reason).toMatch(/not on this computer/)
    expect(proposal.title).toMatch(/these 2 pictures/)
    const kind = proposal.proposal as { imageIds: string[]; providerLabel: string }
    expect(kind.imageIds).toHaveLength(2)
    // The user agrees: only now are the pictures read and sent.
    const updated = engine.respondToProposal(reply.chat.id, proposal.id, true)
    const running = blocksOf(updated).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>
    expect(running.status).toBe('running')
    await waitFor(() => blocksOf(engine.getChat(reply.chat.id)!).some((b) => b.type === 'looked'))
    const chat = engine.getChat(reply.chat.id)!
    const looked = blocksOf(chat).find((b) => b.type === 'looked') as { local: boolean; provider: string; ids: string[] }
    expect(looked.local).toBe(false)
    expect(looked.ids.sort()).toEqual([...kind.imageIds].sort())
    const sent = calls.filter((c) => c.imagesSeen.length > 0)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.imagesSeen).toHaveLength(2)
    expect(blocksOf(chat).filter((b) => b.type === 'text' && (b as { basis: string }).basis === 'seen')).toHaveLength(1)
    const done = blocksOf(chat).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>
    expect(done.status).toBe('applied')
  })

  it('the approved pictures go out once, even when the model needs another round to answer', async () => {
    configure('cloud')
    toolAfterLooking = true
    const reply = await engine.send(null, 'Look closely at these pictures and analyse their mood.')
    const proposal = blocksOf(reply.chat).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>
    engine.respondToProposal(reply.chat.id, proposal.id, true)
    await waitFor(() => blocksOf(engine.getChat(reply.chat.id)!).some((b) => b.type === 'looked'))
    // The model asked for a tool after seeing the pictures, so there were two requests after the agreement: only the first carried pictures.
    const after = calls.slice(calls.findIndex((c) => c.imagesSeen.length > 0))
    expect(after.length).toBeGreaterThanOrEqual(2)
    expect(after.filter((c) => c.imagesSeen.length > 0)).toHaveLength(1)
  })

  it('a refused request sends nothing, ever', async () => {
    configure('cloud')
    const reply = await engine.send(null, 'Look closely at these pictures and analyse their mood.')
    const proposal = blocksOf(reply.chat).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>
    const chat = engine.respondToProposal(reply.chat.id, proposal.id, false)
    expect((blocksOf(chat).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>).status).toBe('dismissed')
    await new Promise((r) => setTimeout(r, 300))
    expect(calls.every((c) => c.imagesSeen.length === 0)).toBe(true)
    // A later question does not smuggle the earlier pictures in.
    await engine.send(reply.chat.id, 'Thanks. What do you know about them from my library?')
    expect(calls.every((c) => c.imagesSeen.length === 0)).toBe(true)
  })

  it('a model that cannot take pictures is explained, not blamed on the user', async () => {
    configure('cloud')
    refuseImages = true
    const reply = await engine.send(null, 'Look closely at these pictures and analyse their mood.')
    const proposal = blocksOf(reply.chat).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>
    engine.respondToProposal(reply.chat.id, proposal.id, true)
    await waitFor(() => (blocksOf(engine.getChat(reply.chat.id)!).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>).status === 'dismissed')
    const done = blocksOf(engine.getChat(reply.chat.id)!).find((b) => b.type === 'proposal') as Extract<AssistantBlock, { type: 'proposal' }>
    expect(done.result).toMatch(/could not look at the pictures/)
    expect(done.result).toMatch(/choose one that does/)
  })

  it('the built-in basics say plainly that they cannot look at pictures', async () => {
    store.update({ provider: 'basics' })
    engine = makeEngine()
    const reply = await engine.send(null, 'Look closely at these three artworks and analyse their composition.')
    const text = blocksOf(reply.chat).map((b) => (b.type === 'text' ? b.text : '')).join(' ')
    expect(text).toMatch(/cannot look at pictures/)
    expect(text).toMatch(/Ollama or LM Studio/)
    expect(mode).toBeTruthy()
  })
})
