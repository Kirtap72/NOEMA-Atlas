import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { compileReferencePrompt, pickReferenceModels, prepareReference, referenceBudget, referenceCapabilities, referenceSize, referenceWorkflow, viewFor } from '../src/main/studio/referenceConditioning'
import type { ModelInventory } from '../src/main/studio/comfyModels'

const inventory = (over: Partial<ModelInventory['byCategory']> = {}): ModelInventory => ({ byCategory: { checkpoints: [], diffusion: [], vae: [], textEncoders: [], loras: [], controlnet: [], upscale: [], ...over }, total: 0, folders: [], families: [] })
const klein = inventory({ diffusion: ['flux-2-klein-4b-fp8.safetensors', 'other.safetensors'], textEncoders: ['qwen_3_4b.safetensors', 'qwen_2.5_vl_7b.safetensors'], vae: ['flux2-vae.safetensors', 'sdxl_vae.safetensors'] })

// A picture with a strong layout (a dark mountain on a bright sky), colour, and fine texture, to see what each view keeps.
async function sample(): Promise<Buffer> {
  const w = 600
  const h = 400
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3
      const mountain = y > 120 + Math.abs(x - 300) * 0.5
      const noise = ((x * 7 + y * 13) % 17) * 3
      raw[i] = mountain ? 40 + noise : 220
      raw[i + 1] = mountain ? 30 : 120
      raw[i + 2] = mountain ? 90 : 40
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer()
}

describe('finding the reference model', () => {
  it('needs the model, its text encoder and its VAE', () => {
    expect(pickReferenceModels(klein)).toEqual({ unet: 'flux-2-klein-4b-fp8.safetensors', clip: 'qwen_3_4b.safetensors', vae: 'flux2-vae.safetensors', distilled: true, family: 'flux2-klein' })
    expect(pickReferenceModels(inventory({ diffusion: ['flux-2-klein-4b.safetensors'] }))).toBeNull()
    expect(pickReferenceModels(null)).toBeNull()
    expect(pickReferenceModels(inventory())).toBeNull()
  })
  it('recognises the base model as not distilled', () => {
    const base = pickReferenceModels(inventory({ diffusion: ['flux-2-klein-base-4b.safetensors'], textEncoders: ['qwen_3_4b.safetensors'], vae: ['flux2-vae.safetensors'] }))
    expect(base?.distilled).toBe(false)
  })
})

describe('the instruction names each picture for what it is', () => {
  it('says what to take from which numbered image, never "copy"', () => {
    const text = compileReferencePrompt('A black cat in front of a mountain.', [
      { roles: ['composition'], influence: 'balanced', view: 'layout' },
      { roles: ['atmosphere', 'colour'], influence: 'subtle', view: 'light' },
      { roles: ['material'], influence: 'strong', view: 'swatch' },
      { roles: ['subject'], influence: 'balanced', view: 'original' }
    ])
    expect(text).toMatch(/grayscale layout sketch \(image 1\)/)
    expect(text).toMatch(/echo loosely the atmosphere, mood and quality of light and the colour palette of the blurred study of light and colour \(image 2\)/)
    expect(text).toMatch(/follow closely the materials and surface textures of the close-up swatch of a material \(image 3\)/)
    expect(text).toMatch(/take the subject and its forms of image 4/)
    expect(text).toMatch(/not a collage and not a copy/)
    expect(text).toContain('A black cat in front of a mountain.')
  })
  it('numbers references after the picture being edited', () => {
    const text = compileReferencePrompt('', [{ roles: ['atmosphere'], influence: 'balanced', view: 'light' }], { editTarget: true })
    expect(text).toMatch(/^Edit image 1\./)
    expect(text).toMatch(/\(image 2\)/)
  })
})

describe('each reference is shown only for its purpose', () => {
  it('chooses the view from the roles', () => {
    expect(viewFor(['composition'])).toBe('layout')
    expect(viewFor(['atmosphere', 'colour'])).toBe('light')
    expect(viewFor(['material'])).toBe('swatch')
    expect(viewFor(['subject'])).toBe('original')
    expect(viewFor(['composition', 'colour'])).toBe('original')
    expect(viewFor([])).toBe('light')
  })
  it('layout keeps the arrangement but not the colour', async () => {
    const out = await prepareReference(await sample(), ['composition'], 'balanced', 0.3)
    expect(out.view).toBe('layout')
    const { data, info } = await sharp(out.png).raw().toBuffer({ resolveWithObject: true })
    let colourful = 0
    for (let i = 0; i < data.length; i += info.channels) if (Math.max(data[i]!, data[i + 1]!, data[i + 2]!) - Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 12) colourful += 1
    expect(colourful / (data.length / info.channels)).toBeLessThan(0.02)
    // the sky stays brighter than the mountain
    const px = (x: number, y: number): number => data[(Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels]!
    expect(px(0.5, 0.05)).toBeGreaterThan(px(0.5, 0.9) + 40)
  })
  it('light keeps colour but has no shapes to copy', async () => {
    const out = await prepareReference(await sample(), ['atmosphere', 'colour'], 'balanced', 0.3)
    expect(out.view).toBe('light')
    const { data, info } = await sharp(out.png).raw().toBuffer({ resolveWithObject: true })
    let edges = 0
    for (let x = 1; x < info.width; x += 1) edges += Math.abs(data[x * info.channels]! - data[(x - 1) * info.channels]!)
    expect(edges / info.width).toBeLessThan(18)
    expect(Math.max(...Array.from(data.subarray(0, 3)))).toBeGreaterThan(0)
  })
  it('stays within the memory budget and never alters the source', async () => {
    const src = await sample()
    const copy = Buffer.from(src)
    for (const roles of [['composition'], ['atmosphere'], ['material'], ['subject']] as const) {
      const out = await prepareReference(src, [...roles], 'strong', referenceBudget(4, 'strong'))
      const meta = await sharp(out.png).metadata()
      expect((meta.width ?? 0) * (meta.height ?? 0)).toBeLessThanOrEqual(0.41e6)
    }
    expect(src.equals(copy)).toBe(true)
  })
  it('shares one memory budget among several references', () => {
    expect(referenceBudget(1, 'strong')).toBe(0.8)
    expect(referenceBudget(4, 'strong')).toBe(0.4)
    expect(referenceBudget(8, 'subtle')).toBe(0.2)
  })
})

describe('the ComfyUI graph', () => {
  const models = pickReferenceModels(klein)!
  it('chains every reference into positive and negative conditioning and uses only core nodes', () => {
    const g = referenceWorkflow({ models, images: ['a.png', 'b.png', 'c.png'], prompt: 'p', seed: 7, width: 1216, height: 832, refMegapixels: 0.5 })
    expect(Object.values(g).filter((n) => n.class_type === 'LoadImage')).toHaveLength(3)
    expect(g['P3']!.inputs.conditioning).toEqual(['P2', 0])
    expect(g['N3']!.inputs.conditioning).toEqual(['N2', 0])
    expect(g['10']!.inputs.positive).toEqual(['P3', 0])
    expect(g['10']!.inputs.cfg).toBe(1)
    expect(g['7']!.inputs.steps).toBe(4)
    expect(g['S1']!.inputs.megapixels).toBe(0.5)
    const core = new Set(['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'LoadImage', 'ImageScaleToTotalPixels', 'VAEEncode', 'ReferenceLatent', 'EmptyFlux2LatentImage', 'Flux2Scheduler', 'KSamplerSelect', 'RandomNoise', 'CFGGuider', 'SamplerCustomAdvanced', 'VAEDecode', 'SaveImage'])
    expect(Object.values(g).filter((n) => !core.has(n.class_type))).toEqual([])
  })
  it('uses real guidance and more steps for the base model', () => {
    const g = referenceWorkflow({ models: { ...models, distilled: false }, images: ['a.png'], prompt: 'p', seed: 1, width: 512, height: 512 })
    expect(g['10']!.inputs.cfg).toBe(4)
    expect(g['7']!.inputs.steps).toBe(24)
  })
  it('sizes the picture in multiples of 16 within about a megapixel', () => {
    const s = referenceSize(4000, 3000)
    expect(s.width % 16).toBe(0)
    expect(s.height % 16).toBe(0)
    expect(s.width * s.height).toBeLessThanOrEqual(1.1e6)
    expect(referenceSize(100, 100)).toEqual({ width: 256, height: 256 })
  })
})

describe('says honestly what each way can do', () => {
  it('lists the reference pipeline with its limits, and the offline fallback', () => {
    const pipelines = referenceCapabilities(pickReferenceModels(klein), { available: false, reason: 'No key.' })
    const flux = pipelines.find((p) => p.id === 'flux2-klein')!
    expect(flux.available).toBe(true)
    expect(flux.can.identity).toBe('weak')
    expect(flux.can.composition).toBe('partial')
    expect(pipelines.find((p) => p.id === 'openai-images')!.available).toBe(false)
    expect(pipelines.find((p) => p.id === 'atlas-blend')!.available).toBe(true)
    expect(referenceCapabilities(null, { available: false, reason: null }).find((p) => p.id === 'flux2-klein')!.available).toBe(false)
  })
})
