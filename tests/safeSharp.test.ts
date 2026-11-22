import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import realSharp, { type Sharp } from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { exifOfBytes, exifOfFile } from '../src/main/exifHeader'
import { cameraOfExif } from '../src/main/organizer/engine'
import safe, { looksLikePicture, whyNotAPicture } from '../src/main/safeSharp'

// The crash this guards against (sharp 0.35.5, Windows): several FAILING operations on files at the same time bring the whole
// process down with exit code 0xC0000409. Reproduced on the user's library (125 pictures whose files were gone) with
// `scripts/repro-sharp-crash.mjs`. If the guard ever stops working, this test file takes the test process down with it.
realSharp.cache(false)
let dir = ''
const bad: string[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'noema-safe-sharp-'))
  for (let i = 0; i < 60; i += 1) bad.push(join(dir, `gone-${i}.png`)) // never created: the files the library still listed
  for (let i = 0; i < 60; i += 1) {
    const p = join(dir, `empty-${i}.jpg`)
    writeFileSync(p, Buffer.alloc(0))
    bad.push(p)
  }
  for (let i = 0; i < 60; i += 1) {
    const p = join(dir, `random-${i}.png`)
    writeFileSync(p, Buffer.from(Array.from({ length: 200 + i }, (_v, k) => (k * 37 + i * 11) % 251)))
    bad.push(p)
  }
  for (let i = 0; i < 40; i += 1) {
    const p = join(dir, `folder-${i}.png`)
    mkdirSync(p)
    bad.push(p)
  }
  writeFileSync(join(dir, 'page.png'), '<html><body>not a picture</body></html>')
  bad.push(join(dir, 'page.png'))
})
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch {
    /* Windows may still hold a handle for a moment; the folder is in the temp directory */
  }
})

describe('opening picture files safely', () => {
  it('turns every kind of unusable file into an ordinary error, never a native failure', async () => {
    for (let round = 0; round < 25; round += 1) {
      const results = await Promise.allSettled(
        bad.map(async (p) => {
          const image = safe(p, { failOn: 'none' })
          return image.metadata()
        })
      )
      expect(results.every((r) => r.status === 'rejected')).toBe(true)
      const reasons = results.map((r) => (r.status === 'rejected' ? String((r.reason as Error).message) : ''))
      expect(reasons.every((m) => /unusable/.test(m))).toBe(true)
    }
  }, 60_000)

  it('explains why a file is unusable', () => {
    expect(whyNotAPicture(join(dir, 'gone-1.png'))).toBe('The file is missing.')
    expect(whyNotAPicture(join(dir, 'empty-1.jpg'))).toBe('The file is empty.')
    expect(whyNotAPicture(join(dir, 'random-1.png'))).toBe('The file does not begin like a picture.')
    expect(whyNotAPicture(join(dir, 'folder-1.png'))).toMatch(/not a file|folder/)
  })

  it('still reads real pictures, concurrently, in every common format', async () => {
    const make = async (name: string, f: (s: Sharp) => Sharp): Promise<string> => {
      const p = join(dir, name)
      await f(realSharp({ create: { width: 48, height: 32, channels: 3, background: '#a0603c' } })).toFile(p)
      return p
    }
    const files = await Promise.all([make('a.png', (s) => s.png()), make('b.jpg', (s) => s.jpeg()), make('c.webp', (s) => s.webp()), make('d.tif', (s) => s.tiff()), make('e.gif', (s) => s.gif()), make('f.avif', (s) => s.avif({ effort: 0 }))])
    const metas = await Promise.all(files.flatMap((p) => Array.from({ length: 20 }, () => safe(p).metadata())))
    expect(metas.every((m) => m.width === 48 && m.height === 32)).toBe(true)
    expect(whyNotAPicture(files[0]!)).toBeNull()
  })

  it('does not interfere with pictures given as bytes or with the rest of sharp', async () => {
    const png = await safe({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).png().toBuffer()
    expect((await safe(png).metadata()).width).toBe(4)
    expect(typeof safe.cache).toBe('function')
    expect(safe.kernel.lanczos3).toBeTruthy()
    expect(looksLikePicture(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(true)
    expect(looksLikePicture(Buffer.from('hello world, not a picture'))).toBe(false)
  })
})

describe('reading the camera without an image library', () => {
  it('finds the camera in JPEG, PNG and WebP files, and nothing where there is none', async () => {
    const exif = { IFD0: { Make: 'Canon', Model: 'Canon EOS 30D' } }
    const base = (): Sharp => realSharp({ create: { width: 16, height: 16, channels: 3, background: '#888' } })
    const jpg = join(dir, 'cam.jpg')
    const png = join(dir, 'cam.png')
    const webp = join(dir, 'cam.webp')
    const plain = join(dir, 'plain.jpg')
    await base().jpeg().withExif(exif).toFile(jpg)
    await base().png().withExif(exif).toFile(png)
    await base().webp().withExif(exif).toFile(webp)
    await base().jpeg().toFile(plain)
    expect(cameraOfExif(exifOfFile(jpg) ?? undefined)).toBe('Canon EOS 30D')
    expect(cameraOfExif(exifOfFile(png) ?? undefined)).toBe('Canon EOS 30D')
    expect(cameraOfExif(exifOfFile(webp) ?? undefined)).toBe('Canon EOS 30D')
    expect(exifOfFile(plain)).toBeNull()
    expect(exifOfFile(join(dir, 'gone-1.png'))).toBeNull()
    expect(exifOfFile(join(dir, 'random-1.png'))).toBeNull()
    expect(exifOfBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff]))).toBeNull()
  })
})
