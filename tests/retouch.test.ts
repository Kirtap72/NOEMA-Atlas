import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { blurredCopy, blurSigma, dilate, exemplarFill, fillFromSurroundings, healedCopy, maskBox, sharpenedCopy, tonedCopy } from '../src/main/studio/retouch'
import { buildRegionMask, compositeThroughMask } from '../src/main/studio/regions'

const W = 240
const H = 160

/** A picture with a smooth gradient, a diagonal stripe pattern (structure to continue) and a sharp vertical edge. */
async function scene(): Promise<{ png: Buffer; raw: Buffer }> {
  const raw = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const stripe = ((x + y) >> 3) % 2 === 0 ? 40 : 0
      const edge = x > 150 ? 90 : 0
      const v = 80 + x * 0.3 + stripe + edge
      const o = (y * W + x) * 3
      raw[o] = Math.min(255, v)
      raw[o + 1] = Math.min(255, v * 0.9 + y * 0.2)
      raw[o + 2] = Math.min(255, v * 0.8)
    }
  }
  return { raw, png: await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() }
}

async function paintedRect(x: number, y: number, w: number, h: number): Promise<string> {
  const m = Buffer.alloc(W * H)
  for (let j = y; j < y + h; j += 1) for (let i = x; i < x + w; i += 1) m[j * W + i] = 255
  const png = await sharp(m, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

const rawOf = async (png: Buffer): Promise<Buffer> => sharp(png).removeAlpha().raw().toBuffer()

describe('blur', () => {
  it('softens only the painted part, and more strength softens more', async () => {
    const { png, raw } = await scene()
    const mask = await buildRegionMask(png, { maskPng: await paintedRect(20, 20, 80, 60), feather: 4 })
    const light = await rawOf(await compositeThroughMask(png, await blurredCopy(png, mask, { strength: 0.2, edgeAware: false }), mask).then((r) => r.png))
    const strong = await rawOf(await compositeThroughMask(png, await blurredCopy(png, mask, { strength: 0.9, edgeAware: false }), mask).then((r) => r.png))
    let outside = 0
    let diffLight = 0
    let diffStrong = 0
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const o = (y * W + x) * 3
        const inside = x >= 14 && x < 106 && y >= 14 && y < 86
        if (!inside) outside += Math.abs(strong[o]! - raw[o]!)
        else { diffLight += Math.abs(light[o]! - raw[o]!); diffStrong += Math.abs(strong[o]! - raw[o]!) }
      }
    }
    expect(outside).toBe(0)
    expect(diffStrong).toBeGreaterThan(diffLight)
    expect(diffLight).toBeGreaterThan(0)
  })

  it('edge-aware smoothing keeps a strong edge sharper than a plain blur does', async () => {
    const { png, raw } = await scene()
    const mask = await buildRegionMask(png, { maskPng: await paintedRect(100, 30, 100, 90), feather: 2 })
    const edgeStep = (buf: Buffer): number => {
      const y = 70
      const a = (y * W + 146) * 3
      const b = (y * W + 156) * 3
      return Math.abs(buf[b]! - buf[a]!)
    }
    const plain = await rawOf(await blurredCopy(png, mask, { strength: 0.7, edgeAware: false }))
    const guided = await rawOf(await blurredCopy(png, mask, { strength: 0.7, edgeAware: true }))
    expect(edgeStep(guided)).toBeGreaterThan(edgeStep(plain))
    expect(edgeStep(raw)).toBeGreaterThanOrEqual(edgeStep(guided))
  })

  it('maps strength to a radius that grows with the picture and the strength', () => {
    expect(blurSigma(0.9, 4000, 3000)).toBeGreaterThan(blurSigma(0.3, 4000, 3000))
    expect(blurSigma(0.5, 4000, 3000)).toBeGreaterThan(blurSigma(0.5, 400, 300))
    expect(blurSigma(0, 800, 600)).toBeLessThan(1)
  })
})

describe('remove (content-aware fill)', () => {
  it('rebuilds a hole in a striped picture close to the truth and touches nothing outside', async () => {
    const { png, raw } = await scene()
    // Damage the picture: a blob of unrelated colour where something unwanted sits.
    const damaged = Buffer.from(raw)
    for (let y = 60; y < 90; y += 1) for (let x = 50; x < 90; x += 1) { const o = (y * W + x) * 3; damaged[o] = 250; damaged[o + 1] = 20; damaged[o + 2] = 20 }
    const damagedPng = await sharp(damaged, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()
    const mask = await buildRegionMask(damagedPng, { maskPng: await paintedRect(50, 60, 40, 30), feather: 2 })
    const filled = await fillFromSurroundings(damagedPng, mask.coverage > 0 ? mask : mask, 0.3)
    const final = await rawOf((await compositeThroughMask(damagedPng, filled.png, filled.mask)).png)
    let err = 0
    let n = 0
    let red = 0
    for (let y = 60; y < 90; y += 1) {
      for (let x = 50; x < 90; x += 1) {
        const o = (y * W + x) * 3
        err += Math.abs(final[o]! - raw[o]!) + Math.abs(final[o + 1]! - raw[o + 1]!) + Math.abs(final[o + 2]! - raw[o + 2]!)
        n += 3
        if (final[o]! > 200 && final[o + 1]! < 60) red += 1
      }
    }
    expect(red).toBe(0)
    expect(err / n).toBeLessThan(28)
    // Far from the hole the picture is byte for byte what it was.
    let far = 0
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (x < 30 || x > 115 || y < 35 || y > 115) { const o = (y * W + x) * 3; if (final[o] !== damaged[o] || final[o + 1] !== damaged[o + 1]) far += 1 }
    expect(far).toBe(0)
  })

  it('says so when the painted area leaves too little picture to learn from', async () => {
    const { png } = await scene()
    const mask = await buildRegionMask(png, { maskPng: await paintedRect(2, 2, 236, 156) })
    await expect(fillFromSurroundings(png, mask, 0.3)).rejects.toThrow(/too|little|large|smaller/i)
  })

  it('exemplarFill continues a plain gradient without leaving the unknown colour', () => {
    const w = 40
    const h = 40
    const rgb = new Float32Array(w * h * 3)
    const unknown = new Uint8Array(w * h)
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const i = y * w + x; rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 100 + x; if (x > 15 && x < 24 && y > 15 && y < 24) { unknown[i] = 1; rgb[i * 3] = 0 } }
    exemplarFill(rgb, unknown, w, h)
    for (let i = 0; i < w * h; i += 1) if (unknown[i]) expect(rgb[i * 3]!).toBeGreaterThan(90)
  })

  it('helpers: the work box and growing a mask', () => {
    const w = 20
    const h = 20
    const hard = Buffer.alloc(w * h)
    hard[10 * w + 10] = 255
    const grown = dilate(hard, w, h, 2)
    expect(grown.filter((v) => v === 255).length).toBeGreaterThan(5)
    const box = maskBox({ width: w, height: h, hard, soft: hard, coverage: 0, how: '' }, 3)
    expect(box).toEqual({ x0: 7, y0: 7, x1: 13, y1: 13 })
  })
})

const lumaAt = (raw: Buffer, x: number, y: number): number => 0.299 * raw[(y * W + x) * 3]! + 0.587 * raw[(y * W + x) * 3 + 1]! + 0.114 * raw[(y * W + x) * 3 + 2]!

describe('dodge and burn', () => {
  it('lightens or darkens the mid-tones, keeps black and white and the hue, and leaves the outside alone', async () => {
    const { png, raw } = await scene()
    const mask = await buildRegionMask(png, { maskPng: await paintedRect(30, 30, 90, 70), feather: 6 })
    const up = await rawOf((await compositeThroughMask(png, await tonedCopy(png, mask, 0.6, 'lighten'), mask)).png)
    const down = await rawOf((await compositeThroughMask(png, await tonedCopy(png, mask, 0.6, 'darken'), mask)).png)
    expect(lumaAt(up, 70, 60)).toBeGreaterThan(lumaAt(raw, 70, 60) + 8)
    expect(lumaAt(down, 70, 60)).toBeLessThan(lumaAt(raw, 70, 60) - 8)
    // hue: the red-to-green ratio hardly moves
    const ratio = (b: Buffer): number => b[(60 * W + 70) * 3]! / Math.max(1, b[(60 * W + 70) * 3 + 1]!)
    expect(Math.abs(ratio(up) - ratio(raw))).toBeLessThan(0.08)
    let outside = 0
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (x < 14 || x > 136 || y < 14 || y > 114) { const o = (y * W + x) * 3; if (up[o] !== raw[o] || down[o + 1] !== raw[o + 1]) outside += 1 }
    expect(outside).toBe(0)
    // pure black and pure white stay
    const black = await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } }).png().toBuffer()
    const blackUp = await rawOf((await tonedCopy(black, mask, 1, 'lighten')))
    expect(blackUp[(60 * W + 70) * 3]).toBeLessThan(3)
    const white = await sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } }).png().toBuffer()
    const whiteUp = await rawOf((await tonedCopy(white, mask, 1, 'lighten')))
    expect(whiteUp[(60 * W + 70) * 3]).toBe(255)
  })
})

describe('sharpen', () => {
  it('adds local contrast on soft detail without overshooting the local range', async () => {
    const soft = await sharp(await (await scene()).png).blur(0.9).png().toBuffer()
    const base = await rawOf(soft)
    const mask = await buildRegionMask(soft, { maskPng: await paintedRect(20, 20, 150, 110), feather: 4 })
    const out = await rawOf(await sharpenedCopy(soft, mask, 0.7))
    const contrast = (b: Buffer): number => { let s2 = 0; for (let y = 30; y < 120; y += 1) for (let x = 30; x < 160; x += 1) s2 += (lumaAt(b, x + 1, y) - lumaAt(b, x - 1, y)) ** 2; return s2 }
    expect(contrast(out)).toBeGreaterThan(contrast(base) * 1.1)
    // no halos: nothing leaves the range of its 5x5 neighbourhood by more than a couple of levels
    let over = 0
    for (let y = 32; y < 118; y += 1) for (let x = 32; x < 158; x += 1) {
      let mn = 255, mx = 0
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) { const v = lumaAt(base, x + dx, y + dy); mn = Math.min(mn, v); mx = Math.max(mx, v) }
      const v = lumaAt(out, x, y)
      if (v > mx + 3.5 || v < mn - 3.5) over += 1
    }
    expect(over).toBe(0)
  })

  it('does not amplify grain on a flat noisy area', async () => {
    const raw = Buffer.alloc(W * H * 3)
    let seed = 5
    for (let i = 0; i < raw.length; i += 1) { seed = (seed * 1664525 + 1013904223) >>> 0; raw[i] = 120 + ((seed >>> 24) % 9) - 4 }
    const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()
    const mask = await buildRegionMask(png, { maskPng: await paintedRect(20, 20, 150, 110) })
    const out = await rawOf(await sharpenedCopy(png, mask, 0.9))
    const sd = (b: Buffer): number => { let m = 0, v = 0, n = 0; for (let y = 30; y < 120; y += 1) for (let x = 30; x < 160; x += 1) { m += lumaAt(b, x, y); n += 1 } m /= n; for (let y = 30; y < 120; y += 1) for (let x = 30; x < 160; x += 1) v += (lumaAt(b, x, y) - m) ** 2; return Math.sqrt(v / n) }
    expect(sd(out)).toBeLessThan(sd(raw) * 1.6)
  })
})

describe('heal', () => {
  it('gives a stained patch the tone of its surroundings and keeps texture', async () => {
    const { png, raw } = await scene()
    const stained = Buffer.from(raw)
    for (let y = 70; y < 90; y += 1) for (let x = 60; x < 84; x += 1) { const o = (y * W + x) * 3; stained[o] = Math.min(255, stained[o]! * 0.55); stained[o + 1] = Math.min(255, stained[o + 1]! * 0.7 + 30); stained[o + 2] = stained[o + 2]! * 0.5 }
    const stainedPng = await sharp(stained, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()
    const mask = await buildRegionMask(stainedPng, { maskPng: await paintedRect(58, 68, 28, 24), feather: 3 })
    const healed = await healedCopy(stainedPng, mask, 0.6)
    const final = await rawOf((await compositeThroughMask(stainedPng, healed.png, healed.mask)).png)
    const err = (b: Buffer): number => { let s2 = 0; let n = 0; for (let y = 72; y < 88; y += 1) for (let x = 62; x < 82; x += 1) for (let c = 0; c < 3; c += 1) { s2 += Math.abs(b[(y * W + x) * 3 + c]! - raw[(y * W + x) * 3 + c]!); n += 1 } return s2 / n }
    expect(err(final)).toBeLessThan(err(stained) * 0.5)
    let far = 0
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (x < 40 || x > 104 || y < 50 || y > 110) { const o = (y * W + x) * 3; if (final[o] !== stained[o]) far += 1 }
    expect(far).toBe(0)
  })
})
