import type { DetailSubject, EditLevel } from '../../shared/studio'
import { EDIT_LEVELS } from '../../shared/studio'
import type { ModelInventory } from './comfyModels'
import type { ApiWorkflow } from './comfyWorkflows'

// Atlas's own ComfyUI graphs, built only from nodes that ship with ComfyUI itself (no custom nodes), for Stable Diffusion 1.5
// models. They are used when the packages Atlas installs are present, or when a connected ComfyUI happens to have the same
// kinds of model. Users' own workflows (Clarity presets and others) are never touched and are always preferred when chosen.

export interface AtlasModels {
  checkpoint: string
  /** A Stable Diffusion 1.5 tile ControlNet, which holds on to the structure of a picture. */
  tile: string | null
  /** An ESRGAN-style enlargement model. */
  esrgan: string | null
}

const SD15 = /(v1-5|v1_5|sd15|sd-1\.5|sd_1\.5|1\.5|juggernaut(?!.*xl)|dreamshaper(?!.*xl)|realistic ?vision|epicrealism|deliberate|majicmix|anything-v|counterfeit|revanim)/i
const NOT_SD15 = /(xl|sdxl|flux|turbo|pony|sd3|sd-3|qwen|z[-_]image|illustrious|lightning|hunyuan|wan|ltx|cosmos|svd)/i

/** True for names that look like Stable Diffusion 1.5 models, which are trained at about 512 to 768 pixels. */
export const isSd15Name = (name: string): boolean => SD15.test(name) && !NOT_SD15.test(name)

/** Picks the models Atlas's own graphs can use from what an installation has. */
export function pickAtlasModels(inventory: ModelInventory | null): AtlasModels | null {
  if (!inventory) return null
  const checkpoint = inventory.byCategory.checkpoints.find((n) => SD15.test(n) && !NOT_SD15.test(n)) ?? null
  if (!checkpoint) return null
  const tile = inventory.byCategory.controlnet.find((n) => /tile/i.test(n) && /(sd15|v11|1\.5)/i.test(n) && !NOT_SD15.test(n)) ?? null
  const esrgan = inventory.byCategory.upscale.find((n) => /(esrgan|nomos|ultrasharp|4x|x4)/i.test(n)) ?? null
  return { checkpoint, tile, esrgan }
}

/** Whole multiples of 8 near the wanted size, the way Stable Diffusion needs them. */
export function workingSize(width: number, height: number, longEdge: number): { width: number; height: number } {
  const scale = longEdge / Math.max(width, height)
  const snap = (v: number): number => Math.max(64, Math.round((v * scale) / 8) * 8)
  return { width: snap(width), height: snap(height) }
}

export const POSITIVE_DETAIL = 'highly detailed, sharp focus, fine natural texture, faithful to the original'
export const NEGATIVE_DETAIL = 'blurry, low quality, artifacts, noise, oversharpened, deformed, text, watermark'

/**
 * Repaints a picture from a description while a tile ControlNet holds its structure, so the architecture and composition
 * stay and the mood, light or style move. `denoise` is how much may change; `hold` is how firmly the structure is kept.
 */
export function tileEditWorkflow(o: { checkpoint: string; tile: string; image: string; prompt: string; negative: string; seed: number; width: number; height: number; denoise: number; hold?: number; steps?: number; prefix?: string }): ApiWorkflow {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: o.negative, clip: ['1', 1] } },
    '8': { class_type: 'LoadImage', inputs: { image: o.image } },
    '9': { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', width: o.width, height: o.height, crop: 'disabled' } },
    '10': { class_type: 'ControlNetLoader', inputs: { control_net_name: o.tile } },
    '11': { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['2', 0], negative: ['3', 0], control_net: ['10', 0], image: ['9', 0], strength: o.hold ?? 0.85, start_percent: 0, end_percent: 1 } },
    '4': { class_type: 'VAEEncodeTiled', inputs: { pixels: ['9', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '5': { class_type: 'KSampler', inputs: { seed: o.seed, steps: o.steps ?? 24, cfg: 6.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: Math.max(0.05, Math.min(1, o.denoise)), model: ['1', 0], positive: ['11', 0], negative: ['11', 1], latent_image: ['4', 0] } },
    '6': { class_type: 'VAEDecodeTiled', inputs: { samples: ['5', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: o.prefix ?? 'atlas-edit', images: ['6', 0] } }
  }
}

/** Enlarges with an ESRGAN model, then resamples to exactly the working size. Nothing is invented, only sharpened. */
export function esrganWorkflow(o: { esrgan: string; image: string; width: number; height: number; prefix?: string }): ApiWorkflow {
  return {
    '8': { class_type: 'LoadImage', inputs: { image: o.image } },
    '12': { class_type: 'UpscaleModelLoader', inputs: { model_name: o.esrgan } },
    '13': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['12', 0], image: ['8', 0] } },
    '9': { class_type: 'ImageScale', inputs: { image: ['13', 0], upscale_method: 'lanczos', width: o.width, height: o.height, crop: 'disabled' } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: o.prefix ?? 'atlas-enlarge', images: ['9', 0] } }
  }
}

/**
 * ESRGAN enlargement followed by a gentle detail pass: a low-denoise repaint held in place by the tile ControlNet. The
 * detail pass runs at the final size, so it is limited to sizes the graphics card can hold (see MAX_DETAIL_EDGE).
 */
export function detailUpscaleWorkflow(o: { checkpoint: string; tile: string; esrgan: string; image: string; width: number; height: number; seed: number; denoise?: number; cfg?: number; prompt?: string; negative?: string; prefix?: string }): ApiWorkflow {
  const w = esrganWorkflow({ esrgan: o.esrgan, image: o.image, width: o.width, height: o.height })
  delete w['7']
  return {
    ...w,
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt ?? POSITIVE_DETAIL, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: o.negative ?? NEGATIVE_DETAIL, clip: ['1', 1] } },
    '10': { class_type: 'ControlNetLoader', inputs: { control_net_name: o.tile } },
    '11': { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['2', 0], negative: ['3', 0], control_net: ['10', 0], image: ['9', 0], strength: 1, start_percent: 0, end_percent: 1 } },
    '4': { class_type: 'VAEEncodeTiled', inputs: { pixels: ['9', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '5': { class_type: 'KSampler', inputs: { seed: o.seed, steps: 20, cfg: o.cfg ?? 6, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: o.denoise ?? 0.3, model: ['1', 0], positive: ['11', 0], negative: ['11', 1], latent_image: ['4', 0] } },
    '6': { class_type: 'VAEDecodeTiled', inputs: { samples: ['5', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: o.prefix ?? 'atlas-detail', images: ['6', 0] } }
  }
}

/** The longest side the detail pass runs at on an 8 GB card. Larger targets get the ESRGAN enlargement and a resample only. */
export const MAX_DETAIL_EDGE = 2048
/** The longest side a repaint (edit) runs at. */
export const MAX_EDIT_EDGE = 1024

// ---- levels, selective editing and subject-aware detail ------------------------------------------------------------------

export interface LevelParams {
  /** How much of the picture the model may repaint, 0 to 1. */
  denoise: number
  /** How firmly the tile ControlNet holds the structure, 0 to 1 (0 = not used). */
  hold: number
  steps: number
  /** Replace the selected area completely instead of reworking what is there (used by radical changes). */
  fill: boolean
}

/**
 * What the three levels mean for the model. Subtle barely repaints and holds structure fully; creative changes mood and
 * look while the ControlNet keeps the composition; radical repaints freely. The strength slider nudges within a level.
 */
export function levelParams(level: EditLevel, strength: number): LevelParams {
  const nudge = (Math.max(0, Math.min(1, strength)) - EDIT_LEVELS[level].strength) * 0.3
  const clamp = (v: number): number => Math.max(0.05, Math.min(1, v))
  switch (level) {
    case 'subtle': return { denoise: clamp(0.24 + nudge), hold: 1, steps: 22, fill: false }
    case 'creative': return { denoise: clamp(0.52 + nudge), hold: 0.8, steps: 24, fill: false }
    case 'radical': return { denoise: clamp(0.85 + nudge), hold: 0.35, steps: 26, fill: true }
  }
}

/**
 * Inpainting with built-in ComfyUI nodes. The mask (white = change) is loaded as a picture and scaled with the image.
 * `fill` repaints the area from nothing (replace the sky); otherwise the area is reworked from what is there, with the
 * tile ControlNet holding its structure when one is available. The result is composited over the original inside the
 * graph, and Atlas composites it again at full size, so the part outside the mask is the original's own.
 */
export function inpaintWorkflow(o: { checkpoint: string; image: string; mask: string; prompt: string; negative: string; seed: number; width: number; height: number; denoise: number; fill: boolean; grow?: number; tile?: string | null; hold?: number; steps?: number; prefix?: string }): ApiWorkflow {
  const useTile = Boolean(o.tile) && !o.fill && (o.hold ?? 0) > 0
  const g: ApiWorkflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.checkpoint } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: o.negative, clip: ['1', 1] } },
    '8': { class_type: 'LoadImage', inputs: { image: o.image } },
    '9': { class_type: 'ImageScale', inputs: { image: ['8', 0], upscale_method: 'lanczos', width: o.width, height: o.height, crop: 'disabled' } },
    '21': { class_type: 'LoadImage', inputs: { image: o.mask } },
    '22': { class_type: 'ImageScale', inputs: { image: ['21', 0], upscale_method: 'bilinear', width: o.width, height: o.height, crop: 'disabled' } },
    '23': { class_type: 'ImageToMask', inputs: { image: ['22', 0], channel: 'red' } },
    '24': { class_type: 'GrowMask', inputs: { mask: ['23', 0], expand: o.grow ?? 6, tapered_corners: true } }
  }
  let positive: [string, number] = ['2', 0]
  let negative: [string, number] = ['3', 0]
  if (useTile) {
    g['10'] = { class_type: 'ControlNetLoader', inputs: { control_net_name: o.tile! } }
    g['11'] = { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['2', 0], negative: ['3', 0], control_net: ['10', 0], image: ['9', 0], strength: o.hold ?? 0.8, start_percent: 0, end_percent: 1 } }
    positive = ['11', 0]
    negative = ['11', 1]
  }
  let latent: [string, number]
  if (o.fill) {
    g['4'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['9', 0], vae: ['1', 2], mask: ['24', 0], grow_mask_by: 8 } }
    latent = ['4', 0]
  } else {
    g['4'] = { class_type: 'VAEEncodeTiled', inputs: { pixels: ['9', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
    g['25'] = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['4', 0], mask: ['24', 0] } }
    latent = ['25', 0]
  }
  g['5'] = { class_type: 'KSampler', inputs: { seed: o.seed, steps: o.steps ?? 24, cfg: 6.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: o.fill ? 1 : Math.max(0.05, Math.min(1, o.denoise)), model: ['1', 0], positive, negative, latent_image: latent } }
  g['6'] = { class_type: 'VAEDecodeTiled', inputs: { samples: ['5', 0], vae: ['1', 2], tile_size: 768, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
  g['30'] = { class_type: 'ImageCompositeMasked', inputs: { destination: ['9', 0], source: ['6', 0], x: 0, y: 0, resize_source: false, mask: ['24', 0] } }
  g['7'] = { class_type: 'SaveImage', inputs: { filename_prefix: o.prefix ?? 'atlas-inpaint', images: ['30', 0] } }
  return g
}

/** What the detail pass should do for each kind of subject: gentler on faces, firmer on architecture, richer on vegetation. */
export function detailSettings(subject: DetailSubject): { prompt: string; negative: string; denoise: number; cfg: number } {
  switch (subject) {
    case 'faces':
      return { prompt: 'natural skin, sharp eyes, fine hair, faithful to the original likeness and expression', negative: `${NEGATIVE_DETAIL}, plastic skin, changed face, extra features`, denoise: 0.18, cfg: 5 }
    case 'architecture':
      return { prompt: 'crisp architectural detail, straight clean edges, fine masonry and material texture, faithful to the original', negative: `${NEGATIVE_DETAIL}, warped lines, bent walls, extra windows`, denoise: 0.24, cfg: 5.5 }
    case 'vegetation':
      return { prompt: 'natural foliage, individual leaves and blades of grass, fine branches, organic detail, faithful to the original', negative: `${NEGATIVE_DETAIL}, plastic leaves, smeared foliage`, denoise: 0.36, cfg: 6 }
    case 'texture':
      return { prompt: 'rich material texture, visible grain of stone, wood, fabric and metal, faithful to the original', negative: `${NEGATIVE_DETAIL}, smooth plastic surfaces`, denoise: 0.34, cfg: 6 }
    default:
      return { prompt: POSITIVE_DETAIL, negative: NEGATIVE_DETAIL, denoise: 0.3, cfg: 6 }
  }
}

/** Guesses the subject from words (a prompt, an instruction) so the detail pass can suit the picture. */
export function subjectFromText(text: string): DetailSubject {
  const t = text.toLowerCase()
  if (/\b(face|faces|portrait|person|people|woman|man|girl|boy|child|skin|eyes)\b/.test(t)) return 'faces'
  if (/\b(architecture|building|buildings|facade|house|temple|cathedral|castle|tower|cabin|city|street|interior|wall)\b/.test(t)) return 'architecture'
  if (/\b(forest|tree|trees|leaves|foliage|vegetation|grass|garden|plants?|flowers?|meadow|jungle|moss)\b/.test(t)) return 'vegetation'
  if (/\b(texture|stone|marble|wood|fabric|cloth|metal|rust|rock|sand|bark)\b/.test(t)) return 'texture'
  return 'general'
}
