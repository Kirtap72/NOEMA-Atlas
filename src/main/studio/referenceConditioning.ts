import sharp from '../safeSharp'
import type { ModelInventory } from './comfyModels'
import type { RefRole } from '../../shared/studio'

// Genuine image-reference conditioning: the reference pictures themselves, not a description of them or their colour
// statistics, are given to an image model that was trained to use them. Here that is FLUX.2 [klein] through ComfyUI's own
// reference-latent nodes (the technique of ComfyUI's multi-image "edit" templates): every reference is encoded to a latent
// and attached to the conditioning, so the model sees them while it paints a NEW picture from the prompt.
//
// What the pictures are *for* is said in words, by role ("the composition of image 1, the atmosphere of image 2"), because
// that is how this kind of model is steered. How strongly each is followed is set with the wording and with how large the
// reference is shown to the model. This is real conditioning with real limits, and the limits are stated in
// referenceCapabilities() rather than promised away.

export type ReferenceInfluence = 'subtle' | 'balanced' | 'strong'
export const REFERENCE_INFLUENCES: Record<ReferenceInfluence, { label: string; note: string }> = {
  subtle: { label: 'Subtle', note: 'An echo of it: the new picture is mostly its own.' },
  balanced: { label: 'Balanced', note: 'It clearly shapes the result.' },
  strong: { label: 'Strong', note: 'The result follows it closely.' }
}

/** The models the reference pipeline needs, found by their names in an installation. */
export interface ReferenceModels {
  unet: string
  clip: string
  vae: string
  /** The few-step distilled model (4 steps) or the base model (more steps, real guidance). */
  distilled: boolean
  family: 'flux2-klein'
}

const KLEIN_DISTILLED = /flux[-_.]?2[-_.]?klein(?![-_.]?base)/i
const KLEIN_BASE = /flux[-_.]?2[-_.]?klein[-_.]?base/i

export function pickReferenceModels(inventory: ModelInventory | null): ReferenceModels | null {
  if (!inventory) return null
  const diffusion = inventory.byCategory.diffusion
  const distilled = diffusion.find((n) => KLEIN_DISTILLED.test(n) && !/fp8|fp4|nvfp4/i.test(n)) ?? diffusion.find((n) => KLEIN_DISTILLED.test(n))
  const base = diffusion.find((n) => KLEIN_BASE.test(n))
  const unet = distilled ?? base
  if (!unet) return null
  // The text encoder FLUX.2 [klein] 4B was trained with is Qwen3 4B.
  const clip = inventory.byCategory.textEncoders.find((n) => /qwen[-_.]?3[-_.]?4b/i.test(n) && !/vl/i.test(n) && !/fp4/i.test(n)) ?? inventory.byCategory.textEncoders.find((n) => /qwen[-_.]?3[-_.]?4b/i.test(n) && !/vl/i.test(n))
  const vae = inventory.byCategory.vae.find((n) => /^flux[-_.]?2[-_.]?vae/i.test(n)) ?? inventory.byCategory.vae.find((n) => /flux[-_.]?2.*vae|flux2[-_.]?ae/i.test(n))
  if (!clip || !vae) return null
  return { unet, clip, vae, distilled: Boolean(distilled), family: 'flux2-klein' }
}

/** What each role asks of a reference, in the words the model is steered with. */
const ROLE_WORDS: Record<RefRole, string> = {
  composition: 'the composition, layout and arrangement of shapes',
  atmosphere: 'the atmosphere, mood and quality of light',
  colour: 'the colour palette',
  material: 'the materials and surface textures',
  subject: 'the subject and its forms'
}
const INFLUENCE_VERB: Record<ReferenceInfluence, string> = { subtle: 'echo loosely', balanced: 'take', strong: 'follow closely' }

export interface ReferencePromptItem {
  roles: RefRole[]
  influence: ReferenceInfluence
  /** What the picture handed to the model is: a prepared view that isolates one thing, or the picture itself. */
  view?: ReferenceView
}

/**
 * Turns the user's description and the roles of the references into the instruction the model reads, naming each image by
 * its number. `editTarget` means image 1 is a picture being changed rather than a reference for a new one.
 */
export function compileReferencePrompt(description: string, items: ReferencePromptItem[], options: { editTarget?: boolean } = {}): string {
  const parts: string[] = []
  const offset = options.editTarget ? 1 : 0
  const lines: string[] = []
  const used = new Set<RefRole>()
  items.forEach((item, i) => {
    const number = i + 1 + offset
    const roles = item.roles.length > 0 ? item.roles : (['atmosphere'] as RefRole[])
    const verb = INFLUENCE_VERB[item.influence]
    const wanted = roles.map((r) => {
      used.add(r)
      return ROLE_WORDS[r]
    })
    // A prepared view is named for what it is, so the model takes only that from it and not the style of the original.
    const what = item.view === 'layout' ? `the grayscale layout sketch (image ${number})` : item.view === 'light' ? `the blurred study of light and colour (image ${number})` : item.view === 'swatch' ? `the close-up swatch of a material (image ${number})` : `image ${number}`
    lines.push(`${verb} ${wanted.join(' and ')} of ${what}`)
  })
  if (options.editTarget) {
    parts.push(`Edit image 1. Keep its subject and composition unless told otherwise.`)
    if (lines.length) parts.push(`${capital(lines.join('; '))}.`)
  } else {
    parts.push(`Create a new, original picture.`)
    if (lines.length) parts.push(`${capital(lines.join('; '))}.`)
  }
  const text = description.trim()
  if (text) parts.push(text.endsWith('.') ? text : `${text}.`)
  parts.push(options.editTarget ? 'Make it one coherent picture, not a collage.' : 'Make it one coherent artwork with its own composition, not a collage and not a copy of any reference.')
  return parts.join(' ')
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// ---- showing each reference for what it is for ---------------------------------------------------------------------------------
//
// Handed over as they are, the first reference dominates and its whole look leaks into the result (its colours, its style,
// even its lettering). So each reference is prepared into a view that carries only the thing it is for:
//   composition  -> a grayscale layout sketch (masses and arrangement, no colour, no fine texture)
//   atmosphere / colour -> a blurred study of light and colour (no shapes to copy)
//   material     -> a close-up swatch of the most textured part (no layout)
//   subject (or mixed roles) -> the picture itself
// How strongly each is followed (subtle, balanced, strong) sets how abstract the view is and how large it is shown.

export type ReferenceView = 'layout' | 'light' | 'swatch' | 'original'

/** Which view a set of roles calls for. A subject, or roles from several families, needs the whole picture. */
export function viewFor(roles: RefRole[]): ReferenceView {
  const set = new Set(roles.length ? roles : (['atmosphere'] as RefRole[]))
  if (set.has('subject')) return 'original'
  if (set.size === 1 && set.has('composition')) return 'layout'
  if (set.size === 1 && set.has('material')) return 'swatch'
  if ([...set].every((r) => r === 'atmosphere' || r === 'colour')) return 'light'
  return 'original'
}

const VIEW_MEGAPIXELS: Record<ReferenceInfluence, number> = { subtle: 0.3, balanced: 0.5, strong: 0.8 }
const VIEW_ABSTRACTION: Record<ReferenceInfluence, number> = { subtle: 1.8, balanced: 1, strong: 0.55 }

/** Megapixels each reference is shown at, so that several of them still fit in the memory of a modest graphics card. */
export function referenceBudget(count: number, influence: ReferenceInfluence): number {
  const total = 1.6
  return Math.max(0.2, Math.min(VIEW_MEGAPIXELS[influence], total / Math.max(1, count)))
}

/** The picture to hand to the model for one reference. Never changes the file; works on a decoded copy. */
export async function prepareReference(source: Buffer | string, roles: RefRole[], influence: ReferenceInfluence, megapixels: number): Promise<{ png: Buffer; view: ReferenceView }> {
  const view = viewFor(roles)
  const meta = await sharp(source, { failOn: 'none' }).rotate().metadata()
  const w0 = meta.width ?? 1024
  const h0 = meta.height ?? 1024
  const scale = Math.sqrt((megapixels * 1_000_000) / Math.max(1, w0 * h0))
  const w = Math.max(64, Math.round((w0 * scale) / 16) * 16)
  const h = Math.max(64, Math.round((h0 * scale) / 16) * 16)
  const abstraction = VIEW_ABSTRACTION[influence]
  const base = (): ReturnType<typeof sharp> => sharp(source, { failOn: 'none', limitInputPixels: false }).rotate().flatten({ background: '#ffffff' })
  if (view === 'layout') {
    // Masses and arrangement only: grayscale, the fine texture blurred away, contrast stretched so the big shapes read.
    const png = await base().resize(w, h, { fit: 'fill' }).greyscale().blur(Math.max(1, Math.max(w, h) * 0.0028 * abstraction)).normalise().toColourspace('srgb').png().toBuffer()
    return { png, view }
  }
  if (view === 'light') {
    // Light and colour only: shrink to a few hundred pixels and blur, so there is nothing left to copy but the glow and the palette.
    const small = await base().resize(Math.max(32, Math.round(w / 4)), Math.max(32, Math.round(h / 4)), { fit: 'fill' }).blur(Math.max(2, 7 * abstraction)).png().toBuffer()
    const png = await sharp(small).resize(w, h, { fit: 'fill', kernel: 'cubic' }).png().toBuffer()
    return { png, view }
  }
  if (view === 'swatch') {
    // The most textured part of the picture, close up: a sample of the surface without any of the picture's layout.
    const thumb = await base().resize(192, 192, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true })
    const tw = thumb.info.width
    const th = thumb.info.height
    const cells = 4
    let best = { score: -1, cx: 0, cy: 0 }
    for (let cy = 0; cy < cells; cy += 1) {
      for (let cx = 0; cx < cells; cx += 1) {
        let energy = 0
        let n = 0
        for (let y = Math.floor((cy * th) / cells) + 1; y < Math.floor(((cy + 1) * th) / cells) - 1; y += 1) {
          for (let x = Math.floor((cx * tw) / cells) + 1; x < Math.floor(((cx + 1) * tw) / cells) - 1; x += 1) {
            energy += Math.abs(thumb.data[y * tw + x]! - thumb.data[y * tw + x + 1]!) + Math.abs(thumb.data[y * tw + x]! - thumb.data[(y + 1) * tw + x]!)
            n += 1
          }
        }
        const score = energy / Math.max(1, n)
        if (score > best.score) best = { score, cx, cy }
      }
    }
    const side = Math.max(48, Math.round(Math.min(w0, h0) * 0.34 * (abstraction > 1 ? 1.2 : abstraction < 1 ? 0.85 : 1)))
    const left = Math.max(0, Math.min(w0 - side, Math.round(((best.cx + 0.5) / cells) * w0 - side / 2)))
    const top = Math.max(0, Math.min(h0 - side, Math.round(((best.cy + 0.5) / cells) * h0 - side / 2)))
    const png = await sharp(source, { failOn: 'none', limitInputPixels: false }).rotate().flatten({ background: '#ffffff' }).extract({ left, top, width: Math.min(side, w0), height: Math.min(side, h0) }).resize(Math.round(Math.sqrt(megapixels * 1_000_000) / 16) * 16, Math.round(Math.sqrt(megapixels * 1_000_000) / 16) * 16, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()
    return { png, view }
  }
  const png = await base().resize(w, h, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()
  return { png, view: 'original' }
}

/** Sizes the model can paint: multiples of 16, about one megapixel at most (kinder to 8 GB graphics cards). */
export function referenceSize(width: number, height: number, maxMegapixels = 1.05): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt((maxMegapixels * 1_000_000) / Math.max(1, width * height)))
  const snap = (v: number): number => Math.max(256, Math.round((v * scale) / 16) * 16)
  return { width: snap(width), height: snap(height) }
}

export interface ReferenceGraph {
  models: ReferenceModels
  /** Reference pictures already uploaded to ComfyUI, in the order the prompt names them (image 1, image 2 …). */
  images: string[]
  prompt: string
  seed: number
  width: number
  height: number
  /** How large each reference is shown to the model, in megapixels. Smaller references pull less on the result. */
  refMegapixels?: number
  steps?: number
  prefix?: string
}

type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

/** The FLUX.2 [klein] reference graph. Only ComfyUI's own nodes are used. */
export function referenceWorkflow(g: ReferenceGraph): ApiWorkflow {
  const w: ApiWorkflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: g.models.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: g.models.clip, type: 'flux2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: g.models.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: g.prompt, clip: ['2', 0] } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } }
  }
  let positive: [string, number] = ['4', 0]
  let negative: [string, number] = ['5', 0]
  g.images.forEach((image, i) => {
    const k = i + 1
    w[`L${k}`] = { class_type: 'LoadImage', inputs: { image } }
    w[`S${k}`] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [`L${k}`, 0], upscale_method: 'lanczos', megapixels: g.refMegapixels ?? 1, resolution_steps: 16 } }
    w[`E${k}`] = { class_type: 'VAEEncode', inputs: { pixels: [`S${k}`, 0], vae: ['3', 0] } }
    w[`P${k}`] = { class_type: 'ReferenceLatent', inputs: { conditioning: positive, latent: [`E${k}`, 0] } }
    w[`N${k}`] = { class_type: 'ReferenceLatent', inputs: { conditioning: negative, latent: [`E${k}`, 0] } }
    positive = [`P${k}`, 0]
    negative = [`N${k}`, 0]
  })
  const steps = g.steps ?? (g.models.distilled ? 4 : 24)
  w['6'] = { class_type: 'EmptyFlux2LatentImage', inputs: { width: g.width, height: g.height, batch_size: 1 } }
  w['7'] = { class_type: 'Flux2Scheduler', inputs: { steps, width: g.width, height: g.height } }
  w['8'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } }
  w['9'] = { class_type: 'RandomNoise', inputs: { noise_seed: g.seed } }
  w['10'] = { class_type: 'CFGGuider', inputs: { model: ['1', 0], positive, negative, cfg: g.models.distilled ? 1 : 4 } }
  w['11'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['9', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['7', 0], latent_image: ['6', 0] } }
  w['12'] = { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } }
  w['13'] = { class_type: 'SaveImage', inputs: { filename_prefix: g.prefix ?? 'atlas-reference', images: ['12', 0] } }
  return w
}

// ---- what each way of using references can actually do ----------------------------------------------------------------------

export type Strength = 'good' | 'partial' | 'weak' | 'none'

export interface ReferencePipeline {
  id: 'flux2-klein' | 'openai-images' | 'atlas-blend'
  name: string
  kind: 'local' | 'cloud' | 'offline'
  available: boolean
  /** Why it cannot be used right now, and what to do. */
  reason: string | null
  /** How many reference pictures it can use at once. */
  maxReferences: number
  /** What it can take from a reference, honestly. */
  can: Record<RefRole | 'identity', Strength>
  /** A few plain sentences on what it is good at and where it falls short. */
  summary: string
  /** Rough time for one picture. */
  speed: string
}

const note: Record<Strength, string> = { good: 'works well', partial: 'works in part', weak: 'only weakly', none: 'not at all' }
export const STRENGTH_WORDS = note

export function referenceCapabilities(models: ReferenceModels | null, cloud: { available: boolean; reason: string | null }): ReferencePipeline[] {
  return [
    {
      id: 'flux2-klein',
      name: 'FLUX.2 [klein] with your reference pictures (on this computer)',
      kind: 'local',
      available: Boolean(models),
      reason: models ? null : 'Needs the FLUX.2 [klein] 4B model, its Qwen3 4B text encoder and the FLUX.2 VAE in ComfyUI. Add them from the Studio settings (an optional download of about 16 GB), or connect a ComfyUI that has them.',
      maxReferences: 4,
      can: { composition: 'partial', atmosphere: 'good', colour: 'good', material: 'partial', subject: 'good', identity: 'weak' },
      summary: 'The reference pictures themselves are shown to the model while it paints a new picture. It follows how a reference looks and feels (light, colour, atmosphere), what it shows (subjects and forms) and, less exactly, how it is arranged and what it is made of. It is steered in words, so it cannot copy a layout to the pixel, and a face is a likeness, not the exact person.',
      speed: 'about a minute on an 8 GB graphics card, less on a larger one'
    },
    {
      id: 'openai-images',
      name: 'Cloud image editing with several pictures (OpenAI)',
      kind: 'cloud',
      available: cloud.available,
      reason: cloud.available ? null : (cloud.reason ?? 'Add an OpenAI key in the Studio settings.'),
      maxReferences: 4,
      can: { composition: 'partial', atmosphere: 'good', colour: 'good', material: 'good', subject: 'good', identity: 'partial' },
      summary: 'The pictures are sent to the cloud service together with your instruction. It is strong at combining several pictures and keeping a subject recognisable. It costs money and the pictures leave this computer, so Atlas asks first every time.',
      speed: 'under a minute; paid per picture'
    },
    {
      id: 'atlas-blend',
      name: 'Atlas Blend (no model needed)',
      kind: 'offline',
      available: true,
      reason: null,
      maxReferences: 12,
      can: { composition: 'partial', atmosphere: 'partial', colour: 'good', material: 'none', subject: 'weak', identity: 'none' },
      summary: 'Combines the pictures directly (their light and colour, and a composition picture as the base). It invents nothing new, so it is a quick study and not a new composition.',
      speed: 'instant'
    }
  ]
}
