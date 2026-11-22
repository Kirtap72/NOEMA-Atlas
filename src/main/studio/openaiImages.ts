import type { FetchFn } from './comfy'

export class CloudImageError extends Error {}

export const CLOUD_MODELS = ['gpt-image-1', 'dall-e-3']

/** Rough prices in US dollars per picture. They are estimates for budgeting, shown as such. */
export function estimateCloudCost(model: string, width: number, height: number): number {
  const wide = Math.abs(width - height) > Math.min(width, height) * 0.2
  if (model.startsWith('dall-e-3')) return wide ? 0.08 : 0.04
  return wide ? 0.063 : 0.042
}

function sizeFor(model: string, width: number, height: number): string {
  const ratio = width / Math.max(1, height)
  if (model.startsWith('dall-e-3')) return ratio > 1.2 ? '1792x1024' : ratio < 0.83 ? '1024x1792' : '1024x1024'
  return ratio > 1.2 ? '1536x1024' : ratio < 0.83 ? '1024x1536' : '1024x1024'
}

async function pictures(response: Response): Promise<Buffer[]> {
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      detail = body.error?.message ?? ''
    } catch {
      detail = ''
    }
    if (response.status === 401) throw new CloudImageError('The image service did not accept the key.')
    if (response.status === 429) throw new CloudImageError('The image service says you have used too much for now. Try again later.')
    throw new CloudImageError(detail ? `The image service said: ${detail}` : `The image service refused the request (${response.status}).`)
  }
  const body = (await response.json()) as { data?: Array<{ b64_json?: string }> }
  const out = (body.data ?? []).flatMap((d) => (d.b64_json ? [Buffer.from(d.b64_json, 'base64')] : []))
  if (out.length === 0) throw new CloudImageError('The image service answered without a picture.')
  return out
}

/** Optional cloud image making through the OpenAI images API. Only the user's prompt is sent for new pictures. */
export class CloudImages {
  constructor(
    private baseUrl: string,
    private key: string,
    private fetchImpl: FetchFn
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.key}` }
  }

  async generate(opts: { model: string; prompt: string; width: number; height: number; count: number; signal?: AbortSignal }): Promise<Buffer[]> {
    const body: Record<string, unknown> = { model: opts.model, prompt: opts.prompt, n: opts.model.startsWith('dall-e-3') ? 1 : opts.count, size: sizeFor(opts.model, opts.width, opts.height) }
    if (opts.model.startsWith('dall-e')) body.response_format = 'b64_json'
    else body.quality = 'medium'
    const out: Buffer[] = []
    const rounds = opts.model.startsWith('dall-e-3') ? opts.count : 1
    for (let i = 0; i < rounds; i += 1) {
      const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/images/generations`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal
      })
      out.push(...(await pictures(response)))
    }
    return out
  }

  /** Editing sends the picture itself, which is why the user must agree first. */
  async edit(opts: { model: string; prompt: string; image: Buffer; /** Several pictures at once (the first is the one being edited); gpt-image-1 combines them. */ images?: Buffer[]; width: number; height: number; signal?: AbortSignal; /** A PNG of the same size as the image; transparent pixels are the part to repaint. */ mask?: Buffer }): Promise<Buffer[]> {
    if (opts.model.startsWith('dall-e-3')) throw new CloudImageError('This model cannot edit pictures. Choose gpt-image-1.')
    const form = new FormData()
    form.append('model', opts.model)
    form.append('prompt', opts.prompt)
    form.append('size', sizeFor(opts.model, opts.width, opts.height))
    if (opts.images && opts.images.length > 1) opts.images.slice(0, 4).forEach((img, i) => form.append('image[]', new Blob([new Uint8Array(img)], { type: 'image/png' }), `image-${i + 1}.png`))
    else form.append('image', new Blob([new Uint8Array(opts.image)], { type: 'image/png' }), 'image.png')
    if (opts.mask) form.append('mask', new Blob([new Uint8Array(opts.mask)], { type: 'image/png' }), 'mask.png')
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/images/edits`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
      signal: opts.signal
    })
    return pictures(response)
  }
}
