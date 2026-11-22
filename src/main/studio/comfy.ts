import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<Response>

export class ComfyError extends Error {}

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export interface ComfyJob {
  workflow: Workflow
  /** Only pictures saved by these nodes are returned (not every preview on the way). */
  outputNodes?: string[]
  signal?: AbortSignal
  onWait?: (seconds: number) => void
}

/** The ordinary text-to-picture (and picture-to-picture) graph, in ComfyUI's API format. */
export function standardWorkflow(opts: {
  checkpoint: string
  prompt: string
  negative: string
  seed: number
  width: number
  height: number
  steps?: number
  cfg?: number
  /** Name of a picture already uploaded to ComfyUI. Starts from it instead of from noise. */
  image?: string
  /** How much to change the starting picture, 0..1. Ignored without `image`. */
  denoise?: number
  prefix?: string
}): Workflow {
  const w: Workflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: opts.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: opts.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: opts.negative, clip: ['1', 1] } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed: opts.seed,
        steps: opts.steps ?? 28,
        cfg: opts.cfg ?? 6.5,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: opts.image ? Math.max(0.05, Math.min(1, opts.denoise ?? 0.7)) : 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0]
      }
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: opts.prefix ?? 'atlas', images: ['6', 0] } }
  }
  if (opts.image) {
    w['8'] = { class_type: 'LoadImage', inputs: { image: opts.image } }
    w['9'] = { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', width: opts.width, height: opts.height, crop: 'center' } }
    w['4'] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } }
  } else {
    w['4'] = { class_type: 'EmptyLatentImage', inputs: { width: opts.width, height: opts.height, batch_size: 1 } }
  }
  return w
}

/** Fills placeholders such as {{prompt}} in a workflow the user exported from ComfyUI ("Save (API format)"). */
export function fillWorkflow(template: unknown, values: Record<string, string | number>): Workflow {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const whole = /^\{\{(\w+)\}\}$/.exec(node)
      if (whole && whole[1]! in values) return values[whole[1]!]
      return node.replace(/\{\{(\w+)\}\}/g, (all, key: string) => (key in values ? String(values[key]) : all))
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    return node
  }
  return walk(template) as Workflow
}

export class ComfyClient {
  constructor(
    readonly baseUrl: string,
    private fetchImpl: FetchFn
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`
  }

  private async json<T>(path: string, init?: Record<string, unknown>): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(this.url(path), init)
    } catch (error) {
      if (error instanceof ComfyError) throw error
      throw new ComfyError('ComfyUI is not reachable. Is it running?')
    }
    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as { error?: { message?: string } | string; node_errors?: Record<string, { errors?: Array<{ message?: string; details?: string }> }> }
        const errors = Object.values(body.node_errors ?? {}).flatMap((n) => (n.errors ?? []).map((e) => `${e.message ?? ''} ${e.details ?? ''}`.trim()))
        detail = errors[0] ?? (typeof body.error === 'string' ? body.error : body.error?.message ?? '')
      } catch {
        detail = ''
      }
      throw new ComfyError(`ComfyUI refused the request${detail ? `: ${detail}` : ` (${response.status})`}.`)
    }
    return (await response.json()) as T
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(this.url('/system_stats'))
      return response.ok
    } catch {
      return false
    }
  }

  /** The node definitions of this ComfyUI (large). */
  async objectInfo(): Promise<Record<string, never>> {
    return this.json<Record<string, never>>('/object_info')
  }

  /** Every model file name a (possibly remote) ComfyUI offers in its loader nodes. Read-only. */
  async modelNames(): Promise<string[]> {
    const loaders: Array<[string, string]> = [['CheckpointLoaderSimple', 'ckpt_name'], ['UNETLoader', 'unet_name'], ['VAELoader', 'vae_name'], ['CLIPLoader', 'clip_name'], ['LoraLoader', 'lora_name'], ['ControlNetLoader', 'control_net_name'], ['UpscaleModelLoader', 'model_name']]
    const names = new Set<string>()
    for (const [node, field] of loaders) {
      try {
        const info = await this.json<Record<string, { input?: { required?: Record<string, [unknown]> } }>>(`/object_info/${node}`)
        const list = info[node]?.input?.required?.[field]?.[0]
        if (Array.isArray(list)) for (const n of list) if (typeof n === 'string') names.add(n.split(/[\\/]/).pop()!)
      } catch {
        // that loader does not exist on this server
      }
    }
    return [...names]
  }

  async checkpoints(): Promise<string[]> {
    const info = await this.json<{ CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: [string[]] } } } }>('/object_info/CheckpointLoaderSimple')
    return info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
  }

  /** Copies a picture into ComfyUI's input folder (it is a local program, so this stays on the computer). */
  async upload(path: string): Promise<string> {
    const form = new FormData()
    const bytes = await readFile(path)
    form.append('image', new Blob([new Uint8Array(bytes)]), `atlas-${randomUUID().slice(0, 8)}-${basename(path)}`)
    form.append('overwrite', 'true')
    const result = await this.json<{ name: string }>('/upload/image', { method: 'POST', body: form })
    return result.name
  }

  /** Hands ComfyUI a picture that exists only in memory (a mask, a graded copy), as a file in its input folder. */
  async uploadBuffer(bytes: Buffer, name = 'picture.png'): Promise<string> {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)]), `atlas-${randomUUID().slice(0, 8)}-${name}`)
    form.append('overwrite', 'true')
    const result = await this.json<{ name: string }>('/upload/image', { method: 'POST', body: form })
    return result.name
  }

  async run(job: ComfyJob): Promise<Buffer[]> {
    const clientId = randomUUID()
    const queued = await this.json<{ prompt_id: string }>('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: job.workflow, client_id: clientId }),
      signal: job.signal
    })
    const started = Date.now()
    const deadline = started + 15 * 60_000
    while (Date.now() < deadline) {
      if (job.signal?.aborted) {
        await this.fetchImpl(this.url('/interrupt'), { method: 'POST' }).catch(() => undefined)
        throw new ComfyError('Stopped.')
      }
      const history = await this.json<Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>; status?: { status_str?: string } }>>(
        `/history/${queued.prompt_id}`
      )
      const entry = history[queued.prompt_id]
      if (entry) {
        if (entry.status?.status_str === 'error') throw new ComfyError('ComfyUI could not finish this picture. Check its window for the reason.')
        const wanted = job.outputNodes && job.outputNodes.length > 0 ? job.outputNodes : null
        const files = Object.entries(entry.outputs ?? {})
          .filter(([node]) => !wanted || wanted.includes(node))
          .sort((a, b) => (wanted ? wanted.indexOf(a[0]) - wanted.indexOf(b[0]) : 0))
          .flatMap(([, o]) => o.images ?? [])
        if (files.length > 0) {
          const out: Buffer[] = []
          for (const file of files) {
            const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type })
            const response = await this.fetchImpl(this.url(`/view?${query}`))
            if (!response.ok) throw new ComfyError('ComfyUI finished, but its picture could not be fetched.')
            out.push(Buffer.from(await response.arrayBuffer()))
          }
          return out
        }
      }
      job.onWait?.(Math.round((Date.now() - started) / 1000))
      await new Promise((r) => setTimeout(r, 600))
    }
    throw new ComfyError('ComfyUI took too long. Stop it from its own window if it is still busy.')
  }
}
