import { readIntent } from '../src/main/assistant/intent'
import { prefersResponsesApi } from '../src/main/assistant/providers'
import { promises as fs, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'
import { EMBEDDING_MODEL, type Embedder } from '../src/main/embedder'
import { SemanticSearch } from '../src/main/semantic'
import { AssistantEngine, parseAnswer } from '../src/main/assistant/engine'
import {
  AnthropicProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  isLoopback,
  type FetchLike
} from '../src/main/assistant/providers'
import { AssistantSettingsStore, type SecretBox } from '../src/main/assistant/settings'
import type { AssistantContext } from '../src/main/assistant/tools'

const DIM = 8

const unit = (values: number[]): Float32Array => {
  const norm = Math.hypot(...values) || 1
  return Float32Array.from(values.map((v) => v / norm))
}
const axis = (i: number, noise = 0): Float32Array => unit(Array.from({ length: DIM }, (_x, d) => (d === i ? 1 : 0.03 * Math.sin(noise * 3 + d))))

/** A reversible but unreadable box, standing in for the operating system's key store. */
const fakeBox = (available = true): SecretBox => ({
  available: () => available,
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').reverse().map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(Buffer.from(data).map((b) => b ^ 0x5a)).reverse().toString('utf8')
})

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch(handler: (call: Call) => { status?: number; body: unknown }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const call: Call = { url, headers: init?.headers ?? {}, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} }
    calls.push(call)
    const result = handler(call)
    const status = result.status ?? 200
    return { ok: status < 400, status, text: async () => JSON.stringify(result.body) }
  }
  return { fetch: fetchImpl, calls }
}

describe('providers', () => {
  it('speaks the OpenAI chat format with tools and reads tool calls', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'search_images', arguments: '{"query":"fog"}' } }] } }] }
    }))
    const provider = new OpenAiCompatibleProvider('openai', 'https://api.example.com/v1/', 'm1', 'sk-secret', fetch)
    const result = await provider.complete({
      system: 'sys',
      turns: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search_images', description: 'd', parameters: { type: 'object', properties: {} } }]
    })
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'search_images', args: { query: 'fog' } }])
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions')
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-secret')
    expect((calls[0]!.body.messages as Array<{ role: string }>)[0]!.role).toBe('system')
    expect(Array.isArray(calls[0]!.body.tools)).toBe(true)
  })

  it('speaks the Anthropic format and merges tool results into one user turn', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 't1', name: 'x', input: { a: 1 } }] } }))
    const provider = new AnthropicProvider('https://api.anthropic.com', 'claude-x', 'key-1', fetch)
    const out = await provider.complete({
      system: 'sys',
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', args: {} }, { id: 'b', name: 'y', args: {} }] },
        { role: 'tool', toolCallId: 'a', name: 'x', content: '1' },
        { role: 'tool', toolCallId: 'b', name: 'y', content: '2' }
      ],
      tools: []
    })
    expect(out.text).toBe('Hello')
    expect(out.toolCalls[0]).toEqual({ id: 't1', name: 'x', args: { a: 1 } })
    expect(calls[0]!.headers['x-api-key']).toBe('key-1')
    const messages = calls[0]!.body.messages as Array<{ role: string; content: unknown[] }>
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2]!.content).toHaveLength(2)
    expect(calls[0]!.body.system).toBe('sys')
  })

  it('gives friendly errors that never contain the key', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: 'bad key sk-secret' } } }))
    const provider = new OpenAiCompatibleProvider('openai', 'https://x/v1', 'm', 'sk-secret', fetch)
    const error = await provider.complete({ system: '', turns: [{ role: 'user', content: 'a' }], tools: [] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).kind).toBe('auth')
    expect((error as Error).message).not.toContain('sk-secret')
    const refused: FetchLike = async () => {
      throw new Error('ECONNREFUSED sk-secret')
    }
    const down = await new OpenAiCompatibleProvider('local', 'http://127.0.0.1:1/v1', 'm', 'sk-secret', refused).complete({ system: '', turns: [], tools: [] }).catch((e: unknown) => e)
    expect((down as ProviderError).kind).toBe('network')
    expect((down as Error).message).not.toContain('sk-secret')
  })

  it('recognises addresses on this computer', () => {
    expect(isLoopback('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLoopback('http://localhost:1234/v1')).toBe(true)
    expect(isLoopback('https://api.openai.com/v1')).toBe(false)
    expect(isLoopback('http://192.168.1.20:11434/v1')).toBe(false)
  })
})

describe('settings and credentials', () => {
  let dir = ''
  beforeEach(async () => {
    dir = join(tmpdir(), `noema-assist-settings-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('stores keys encrypted, never exposes them, and can forget them', () => {
    const store = new AssistantSettingsStore(dir, fakeBox())
    store.update({ provider: 'anthropic', apiKey: 'sk-ant-VERY-SECRET' })
    const files = readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
    expect(files).not.toContain('VERY-SECRET')
    expect(JSON.stringify(store.view())).not.toContain('VERY-SECRET')
    expect(store.view().hasKey).toBe(true)
    expect(store.apiKey()).toBe('sk-ant-VERY-SECRET')
    // A fresh start reads it back.
    expect(new AssistantSettingsStore(dir, fakeBox()).apiKey('anthropic')).toBe('sk-ant-VERY-SECRET')
    store.update({ apiKey: '' })
    expect(store.view().hasKey).toBe(false)
    expect(store.apiKey()).toBeNull()
  })

  it('keeps a key only in memory when the system cannot store secrets', () => {
    const store = new AssistantSettingsStore(dir, fakeBox(false))
    store.update({ provider: 'openai', apiKey: 'sk-mem' })
    expect(store.apiKey()).toBe('sk-mem')
    expect(readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8')).join('')).not.toContain('sk-mem')
    expect(new AssistantSettingsStore(dir, fakeBox(false)).apiKey('openai')).toBeNull()
  })

  it('clears the previous server credentials and consent when a custom address changes', () => {
    const store = new AssistantSettingsStore(dir, fakeBox())
    store.update({ provider: 'custom', baseUrl: 'https://first.invalid', apiKey: 'fixture', consent: { granted: true, shareNames: true } })
    store.update({ baseUrl: 'https://second.invalid' })
    const reopened = new AssistantSettingsStore(dir, fakeBox())
    expect(reopened.apiKey()).toBeNull()
    expect(reopened.consentGiven()).toBe(false)
    expect(reopened.mayShareNames()).toBe(false)
  })

  it('needs consent for cloud providers only, per provider, and names only with a second yes', () => {
    const store = new AssistantSettingsStore(dir, fakeBox())
    expect(store.consentGiven()).toBe(true) // basics
    store.update({ provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1' })
    expect(store.leavesComputer()).toBe(false)
    expect(store.consentGiven()).toBe(true)
    expect(store.mayShareNames()).toBe(true)

    store.update({ provider: 'anthropic' })
    expect(store.leavesComputer()).toBe(true)
    expect(store.consentGiven()).toBe(false)
    expect(store.mayShareNames()).toBe(false)
    store.update({ consent: { granted: true, shareNames: false } })
    expect(store.consentGiven()).toBe(true)
    expect(store.mayShareNames()).toBe(false)
    store.update({ consent: { granted: true, shareNames: true } })
    expect(store.mayShareNames()).toBe(true)

    // Switching to another cloud provider asks again.
    store.update({ provider: 'openai' })
    expect(store.consentGiven()).toBe(false)
    // A "custom" server that is not on this computer is cloud too.
    store.update({ provider: 'custom', baseUrl: 'https://router.example.com/v1' })
    expect(store.leavesComputer()).toBe(true)
    store.update({ baseUrl: 'http://localhost:8080/v1' })
    expect(store.leavesComputer()).toBe(false)
    expect(store.view().staysLocal).toBe(true)
  })
})

describe('reading the answer of a model', () => {
  it('separates what is supported by the library from ideas', () => {
    const blocks = parseAnswer('Hello there.\n\n[library] You have 12 favorites.\n\n[idea] Try warmer light.\n- one\n- two\n\nAnd a plain closing line.')
    expect(blocks.map((b) => (b.type === 'text' ? b.basis : b.type))).toEqual(['plain', 'library', 'idea', 'plain'])
    expect((blocks[1] as { text: string }).text).toBe('You have 12 favorites.')
    expect((blocks[2] as { text: string }).text).toContain('- one')
  })
})

describe('the assistant in the library', () => {
  let workDir = ''
  let db: AtlasDatabase | null = null
  let rootId = ''
  let engine: AssistantEngine | null = null
  let store: AssistantSettingsStore | null = null
  let counter = 0
  const ids: Record<string, string[]> = { fog: [], city: [] }

  const embedder = {
    async embedTexts(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => (/fog|mist|forest/i.test(t) ? axis(0) : /city|street/i.test(t) ? axis(1) : axis(5)))
    }
  } as unknown as Embedder

  function addImage(kind: 'fog' | 'city', tags: string[]): string {
    counter += 1
    const path = join(workDir, 'images', `${kind}-${counter}.png`)
    const record: ScannedImageRecord = {
      id: imageIdForPath(path),
      rootId,
      path,
      folder: join(workDir, 'images', 'private-folder'),
      filename: `${kind}-${counter}.png`,
      ext: 'png',
      bytes: 1000,
      width: 64,
      height: 64,
      orientation: 1,
      mtime: 1_700_000_000_000,
      color: '#777777',
      thumbStatus: 'ready',
      thumbError: null,
      scanToken: 't'
    }
    db!.upsertScannedImage(record)
    db!.saveEmbeddings(EMBEDDING_MODEL, [{ id: record.id, mtime: record.mtime, vector: axis(kind === 'fog' ? 0 : 1, counter) }])
    if (tags.length) db!.updateImage({ id: record.id, tags })
    ids[kind]!.push(record.id)
    return record.id
  }

  function makeEngine(fetchImpl: FetchLike, overrides: Partial<AssistantContext> = {}): AssistantEngine {
    const semantic = new SemanticSearch(db!, async () => embedder)
    const ctx: AssistantContext = {
      db: db!,
      semantic,
      searchable: () => true,
      reference: null,
      identity: async () => null,
      taste: async () => null,
      journeySuggestions: async () => [],
      getEmbedder: async () => embedder,
      mayShareNames: () => store!.mayShareNames(),
      ...overrides
    }
    return new AssistantEngine({ dir: join(workDir, 'assistant'), settings: store!, ctx, fetchImpl })
  }

  beforeEach(async () => {
    workDir = join(tmpdir(), `noema-assist-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(workDir, 'images'), { recursive: true })
    db = new AtlasDatabase(join(workDir, 'library.db'))
    rootId = db.addRoot(join(workDir, 'images')).id
    counter = 0
    ids.fog = []
    ids.city = []
    for (let i = 0; i < 6; i += 1) addImage('fog', ['atmospheric'])
    for (let i = 0; i < 4; i += 1) addImage('city', [])
    store = new AssistantSettingsStore(join(workDir, 'assistant'), fakeBox())
    engine = makeEngine(async () => {
      throw new Error('no network in basics')
    })
  })

  afterEach(async () => {
    db?.close()
    db = null
    await fs.rm(workDir, { recursive: true, force: true })
  })

  it('works offline with the built-in basics: finds images by what they look like', async () => {
    const reply = await engine!.send(null, 'Find my most atmospheric forest images')
    const last = reply.chat.messages.at(-1)!
    const images = last.blocks.find((b) => b.type === 'images')
    expect(images?.type).toBe('images')
    if (images?.type === 'images') {
      expect(images.items!.length).toBeGreaterThan(0)
      // The foggy images come first.
      expect(images.ids.slice(0, 6).every((id) => ids.fog!.includes(id))).toBe(true)
    }
    expect(last.blocks.some((b) => b.type === 'text' && b.basis === 'library')).toBe(true)
    expect(reply.chat.title).toContain('Find my most')
    // Conversations are saved and can be listed and reopened.
    expect(engine!.listChats()).toHaveLength(1)
    expect(engine!.getChat(reply.chat.id)!.messages).toHaveLength(2)
  })

  it('proposes a moodboard and creates nothing until the user accepts', async () => {
    const reply = await engine!.send(null, 'Create a moodboard of foggy forest')
    const proposal = reply.chat.messages.at(-1)!.blocks.find((b) => b.type === 'proposal')
    expect(proposal?.type).toBe('proposal')
    expect(db!.listMoodboards()).toHaveLength(0)

    const dismissed = engine!.respondToProposal(reply.chat.id, (proposal as { id: string }).id, false)
    expect(db!.listMoodboards()).toHaveLength(0)
    expect((dismissed.messages.at(-1)!.blocks.find((b) => b.type === 'proposal') as { status: string }).status).toBe('dismissed')

    const again = await engine!.send(reply.chat.id, 'Create a moodboard of foggy forest')
    const second = again.chat.messages.at(-1)!.blocks.find((b) => b.type === 'proposal') as { id: string }
    const applied = engine!.respondToProposal(again.chat.id, second.id, true)
    const boards = db!.listMoodboards()
    expect(boards).toHaveLength(1)
    expect(boards[0]!.imageCount).toBeGreaterThan(0)
    expect((applied.messages.at(-1)!.blocks.find((b) => b.type === 'proposal') as { status: string }).status).toBe('applied')
    // A second accept does nothing.
    engine!.respondToProposal(again.chat.id, second.id, true)
    expect(db!.listMoodboards()[0]!.imageCount).toBe(boards[0]!.imageCount)
  })

  it('suggests images that complement a moodboard and proposes adding them without changing it', async () => {
    const board = db!.createMoodboard('Quiet mornings')
    db!.addToMoodboard(board.id, ids.fog!.slice(0, 3), [])
    const reply = await engine!.send(null, 'Find images that would complement my "Quiet mornings" moodboard')
    const blocks = reply.chat.messages.at(-1)!.blocks
    const suggested = blocks.find((b) => b.type === 'images')
    expect(suggested?.type).toBe('images')
    if (suggested?.type === 'images') {
      expect(suggested.ids.every((id) => !ids.fog!.slice(0, 3).includes(id))).toBe(true)
      // Near-identical images are not suggested twice, so the list varies; the closest match comes first.
      expect(ids.fog!.includes(suggested.ids[0]!)).toBe(true)
    }
    expect(blocks.some((b) => b.type === 'proposal' && b.proposal.kind === 'add-to-moodboard')).toBe(true)
    expect(db!.getMoodboard(board.id)!.imageCount).toBe(3)
  })

  it('tells questions about personal taste apart from image searches, in English and Swedish', async () => {
    const taste = [
      'What is my personal taste?', 'what is my taste', 'Tell me about my taste', 'How would you describe my aesthetic?',
      'What kind of art do I like?', 'what am I drawn to', 'Describe my artistic style', 'What does my visual identity look like?',
      'Can you analyse my preferences?', 'What do my choices say about me?', 'Show me my taste',
      'Vad är min personliga smak?', 'vad är min smak', 'Berätta om min smak', 'Vad gillar jag?', 'Beskriv min konstnärliga stil',
      'Hur ser min estetik ut?', 'Vad säger mina val om mig?', 'Vilken stil har jag?', 'min smak'
    ]
    for (const text of taste) expect(readIntent(text).intent, text).toBe('taste')
    const search = [
      'Find my most atmospheric landscape images', 'show me foggy forests', 'images of old cities at night', 'hitta bilder på dimmiga skogar',
      'visa mina mest stämningsfulla landskap', 'search for red doors', 'foggy forest', 'dimmig skog'
    ]
    for (const text of search) expect(readIntent(text).intent, text).toBe('search')
    const mixed = ['Find images that match my taste', 'hitta bilder som passar min smak']
    for (const text of mixed) expect(readIntent(text).intent, text).toBe('ambiguous')
    expect(readIntent('What do I like about forests?').intent).not.toBe('search')
  })

  it('answers "what is my taste?" from the taste engines and never runs an image search', async () => {
    const withIdentity = makeEngine(
      async () => {
        throw new Error('offline')
      },
      {
        identity: async () =>
          ({
            available: true,
            favorites: 12,
            tentative: false,
            dimensions: [{ certain: true, mean: 1, label: 'Misty and quiet' }],
            modes: []
          }) as never,
        taste: async () =>
          ({
            available: true,
            compassChoices: 40,
            stage: 'ready',
            dimensions: [{ certain: true, lean: 0.8, clear: 30, label: 'Muted colour' }]
          }) as never
      }
    )
    for (const text of ['What is my personal taste?', 'Vad är min smak?']) {
      const reply = await withIdentity.send(null, text)
      const last = reply.chat.messages.at(-1)!
      expect(last.blocks.some((b) => b.type === 'images'), text).toBe(false)
      const said = last.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ')
      expect(said).toContain('Misty and quiet')
      expect(said).toContain('Muted colour')
    }
  })

  it('explains what it needs when there is no taste data yet, instead of showing unrelated images', async () => {
    const reply = await engine!.send(null, 'What is my personal taste?')
    const last = reply.chat.messages.at(-1)!
    expect(last.blocks.some((b) => b.type === 'images')).toBe(false)
    expect(JSON.stringify(last.blocks)).toContain('favorites')
  })

  it('asks a short question when a request could be taste or search', async () => {
    for (const text of ['Find images that match my taste', 'hitta bilder som passar min smak']) {
      const reply = await engine!.send(null, text)
      const last = reply.chat.messages.at(-1)!
      expect(last.blocks.some((b) => b.type === 'images'), text).toBe(false)
      expect(last.blocks).toHaveLength(1)
    }
  })

  it('explains itself when asked something it cannot do, and never fails on empty input', async () => {
    const reply = await engine!.send(null, '   ')
    expect(reply.chat.messages).toHaveLength(0)
    const hello = await engine!.send(null, 'hello')
    expect((hello.chat.messages.at(-1)!.blocks[0] as { text: string }).text).toContain('favorites')
  })

  // A scripted Anthropic server that behaves like a model with working tool use.
  const toolUsingAnthropic = (opts: { modelWorks: () => boolean; emptyAfterTool?: boolean; ignoreTools?: boolean }) =>
    fakeFetch((call) => {
      if (call.url.includes('/models')) return { body: { data: [{ id: 'broken-model' }, { id: 'good-model' }] } }
      if (!opts.modelWorks()) return { status: 404, body: { error: { message: 'model not found' } } }
      if (opts.ignoreTools) return { body: { content: [{ type: 'text', text: 'Hi there.' }] } }
      const hasResult = JSON.stringify(call.body).includes('tool_result')
      if (!hasResult) return { body: { content: [{ type: 'tool_use', id: 'u1', name: 'atlas_check', input: { word: 'ready' } }] } }
      return { body: { content: opts.emptyAfterTool ? [] : [{ type: 'text', text: 'Hello, I am glad to be here.' }] } }
    })

  it('separates a reachable provider from a model that has actually answered and used a tool', async () => {
    store!.update({ provider: 'anthropic', apiKey: 'k', model: 'broken-model', consent: { granted: true, shareNames: false } })
    let modelWorks = false
    const { fetch, calls } = toolUsingAnthropic({ modelWorks: () => modelWorks })
    const cloud = makeEngine(fetch)
    const first = await cloud.testConnection()
    // The server answered, the model did not: not ready, and Atlas does not say so.
    expect(first.connected).toBe(true)
    expect(first.verified).toBe(false)
    expect(first.ok).toBe(false)
    expect(first.greeting).toBeNull()
    expect(first.message).toContain('did not answer')
    expect(store!.view().verified).toBe(false)

    modelWorks = true
    const second = await cloud.testConnection()
    expect(second.ok && second.verified).toBe(true)
    expect(second.greeting).toBe('Hello, I am glad to be here.')
    expect(second.message).toContain('used a tool')
    expect(store!.view().verified).toBe(true)
    // Two requests: the tool call, then the reply after the tool result. Neither carries library data.
    expect(calls.filter((c) => !c.url.includes('/models') && JSON.stringify(c.body).includes('atlas_check'))).toHaveLength(3)
    expect(JSON.stringify(calls.at(-1)!.body)).not.toContain('fog')

    // Opening settings and testing again does not greet a second time.
    const third = await cloud.testConnection()
    expect(third.verified).toBe(true)
    expect(third.greeting).toBeNull()

    // Another model has not answered yet, so the earlier verification no longer counts.
    store!.update({ model: 'good-model' })
    expect(store!.view().verified).toBe(false)
  })

  it('does not call a setup verified when the model ignores tools, answers with nothing, or the key is wrong', async () => {
    store!.update({ provider: 'anthropic', apiKey: 'k', model: 'good-model', consent: { granted: true, shareNames: false } })
    const noTools = await makeEngine(toolUsingAnthropic({ modelWorks: () => true, ignoreTools: true }).fetch).testConnection()
    expect(noTools.connected).toBe(true)
    expect(noTools.verified).toBe(false)
    expect(noTools.message).toContain('did not use the tool')
    const empty = await makeEngine(toolUsingAnthropic({ modelWorks: () => true, emptyAfterTool: true }).fetch).testConnection()
    expect(empty.verified).toBe(false)
    const denied = await makeEngine(fakeFetch(() => ({ status: 401, body: { error: { message: 'bad key' } } })).fetch).testConnection()
    expect(denied.connected).toBe(false)
    expect(denied.verified).toBe(false)
    expect(store!.view().verified).toBe(false)
  })

  // ---- the OpenAI Responses API ---------------------------------------------------------------------------------------------
  const CHAT_REFUSAL = { status: 400, body: { error: { message: 'Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions.' } } }
  type ResponsesCall = { body: Record<string, unknown>; headers: Record<string, string> }
  /** A scripted /v1/responses server. `steps` produce the output items for each successive request. */
  function responsesServer(steps: Array<(body: Record<string, unknown>) => unknown[]>, chatBehaviour: 'refuse' | 'fail' = 'fail') {
    const responses: ResponsesCall[] = []
    let chatCalls = 0
    let i = 0
    const { fetch } = fakeFetch((call) => {
      if (call.url.endsWith('/models')) return { body: { data: [{ id: 'gpt-6.1-sol' }] } }
      if (call.url.endsWith('/chat/completions')) {
        chatCalls += 1
        return chatBehaviour === 'refuse' ? CHAT_REFUSAL : { status: 500, body: {} }
      }
      responses.push({ body: call.body, headers: call.headers })
      const step = steps[Math.min(i, steps.length - 1)]!
      i += 1
      return { body: { status: 'completed', output: step(call.body) } }
    })
    return { fetch, responses, chatCalls: () => chatCalls }
  }
  const message = (text: string): unknown => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
  const reasoning = (n: number): unknown => ({ type: 'reasoning', id: `rs_${n}`, encrypted_content: `enc-${n}`, summary: [] })
  const functionCall = (id: string, name: string, args: unknown): unknown => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) })
  const lastOutput = (body: Record<string, unknown>): Record<string, unknown> => {
    const items = (body.input as Array<Record<string, unknown>>).filter((x) => x.type === 'function_call_output')
    return JSON.parse(String(items.at(-1)!.output)) as Record<string, unknown>
  }
  const openAiSetup = (model: string): void => {
    store!.update({ provider: 'openai', apiKey: 'sk-test', model, consent: { granted: true, shareNames: false } })
  }
  const tasteCtx = {
    identity: async () =>
      ({ available: true, favorites: 12, tentative: false, dimensions: [{ certain: true, mean: 1, label: 'Misty and quiet' }], modes: [] }) as never,
    taste: async () =>
      ({ available: true, compassChoices: 40, stage: 'ready', dimensions: [{ certain: true, lean: 0.8, clear: 30, label: 'Muted colour' }] }) as never
  }

  it('chooses the Responses API by model family and keeps Chat Completions for older models', () => {
    for (const model of ['gpt-6.1-sol', 'gpt-5', 'gpt-5.2-mini', 'o3', 'o4-mini']) expect(prefersResponsesApi('https://api.openai.com/v1', model), model).toBe(true)
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-4o-mini', 'llama3.1']) expect(prefersResponsesApi('https://api.openai.com/v1', model), model).toBe(false)
    expect(prefersResponsesApi('http://127.0.0.1:11434/v1', 'gpt-6.1-sol')).toBe(false)
  })

  it('talks to GPT-6.1 Sol through /v1/responses: tools, reasoning items, no reasoning_effort, nothing stored', async () => {
    openAiSetup('gpt-6.1-sol')
    const server = responsesServer([
      () => [reasoning(1), functionCall('c1', 'favorites_profile', {})],
      () => [reasoning(2), functionCall('c2', 'taste_summary', {})],
      () => [reasoning(3), message('[library] Your favorites lean misty and quiet.\n\n[idea] You might try dusk light.')]
    ])
    const engine = makeEngine(server.fetch, tasteCtx)
    const reply = await engine.send(null, 'What is my personal taste?')
    const blocks = reply.chat.messages.at(-1)!.blocks
    expect(blocks.filter((b) => b.type === 'text').map((b) => (b as { basis: string }).basis)).toEqual(['library', 'idea'])
    expect(server.chatCalls()).toBe(0)
    expect(server.responses).toHaveLength(3)
    const first = server.responses[0]!.body
    expect(first.model).toBe('gpt-6.1-sol')
    expect(first.store).toBe(false)
    expect('reasoning_effort' in first).toBe(false)
    expect(JSON.stringify(first)).not.toContain('reasoning_effort')
    expect(typeof first.instructions).toBe('string')
    // Tools are flat function tools, the same set as everywhere else.
    const tools = first.tools as Array<{ type: string; name: string; parameters: unknown }>
    expect(tools.every((t) => t.type === 'function' && typeof t.name === 'string' && t.parameters)).toBe(true)
    expect(tools.map((t) => t.name)).toContain('favorites_profile')
    expect(server.responses[0]!.headers.authorization).toBe('Bearer sk-test')
    // The second request carries the first step: reasoning, the call, and its result tied to the same call id.
    const input = server.responses[1]!.body.input as Array<Record<string, unknown>>
    expect(input.some((x) => x.type === 'reasoning' && x.encrypted_content === 'enc-1')).toBe(true)
    expect(input.some((x) => x.type === 'function_call' && x.call_id === 'c1')).toBe(true)
    const result = input.find((x) => x.type === 'function_call_output' && x.call_id === 'c1')
    expect(JSON.parse(String(result!.output)).favorites).toBe(12)
    // The taste profile reached the model as text, never as images or ids.
    expect(JSON.stringify(server.responses[2]!.body.input)).toContain('Muted colour')
  })

  it('searches images and proposes a moodboard through the Responses API, changing nothing until accepted', async () => {
    openAiSetup('gpt-6.1-sol')
    const boardsBefore = db!.listMoodboards().length
    const server = responsesServer([
      () => [reasoning(1), functionCall('s1', 'search_images', { query: 'foggy forest', limit: 6 })],
      (body) => {
        const refs = (lastOutput(body).images as Array<{ ref: string }>).map((i) => i.ref)
        return [reasoning(2), functionCall('p1', 'propose_moodboard', { name: 'Fog', refs, reason: 'They look alike.' })]
      },
      () => [message('[library] I found foggy images and drafted a moodboard for you to review.')]
    ])
    const engine = makeEngine(server.fetch)
    const reply = await engine.send(null, 'Find foggy forests and make a moodboard of them')
    const blocks = reply.chat.messages.at(-1)!.blocks
    expect(blocks.some((b) => b.type === 'images')).toBe(true)
    const proposal = blocks.find((b) => b.type === 'proposal')
    expect(proposal).toBeTruthy()
    expect(db!.listMoodboards().length).toBe(boardsBefore)
    // A follow-up keeps working: history is replayed as plain messages, and the proposal can still be accepted.
    engine.respondToProposal(reply.chat.id, (proposal as { id: string }).id, true)
    expect(db!.listMoodboards().length).toBe(boardsBefore + 1)
    const follow = await engine.send(reply.chat.id, 'Thanks. What else?')
    expect(follow.chat.messages.at(-1)!.role).toBe('assistant')
    const replayed = server.responses.at(-1)!.body.input as Array<Record<string, unknown>>
    expect(replayed.filter((x) => x.role === 'user').length).toBe(2)
    expect(server.chatCalls()).toBe(0)
  })

  it('learns from the provider that a model needs /v1/responses, falls back once, and remembers', async () => {
    // A custom address, so the model name alone does not decide; the provider's own error does.
    store!.update({ provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'learned-model-x', consent: { granted: true, shareNames: true } })
    const server = responsesServer([() => [message('Hello from the Responses API.')]], 'refuse')
    const engine = makeEngine(server.fetch)
    const one = await engine.send(null, 'hello there, tell me about your day please')
    expect(server.chatCalls()).toBe(1)
    expect(server.responses.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(one.chat.messages.at(-1)!.blocks)).toBeTruthy()
    const before = server.chatCalls()
    await engine.send(one.chat.id, 'and again please, what do you think')
    expect(server.chatCalls()).toBe(before)
  })

  it('verifies GPT-6.1 Sol with a real answer and a tool round trip through /v1/responses', async () => {
    openAiSetup('gpt-6.1-sol')
    const server = responsesServer([
      () => [reasoning(1), functionCall('k1', 'atlas_check', { word: 'ready' })],
      () => [reasoning(2), message('Hello! Lovely to meet you.')]
    ])
    const engine = makeEngine(server.fetch)
    const result = await engine.testConnection()
    expect(result.ok && result.verified).toBe(true)
    expect(result.greeting).toBe('Hello! Lovely to meet you.')
    expect(server.chatCalls()).toBe(0)
    expect(JSON.stringify(server.responses[1]!.body.input)).toContain('echoed')
  })

  it('still uses Chat Completions for models that work there', async () => {
    openAiSetup('gpt-4o')
    const urls: string[] = []
    const { fetch } = fakeFetch((call) => {
      urls.push(call.url)
      if (call.url.endsWith('/models')) return { body: { data: [{ id: 'gpt-4o' }] } }
      return { body: { choices: [{ message: { content: '[library] Plain chat works.' } }] } }
    })
    const engine = makeEngine(fetch)
    await engine.send(null, 'tell me something about my pictures please')
    expect(urls.some((u) => u.endsWith('/chat/completions'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/responses'))).toBe(false)
  })

  it('does not contact a cloud provider before the user has agreed', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { content: [{ type: 'text', text: 'x' }] } }))
    store!.update({ provider: 'anthropic', apiKey: 'k', model: 'claude-x' })
    const cloud = makeEngine(fetch)
    const reply = await cloud.send(null, 'Find fog')
    expect(reply.needs).toBe('consent')
    expect(calls).toHaveLength(0)
    expect((await cloud.testConnection()).ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('lets a language model use the tools, keeps paths and file names away from it, and labels what it says', async () => {
    store!.update({ provider: 'anthropic', apiKey: 'k', model: 'claude-x', consent: { granted: true, shareNames: false } })
    let step = 0
    const { fetch, calls } = fakeFetch(() => {
      step += 1
      if (step === 1) return { body: { content: [{ type: 'tool_use', id: 'u1', name: 'search_images', input: { query: 'foggy forest', limit: 4 } }] } }
      return { body: { content: [{ type: 'text', text: '[library] I found foggy images in your library.\n\n[idea] You might try a night version of them.' }] } }
    })
    const cloud = makeEngine(fetch)
    const reply = await cloud.send(null, 'show me something foggy')
    const blocks = reply.chat.messages.at(-1)!.blocks
    expect(blocks.filter((b) => b.type === 'text').map((b) => (b as { basis: string }).basis)).toEqual(['library', 'idea'])
    expect(blocks.some((b) => b.type === 'images')).toBe(true)
    expect(calls).toHaveLength(2)
    const sent = JSON.stringify(calls.map((c) => c.body))
    expect(sent).not.toContain('private-folder')
    expect(sent).not.toContain('fog-1.png')
    expect(sent).not.toContain(workDir.replace(/\\/g, '\\\\'))
    expect(sent).not.toContain('thumb')
    expect(sent).toContain('atmospheric') // tags are descriptions and are shared
    expect(calls[0]!.headers['x-api-key']).toBe('k')
    // The model sees short references, not image ids.
    for (const id of [...ids.fog!, ...ids.city!]) expect(sent).not.toContain(id)
  })

  it('shares file names only after the second, explicit yes', async () => {
    store!.update({ provider: 'anthropic', apiKey: 'k', model: 'claude-x', consent: { granted: true, shareNames: true } })
    let step = 0
    const { fetch, calls } = fakeFetch(() => {
      step += 1
      return step === 1
        ? { body: { content: [{ type: 'tool_use', id: 'u1', name: 'search_images', input: { query: 'fog' } }] } }
        : { body: { content: [{ type: 'text', text: 'ok' }] } }
    })
    await makeEngine(fetch).send(null, 'fog')
    expect(JSON.stringify(calls.map((c) => c.body))).toContain('private-folder')
  })

  it('never changes a moodboard when the model only proposes', async () => {
    const board = db!.createMoodboard('Calm')
    store!.update({ provider: 'openai', apiKey: 'k', model: 'm', consent: { granted: true, shareNames: false } })
    let step = 0
    const { fetch } = fakeFetch(() => {
      step += 1
      if (step === 1) return { body: { choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'search_images', arguments: '{"query":"fog"}' } }] } }] } }
      if (step === 2) {
        return { body: { choices: [{ message: { tool_calls: [{ id: 'b', function: { name: 'propose_add_to_moodboard', arguments: JSON.stringify({ board: 'Calm', refs: ['i1', 'i2'], reason: 'fits' }) } }] } }] } }
      }
      return { body: { choices: [{ message: { content: '[idea] I proposed some additions. You decide.' } }] } }
    })
    const reply = await makeEngine(fetch).send(null, 'improve my Calm moodboard')
    expect(db!.getMoodboard(board.id)!.imageCount).toBe(0)
    const proposal = reply.chat.messages.at(-1)!.blocks.find((b) => b.type === 'proposal')
    expect(proposal).toBeTruthy()
  })

  it('reports provider problems in plain words and keeps the conversation', async () => {
    store!.update({ provider: 'openai', apiKey: 'bad', model: 'm', consent: { granted: true, shareNames: false } })
    const { fetch } = fakeFetch(() => ({ status: 401, body: { error: { message: 'nope' } } }))
    const reply = await makeEngine(fetch).send(null, 'hello')
    expect(reply.needs).toBe('setup')
    expect((reply.chat.messages.at(-1)!.blocks[0] as { text: string }).text).toContain('API key')
    expect(reply.chat.messages).toHaveLength(2)
  })

  it('deletes conversations', async () => {
    const reply = await engine!.send(null, 'hello')
    engine!.deleteChat(reply.chat.id)
    expect(engine!.listChats()).toEqual([])
    expect(engine!.getChat(reply.chat.id)).toBeNull()
  })
})
