import sharp from '../safeSharp'
import { decodeRgb, type RegionMask } from './regions'

// Retouching that needs no generative model.
//
//  * blurThroughMask: softens the painted part. Plain mode is a Gaussian blur; edge-aware mode is a guided filter that
//    smooths what lies between strong edges (skin-like surfaces, artificial texture, noise) and keeps the edges.
//  * fillFromSurroundings: content-aware removal. Exemplar-based inpainting (Criminisi et al., in a simplified form):
//    the hole is filled from the outside in, each time by copying the patch from the rest of the picture that best matches
//    what is already known around the front, so structure and texture continue into the hole. Grain is matched afterwards.
//
// Both return a full-size picture that equals the original outside the work area; the caller lays it over the original
// through the soft mask, so everything outside the selection stays exactly as it was.

export interface Box { x0: number; y0: number; x1: number; y1: number }

/** The smallest box around everything the mask touches (soft part included), grown by `pad`. */
export function maskBox(mask: RegionMask, pad: number): Box | null {
  const { width, height, soft } = mask
  let x0 = width, y0 = height, x1 = -1, y1 = -1
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      if (soft[row + x]! > 0) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  return { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(width - 1, x1 + pad), y1: Math.min(height - 1, y1 + pad) }
}

/** Grows (or, with a negative radius, shrinks) a hard mask by a round-ish amount of pixels. */
export function dilate(hard: Buffer, width: number, height: number, radius: number): Buffer {
  if (radius <= 0) return Buffer.from(hard)
  let cur = Buffer.from(hard)
  for (let pass = 0; pass < radius; pass += 1) {
    const next = Buffer.from(cur)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x
        if (cur[i]) continue
        if ((x > 0 && cur[i - 1]) || (x < width - 1 && cur[i + 1]) || (y > 0 && cur[i - width]) || (y < height - 1 && cur[i + width])) next[i] = 255
      }
    }
    cur = next
  }
  return cur
}

// ---- blur ---------------------------------------------------------------------------------------------------------------

/** Blur radius in pixels for a strength from 0 to 1 on a picture of the given size. */
export function blurSigma(strength: number, width: number, height: number): number {
  const long = Math.max(width, height)
  const s = Math.max(0, Math.min(1, strength))
  return 0.6 + s ** 1.3 * Math.max(2, long * 0.012)
}

/** Box mean of a plane with an integral image; edges use the part of the window that is inside. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const iw = w + 1
  const integral = new Float64Array(iw * (h + 1))
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0
    for (let x = 0; x < w; x += 1) {
      rowSum += src[y * w + x]!
      integral[(y + 1) * iw + x + 1] = integral[y * iw + x + 1]! + rowSum
    }
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y += 1) {
    const ya = Math.max(0, y - r)
    const yb = Math.min(h, y + r + 1)
    for (let x = 0; x < w; x += 1) {
      const xa = Math.max(0, x - r)
      const xb = Math.min(w, x + r + 1)
      const sum = integral[yb * iw + xb]! - integral[ya * iw + xb]! - integral[yb * iw + xa]! + integral[ya * iw + xa]!
      out[y * w + x] = sum / ((xb - xa) * (yb - ya))
    }
  }
  return out
}

/** Guided filter (He et al.) with the picture's own brightness as the guide: smooths flat and fine-textured areas, keeps strong edges. */
function guidedFilter(rgb: Buffer, w: number, h: number, r: number, eps: number): Buffer {
  const n = w * h
  const guide = new Float32Array(n)
  for (let i = 0; i < n; i += 1) guide[i] = (0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!) / 255
  const meanI = boxMean(guide, w, h, r)
  const ii = new Float32Array(n)
  for (let i = 0; i < n; i += 1) ii[i] = guide[i]! * guide[i]!
  const meanII = boxMean(ii, w, h, r)
  const varI = new Float32Array(n)
  for (let i = 0; i < n; i += 1) varI[i] = meanII[i]! - meanI[i]! * meanI[i]!
  const out = Buffer.alloc(n * 3)
  const plane = new Float32Array(n)
  const ip = new Float32Array(n)
  for (let c = 0; c < 3; c += 1) {
    for (let i = 0; i < n; i += 1) { plane[i] = rgb[i * 3 + c]! / 255; ip[i] = guide[i]! * plane[i]! }
    const meanP = boxMean(plane, w, h, r)
    const meanIP = boxMean(ip, w, h, r)
    const a = new Float32Array(n)
    const b = new Float32Array(n)
    for (let i = 0; i < n; i += 1) {
      const cov = meanIP[i]! - meanI[i]! * meanP[i]!
      a[i] = cov / (varI[i]! + eps)
      b[i] = meanP[i]! - a[i]! * meanI[i]!
    }
    const meanA = boxMean(a, w, h, r)
    const meanB = boxMean(b, w, h, r)
    for (let i = 0; i < n; i += 1) {
      const v = meanA[i]! * guide[i]! + meanB[i]!
      out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(v * 255)))
    }
  }
  return out
}

/** Tuning of the edge-aware blur: the window grows with strength and picture size; eps decides what still counts as an edge. */
export const EDGE_AWARE = { divisor: 160, epsBase: 0.0015, epsRange: 0.004 }

export interface BlurOptions { strength: number; edgeAware: boolean }

/**
 * Returns the original with a softened version in the work area. Only the area around the mask is processed, so a small
 * brush mark on a large picture stays quick.
 */
export async function blurredCopy(original: Buffer, mask: RegionMask, options: BlurOptions): Promise<Buffer> {
  const { width, height } = mask
  const sigma = blurSigma(options.strength, width, height)
  const pad = Math.ceil(sigma * 3) + 4
  const box = maskBox(mask, pad)
  const base = await decodeRgb(original)
  if (!box) return sharp(base, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
  const bw = box.x1 - box.x0 + 1
  const bh = box.y1 - box.y0 + 1
  const crop = Buffer.alloc(bw * bh * 3)
  for (let y = 0; y < bh; y += 1) base.copy(crop, y * bw * 3, ((box.y0 + y) * width + box.x0) * 3, ((box.y0 + y) * width + box.x0 + bw) * 3)
  let softened: Buffer
  if (options.edgeAware) {
    // The window grows with the strength; eps decides what still counts as an edge (small = more edges are kept).
    // A narrow window and a low edge threshold: thin high-contrast lines (hair, lashes, outlines) must survive, while the
    // fine texture between them is smoothed.
    const r = Math.max(2, Math.round(1.5 + options.strength * Math.max(width, height) / EDGE_AWARE.divisor))
    const eps = EDGE_AWARE.epsBase + (1 - options.strength) * EDGE_AWARE.epsRange
    softened = guidedFilter(crop, bw, bh, r, eps)
    if (options.strength > 0.8) softened = guidedFilter(softened, bw, bh, r, eps)
  } else {
    softened = await sharp(crop, { raw: { width: bw, height: bh, channels: 3 } }).blur(Math.max(0.3, sigma)).raw().toBuffer()
  }
  const out = Buffer.from(base)
  for (let y = 0; y < bh; y += 1) softened.copy(out, ((box.y0 + y) * width + box.x0) * 3, y * bw * 3, (y + 1) * bw * 3)
  return sharp(out, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
}

// ---- remove (content-aware fill) ------------------------------------------------------------------------------------

const PATCH = 4 // radius: 9 x 9 patches

/** Small deterministic random numbers so the same painting gives the same result. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/**
 * Fills the unknown pixels of a small RGB picture by exemplar-based inpainting. `unknown` is 1 where the picture must be
 * rebuilt. Works in place on `rgb` (Float32, 3 values per pixel).
 */
export function exemplarFill(rgb: Float32Array, unknown: Uint8Array, w: number, h: number, seed = 7): void {
  const n = w * h
  const known = new Uint8Array(n)
  const conf = new Float32Array(n)
  let remaining = 0
  for (let i = 0; i < n; i += 1) {
    known[i] = unknown[i] ? 0 : 1
    conf[i] = known[i]!
    if (!known[i]) remaining += 1
  }
  if (remaining === 0) return
  const random = rng(seed)
  // Source patches: centres where the whole patch is known and inside the picture.
  const fullyKnown = (cx: number, cy: number): boolean => {
    if (cx < PATCH || cy < PATCH || cx >= w - PATCH || cy >= h - PATCH) return false
    for (let dy = -PATCH; dy <= PATCH; dy += 1) for (let dx = -PATCH; dx <= PATCH; dx += 1) if (!known[(cy + dy) * w + cx + dx]) return false
    return true
  }
  const sources: number[] = []
  for (let y = PATCH; y < h - PATCH; y += 1) for (let x = PATCH; x < w - PATCH; x += 1) if (known[y * w + x] && fullyKnown(x, y)) sources.push(y * w + x)
  if (sources.length === 0) throw new Error('There is too little picture around the painted area to rebuild it from. Paint a smaller area.')
  const MAX_RANDOM = 2500
  // The picture's known part never changes during the search, except where earlier patches were filled in (those count as known too, but
  // we keep sources to the original known pixels so errors do not feed on themselves).
  const sourceList = sources.length > MAX_RANDOM ? Array.from({ length: MAX_RANDOM }, () => sources[Math.floor(random() * sources.length)]!) : sources
  const sourceSet = new Uint8Array(n)
  for (const s of sources) sourceSet[s] = 1

  let guard = remaining * 2 + 100
  while (remaining > 0 && guard-- > 0) {
    // The front: unknown pixels that touch a known one. Highest confidence first.
    let best = -1
    let bestScore = -1
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x
        if (known[i]) continue
        if (!((x > 0 && known[i - 1]) || (x < w - 1 && known[i + 1]) || (y > 0 && known[i - w]) || (y < h - 1 && known[i + w]))) continue
        let sum = 0
        for (let dy = -PATCH; dy <= PATCH; dy += 1) {
          const yy = y + dy
          if (yy < 0 || yy >= h) continue
          for (let dx = -PATCH; dx <= PATCH; dx += 1) {
            const xx = x + dx
            if (xx >= 0 && xx < w) sum += conf[yy * w + xx]!
          }
        }
        if (sum > bestScore) { bestScore = sum; best = i }
      }
    }
    if (best < 0) break
    const px = best % w
    const py = (best / w) | 0
    const patchConf = bestScore / ((2 * PATCH + 1) ** 2)
    // Candidates: the random set plus the source pixels nearest to the target (structure usually continues close by).
    const local: number[] = []
    for (let dy = -34; dy <= 34; dy += 2) {
      for (let dx = -34; dx <= 34; dx += 2) {
        const cx = px + dx
        const cy = py + dy
        if (cx >= PATCH && cy >= PATCH && cx < w - PATCH && cy < h - PATCH && sourceSet[cy * w + cx]) local.push(cy * w + cx)
      }
    }
    let bestSrc = -1
    let bestCost = Infinity
    const test = (cand: number): void => {
      const cx = cand % w
      const cy = (cand / w) | 0
      let cost = 0
      for (let dy = -PATCH; dy <= PATCH && cost < bestCost; dy += 1) {
        const ty = py + dy
        if (ty < 0 || ty >= h) continue
        for (let dx = -PATCH; dx <= PATCH; dx += 1) {
          const tx = px + dx
          if (tx < 0 || tx >= w) continue
          const ti = ty * w + tx
          if (!known[ti]) continue
          const si = (cy + dy) * w + cx + dx
          const d0 = rgb[ti * 3]! - rgb[si * 3]!
          const d1 = rgb[ti * 3 + 1]! - rgb[si * 3 + 1]!
          const d2 = rgb[ti * 3 + 2]! - rgb[si * 3 + 2]!
          cost += d0 * d0 + d1 * d1 + d2 * d2
        }
      }
      if (cost < bestCost) { bestCost = cost; bestSrc = cand }
    }
    for (const c of local) test(c)
    for (const c of sourceList) test(c)
    if (bestSrc < 0) break
    const sx = bestSrc % w
    const sy = (bestSrc / w) | 0
    for (let dy = -PATCH; dy <= PATCH; dy += 1) {
      const ty = py + dy
      if (ty < 0 || ty >= h) continue
      for (let dx = -PATCH; dx <= PATCH; dx += 1) {
        const tx = px + dx
        if (tx < 0 || tx >= w) continue
        const ti = ty * w + tx
        if (known[ti]) continue
        const si = (sy + dy) * w + sx + dx
        rgb[ti * 3] = rgb[si * 3]!
        rgb[ti * 3 + 1] = rgb[si * 3 + 1]!
        rgb[ti * 3 + 2] = rgb[si * 3 + 2]!
        known[ti] = 1
        conf[ti] = patchConf
        remaining -= 1
      }
    }
  }
}

/**
 * Makes a rough fill coherent: PatchMatch finds, for every patch that touches the hole, the most similar patch of known
 * picture, and then every hole pixel takes the average of what all the patches covering it say (Wexler et al.). A few
 * rounds remove the seams and blocks that copying whole patches leaves, and let the texture continue. Works in place.
 */
export function refineByPatchVoting(rgb: Float32Array, unknown: Uint8Array, w: number, h: number, iterations = 6, seed = 11, copyLast = 0): void {
  const R = 3
  const n = w * h
  if (w < 2 * R + 2 || h < 2 * R + 2) return
  const integral = new Int32Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y += 1) {
    let row = 0
    for (let x = 0; x < w; x += 1) {
      row += unknown[y * w + x]!
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1]! + row
    }
  }
  const unknownIn = (cx: number, cy: number): number => {
    const x0 = cx - R
    const y0 = cy - R
    const x1 = cx + R + 1
    const y1 = cy + R + 1
    return integral[y1 * (w + 1) + x1]! - integral[y0 * (w + 1) + x1]! - integral[y1 * (w + 1) + x0]! + integral[y0 * (w + 1) + x0]!
  }
  const okSource = new Uint8Array(n)
  const sources: number[] = []
  const targets: number[] = []
  for (let cy = R; cy < h - R; cy += 1) {
    for (let cx = R; cx < w - R; cx += 1) {
      const u = unknownIn(cx, cy)
      if (u === 0) { okSource[cy * w + cx] = 1; sources.push(cy * w + cx) } else targets.push(cy * w + cx)
    }
  }
  if (sources.length === 0 || targets.length === 0) return
  const random = rng(seed)
  const nn = new Int32Array(n).fill(-1)
  const cost = new Float32Array(n)
  const ssd = (t: number, s: number, limit: number): number => {
    const tx = t % w
    const ty = (t / w) | 0
    const sx = s % w
    const sy = (s / w) | 0
    let sum = 0
    for (let dy = -R; dy <= R; dy += 1) {
      const to = ((ty + dy) * w + tx - R) * 3
      const so = ((sy + dy) * w + sx - R) * 3
      for (let k = 0; k < (2 * R + 1) * 3; k += 1) {
        const d = rgb[to + k]! - rgb[so + k]!
        sum += d * d
      }
      if (sum >= limit) return sum
    }
    return sum
  }
  for (const t of targets) nn[t] = sources[Math.floor(random() * sources.length)]!
  const voteR = new Float32Array(n * 3)
  const voteW = new Float32Array(n)
  for (let it = 0; it < iterations; it += 1) {
    for (const t of targets) cost[t] = ssd(t, nn[t]!, Infinity)
    const forward = it % 2 === 0
    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[forward ? i : targets.length - 1 - i]!
      const tx = t % w
      const ty = (t / w) | 0
      const tryCandidate = (sx: number, sy: number): void => {
        if (sx < R || sy < R || sx >= w - R || sy >= h - R) return
        const s = sy * w + sx
        if (!okSource[s]) return
        const c = ssd(t, s, cost[t]!)
        if (c < cost[t]!) { cost[t] = c; nn[t] = s }
      }
      // Propagation: a neighbour's match, shifted by the step between us.
      const dx = forward ? -1 : 1
      const nx = tx + dx
      if (nx >= R && nx < w - R && nn[ty * w + nx]! >= 0) { const s = nn[ty * w + nx]!; tryCandidate((s % w) - dx, (s / w) | 0) }
      const ny = ty + dx
      if (ny >= R && ny < h - R && nn[ny * w + tx]! >= 0) { const s = nn[ny * w + tx]!; tryCandidate(s % w, ((s / w) | 0) - dx) }
      // Random search around the current match, shrinking.
      const cur = nn[t]!
      const cx = cur % w
      const cy = (cur / w) | 0
      for (let r = Math.max(w, h) / 2; r >= 1; r /= 2) tryCandidate(Math.round(cx + (random() * 2 - 1) * r), Math.round(cy + (random() * 2 - 1) * r))
    }
    // The last rounds copy: every hole pixel takes the centre pixel of its best patch instead of an average. Averaging overlapping
    // patches blurs fine, regular texture (cloth, weave, fur) into a smudge; copying keeps real threads, real grain and the
    // pattern's rhythm, because the match field is coherent (neighbouring pixels copy from neighbouring places).
    if (it >= iterations - copyLast) {
      for (const t of targets) {
        if (!unknown[t]) continue
        const s = nn[t]!
        rgb[t * 3] = rgb[s * 3]!
        rgb[t * 3 + 1] = rgb[s * 3 + 1]!
        rgb[t * 3 + 2] = rgb[s * 3 + 2]!
      }
      continue
    }
    // Vote: every hole pixel becomes the average of what the patches over it contain.
    voteR.fill(0)
    voteW.fill(0)
    for (const t of targets) {
      const tx = t % w
      const ty = (t / w) | 0
      const s = nn[t]!
      const sx = s % w
      const sy = (s / w) | 0
      for (let dy = -R; dy <= R; dy += 1) {
        for (let dx2 = -R; dx2 <= R; dx2 += 1) {
          const p = (ty + dy) * w + tx + dx2
          if (!unknown[p]) continue
          const q = ((sy + dy) * w + sx + dx2) * 3
          voteR[p * 3] = voteR[p * 3]! + rgb[q]!
          voteR[p * 3 + 1] = voteR[p * 3 + 1]! + rgb[q + 1]!
          voteR[p * 3 + 2] = voteR[p * 3 + 2]! + rgb[q + 2]!
          voteW[p] = voteW[p]! + 1
        }
      }
    }
    for (let p = 0; p < n; p += 1) {
      if (!unknown[p] || voteW[p]! === 0) continue
      rgb[p * 3] = voteR[p * 3]! / voteW[p]!
      rgb[p * 3 + 1] = voteR[p * 3 + 1]! / voteW[p]!
      rgb[p * 3 + 2] = voteR[p * 3 + 2]! / voteW[p]!
    }
  }
}

export interface FillResult {
  png: Buffer
  /** The mask that was actually rebuilt (the painted one, grown a little), to lay the result over the original through. */
  mask: RegionMask
  note: string
}

/**
 * Rebuilds the masked area from its surroundings. The mask is grown a little so halos and soft edges of the unwanted
 * thing are rebuilt too. Returns the original with only the work area replaced.
 */
export async function fillFromSurroundings(original: Buffer, mask: RegionMask, reach: number, contextScale = 0.9): Promise<FillResult> {
  const { width, height } = mask
  const long = Math.max(width, height)
  const grow = Math.max(1, Math.round(long * (0.002 + Math.max(0, Math.min(1, reach)) * 0.01)))
  const hard = dilate(mask.hard, width, height, grow)
  const feather = Math.max(1, grow * 0.6)
  // The blend zone lies OUTSIDE the rebuilt area: it is grown first, so everything that was rebuilt is used at full strength.
  // (Blurring the rebuilt area itself lets a few percent of the original through at the middle of a small mark: a faint ghost of a defect.)
  const reachOut = Math.max(1, Math.min(grow, Math.ceil(feather * 2)))
  const blendBase = dilate(hard, width, height, reachOut)
  const soft = await sharp(blendBase, { raw: { width, height, channels: 1 } }).blur(Math.max(0.5, feather)).extractChannel(0).raw().toBuffer()
  const usedMask: RegionMask = { ...mask, hard, soft }
  const holeBox = maskBox({ ...mask, hard, soft: hard }, 0)
  if (!holeBox) throw new Error('The selected area is empty. Paint over what you want to remove.')
  const holeW = holeBox.x1 - holeBox.x0 + 1
  const holeH = holeBox.y1 - holeBox.y0 + 1
  // Context around the hole to learn from: generous for big holes, never less than a few patches.
  const context = Math.max(24, Math.round(Math.max(holeW, holeH) * contextScale))
  const box = { x0: Math.max(0, holeBox.x0 - context), y0: Math.max(0, holeBox.y0 - context), x1: Math.min(width - 1, holeBox.x1 + context), y1: Math.min(height - 1, holeBox.y1 + context) }
  const bw = box.x1 - box.x0 + 1
  const bh = box.y1 - box.y0 + 1
  const base = await decodeRgb(original)
  const crop = Buffer.alloc(bw * bh * 3)
  const cropMask = Buffer.alloc(bw * bh)
  for (let y = 0; y < bh; y += 1) {
    base.copy(crop, y * bw * 3, ((box.y0 + y) * width + box.x0) * 3, ((box.y0 + y) * width + box.x0 + bw) * 3)
    hard.copy(cropMask, y * bw, (box.y0 + y) * width + box.x0, (box.y0 + y) * width + box.x0 + bw)
  }
  // Work at a size the search can afford; small holes are worked at full resolution.
  const WORK = 300
  const scale = Math.min(1, WORK / Math.max(bw, bh))
  const ww = Math.max(2 * PATCH + 2, Math.round(bw * scale))
  const wh = Math.max(2 * PATCH + 2, Math.round(bh * scale))
  const small = scale < 1 ? await sharp(crop, { raw: { width: bw, height: bh, channels: 3 } }).resize(ww, wh, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer() : crop
  const smallMaskRaw = scale < 1 ? await sharp(cropMask, { raw: { width: bw, height: bh, channels: 1 } }).resize(ww, wh, { fit: 'fill', kernel: 'nearest' }).extractChannel(0).raw().toBuffer() : cropMask
  const rgb = new Float32Array(ww * wh * 3)
  const unknown = new Uint8Array(ww * wh)
  let holes = 0
  for (let i = 0; i < ww * wh; i += 1) {
    rgb[i * 3] = small[i * 3]!
    rgb[i * 3 + 1] = small[i * 3 + 1]!
    rgb[i * 3 + 2] = small[i * 3 + 2]!
    if (smallMaskRaw[i]! > 127) { unknown[i] = 1; holes += 1 }
  }
  if (holes / (ww * wh) > 0.7) throw new Error('That area is too large to rebuild from what is left around it. Paint a smaller part, or use ComfyUI inpainting.')
  exemplarFill(rgb, unknown, ww, wh)
  // Small and medium areas end with copying (sharp, real texture); very large ones keep averaging, which is smoother and calmer.
  const copying = holes <= 40000 ? 2 : 0
  refineByPatchVoting(rgb, unknown, ww, wh, holes > 30000 ? 3 : 7, 11, copying)
  const filledSmall = Buffer.alloc(ww * wh * 3)
  for (let i = 0; i < filledSmall.length; i += 1) filledSmall[i] = Math.max(0, Math.min(255, Math.round(rgb[i]!)))
  // Back to full size. Known pixels keep their original values; only the hole takes the rebuilt ones.
  const filled = scale < 1 ? await sharp(filledSmall, { raw: { width: ww, height: wh, channels: 3 } }).resize(bw, bh, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer() : filledSmall
  // Grain: the rebuilt area should not be smoother than its surroundings. Measure the fine noise outside the hole and add the same.
  const ring = Buffer.from(crop)
  const smooth = await sharp(ring, { raw: { width: bw, height: bh, channels: 3 } }).blur(1.2).raw().toBuffer()
  let sum = 0
  let count = 0
  for (let i = 0; i < bw * bh; i += 1) {
    if (cropMask[i]) continue
    for (let c = 0; c < 3; c += 1) { const d = ring[i * 3 + c]! - smooth[i * 3 + c]!; sum += d * d }
    count += 3
  }
  const grain = count > 0 ? Math.sqrt(sum / count) : 0
  const noise = rng(1234)
  const gauss = (): number => Math.sqrt(-2 * Math.log(noise() || 1e-9)) * Math.cos(2 * Math.PI * noise())
  const out = Buffer.from(base)
  // Averaging patches smooths a little, so the surrounding grain is put back; copied pixels already carry their own real grain.
  const rebuilt = copying > 0 ? 0 : grain * (scale < 1 ? 0.8 : 0.6)
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const ci = y * bw + x
      if (!cropMask[ci]) continue
      const o = ((box.y0 + y) * width + box.x0 + x) * 3
      const n0 = rebuilt * gauss()
      for (let c = 0; c < 3; c += 1) out[o + c] = Math.max(0, Math.min(255, Math.round(filled[ci * 3 + c]! + n0)))
    }
  }
  const png = await sharp(out, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
  return { png, mask: usedMask, note: `${Math.round((holes / (ww * wh)) * 100)}% of the working area was rebuilt from its surroundings${scale < 1 ? ` (worked at ${ww}×${wh} and enlarged, with the surrounding grain added)` : ' at full resolution'}.` }
}

// ---- shared helpers for the tone tools ---------------------------------------------------------------------------------

/** Separable Gaussian blur of one float plane. Edges repeat the nearest pixel. */
export function gaussBlurPlane(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return Float32Array.from(src)
  // A wide blur only keeps the slow changes, so it can be done on a smaller copy: much faster, the same look.
  const f = Math.floor(sigma / 3)
  if (f >= 2 && w >= 4 * f && h >= 4 * f) {
    const sw = Math.ceil(w / f)
    const sh = Math.ceil(h / f)
    const small = new Float32Array(sw * sh)
    const count = new Float32Array(sw * sh)
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const i = Math.floor(y / f) * sw + Math.floor(x / f); small[i] = small[i]! + src[y * w + x]!; count[i] = count[i]! + 1 }
    for (let i = 0; i < small.length; i += 1) small[i] = small[i]! / Math.max(1, count[i]!)
    const blurred = gaussBlurPlane(small, sw, sh, sigma / f)
    const out = new Float32Array(w * h)
    for (let y = 0; y < h; y += 1) {
      const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5))
      const y0 = Math.floor(fy)
      const y1 = Math.min(sh - 1, y0 + 1)
      const ty = fy - y0
      for (let x = 0; x < w; x += 1) {
        const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5))
        const x0 = Math.floor(fx)
        const x1 = Math.min(sw - 1, x0 + 1)
        const tx = fx - x0
        out[y * w + x] = (blurred[y0 * sw + x0]! * (1 - tx) + blurred[y0 * sw + x1]! * tx) * (1 - ty) + (blurred[y1 * sw + x0]! * (1 - tx) + blurred[y1 * sw + x1]! * tx) * ty
      }
    }
    return out
  }
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float32Array(2 * r + 1)
  let total = 0
  for (let i = -r; i <= r; i += 1) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); total += k[i + r]! }
  for (let i = 0; i < k.length; i += 1) k[i] = k[i]! / total
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y += 1) {
    const row = y * w
    for (let x = 0; x < w; x += 1) {
      let acc = 0
      for (let i = -r; i <= r; i += 1) acc += src[row + Math.min(w - 1, Math.max(0, x + i))]! * k[i + r]!
      tmp[row + x] = acc
    }
  }
  const out = new Float32Array(w * h)
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) {
      let acc = 0
      for (let i = -r; i <= r; i += 1) acc += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x]! * k[i + r]!
      out[y * w + x] = acc
    }
  }
  return out
}

interface Crop { box: Box; w: number; h: number; rgb: Buffer; full: Buffer; width: number; height: number }

/** The work area around a mask, as raw RGB, plus the whole picture so the result can be put back. */
async function cropAround(original: Buffer, mask: RegionMask, pad: number): Promise<Crop | null> {
  const { width, height } = mask
  const box = maskBox(mask, pad)
  if (!box) return null
  const full = await decodeRgb(original)
  const w = box.x1 - box.x0 + 1
  const h = box.y1 - box.y0 + 1
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y += 1) full.copy(rgb, y * w * 3, ((box.y0 + y) * width + box.x0) * 3, ((box.y0 + y) * width + box.x0 + w) * 3)
  return { box, w, h, rgb, full, width, height }
}

async function putBack(crop: Crop, edited: Buffer): Promise<Buffer> {
  const out = Buffer.from(crop.full)
  for (let y = 0; y < crop.h; y += 1) edited.copy(out, ((crop.box.y0 + y) * crop.width + crop.box.x0) * 3, y * crop.w * 3, (y + 1) * crop.w * 3)
  return sharp(out, { raw: { width: crop.width, height: crop.height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

// ---- sharpen ------------------------------------------------------------------------------------------------------------

/** Strength 0 to 1 as unsharp-mask amount and detail scale (in pixels) for a picture of this size. */
export function sharpenSettings(strength: number, width: number, height: number): { amount: number; sigma: number } {
  const s = Math.max(0, Math.min(1, strength))
  return { amount: 0.25 + s * 1.5, sigma: Math.max(0.7, Math.max(width, height) * 0.0011) }
}

/**
 * Brings back detail without the usual damage: the detail layer is cored (noise-sized detail is not amplified), applied
 * to brightness only (no colour fringes) and limited to the local range (no halos along edges).
 */
export async function sharpenedCopy(original: Buffer, mask: RegionMask, strength: number): Promise<Buffer> {
  const { amount, sigma } = sharpenSettings(strength, mask.width, mask.height)
  const pad = Math.ceil(sigma * 3) + 6
  const crop = await cropAround(original, mask, pad)
  if (!crop) return sharp(original).png({ compressionLevel: 0 }).toBuffer()
  const { w, h, rgb } = crop
  const n = w * h
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i += 1) luma[i] = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!
  const blurred = gaussBlurPlane(luma, w, h, sigma)
  // Noise floor from the quieter part of the detail layer: what is that small is grain, not detail.
  const mags: number[] = []
  for (let i = 0; i < n; i += 7) mags.push(Math.abs(luma[i]! - blurred[i]!))
  mags.sort((a, b) => a - b)
  const floor = (mags[Math.floor(mags.length * 0.4)] ?? 0) * 1.4
  // Local range for the halo limit.
  const lo = new Float32Array(n)
  const hi = new Float32Array(n)
  const win = 2
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let mn = 255
      let mx = 0
      for (let dy = -win; dy <= win; dy += 1) {
        const yy = Math.min(h - 1, Math.max(0, y + dy))
        for (let dx = -win; dx <= win; dx += 1) {
          const v = luma[yy * w + Math.min(w - 1, Math.max(0, x + dx))]!
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
      }
      lo[y * w + x] = mn
      hi[y * w + x] = mx
    }
  }
  const out = Buffer.alloc(n * 3)
  for (let i = 0; i < n; i += 1) {
    const d = luma[i]! - blurred[i]!
    const mag = Math.abs(d)
    const cored = mag <= floor ? 0 : Math.sign(d) * (mag - floor)
    let target = luma[i]! + amount * cored
    target = Math.max(lo[i]! - 2, Math.min(hi[i]! + 2, target))
    const delta = target - luma[i]!
    out[i * 3] = clampByte(rgb[i * 3]! + delta)
    out[i * 3 + 1] = clampByte(rgb[i * 3 + 1]! + delta)
    out[i * 3 + 2] = clampByte(rgb[i * 3 + 2]! + delta)
  }
  return putBack(crop, out)
}

// ---- dodge and burn -------------------------------------------------------------------------------------------------------

/** Exposure change in stops for a strength from 0 to 1. */
export function toneStops(strength: number): number {
  return Math.max(0, Math.min(1, strength)) * 1.3
}

/**
 * Lightens or darkens by bending brightness along a curve that keeps black and white where they are (mid-tones move the
 * most), and scales the colour channels with it so hue does not drift. Where a channel would run out of range the whole
 * pixel is eased back, rather than clipped into another colour.
 */
export async function tonedCopy(original: Buffer, mask: RegionMask, strength: number, direction: 'lighten' | 'darken'): Promise<Buffer> {
  const crop = await cropAround(original, mask, 2)
  if (!crop) return sharp(original).png({ compressionLevel: 0 }).toBuffer()
  const { w, h, rgb } = crop
  const gamma = 2 ** ((direction === 'lighten' ? -1 : 1) * toneStops(strength) * 0.62)
  const out = Buffer.alloc(w * h * 3)
  for (let i = 0; i < w * h; i += 1) {
    const r = rgb[i * 3]! / 255
    const g = rgb[i * 3 + 1]! / 255
    const b = rgb[i * 3 + 2]! / 255
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (y < 1e-4) { out[i * 3] = rgb[i * 3]!; out[i * 3 + 1] = rgb[i * 3 + 1]!; out[i * 3 + 2] = rgb[i * 3 + 2]!; continue }
    const y2 = y ** gamma
    let ratio = y2 / y
    const peak = Math.max(r, g, b) * ratio
    if (peak > 1) ratio /= peak
    out[i * 3] = clampByte(r * ratio * 255)
    out[i * 3 + 1] = clampByte(g * ratio * 255)
    out[i * 3 + 2] = clampByte(b * ratio * 255)
  }
  return putBack(crop, out)
}

// ---- heal -----------------------------------------------------------------------------------------------------------------

/**
 * Repairs a small flaw so it takes on the tone of its surroundings but keeps believable texture: the low frequencies
 * (colour, light) come from the picture around it (a normalised blur of the known pixels, so the flaw does not leak in),
 * the fine texture is a mix of what is already there and texture rebuilt from the surroundings. `texture` 0 keeps the area's
 * own fine detail, 1 replaces it completely.
 */
export async function healedCopy(original: Buffer, mask: RegionMask, texture: number): Promise<{ png: Buffer; mask: RegionMask; note: string }> {
  const { width, height } = mask
  // A flaw is mended from what is right next to it: a narrow context keeps unrelated parts of the picture out of the rebuilt texture.
  const filled = await fillFromSurroundings(original, mask, 0.2, 0.45)
  const used = filled.mask
  const hole = maskBox({ ...used, soft: used.hard }, 0)
  if (!hole) throw new Error('The selected area is empty. Paint over the flaw to repair.')
  const size = Math.max(hole.x1 - hole.x0, hole.y1 - hole.y0) + 1
  const sigma = Math.max(3, Math.min(40, size * 0.2))
  const pad = Math.ceil(sigma * 3) + 4
  const crop = await cropAround(original, { ...used, soft: used.hard }, pad)
  if (!crop) throw new Error('The selected area is empty. Paint over the flaw to repair.')
  const { w, h, box } = crop
  const n = w * h
  const filledFull = await sharp(filled.png).removeAlpha().raw().toBuffer()
  const filledRgb = Buffer.alloc(n * 3)
  for (let y = 0; y < h; y += 1) filledFull.copy(filledRgb, y * w * 3, ((box.y0 + y) * width + box.x0) * 3, ((box.y0 + y) * width + box.x0 + w) * 3)
  const known = new Float32Array(n)
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) known[y * w + x] = used.hard[(box.y0 + y) * width + box.x0 + x] ? 0 : 1
  const kBlur = gaussBlurPlane(known, w, h, sigma)
  const t = Math.max(0, Math.min(1, texture))
  const out = Buffer.from(crop.rgb)
  const planeO = new Float32Array(n)
  const planeF = new Float32Array(n)
  for (let c = 0; c < 3; c += 1) {
    for (let i = 0; i < n; i += 1) { planeO[i] = crop.rgb[i * 3 + c]!; planeF[i] = filledRgb[i * 3 + c]! }
    const masked = new Float32Array(n)
    for (let i = 0; i < n; i += 1) masked[i] = planeO[i]! * known[i]!
    const lowKnown = gaussBlurPlane(masked, w, h, sigma)
    // The area's own texture is only its finest scale (a flaw has structure at larger scales, which must not come back);
    // the rebuilt texture is everything finer than the picture's slow changes.
    const lowO = gaussBlurPlane(planeO, w, h, Math.max(1.5, Math.min(4, size * 0.04)))
    const lowF = gaussBlurPlane(planeF, w, h, sigma)
    // How strong the picture's own fine texture normally is around the flaw: what lies far beyond that is the flaw, not texture.
    let sq = 0
    let nk = 0
    for (let i = 0; i < n; i += 1) {
      if (!known[i]) continue
      const d = planeO[i]! - lowO[i]!
      sq += d * d
      nk += 1
    }
    const sigmaK = Math.sqrt(sq / Math.max(1, nk))
    for (let i = 0; i < n; i += 1) {
      const x = i % w
      const y = (i / w) | 0
      if (!used.hard[(box.y0 + y) * width + box.x0 + x]) continue
      const wk = kBlur[i]!
      // Where too little known picture is within reach, fall back to the rebuilt colour.
      const target = wk > 0.04 ? lowKnown[i]! / wk : lowF[i]!
      const own = planeO[i]! - lowO[i]!
      const rebuilt = planeF[i]! - lowF[i]!
      // The area's own texture counts only where it looks like the cloth around it. A pixel far outside the usual texture (the dark core of a
      // speck, its halo) is always rebuilt, whatever the setting; otherwise "keep 40 %" would keep 40 % of the flaw.
      const normal = Math.exp(-((own / (2.2 * sigmaK + 1e-3)) ** 2))
      const wa = (1 - t) * normal
      const wb = 1 - wa
      // Two different textures mixed lose strength (they do not add up): scale back so the mix is as lively as either.
      const detail = (wa * own + wb * rebuilt) / Math.sqrt(wa * wa + wb * wb)
      out[i * 3 + c] = clampByte(target + detail)
    }
  }
  const png = await putBack(crop, out)
  return { png, mask: used, note: `The flaw takes its colour and light from what surrounds it; ${Math.round(t * 100)}% of its fine texture was rebuilt from the surroundings and ${Math.round((1 - t) * 100)}% kept.` }
}
