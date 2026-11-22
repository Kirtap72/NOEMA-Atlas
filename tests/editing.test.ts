import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { buildRegionMask, compositeThroughMask, detectSky, regionFromText } from '../src/main/studio/regions'
import { describeLook, lookStats, mergeStats, transferLook } from '../src/main/studio/referenceTransfer'
import { countFromText, imagePromptFromInstruction, levelFromText, regionFromInstruction } from '../src/main/studio/editLanguage'
import { inpaintWorkflow, levelParams, subjectFromText, detailSettings } from '../src/main/studio/atlasWorkflows'

/** A landscape: a blue sky with a soft cloud on top, dark noisy "trees" at the bottom. */
async function landscape(width = 400, height = 300): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3)
  let seed = 7
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const horizon = Math.round(height * 0.55)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 3
      if (y < horizon) {
        const t = y / horizon
        raw[o] = 90 + t * 80
        raw[o + 1] = 140 + t * 60
        raw[o + 2] = 220 - t * 20
        if (Math.hypot(x - width * 0.6, y - height * 0.2) < 30) {
          raw[o] = 235
          raw[o + 1] = 238
          raw[o + 2] = 240
        }
      } else {
        raw[o] = 20 + rnd() * 60
        raw[o + 1] = 60 + rnd() * 90
        raw[o + 2] = 20 + rnd() * 40
      }
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

describe('region masks', () => {
  it('finds the sky from colour and the top edge, and not the trees', async () => {
    const image = await landscape()
    const sky = await detectSky(image)
    expect(sky).not.toBeNull()
    const mask = await buildRegionMask(image, { named: 'sky' })
    expect(mask.coverage).toBeGreaterThan(0.45)
    expect(mask.coverage).toBeLessThan(0.7)
    const at = (x: number, y: number): number => mask.hard[y * mask.width + x]!
    expect(at(200, 20)).toBe(255)
    expect(at(240, 60)).toBe(255) // inside the cloud
    expect(at(200, 250)).toBe(0)
  })

  it('refuses a picture with no sky rather than guessing', async () => {
    const noise = await sharp({ create: { width: 200, height: 150, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 120, sigma: 60 } } }).png().toBuffer()
    await expect(buildRegionMask(noise, { named: 'sky' })).rejects.toThrow(/could not find a clear sky/)
  })

  it('builds masks from shapes, geometry and the user’s own painting', async () => {
    const image = await landscape(200, 100)
    const rect = await buildRegionMask(image, { shape: { kind: 'rect', x: 0, y: 0, w: 0.5, h: 1 }, feather: 0 })
    expect(rect.coverage).toBeCloseTo(0.5, 1)
    const left = await buildRegionMask(image, { named: 'left' })
    expect(left.hard[50 * 200 + 10]).toBe(255)
    expect(left.hard[50 * 200 + 190]).toBe(0)
    const painted = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#000' } }).composite([{ input: await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer(), left: 10, top: 0 }]).png().toBuffer()
    const mine = await buildRegionMask(image, { maskPng: `data:image/png;base64,${painted.toString('base64')}`, feather: 0 })
    expect(mine.hard[50 * 200 + 190]).toBe(255)
    expect(mine.hard[50 * 200 + 10]).toBe(0)
    const inverted = await buildRegionMask(image, { maskPng: `data:image/png;base64,${painted.toString('base64')}`, invert: true, feather: 0 })
    expect(inverted.hard[50 * 200 + 10]).toBe(255)
    await expect(buildRegionMask(image, {})).rejects.toThrow(/Choose which part/)
  })

  it('leaves everything outside the mask exactly as the original', async () => {
    const image = await landscape(300, 200)
    const mask = await buildRegionMask(image, { shape: { kind: 'rect', x: 0.5, y: 0.1, w: 0.4, h: 0.5 }, feather: 8 })
    // A "model result" that is completely different, and at another size.
    const edited = await sharp({ create: { width: 150, height: 100, channels: 3, background: '#e03030' } }).png().toBuffer()
    const out = await compositeThroughMask(image, edited, mask)
    const before = await sharp(image).removeAlpha().raw().toBuffer()
    const after = await sharp(out.png).removeAlpha().raw().toBuffer()
    let changedOutside = 0
    let changedInside = 0
    for (let i = 0; i < 300 * 200; i += 1) {
      const differs = before[i * 3] !== after[i * 3] || before[i * 3 + 1] !== after[i * 3 + 1] || before[i * 3 + 2] !== after[i * 3 + 2]
      if (differs && mask.soft[i] === 0) changedOutside += 1
      if (differs && mask.hard[i] === 255) changedInside += 1
    }
    expect(changedOutside).toBe(0)
    expect(changedInside).toBeGreaterThan(0.9 * 120 * 100)
  })

  it('names regions from everyday words', () => {
    expect(regionFromText('make the sky more dramatic')).toBe('sky')
    expect(regionFromText('brighten the foreground')).toBe('foreground')
    expect(regionFromText('something unrelated')).toBeNull()
    expect(regionFromInstruction('replace the sky with something more mysterious')).toBe('sky')
    expect(regionFromInstruction('make it moodier but keep the sky')).toBeNull()
  })
})

describe('reference looks', () => {
  it('moves a picture towards the reference’s light and colour, and measurably so', async () => {
    const neutral = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 128, g: 128, b: 128 } } }).composite([{ input: await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer(), left: 60, top: 0 }]).png().toBuffer()
    const warmDark = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 120, g: 70, b: 30 } } }).composite([{ input: await sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 200, g: 130, b: 60 } } }).png().toBuffer(), left: 60, top: 0 }]).png().toBuffer()
    const ref = await lookStats(warmDark)
    const own = await lookStats(neutral)
    expect(ref.b.mean).toBeGreaterThan(own.b.mean + 20)
    const moved = await transferLook(neutral, ref, ['atmosphere'], 0.8)
    const after = await lookStats(moved)
    expect(after.b.mean).toBeGreaterThan(own.b.mean + 12)
    expect(Math.abs(after.b.mean - ref.b.mean)).toBeLessThan(Math.abs(own.b.mean - ref.b.mean))
    expect(Math.abs(after.l.mean - ref.l.mean)).toBeLessThan(Math.abs(own.l.mean - ref.l.mean))
    // Colour alone must not change the light much; lighting alone must not add colour.
    const colourOnly = await lookStats(await transferLook(neutral, ref, ['colour'], 0.8))
    expect(Math.abs(colourOnly.l.mean - own.l.mean)).toBeLessThan(6)
    const lightOnly = await lookStats(await transferLook(neutral, ref, ['lighting'], 0.8))
    expect(Math.abs(lightOnly.b.mean - own.b.mean)).toBeLessThan(3)
    // The structure stays: the bright half is still the brighter half.
    const raw = await sharp(moved).raw().toBuffer()
    expect(raw[100 * 3]!).toBeGreaterThan(raw[10 * 3]!)
    expect(describeLook(ref)).toMatch(/warm/)
  })

  it('averages several references into one look', () => {
    const a = { l: { mean: 30, std: 10, p5: 5, p95: 60 }, a: { mean: 0, std: 5 }, b: { mean: 10, std: 5 } }
    const b = { l: { mean: 70, std: 20, p5: 15, p95: 90 }, a: { mean: 10, std: 9 }, b: { mean: -10, std: 7 } }
    const merged = mergeStats([a, b])
    expect(merged.l.mean).toBe(50)
    expect(merged.b.mean).toBe(0)
    expect(() => mergeStats([])).toThrow()
  })
})

describe('reading an edit request', () => {
  it('understands levels, counts and what is wanted', () => {
    expect(levelFromText('a subtle polish please')).toBe('subtle')
    expect(levelFromText('completely reimagine it')).toBe('radical')
    expect(levelFromText('softer light but keep the architecture')).toBe('creative')
    expect(levelFromText('hello')).toBeNull()
    expect(countFromText('try three artistic interpretations')).toBe(3)
    expect(countFromText('give me 2 versions')).toBe(2)
    expect(countFromText('make it warmer')).toBeNull()
    expect(imagePromptFromInstruction('Replace the sky with something more mysterious')).toBe('mysterious, sky')
    expect(imagePromptFromInstruction('Make the lighting softer but keep the architecture unchanged')).toBe('lighting softer')
    expect(imagePromptFromInstruction('Could you make it more dreamy.')).toBe('dreamy')
  })
})

describe('Atlas graphs for the new edits', () => {
  it('levels keep structure at subtle and let go at radical', () => {
    const s = levelParams('subtle', 0.2)
    const c = levelParams('creative', 0.55)
    const r = levelParams('radical', 0.9)
    expect(s.denoise).toBeLessThan(c.denoise)
    expect(c.denoise).toBeLessThan(r.denoise)
    expect(s.hold).toBeGreaterThan(c.hold)
    expect(c.hold).toBeGreaterThan(r.hold)
    expect(r.fill).toBe(true)
    expect(s.fill).toBe(false)
  })

  it('an inpainting graph repaints inside the mask and composites over the original', () => {
    const g = inpaintWorkflow({ checkpoint: 'a.safetensors', image: 'p.png', mask: 'm.png', prompt: 'x', negative: 'y', seed: 1, width: 512, height: 384, denoise: 0.5, fill: false, tile: 'tile.safetensors', hold: 0.8 })
    const kinds = Object.values(g).map((n) => n.class_type)
    expect(kinds).toContain('SetLatentNoiseMask')
    expect(kinds).toContain('ControlNetApplyAdvanced')
    expect(kinds).toContain('ImageCompositeMasked')
    expect(kinds).not.toContain('VAEEncodeForInpaint')
    const fill = inpaintWorkflow({ checkpoint: 'a.safetensors', image: 'p.png', mask: 'm.png', prompt: 'x', negative: 'y', seed: 1, width: 512, height: 384, denoise: 0.5, fill: true, tile: 'tile.safetensors' })
    const fillKinds = Object.values(fill).map((n) => n.class_type)
    expect(fillKinds).toContain('VAEEncodeForInpaint')
    expect(fillKinds).not.toContain('ControlNetApplyAdvanced')
    expect((fill['5']!.inputs as Record<string, unknown>).denoise).toBe(1)
  })

  it('the detail pass suits the subject', () => {
    expect(subjectFromText('a forest with moss')).toBe('vegetation')
    expect(subjectFromText('portrait of a woman')).toBe('faces')
    expect(subjectFromText('old stone cathedral')).toBe('architecture')
    expect(subjectFromText('nothing special')).toBe('general')
    expect(detailSettings('faces').denoise).toBeLessThan(detailSettings('vegetation').denoise)
    expect(detailSettings('architecture').negative).toMatch(/warped lines/)
  })
})
