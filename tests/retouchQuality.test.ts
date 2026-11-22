import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { fillFromSurroundings, healedCopy } from '../src/main/studio/retouch'
import type { RegionMask } from '../src/main/studio/regions'

// The reported problems: on a detailed woven fabric, Remove replaced a tiny black defect with an obvious blurry round patch, and Heal
// did not take a small black defect out reliably. These tests build a woven cloth, put small defects on it, repair them, and measure
// what a person sees: is the defect gone, is the repair as sharp as its surroundings, and is the texture's pattern continuous?
// The before and after crops are saved for a manual look in .e2e/retouch-quality.
const OUT = resolve('.e2e/retouch-quality')
mkdirSync(OUT, { recursive: true })

const W = 640
const H = 480

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/** A plain-weave cloth: warp and weft threads crossing over and under, each with its own brightness, slight waviness and fibre noise. */
function weave(seed: number, thread = 9): Buffer {
  const r = rng(seed)
  const warp = Array.from({ length: Math.ceil(W / thread) + 2 }, () => 0.82 + r() * 0.3)
  const weft = Array.from({ length: Math.ceil(H / thread) + 2 }, () => 0.82 + r() * 0.3)
  const raw = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const wob = Math.sin(y / 31) * 1.2 + Math.sin(x / 47) * 0.8
      const tx = (x + wob) / thread
      const ty = (y - wob * 0.6) / thread
      const ix = Math.floor(tx)
      const iy = Math.floor(ty)
      const fx = tx - ix
      const fy = ty - iy
      const over = (ix + iy) % 2 === 0 // warp over weft, then weft over warp
      const across = over ? Math.sin(Math.PI * fx) : Math.sin(Math.PI * fy) // round thread profile
      const along = over ? Math.sin(Math.PI * fy) * 0.35 + 0.65 : Math.sin(Math.PI * fx) * 0.35 + 0.65
      const base = (over ? warp[ix]! : weft[iy]!) * (0.45 + 0.55 * across) * along
      const fibre = (r() - 0.5) * 0.12
      const v = Math.max(0, Math.min(1, base * 0.9 + fibre))
      const o = (y * W + x) * 3
      raw[o] = Math.round(v * 150 + 30)
      raw[o + 1] = Math.round(v * 120 + 25)
      raw[o + 2] = Math.round(v * 85 + 20)
    }
  }
  return raw
}

function discMask(cx: number, cy: number, radius: number): RegionMask {
  const hard = Buffer.alloc(W * H)
  for (let y = Math.floor(cy - radius - 2); y <= cy + radius + 2; y += 1) for (let x = Math.floor(cx - radius - 2); x <= cx + radius + 2; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) hard[y * W + x] = 255
  return { width: W, height: H, hard, soft: Buffer.from(hard), coverage: 0, how: 'the marked area' }
}

function defect(raw: Buffer, cx: number, cy: number, radius: number, shade = 8): Buffer {
  const out = Buffer.from(raw)
  for (let y = Math.floor(cy - radius - 5); y <= cy + radius + 5; y += 1) for (let x = Math.floor(cx - radius - 5); x <= cx + radius + 5; x += 1) {
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    if (d > radius + 4) continue
    const k = d <= radius ? 1 : Math.max(0, 0.45 * (1 - (d - radius) / 4)) // a soft, darker halo around the black core
    const o = (y * W + x) * 3
    for (let c = 0; c < 3; c += 1) out[o + c] = Math.round(out[o + c]! * (1 - k) + shade * k)
  }
  return out
}

const png = (raw: Buffer): Promise<Buffer> => sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()
const rawOf = (p: Buffer): Promise<Buffer> => sharp(p).removeAlpha().raw().toBuffer()
const luma = (b: Buffer, i: number): number => 0.299 * b[i * 3]! + 0.587 * b[i * 3 + 1]! + 0.114 * b[i * 3 + 2]!

/** Mean absolute Laplacian of luma over the pixels where `test` is true: how much fine detail a place carries. */
function detailIn(b: Buffer, test: (x: number, y: number) => boolean): number {
  let sum = 0
  let n = 0
  for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) {
    if (!test(x, y)) continue
    const i = y * W + x
    sum += Math.abs(4 * luma(b, i) - luma(b, i - 1) - luma(b, i + 1) - luma(b, i - W) - luma(b, i + W))
    n += 1
  }
  return sum / Math.max(1, n)
}

async function crop(buf: Buffer, cx: number, cy: number, half: number, name: string): Promise<void> {
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).extract({ left: Math.max(0, cx - half), top: Math.max(0, cy - half), width: half * 2, height: half * 2 }).resize({ width: half * 6, kernel: 'nearest' }).png().toFile(join(OUT, name))
}

const cases = [
  { name: 'dot-5', cx: 210, cy: 160, r: 2.5 },
  { name: 'dot-9', cx: 420, cy: 300, r: 4.5 },
  { name: 'dot-14', cx: 300, cy: 380, r: 7 }
]

describe.each([{ label: 'coarse weave', thread: 9 }, { label: 'fine weave', thread: 3.6 }])('repairs on a woven cloth: $label', ({ label, thread }) => {
  const truth = weave(5, thread)
  for (const tool of ['remove', 'heal'] as const) {
    for (const c of cases) {
      it(`${tool}: a ${Math.round(c.r * 2)} px black defect disappears and leaves no visible patch (${c.name}, ${label})`, async () => {
        const damaged = defect(truth, c.cx, c.cy, c.r)
        const before = await png(damaged)
        // The painted area is a little larger than the defect, like a person's brush.
        const mask = discMask(c.cx, c.cy, c.r + 2.5)
        const result = tool === 'remove' ? await fillFromSurroundings(before, mask, 0.4) : await healedCopy(before, mask, 0.6)
        // Lay it through the soft mask, as the application does.
        const out = Buffer.from(damaged)
        const fixed = await rawOf(result.png)
        const soft = result.mask.soft
        for (let i = 0; i < W * H; i += 1) {
          const a = soft[i]! / 255
          if (a <= 0) continue
          for (let k = 0; k < 3; k += 1) out[i * 3 + k] = Math.round(fixed[i * 3 + k]! * a + damaged[i * 3 + k]! * (1 - a))
        }
        await crop(damaged, c.cx, c.cy, 40, `${label.split(" ")[0]}-${tool}-${c.name}-1-before.png`)
        await crop(out, c.cx, c.cy, 40, `${label.split(" ")[0]}-${tool}-${c.name}-2-after.png`)
        await crop(truth, c.cx, c.cy, 40, `${label.split(" ")[0]}-${tool}-${c.name}-3-truth.png`)
        const near = (x: number, y: number, rad: number): boolean => (x - c.cx) ** 2 + (y - c.cy) ** 2 <= rad * rad
        // 1. the defect is gone: nothing inside is darker than the cloth's own darkest shadows around it
        let ringMin = 255
        for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (!near(x, y, c.r + 4) && near(x, y, c.r + 30)) ringMin = Math.min(ringMin, luma(out, y * W + x))
        let inMin = 255
        for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (near(x, y, c.r + 1)) inMin = Math.min(inMin, luma(out, y * W + x))
        // 2. no blurry patch: the repaired area carries about as much fine detail as the cloth around it
        const ringDetail = detailIn(out, (x, y) => !near(x, y, c.r + 8) && near(x, y, c.r + 40))
        const holeDetail = detailIn(out, (x, y) => near(x, y, c.r + 1))
        const ratio = holeDetail / ringDetail
        // 3. how close the repair is to what the cloth really was under the defect (mean error and bias, inside the defect)
        let err = 0
        let bias = 0
        let count = 0
        for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (near(x, y, c.r + 1)) { const i = y * W + x; err += Math.abs(luma(out, i) - luma(truth, i)); bias += luma(out, i) - luma(truth, i); count += 1 }
        err /= count
        bias /= count
        console.log(`${tool} ${c.name}: darkest inside ${inMin.toFixed(0)} vs around ${ringMin.toFixed(0)}; detail ratio ${ratio.toFixed(2)}; error vs the real cloth ${err.toFixed(1)}, bias ${bias.toFixed(1)}`)
        expect(inMin, 'the black defect is still there').toBeGreaterThan(ringMin - 4)
        expect(ratio, 'the repair is blurrier than its surroundings').toBeGreaterThan(0.85)
        expect(ratio, 'the repair is noisier than its surroundings').toBeLessThan(1.4)
        expect(err, 'the repair is far from what the cloth really was').toBeLessThan(14)
        expect(Math.abs(bias), 'the repair is visibly lighter or darker than the cloth').toBeLessThan(9)
        writeFileSync(join(OUT, `${label.split(" ")[0]}-${tool}-${c.name}.txt`), `${inMin.toFixed(1)} ${ringMin.toFixed(1)} ${ratio.toFixed(2)} err=${err.toFixed(1)} bias=${bias.toFixed(1)}`)
      }, 60_000)
    }
  }
})
