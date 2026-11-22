import sharp, { type OverlayOptions, type Sharp } from '../safeSharp'
import type { RefRole } from '../../shared/studio'

// Atlas Blend: a real, fully offline way of making a new picture from a moodboard, and of changing an existing one
// without any AI model. It does not invent subjects. It takes the composition of one reference, re-colours it with
// the palette of another, lays the atmosphere of a third over it, and grades the result towards the mood the user
// asked for. It is a colour-and-composition study, honest about being that, and it works anywhere.

/** A small deterministic random source, so the same seed always gives the same picture. */
export function seeded(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MoodAdjustment {
  brightness: number
  saturation: number
  contrast: number
  /** Multipliers for red, green and blue. */
  grade: [number, number, number]
  vignette: number
  haze: number
  grain: number
  glow: number
  mono: boolean
  sharpen: boolean
  hue: number
  /** Words that were understood, for telling the user what was done. */
  understood: string[]
}

const NEUTRAL = (): MoodAdjustment => ({ brightness: 1, saturation: 1, contrast: 1, grade: [1, 1, 1], vignette: 0, haze: 0, grain: 0, glow: 0, mono: false, sharpen: false, hue: 0, understood: [] })

interface MoodRule {
  words: RegExp
  label: string
  apply(m: MoodAdjustment): void
}

const mul = (m: MoodAdjustment, r: number, g: number, b: number): void => {
  m.grade = [m.grade[0] * r, m.grade[1] * g, m.grade[2] * b]
}

const RULES: MoodRule[] = [
  { words: /myster|mystisk|moody|noir|ominous|eerie|dark|mörk|dyster|haunt|gloom/, label: 'more mysterious', apply: (m) => { m.brightness *= 0.66; m.saturation *= 0.7; m.contrast *= 1.12; m.vignette += 0.9; m.haze += 0.16; mul(m, 0.88, 0.97, 1.14) } },
  { words: /mist|fog|dimma|haze|dim[mb]ig|hazy|ethereal/, label: 'misty', apply: (m) => { m.haze += 0.5; m.contrast *= 0.82; m.saturation *= 0.82; m.brightness *= 1.04 } },
  { words: /dream|soft|drömsk|mjuk|gentle|romantic|romantisk/, label: 'dreamy and soft', apply: (m) => { m.glow += 0.4; m.contrast *= 0.94 } },
  { words: /warm|golden|gyllene|varm|sunset|solnedgång|dusk|amber|glow of/, label: 'warmer', apply: (m) => { mul(m, 1.1, 1.02, 0.86); m.saturation *= 1.06 } },
  { words: /cold|cool|kall|icy|blue|blå|winter|vinter|frost/, label: 'cooler', apply: (m) => { mul(m, 0.9, 0.99, 1.12) } },
  { words: /bright|ljus|airy|luminous|light and|lighter|ljusare/, label: 'brighter', apply: (m) => { m.brightness *= 1.16 } },
  { words: /vivid|saturated|colourful|colorful|färgstark|vibrant|intense/, label: 'more vivid', apply: (m) => { m.saturation *= 1.35 } },
  { words: /muted|faded|desaturat|dämpad|subtle|quiet|stillsam/, label: 'quieter colours', apply: (m) => { m.saturation *= 0.68 } },
  { words: /black and white|monochrome|svartvit|b&w|greyscale|grayscale/, label: 'black and white', apply: (m) => { m.mono = true } },
  { words: /film|grain|vintage|korn|analog|retro/, label: 'film grain', apply: (m) => { m.grain += 0.5; m.saturation *= 0.92; mul(m, 1.04, 1.0, 0.94) } },
  { words: /dramatic|dramatisk|contrast|kontrast|bold|powerful/, label: 'more dramatic', apply: (m) => { m.contrast *= 1.25; m.vignette += 0.3 } },
  { words: /surreal|surrealistisk|strange|otherworld|uncanny/, label: 'surreal colour shift', apply: (m) => { m.hue += 24; m.saturation *= 1.18 } },
  { words: /sharp|crisp|skarp|detailed|detaljrik/, label: 'crisper', apply: (m) => { m.sharpen = true } }
]

/** Turns a description such as "more mysterious, but keep the architecture" into image adjustments. */
export function readMood(text: string, strength = 0.6): MoodAdjustment {
  const q = text.toLowerCase()
  const full = NEUTRAL()
  const hit: string[] = []
  for (const rule of RULES) {
    if (rule.words.test(q)) {
      rule.apply(full)
      hit.push(rule.label)
    }
  }
  const s = Math.max(0, Math.min(1, strength))
  // Blend from "no change" towards the full effect, so strength is a real dial.
  const lerp = (v: number): number => 1 + (v - 1) * s
  const out = NEUTRAL()
  out.brightness = lerp(full.brightness)
  out.saturation = lerp(full.saturation)
  out.contrast = lerp(full.contrast)
  out.grade = [lerp(full.grade[0]), lerp(full.grade[1]), lerp(full.grade[2])]
  out.vignette = Math.min(0.85, full.vignette * s)
  out.haze = Math.min(0.55, full.haze * s)
  out.grain = Math.min(0.8, full.grain * s)
  out.glow = Math.min(0.6, full.glow * s)
  out.mono = full.mono && s > 0.2
  out.sharpen = full.sharpen
  out.hue = Math.round(full.hue * s)
  out.understood = hit
  return out
}

const png = (image: Sharp): Promise<Buffer> => image.png({ compressionLevel: 6 }).toBuffer()

/** The picture with a uniform transparency, so it can be laid over another one at partial strength. */
async function withOpacity(input: Buffer, opacity: number): Promise<Buffer> {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const pixels = info.width * info.height
  const rgba = Buffer.alloc(pixels * 4)
  const alpha = Math.max(0, Math.min(255, Math.round(255 * opacity)))
  for (let i = 0; i < pixels; i += 1) {
    rgba[i * 4] = data[i * 3]!
    rgba[i * 4 + 1] = data[i * 3 + 1]!
    rgba[i * 4 + 2] = data[i * 3 + 2]!
    rgba[i * 4 + 3] = alpha
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
}

/** Applies the adjustments. Pixels are graded, never moved, so the composition of the picture is kept. */
export async function applyMood(input: Buffer, mood: MoodAdjustment, seed = 1): Promise<Buffer> {
  const meta = await sharp(input).metadata()
  const width = meta.width ?? 1024
  const height = meta.height ?? 1024
  let image = sharp(input).removeAlpha()
  if (mood.hue) image = image.modulate({ hue: mood.hue })
  image = image.modulate({ brightness: mood.brightness, saturation: mood.mono ? 0 : mood.saturation })
  if (mood.contrast !== 1) image = image.linear(mood.contrast, 128 * (1 - mood.contrast))
  if (mood.grade.some((g) => Math.abs(g - 1) > 0.003)) image = image.linear(mood.grade, [0, 0, 0])
  if (mood.sharpen) image = image.sharpen({ sigma: 1.1 })
  let buffer = await png(image)

  const layers: OverlayOptions[] = []
  if (mood.glow > 0.01) {
    const soft = await sharp(buffer).blur(Math.max(4, width / 140)).png().toBuffer()
    layers.push({ input: await withOpacity(soft, mood.glow), blend: 'screen' })
  }
  if (mood.haze > 0.01) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfd6dc" stop-opacity="${mood.haze * 0.55}"/><stop offset="1" stop-color="#e7e2d6" stop-opacity="${mood.haze}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`
    layers.push({ input: Buffer.from(svg) })
  }
  if (mood.vignette > 0.01) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="v" cx="50%" cy="50%" r="75%"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${Math.min(0.9, mood.vignette)}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`
    layers.push({ input: Buffer.from(svg) })
  }
  if (mood.grain > 0.01) {
    const rand = seeded(seed + 7)
    const raw = Buffer.alloc(width * height * 3)
    for (let i = 0; i < raw.length; i += 1) raw[i] = 96 + Math.floor(rand() * 64)
    const noise = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
    layers.push({ input: await withOpacity(noise, mood.grain * 0.5), blend: 'soft-light' })
  }
  if (layers.length) buffer = await png(sharp(buffer).composite(layers))
  return buffer
}

export interface BlendRef {
  path: string
  roles: RefRole[]
}

export interface BlendInput {
  refs: BlendRef[]
  width: number
  height: number
  seed: number
  /** The user's prompt, read for mood words. */
  mood: string
  strength?: number
}

async function cover(path: string, width: number, height: number, rand: () => number, zoom = 1): Promise<Buffer> {
  const W = Math.round(width * zoom)
  const H = Math.round(height * zoom)
  const resized = await sharp(path, { failOn: 'none' }).rotate().resize(W, H, { fit: 'cover', position: 'attention' }).removeAlpha().png().toBuffer()
  if (zoom === 1) return resized
  const left = Math.floor(rand() * Math.max(1, W - width))
  const top = Math.floor(rand() * Math.max(1, H - height))
  return sharp(resized).extract({ left, top, width, height }).png().toBuffer()
}

/** Re-colours `base` so its overall colour balance resembles `palette`. */
async function transferColour(base: Buffer, palette: Buffer, amount: number): Promise<Buffer> {
  const [a, b] = await Promise.all([sharp(base).stats(), sharp(palette).stats()])
  const gain: number[] = []
  const offset: number[] = []
  for (let c = 0; c < 3; c += 1) {
    const sa = Math.max(8, a.channels[c]!.stdev)
    const sb = Math.max(8, b.channels[c]!.stdev)
    const g = Math.max(0.55, Math.min(1.8, sb / sa))
    const o = b.channels[c]!.mean - g * a.channels[c]!.mean
    gain.push(1 + (g - 1) * amount)
    offset.push(o * amount)
  }
  return png(sharp(base).linear(gain, offset))
}

/** Makes one new picture from the references. */
export async function blendArtwork(input: BlendInput): Promise<Buffer> {
  if (input.refs.length === 0) throw new Error('Atlas Blend needs at least one reference picture.')
  const rand = seeded(input.seed)
  const first = (role: RefRole): BlendRef | undefined => input.refs.find((r) => r.roles.includes(role))
  const compositionRef = first('composition') ?? first('subject') ?? input.refs[0]!
  const zoom = 1 + rand() * 0.22
  let base = await cover(compositionRef.path, input.width, input.height, rand, zoom)
  if (rand() < 0.35) base = await png(sharp(base).flop())

  const colourRefs = input.refs.filter((r) => r.roles.includes('colour') && r !== compositionRef)
  if (colourRefs.length) {
    const pick = colourRefs[Math.floor(rand() * colourRefs.length)]!
    base = await transferColour(base, await cover(pick.path, 256, 256, rand), 0.85)
  }

  const atmosphere = input.refs.filter((r) => r.roles.includes('atmosphere') && r !== compositionRef)
  const layers: OverlayOptions[] = []
  for (const ref of atmosphere.slice(0, 3)) {
    const layer = await cover(ref.path, input.width, input.height, rand, 1 + rand() * 0.3)
    const soft = await sharp(layer).blur(Math.max(3, input.width / 220)).png().toBuffer()
    layers.push({ input: await withOpacity(soft, 0.5 / Math.min(atmosphere.length, 3) + 0.15), blend: 'soft-light' })
  }
  // Subject pictures that are not the base come in lightly, like a double exposure.
  const subjects = input.refs.filter((r) => r.roles.includes('subject') && r !== compositionRef)
  for (const ref of subjects.slice(0, 2)) {
    const layer = await cover(ref.path, input.width, input.height, rand, 1 + rand() * 0.2)
    layers.push({ input: await withOpacity(layer, 0.28), blend: 'lighten' })
  }
  if (layers.length) base = await png(sharp(base).composite(layers))

  const mood = readMood(input.mood, input.strength ?? 0.6)
  return applyMood(base, mood, input.seed)
}
