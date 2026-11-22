import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assessRuntime, buildProfile, detectProfile, inferNvidia, modelMemory, parseCudaDriver, parseNvidiaSmiRow, precisionsFor, simulatedProfile, SIMULATED, tierFor } from '../src/main/modelLibrary/hardware'
import { filesFor, loadCatalog, requirementsFor, validateEntry, totalBytes } from '../src/main/modelLibrary/catalog'
import { BUILT_IN } from '../src/main/modelLibrary/catalog/index'
import { assess, categoriesForTask, recommend } from '../src/main/modelLibrary/fit'

const catalog = (): ReturnType<typeof loadCatalog> => loadCatalog(BUILT_IN)
const entry = (id: string) => catalog().entries.find((e) => e.id === id)!
const profile = (id: string) => simulatedProfile(id)!

describe('hardware: reading the real thing', () => {
  it('parses nvidia-smi rows and the CUDA driver version', () => {
    expect(parseNvidiaSmiRow('NVIDIA GeForce RTX 2080, 8192, 576.80, 7.5')).toEqual({ name: 'NVIDIA GeForce RTX 2080', memoryMiB: 8192, driver: '576.80', capability: '7.5' })
    expect(parseNvidiaSmiRow('NVIDIA GeForce RTX 5090, 32607, 576.80, 12.0')?.capability).toBe('12.0')
    expect(parseNvidiaSmiRow('NVIDIA RTX Spark, [N/A], [N/A], 12.1')).toMatchObject({ memoryMiB: null, driver: null })
    expect(parseNvidiaSmiRow('')).toBeNull()
    expect(parseCudaDriver('| NVIDIA-SMI 576.80  Driver Version: 576.80  CUDA Version: 12.9 |')).toBe('12.9')
  })

  it('knows each generation and what it computes in hardware', () => {
    expect(inferNvidia('NVIDIA GeForce RTX 2080').family).toBe('turing')
    expect(inferNvidia('NVIDIA GeForce RTX 3060').family).toBe('ampere')
    expect(inferNvidia('NVIDIA GeForce RTX 4090').family).toBe('ada')
    expect(inferNvidia('NVIDIA GeForce RTX 5080').family).toBe('blackwell')
    expect(inferNvidia('NVIDIA RTX Spark').family).toBe('blackwell')
    expect(inferNvidia('NVIDIA GeForce GTX 1080 Ti').family).toBe('pascal')
    expect(precisionsFor('turing', '7.5')).toEqual({ fp16: true, bf16: false, fp8: false, fp4: false })
    expect(precisionsFor('ada', '8.9').fp8).toBe(true)
    expect(precisionsFor('blackwell', '12.0').fp4).toBe(true)
    expect(precisionsFor('pascal', '6.1').fp16).toBe(false)
  })

  it('detects this kind of computer from captured command output', async () => {
    const run = async (file: string, args: string[]): Promise<string> => {
      if (file === 'nvidia-smi' && args.includes('--query-gpu=name,memory.total,driver_version,compute_cap')) return 'NVIDIA GeForce RTX 2080, 8192, 576.80, 7.5\n'
      if (file === 'nvidia-smi') return '| NVIDIA-SMI 576.80   Driver Version: 576.80   CUDA Version: 12.9 |'
      if (file === 'powershell.exe' && args.join(' ').includes('Architecture')) return '9\n'
      if (file === 'powershell.exe') return 'NVIDIA GeForce RTX 2080|Microsoft Basic Display\n'
      return ''
    }
    const p = await detectProfile({ run, platform: 'win32', processArch: 'x64', env: {}, totalmem: 32 * 1024 ** 3, cpu: { name: 'Test CPU', cores: 16 }, release: '10.0.26100' })
    expect(p.arch).toBe('x64')
    expect(p.emulated).toBe(false)
    expect(p.primary).toMatchObject({ name: 'NVIDIA GeForce RTX 2080', vramGB: 8, memoryKind: 'dedicated', family: 'turing', cudaDriver: '12.9' })
    expect(p.modelMemoryGB).toBe(8)
    expect(p.tier).toBe('mainstream')
    expect(p.runtime.managedComfy).toBe('supported')
    expect(p.os.windowsBuild).toBe(26100)
    expect(p.gpus).toHaveLength(1) // a basic display adapter is not a graphics card for models
  })

  it('sees through emulation: an x64 Atlas on an Arm64 computer', async () => {
    const run = async (file: string, args: string[]): Promise<string> => (file === 'powershell.exe' && args.join(' ').includes('Architecture') ? '12\n' : file === 'powershell.exe' ? 'NVIDIA RTX Spark\n' : '')
    const p = await detectProfile({ run, platform: 'win32', processArch: 'x64', env: {}, totalmem: 128 * 1024 ** 3, cpu: { name: 'Arm64 CPU', cores: 20 }, release: '10.0.26100' })
    expect(p.arch).toBe('arm64')
    expect(p.appArch).toBe('x64')
    expect(p.emulated).toBe(true)
    expect(p.runtime.notes.join(' ')).toMatch(/emulation/)
  })
})

describe('hardware: simulated computers', () => {
  it('RTX 2080: 8 GB of dedicated memory, a supported Windows x64 setup', () => {
    const p = profile('rtx-2080')
    expect(p.simulated).toBe('rtx-2080')
    expect(p.primary!.memoryKind).toBe('dedicated')
    expect(p.modelMemoryGB).toBe(8)
    expect(p.precisions.bf16).toBe(false)
    expect(p.runtime.managedComfy).toBe('supported')
  })
  it('RTX 5080 and 5090: Blackwell with 4-bit maths; the installer is only “untested” until someone runs it on one', () => {
    for (const [id, gb] of [['rtx-5080', 16], ['rtx-5090', 32]] as const) {
      const p = profile(id)
      expect(p.primary!.family).toBe('blackwell')
      expect(p.precisions.fp4).toBe(true)
      expect(Math.round(p.modelMemoryGB!)).toBe(gb)
      expect(p.runtime.managedComfy).toBe('untested')
      expect(p.runtime.notes.join(' ')).toMatch(/CUDA 12\.8|570/)
    }
    expect(profile('rtx-5090').tier).toBe('workstation')
  })
  it('RTX 50-series with an old driver is told to update it first', () => {
    const raw = structuredClone(SIMULATED['rtx-5080']!.raw)
    raw.adapters[0]!.driver = '560.94'
    const p = buildProfile(raw)
    expect(p.runtime.managedComfy).toBe('untested')
    expect(p.runtime.managedComfyReason).toMatch(/older than 570/)
  })
  it('RTX Spark on Windows on Arm64: unified memory (not VRAM), and no x64 runtime is assumed to work', () => {
    const p = profile('rtx-spark-arm64')
    expect(p.arch).toBe('arm64')
    expect(p.primary!.memoryKind).toBe('unified')
    expect(p.primary!.vramGB).toBeNull() // no dedicated VRAM figure
    expect(p.ramGB).toBe(128)
    expect(p.modelMemoryGB).toBe(96) // 75% of the shared pool, the rest kept for Windows and programs
    expect(p.memoryNote).toMatch(/Unified memory/)
    expect(p.runtime.managedComfy).toBe('unsupported')
    expect(p.runtime.managedComfyReason).toMatch(/no official portable build for Windows on Arm/)
    expect(p.runtime.notes.join(' ')).toMatch(/x64 .*run only in emulation or not at all/)
    expect(p.tier).toBe('workstation')
    expect(p.precisions.fp4).toBe(true)
  })
  it('the same computer with Atlas running as x64 is flagged as emulated', () => {
    const p = profile('rtx-spark-arm64-emulated')
    expect(p.emulated).toBe(true)
    expect(p.runtime.notes.join(' ')).toMatch(/emulation/)
  })
  it('AMD, and a computer with no usable graphics', () => {
    expect(profile('amd-rx-7800').runtime.managedComfy).toBe('untested')
    const none = profile('no-gpu')
    expect(none.primary!.memoryKind).toBe('shared')
    expect(none.tier).toBe('mainstream' === none.tier ? 'mainstream' : none.tier)
    expect(none.modelMemoryGB).toBeLessThanOrEqual(8)
    expect(none.runtime.managedComfy).toBe('untested')
  })
  it('memory and tiers', () => {
    expect(tierFor(null)).toBe('none')
    expect(tierFor(5)).toBe('entry')
    expect(tierFor(8)).toBe('mainstream')
    expect(tierFor(16)).toBe('high')
    expect(tierFor(32)).toBe('workstation')
    expect(modelMemory(null, 16).gb).toBeNull()
    expect(assessRuntime({ os: { platform: 'linux', release: '', windowsBuild: null }, arch: 'x64', appArch: 'x64', emulated: false, primary: null }).managedComfy).toBe('unsupported')
  })
})

describe('the catalogue', () => {
  it('every built-in entry is valid, complete and has a source, a licence and honest verification', () => {
    const c = catalog()
    expect(c.problems).toEqual([])
    expect(c.entries.length).toBe(BUILT_IN.length)
    for (const e of c.entries) {
      expect(e.source.url).toMatch(/^https:\/\//)
      expect(e.licence.summary.length).toBeGreaterThan(20)
      if (e.verification.status === 'verified') expect(e.verification.checks.length).toBeGreaterThan(0)
      if (e.install.mode === 'managed') for (const f of [...e.files, ...(e.variants ?? []).flatMap((v) => v.files)]) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
    // every category of the brief is covered
    const covered = new Set(c.entries.flatMap((e) => e.categories))
    for (const k of ['generation', 'photoreal', 'artistic', 'editing', 'reference', 'upscaling', 'understanding']) expect(covered.has(k as never)).toBe(true)
  })

  it('refuses entries that are incomplete or unsafe, and says why', () => {
    const good = JSON.parse(JSON.stringify(entry('realesrgan-x4plus')))
    expect(validateEntry(good).entry).not.toBeNull()
    const bad = (patch: (e: Record<string, unknown>) => void): string => {
      const e = JSON.parse(JSON.stringify(good)) as Record<string, unknown>
      patch(e)
      return validateEntry(e).errors.join(' | ')
    }
    expect(bad((e) => { (e.files as Array<Record<string, unknown>>)[0]!.url = 'http://example.com/x.pth' })).toMatch(/url \(https only\)/)
    expect(bad((e) => { (e.files as Array<Record<string, unknown>>)[0]!.sha256 = 'abc' })).toMatch(/sha256/)
    expect(bad((e) => { (e.files as Array<Record<string, unknown>>)[0]!.name = '..\\evil.pth' })).toMatch(/name/)
    expect(bad((e) => { (e.files as Array<Record<string, unknown>>)[0]!.folder = 'C:\\Windows' })).toMatch(/folder/)
    expect(bad((e) => { delete e.licence })).toMatch(/licence/)
    expect(bad((e) => { delete e.source })).toMatch(/official source/)
    expect(bad((e) => { e.verification = { status: 'verified', checks: [] } })).toMatch(/must list the tests/)
    expect(bad((e) => { e.verification = { status: 'proven' } })).toMatch(/verification\.status/)
    expect(bad((e) => { e.schema = 99 })).toMatch(/schema/)
    expect(bad((e) => { e.id = 'Has Spaces' })).toMatch(/id must be/)
    expect(bad((e) => { e.categories = ['nope'] })).toMatch(/category/)
    expect(bad((e) => { e.install = { mode: 'manual' } })).toMatch(/instructions/)
  })

  it('takes new definitions from the user\'s folder without rebuilding, replaces built-ins by id, and reports broken files', async () => {
    const dir = join(tmpdir(), `noema-catalog-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    const mine = { ...JSON.parse(JSON.stringify(entry('realesrgan-x4plus'))), id: 'my-upscaler', name: 'My upscaler', files: [{ key: 'my-up', name: 'my_up.pth', folder: 'upscale_models', url: 'https://example.com/my_up.pth', bytes: 1000, sha256: 'a'.repeat(64) }] }
    await fs.writeFile(join(dir, 'mine.json'), JSON.stringify(mine))
    const replaced = { ...JSON.parse(JSON.stringify(entry('sd15-base'))), name: 'Stable Diffusion 1.5 (my notes)' }
    await fs.writeFile(join(dir, 'list.json'), JSON.stringify([replaced, { id: 'broken' }]))
    await fs.writeFile(join(dir, 'garbage.json'), '{ not json')
    const c = loadCatalog(BUILT_IN, dir)
    expect(c.entries.find((e) => e.id === 'my-upscaler')?.name).toBe('My upscaler')
    expect(c.entries.find((e) => e.id === 'sd15-base')?.name).toBe('Stable Diffusion 1.5 (my notes)')
    expect(c.userIds.sort()).toEqual(['my-upscaler', 'sd15-base'])
    expect(c.problems.join(' ')).toMatch(/not valid JSON/)
    expect(c.problems.join(' ')).toMatch(/list\.json\[1\]/)
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('flags a dependency that is not in the catalogue, and chooses the files of a variant', () => {
    const e = JSON.parse(JSON.stringify(entry('realesrgan-x4plus')))
    e.dependsOn = ['nothing-like-it']
    expect(loadCatalog([e]).problems.join(' ')).toMatch(/depends on “nothing-like-it”/)
    const krea = entry('krea2-turbo')
    expect(filesFor(krea, 'nvfp4')[0]!.name).toBe('krea2_turbo_nvfp4.safetensors')
    expect(filesFor(krea, 'int8')[0]!.name).toBe('krea2_turbo_int8_convrot.safetensors')
    expect(requirementsFor(krea, 'nvfp4').gpuFamilies).toEqual(['blackwell'])
    expect(totalBytes(filesFor(krea, 'nvfp4'))).toBeLessThan(totalBytes(filesFor(krea, 'int8')))
  })
})

describe('what suits which computer', () => {
  it('FLUX.2 [klein] 4B on an 8 GB card: works, but slowly; comfortable on 16 GB and up', () => {
    const e = entry('flux2-klein-4b')
    expect(assess(e, profile('rtx-2080')).level).toBe('slow')
    expect(assess(e, profile('rtx-3060')).level).toBe('works') // 12 GB: above the minimum, near comfortable
    expect(assess(e, profile('rtx-5080')).level).toBe('recommended')
    expect(assess(e, profile('rtx-5090')).level).toBe('recommended')
    expect(assess(e, profile('no-gpu')).level).not.toMatch(/recommended|works/)
  })
  it('chooses the build that suits the card: 4-bit on RTX 50-series, 8-bit on earlier cards, none where neither fits', () => {
    const k = entry('krea2-turbo')
    expect(assess(k, profile('rtx-5090'))).toMatchObject({ level: 'recommended', variant: 'nvfp4' })
    expect(assess(k, profile('rtx-4090')).variant).toBe('int8')
    expect(assess(k, profile('rtx-4090')).level).toBe('recommended')
    expect(assess(k, profile('rtx-2080')).level).toBe('slow') // 13.5 GB of model on an 8 GB card: mostly in system memory
    expect(assess(k, profile('rtx-2080')).reasons.join(' ')).toMatch(/system memory/)
    expect(assess(k, profile('no-gpu')).level).toBe('too-big') // integrated graphics share a small part of system memory
  })
  it('the 4-bit build is never offered to a card that cannot compute it', () => {
    const k = entry('krea2-turbo')
    const only4bit = { ...k, variants: k.variants!.filter((v) => v.id === 'nvfp4') }
    expect(assess(only4bit, profile('rtx-4090')).level).toBe('incompatible')
    expect(assess(only4bit, profile('rtx-4090')).reasons.join(' ')).toMatch(/RTX 50-series/)
  })
  it('on RTX Spark (Arm64, unified memory) models fit by the shared memory, with an honest caveat about the runtime', () => {
    const p = profile('rtx-spark-arm64')
    const f = assess(entry('flux2-klein-4b'), p)
    expect(f.level).toBe('works') // plenty of memory, but never “recommended” on a runtime Atlas has not tested
    expect(f.reasons.join(' ')).toMatch(/unified memory/)
    expect(f.reasons.join(' ')).toMatch(/Arm64|arm64/)
    expect(f.reasons.join(' ')).toMatch(/cannot install ComfyUI on this computer itself/)
    expect(f.testedHere).toBe(false)
    // an entry whose runtime is cross-platform is judged by memory alone
    expect(assess(entry('ollama-gemma3-4b'), p).level).toBe('recommended')
  })
  it('only claims “tested on this hardware” for a real computer that matches the test, never a simulation', () => {
    const e = JSON.parse(JSON.stringify(entry('flux2-klein-4b')))
    e.verification = { status: 'verified', checks: [{ hardware: 'NVIDIA GeForce RTX 2080 (8 GB), Windows 11 x64', date: '2026-11-20', result: 'Made a picture from four references in 147 s', how: 'Atlas e2e' }] }
    const real = buildProfile({ ...SIMULATED['rtx-2080']!.raw }) // not marked simulated
    expect(assess(e, real).testedHere).toBe(true)
    expect(assess(e, real).testedNote).toMatch(/147 s/)
    expect(assess(e, profile('rtx-2080')).testedHere).toBe(false)
    expect(assess(e, buildProfile({ ...SIMULATED['rtx-5090']!.raw })).testedHere).toBe(false)
  })
  it('recommends by task, hardware and preferences', () => {
    const entries = catalog().entries
    const p = profile('rtx-2080')
    expect(categoriesForTask('I want a realistic portrait photo')).toContain('photoreal')
    expect(categoriesForTask('use my moodboard pictures as references')).toContain('reference')
    expect(categoriesForTask('enlarge to 4K with more detail')).toContain('upscaling')
    expect(categoriesForTask('what can look at my pictures and describe them')).toContain('understanding')
    const reference = recommend(entries, p, { categories: ['reference'] })
    expect(reference[0]!.entry.id).toBe('flux2-klein-4b')
    const photoreal = recommend(entries, p, { categories: ['photoreal'] })
    expect(photoreal.map((r) => r.entry.id)).toContain('realvisxl-v4')
    const commercial = recommend(entries, profile('rtx-5090'), { categories: ['reference'], preferences: { commercial: true } })
    expect(commercial.map((r) => r.entry.id)).not.toContain('flux2-klein-9b') // non-commercial licence
    const small = recommend(entries, p, { categories: ['generation'], preferences: { maxDownloadGB: 3 } })
    expect(small.every((r) => (r.entry.files.reduce((s, f) => s + f.bytes, 0) || 0) / 1e9 <= 3)).toBe(true)
    // nothing too large or incompatible is recommended
    // a model that would run slowly is listed, but after the ones that suit the computer
    const ids = recommend(entries, p, { categories: ['generation'] }).map((r) => r.entry.id)
    expect(ids.indexOf('krea2-turbo')).toBeGreaterThan(ids.indexOf('sd15-base'))
    expect(ids.indexOf('krea2-turbo')).toBeGreaterThan(ids.indexOf('realvisxl-v4'))
    expect(recommend(entries, profile('rtx-5090'), { categories: ['generation'] }).map((r) => r.entry.id)).toContain('krea2-turbo')
  })
})
