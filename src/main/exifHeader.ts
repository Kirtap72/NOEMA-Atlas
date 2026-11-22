import { closeSync, openSync, readSync } from 'node:fs'

/**
 * The EXIF block of a picture file, read from its first bytes with plain JavaScript (no native image library).
 * Used to learn which camera made a photograph. Returns the block as `cameraOfExif` expects it, or null.
 */
export function exifOfBytes(b: Buffer): Buffer | null {
  try {
    // JPEG: segments before the picture data; EXIF lives in an APP1 segment that begins "Exif\0\0".
    if (b[0] === 0xff && b[1] === 0xd8) {
      let p = 2
      while (p + 4 <= b.length) {
        if (b[p] !== 0xff) return null
        const marker = b[p + 1]!
        if (marker === 0xff) {
          p += 1
          continue
        }
        if (marker === 0xda || marker === 0xd9) return null
        const len = b.readUInt16BE(p + 2)
        if (marker === 0xe1 && b.toString('latin1', p + 4, p + 10) === 'Exif\u0000\u0000') return b.subarray(p + 4, Math.min(b.length, p + 2 + len))
        p += 2 + len
      }
      return null
    }
    // PNG: an "eXIf" chunk holds the TIFF block directly.
    if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') {
      let p = 8
      while (p + 12 <= b.length) {
        const len = b.readUInt32BE(p)
        const type = b.toString('latin1', p + 4, p + 8)
        if (type === 'eXIf') return b.subarray(p + 8, Math.min(b.length, p + 8 + len))
        if (type === 'IDAT' || type === 'IEND') return null
        p += 12 + len
      }
      return null
    }
    // WebP: a RIFF container with an "EXIF" chunk.
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      let p = 12
      while (p + 8 <= b.length) {
        const type = b.toString('latin1', p, p + 4)
        const len = b.readUInt32LE(p + 4)
        if (type === 'EXIF') return b.subarray(p + 8, Math.min(b.length, p + 8 + len))
        p += 8 + len + (len % 2)
      }
      return null
    }
    // TIFF: the file itself starts with the same structure.
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return b
  } catch {
    /* a damaged header simply has no camera */
  }
  return null
}

/** Reads only the head of the file (enough for any real EXIF block) and never throws. */
export function exifOfFile(path: string, headBytes = 256 * 1024): Buffer | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(headBytes)
    const read = readSync(fd, buffer, 0, headBytes, 0)
    return exifOfBytes(buffer.subarray(0, read))
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* nothing to do */
      }
    }
  }
}
