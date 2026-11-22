import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUDED_NAMES, discover, groupCollections, previewSamples } from '../src/main/drives'

let root = ''

async function pictures(dir: string, count: number, size = 640): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    // Noise keeps the files above the "too small to be a real picture" size.
    const raw = Buffer.alloc(size * size * 3)
    for (let p = 0; p < raw.length; p += 1) raw[p] = (p * 7 + i * 31 + (p >> 5)) & 255
    await sharp(raw, { raw: { width: size, height: size, channels: 3 } }).jpeg({ quality: 92 }).toFile(join(dir, `p${i}.jpg`))
  }
}

beforeEach(async () => {
  root = join(tmpdir(), `noema-drive-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
})
afterEach(async () => fs.rm(root, { recursive: true, force: true }))

const run = (roots: string[], extra: Record<string, unknown> = {}) =>
  discover({ roots, excludePaths: [], minImages: 5, ...extra } as never, new AbortController().signal, () => undefined)

describe('finding pictures across a drive', () => {
  it('finds real collections and leaves out system folders, caches, software and tiny icons', async () => {
    await pictures(join(root, 'Photos', 'Iceland 2023'), 7)
    await pictures(join(root, 'Photos', 'Iceland 2024'), 6)
    await pictures(join(root, 'Art', 'Sketchbook'), 9)
    await pictures(join(root, 'Windows', 'Web', 'Wallpaper'), 8)
    await pictures(join(root, 'Program Files', 'Game', 'textures'), 8)
    await pictures(join(root, 'Users', 'me', 'AppData', 'Local', 'Cache'), 8)
    await pictures(join(root, 'project', 'node_modules', 'pkg'), 8)
    // A folder of a program: pictures next to its executables and libraries.
    await pictures(join(root, 'SomeApp', 'resources'), 8)
    for (const f of ['a.dll', 'b.dll', 'c.dll']) await fs.writeFile(join(root, 'SomeApp', 'resources', f), 'x')
    // A web project with its own images.
    await pictures(join(root, 'website', 'img'), 8)
    await fs.writeFile(join(root, 'website', 'img', 'package.json'), '{}')
    // Icons: many files, but too small.
    await fs.mkdir(join(root, 'Icons'), { recursive: true })
    for (let i = 0; i < 12; i += 1) await sharp({ create: { width: 32, height: 32, channels: 3, background: '#789' } }).png().toFile(join(root, 'Icons', `i${i}.png`))
    // Too few pictures to be a collection.
    await pictures(join(root, 'Misc'), 2)

    const result = await run([root])
    const names = result.collections.map((c) => c.path.replace(root, '').replace(/\\/g, '/'))
    expect(names.sort()).toEqual(['/Art/Sketchbook', '/Photos'].sort())
    const photos = result.collections.find((c) => c.name === 'Photos')!
    expect(photos.images).toBe(13)
    expect(photos.folders).toBe(2)
    expect(photos.samples.length).toBeGreaterThan(0)
    expect(result.skippedFolders).toBeGreaterThan(4)
    expect(result.cancelled).toBe(false)
  })

  it('respects folders the user chose to leave out', async () => {
    await pictures(join(root, 'Keep'), 6)
    await pictures(join(root, 'Private'), 6)
    const result = await run([root], { excludePaths: [join(root, 'Private')] })
    expect(result.collections.map((c) => c.name)).toEqual(['Keep'])
  })

  it('can search a built-in excluded folder when the user asks for it', async () => {
    await pictures(join(root, 'Library', 'Scans'), 6)
    expect((await run([root])).collections).toHaveLength(0)
    expect((await run([root], { includeNames: ['library'] })).collections.map((c) => c.name)).toEqual(['Scans'])
  })

  it('marks collections already in Atlas and lists them last', async () => {
    await pictures(join(root, 'x', 'A'), 6)
    await pictures(join(root, 'y', 'B'), 7)
    const found = await discover({ roots: [root], excludePaths: [], minImages: 5 }, new AbortController().signal, () => undefined, (p) => p.endsWith('B'))
    expect(found.collections.map((c) => [c.name, c.inAtlas])).toEqual([['A', false], ['B', true]])
  })

  it('never modifies anything it reads', async () => {
    await pictures(join(root, 'A'), 6)
    const before = await Promise.all((await fs.readdir(join(root, 'A'))).map(async (f) => [f, (await fs.stat(join(root, 'A', f))).mtimeMs] as const))
    const found = await run([root])
    await previewSamples(found.collections[0]!.samples)
    const after = await Promise.all((await fs.readdir(join(root, 'A'))).map(async (f) => [f, (await fs.stat(join(root, 'A', f))).mtimeMs] as const))
    expect(after).toEqual(before)
    expect(await fs.readdir(join(root, 'A'))).toHaveLength(6)
  })

  it('stops promptly when cancelled and reports progress', async () => {
    for (let i = 0; i < 30; i += 1) await fs.mkdir(join(root, `d${i}`), { recursive: true })
    const controller = new AbortController()
    const seen: number[] = []
    const result = await discover({ roots: [root], excludePaths: [], minImages: 5 }, controller.signal, (p) => {
      seen.push(p.scannedFolders)
      controller.abort()
    })
    expect(result.cancelled).toBe(true)
    expect(result.scannedFolders).toBeLessThan(5)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('previews pictures in memory only', async () => {
    await pictures(join(root, 'A'), 6)
    const found = await run([root])
    const previews = await previewSamples(found.collections[0]!.samples)
    expect(previews.length).toBeGreaterThan(0)
    expect(previews[0]).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('lists the usual exclusions so the interface can show them', () => {
    expect(DEFAULT_EXCLUDED_NAMES).toEqual(expect.arrayContaining(['windows', 'program files', 'appdata', 'node_modules', '$recycle.bin']))
  })

  it('does not merge unrelated folders into one giant collection', () => {
    const f = (path: string) => ({ path, images: 10, bytes: 1, samples: [`${path}/a.jpg`], newest: 1 })
    const groups = groupCollections([f('D:\\a\\x'), f('D:\\b\\y')], () => false)
    expect(groups.map((g) => g.path).sort()).toEqual(['D:\\a\\x', 'D:\\b\\y'])
  })
})
