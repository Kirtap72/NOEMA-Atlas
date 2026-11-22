import sharp from '../safeSharp'
import type { ReferenceAspect } from '../../shared/studio'

// Reference-guided editing that acts on the pixels. A reference picture (or a whole moodboard) lends its light, colour
// or atmosphere to the picture being edited: the picture is moved towards the reference's statistics in the Lab colour
// space (Reinhard colour transfer, with the amount under the user's control). The result is what the AI model starts
// from, so the generated picture really follows the reference, and the structure of the original is untouched.
// Composition and material references need an image-conditioned model and are not claimed here.

export interface LookStats {
  l: { mean: number; std: number; p5: number; p95: number }
  a: { mean: number; std: number }
  b: { mean: number; std: number }
}

const toLinear = new Float32Array(256)
for (let i = 0; i < 256; i += 1) {
  const c = i / 255
  toLinear[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const XN = 0.95047
const ZN = 1.08883
const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
const finv = (t: number): number => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27))

function rgbToLab(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const lr = toLinear[r]!
  const lg = toLinear[g]!
  const lb = toLinear[b]!
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN
  const y = 0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / ZN
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  out[o] = 116 * fy - 16
  out[o + 1] = 500 * (fx - fy)
  out[o + 2] = 200 * (fy - fz)
}

const encode = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}

function labToRgb(l: number, a: number, b: number, out: Buffer, o: number): void {
  const fy = (l + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const x = finv(fx) * XN
  const y = finv(fy)
  const z = finv(fz) * ZN
  out[o] = encode(3.2404542 * x - 1.5371385 * y - 0.4985314 * z)
  out[o + 1] = encode(-0.969266 * x + 1.8760108 * y + 0.041556 * z)
  out[o + 2] = encode(0.0556434 * x - 0.2040259 * y + 1.0572252 * z)
}

async function labOf(source: Buffer | string, longEdge: number): Promise<{ lab: Float32Array; width: number; height: number }> {
  const { data, info } = await sharp(source, { failOn: 'none', limitInputPixels: false }).rotate().resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const lab = new Float32Array(info.width * info.height * 3)
  for (let i = 0; i < info.width * info.height; i += 1) rgbToLab(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!, lab, i * 3)
  return { lab, width: info.width, height: info.height }
}

function statsOf(lab: Float32Array): LookStats {
  const n = lab.length / 3
  let sl = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i += 1) {
    sl += lab[i * 3]!
    sa += lab[i * 3 + 1]!
    sb += lab[i * 3 + 2]!
  }
  const ml = sl / n
  const ma = sa / n
  const mb = sb / n
  let vl = 0
  let va = 0
  let vb = 0
  const hist = new Uint32Array(101)
  for (let i = 0; i < n; i += 1) {
    const l = lab[i * 3]!
    vl += (l - ml) ** 2
    va += (lab[i * 3 + 1]! - ma) ** 2
    vb += (lab[i * 3 + 2]! - mb) ** 2
    hist[Math.max(0, Math.min(100, Math.round(l)))]! += 1
  }
  const percentile = (p: number): number => {
    let acc = 0
    for (let v = 0; v <= 100; v += 1) {
      acc += hist[v]!
      if (acc >= n * p) return v
    }
    return 100
  }
  return { l: { mean: ml, std: Math.sqrt(vl / n), p5: percentile(0.05), p95: percentile(0.95) }, a: { mean: ma, std: Math.sqrt(va / n) }, b: { mean: mb, std: Math.sqrt(vb / n) } }
}

/** The look of a picture: its light, contrast and colour balance, measured on a small copy. */
export async function lookStats(source: Buffer | string): Promise<LookStats> {
  return statsOf((await labOf(source, 256)).lab)
}

/** One look from several pictures (a moodboard): the average, so no single picture dominates. */
export function mergeStats(list: LookStats[]): LookStats {
  if (list.length === 0) throw new Error('No reference pictures.')
  const mean = (pick: (s: LookStats) => number): number => list.reduce((s, x) => s + pick(x), 0) / list.length
  return {
    l: { mean: mean((s) => s.l.mean), std: mean((s) => s.l.std), p5: mean((s) => s.l.p5), p95: mean((s) => s.l.p95) },
    a: { mean: mean((s) => s.a.mean), std: mean((s) => s.a.std) },
    b: { mean: mean((s) => s.b.mean), std: mean((s) => s.b.std) }
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/**
 * Moves a picture towards a reference look. `lighting` changes brightness and contrast, `colour` the colour balance,
 * `atmosphere` both (and lifts the blacks when the reference is hazy). `amount` is how far, 0 to 1.
 */
export async function transferLook(image: Buffer | string, reference: LookStats, aspects: ReferenceAspect[], amount = 0.75): Promise<Buffer> {
  const { data, info } = await sharp(image, { failOn: 'none', limitInputPixels: false }).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const n = width * height
  const lab = new Float32Array(n * 3)
  for (let i = 0; i < n; i += 1) rgbToLab(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!, lab, i * 3)
  const own = await lookStats(image)
  const want = (aspect: ReferenceAspect): boolean => aspects.includes(aspect) || (aspect !== 'atmosphere' && aspects.includes('atmosphere'))
  const a = clamp(amount, 0, 1)
  const kL = clamp(reference.l.std / Math.max(1, own.l.std), 0.7, 1.45)
  const kA = clamp(reference.a.std / Math.max(0.5, own.a.std), 0.5, 1.8)
  const kB = clamp(reference.b.std / Math.max(0.5, own.b.std), 0.5, 1.8)
  const haze = aspects.includes('atmosphere') ? clamp((reference.l.p5 - own.l.p5) / 40, 0, 0.5) : 0
  const out = Buffer.alloc(n * 3)
  const doL = want('lighting')
  const doC = want('colour')
  for (let i = 0; i < n; i += 1) {
    const l0 = lab[i * 3]!
    const a0 = lab[i * 3 + 1]!
    const b0 = lab[i * 3 + 2]!
    let l1 = l0
    let a1 = a0
    let b1 = b0
    if (doL) {
      l1 = (l0 - own.l.mean) * kL + reference.l.mean
      if (haze > 0) l1 = l1 + (reference.l.p5 - l1) * haze * (1 - l1 / 100) * 2
    }
    if (doC) {
      a1 = (a0 - own.a.mean) * kA + reference.a.mean
      b1 = (b0 - own.b.mean) * kB + reference.b.mean
    }
    labToRgb(clamp(l0 + (l1 - l0) * a, 0, 100), a0 + (a1 - a0) * a, b0 + (b1 - b0) * a, out, i * 3)
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 3 }).toBuffer()
}

/** The look in a few words, so the description given to the model says the same as the pixels. */
export function describeLook(s: LookStats): string {
  const words: string[] = []
  if (s.l.mean < 38) words.push('dark, low-key light')
  else if (s.l.mean < 55) words.push('subdued light')
  else if (s.l.mean > 72) words.push('bright, airy light')
  if (s.l.std > 26) words.push('strong contrast')
  else if (s.l.std < 14) words.push('soft, low contrast')
  const chroma = Math.hypot(s.a.mean, s.b.mean)
  if (s.b.mean > 12) words.push('warm golden tones')
  else if (s.b.mean < -8) words.push('cool blue tones')
  if (s.a.mean > 10) words.push('rose and magenta tones')
  else if (s.a.mean < -8) words.push('green tones')
  if (chroma < 9 && s.a.std < 14) words.push('muted palette')
  else if (s.a.std + s.b.std > 40) words.push('rich, saturated colour')
  return words.join(', ')
}
