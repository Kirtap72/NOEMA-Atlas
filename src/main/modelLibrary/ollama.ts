// Talks to the user's own Ollama (https://ollama.com) on this computer. Atlas never installs Ollama and never runs a script: it asks
// the running Ollama which models it has, and, only after the user agrees, asks it to download one with Ollama's own pull call.

export type OllamaFetch = (url: string, init?: Record<string, unknown>) => Promise<Response>

export const OLLAMA_URL = 'http://127.0.0.1:11434'

/** "moondream" and "moondream:latest" are the same model. */
export const tagKey = (name: string): string => (name.includes(':') ? name : `${name}:latest`).toLowerCase()

export class OllamaClient {
  constructor(
    private fetchImpl: OllamaFetch,
    readonly baseUrl: string = OLLAMA_URL
  ) {}

  /** The models Ollama has, or null when Ollama is not running. */
  async tags(): Promise<string[] | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) })
      if (!response.ok) return null
      const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> }
      return (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean)
    } catch {
      return null
    }
  }

  async has(name: string): Promise<boolean | null> {
    const tags = await this.tags()
    return tags === null ? null : tags.some((t) => tagKey(t) === tagKey(name))
  }

  /** Downloads a model into Ollama, reporting progress. Ollama verifies its own downloads. */
  async pull(name: string, onProgress: (done: number, total: number | null, status: string) => void, signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: true }), signal })
    if (!response.ok || !response.body) {
      let detail = ''
      try {
        detail = ((await response.json()) as { error?: string }).error ?? ''
      } catch {
        detail = ''
      }
      throw new Error(`Ollama refused to download “${name}”${detail ? `: ${detail}` : ''}.`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let failure = ''
    let finished = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string }
          if (row.error) failure = row.error
          if (row.status === 'success') finished = true
          onProgress(row.completed ?? 0, row.total ?? null, row.status ?? '')
        } catch {
          // a partial line; the next chunk completes it
        }
      }
    }
    if (failure) throw new Error(`Ollama could not download “${name}”: ${failure}`)
    if (!finished) throw new Error(`The download of “${name}” ended before Ollama said it was complete. Try again.`)
  }
}
