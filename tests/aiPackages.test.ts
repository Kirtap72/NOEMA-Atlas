import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiPackages, PACKAGES, type AiDeps } from '../src/main/studio/aiPackages'
import type { HardwareInfo } from '../src/shared/ai'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const archive = Buffer.from('pretend this is a 7z archive of ComfyUI')
const blobs: Record<string, Buffer> = {
  '/runtime.7z': archive,
  '/runtime2.7z': Buffer.from('a newer ComfyUI archive'),
  '/sd15': Buffer.alloc(300_000, 1),
  '/tile': Buffer.alloc(120_000, 2),
  '/esrgan': Buffer.alloc(40_000, 3)
}
// The catalogue pins real sizes and checksums; the tests swap them for small stand-ins of the same shape.
let server: Server
let base = ''
let work = ''
let ai: AiPackages
let used: Array<{ folder: string; args: string[]; port: number }>
let verifyResult: string | null
let hits: string[]
let dropOnce = false

const gpu = (over: Partial<HardwareInfo> = {}): HardwareInfo => ({ gpu: { name: 'NVIDIA Test', vendor: 'nvidia', vramGB: 8, driver: '600' }, platform: 'win32', supported: true, note: null, ...over })

/** Pretends to unpack: creates the folder layout of the portable ComfyUI. */
const fakeExtract: AiDeps['extract'] = async (_archive, dest, onFiles) => {
  mkdirSync(join(dest, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true })
  writeFileSync(join(dest, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), '# comfy')
  mkdirSync(join(dest, 'ComfyUI_windows_portable', 'python_embeded'), { recursive: true })
  onFiles(10)
}

beforeEach(async () => {
  work = join(tmpdir(), `noema-ai-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(work, { recursive: true })
  hits = []
  used = []
  verifyResult = null
  dropOnce = false
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    const blob = blobs[req.url ?? '']
    if (!blob) {
      res.statusCode = 404
      return res.end()
    }
    const m = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
    const start = m ? Number(m[1]) : 0
    res.statusCode = m ? 206 : 200
    res.setHeader('content-length', String(blob.length - start))
    if (dropOnce && req.url === '/sd15' && start === 0) {
      dropOnce = false
      res.write(blob.subarray(0, 100_000))
      setTimeout(() => res.destroy(), 10)
      return
    }
    res.end(blob.subarray(start))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(work, { recursive: true, force: true })
})

function make(over: Partial<AiDeps> = {}, release: { tag: string; path: string; body: Buffer } = { tag: 'v1.0.0', path: '/runtime.7z', body: archive }): AiPackages {
  const events: unknown[] = []
  void events
  return new AiPackages({
    dataDir: join(work, 'data'),
    useRuntime: (folder, args, port) => used.push({ folder, args, port }),
    verifyRuntime: async () => verifyResult,
    hardware: async () => gpu(),
    extract: fakeExtract,
    freeBytes: async () => 500e9,
    latestRelease: async () => ({ tag: release.tag, url: `${base}${release.path}`, sha256: sha(release.body), bytes: release.body.length }),
    fileFor: (file) => ({ ...file, url: `${base}/${file.key}`, bytes: blobs[`/${file.key}`]!.length, sha256: sha(blobs[`/${file.key}`]!) }),
    ...over
  })
}

describe('Atlas’s own ComfyUI and capability packages', () => {
  beforeEach(() => {
    ai = make()
  })

  it('reports an honest starting point: nothing installed, hardware, sizes, licences', async () => {
    const status = await ai.status()
    expect(status.mode).toBe('none')
    expect(status.runtime.state).toBe('not-installed')
    expect(status.hardware.gpu?.name).toBe('NVIDIA Test')
    expect(status.packages.map((p) => p.id)).toEqual(['create', 'edit', 'upscale'])
    for (const p of status.packages) {
      expect(p.state).toBe('not-installed')
      expect(p.downloadBytes).toBeGreaterThan(0)
      expect(p.licenses.length).toBeGreaterThan(0)
      expect(p.vramGB).toBeGreaterThan(0)
    }
    expect(status.packages.find((p) => p.id === 'create')!.licenses[0]!.name).toMatch(/OpenRAIL|Open RAIL/i)
    expect(PACKAGES.find((p) => p.id === 'upscale')!.needs).toEqual(['create', 'edit'])
  })

  it('does nothing without consent', async () => {
    await expect(ai.installRuntime(join(work, 'ai'), false)).rejects.toThrow(/agree/)
    expect(existsSync(join(work, 'ai'))).toBe(false)
  })

  it('installs the runtime after consent: download, checksum, unpack, configure, verify, hand over', async () => {
    const root = join(work, 'ai')
    const steps: string[] = []
    const seen = new AiPackages({ dataDir: join(work, 'data2'), useRuntime: (f, a, p) => used.push({ folder: f, args: a, port: p }), verifyRuntime: async () => null, hardware: async () => gpu(), extract: fakeExtract, freeBytes: async () => 500e9, latestRelease: async () => ({ tag: 'v1.0.0', url: `${base}/runtime.7z`, sha256: sha(archive), bytes: archive.length }), broadcast: (_c, job) => steps.push((job as { stage: string }).stage) })
    const status = await seen.installRuntime(root, true)
    expect(status.runtime.state).toBe('ready')
    expect(status.mode).toBe('managed')
    expect(steps).toEqual(expect.arrayContaining(['downloading', 'unpacking', 'configuring', 'starting', 'done']))
    const folder = join(root, 'runtime', 'ComfyUI-v1.0.0')
    expect(existsSync(join(folder, 'ComfyUI', 'main.py'))).toBe(true)
    const yaml = readFileSync(join(folder, 'ComfyUI', 'extra_model_paths.yaml'), 'utf8')
    expect(yaml).toContain('checkpoints: checkpoints')
    expect(yaml).toContain(join(root, 'models').replace(/\\/g, '/'))
    expect(used).toHaveLength(1)
    expect(used[0]!.folder).toBe(folder)
    expect(used[0]!.args).toEqual(expect.arrayContaining(['--output-directory', '--user-directory']))
    expect(used[0]!.port).toBe(8191)
    expect(existsSync(join(root, 'downloads', 'ComfyUI_windows_portable_nvidia.7z'))).toBe(false)
  })

  it('refuses a folder that is not empty and was not made by Atlas, and whole drives', async () => {
    const mine = join(work, 'documents')
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'thesis.docx'), 'x')
    await expect(ai.installRuntime(mine, true)).rejects.toThrow(/not empty/)
    expect(readFileSync(join(mine, 'thesis.docx'), 'utf8')).toBe('x')
    await expect(ai.installRuntime('C:\\', true)).rejects.toThrow(/not a whole drive|Choose a folder/)
  })

  it('refuses when there is not enough disk space, before downloading anything', async () => {
    const small = make({ freeBytes: async () => 10 })
    await expect(small.installRuntime(join(work, 'ai'), true)).rejects.toThrow(/not enough room/)
    expect(hits).toHaveLength(0)
  })

  it('a download that does not match its checksum is thrown away and the install fails clearly', async () => {
    const bad = make({}, { tag: 'v1.0.0', path: '/runtime.7z', body: Buffer.from('something else') })
    await expect(bad.installRuntime(join(work, 'ai'), true)).rejects.toThrow()
    expect((await bad.status()).runtime.state).toBe('not-installed')
    expect(existsSync(join(work, 'ai', 'downloads', 'ComfyUI_windows_portable_nvidia.7z'))).toBe(false)
  })

  it('reports a runtime that does not start, and keeps the files for a retry', async () => {
    verifyResult = 'ComfyUI did not answer after starting.'
    await expect(ai.installRuntime(join(work, 'ai'), true)).rejects.toThrow(/did not answer/)
    expect((await ai.status()).problem).toMatch(/did not answer/)
  })

  it('refuses to add models to anything but its own runtime', async () => {
    await expect(ai.installPackages(['create'], true)).rejects.toThrow(/never writes into another ComfyUI/)
  })

  describe('with the runtime installed', () => {
    beforeEach(async () => {
      await ai.installRuntime(join(work, 'ai'), true)
    })

    it('installs packages with their dependencies after consent, verifies them and reports sizes', async () => {
      await expect(ai.installPackages(['upscale'], false)).rejects.toThrow(/agree/)
      expect(ai.expand(['upscale'])).toEqual(['create', 'edit', 'upscale'])
      const before = await ai.status()
      expect(before.packages.find((p) => p.id === 'upscale')!.downloadBytes).toBeGreaterThan(0)
      dropOnce = true
      const status = await ai.installPackages(['upscale'], true)
      for (const p of status.packages) expect(p.state).toBe('installed')
      expect(readFileSync(join(work, 'ai', 'models', 'checkpoints', 'v1-5-pruned-emaonly-fp16.safetensors')).equals(blobs['/sd15']!)).toBe(true)
      expect(readFileSync(join(work, 'ai', 'models', 'controlnet', 'control_v11f1e_sd15_tile_fp16.safetensors')).equals(blobs['/tile']!)).toBe(true)
      expect(readFileSync(join(work, 'ai', 'models', 'upscale_models', 'RealESRGAN_x4plus.pth')).equals(blobs['/esrgan']!)).toBe(true)
      expect(hits.filter((h) => h === '/tile')).toHaveLength(1)
      expect(ai.verifyFiles()).toEqual([])
      // A damaged file is noticed, and installing again repairs only that file.
      writeFileSync(join(work, 'ai', 'models', 'controlnet', 'control_v11f1e_sd15_tile_fp16.safetensors'), 'broken')
      expect(ai.verifyFiles()[0]).toMatch(/control_v11f1e/)
      const again = await ai.installPackages(['edit'], true)
      expect(again.packages.find((p) => p.id === 'edit')!.state).toBe('installed')
      expect(hits.filter((h) => h === '/sd15').length).toBeGreaterThanOrEqual(2)
      expect(hits.filter((h) => h === '/tile')).toHaveLength(2)
      expect(hits.filter((h) => h === '/esrgan')).toHaveLength(1)
    })
  })

  it('updates safely: the new runtime goes in beside the old, is checked, then switched; the old is kept', async () => {
    await ai.installRuntime(join(work, 'ai'), true)
    const newer = make({}, { tag: 'v2.0.0', path: '/runtime2.7z', body: blobs['/runtime2.7z']! })
    // The same state file is shared (same dataDir), so a fresh instance sees the installed runtime.
    expect(await newer.checkForUpdate()).toBe('v2.0.0')
    expect((await newer.status()).runtime.updateTo).toBe('v2.0.0')
    await expect(newer.updateRuntime(false)).rejects.toThrow(/confirm/)
    const status = await newer.updateRuntime(true)
    expect(status.runtime.version).toBe('v2.0.0')
    expect(existsSync(join(work, 'ai', 'runtime', 'ComfyUI-v1.0.0', 'ComfyUI', 'main.py'))).toBe(true)
    expect(existsSync(join(work, 'ai', 'runtime', 'ComfyUI-v2.0.0', 'ComfyUI', 'main.py'))).toBe(true)
    expect(used.at(-1)!.folder).toContain('v2.0.0')
  })

  it('a failed update leaves the working runtime in place and switches back', async () => {
    await ai.installRuntime(join(work, 'ai'), true)
    verifyResult = 'The new ComfyUI did not start.'
    const newer = make({}, { tag: 'v2.0.0', path: '/runtime2.7z', body: blobs['/runtime2.7z']! })
    await expect(newer.updateRuntime(true)).rejects.toThrow(/previous ComfyUI is unchanged/)
    const status = await newer.status()
    expect(status.runtime.version).toBe('v1.0.0')
    expect(used.at(-1)!.folder).toContain('v1.0.0')
  })

  it('uninstall removes only what Atlas installed, inside its own folder', async () => {
    const root = join(work, 'ai')
    await ai.installRuntime(root, true)
    writeFileSync(join(root, 'models', 'checkpoints', 'my-own-model.safetensors'), 'user file')
    const userWorkflow = join(root, 'runtime', 'ComfyUI-v1.0.0', 'my-workflow.json')
    writeFileSync(userWorkflow, 'user workflow')
    writeFileSync(join(root, 'downloads', 'my-download.bin'), 'user download')
    await ai.uninstall()
    expect(existsSync(join(root, 'runtime', 'ComfyUI-v1.0.0'))).toBe(false)
    expect(readFileSync(join(root, 'models', 'checkpoints', 'my-own-model.safetensors'), 'utf8')).toBe('user file')
    expect(readFileSync(join(root, 'downloads', 'my-download.bin'), 'utf8')).toBe('user download')
    const retained = await fs.readdir(join(root, 'retained'))
    expect(readFileSync(join(root, 'retained', retained[0]!, 'my-workflow.json'), 'utf8')).toBe('user workflow')
    expect((await ai.status()).runtime.state).toBe('not-installed')
  })
})
