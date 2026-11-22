import { isLoopback } from '../../shared/network'
export { isLoopback } from '../../shared/network'
import type { AssistantProviderId, LocalServer } from '../../shared/assistant'

/**
 * A model-independent way to talk to a language model. The assistant only knows this small interface; each provider
 * translates it to its own wire format. Everything is plain HTTPS/HTTP from the main process, with no vendor SDK, so
 * any server that speaks the OpenAI chat format (OpenAI, OpenRouter, Ollama, LM Studio, llama.cpp, vLLM ...) or the
 * Anthropic Messages format works.
 */
export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** A picture handed to a model that can look at pictures. Always JPEG or PNG bytes, as base64. */
export interface ImagePart {
  type: 'image'
  mime: 'image/jpeg' | 'image/png'
  base64: string
  /** A short name so the model can refer to the picture ("Picture 2"). Never sent as metadata of its own. */
  label?: string
}
export type ContentPart = { type: 'text'; text: string } | ImagePart
/** A user turn is plain text, or text mixed with pictures. */
export type UserContent = string | ContentPart[]

/** The text of a turn, ignoring any pictures. */
export function textOf(content: UserContent): string {
  return typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : `[${p.label ?? 'picture'}]`)).join('\n')
}
/** How many pictures a turn carries. */
export function imageCount(content: UserContent): number {
  return typeof content === 'string' ? 0 : content.filter((p) => p.type === 'image').length
}
const dataUrl = (p: ImagePart): string => `data:${p.mime};base64,${p.base64}`

export type ChatTurn =
  | { role: 'user'; content: UserContent }
  /** `raw` holds the provider's own items for this turn (for example encrypted reasoning that must be passed back). Opaque to Atlas. */
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; raw?: unknown[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface CompletionRequest {
  system: string
  turns: ChatTurn[]
  tools: ToolSpec[]
  signal?: AbortSignal
}

export interface Completion {
  text: string
  toolCalls: ToolCall[]
  raw?: unknown[]
}

export interface ChatProvider {
  readonly id: AssistantProviderId
  complete(request: CompletionRequest): Promise<Completion>
  listModels(): Promise<string[]>
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'rate' | 'server' | 'bad-request' | 'unsupported'
  ) {
    super(message)
  }
}

export const PRESETS: Record<'anthropic' | 'openai', { baseUrl: string; model: string; name: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', name: 'Anthropic (Claude)' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: '', name: 'OpenAI' }
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '')

async function send(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  timeoutMs: number
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const outside = init.signal
  const onAbort = (): void => controller.abort()
  outside?.addEventListener('abort', onAbort)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      // Never echo the request (it carries the key); only a short reason from the provider.
      let detail = ''
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string }
        detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message ?? '')
      } catch {
        detail = ''
      }
      detail = detail.slice(0, 240)
      if (response.status === 401 || response.status === 403) throw new ProviderError('The provider did not accept the API key.', 'auth')
      if (response.status === 429) throw new ProviderError('The provider says there are too many requests right now. Try again in a moment.', 'rate')
      if (response.status === 404) throw new ProviderError(`The provider does not know this model or address.${detail ? ` (${detail})` : ''}`, 'bad-request')
      if (response.status >= 500) throw new ProviderError('The provider had a problem. Try again in a moment.', 'server')
      throw new ProviderError(`The provider refused the request${detail ? `: ${detail}` : '.'}`, 'bad-request')
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new ProviderError('The provider answered in a way Atlas could not read.', 'server')
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error
    if (outside?.aborted) throw new ProviderError('Stopped.', 'network')
    if (controller.signal.aborted) throw new ProviderError('The provider took too long to answer.', 'network')
    throw new ProviderError('Atlas could not reach the provider. Check the address and your connection.', 'network')
  } finally {
    clearTimeout(timer)
    outside?.removeEventListener('abort', onAbort)
  }
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The OpenAI chat format, which most local and hosted servers speak. */
export class OpenAiCompatibleProvider implements ChatProvider {
  constructor(
    readonly id: AssistantProviderId,
    private baseUrl: string,
    private model: string,
    private apiKey: string | null,
    private fetchImpl: FetchLike,
    private timeoutMs = 120_000
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    return headers
  }

  async listModels(): Promise<string[]> {
    const body = (await send(this.fetchImpl, `${trimSlash(this.baseUrl)}/models`, { headers: this.headers() }, Math.min(15_000, this.timeoutMs))) as { data?: Array<{ id?: string }> }
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort()
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (!this.model) throw new ProviderError('Choose a model first.', 'bad-request')
    const messages: unknown[] = [{ role: 'system', content: request.system }]
    for (const turn of request.turns) {
      if (turn.role === 'user') {
        messages.push({ role: 'user', content: typeof turn.content === 'string' ? turn.content : turn.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: dataUrl(p) } })) })
      } else if (turn.role === 'tool') messages.push({ role: 'tool', tool_call_id: turn.toolCallId, content: turn.content })
      else {
        messages.push({
          role: 'assistant',
          content: turn.content || null,
          ...(turn.toolCalls?.length
            ? { tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
            : {})
        })
      }
    }
    const body: Record<string, unknown> = { model: this.model, messages }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    const reply = (await send(
      this.fetchImpl,
      `${trimSlash(this.baseUrl)}/chat/completions`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: request.signal },
      this.timeoutMs
    )) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }> }
    const message = reply.choices?.[0]?.message
    if (!message) throw new ProviderError('The provider sent an empty answer.', 'server')
    const toolCalls: ToolCall[] = (message.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => ({ id: c.id || `call_${i}`, name: c.function!.name!, args: parseArgs(c.function!.arguments) }))
    return { text: typeof message.content === 'string' ? message.content : '', toolCalls }
  }
}

/**
 * The OpenAI Responses API (`/v1/responses`). Newer models (the GPT-5 and GPT-6 families, reasoning models) need it for
 * function tools together with reasoning. Same tools, same history; only the wire format differs. Nothing is stored at
 * the provider (`store: false`), and no `reasoning_effort` is sent: the model uses its own default. Encrypted reasoning
 * items are carried between the steps of one answer so tool use keeps working without server-side storage.
 */
export class OpenAiResponsesProvider implements ChatProvider {
  private lister: OpenAiCompatibleProvider
  constructor(
    readonly id: AssistantProviderId,
    private baseUrl: string,
    private model: string,
    private apiKey: string | null,
    private fetchImpl: FetchLike,
    private timeoutMs = 120_000
  ) {
    this.lister = new OpenAiCompatibleProvider(id, baseUrl, model, apiKey, fetchImpl, timeoutMs)
  }

  listModels(): Promise<string[]> {
    return this.lister.listModels()
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    return headers
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (!this.model) throw new ProviderError('Choose a model first.', 'bad-request')
    const input: unknown[] = []
    for (const turn of request.turns) {
      if (turn.role === 'user') {
        input.push({ role: 'user', content: typeof turn.content === 'string' ? turn.content : turn.content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: dataUrl(p) })) })
      } else if (turn.role === 'tool') input.push({ type: 'function_call_output', call_id: turn.toolCallId, output: turn.content })
      else if (turn.raw?.length) input.push(...turn.raw)
      else {
        if (turn.content) input.push({ role: 'assistant', content: turn.content })
        for (const call of turn.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) })
      }
    }
    const body: Record<string, unknown> = { model: this.model, instructions: request.system, input, store: false }
    if (request.tools.length > 0) body.tools = request.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))
    const url = `${trimSlash(this.baseUrl)}/responses`
    const post = (withReasoning: boolean): Promise<unknown> =>
      send(this.fetchImpl, url, { method: 'POST', headers: this.headers(), body: JSON.stringify(withReasoning ? { ...body, include: ['reasoning.encrypted_content'] } : body), signal: request.signal }, this.timeoutMs)
    let reply: unknown
    try {
      reply = await post(true)
    } catch (error) {
      // A model without reasoning may not accept the include option; try once without it.
      if (error instanceof ProviderError && error.kind === 'bad-request' && /include|encrypted/i.test(error.message)) reply = await post(false)
      else throw error
    }
    const result = reply as {
      status?: string
      error?: { message?: string } | null
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }>; call_id?: string; id?: string; name?: string; arguments?: unknown }>
    }
    if (result.status === 'failed') throw new ProviderError(`The model could not answer${result.error?.message ? `: ${String(result.error.message).slice(0, 200)}` : '.'}`, 'server')
    const output = result.output ?? []
    let text = ''
    const toolCalls: ToolCall[] = []
    for (const item of output) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          const piece = part.type === 'output_text' ? part.text : part.type === 'refusal' ? part.refusal : undefined
          if (piece) text += (text ? '\n' : '') + piece
        }
      } else if (item.type === 'function_call' && item.name) {
        toolCalls.push({ id: item.call_id ?? item.id ?? `call_${toolCalls.length}`, name: item.name, args: parseArgs(item.arguments) })
      }
    }
    return { text, toolCalls, raw: output }
  }
}

/** True when an error says this model must use the other (Responses) endpoint. */
export function needsResponsesApi(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    error.kind === 'bad-request' &&
    /\/v1\/responses|responses api|not supported.{0,160}chat\/completions|chat\/completions.{0,160}not supported/i.test(error.message)
  )
}

/** Models that OpenAI serves through the Responses API. Older chat models keep using Chat Completions. */
export function prefersResponsesApi(baseUrl: string, model: string): boolean {
  return /api\.openai\.com/i.test(baseUrl) && /^(gpt-(?:[5-9]|\d{2,})|o\d|codex)/i.test(model)
}

const learnedResponses = new Set<string>()

/**
 * One provider for the OpenAI family: Chat Completions for the models that work there, the Responses API for the
 * models that need it. It picks by model name for OpenAI itself, and otherwise (or when the name is new to it) learns
 * from the provider's own error, then remembers. Callers see a single ChatProvider.
 */
export class OpenAiAdaptiveProvider implements ChatProvider {
  private chat: OpenAiCompatibleProvider
  private responses: OpenAiResponsesProvider
  private key: string
  constructor(
    readonly id: AssistantProviderId,
    private baseUrl: string,
    private model: string,
    apiKey: string | null,
    fetchImpl: FetchLike,
    timeoutMs = 120_000
  ) {
    this.chat = new OpenAiCompatibleProvider(id, baseUrl, model, apiKey, fetchImpl, timeoutMs)
    this.responses = new OpenAiResponsesProvider(id, baseUrl, model, apiKey, fetchImpl, timeoutMs)
    this.key = `${baseUrl}|${model}`
  }

  listModels(): Promise<string[]> {
    return this.chat.listModels()
  }

  /** Which wire format this model uses right now. */
  get api(): 'chat' | 'responses' {
    return learnedResponses.has(this.key) || prefersResponsesApi(this.baseUrl, this.model) ? 'responses' : 'chat'
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (this.api === 'responses') return this.responses.complete(request)
    try {
      return await this.chat.complete(request)
    } catch (error) {
      if (!needsResponsesApi(error)) throw error
      learnedResponses.add(this.key)
      return this.responses.complete(request)
    }
  }
}

/** The Anthropic Messages format. */
export class AnthropicProvider implements ChatProvider {
  readonly id: AssistantProviderId = 'anthropic'
  constructor(
    private baseUrl: string,
    private model: string,
    private apiKey: string,
    private fetchImpl: FetchLike,
    private timeoutMs = 120_000
  ) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
  }

  async listModels(): Promise<string[]> {
    const body = (await send(this.fetchImpl, `${trimSlash(this.baseUrl)}/v1/models?limit=100`, { headers: this.headers() }, 15_000)) as { data?: Array<{ id?: string }> }
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean)
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    if (!this.model) throw new ProviderError('Choose a model first.', 'bad-request')
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
    const push = (role: 'user' | 'assistant', block: unknown): void => {
      const last = messages[messages.length - 1]
      if (last && last.role === role) last.content.push(block)
      else messages.push({ role, content: [block] })
    }
    for (const turn of request.turns) {
      if (turn.role === 'user') {
        if (typeof turn.content === 'string') push('user', { type: 'text', text: turn.content })
        else for (const p of turn.content) push('user', p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.base64 } })
      } else if (turn.role === 'tool') push('user', { type: 'tool_result', tool_use_id: turn.toolCallId, content: turn.content })
      else {
        if (turn.content) push('assistant', { type: 'text', text: turn.content })
        for (const call of turn.toolCalls ?? []) push('assistant', { type: 'tool_use', id: call.id, name: call.name, input: call.args })
      }
    }
    const body: Record<string, unknown> = { model: this.model, max_tokens: 3000, system: request.system, messages }
    if (request.tools.length > 0) body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    const reply = (await send(
      this.fetchImpl,
      `${trimSlash(this.baseUrl)}/v1/messages`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: request.signal },
      this.timeoutMs
    )) as { content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> }
    let text = ''
    const toolCalls: ToolCall[] = []
    for (const block of reply.content ?? []) {
      if (block.type === 'text' && block.text) text += (text ? '\n' : '') + block.text
      if (block.type === 'tool_use' && block.name) toolCalls.push({ id: block.id ?? `call_${toolCalls.length}`, name: block.name, args: parseArgs(block.input) })
    }
    return { text, toolCalls }
  }
}

/** Looks for language-model servers already running on this computer (Ollama and LM Studio). Nothing leaves the machine. */
export async function detectLocalServers(fetchImpl: FetchLike): Promise<LocalServer[]> {
  const candidates: Array<Omit<LocalServer, 'models'>> = [
    { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' }
  ]
  const found: LocalServer[] = []
  await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const models = await new OpenAiCompatibleProvider('local', candidate.baseUrl, '', null, fetchImpl, 1500).listModels()
        found.push({ ...candidate, models: models.filter((m) => !/embed/i.test(m)) })
      } catch {
        // Not running; that is normal.
      }
    })
  )
  return found.sort((a, b) => a.id.localeCompare(b.id))
}
