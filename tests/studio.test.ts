import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { RootFolder } from '../src/shared/types'
import type { SecretBox } from '../src/main/assistant/settings'
import { applyMood, blendArtwork, readMood } from '../src/main/studio/blend'
import { developConcept, colourName } from '../src/main/studio/concept'
import { BoardEditor } from '../src/main/studio/boardEdit'
import { fillWorkflow, standardWorkflow, type FetchFn } from '../src/main/studio/comfy'
import { retargetUpscale } from '../src/main/studio/comfyWorkflows'
import { Studio } from '../src/main/studio/studio'
import { AssistantSettingsStore } from '../src/main/assistant/settings'
import { AssistantEngine } from '../src/main/assistant/engine'
import { SemanticSearch } from '../src/main/semantic'
import type { Embedder } from '../src/main/embedder'

const fakeBox: SecretBox = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').reverse().map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(Buffer.from(data).map((b) => b ^ 0x5a)).reverse().toString('utf8')
}

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** A real picture with structure (a gradient and a bright bar), so grading can be checked against it. */
async function paint(path: string, colours: [number, number, number], w = 480, h = 320): Promise<void> {
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3
      const g = 0.35 + 0.65 * (y / h)
      const bar = x > w * 0.45 && x < w * 0.55 ? 1.35 : 1
      raw[i] = Math.min(255, colours[0] * g * bar)
      raw[i + 1] = Math.min(255, colours[1] * g * bar)
      raw[i + 2] = Math.min(255, colours[2] * g * bar)
    }
  }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path)
}

const luma = async (input: string | Buffer): Promise<{ mean: number; data: Float64Array }> => {
  const { data } = await sharp(input).resize(48, 32, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const arr = Float64Array.from(data)
  return { mean: arr.reduce((s, v) => s + v, 0) / arr.length, data: arr }
}
const correlation = (a: Float64Array, b: Float64Array): number => {
  const ma = a.reduce((s, v) => s + v, 0) / a.length
  const mb = b.reduce((s, v) => s + v, 0) / b.length
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i += 1) {
    num += (a[i]! - ma) * (b[i]! - mb)
    da += (a[i]! - ma) ** 2
    db += (b[i]! - mb) ** 2
  }
  return num / Math.sqrt(da * db || 1)
}
const channelMean = async (input: string | Buffer): Promise<number[]> => (await sharp(input).stats()).channels.slice(0, 3).map((c) => c.mean)

describe('Atlas Blend and mood grading (real pixels)', () => {
  let dir = ''
  beforeEach(async () => {
    dir = join(tmpdir(), `noema-blend-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(dir, { recursive: true })
  })
  afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

  it('reads moods in English and Swedish and scales them by strength', () => {
    expect(readMood('make it more mysterious').understood).toContain('more mysterious')
    expect(readMood('mer mystisk och dimmig').understood).toEqual(expect.arrayContaining(['more mysterious', 'misty']))
    expect(readMood('warmer and brighter').grade[0]).toBeGreaterThan(1)
    expect(readMood('something unrelated').understood).toHaveLength(0)
    const light = readMood('mysterious', 0.2)
    const strong = readMood('mysterious', 1)
    expect(strong.brightness).toBeLessThan(light.brightness)
    expect(strong.vignette).toBeGreaterThan(light.vignette)
  })

  it('a mysterious edit darkens the picture but keeps its structure', async () => {
    const src = join(dir, 'building.png')
    await paint(src, [200, 190, 170])
    const original = await fs.readFile(src)
    const edited = await applyMood(original, readMood('Make the atmosphere more mysterious, but preserve the architecture', 0.7))
    const before = await luma(original)
    const after = await luma(edited)
    expect(after.mean).toBeLessThan(before.mean * 0.92)
    // The composition is kept: the grey-level layout still correlates strongly with the original.
    expect(correlation(before.data, after.data)).toBeGreaterThan(0.8)
    const meta = await sharp(edited).metadata()
    expect(meta.width).toBe(480)
    expect(meta.height).toBe(320)
  })

  it('blends composition, colour and atmosphere into a new picture, deterministically by seed', async () => {
    const comp = join(dir, 'comp.png')
    const warm = join(dir, 'warm.png')
    const mist = join(dir, 'mist.png')
    await paint(comp, [60, 90, 200])
    await paint(warm, [230, 140, 40])
    await paint(mist, [150, 150, 160])
    const refs = [
      { path: comp, roles: ['composition' as const] },
      { path: warm, roles: ['colour' as const] },
      { path: mist, roles: ['atmosphere' as const] }
    ]
    const a = await blendArtwork({ refs, width: 640, height: 400, seed: 11, mood: 'surreal and misty' })
    const b = await blendArtwork({ refs, width: 640, height: 400, seed: 11, mood: 'surreal and misty' })
    const c = await blendArtwork({ refs, width: 640, height: 400, seed: 12, mood: 'surreal and misty' })
    const meta = await sharp(a).metadata()
    expect([meta.width, meta.height, meta.format]).toEqual([640, 400, 'png'])
    expect(createHash('sha256').update(a).digest('hex')).toBe(createHash('sha256').update(b).digest('hex'))
    expect(createHash('sha256').update(a).digest('hex')).not.toBe(createHash('sha256').update(c).digest('hex'))
    // The colour reference moved the blue composition towards its orange palette.
    const [r0, , b0] = await channelMean(comp)
    const [r1, , b1] = await channelMean(a)
    expect(r1! - b1!).toBeGreaterThan(r0! - b0! + 40)
  })
})

describe('concepts', () => {
  const img = (id: string, color: string, w: number, h: number, filename = `${id}.jpg`) =>
    ({ id, color, width: w, height: h, filename, tags: [], missing: false }) as never

  it('develops a prompt from roles, palette, mood and composition', () => {
    const images = [img('a', '#d99a2b', 1600, 900), img('b', '#1d5f66', 900, 1200), img('c', '#8a8d93', 1000, 1000)]
    const concept = developConcept(
      { moodboardId: 'm', intent: 'Create a new surreal landscape inspired by this moodboard', roles: { a: ['composition'], b: ['colour'], c: ['atmosphere'] } },
      images,
      { c: { mood: 'misty', style: 'romantic' } },
      'Quiet Valleys'
    )
    expect(concept.prompt).toMatch(/^Surreal landscape/)
    expect(concept.prompt).toMatch(/misty atmosphere/)
    expect(concept.prompt).toMatch(/teal/)
    expect(concept.aspect).toBe('wide')
    expect(concept.width).toBeGreaterThan(concept.height)
    expect(concept.notes.some((n) => n.startsWith('Composition follows a.jpg'))).toBe(true)
    expect(concept.variations).toHaveLength(3)
    expect(concept.prompt).not.toMatch(/a\.jpg|inspired by this moodboard/)
    expect(colourName('#1d5f66')).toBe('teal')
  })
})

describe('Creative Studio', () => {
  let work = ''
  let db: AtlasDatabase
  let studio: Studio
  let root: RootFolder
  let fetchCalls: Array<{ url: string; init?: Record<string, unknown> }>
  let fetchImpl: FetchFn
  const progress: Array<{ stage: string }> = []
  let ids: string[] = []

  /** Stands in for the scanner: puts any new picture in the studio folder into the library. */
  const scan = (r: RootFolder): void => {
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(png|jpe?g|tiff?|webp)$/i.test(name) && !db.getImageByPath(p)) {
          void sharp(p).metadata().then((m) =>
            db.upsertScannedImage({ id: imageIdForPath(p), rootId: r.id, path: p, folder: d, filename: name, ext: 'png', bytes: statSync(p).size, width: m.width ?? 0, height: m.height ?? 0, orientation: 1, mtime: statSync(p).mtimeMs, color: '#808080', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
          )
        }
      }
    }
    walk(r.path)
  }

  const makeStudio = (extra: Partial<ConstructorParameters<typeof Studio>[0]> = {}): Studio =>
    new Studio({
      db,
      dataDir: join(work, 'data'),
      studioDir: join(work, 'studio'),
      box: fakeBox,
      fetchImpl: (url, init) => fetchImpl(url, init),
      enqueueScan: scan,
      broadcast: (channel, payload) => {
        if (channel === 'studio:progress') progress.push(payload as { stage: string })
      },
      notifyChanged: () => undefined,
      importWaitMs: 8000,
      ...extra
    })

  beforeEach(async () => {
    work = join(tmpdir(), `noema-studio-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(work, 'refs'), { recursive: true })
    db = new AtlasDatabase(join(work, 'library.db'))
    root = db.addRoot(join(work, 'refs'))
    ids = []
    const colours: Array<[string, [number, number, number]]> = [['sky', [80, 120, 210]], ['amber', [230, 150, 50]], ['mist', [150, 152, 160]]]
    for (const [name, c] of colours) {
      const p = join(work, 'refs', `${name}.png`)
      await paint(p, c)
      db.upsertScannedImage({ id: imageIdForPath(p), rootId: root.id, path: p, folder: join(work, 'refs'), filename: `${name}.png`, ext: 'png', bytes: statSync(p).size, width: 480, height: 320, orientation: 1, mtime: statSync(p).mtimeMs, color: name === 'sky' ? '#5078d2' : name === 'amber' ? '#e69632' : '#9698a0', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
      ids.push(imageIdForPath(p))
    }
    const board = db.createMoodboard('Quiet Valleys')
    db.addToMoodboard(board.id, ids, [])
    fetchCalls = []
    fetchImpl = async (url, init) => {
      fetchCalls.push({ url, init })
      throw new Error('offline')
    }
    progress.length = 0
    studio = makeStudio()
  })

  afterEach(async () => {
    studio.dispose()
    db.close()
    await fs.rm(work, { recursive: true, force: true })
  })

  const board = (): string => db.listMoodboards()[0]!.id
  const roles = (): Record<string, Array<'atmosphere' | 'composition' | 'colour' | 'subject'>> => ({ [ids[0]!]: ['composition'], [ids[1]!]: ['colour'], [ids[2]!]: ['atmosphere'] })
  const request = (over: Record<string, unknown> = {}) => ({ methodId: 'blend' as const, moodboardId: board(), title: 'Amber valley', prompt: 'A surreal valley, misty', negative: '', width: 640, height: 416, count: 1, roles: roles(), approvedCost: 0, approvedUpload: false, ...over })

  it('lists methods: Atlas Blend always works, others say why not', async () => {
    const methods = await studio.methods()
    expect(methods.find((m) => m.id === 'blend')!.available).toBe(true)
    const comfy = methods.find((m) => m.id === 'comfyui')!
    expect(comfy.available).toBe(false)
    expect(comfy.reason).toMatch(/Set up ComfyUI once|not running/)
    const cloud = methods.find((m) => m.id === 'openai')!
    expect(cloud.available).toBe(false)
    expect(cloud.reason).toMatch(/key/)
  })

  it('makes a real picture from a moodboard, saves it in the library and links it to its sources', async () => {
    const originals = ids.map((id) => sha(db.getImage(id)!.path))
    const result = await studio.generate(request())
    expect(result.ok).toBe(true)
    const record = result.records[0]!
    expect(record.imageId).toBeTruthy()
    const image = db.getImage(record.imageId!)!
    expect(existsSync(image.path)).toBe(true)
    expect(image.path.startsWith(join(work, 'studio'))).toBe(true)
    expect((await sharp(image.path).metadata()).width).toBe(640)
    // The sources are untouched.
    expect(ids.map((id) => sha(db.getImage(id)!.path))).toEqual(originals)
    const info = studio.provenance(record.imageId!)!
    expect(info.record.moodboardName).toBe('Quiet Valleys')
    expect(info.sources.map((s) => s.id).sort()).toEqual([...ids].sort())
    expect(info.sources.find((s) => s.id === ids[1])!.roles).toEqual(['colour'])
    expect(progress.some((p) => p.stage === 'done')).toBe(true)
  })

  it('variations grow out of their parent and stay in one series', async () => {
    const first = (await studio.generate(request())).records[0]!
    const second = (await studio.generate(request({ parentId: first.id, seed: 99 }))).records[0]!
    expect(second.parentId).toBe(first.id)
    expect(second.seriesId).toBe(first.seriesId)
    const series = studio.provenance(second.imageId!)!.series
    expect(series.map((r) => r.id)).toEqual([first.id, second.id])
    expect(sha(db.getImage(first.imageId!)!.path)).not.toBe(sha(db.getImage(second.imageId!)!.path))
  })

  it('makes several pictures in one go', async () => {
    const result = await studio.generate(request({ count: 3 }))
    expect(result.records).toHaveLength(3)
    expect(new Set(result.records.map((r) => r.seed)).size).toBe(3)
  })

  it('cloud generation needs a key, a budget, the price approved and the upload agreed', async () => {
    studio.update({ cloudKey: 'sk-test-key', monthlyBudget: 0.1 })
    expect(existsSync(join(work, 'data', 'studio', 'settings.json'))).toBe(true)
    expect(readFileSync(join(work, 'data', 'studio', 'settings.json'), 'utf8')).not.toContain('sk-test-key')
    expect(readFileSync(join(work, 'data', 'studio', 'cloud-key.bin')).includes(Buffer.from('sk-test-key'))).toBe(false)
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#a33' } }).png().toBuffer()
    fetchImpl = async (url, init) => {
      fetchCalls.push({ url, init })
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 })
    }
    expect((await studio.generate(request({ methodId: 'openai', approvedCost: 0.07, approvedUpload: false }))).message).toMatch(/agree to send/)
    expect((await studio.generate(request({ methodId: 'openai', approvedCost: 0.01, approvedUpload: true }))).message).toMatch(/more than the/)
    expect(fetchCalls.filter((c) => !c.url.includes('127.0.0.1'))).toHaveLength(0)
    const ok = await studio.generate(request({ methodId: 'openai', approvedCost: 0.07, approvedUpload: true }))
    expect(ok.ok).toBe(true)
    const cloudCalls = fetchCalls.filter((c) => !c.url.includes('127.0.0.1'))
    const sent = JSON.parse(String(cloudCalls[0]!.init!.body)) as Record<string, unknown>
    expect(cloudCalls[0]!.url).toBe('https://api.openai.com/v1/images/generations')
    // Only the prompt goes out: no picture data, no paths.
    expect(Object.keys(sent).sort()).toEqual(['model', 'n', 'prompt', 'quality', 'size'])
    expect((cloudCalls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer sk-test-key')
    expect((await studio.settings()).spentThisMonth).toBeGreaterThan(0.05)
    // The limit is enforced: a second picture would pass $0.10.
    const again = await studio.generate(request({ methodId: 'openai', count: 2, approvedCost: 1, approvedUpload: true }))
    expect(again.ok).toBe(false)
    expect(again.message).toMatch(/monthly limit/)
  })

  it('a monthly limit of zero keeps paid services switched off', async () => {
    studio.update({ cloudKey: 'sk-x', monthlyBudget: 0 })
    const cloud = (await studio.methods()).find((m) => m.id === 'openai')!
    expect(cloud.available).toBe(false)
    expect(cloud.reason).toMatch(/monthly limit/)
  })

  it('talks to ComfyUI: finds checkpoints, queues a workflow, fetches the picture, and refines from a parent', async () => {
    const out = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#357' } }).png().toBuffer()
    const queued: Array<Record<string, { class_type: string; inputs: Record<string, unknown> }>> = []
    let uploads = 0
    fetchImpl = async (url, init) => {
      fetchCalls.push({ url, init })
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
      if (url.endsWith('/system_stats')) return json({ system: {} })
      if (url.endsWith('/object_info/CheckpointLoaderSimple')) return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['dreamy-v1.safetensors', 'other.ckpt']] } } } })
      if (url.endsWith('/upload/image')) {
        uploads += 1
        return json({ name: 'uploaded.png' })
      }
      if (url.endsWith('/prompt')) {
        queued.push((JSON.parse(String(init!.body)) as { prompt: never }).prompt)
        return json({ prompt_id: `p${queued.length}` })
      }
      if (url.includes('/history/')) return json({ [url.split('/').pop()!]: { status: { status_str: 'success' }, outputs: { '7': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } })
      if (url.includes('/view')) return new Response(new Uint8Array(out), { status: 200 })
      return json({}, 404)
    }
    const methods = await studio.methods()
    const comfy = methods.find((m) => m.id === 'comfyui')!
    expect(comfy.available).toBe(true)
    expect(comfy.models).toEqual(['dreamy-v1.safetensors', 'other.ckpt'])

    const first = await studio.generate(request({ methodId: 'comfyui', model: 'dreamy-v1.safetensors', negative: 'blurry', width: 640, height: 416 }))
    expect(first.ok).toBe(true)
    const wf = queued[0]!
    expect(wf['1']!.inputs.ckpt_name).toBe('dreamy-v1.safetensors')
    expect(wf['2']!.inputs.text).toBe('A surreal valley, misty')
    expect(wf['3']!.inputs.text).toBe('blurry')
    expect(wf['4']!.class_type).toBe('EmptyLatentImage')
    expect(wf['5']!.inputs.denoise).toBe(1)
    expect(uploads).toBe(0)
    // Nothing leaves the computer for a local method: only the ComfyUI address was contacted.
    expect(fetchCalls.every((c) => c.url.startsWith('http://127.0.0.1:8188'))).toBe(true)

    const second = await studio.generate(request({ methodId: 'comfyui', model: 'dreamy-v1.safetensors', parentId: first.records[0]!.id, strength: 0.4 }))
    expect(second.ok).toBe(true)
    expect(uploads).toBe(1)
    expect(queued[1]!['4']!.class_type).toBe('VAEEncode')
    expect(queued[1]!['5']!.inputs.denoise).toBeCloseTo(0.4)
    expect(second.records[0]!.parentId).toBe(first.records[0]!.id)

    const remote = 'https://studio.example.invalid'
    const previousJobs = queued.length
    studio.update({ comfyUrl: remote })
    expect(studio.estimate('comfyui', undefined, 1, 512, 512).leavesComputer).toBe(true)
    expect((await studio.methods()).find((m) => m.id === 'comfyui')?.kind).toBe('cloud')
    const remoteRequest = request({ methodId: 'comfyui', parentId: first.records[0]!.id, approvedUpload: true })
    expect((await studio.generate(remoteRequest)).ok).toBe(false)
    expect(uploads).toBe(1)
    expect(queued).toHaveLength(previousJobs)
    studio.update({ approvedComfyUrl: remote })
    expect((await studio.generate({ ...remoteRequest, approvedUpload: false })).ok).toBe(false)
    expect((await studio.generate(remoteRequest)).ok).toBe(true)
    expect(uploads).toBe(2)
    const plan = await studio.runPlan(ids[0]!, [{ label: 'Darken', op: 'edit', instruction: 'darker' }])
    expect(plan.ok).toBe(true)
    expect(uploads).toBe(2)
    studio.update({ comfyUrl: 'https://different.example.invalid' })
    expect((await studio.generate(remoteRequest)).ok).toBe(false)
    expect(queued).toHaveLength(previousJobs + 1)
    expect(uploads).toBe(2)
  })

  it('fills placeholders in a workflow exported from ComfyUI', () => {
    const filled = fillWorkflow({ a: { class_type: 'X', inputs: { text: '{{prompt}}', seed: '{{seed}}', mix: 'a {{negative}} b' } } }, { prompt: 'hi', seed: 5, negative: 'n' })
    expect(filled.a!.inputs).toEqual({ text: 'hi', seed: 5, mix: 'a n b' })
    expect(Object.keys(standardWorkflow({ checkpoint: 'c', prompt: 'p', negative: 'n', seed: 1, width: 512, height: 512 }))).toEqual(expect.arrayContaining(['1', '2', '3', '4', '5', '6', '7']))
  })

  it('edits are previewed first, saved as a new version, and never touch the original', async () => {
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const preview = await studio.edit({ imageId: source.id, methodId: 'blend', instruction: 'Make the atmosphere more mysterious, but preserve the architecture', strength: 0.7, approvedCost: 0, approvedUpload: false })
    expect(preview.ok).toBe(true)
    expect(preview.previewUrl).toMatch(/^data:image\/jpeg;base64,/)
    expect(preview.summary).toMatch(/more mysterious/)
    // A preview saves nothing.
    expect(studio.generations()).toHaveLength(0)
    expect(existsSync(join(work, 'studio', 'edits'))).toBe(false)
    const saved = await studio.commitEdit(preview.pendingId!)
    expect(saved.ok).toBe(true)
    const record = saved.records[0]!
    expect(record.kind).toBe('edit')
    expect(record.sourceImageIds).toEqual([source.id])
    expect(db.getImage(record.imageId!)!.path).not.toBe(source.path)
    expect(sha(source.path)).toBe(before)
    expect((await luma(db.getImage(record.imageId!)!.path)).mean).toBeLessThan((await luma(source.path)).mean)
    // A discarded preview leaves nothing behind.
    const second = await studio.edit({ imageId: source.id, methodId: 'blend', instruction: 'warmer', strength: 0.5, approvedCost: 0, approvedUpload: false })
    studio.discardEdit(second.pendingId!)
    expect((await studio.commitEdit(second.pendingId!)).ok).toBe(false)
  })

  it('makes a larger linked copy with a plain enlargement and never touches the original', async () => {
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const result = await studio.upscale({ imageId: source.id, workflowId: null, targetLongEdge: 1440 })
    expect(result.ok).toBe(true)
    const record = result.records[0]!
    expect(record.kind).toBe('upscale')
    expect(record.sourceImageIds).toEqual([source.id])
    expect(record.model).toBe('Plain enlarge')
    expect([record.width, record.height]).toEqual([1440, 960])
    const made = db.getImage(record.imageId!)!
    expect((await sharp(made.path).metadata()).width).toBe(1440)
    expect(made.path.startsWith(join(work, 'studio', 'upscaled'))).toBe(true)
    expect(sha(source.path)).toBe(before)
    expect(studio.provenance(record.imageId!)!.record.note).toMatch(/adds no new detail/)
  })

  it('refuses sizes that are too small, too large or unknown workflows', async () => {
    expect((await studio.upscale({ imageId: ids[0]!, workflowId: null, targetLongEdge: 100 })).ok).toBe(false)
    expect((await studio.upscale({ imageId: ids[0]!, workflowId: null, targetLongEdge: 99999 })).message).toMatch(/between 256/)
    expect((await studio.upscale({ imageId: ids[0]!, workflowId: 'nope', targetLongEdge: 1000 })).message).toMatch(/not in the list/)
  })

  it('sets only the scale step of a model-based upscaling graph from the target size', () => {
    const graph = {
      '1': { class_type: 'LoadImage', inputs: { image: 'a.png' } },
      '2': { class_type: 'UpscaleModelLoader', inputs: { model_name: '4xNomosUniDAT_otf.pth' } },
      '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
      '4': { class_type: 'ImageScaleBy', inputs: { upscale_method: 'lanczos', scale_by: 0.6, image: ['3', 0] } },
      '5': { class_type: 'KSampler', inputs: { seed: 7, denoise: 0.22 } }
    }
    const out = retargetUpscale(graph, 1000, 3000)!
    expect(out.scaleBy).toBe(0.75)
    expect(out.workflow['4']!.inputs.scale_by).toBe(0.75)
    expect(out.workflow['5']).toEqual(graph['5'])
    expect(graph['4']!.inputs.scale_by).toBe(0.6)
    expect(retargetUpscale({ '1': graph['1'] }, 1000, 3000)).toBeNull()
  })

  it('tells the user what Atlas Blend cannot do instead of pretending', async () => {
    const result = await studio.edit({ imageId: ids[0]!, methodId: 'blend', instruction: 'add a dragon on the roof', strength: 0.5, approvedCost: 0, approvedUpload: false })
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/understands moods/)
  })

  it('a cloud edit sends the picture only after the user agrees', async () => {
    studio.update({ cloudKey: 'sk-test', monthlyBudget: 1 })
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#255' } }).png().toBuffer()
    fetchImpl = async (url, init) => {
      fetchCalls.push({ url, init })
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 })
    }
    const refused = await studio.edit({ imageId: ids[0]!, methodId: 'openai', instruction: 'more dramatic sky', strength: 0.5, approvedCost: 0.1, approvedUpload: false })
    expect(refused.ok).toBe(false)
    expect(fetchCalls.filter((c) => !c.url.includes('127.0.0.1'))).toHaveLength(0)
    const allowed = await studio.edit({ imageId: ids[0]!, methodId: 'openai', instruction: 'more dramatic sky', strength: 0.5, approvedCost: 0.1, approvedUpload: true })
    expect(allowed.ok).toBe(true)
    const editCall = fetchCalls.find((c) => c.url.endsWith('/images/edits'))!
    expect(editCall).toBeTruthy()
    expect(editCall.init!.body).toBeInstanceOf(FormData)
  })

  it('imports a picture edited in another program as a linked new version', async () => {
    let working = ''
    const external = makeStudio({
      openPath: async (path) => {
        working = path
        // The "program" saves a changed picture into the working copy.
        await sharp(path).modulate({ brightness: 0.5 }).png().toFile(`${path}.tmp`)
        await fs.rename(`${path}.tmp`, path)
        return ''
      }
    })
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const session = await external.startExternalEdit(source.id, null)
    expect(session.workingFile).toBe(working)
    expect(working).not.toBe(source.path)
    const done = await external.importExternal(session.id)
    expect(done.status).toBe('imported')
    expect(done.importedImageId).toBeTruthy()
    const info = external.provenance(done.importedImageId!)!
    expect(info.record.kind).toBe('external')
    expect(info.record.sourceImageIds).toEqual([source.id])
    expect(sha(source.path)).toBe(before)
    external.endExternal(session.id)
    external.dispose()
  })

  // ---- external editing: detection, reliability, honesty ---------------------------------------------------------------------

  /** A minimal Photoshop file: header, empty sections, then the flattened picture (raw, or RLE). */
  const makePsd = (w: number, h: number, rgb: Buffer, rle = false, depth: 8 | 16 = 8): Buffer => {
    const header = Buffer.alloc(26)
    header.write('8BPS', 0, 'latin1')
    header.writeUInt16BE(1, 4)
    header.writeUInt16BE(3, 12)
    header.writeUInt32BE(h, 14)
    header.writeUInt32BE(w, 18)
    header.writeUInt16BE(depth, 22)
    header.writeUInt16BE(3, 24)
    const empty = Buffer.alloc(12) // colour mode data, image resources, layer and mask information: three empty sections
    const planes: Buffer[] = []
    for (let c = 0; c < 3; c += 1) {
      const plane = Buffer.alloc(w * h * (depth / 8))
      for (let i = 0; i < w * h; i += 1) {
        if (depth === 8) plane[i] = rgb[i * 3 + c]!
        else { plane[i * 2] = rgb[i * 3 + c]!; plane[i * 2 + 1] = 0x80 }
      }
      planes.push(plane)
    }
    if (!rle) {
      const comp = Buffer.alloc(2)
      return Buffer.concat([header, empty, comp, ...planes])
    }
    const counts = Buffer.alloc(3 * h * 2)
    const rows: Buffer[] = []
    for (let c = 0; c < 3; c += 1) {
      for (let y = 0; y < h; y += 1) {
        // PackBits, literal runs only (valid, and exercises the decoder's copy path), plus a repeat run for flat rows.
        const row = planes[c]!.subarray(y * w, (y + 1) * w)
        const flat = row.every((v) => v === row[0])
        const out = flat ? Buffer.from([(257 - w) & 0xff, row[0]!]) : Buffer.concat([Buffer.from([w - 1]), row])
        counts.writeUInt16BE(out.length, (c * h + y) * 2)
        rows.push(out)
      }
    }
    const comp = Buffer.alloc(2)
    comp.writeUInt16BE(1)
    return Buffer.concat([header, empty, comp, counts, ...rows])
  }

  const waitUntil = async (test: () => boolean, ms = 8000): Promise<void> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return
      await new Promise((r) => setTimeout(r, 30))
    }
    throw new Error('Timed out waiting.')
  }

  const externalStudio = (events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }>, extra: Partial<ConstructorParameters<typeof Studio>[0]> = {}): Studio =>
    makeStudio({
      externalPollMs: 30,
      externalSettleMs: 120,
      importWaitMs: 4000,
      broadcast: (channel, payload) => {
        if (channel !== 'studio:external') return
        const x = payload as { status: string; importedImageId: string | null; versions: unknown[]; message: string }
        events.push({ status: x.status, importedInLibrary: Boolean(x.importedImageId && db.getImage(x.importedImageId) && !db.getImage(x.importedImageId)!.missing), versions: x.versions.length, message: x.message })
      },
      ...extra
    })
  /** What Photoshop does: write the new file beside the old one, then swap it in. */
  const savedLike = async (path: string, make: (s: ReturnType<typeof sharp>) => ReturnType<typeof sharp>): Promise<void> => {
    const tmp = `${path}.saving`
    await make(sharp(path)).png().toFile(tmp)
    await fs.rename(tmp, path)
  }

  it('brings a save back by itself, and reports success only once the picture is in the library', async () => {
    const events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }> = []
    const ex = externalStudio(events)
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const session = await ex.startExternalEdit(source.id, null)
    await waitUntil(() => true)
    await savedLike(session.workingFile, (s) => s.modulate({ brightness: 0.5 }))
    await waitUntil(() => events.some((e) => e.status === 'imported'))
    const imported = events.filter((e) => e.status === 'imported')
    expect(imported).toHaveLength(1)
    expect(imported.every((e) => e.importedInLibrary)).toBe(true) // never "imported" before it is really there
    expect(events.some((e) => e.status === 'importing')).toBe(true)
    const done = ex.externalSessions()[0]!
    expect(done.versions).toHaveLength(1)
    expect(done.versions[0]).toMatchObject({ origin: 'saved', flattened: false })
    expect(done.message).toMatch(/added to your library as a new version/)
    const info = ex.provenance(done.importedImageId!)!
    expect(info.record.sourceImageIds).toEqual([source.id])
    expect(info.record.note).toContain(`session ${session.id}`)
    expect(sha(source.path)).toBe(before)
    ex.dispose()
  })

  it('waits out a slow, partial write and makes exactly one version', async () => {
    const events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }> = []
    const ex = externalStudio(events)
    const source = db.getImage(ids[1]!)!
    const session = await ex.startExternalEdit(source.id, null)
    const full = await sharp(session.workingFile).modulate({ brightness: 0.6 }).png().toBuffer()
    // the program writes in pieces, with pauses: first a truncated file, then the rest
    await fs.writeFile(session.workingFile, full.subarray(0, 900))
    await new Promise((r) => setTimeout(r, 200))
    await fs.writeFile(session.workingFile, full.subarray(0, 2400))
    await new Promise((r) => setTimeout(r, 200))
    await fs.writeFile(session.workingFile, full)
    await waitUntil(() => events.some((e) => e.status === 'imported'))
    await new Promise((r) => setTimeout(r, 400))
    const done = ex.externalSessions()[0]!
    expect(done.versions).toHaveLength(1)
    // the version is the complete picture, not a half-written one
    const result = await sharp(db.getImage(done.importedImageId!)!.path, { failOn: 'error' }).raw().toBuffer()
    expect(result.length).toBe(480 * 320 * 3)
    expect(events.filter((e) => e.status === 'error')).toHaveLength(0)
    expect(db.getImage(done.importedImageId!)).toBeTruthy()
    ex.dispose()
  })

  it('chains repeated saves as linked versions, and ignores a save that changed nothing', async () => {
    const events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }> = []
    const ex = externalStudio(events)
    const source = db.getImage(ids[0]!)!
    const session = await ex.startExternalEdit(source.id, null)
    await savedLike(session.workingFile, (s) => s.modulate({ brightness: 0.5 }))
    await waitUntil(() => ex.externalSessions()[0]!.versions.length === 1)
    // the same pixels saved again (different bytes: another compression level) is not a new version
    const again = await sharp(session.workingFile).png({ compressionLevel: 1 }).toBuffer()
    await fs.writeFile(`${session.workingFile}.x`, again)
    await fs.rename(`${session.workingFile}.x`, session.workingFile)
    await waitUntil(() => ex.externalSessions()[0]!.message.includes('already brought back'))
    expect(ex.externalSessions()[0]!.versions).toHaveLength(1)
    // a real second save is a second version, chained to the first
    await savedLike(session.workingFile, (s) => s.modulate({ saturation: 0.2 }))
    await waitUntil(() => ex.externalSessions()[0]!.versions.length === 2)
    const [v1, v2] = ex.externalSessions()[0]!.versions
    expect(ex.provenance(v2!.imageId)!.record.parentId).toBe(v1!.recordId)
    expect(ex.versions(source.id).records.filter((r) => r.kind === 'external')).toHaveLength(2)
    expect(ex.externalSessions()[0]!.message).toMatch(/Saved again/)
    // saving the original pixels back is "no change" against the original
    await sharp(source.path).png().toFile(`${session.workingFile}.x`)
    await fs.rename(`${session.workingFile}.x`, session.workingFile)
    await waitUntil(() => ex.externalSessions()[0]!.message.includes('Saved without changes'))
    expect(ex.externalSessions()[0]!.versions).toHaveLength(2)
    ex.dispose()
  })

  it('notices a result saved next to the copy in another format, including a Photoshop document', async () => {
    const events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }> = []
    const ex = externalStudio(events)
    const source = db.getImage(ids[2]!)!
    const session = await ex.startExternalEdit(source.id, null)
    const base = session.workingFile.replace(/\.[^.]+$/, '')
    // "Save As" TIFF beside the copy
    await sharp(session.workingFile).modulate({ brightness: 0.7 }).tiff().toFile(`${base}.tif`)
    await waitUntil(() => ex.externalSessions()[0]!.versions.length === 1)
    expect(ex.externalSessions()[0]!.versions[0]!.fileName).toBe(basename(`${base}.tif`))
    // "Save As" PSD beside it: Atlas reads the flattened picture of the document
    const w = 64
    const h = 40
    const rgb = Buffer.alloc(w * h * 3)
    for (let i = 0; i < w * h; i += 1) { rgb[i * 3] = (i * 3) % 251; rgb[i * 3 + 1] = (i * 7) % 241; rgb[i * 3 + 2] = 90 }
    await fs.writeFile(`${base}.psd`, makePsd(w, h, rgb, true))
    await waitUntil(() => ex.externalSessions()[0]!.versions.length === 2)
    const psdVersion = ex.externalSessions()[0]!.versions[1]!
    expect(psdVersion.flattened).toBe(true)
    expect(psdVersion.width).toBe(w)
    const pixels = await sharp(db.getImage(psdVersion.imageId)!.path).removeAlpha().raw().toBuffer()
    expect(pixels.equals(rgb)).toBe(true) // the flattened picture is exactly what the document holds
    expect(ex.provenance(psdVersion.imageId)!.record.note).toMatch(/layers stay in your file/)
    ex.dispose()
  })

  it('reads raw and 16-bit Photoshop pictures and refuses what it cannot read, with a way forward', async () => {
    const { parsePsd } = await import('../src/main/studio/psd')
    const w = 8
    const h = 5
    const rgb = Buffer.alloc(w * h * 3)
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 13) % 256
    expect(parsePsd(makePsd(w, h, rgb, false)).data.equals(rgb)).toBe(true)
    expect(parsePsd(makePsd(w, h, rgb, true)).data.equals(rgb)).toBe(true)
    expect(parsePsd(makePsd(w, h, rgb, false, 16)).data.equals(rgb)).toBe(true) // the high byte of each 16-bit value
    expect(() => parsePsd(Buffer.from('not a photoshop file at all, really not'))).toThrow(/not a Photoshop file/)
    const cmyk = makePsd(w, h, rgb)
    cmyk.writeUInt16BE(4, 24)
    expect(() => parsePsd(cmyk)).toThrow(/RGB and grey/)
  })

  it('does not report success when the picture cannot be added to the library, and says what to do', async () => {
    const events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }> = []
    const ex = externalStudio(events, { enqueueScan: () => undefined, importWaitMs: 300 })
    const source = db.getImage(ids[0]!)!
    const session = await ex.startExternalEdit(source.id, null)
    await savedLike(session.workingFile, (s) => s.modulate({ brightness: 0.5 }))
    await waitUntil(() => events.some((e) => e.status === 'error'))
    expect(events.some((e) => e.status === 'imported')).toBe(false)
    const state = ex.externalSessions()[0]!
    expect(state.versions).toHaveLength(0)
    expect(state.message).toMatch(/has not appeared in the library yet/)
    expect(ex.versions(source.id).records.filter((r) => r.kind === 'external')).toHaveLength(0)
    ex.dispose()
  })

  it('imports a file saved somewhere else: found among recent files, or chosen, never moved or changed', async () => {
    const events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }> = []
    const home = join(work, 'home')
    await fs.mkdir(join(home, 'Downloads'), { recursive: true })
    await fs.mkdir(join(home, 'Documents'), { recursive: true })
    const ex = externalStudio(events, { homeDir: home })
    const source = db.getImage(ids[1]!)!
    const session = await ex.startExternalEdit(source.id, null)
    const saved = join(home, 'Downloads', 'amber-final.png')
    await sharp(source.path).modulate({ brightness: 0.4 }).png().toFile(saved)
    const old = join(home, 'Documents', 'old.png')
    await sharp(source.path).png().toFile(old)
    const past = new Date(Date.now() - 6 * 3600_000)
    await fs.utimes(old, past, past)
    await fs.writeFile(join(home, 'Downloads', 'notes.txt'), 'hello')
    const found = ex.externalCandidates(session.id)
    expect(found.map((c) => c.name)).toContain('amber-final.png')
    expect(found.map((c) => c.name)).not.toContain('old.png')
    expect(found.map((c) => c.name)).not.toContain('notes.txt')
    const hashBefore = sha(saved)
    const done = await ex.importExternalFile(session.id, saved)
    expect(done.status).toBe('imported')
    expect(done.versions[0]).toMatchObject({ origin: 'chosen', fileName: 'amber-final.png' })
    expect(sha(saved)).toBe(hashBefore)
    expect(existsSync(saved)).toBe(true)
    expect(ex.provenance(done.importedImageId!)!.record.note).toMatch(/Imported from/)
    // the same file again, or the original itself, is refused kindly
    await expect(ex.importExternalFile(session.id, saved)).rejects.toThrow(/already brought back/)
    await expect(ex.importExternalFile(session.id, source.path)).rejects.toThrow(/same picture as the original/)
    await expect(ex.importExternalFile(session.id, join(home, 'Downloads', 'notes.txt'))).rejects.toThrow(/PNG, JPEG/)
    await expect(ex.importExternalFile(session.id, join(home, 'missing.png'))).rejects.toThrow(/cannot be found/)
    ex.dispose()
  })

  it('keeps watching after the Studio window is gone, and stops only when told to', async () => {
    const events: Array<{ status: string; importedInLibrary: boolean; versions: number; message: string }> = []
    const ex = externalStudio(events)
    const session = await ex.startExternalEdit(ids[0]!, null)
    expect(ex.externalSessions().map((x) => x.id)).toEqual([session.id])
    await savedLike(session.workingFile, (s) => s.modulate({ brightness: 0.5 }))
    await waitUntil(() => ex.externalSessions()[0]!.versions.length === 1)
    ex.endExternal(session.id)
    expect(ex.externalSessions()).toHaveLength(0)
    await expect(ex.importExternal(session.id)).rejects.toThrow(/has ended/)
    ex.dispose()
  })

  // ---- conversational editing: regions, references, levels, alternatives, plans, versions ---------------------------------

  const pixels = async (input: string | Buffer): Promise<Buffer> => sharp(input).removeAlpha().raw().toBuffer()

  it('changes only the chosen part: everything outside the region is the original, pixel for pixel', async () => {
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const result = await studio.edit({ imageId: source.id, methodId: 'blend', instruction: 'much warmer and brighter', strength: 0.9, level: 'creative', region: { shape: { kind: 'rect', x: 0.5, y: 0, w: 0.5, h: 1 }, feather: 0 }, approvedCost: 0, approvedUpload: false })
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/Only the rectangle you drew/)
    const saved = await studio.commitEdit(result.pendingId!)
    const edited = db.getImage(saved.records[0]!.imageId!)!
    const a = await pixels(source.path)
    const b = await pixels(edited.path)
    expect(b.length).toBe(a.length)
    const w = 480
    let leftChanged = 0
    let rightChanged = 0
    for (let y = 0; y < 320; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = (y * w + x) * 3
        const differs = a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]
        if (differs && x < w / 2) leftChanged += 1
        if (differs && x >= w / 2) rightChanged += 1
      }
    }
    expect(leftChanged).toBe(0)
    expect(rightChanged).toBeGreaterThan(160 * 240)
    expect(sha(source.path)).toBe(before)
  })

  it('retouches with all five tools: previews first, keeps only on request, leaves the outside and the original alone, and records versions', async () => {
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const region = { shape: { kind: 'rect' as const, x: 0.25, y: 0.25, w: 0.4, h: 0.4 }, feather: 4 }
    const a = await pixels(source.path)
    const kept: string[] = []
    for (const [tool, extra] of [['blur', { edgeAware: true }], ['sharpen', {}], ['tone', { tone: 'darken' as const }], ['heal', {}], ['remove', {}]] as const) {
      const result = await studio.retouch({ imageId: source.id, tool, region, strength: 0.6, ...extra })
      expect(result.ok, `${tool}: ${result.message}`).toBe(true)
      expect(result.previewUrl).toMatch(/^data:image\/jpeg/)
      expect(result.summary).toMatch(/pixel for pixel/)
      const saved = await studio.commitEdit(result.pendingId!)
      expect(saved.ok).toBe(true)
      kept.push(saved.records[0]!.imageId!)
      const out = await pixels(db.getImage(saved.records[0]!.imageId!)!.path)
      expect(out.length).toBe(a.length)
      let outside = 0
      for (let y = 0; y < 320; y += 1) for (let x = 0; x < 480; x += 1) {
        const inside = x >= 120 - 14 && x < 312 + 14 && y >= 80 - 14 && y < 208 + 14
        if (inside) continue
        const i = (y * 480 + x) * 3
        if (a[i] !== out[i] || a[i + 1] !== out[i + 1] || a[i + 2] !== out[i + 2]) outside += 1
      }
      expect(outside, tool).toBe(0)
    }
    const hist = studio.versions(source.id).records
    expect(hist.length).toBe(5)
    expect(hist.map((r) => r.title).join(' ')).toMatch(/softened.*sharpened.*burned.*healed.*retouched/)
    expect(sha(source.path)).toBe(before)
  })

  // The reported bug: a gentle Blur on one part looked right; after switching to Heal and fixing a defect somewhere else, the
  // blurred part had changed drastically. Every finished step must keep its own result, whatever tool comes next.
  it('keeps a finished retouch step exactly as it was when other tools are used elsewhere afterwards', async () => {
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const original = await pixels(source.path)
    const W = 480
    const H = 320
    const A = { x0: 0.38, y0: 0.2, x1: 0.62, y1: 0.8 } // blurred first
    const B = { x0: 0.06, y0: 0.1, x1: 0.16, y1: 0.24 } // healed later, far away
    const C = { x0: 0.8, y0: 0.6, x1: 0.95, y1: 0.9 } // darkened last
    const rect = (r: typeof A): { shape: { kind: 'rect'; x: number; y: number; w: number; h: number }; feather: number } => ({ shape: { kind: 'rect', x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 }, feather: 3 })
    const inside = (r: typeof A, x: number, y: number, pad = 0): boolean => x >= r.x0 * W - pad && x < r.x1 * W + pad && y >= r.y0 * H - pad && y < r.y1 * H + pad
    const sameWhere = (a: Buffer, b: Buffer, test: (x: number, y: number) => boolean): number => {
      let differing = 0
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
        if (!test(x, y)) continue
        const i = (y * W + x) * 3
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) differing += 1
      }
      return differing
    }
    const step = async (args: Parameters<typeof studio.retouch>[0]): Promise<{ id: string; px: Buffer }> => {
      const r = await studio.retouch(args)
      expect(r.ok, r.message).toBe(true)
      // read the full picture of this step without ending it: keep a copy as a version, which does not alter the chain
      const copy = studio['pending'].get(r.pendingId!)!
      return { id: r.pendingId!, px: await sharp(copy.buffer).removeAlpha().raw().toBuffer() }
    }

    // 1. A gentle blur of about 5 % on part A.
    const first = await step({ imageId: source.id, tool: 'blur', region: rect(A), strength: 0.05 })
    expect(sameWhere(original, first.px, (x, y) => inside(A, x, y))).toBeGreaterThan(0) // it really blurred something
    expect(sameWhere(original, first.px, (x, y) => !inside(A, x, y, 12))).toBe(0)
    studio.holdRetouch([first.id], [])

    // 2. Another tool, with other settings, on a different part, continuing from the finished step.
    const second = await step({ imageId: source.id, baseId: first.id, tool: 'heal', region: rect(B), strength: 0.9 })
    expect(sameWhere(first.px, second.px, (x, y) => inside(A, x, y, 12))).toBe(0) // the blurred part is byte for byte what the user approved
    expect(sameWhere(first.px, second.px, (x, y) => !inside(B, x, y, 14))).toBe(0)
    studio.holdRetouch([second.id], [])

    // 3. And a third, with yet another tool and other settings.
    const third = await step({ imageId: source.id, baseId: second.id, tool: 'tone', tone: 'darken', region: rect(C), strength: 0.7 })
    expect(sameWhere(second.px, third.px, (x, y) => inside(C, x, y)) ).toBeGreaterThan(0)
    expect(sameWhere(first.px, third.px, (x, y) => inside(A, x, y, 12))).toBe(0)
    expect(sameWhere(second.px, third.px, (x, y) => !inside(C, x, y, 20))).toBe(0)
    // Outside everything that was touched, the picture is still the original.
    expect(sameWhere(original, third.px, (x, y) => !inside(A, x, y, 12) && !inside(B, x, y, 14) && !inside(C, x, y, 20))).toBe(0)

    studio.holdRetouch([third.id], [])
    // Many ordinary previews (live slider moves) must not push the finished steps out of memory.
    for (let i = 0; i < 30; i += 1) await studio.retouch({ imageId: source.id, baseId: third.id, tool: 'blur', region: rect(C), strength: 0.1 + i / 100 })
    const check = await studio.retouch({ imageId: source.id, baseId: first.id, tool: 'sharpen', region: rect(C), strength: 0.3 })
    expect(check.ok).toBe(true)

    // Saving gives one new version that says how it was made; the original file is untouched.
    const saved = await studio.commitEdit(third.id)
    expect(saved.ok).toBe(true)
    const record = saved.records[0]!
    expect(record.prompt).toMatch(/Soften.*then Heal.*then Darken/)
    const final = await pixels(db.getImage(record.imageId!)!.path)
    expect(sameWhere(third.px, final, () => true)).toBe(0)
    expect(sha(source.path)).toBe(before)

    // A step that was let go of cannot be continued from, and says so kindly.
    studio.holdRetouch([], [first.id])
    const gone = await studio.retouch({ imageId: source.id, baseId: first.id, tool: 'blur', region: rect(C), strength: 0.2 })
    expect(gone.ok).toBe(false)
    expect(gone.message).toMatch(/no longer available/)
    // And a step of another picture is never used as a base.
    const other = await studio.retouch({ imageId: source.id, tool: 'blur', region: rect(C), strength: 0.2 })
    const wrong = await studio.retouch({ imageId: ids[1]!, baseId: other.pendingId, tool: 'blur', region: rect(C), strength: 0.2 })
    expect(wrong.ok).toBe(false)
  })

  it('says plainly when nothing is marked or the area is empty, and stops cleanly', async () => {
    const source = db.getImage(ids[0]!)!
    const empty = await studio.retouch({ imageId: source.id, tool: 'remove', region: { shape: { kind: 'rect', x: 0.2, y: 0.2, w: 0.0005, h: 0.0005 } }, strength: 0.4 })
    expect(empty.ok).toBe(false)
    expect(empty.message).toMatch(/empty|paint/i)
    const none = await studio.retouch({ imageId: source.id, tool: 'blur', region: {}, strength: 0.4 })
    expect(none.ok).toBe(false)
    expect(none.message).toMatch(/Choose which part|paint/i)
  })

  it('plans can carry retouching steps on named parts, saved as linked versions', async () => {
    const source = db.getImage(ids[0]!)!
    const plan = await studio.runPlan(source.id, [
      { op: 'blur', label: 'Soften the background', region: { named: 'background' }, strength: 0.5, edgeAware: true },
      { op: 'tone', label: 'Darken the left', region: { named: 'left' }, strength: 0.4, tone: 'darken' },
      { op: 'sharpen', label: 'Sharpen the top', region: { named: 'top' }, strength: 0.3 }
    ])
    expect(plan.ok, plan.message).toBe(true)
    expect(plan.records).toHaveLength(3)
    expect(plan.records[1]!.parentId).toBe(plan.records[0]!.id)
    const noPart = await studio.runPlan(source.id, [{ op: 'heal', label: 'Heal the cheek' }])
    expect(noPart.ok).toBe(false)
    expect(noPart.message).toMatch(/paint/i)
  })

  it('borrows the light and colour of a reference picture, and says what it cannot take', async () => {
    const source = db.getImage(ids[0]!)! // the blue picture
    const amber = db.getImage(ids[1]!)!
    const [r0, , b0] = await channelMean(source.path)
    const result = await studio.edit({ imageId: source.id, methodId: 'blend', instruction: '', strength: 0.5, references: { imageIds: [amber.id], aspects: ['colour'], amount: 0.9 }, approvedCost: 0, approvedUpload: false })
    expect(result.ok).toBe(true)
    expect(result.summary).toMatch(/Composition and material cannot be taken/)
    const saved = await studio.commitEdit(result.pendingId!)
    const [r1, , b1] = await channelMean(db.getImage(saved.records[0]!.imageId!)!.path)
    expect(r1!).toBeGreaterThan(r0! + 20)
    expect(b1!).toBeLessThan(b0! - 20)
    // The structure is still the original's: the bright bar is still where it was.
    const grey = await luma(db.getImage(saved.records[0]!.imageId!)!.path)
    const orig = await luma(source.path)
    expect(correlation(grey.data, orig.data)).toBeGreaterThan(0.95)
  })

  it('makes several alternatives at once and keeps only the ones the user chooses', async () => {
    const source = db.getImage(ids[0]!)!
    const result = await studio.edit({ imageId: source.id, methodId: 'blend', instruction: 'mysterious', strength: 0.7, count: 3, approvedCost: 0, approvedUpload: false })
    expect(result.ok).toBe(true)
    expect(result.alternatives).toHaveLength(3)
    expect(new Set(result.alternatives!.map((a) => a.pendingId)).size).toBe(3)
    const kept = await studio.commitEdit(result.alternatives![1]!.pendingId)
    expect(kept.ok).toBe(true)
    expect(studio.versions(source.id).records).toHaveLength(1)
    studio.discardEdit(result.alternatives![0]!.pendingId)
    studio.discardEdit(result.alternatives![2]!.pendingId)
  })

  it('runs an approved plan step by step, never uploads, and links every result into one version history', async () => {
    const source = db.getImage(ids[0]!)!
    const before = sha(source.path)
    const steps: string[] = []
    const result = await studio.runPlan(
      source.id,
      [
        { op: 'edit', label: 'Make it mysterious', instruction: 'mysterious and misty', level: 'creative' },
        { op: 'edit', label: 'Then warmer, only on the left', instruction: 'warmer', level: 'subtle', region: { named: 'left' } },
        { op: 'upscale', label: 'Enlarge', targetLongEdge: 960, workflowId: null }
      ],
      { onStep: (t) => steps.push(t) }
    )
    expect(result.ok).toBe(true)
    expect(result.records).toHaveLength(3)
    expect(steps).toHaveLength(3)
    expect(fetchCalls.filter((c) => /openai/.test(c.url))).toHaveLength(0)
    // Each step started from the one before: a chain of parents.
    expect(result.records[1]!.parentId).toBe(result.records[0]!.id)
    expect(result.records[2]!.parentId).toBe(result.records[1]!.id)
    expect(new Set(result.records.map((r) => r.seriesId)).size).toBe(1)
    const final = db.getImage(result.records[2]!.imageId!)!
    expect(Math.max(final.width, final.height)).toBe(960)
    expect(sha(source.path)).toBe(before)
    // The history can be read from the original and from any version, and nothing is ever removed.
    expect(studio.versions(source.id).records).toHaveLength(3)
    expect(studio.versions(result.records[1]!.imageId!).records).toHaveLength(3)
  })

  it('branches: alternatives from the same source are siblings, and any version can be continued', async () => {
    const source = db.getImage(ids[0]!)!
    const plan = await studio.runPlan(source.id, [
      { op: 'edit', label: 'A', instruction: 'mysterious', from: 'source' },
      { op: 'edit', label: 'B', instruction: 'warmer', from: 'source' }
    ])
    expect(plan.ok).toBe(true)
    const [a, b] = plan.records
    expect(a!.parentId).toBeNull()
    expect(b!.parentId).toBeNull()
    expect(a!.seriesId).toBe(b!.seriesId)
    const more = await studio.runPlan(a!.imageId!, [{ op: 'edit', label: 'C', instruction: 'brighter' }])
    expect(more.records[0]!.parentId).toBe(a!.id)
    expect(studio.versions(source.id).records).toHaveLength(3)
  })

  it('stops a plan at the first step that cannot be done and says which', async () => {
    const source = db.getImage(ids[0]!)!
    const result = await studio.runPlan(source.id, [
      { op: 'edit', label: 'Paint a dragon', instruction: 'add a dragon on the roof' },
      { op: 'edit', label: 'Never reached', instruction: 'mysterious' }
    ])
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Stopped at step 1/)
    expect(result.records).toHaveLength(0)
  })

  it('previews a region before anything is made', async () => {
    const preview = await studio.previewRegion(ids[0]!, { named: 'top' })
    expect(preview.coverage).toBeGreaterThan(0.35)
    expect(preview.overlayUrl).toMatch(/^data:image\/jpeg;base64,/)
    await expect(studio.previewRegion(ids[0]!, { maskPng: '' })).rejects.toThrow(/Choose which part/)
  })

  it('rejects editor programs that do not exist', () => {
    studio.update({ editors: [{ id: 'x', name: 'Nothing', path: 'C:\\no\\such\\Editor.exe' }] })
    return studio.settings().then((s) => expect(s.editors).toEqual([]))
  })
})

describe('moodboard editing with undo', () => {
  let work = ''
  let db: AtlasDatabase
  let ids: string[] = []
  beforeEach(async () => {
    work = join(tmpdir(), `noema-board-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(work, 'refs'), { recursive: true })
    db = new AtlasDatabase(join(work, 'library.db'))
    const root = db.addRoot(join(work, 'refs'))
    ids = []
    for (let i = 0; i < 8; i += 1) {
      const p = join(work, 'refs', `p${i}.png`)
      writeFileSync(p, 'x')
      db.upsertScannedImage({ id: imageIdForPath(p), rootId: root.id, path: p, folder: join(work, 'refs'), filename: `p${i}.png`, ext: 'png', bytes: 1, width: i % 2 ? 600 : 900, height: 600, orientation: 1, mtime: 1, color: '#777777', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
      ids.push(imageIdForPath(p))
    }
  })
  afterEach(async () => {
    db.close()
    await fs.rm(work, { recursive: true, force: true })
  })

  it('replaces, removes and rearranges, then undoes exactly', () => {
    const board = db.createMoodboard('Study')
    db.addToMoodboard(board.id, ids.slice(0, 5), [])
    db.updateBoardItem({ moodboardId: board.id, imageId: ids[0]!, x: 0.31, y: 0.17, width: 0.2, height: 0.3, z: 9 })
    const layoutBefore = db.getMoodboard(board.id)!.images.map((i) => [i.id, i.x, i.y, i.layoutWidth, i.layoutHeight, i.z])
    let changed = 0
    const editor = new BoardEditor(db, () => (changed += 1))

    const preview = editor.preview(board.id, { remove: [ids[1]!, ids[2]!], add: [ids[6]!, ids[7]!], arrange: 'tidy' })
    expect(preview.removed.map((i) => i.id)).toEqual([ids[1], ids[2]])
    expect(preview.added.map((i) => i.id)).toEqual([ids[6], ids[7]])
    expect(preview.resulting).toBe(5)
    // Previewing changes nothing.
    expect(db.getMoodboard(board.id)!.images).toHaveLength(5)

    editor.apply(board.id, { remove: [ids[1]!, ids[2]!], add: [ids[6]!, ids[7]!], arrange: 'tidy' }, 'Swap two for two')
    const after = db.getMoodboard(board.id)!.images
    expect(after.map((i) => i.id).sort()).toEqual([ids[0]!, ids[3]!, ids[4]!, ids[6]!, ids[7]!].sort())
    // Tidy layout keeps every picture's proportions and puts nothing on top of anything else.
    for (const i of after) expect((i.layoutWidth * 1500) / (i.layoutHeight * 1000)).toBeCloseTo(i.width / i.height, 1)
    for (let a = 0; a < after.length; a += 1) {
      for (let b = a + 1; b < after.length; b += 1) {
        const p = after[a]!
        const q = after[b]!
        const overlap = !(p.x + p.layoutWidth <= q.x + 1e-6 || q.x + q.layoutWidth <= p.x + 1e-6 || p.y + p.layoutHeight <= q.y + 1e-6 || q.y + q.layoutHeight <= p.y + 1e-6)
        expect(overlap).toBe(false)
      }
    }
    expect(editor.lastSnapshot(board.id)!.label).toBe('Swap two for two')

    expect(editor.undo(board.id)).toBe(true)
    expect(db.getMoodboard(board.id)!.images.map((i) => [i.id, i.x, i.y, i.layoutWidth, i.layoutHeight, i.z])).toEqual(layoutBefore)
    expect(editor.undo(board.id)).toBe(false)
    expect(changed).toBeGreaterThanOrEqual(2)
  })
})

describe('the assistant proposes artwork and board changes, and acts only on a click', () => {
  let work = ''
  let db: AtlasDatabase
  let ids: string[] = []
  let engine: AssistantEngine
  beforeEach(async () => {
    work = join(tmpdir(), `noema-asst2-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await fs.mkdir(join(work, 'refs'), { recursive: true })
    db = new AtlasDatabase(join(work, 'library.db'))
    const root = db.addRoot(join(work, 'refs'))
    ids = []
    for (let i = 0; i < 6; i += 1) {
      const p = join(work, 'refs', `p${i}.png`)
      writeFileSync(p, 'x')
      db.upsertScannedImage({ id: imageIdForPath(p), rootId: root.id, path: p, folder: join(work, 'refs'), filename: `p${i}.png`, ext: 'png', bytes: 1, width: 800, height: 600, orientation: 1, mtime: 1, color: '#6a7fb0', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
      ids.push(imageIdForPath(p))
    }
    const store = new AssistantSettingsStore(join(work, 'assistant'), fakeBox)
    const embedder = { async embedTexts(t: string[]) { return t.map(() => new Float32Array(8)) } } as unknown as Embedder
    const semantic = new SemanticSearch(db, async () => embedder)
    engine = new AssistantEngine({
      dir: join(work, 'assistant'),
      settings: store,
      ctx: { db, semantic, searchable: () => false, reference: null, identity: async () => null, taste: async () => null, journeySuggestions: async () => [], getEmbedder: async () => embedder, mayShareNames: () => false, boards: new BoardEditor(db, () => undefined) },
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
  })
  afterEach(async () => {
    db.close()
    await fs.rm(work, { recursive: true, force: true })
  })

  it('applies a board change only when accepted, and the user can undo it', async () => {
    const board = db.createMoodboard('Study')
    db.addToMoodboard(board.id, ids.slice(0, 4), [])
    const editor = new BoardEditor(db, () => undefined)
    // Drive the tool the way a language model would.
    const { buildTools, RefBook } = await import('../src/main/assistant/tools')
    const tools = buildTools()
    const refs = new RefBook()
    const remove = refs.refFor(ids[0]!)
    const add = refs.refFor(ids[5]!)
    const tool = tools.find((t) => t.spec.name === 'propose_board_changes')!
    const out = await tool.run({ board: 'Study', remove_refs: [remove], add_refs: [add], arrange: 'tidy', reason: 'Swap one.' }, { ctx: (engine as unknown as { options: { ctx: never } }).options.ctx, refs })
    const block = out.blocks[0]!
    expect(block.type).toBe('proposal')
    expect(db.getMoodboard(board.id)!.images.map((i) => i.id)).toContain(ids[0])
    if (block.type !== 'proposal') return
    expect(block.proposal).toMatchObject({ kind: 'board-change', removeIds: [ids[0]], imageIds: [ids[5]] })
    editor.apply(board.id, { remove: [ids[0]!], add: [ids[5]!], arrange: 'keep' }, 'x')
    expect(db.getMoodboard(board.id)!.images.map((i) => i.id)).not.toContain(ids[0])
    expect(editor.undo(board.id)).toBe(true)
    expect(db.getMoodboard(board.id)!.images.map((i) => i.id)).toContain(ids[0])
  })

  it('offline basics understands tidy and artwork requests', async () => {
    const board = db.createMoodboard('Study')
    db.addToMoodboard(board.id, ids.slice(0, 4), [])
    const tidy = await engine.send(null, 'Tidy my "Study" moodboard')
    const proposal = tidy.chat.messages.at(-1)!.blocks.find((b) => b.type === 'proposal')
    expect(proposal && proposal.type === 'proposal' && proposal.proposal.kind).toBe('board-change')
    const art = await engine.send(null, 'Create a new surreal landscape from my "Study" moodboard')
    const concept = art.chat.messages.at(-1)!.blocks.find((b) => b.type === 'proposal')
    expect(concept && concept.type === 'proposal' && concept.proposal.kind).toBe('artwork')
    expect(db.listMoodboards()).toHaveLength(1)
  })

  it('proposes an artwork with the roles the model chose, and makes nothing', async () => {
    const board = db.createMoodboard('Valleys')
    db.addToMoodboard(board.id, ids.slice(0, 3), [])
    const { buildTools, RefBook } = await import('../src/main/assistant/tools')
    const refs = new RefBook()
    const a = refs.refFor(ids[0]!)
    const b = refs.refFor(ids[1]!)
    const tool = buildTools().find((t) => t.spec.name === 'propose_artwork')!
    const out = await tool.run({ board: 'Valleys', intent: 'a new surreal landscape', atmosphere_refs: [a], colour_refs: [b], prompt: 'A surreal valley under twin moons' }, { ctx: (engine as unknown as { options: { ctx: never } }).options.ctx, refs })
    const block = out.blocks[0]!
    expect(block.type).toBe('proposal')
    if (block.type !== 'proposal' || block.proposal.kind !== 'artwork') throw new Error('expected an artwork proposal')
    expect(block.proposal.prompt).toBe('A surreal valley under twin moons')
    expect(block.proposal.roles).toEqual({ [ids[0]!]: ['atmosphere'], [ids[1]!]: ['colour'] })
    expect(block.proposal.title).toBeTruthy()
    // Nothing was written to disk or the database.
    expect(readdirSync(work).sort()).toEqual(['assistant', 'library.db', 'library.db-shm', 'library.db-wal', 'refs'].filter((n) => existsSync(join(work, n))).sort())
  })

  // ---- Sol as creative director: plans, versions, external editors -----------------------------------------------------

  const stubStudio = () => {
    const calls: Array<{ imageId: string; steps: Array<{ op: string; label: string; region?: unknown; count?: number; level?: string }> }> = []
    return {
      calls,
      api: {
        run: async (imageId: string, steps: Array<{ op: string; label: string }>, hooks: { jobId: string; onStep: (t: string) => void }) => {
          calls.push({ imageId, steps })
          hooks.onStep(`Step 1 of ${steps.length}: ${steps[0]!.label}`)
          return { ok: true, message: 'Finished.', records: [{ id: 'r1', imageId: ids[3]! } as never], steps: steps.map((x) => ({ label: x.label, ok: true, message: 'Saved as a new version.', recordIds: ['r1'], imageIds: [ids[3]!] })) }
        },
        stop: () => undefined,
        versions: (imageId: string) => ({
          seriesId: `photo-${imageId}`,
          records: [
            { id: 'v1', kind: 'edit', imageId: ids[1]!, title: 'a', moodboardId: null, moodboardName: '', sourceImageIds: [imageId], roles: {}, prompt: 'mysterious', negative: '', methodId: 'comfyui', model: 'm', seed: null, width: 800, height: 600, costUsd: 0, parentId: null, seriesId: `photo-${imageId}`, note: 'n', createdAt: 1 } as never,
            { id: 'v2', kind: 'upscale', imageId: ids[2]!, title: 'b', moodboardId: null, moodboardName: '', sourceImageIds: [], roles: {}, prompt: '', negative: '', methodId: 'comfyui', model: 'm', seed: null, width: 1600, height: 1200, costUsd: 0, parentId: 'v1', seriesId: `photo-${imageId}`, note: 'x', createdAt: 2 } as never
          ]
        }),
        startExternal: async () => ({ editorName: 'Photoshop' }),
        editors: () => [{ id: 'photoshop', name: 'Photoshop' }]
      }
    }
  }
  const withStudio = (api: unknown) => {
    const ctx = (engine as unknown as { options: { ctx: Record<string, unknown> } }).options.ctx
    ctx.studio = api
    ctx.capabilities = async () => [
      { id: 'create', label: 'Create pictures', ready: true, how: 'ComfyUI on this computer', options: [], missing: null, offer: null },
      { id: 'edit', label: 'Edit pictures', ready: true, how: 'ComfyUI, keeping the structure', options: [], missing: null, offer: null },
      { id: 'upscale', label: 'Creative upscaling', ready: true, how: 'Atlas detail upscale', options: [{ id: 'atlas:detail', label: 'Atlas detail upscale', kind: 'local', note: '' }, { id: 'clarity-1', label: 'Clarity cabin realistic', kind: 'local', note: '' }], missing: null, offer: null }
    ]
    return ctx as never
  }

  it('proposes a multi-step plan that runs nothing until it is accepted, then runs it and shows the results', async () => {
    const { buildTools, RefBook } = await import('../src/main/assistant/tools')
    const stub = stubStudio()
    const ctx = withStudio(stub.api)
    const refs = new RefBook()
    const src = refs.refFor(ids[0]!)
    const board = db.createMoodboard('Inner Mythologies')
    db.addToMoodboard(board.id, ids.slice(1, 4), [])
    const tool = buildTools().find((t) => t.spec.name === 'propose_edit_plan')!
    const out = await tool.run(
      {
        ref: src,
        title: 'Three interpretations',
        steps: [
          { op: 'edit', label: 'Replace the sky with something more mysterious', instruction: 'replace the sky', region: 'sky', level: 'radical', variations: 3, reference_board: 'Inner Mythologies', reference_aspects: ['atmosphere'], from: 'source' },
          { op: 'detail', label: 'Refine fine details', subject: 'vegetation' },
          { op: 'upscale', label: 'Enlarge to 4K', target_long_edge: 3840, preset: 'cabin' }
        ]
      },
      { ctx, refs }
    )
    expect(stub.calls).toHaveLength(0) // nothing ran
    const block = out.blocks[0]!
    if (block.type !== 'proposal' || block.proposal.kind !== 'edit-plan') throw new Error('expected a plan')
    expect(block.proposal.steps).toHaveLength(3)
    expect(block.proposal.steps[0]).toMatchObject({ op: 'edit', level: 'radical', count: 3, region: { named: 'sky' }, from: 'source' })
    expect(block.proposal.steps[0]!.references!.imageIds.length).toBe(3)
    expect(block.proposal.steps[2]).toMatchObject({ op: 'upscale', targetLongEdge: 3840, workflowId: 'clarity-1' })
    expect(block.proposal.how).toMatch(/Nothing is uploaded or paid for/)
    expect(block.proposal.how).toMatch(/ComfyUI, keeping the structure/)

    // Put the proposal into a chat the way the engine does, then accept it.
    const chat = engine.newChat()
    const stored = (engine as unknown as { read(id: string): { messages: unknown[] } }).read(chat.id)!
    stored.messages.push({ id: 'm1', role: 'assistant', at: 1, blocks: [block] })
    ;(engine as unknown as { write(c: unknown): void }).write(stored)
    const changed: string[] = []
    ;(engine as unknown as { options: { onChatChanged?: (id: string) => void } }).options.onChatChanged = (id) => changed.push(id)
    const answered = engine.respondToProposal(chat.id, block.id, true)
    const running = answered.messages[0]!.blocks[0]!
    expect(running.type === 'proposal' && running.status).toBe('running')
    await vi.waitFor(() => {
      const done = engine.getChat(chat.id)!.messages[0]!.blocks[0]!
      expect(done.type === 'proposal' && done.status).toBe('applied')
    })
    const done = engine.getChat(chat.id)!.messages[0]!.blocks[0]!
    if (done.type !== 'proposal') throw new Error('x')
    expect(stub.calls).toHaveLength(1)
    expect(done.resultItems?.map((i) => i.id)).toEqual([ids[3]])
    expect(done.result).toMatch(/Finished/)
    expect(changed.length).toBeGreaterThan(0)
  })

  it('rejects a plan with an unknown preset or an empty step instead of guessing', async () => {
    const { buildTools, RefBook } = await import('../src/main/assistant/tools')
    const ctx = withStudio(stubStudio().api)
    const refs = new RefBook()
    const src = refs.refFor(ids[0]!)
    const tool = buildTools().find((t) => t.spec.name === 'propose_edit_plan')!
    const bad = await tool.run({ ref: src, steps: [{ op: 'upscale', label: 'x', preset: 'does not exist' }] }, { ctx, refs })
    expect(bad.blocks).toHaveLength(0)
    expect(JSON.stringify(bad.model)).toMatch(/no upscaling preset/)
    const empty = await tool.run({ ref: src, steps: [{ op: 'edit', label: 'x' }] }, { ctx, refs })
    expect(JSON.stringify(empty.model)).toMatch(/needs an instruction/)
    const none = await tool.run({ ref: src, steps: [] }, { ctx, refs })
    expect(JSON.stringify(none.model)).toMatch(/at least one step/)
  })

  it('proposes retouching with a located part, or asks the user to mark it instead of guessing, and never runs anything itself', async () => {
    const { buildTools, RefBook } = await import('../src/main/assistant/tools')
    const stub = stubStudio()
    const ctx = withStudio(stub.api)
    const refs = new RefBook()
    const src = refs.refFor(ids[0]!)
    const tool = buildTools().find((t) => t.spec.name === 'propose_retouch')!
    const located = await tool.run({ ref: src, tool: 'tone', tone: 'darken', region: 'background', strength: 0.5 }, { ctx, refs })
    const lb = located.blocks[0]!
    if (lb.type !== 'proposal' || lb.proposal.kind !== 'retouch') throw new Error('expected a retouch proposal')
    expect(lb.proposal).toMatchObject({ tool: 'tone', tone: 'darken', region: { named: 'background' } })
    expect(lb.title).toMatch(/Darken the background/)
    const unlocated = await tool.run({ ref: src, tool: 'heal', reason: 'damaged texture on the cheek' }, { ctx, refs })
    const ub = unlocated.blocks[0]!
    if (ub.type !== 'proposal' || ub.proposal.kind !== 'retouch') throw new Error('expected a retouch proposal')
    expect(ub.proposal.region).toBeUndefined()
    expect(JSON.stringify(unlocated.model)).toMatch(/must paint/)
    const wrong = await tool.run({ ref: src, tool: 'liquify' }, { ctx, refs })
    expect(wrong.blocks).toHaveLength(0)
    expect(stub.calls).toHaveLength(0)
    // plan steps: located parts only; an object or face is refused with the way forward
    const plan = buildTools().find((t) => t.spec.name === 'propose_edit_plan')!
    const ok = await plan.run({ ref: src, steps: [{ op: 'blur', label: 'Soften the background', region: 'background', edge_aware: true }, { op: 'tone', label: 'Brighten the sky', region: 'sky', tone: 'lighten' }, { op: 'sharpen', label: 'Sharpen the foreground', region: 'foreground', strength: 0.3 }] }, { ctx, refs })
    const pb = ok.blocks[0]!
    if (pb.type !== 'proposal' || pb.proposal.kind !== 'edit-plan') throw new Error('expected a plan')
    expect(pb.proposal.steps.map((x) => x.op)).toEqual(['blur', 'tone', 'sharpen'])
    expect(pb.proposal.steps[1]).toMatchObject({ tone: 'lighten' })
    const refused = await plan.run({ ref: src, steps: [{ op: 'heal', label: 'Heal the cheek' }] }, { ctx, refs })
    expect(refused.blocks).toHaveLength(0)
    expect(JSON.stringify(refused.model)).toMatch(/paints over it|reliably/)
  })

  it('lists versions with references, and opens an external program only after the user accepts', async () => {
    const { buildTools, RefBook } = await import('../src/main/assistant/tools')
    const ctx = withStudio(stubStudio().api)
    const refs = new RefBook()
    const src = refs.refFor(ids[0]!)
    const versions = await buildTools().find((t) => t.spec.name === 'show_versions')!.run({ ref: src }, { ctx, refs })
    const list = (versions.model as { versions: Array<{ n: number; ref: string; parent_ref: string | null }> }).versions
    expect(list).toHaveLength(2)
    expect(list[1]!.parent_ref).toBe(list[0]!.ref)
    expect(versions.blocks[0]).toMatchObject({ type: 'images' })
    const external = await buildTools().find((t) => t.spec.name === 'propose_external_edit')!.run({ ref: src, editor: 'photoshop' }, { ctx, refs })
    const block = external.blocks[0]!
    expect(block.type === 'proposal' && block.proposal).toMatchObject({ kind: 'external-edit', editorId: 'photoshop', editorName: 'Photoshop' })
    const unknown = await buildTools().find((t) => t.spec.name === 'propose_external_edit')!.run({ ref: src, editor: 'gimp' }, { ctx, refs })
    expect(JSON.stringify(unknown.model)).toMatch(/not set up/)
  })

  it('offline basics turns “try three interpretations” and “replace the sky” into plans, and “improve details and upscale to 4K” into two steps', async () => {
    withStudio(stubStudio().api)
    const first = await engine.send(null, 'find pictures')
    const chatId = first.chat.id
    // Make the chat remember images that were shown.
    const stored = (engine as unknown as { read(id: string): { messages: Array<{ blocks: unknown[] }>; refs: Record<string, string> } }).read(chatId)!
    stored.messages.push({ id: 'm9', role: 'assistant', at: 1, blocks: [{ type: 'images', label: 'x', ids: [ids[0]!, ids[1]!, ids[2]!], basis: 'library' }] } as never)
    ;(engine as unknown as { write(c: unknown): void }).write(stored)
    const find = async (text: string) => {
      const reply = await engine.send(chatId, text)
      const block = reply.chat.messages.at(-1)!.blocks.find((b) => b.type === 'proposal')
      return block && block.type === 'proposal' ? block.proposal : null
    }
    const three = await find('Try three artistic interpretations of it')
    expect(three).toMatchObject({ kind: 'edit-plan' })
    expect(three && three.kind === 'edit-plan' && three.steps[0]).toMatchObject({ op: 'edit', count: 3, level: 'radical' })
    const sky = await find('Replace the sky with something more mysterious')
    expect(sky && sky.kind === 'edit-plan' && sky.steps[0]).toMatchObject({ op: 'edit', region: { named: 'sky' } })
    const detail = await find('Improve the fine details of the second one and upscale it to 4K')
    expect(detail && detail.kind === 'edit-plan' && detail.steps.map((x) => x.op)).toEqual(['detail', 'upscale'])
    expect(detail && detail.kind === 'edit-plan' && detail.steps[1]).toMatchObject({ targetLongEdge: 3840 })
    expect(detail && detail.kind === 'edit-plan' && detail.imageId).toBe(ids[1])
  })
})
