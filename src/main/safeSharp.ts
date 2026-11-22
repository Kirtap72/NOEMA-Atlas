/**
 * The one place the application opens a picture file with sharp.
 *
 * Why this exists: in sharp 0.35.5 an operation that FAILS on a file (the file is gone, empty, a folder, or not a picture at
 * all) can bring down the whole process with a native fast-fail (exit code 0xC0000409) when several such operations are in
 * flight at once. It cannot be caught from JavaScript: the window simply disappears. Reproduced with plain Node, with
 * Electron's Node, and with different amounts of parallelism (see scripts/repro-sharp-crash.mjs); one at a time is safe.
 *
 * So a file is first checked cheaply and synchronously — it exists, is a regular non-empty file, and begins like a picture —
 * and anything else becomes an ordinary, catchable JavaScript error without ever reaching the native code. Pictures given as
 * buffers or raw pixels are never checked: they were produced inside the application.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import sharpNative from 'sharp'

export type { OverlayOptions, Sharp, SharpOptions } from 'sharp'

/** True when the first bytes look like a picture format sharp can read. */
export function looksLikePicture(head: Buffer): boolean {
  if (head.length < 4) return false
  const b = head
  if (b[0] === 0xff && b[1] === 0xd8) return true // JPEG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true // PNG
  if (b.toString('latin1', 0, 3) === 'GIF') return true
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.length >= 12 && b.toString('latin1', 8, 12) === 'WEBP') return true
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return true // TIFF
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2b && b[3] === 0) return true // BigTIFF
  if (b[0] === 0x42 && b[1] === 0x4d) return true // BMP
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return true // HEIC, AVIF
  if (b.toString('latin1', 0, 4) === '8BPS') return true // PSD
  if (b[0] === 0xff && b[1] === 0x0a) return true // JPEG XL codestream
  if (b.length >= 12 && b[4] === 0x4a && b[5] === 0x58 && b[6] === 0x4c) return true // JPEG XL container
  if (b.toString('latin1', 0, 4) === 'icns' || (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0)) return true // ICNS, ICO
  const text = b.toString('latin1', 0, Math.min(b.length, 64)).trimStart().toLowerCase()
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && b.toString('latin1').toLowerCase().includes('<svg'))) return true
  if (b[0] === 0x50 && /^P[1-7]/.test(b.toString('latin1', 0, 2))) return true // PNM
  if (b.toString('latin1', 0, 4) === '#?RA' || b.toString('latin1', 0, 10) === '#?RADIANCE') return true // Radiance HDR
  return false
}

/** Why a file cannot be opened as a picture, or null when it can. Never throws. */
export function whyNotAPicture(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile()) return 'It is not a file.'
    if (stat.size === 0) return 'The file is empty.'
    const head = Buffer.alloc(32)
    const read = readSync(fd, head, 0, 32, 0)
    if (!looksLikePicture(head.subarray(0, read))) return 'The file does not begin like a picture.'
    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'The file is missing.' : code === 'EISDIR' ? 'It is a folder.' : code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' ? 'The file cannot be read right now.' : 'The file cannot be opened.'
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

type Native = typeof sharpNative

const guarded = function sharp(...args: unknown[]): ReturnType<Native> {
  const input = args[0]
  if (typeof input === 'string') {
    const why = whyNotAPicture(input)
    if (why) throw new Error(`Input file is unusable: ${why} (${input})`)
  }
  return (sharpNative as unknown as (...a: unknown[]) => ReturnType<Native>)(...args)
} as unknown as Native

// Everything else sharp offers (cache, kernel, formats, versions…) stays reachable.
Object.setPrototypeOf(guarded, sharpNative)
for (const key of Object.getOwnPropertyNames(sharpNative)) {
  if (['length', 'name', 'prototype', 'arguments', 'caller'].includes(key)) continue
  Object.defineProperty(guarded, key, { get: () => (sharpNative as unknown as Record<string, unknown>)[key], enumerable: true, configurable: true })
}

export default guarded
