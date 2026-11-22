/**
 * Measurable colour and tone of each image, worked out once from Atlas's own preview (never the original file).
 * Smart Collections combine these numbers with the image model: the model understands "melancholic" or "surreal",
 * the pixels tell for certain whether an image is teal, dark or black and white.
 */
import sharp from './safeSharp'
import type { ColourId } from '../shared/smart'

export const HUE_BINS = 24
const SAMPLE = 48

export interface ImageStats {
  /** Average brightness, 0 (black) to 1 (white). */
  lightness: number
  /** Spread of brightness, 0 (flat) to about 0.35 (strong light and dark). */
  contrast: number
  /** Average colour strength of the pixels that have colour, 0 to 1. */
  saturation: number
  /** Share of all pixels that fall in each 15 degree slice of the colour wheel; grey and near-black pixels are in none. */
  hues: Float32Array
}

/** Describes raw sRGB pixels (three bytes each). Pure, so it can be tested with made-up pixels. */
export function analyzeRgb(data: Uint8Array | Buffer, pixels: number): ImageStats {
  const hues = new Float32Array(HUE_BINS)
  if (pixels === 0) return { lightness: 0, contrast: 0, saturation: 0, hues }
  let sumL = 0
  let sumL2 = 0
  let sumS = 0
  let coloured = 0
  for (let p = 0; p < pixels; p += 1) {
    const r = data[p * 3]! / 255
    const g = data[p * 3 + 1]! / 255
    const b = data[p * 3 + 2]! / 255
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    sumL += luma
    sumL2 += luma * luma
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    const s = max === 0 ? 0 : delta / max
    if (max < 0.12) continue
    sumS += s
    coloured += 1
    if (s < 0.2 || max < 0.15) continue
    let h: number
    if (delta === 0) continue
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
    hues[Math.min(HUE_BINS - 1, Math.floor(h / (360 / HUE_BINS)))]! += 1 / pixels
  }
  const mean = sumL / pixels
  return {
    lightness: mean,
    contrast: Math.sqrt(Math.max(0, sumL2 / pixels - mean * mean)),
    saturation: coloured === 0 ? 0 : sumS / coloured,
    hues
  }
}

export async function describeFile(path: string): Promise<ImageStats> {
  const { data, info } = await sharp(path, { failOn: 'none' })
    .resize(SAMPLE, SAMPLE, { fit: 'inside' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return analyzeRgb(data, info.width * info.height)
}

// Which 15 degree slices belong to each named colour (bin 0 is 0 to 15 degrees, red; the wheel runs red, yellow, green, cyan, blue, magenta).
const HUE_WINDOWS: Record<Exclude<ColourId, 'warm' | 'cool'>, number[]> = {
  red: [23, 0],
  orange: [1, 2],
  yellow: [3, 4],
  green: [5, 6, 7, 8, 9],
  teal: [10, 11, 12],
  blue: [13, 14, 15, 16],
  purple: [17, 18, 19, 20],
  pink: [21, 22]
}
const WARM_BINS = [23, 0, 1, 2, 3, 4]
const COOL_BINS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]

function share(hues: Float32Array, bins: number[]): number {
  let total = 0
  for (const bin of bins) total += hues[bin] ?? 0
  return total
}

function ramp(value: number, from: number, to: number): number {
  if (from === to) return value >= to ? 1 : 0
  return Math.max(0, Math.min(1, (value - from) / (to - from)))
}

/** How well one image fits one colour, 0 (not at all) to 1 (clearly dominated by it). */
export function colourFit(stats: ImageStats, colour: ColourId): number {
  if (colour === 'warm' || colour === 'cool') {
    const warm = share(stats.hues, WARM_BINS)
    const cool = share(stats.hues, COOL_BINS)
    const total = warm + cool
    if (total < 0.06) return colour === 'warm' ? 0.15 : 0.15
    const lean = (colour === 'warm' ? warm : cool) / total
    return ramp(lean, 0.5, 0.85) * ramp(total, 0.06, 0.25)
  }
  // Teal is a narrow slice of the wheel, so a smaller share of the picture already counts as "teal-toned".
  const needed = colour === 'teal' || colour === 'yellow' || colour === 'pink' ? 0.22 : 0.3
  return ramp(share(stats.hues, HUE_WINDOWS[colour]), 0.02, needed)
}

export function toneFit(stats: ImageStats, tone: 'dark' | 'bright'): number {
  return tone === 'dark' ? 1 - ramp(stats.lightness, 0.28, 0.5) : ramp(stats.lightness, 0.5, 0.68)
}

export function vividnessFit(stats: ImageStats, vividness: 'vivid' | 'muted' | 'mono'): number {
  if (vividness === 'mono') return 1 - ramp(stats.saturation, 0.05, 0.14)
  if (vividness === 'vivid') return ramp(stats.saturation, 0.35, 0.6)
  return (1 - ramp(stats.saturation, 0.3, 0.5)) * ramp(stats.saturation, 0.05, 0.12)
}

export function encodeHues(hues: Float32Array): Uint8Array {
  return new Uint8Array(hues.buffer.slice(hues.byteOffset, hues.byteOffset + hues.byteLength))
}

export function decodeHues(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}
