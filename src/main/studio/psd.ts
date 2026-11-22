import { promises as fs } from 'node:fs'
import { inflateSync } from 'node:zlib'

// A small reader for the flattened picture inside a Photoshop file (.psd, .psb). Every Photoshop file carries a
// composite of all its layers after the layer data; that is what Atlas imports. Layers are not read (they stay in the
// user's own file). Supports 8 and 16 bit RGB and grey, with or without transparency, raw, RLE and zip compression.

export interface PsdPicture {
  width: number
  height: number
  channels: 3 | 4
  /** 8-bit RGB(A), interleaved. */
  data: Buffer
}

export class PsdError extends Error {}

/** True for the file types that are read here rather than by the image library. */
export function isPsdPath(path: string): boolean {
  return /\.(psd|psb)$/i.test(path)
}

export async function readPsdComposite(path: string): Promise<PsdPicture> {
  const file = await fs.readFile(path)
  return parsePsd(file)
}

export function parsePsd(file: Buffer): PsdPicture {
  if (file.length < 30 || file.toString('latin1', 0, 4) !== '8BPS') throw new PsdError('This is not a Photoshop file.')
  const version = file.readUInt16BE(4)
  if (version !== 1 && version !== 2) throw new PsdError('This Photoshop file has a version Atlas does not know.')
  const big = version === 2
  const channelCount = file.readUInt16BE(12)
  const height = file.readUInt32BE(14)
  const width = file.readUInt32BE(18)
  const depth = file.readUInt16BE(22)
  const mode = file.readUInt16BE(24)
  if (width < 1 || height < 1 || width * height > 400_000_000) throw new PsdError('The size of this Photoshop file is not supported.')
  if (depth !== 8 && depth !== 16) throw new PsdError(`Atlas reads 8 and 16 bit Photoshop files; this one is ${depth} bit. Use File › Export › Export As… to save a PNG instead.`)
  if (mode !== 3 && mode !== 1) throw new PsdError('Atlas reads RGB and grey Photoshop files. Convert it to RGB (Image › Mode) or export a PNG.')
  let p = 26
  const skip = (long: boolean): void => {
    const len = long ? Number(file.readBigUInt64BE(p)) : file.readUInt32BE(p)
    p += (long ? 8 : 4) + len
  }
  skip(false) // colour mode data
  skip(false) // image resources
  skip(big) //   layer and mask information
  if (p + 2 > file.length) throw new PsdError('This Photoshop file has no flattened picture. Save it with “Maximize Compatibility”, or export a PNG.')
  const compression = file.readUInt16BE(p)
  p += 2
  const bytes = depth / 8
  const rowBytes = width * bytes
  const planes = Math.min(channelCount, mode === 1 ? 2 : 4)
  const raw = Buffer.alloc(planes * height * rowBytes)
  if (compression === 0) {
    if (p + planes * height * rowBytes > file.length) throw new PsdError('This Photoshop file is cut short. Save it again in Photoshop.')
    for (let c = 0; c < planes; c += 1) file.copy(raw, c * height * rowBytes, p + c * height * rowBytes, p + (c + 1) * height * rowBytes)
  } else if (compression === 1) {
    // One byte count per row of every channel, then PackBits rows.
    const countSize = big ? 4 : 2
    const rows = channelCount * height
    let q = p + rows * countSize
    for (let c = 0; c < planes; c += 1) {
      for (let y = 0; y < height; y += 1) {
        const n = big ? file.readUInt32BE(p + (c * height + y) * 4) : file.readUInt16BE(p + (c * height + y) * 2)
        const out = c * height * rowBytes + y * rowBytes
        unpackBits(file, q, q + n, raw, out, rowBytes)
        q += n
      }
      // Skipped channels beyond `planes` are not read.
    }
  } else if (compression === 2) {
    const inflated = inflateSync(file.subarray(p))
    if (inflated.length < planes * height * rowBytes) throw new PsdError('This Photoshop file is cut short. Save it again in Photoshop.')
    inflated.copy(raw, 0, 0, planes * height * rowBytes)
  } else {
    throw new PsdError('This Photoshop file uses a compression Atlas does not read. Export a PNG from Photoshop instead.')
  }
  const hasAlpha = (mode === 3 && planes >= 4) || (mode === 1 && planes >= 2)
  const channels: 3 | 4 = hasAlpha ? 4 : 3
  const out = Buffer.alloc(width * height * channels)
  const at = (plane: number, i: number): number => (bytes === 2 ? raw[(plane * height * width + i) * 2]! : raw[plane * height * width + i]!)
  for (let i = 0; i < width * height; i += 1) {
    if (mode === 1) {
      const g = at(0, i)
      out[i * channels] = g
      out[i * channels + 1] = g
      out[i * channels + 2] = g
      if (hasAlpha) out[i * channels + 3] = at(1, i)
    } else {
      out[i * channels] = at(0, i)
      out[i * channels + 1] = at(1, i)
      out[i * channels + 2] = at(2, i)
      if (hasAlpha) out[i * channels + 3] = at(3, i)
    }
  }
  return { width, height, channels, data: out }
}

/** PackBits: a signed count n; 0..127 copies n+1 bytes, -1..-127 repeats the next byte 1-n times. */
function unpackBits(src: Buffer, start: number, end: number, dst: Buffer, out: number, length: number): void {
  let i = start
  let o = out
  const stop = out + length
  while (i < end && o < stop) {
    const n = src.readInt8(i)
    i += 1
    if (n >= 0) {
      const count = n + 1
      for (let k = 0; k < count && o < stop; k += 1) dst[o++] = src[i + k]!
      i += count
    } else if (n !== -128) {
      const count = 1 - n
      const value = src[i]!
      i += 1
      for (let k = 0; k < count && o < stop; k += 1) dst[o++] = value
    }
  }
}
