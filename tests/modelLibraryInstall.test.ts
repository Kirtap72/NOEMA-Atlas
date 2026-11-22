import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AiPackages, type AiDeps } from '../src/main/studio/aiPackages'
import { ModelLibrary, type ComfyView } from '../src/main/modelLibrary/library'
import { OllamaClient } from '../src/main/modelLibrary/ollama'
import type { ModelInventory } from '../src/main/studio/comfyModels'
import type { HardwareInfo } from '../src/shared/ai'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const archive = Buffer.from('pretend this is a 7z archive of ComfyUI')
const blobs: Record<string, Buffer> = {
  '/runtime.7z': archive,
  '/base.bin': Buffer.alloc(300_000, 1),
  '/tool.bin': Buffer.alloc(120_000, 2),
  '/shared.bin': Buffer.alloc(40_000, 3),
  '/big.bin': Buffer.alloc(200_000, 4)
}
let server: Server
let base = ''
let work = ''
let dropOnce = false
let corrupt = false
let hits: string[]

const gpu = (): HardwareInfo => ({ gpu: { name: 'NVIDIA Test', vendor: 'nvidia', vramGB: 8, driver: '600' }, platform: 'win32', supported: true, note: null })
const fakeExtract: AiDeps['extract'] = async (_a, dest, onFiles) => {
  mkdirSync(join(dest, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true })
  writeFileSync(join(dest, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), '# comfy')
  onFiles(5)
}

const file = (key: string, name: string, folder: string, blob: string) => ({ key, name, folder, url: `${base}${blob}`, bytes: blobs[blob]!.length, sha256: sha(blobs[blob]!) })
const entryOf = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 1, id, name: id.toUpperCase(), summary: `${id} summary`, details: `${id} details`, categories: ['generation'], capabilities: [], version: '1.0', runtime: 'comfyui',
  source: { name: 'Official', url: 'https://example.com/official' },
  licence: { name: 'Test licence', url: 'https://example.com/licence', summary: 'A licence that is long enough to read.', commercialUse: 'yes' },
  files: [], requirements: { minMemoryGB: 4, recommendedMemoryGB: 6, archs: ['x64'], os: ['win32'] }, dependsOn: [], workflows: [], provides: ['create'],
  verification: { status: 'documented', checks: [] }, install: { mode: 'managed' }, ...over
})
let catalog: unknown[]

let ai: AiPackages
let progress: Array<{ stage: string; message: string }>
let comfy: ComfyView
let ollamaTags: string[] | null
let pullMode: 'ok' | 'error' | 'cut'
let lib: ModelLibrary

const ollamaFetch = async (url: string, init?: Record<string, unknown>): Promise<Response> => {
  if (ollamaTags === null) throw new Error('connection refused')
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: ollamaTags.map((name) => ({ name })) }))
  if (url.endsWith('/api/pull')) {
    const name = (JSON.parse(String(init?.body)) as { name: string }).name
    const lines = [{ status: 'pulling manifest' }, { status: 'pulling abc', total: 1000, completed: 400 }, { status: 'pulling abc', total: 1000, completed: 1000 }]
    if (pullMode === 'error') lines.push({ error: 'pull model manifest: file does not exist' } as never)
    else if (pullMode === 'ok') {
      lines.push({ status: 'success' })
      ollamaTags = [...(ollamaTags ?? []), name.includes(':') ? name : `${name}:latest`]
    }
    return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }
  return new Response('', { status: 404 })
}

beforeEach(async () => {
  work = join(tmpdir(), `noema-lib-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(work, { recursive: true })
  hits = []
  dropOnce = false
  corrupt = false
  progress = []
  ollamaTags = null
  pullMode = 'ok'
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
    if (dropOnce && req.url === '/base.bin' && start === 0) {
      dropOnce = false
      res.write(blob.subarray(0, 100_000))
      setTimeout(() => res.destroy(), 10)
      return
    }
    const body = corrupt && req.url === '/tool.bin' ? Buffer.alloc(blob.length - start, 9) : blob.subarray(start)
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  catalog = [
    entryOf('base-model', { name: 'Base model', files: [file('base', 'base_model.bin', 'checkpoints', '/base.bin'), file('shared-vae', 'shared_vae.bin', 'vae', '/shared.bin')] }),
    entryOf('tool-model', { name: 'Tool model', categories: ['editing'], dependsOn: ['base-model'], provides: ['edit'], files: [file('tool', 'tool_model.bin', 'controlnet', '/tool.bin')], licence: { name: 'Non-commercial test licence', url: 'https://example.com/nc', summary: 'Only for non-commercial use, read the licence.', commercialUse: 'no' } }),
    entryOf('other-model', { name: 'Other model', files: [file('shared-vae', 'shared_vae.bin', 'vae', '/shared.bin'), file('other', 'other_model.bin', 'diffusion_models', '/big.bin')] }),
    entryOf('arm-ok', { name: 'Runs anywhere', runtime: 'ollama', install: { mode: 'ollama', pullName: 'tiny-vision', instructions: ['Install Ollama'] }, categories: ['understanding'], provides: ['describe'], requirements: { minMemoryGB: 1 }, files: [] }),
    entryOf('manual-model', { name: 'Manual model', install: { mode: 'manual', manualReason: 'A login is needed.', instructions: ['Log in and accept the licence.'] }, files: [] })
  ]
  comfy = { inventory: null, kind: 'none', folder: null, dataFolder: null, version: null, note: null }
  ai = new AiPackages({
    dataDir: join(work, 'data'),
    useRuntime: () => undefined,
    verifyRuntime: async () => null,
    hardware: async () => gpu(),
    extract: fakeExtract,
    freeBytes: async () => 500e9,
    latestRelease: async () => ({ tag: 'v1.0.0', url: `${base}/runtime.7z`, sha256: sha(archive), bytes: archive.length }),
    broadcast: (_c, job) => progress.push(job as { stage: string; message: string })
  })
  lib = makeLib()
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(work, { recursive: true, force: true })
})

function makeLib(over: Partial<ConstructorParameters<typeof ModelLibrary>[0]> = {}): ModelLibrary {
  return new ModelLibrary({ ai, userCatalogDir: join(work, 'model-library'), comfy: () => comfy, ollama: new OllamaClient(ollamaFetch), builtIn: catalog, allowLocalHttp: true, freeBytes: async () => 500e9, broadcast: (_c, job) => progress.push(job as { stage: string; message: string }), ...over })
}
const view = async (id: string, simulate?: string) => (await lib.overview(simulate)).entries.find((e) => e.entry.id === id)!
const installRuntime = async (): Promise<void> => void (await ai.installRuntime(join(work, 'ai'), true))

describe('the library installs through the existing installer', () => {
  it('before anything is set up, says what is missing instead of pretending', async () => {
    const o = await lib.overview()
    expect(o.mode).toBe('none')
    expect(o.problems).toEqual([])
    const v = await view('base-model')
    expect(v.way).toBe('unavailable')
    expect(v.wayNote).toMatch(/Set up AI first/)
    expect(v.state.kind).toBe('not-installed')
    await expect(lib.install('base-model', { consent: true })).rejects.toThrow(/Set up AI first/)
    expect(hits).toEqual([])
  })

  it('shows the complete plan before anything is downloaded: dependencies first, sizes, licences, warnings, free space', async () => {
    await installRuntime()
    const v = await view('tool-model')
    expect(v.way).toBe('atlas')
    const plan = v.plan!
    expect(plan.entries.map((e) => e.id)).toEqual(['base-model', 'tool-model'])
    expect(plan.files.map((f) => f.name)).toEqual(['base_model.bin', 'shared_vae.bin', 'tool_model.bin'])
    expect(plan.downloadBytes).toBe(300_000 + 40_000 + 120_000)
    expect(plan.freeBytes).toBe(500e9)
    expect(plan.destination).toBe(join(work, 'ai', 'models'))
    expect(plan.licences.map((l) => l.name)).toEqual(['Test licence', 'Non-commercial test licence'])
    expect(plan.warnings.join(' ')).toMatch(/does not allow commercial use/)
    expect(hits).toEqual(['/runtime.7z']) // only the runtime was fetched so far
  })

  it('refuses without consent, then installs the dependency and the model, each file verified, and reports progress', async () => {
    await installRuntime()
    hits = []
    await expect(lib.install('tool-model', { consent: false })).rejects.toThrow(/agree/)
    expect(hits).toEqual([])
    const o = await lib.install('tool-model', { consent: true })
    const models = join(work, 'ai', 'models')
    expect(readFileSync(join(models, 'checkpoints', 'base_model.bin')).equals(blobs['/base.bin']!)).toBe(true)
    expect(existsSync(join(models, 'vae', 'shared_vae.bin'))).toBe(true)
    expect(existsSync(join(models, 'controlnet', 'tool_model.bin'))).toBe(true)
    expect(o.entries.find((e) => e.entry.id === 'tool-model')!.state.kind).toBe('installed')
    expect(o.entries.find((e) => e.entry.id === 'base-model')!.state.kind).toBe('installed')
    expect(progress.map((p) => p.stage)).toEqual(expect.arrayContaining(['downloading', 'done']))
    // installing again downloads nothing
    hits = []
    await lib.install('tool-model', { consent: true })
    expect(hits).toEqual([])
  })

  it('a damaged download is rejected by its checksum and leaves nothing behind', async () => {
    await installRuntime()
    corrupt = true
    await expect(lib.install('tool-model', { consent: true })).rejects.toThrow()
    expect(existsSync(join(work, 'ai', 'models', 'controlnet', 'tool_model.bin'))).toBe(false)
    expect((await view('tool-model')).state.kind).not.toBe('installed')
  })

  it('resumes an interrupted download and finishes it', async () => {
    await installRuntime()
    dropOnce = true
    await lib.install('base-model', { consent: true }).catch(() => undefined)
    const o = await lib.install('base-model', { consent: true })
    expect(o.entries.find((e) => e.entry.id === 'base-model')!.state.kind).toBe('installed')
    expect(hits.filter((h) => h === '/base.bin').length).toBeGreaterThanOrEqual(2)
  })

  it('stops when the disk is too full, before downloading', async () => {
    await installRuntime()
    ai = new AiPackages({ dataDir: join(work, 'data'), useRuntime: () => undefined, verifyRuntime: async () => null, hardware: async () => gpu(), extract: fakeExtract, freeBytes: async () => 100_000, latestRelease: async () => ({ tag: 'v1.0.0', url: `${base}/runtime.7z`, sha256: sha(archive), bytes: archive.length }) })
    lib = makeLib({ ai, freeBytes: async () => 100_000 })
    hits = []
    await expect(lib.install('base-model', { consent: true })).rejects.toThrow(/not enough room/)
    expect(hits).toEqual([])
  })

  it('removes only what Atlas installed, keeps files another model uses, and refuses while something depends on it', async () => {
    await installRuntime()
    await lib.install('tool-model', { consent: true })
    await lib.install('other-model', { consent: true })
    const models = join(work, 'ai', 'models')
    // a file that is not Atlas's own lies in the same folder
    writeFileSync(join(models, 'checkpoints', 'my_own_model.safetensors'), 'mine')
    await expect(lib.remove('base-model')).rejects.toThrow(/“Tool model” needs this model/)
    const gone = await lib.remove('other-model')
    expect(gone.removed).toEqual(['other_model.bin'])
    expect(gone.kept).toEqual(['shared_vae.bin']) // the tool model's dependency still uses it
    expect(existsSync(join(models, 'vae', 'shared_vae.bin'))).toBe(true)
    expect(existsSync(join(models, 'diffusion_models', 'other_model.bin'))).toBe(false)
    const gone2 = await lib.remove('tool-model')
    expect(gone2.removed).toEqual(['tool_model.bin'])
    const gone3 = await lib.remove('base-model')
    expect(gone3.removed.sort()).toEqual(['base_model.bin', 'shared_vae.bin'])
    expect(readFileSync(join(models, 'checkpoints', 'my_own_model.safetensors'), 'utf8')).toBe('mine')
    expect((await view('base-model')).state.kind).toBe('not-installed')
  })

  it('verifies installed files, and a deep check catches a tampered one', async () => {
    await installRuntime()
    await lib.install('base-model', { consent: true })
    expect(await lib.verify('base-model', true)).toEqual([])
    const path = join(work, 'ai', 'models', 'checkpoints', 'base_model.bin')
    const bytes = readFileSync(path)
    bytes[1000] = bytes[1000]! ^ 0xff
    writeFileSync(path, bytes) // same size, one byte changed
    expect(await lib.verify('base-model', false)).toEqual([]) // quick check looks at the size
    expect((await lib.verify('base-model', true)).join(' ')).toMatch(/damaged/)
    await fs.rm(path)
    expect((await lib.verify('base-model', false)).join(' ')).toMatch(/missing/)
  })
})

describe('a ComfyUI that is the user\'s own (here, or elsewhere) is only read', () => {
  const inventory = (over: Partial<ModelInventory['byCategory']> = {}): ModelInventory => ({ byCategory: { checkpoints: [], diffusion: [], vae: [], textEncoders: [], loras: [], controlnet: [], upscale: [], ...over }, total: 0, folders: [], families: [] })

  it('lists what it finds as available, says Atlas will not write into it, and gives the official steps with its folders', async () => {
    comfy = { inventory: inventory({ checkpoints: ['base_model.bin'], vae: ['SHARED_VAE.bin'] }), kind: 'local', folder: 'D:\\ComfyUI', dataFolder: 'D:\\ComfyUI', version: '0.45.0', note: null }
    const base0 = await view('base-model')
    expect(base0.state.kind).toBe('found-in-comfyui')
    expect(base0.state.where).toMatch(/your ComfyUI/)
    const t = await view('tool-model')
    expect(t.way).toBe('manual')
    expect(t.wayNote).toMatch(/never writes into it/)
    expect(t.instructions.join('\n')).toMatch(/Download tool_model\.bin .* and put it in D:\\ComfyUI\\models\\controlnet/)
    expect(t.instructions.join('\n')).toContain(sha(blobs['/tool.bin']!))
    expect(t.instructions.join('\n')).toMatch(/Check my ComfyUI/)
    await expect(lib.install('tool-model', { consent: true })).rejects.toThrow(/never writes/)
    expect(hits).toEqual([])
    // after the user puts the file there, a check sees it
    comfy = { ...comfy, inventory: inventory({ checkpoints: ['base_model.bin'], vae: ['shared_vae.bin'], controlnet: ['tool_model.bin'] }) }
    expect((await view('tool-model')).state.kind).toBe('found-in-comfyui')
  })

  it('a ComfyUI on the network is read through its API', async () => {
    comfy = { inventory: null, kind: 'remote', folder: null, dataFolder: null, version: null, note: 'Connected over the network.' }
    lib = makeLib({ remoteNames: async () => ['base_model.bin', 'shared_vae.bin', 'tool_model.bin'] })
    expect((await view('tool-model')).state.kind).toBe('found-in-comfyui')
    expect((await view('tool-model')).way).toBe('manual')
  })
})

describe('Windows on Arm', () => {
  it('does not assume the x64 runtime works: no automatic install, official steps and a clear reason', async () => {
    const v = await view('base-model', 'rtx-spark-arm64')
    expect(v.way).toBe('manual')
    expect(v.wayNote).toMatch(/no official portable build for Windows on Arm/)
    expect(v.instructions[0]).toMatch(/Windows-on-Arm computer/)
    expect(v.fit.level).toBe('works')
    expect(v.fit.reasons.join(' ')).toMatch(/arm64/)
    // the library refuses even if asked, because the real computer here is x64: the simulation only previews
    const o = await lib.overview('rtx-spark-arm64')
    expect(o.hardware.simulated).toBe('rtx-spark-arm64')
    expect(o.hardware.primary!.memoryKind).toBe('unified')
    expect(o.simulations.map((s) => s.id)).toEqual(expect.arrayContaining(['rtx-2080', 'rtx-5080', 'rtx-5090', 'rtx-spark-arm64']))
  })
})

describe('local vision models through the user\'s own Ollama', () => {
  it('is “manual” while Ollama is not running, and installs through Ollama\'s own pull once it is and the user agrees', async () => {
    ollamaTags = null
    const off = await view('arm-ok')
    expect(off.way).toBe('manual')
    expect(off.wayNote).toMatch(/Ollama is not running/)
    expect(off.state.kind).toBe('unknown')
    ollamaTags = ['llama3:latest']
    const on = await view('arm-ok')
    expect(on.way).toBe('ollama')
    expect(on.state.kind).toBe('not-installed')
    await expect(lib.install('arm-ok', { consent: false })).rejects.toThrow(/agree/)
    const o = await lib.install('arm-ok', { consent: true })
    expect(o.entries.find((e) => e.entry.id === 'arm-ok')!.state.kind).toBe('installed')
    expect(progress.some((p) => p.stage === 'downloading')).toBe(true)
    expect(progress.some((p) => p.stage === 'done')).toBe(true)
    await expect(lib.remove('arm-ok')).rejects.toThrow(/ollama rm tiny-vision/)
  })
  it('reports Ollama\'s own errors and a download that ended early', async () => {
    ollamaTags = []
    pullMode = 'error'
    await expect(lib.install('arm-ok', { consent: true })).rejects.toThrow(/file does not exist/)
    pullMode = 'cut'
    await expect(lib.install('arm-ok', { consent: true })).rejects.toThrow(/ended before Ollama said it was complete/)
    expect((await view('arm-ok')).state.kind).toBe('not-installed')
  })
})

describe('entries that cannot be installed by Atlas', () => {
  it('shows the official steps and why, and never downloads', async () => {
    await installRuntime()
    const v = await view('manual-model')
    expect(v.way).toBe('manual')
    expect(v.wayNote).toBe('A login is needed.')
    expect(v.instructions).toEqual(['Log in and accept the licence.'])
    await expect(lib.install('manual-model', { consent: true })).rejects.toThrow(/A login is needed/)
  })

  it('takes new definitions from the user\'s folder without changing the application', async () => {
    const mine = entryOf('my-extra', { name: 'My extra model', files: [{ key: 'extra', name: 'extra.bin', folder: 'loras', url: 'https://example.com/extra.bin', bytes: 1000, sha256: 'a'.repeat(64) }] })
    await fs.mkdir(join(work, 'model-library'), { recursive: true })
    await fs.writeFile(join(work, 'model-library', 'extra.json'), JSON.stringify(mine))
    await fs.writeFile(join(work, 'model-library', 'bad.json'), JSON.stringify({ id: 'bad' }))
    const o = await lib.overview()
    expect(o.entries.map((e) => e.entry.id)).toContain('my-extra')
    expect(o.userEntries).toEqual(['my-extra'])
    expect(o.problems.join(' ')).toMatch(/bad\.json/)
    // a user definition may not point at plain http, even on this computer
    const insecure = entryOf('insecure', { files: [file('x', 'x.bin', 'loras', '/shared.bin')] })
    await fs.writeFile(join(work, 'model-library', 'insecure.json'), JSON.stringify(insecure))
    lib.reload()
    const again = await lib.overview()
    expect(again.entries.map((e) => e.entry.id)).not.toContain('insecure')
  })
})
