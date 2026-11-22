import sharp from '../safeSharp'
import type { EditRegion, RegionName } from '../../shared/studio'

// Selective editing. A region says which part of a picture may change. It comes from the user's own painting, from a
// shape, or from a name such as "the sky". The edit is made on a copy and then laid back over the original through the
// soft mask, so every pixel outside the region (and its soft edge) stays exactly as it was.

export interface RegionMask {
  width: number
  height: number
  /** One byte per pixel, 255 = change, 0 = keep, before the soft edge. */
  hard: Buffer
  /** The same with the soft edge. This is what the edit is blended through. */
  soft: Buffer
  /** Share of the picture that may change, 0 to 1. */
  coverage: number
  /** One plain sentence: how the region was found. */
  how: string
}

export { REGION_WORDS, regionFromText } from '../../shared/regionWords'

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

function shapeMask(width: number, height: number, shape: NonNullable<EditRegion['shape']>): Buffer {
  const out = Buffer.alloc(width * height)
  const x0 = clamp01(shape.x) * width
  const y0 = clamp01(shape.y) * height
  const x1 = clamp01(shape.x + shape.w) * width
  const y1 = clamp01(shape.y + shape.h) * height
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const rx = Math.max(1, (x1 - x0) / 2)
  const ry = Math.max(1, (y1 - y0) / 2)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = shape.kind === 'ellipse' ? ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 : x + 0.5 >= x0 && x + 0.5 <= x1 && y + 0.5 >= y0 && y + 0.5 <= y1
      if (inside) out[y * width + x] = 255
    }
  }
  return out
}

/** Parts of the picture that follow from its geometry alone. */
function geometricMask(width: number, height: number, name: Exclude<RegionName, 'sky'>): Buffer {
  switch (name) {
    case 'top': return shapeMask(width, height, { kind: 'rect', x: 0, y: 0, w: 1, h: 0.4 })
    case 'bottom':
    case 'foreground': return shapeMask(width, height, { kind: 'rect', x: 0, y: 0.58, w: 1, h: 0.42 })
    case 'left': return shapeMask(width, height, { kind: 'rect', x: 0, y: 0, w: 0.46, h: 1 })
    case 'right': return shapeMask(width, height, { kind: 'rect', x: 0.54, y: 0, w: 0.46, h: 1 })
    case 'center': return shapeMask(width, height, { kind: 'ellipse', x: 0.2, y: 0.15, w: 0.6, h: 0.7 })
    case 'background': {
      const subject = shapeMask(width, height, { kind: 'ellipse', x: 0.15, y: 0.1, w: 0.7, h: 0.8 })
      for (let i = 0; i < subject.length; i += 1) subject[i] = 255 - subject[i]!
      return subject
    }
  }
}

/**
 * Finds the sky: smooth or cloudy areas that connect to the top edge, grown outwards while neighbouring pixels keep
 * changing gently (so a sunset gradient is followed). Honest limits: it works on the picture's own colours, not on
 * understanding, so a smooth wall at the top edge can be mistaken for sky. The user always sees the selection first.
 */
export async function detectSky(source: Buffer | string): Promise<{ mask: Buffer; width: number; height: number } | null> {
  const long = 320
  const { data, info } = await sharp(source, { failOn: 'none' }).rotate().resize(long, long, { fit: 'inside' }).blur(1.4).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  const lum = new Float32Array(w * h)
  const sat = new Float32Array(w * h)
  for (let i = 0; i < w * h; i += 1) {
    const r = data[i * 3]!
    const g = data[i * 3 + 1]!
    const b = data[i * 3 + 2]!
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b
    const mx = Math.max(r, g, b)
    sat[i] = mx === 0 ? 0 : (mx - Math.min(r, g, b)) / mx
  }
  const ok = new Uint8Array(w * h)
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x
      const grad = Math.max(Math.abs(lum[i + 1]! - lum[i - 1]!), Math.abs(lum[i + w]! - lum[i - w]!))
      const cloud = lum[i]! > 150 && sat[i]! < 0.3
      if (grad < 9 || (cloud && grad < 28)) ok[i] = 1
    }
  }
  for (let x = 0; x < w; x += 1) {
    ok[x] = ok[w + x]!
    ok[(h - 1) * w + x] = ok[(h - 2) * w + x]!
  }
  for (let y = 0; y < h; y += 1) {
    ok[y * w] = ok[y * w + 1]!
    ok[y * w + w - 1] = ok[y * w + w - 2]!
  }
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  for (let x = 0; x < w; x += 1) if (ok[x]) { seen[x] = 1; stack.push(x) }
  const step = (a: number, b: number): boolean => Math.abs(data[a * 3]! - data[b * 3]!) + Math.abs(data[a * 3 + 1]! - data[b * 3 + 1]!) + Math.abs(data[a * 3 + 2]! - data[b * 3 + 2]!) < 36
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w
    const y = (i / w) | 0
    const next: number[] = []
    if (x > 0) next.push(i - 1)
    if (x < w - 1) next.push(i + 1)
    if (y > 0) next.push(i - w)
    if (y < h - 1) next.push(i + w)
    for (const n of next) {
      if (seen[n] || !ok[n] || !step(i, n)) continue
      seen[n] = 1
      stack.push(n)
    }
  }
  // Clouds, birds and other things that sit inside the sky are surrounded by it: whatever the outside cannot reach is sky too.
  const outside = new Uint8Array(w * h)
  const edge: number[] = []
  for (let x = 0; x < w; x += 1) for (const i of [x, (h - 1) * w + x]) if (!seen[i] && !outside[i]) { outside[i] = 1; edge.push(i) }
  for (let y = 0; y < h; y += 1) for (const i of [y * w, y * w + w - 1]) if (!seen[i] && !outside[i]) { outside[i] = 1; edge.push(i) }
  while (edge.length) {
    const i = edge.pop()!
    const x = i % w
    const y = (i / w) | 0
    const next: number[] = []
    if (x > 0) next.push(i - 1)
    if (x < w - 1) next.push(i + 1)
    if (y > 0) next.push(i - w)
    if (y < h - 1) next.push(i + w)
    for (const n of next) if (!seen[n] && !outside[n]) { outside[n] = 1; edge.push(n) }
  }
  for (let i = 0; i < w * h; i += 1) if (!seen[i] && !outside[i]) seen[i] = 1
  let count = 0
  for (let i = 0; i < w * h; i += 1) if (seen[i]) count += 1
  const share = count / (w * h)
  if (share < 0.03 || share > 0.92) return null
  const mask = Buffer.alloc(w * h)
  for (let i = 0; i < w * h; i += 1) if (seen[i]) mask[i] = 255
  // Close small holes (cloud edges) and cover the fringe where the sky meets what is below it.
  const closed = await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).blur(3).threshold(60).extractChannel(0).raw().toBuffer()
  return { mask: closed, width: w, height: h }
}

const rgbCache = new WeakMap<Buffer, Buffer>()

/** The picture's pixels as plain RGB, decoded once per picture buffer (retouching decodes the same big picture several times). */
export async function decodeRgb(input: Buffer): Promise<Buffer> {
  const hit = rgbCache.get(input)
  if (hit) return hit
  const raw = await sharp(input, { failOn: 'none', limitInputPixels: false }).rotate().removeAlpha().raw().toBuffer()
  rgbCache.set(input, raw)
  return raw
}

async function decodeMask(png: string, width: number, height: number): Promise<Buffer> {
  const base64 = png.includes(',') ? png.slice(png.indexOf(',') + 1) : png
  const raw = await sharp(Buffer.from(base64, 'base64'), { failOn: 'none' }).flatten({ background: '#000' }).greyscale().resize(width, height, { fit: 'fill' }).extractChannel(0).raw().toBuffer()
  for (let i = 0; i < raw.length; i += 1) raw[i] = raw[i]! > 127 ? 255 : 0
  return raw
}

/** Builds the mask for a region on a picture of the given size (or reads the size from the picture). */
export async function buildRegionMask(source: Buffer | string, region: EditRegion, size?: { width: number; height: number }): Promise<RegionMask> {
  let dims: { width: number; height: number }
  if (size) dims = size
  else {
    const info = (await sharp(source, { failOn: 'none' }).rotate().toBuffer({ resolveWithObject: true })).info
    dims = { width: info.width, height: info.height }
  }
  const { width, height } = dims
  let hard: Buffer
  let how: string
  if (region.maskPng) {
    hard = await decodeMask(region.maskPng, width, height)
    how = 'the area you painted'
  } else if (region.shape) {
    hard = shapeMask(width, height, region.shape)
    how = region.shape.kind === 'ellipse' ? 'the oval you drew' : 'the rectangle you drew'
  } else if (region.named === 'sky') {
    const sky = await detectSky(source)
    if (!sky) throw new Error('Atlas could not find a clear sky in this picture. Paint the area you want to change instead.')
    const grown = await sharp(sky.mask, { raw: { width: sky.width, height: sky.height, channels: 1 } }).resize(width, height, { fit: 'fill', kernel: 'cubic' }).blur(Math.max(1.5, Math.max(width, height) * 0.0035)).threshold(70).extractChannel(0).raw().toBuffer()
    hard = grown
    how = 'the sky, found from its colours and where it meets the top edge'
  } else if (region.named) {
    hard = geometricMask(width, height, region.named)
    how = `the ${region.named === 'center' ? 'central part' : region.named === 'background' ? 'area around the middle' : `${region.named} of the picture`}`
  } else {
    throw new Error('Choose which part of the picture may change: paint it, draw a shape, or name it (for example the sky).')
  }
  if (region.invert) {
    for (let i = 0; i < hard.length; i += 1) hard[i] = 255 - hard[i]!
    how = `everything except ${how}`
  }
  let marked = 0
  for (let i = 0; i < hard.length; i += 1) if (hard[i]! > 127) marked += 1
  const coverage = marked / hard.length
  // A few pixels is a deliberate mark on a large picture (a speck to heal); nothing at all is an empty selection.
  if (marked < 12) throw new Error('The selected area is empty. Paint over the part you want to change.')
  const feather = Math.max(0, Math.min(80, region.feather ?? Math.round(Math.max(width, height) * 0.006)))
  const soft = feather < 1 ? Buffer.from(hard) : await sharp(hard, { raw: { width, height, channels: 1 } }).blur(Math.max(0.3, feather / 2)).extractChannel(0).raw().toBuffer()
  return { width, height, hard, soft, coverage, how }
}

/**
 * Lays an edited picture over the original through the soft mask. Outside the mask every pixel is the original's own,
 * byte for byte, whatever size the edit was made at (it is resampled to the original's size first).
 */
export async function compositeThroughMask(original: Buffer | string, edited: Buffer, mask: RegionMask): Promise<{ png: Buffer; width: number; height: number }> {
  const { width, height } = mask
  const base = typeof original !== 'string' && (await sharp(original, { failOn: 'none', limitInputPixels: false }).metadata().then((m) => m.width === width && m.height === height)) ? await decodeRgb(original) : await sharp(original, { failOn: 'none', limitInputPixels: false }).rotate().removeAlpha().resize(width, height, { fit: 'fill' }).raw().toBuffer()
  const over = await sharp(edited, { failOn: 'none', limitInputPixels: false }).removeAlpha().resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer()
  const out = Buffer.from(base)
  for (let i = 0; i < width * height; i += 1) {
    const m = mask.soft[i]!
    if (m === 0) continue
    const a = m / 255
    const o = i * 3
    out[o] = Math.round(base[o]! + (over[o]! - base[o]!) * a)
    out[o + 1] = Math.round(base[o + 1]! + (over[o + 1]! - base[o + 1]!) * a)
    out[o + 2] = Math.round(base[o + 2]! + (over[o + 2]! - base[o + 2]!) * a)
  }
  const png = await sharp(out, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 4 }).toBuffer()
  return { png, width, height }
}

/** A small picture showing the selection (red over a dimmed copy), so the user can check it before anything is made. */
export async function regionOverlay(source: Buffer | string, mask: RegionMask, longEdge = 720): Promise<string> {
  const scale = Math.min(1, longEdge / Math.max(mask.width, mask.height))
  const w = Math.max(1, Math.round(mask.width * scale))
  const h = Math.max(1, Math.round(mask.height * scale))
  const base = await sharp(source, { failOn: 'none' }).rotate().removeAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer()
  const m = await sharp(mask.soft, { raw: { width: mask.width, height: mask.height, channels: 1 } }).resize(w, h, { fit: 'fill' }).extractChannel(0).raw().toBuffer()
  const out = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i += 1) {
    const a = m[i]! / 255
    for (let c = 0; c < 3; c += 1) {
      const v = base[i * 3 + c]!
      const tint = c === 0 ? 235 : c === 1 ? 70 : 90
      out[i * 3 + c] = Math.round(v * (1 - a * 0.55) + tint * a * 0.55 + (1 - a) * -v * 0.35)
    }
  }
  const jpeg = await sharp(out, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 82 }).toBuffer()
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

/** The mask as a picture the ComfyUI graphs can load: white where the picture may change. */
export async function maskToPng(mask: RegionMask, soft = false): Promise<Buffer> {
  return sharp(soft ? mask.soft : mask.hard, { raw: { width: mask.width, height: mask.height, channels: 1 } }).png().toBuffer()
}
