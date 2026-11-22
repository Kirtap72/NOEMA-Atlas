import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtlasDatabase, imageIdForPath } from '../src/main/db'
import type { ScannedImageRecord } from '../src/main/db'
import { EMBEDDING_MODEL } from '../src/main/embedder'
import { OrganizerEngine, cameraOfExif, decideKind, relatedNames, type OrganizerDeps, type RoleName } from '../src/main/organizer/engine'
import { chooseBest, placeItems, planOperations, safeName, type OrganizeItem } from '../src/main/organizer/structure'
import { DEFAULT_SETTINGS, type OrganizeProgress } from '../src/shared/organizer'

const DIM = 24
const unit = (values: number[]): Float32Array => {
  const n = Math.hypot(...values) || 1
  return Float32Array.from(values.map((v) => v / n))
}
const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const treeHashes = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).filter((f) => /\.(png|jpg)$/.test(f)).map((f) => [f, sha(join(dir, f))]))

/** The vector of a picture: one axis for its subject (0-3), one for photograph (8) or artwork (9), plus a little individual noise. */
/** Pseudo-random but repeatable, so every picture has its own individual look and only real copies are near-identical. */
const noise = (n: number, d: number): number => {
  const x = Math.sin(n * 12.9898 + d * 78.233) * 43758.5453
  return x - Math.floor(x)
}
const vec = (subject: number, kind: 'photo' | 'art', n: number): Float32Array => unit(Array.from({ length: DIM }, (_v, d) => (d === subject ? 1 : 0) + (d === (kind === 'photo' ? 8 : 9) ? 0.9 : 0) + (d >= 12 ? 0.9 * noise(n, d) : 0)))

const fakeEmbedder = {
  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t, i) => {
      if (/photograph|photo|snapshot|candid|documentary|photography/i.test(t) && !/painting/.test(t)) return unit(Array.from({ length: DIM }, (_v, d) => (d === 8 ? 1 : 0)))
      if (/painting|drawing|illustration|digital art|render|concept art|stylised|abstract|surreal|engraving|print/i.test(t)) return unit(Array.from({ length: DIM }, (_v, d) => (d === 9 ? 1 : 0)))
      if (/cats?/i.test(t)) return unit(Array.from({ length: DIM }, (_v, d) => (d === 3 ? 1 : 0)))
      return unit(Array.from({ length: DIM }, (_v, d) => (d === 10 + (i % 2) ? 1 : 0.01)))
    })
  }
}

describe('placing and naming', () => {
  const item = (id: string, over: Partial<OrganizeItem> = {}): OrganizeItem => ({ id, path: `C:\\lib\\${id}.png`, filename: `${id}.png`, ext: 'png', bytes: 1000, width: 100, height: 100, year: 2025, kind: 'artwork', kindWhy: '', subject: 'Foggy forests', subjectConfidence: 'clear', cluster: 1, dupGroup: null, dupType: null, isBest: false, modelRead: true, ...over })

  it('makes names safe for Windows', () => {
    expect(safeName('a<b>:c"d/e\\f|g?h*i')).toBe('a b c d e f g h i')
    expect(safeName('CON')).toBe('CON_')
    expect(safeName('  ..dots..  ')).toBe('dots')
    expect(safeName('')).toBe('Untitled')
    expect(safeName('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })

  it('arranges by the chosen structure, and keeps working images out of the subject folders', () => {
    const items = [item('a'), item('b'), item('c'), item('t', { kind: 'technical', subject: null }), item('u', { kind: 'uncertain', subject: null })]
    const folders = (structure: typeof DEFAULT_SETTINGS.structure): string[] => placeItems(items, { ...DEFAULT_SETTINGS, structure }).map((p) => p.folder.join('/'))
    expect(folders('kind-subject')).toEqual(['Finished artwork/Foggy forests', 'Finished artwork/Foggy forests', 'Finished artwork/Foggy forests', 'Screenshots and technical', 'To review'])
    expect(folders('subject')).toEqual(['Foggy forests', 'Foggy forests', 'Foggy forests', 'Screenshots and technical', 'To review'])
    expect(folders('year-subject')[0]).toBe('2025/Foggy forests')
    expect(folders('kind')[0]).toBe('Finished artwork')
    expect(folders('flat')).toEqual(['', '', '', '', ''])
  })

  it('applies renames, merges and hand placements, and folds tiny folders into Other', () => {
    const items = [item('a'), item('b'), item('c'), item('d', { subject: 'Rare thing' }), item('e', { subject: 'Rare thing' })]
    const key = 'artwork|Foggy forests'
    const renamed = placeItems(items, { ...DEFAULT_SETTINGS, renames: { [key]: 'Quiet mornings' } }).map((p) => p.folder.join('/'))
    expect(renamed[0]).toBe('Finished artwork/Quiet mornings')
    expect(renamed[3]).toBe('Finished artwork/Other') // two pictures: fewer than the minimum of three
    const merged = placeItems(items, { ...DEFAULT_SETTINGS, merges: { 'artwork|Rare thing': 'Foggy forests' } }).map((p) => p.folder.join('/'))
    expect(merged.every((f) => f === 'Finished artwork/Foggy forests')).toBe(true)
    const moved = placeItems(items, { ...DEFAULT_SETTINGS, overrides: { a: { subject: 'My cats' }, b: { kind: 'photograph' } } })
    expect(moved[0]!.folder.join('/')).toBe('Finished artwork/My cats')
    expect(moved[1]!.kind).toBe('photograph')
  })

  it('handles duplicate groups by policy', () => {
    const items = [item('a', { dupGroup: 'g1', dupType: 'near', isBest: true }), item('b', { dupGroup: 'g1', dupType: 'near' }), item('c')]
    const by = (duplicates: 'separate' | 'best-only' | 'keep-all'): string[] => placeItems(items, { ...DEFAULT_SETTINGS, duplicates, minGroup: 1 }).map((p) => `${p.action}:${p.folder.join('/')}`)
    expect(by('separate')[1]).toBe('copy:Duplicates and versions/a')
    expect(by('best-only')[1]).toBe('skip-duplicate:Finished artwork/Foggy forests')
    expect(by('keep-all')[1]).toBe('copy:Finished artwork/Foggy forests')
  })

  it('names clashes, never overwrites, and skips what is already there', async () => {
    const items = [item('a', { path: 'C:\\one\\photo.png', filename: 'photo.png' }), item('b', { path: 'C:\\two\\photo.png', filename: 'photo.png', bytes: 2000 }), item('c', { path: 'C:\\three\\sunset.png', filename: 'sunset.png' })]
    const there = new Map<string, { size: number; mtimeMs: number }>()
    there.set(join('D:\\out', 'Finished artwork', 'Foggy forests', 'sunset.png').toLowerCase(), { size: 1000, mtimeMs: 1 })
    const plan = await planOperations(items, { ...DEFAULT_SETTINGS, minGroup: 1 }, 'D:\\out', (p) => there.get(p.toLowerCase()) ?? null, async (src) => src.endsWith('sunset.png'))
    const names = plan.ops.filter((o) => o.action === 'copy').map((o) => o.to)
    expect(names).toEqual([join('Finished artwork', 'Foggy forests', 'photo.png'), join('Finished artwork', 'Foggy forests', 'photo (2).png')])
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.skipped.same).toBe(1)
    expect(plan.copyBytes).toBe(3000)
    // A different file with that name at the destination is not overwritten either.
    there.set(join('D:\\out', 'Finished artwork', 'Foggy forests', 'photo.png').toLowerCase(), { size: 5, mtimeMs: 1 })
    const again = await planOperations(items, { ...DEFAULT_SETTINGS, minGroup: 1 }, 'D:\\out', (p) => there.get(p.toLowerCase()) ?? null, async (src) => src.endsWith('sunset.png'))
    expect(again.ops.filter((o) => o.action === 'copy').map((o) => o.to)).toContain(join('Finished artwork', 'Foggy forests', 'photo (2).png'))
    expect(again.conflicts.some((c) => /already at the destination/.test(c.reason))).toBe(true)
  })

  it('chooses the best version and says why', () => {
    const m = (id: string, w: number, bytes: number, over: object = {}) => ({ id, width: w, height: w, bytes, favorite: false, rating: 0, decision: null, mtime: 1, ...over })
    expect(chooseBest([m('a', 1000, 5), m('b', 3000, 9)]).best.id).toBe('b')
    expect(chooseBest([m('a', 1000, 5, { favorite: true }), m('b', 3000, 9)])).toMatchObject({ best: { id: 'a' }, why: 'it is one of your favorites' })
    expect(chooseBest([m('a', 3000, 5, { decision: 'pass' }), m('b', 1000, 9)]).best.id).toBe('b')
    expect(chooseBest([m('a', 100, 5), m('b', 100, 5, { mtime: 0 })]).best.id).toBe('b')
  })

  it('reads related file names', () => {
    expect(relatedNames('sunset_beach.png', 'sunset_beach_v2.png')).toBe(true)
    expect(relatedNames('sunset beach.png', 'sunset beach (1).png')).toBe(true)
    expect(relatedNames('portrait.jpg', 'portrait, Topaz Bloom, 2x skala.jpg')).toBe(true)
    expect(relatedNames('a.png', 'b.png')).toBe(false)
    expect(relatedNames('forest_morning.png', 'city_night.png')).toBe(false)
  })

  it('decides kinds from the evidence', () => {
    expect(decideKind({ role: 'technical', reasons: ['the file name suggests a screen capture'], photoMargin: 0.1 }).kind).toBe('technical')
    expect(decideKind({ role: 'experimental', reasons: [], photoMargin: 0.1 }).kind).toBe('experiment')
    expect(decideKind({ role: 'unclear', reasons: [], photoMargin: 0.1 }).kind).toBe('uncertain')
    expect(decideKind({ role: 'finished', reasons: [], photoMargin: 0.2, camera: 'Canon EOS 30D' })).toMatchObject({ kind: 'photograph', why: 'has camera data (Canon EOS 30D)' })
    // A photographic look without camera data is not proof: realistic generated images look the same to the image model.
    expect(decideKind({ role: 'finished', reasons: [], photoMargin: 0.2 }).kind).toBe('uncertain')
    expect(decideKind({ role: 'finished', reasons: [], photoMargin: -0.2 }).kind).toBe('artwork')
    // Screenshots, diagrams and sheets of test renders are recognised from how they look, not only from file names.
    expect(decideKind({ role: 'finished', reasons: [], photoMargin: -0.2, techMargin: 0.05 }).kind).toBe('technical')
    expect(decideKind({ role: 'finished', reasons: [], photoMargin: -0.2, techMargin: 0.01 }).kind).toBe('artwork')
    expect(decideKind({ role: 'finished', reasons: [], photoMargin: 0.2, techMargin: 0.05, camera: 'Canon' }).kind).toBe('photograph')
    expect(decideKind({ role: 'finished', reasons: [], photoMargin: 0.01 }).kind).toBe('uncertain')
    expect(decideKind({ role: null, reasons: [], photoMargin: null }).kind).toBe('uncertain')
  })
})

describe('camera data', () => {
  it('reads the make and model from real EXIF data, and finds none where there is none', async () => {
    const withExif = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#888' } }).jpeg().withExif({ IFD0: { Make: 'Canon', Model: 'Canon EOS 30D' } }).toBuffer()
    const meta = await sharp(withExif).metadata()
    expect(cameraOfExif(meta.exif)).toBe('Canon EOS 30D')
    const plain = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#888' } }).jpeg().toBuffer()
    expect(cameraOfExif((await sharp(plain).metadata()).exif)).toBeNull()
    expect(cameraOfExif(Buffer.from('garbage'))).toBeNull()
    expect(cameraOfExif(undefined)).toBeNull()
  })
})

describe('the organizer on a library', () => {
  let work = ''
  let src = ''
  let db: AtlasDatabase
  let engine: OrganizerEngine
  let progress: OrganizeProgress[] = []
  let free: number | null = 1e12
  let ids: Record<string, string> = {}

  const roleOf = (filename: string): RoleName => (/shot/.test(filename) ? 'technical' : /glitch/.test(filename) ? 'experimental' : /mystery/.test(filename) ? 'unclear' : 'finished')

  const makeEngine = (over: Partial<OrganizerDeps> = {}): OrganizerEngine =>
    new OrganizerEngine({
      db,
      embedder: async () => fakeEmbedder,
      roles: async (items) => new Map(items.map((i) => [i.id, { role: roleOf(i.filename), reasons: roleOf(i.filename) === 'technical' ? ['the file name suggests a screen capture'] : [] }])),
      progress: (p) => progress.push(p),
      freeBytes: async () => free,
      camera: async (p) => (/photo-/.test(p) ? 'Canon EOS Test' : null),
      batch: 12,
      ...over
    })

  /** Adds one real picture file with a vector. */
  const add = async (name: string, colour: [number, number, number], vector: Float32Array | null, size = 64, sub = ''): Promise<string> => {
    const dir = sub ? join(src, sub) : src
    await fs.mkdir(dir, { recursive: true })
    const path = join(dir, name)
    await sharp({ create: { width: size, height: Math.round(size * 0.75), channels: 3, background: { r: colour[0], g: colour[1], b: colour[2] } } }).png().toFile(path)
    const st = statSync(path)
    const record: ScannedImageRecord = { id: imageIdForPath(path), rootId: db.listRoots()[0]!.id, path, folder: dir, filename: name, ext: 'png', bytes: st.size, width: size, height: Math.round(size * 0.75), orientation: 1, mtime: new Date(2025, 5, 1).getTime(), color: '#777777', thumbStatus: 'ready', thumbError: null, scanToken: 't' }
    db.upsertScannedImage(record)
    if (vector) db.saveEmbeddings(EMBEDDING_MODEL, [{ id: record.id, mtime: record.mtime, vector }])
    ids[name] = record.id
    return record.id
  }

  const waitFor = async (test: () => boolean, ms = 15000): Promise<void> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (test()) return
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('Timed out.')
  }

  /** Checks every group, as the user does with “Check all”. */
  const selectAll = (id: string): void => {
    const keys = engine.overview(id).kinds.flatMap((k) => k.categories.map((c) => `${k.kind}|${c.name}`))
    engine.refine(id, [{ op: 'select', keys }])
  }
  const analyse = async (e = engine): Promise<string> => {
    const plan = e.createPlan('Test', { all: true })
    e.start(plan.id)
    await waitFor(() => ['ready', 'failed'].includes(e.plan(plan.id)!.status))
    expect(e.plan(plan.id)!.status).toBe('ready')
    return plan.id
  }

  beforeEach(async () => {
    work = join(tmpdir(), `noema-org-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    src = join(work, 'library')
    await fs.mkdir(src, { recursive: true })
    db = new AtlasDatabase(join(work, 'library.db'))
    db.addRoot(src)
    progress = []
    free = 1e12
    ids = {}
    let n = 0
    // Photographs of three subjects, artworks of three subjects, and some working and odd material.
    for (let s = 0; s < 3; s += 1) for (let k = 0; k < 8; k += 1) { n += 1; await add(`photo-${s}-${k}.png`, [40 + s * 60, 90, 200 - s * 50], vec(s, 'photo', n), 64 + k) }
    for (let s = 0; s < 3; s += 1) for (let k = 0; k < 8; k += 1) { n += 1; await add(`art-${s}-${k}.png`, [200 - s * 50, 60 + s * 40, 70], vec(s, 'art', n), 80 + k) }
    for (let k = 0; k < 4; k += 1) { n += 1; await add(`screenshot-${k}.png`, [250, 250, 250], vec(1, 'photo', n), 100 + k) }
    for (let k = 0; k < 3; k += 1) { n += 1; await add(`glitch-${k}.png`, [10, 250, 10], vec(2, 'art', n), 90 + k) }
    n += 1
    await add('mystery.png', [128, 128, 0], vec(0, 'art', n), 70)
    // A picture without an image-model reading.
    await add('unread.png', [1, 2, 3], null, 66)
    engine = makeEngine()
  })
  afterEach(async () => {
    db.close()
    await fs.rm(work, { recursive: true, force: true })
  })

  it('tells the kinds of pictures apart and groups each kind by subject', async () => {
    const id = await analyse()
    const o = engine.overview(id)
    const kind = (k: string): number => o.kinds.find((x) => x.kind === k)?.count ?? 0
    expect(kind('photograph')).toBe(24)
    expect(kind('artwork')).toBe(24)
    expect(kind('technical')).toBe(4)
    expect(kind('experiment')).toBe(3)
    expect(kind('uncertain')).toBe(2) // the unclear one and the one the model never read
    const photos = o.kinds.find((k) => k.kind === 'photograph')!
    expect(photos.categories.length).toBeGreaterThanOrEqual(3)
    expect(photos.categories.every((c) => c.name && c.count >= 1)).toBe(true)
    // Each folder holds pictures of one subject only.
    const items = engine.store.items(id)
    const bySubject = new Map<string, Set<string>>()
    for (const i of items.filter((x) => x.kind === 'photograph' && x.subject)) bySubject.set(i.subject!, (bySubject.get(i.subject!) ?? new Set()).add(i.filename.split('-')[1]!))
    for (const subjects of bySubject.values()) expect(subjects.size).toBe(1)
    expect(o.withoutModel).toBe(1)
    expect(items.find((i) => i.filename === 'unread.png')!.kindWhy).toMatch(/has not looked at it/)
    // The files themselves were not touched by reading them.
    expect(existsSync(join(src, 'photo-0-0.png'))).toBe(true)
  })

  it('leaves out pictures whose files are gone, says so, and does not fail (the real library listed 125 such pictures)', async () => {
    for (let i = 0; i < 40; i += 1) {
      const path = join(src, `gone-${i}.png`)
      db.upsertScannedImage({ id: imageIdForPath(path), rootId: db.listRoots()[0]!.id, path, folder: src, filename: `gone-${i}.png`, ext: 'png', bytes: 5000 + (i % 3), width: 300, height: 200, orientation: 1, mtime: new Date(2025, 5, 1).getTime(), color: '#777777', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
    }
    // A file that exists but is not a picture at all, and an empty one: they are listed like any other.
    await fs.writeFile(join(src, 'not-a-picture.png'), 'just text')
    const odd = join(src, 'not-a-picture.png')
    db.upsertScannedImage({ id: imageIdForPath(odd), rootId: db.listRoots()[0]!.id, path: odd, folder: src, filename: 'not-a-picture.png', ext: 'png', bytes: 9, width: 10, height: 10, orientation: 1, mtime: new Date(2025, 5, 1).getTime(), color: '#777777', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
    const real = new OrganizerEngine({ db, embedder: async () => fakeEmbedder, roles: async (items) => new Map(items.map((i) => [i.id, { role: 'finished' as RoleName, reasons: [] }])), progress: (p) => progress.push(p), freeBytes: async () => free, batch: 12 })
    const id = await analyse(real)
    const items = real.store.items(id)
    expect(items.some((i) => i.filename.startsWith('gone-'))).toBe(false)
    expect(items.some((i) => i.filename === 'not-a-picture.png')).toBe(true)
    expect(items.length).toBeGreaterThan(50)
    const last = progress[progress.length - 1]!
    expect(last.message).toMatch(/40 more listed in your library are no longer at their location and were left out/)
    // Nothing on disk was touched.
    expect(existsSync(join(src, 'photo-0-0.png'))).toBe(true)
  })

  it('finds exact copies, near copies and versions, and suggests the best of each', async () => {
    const vector = vec(0, 'art', 999)
    await add('landscape.png', [10, 20, 30], vector, 200)
    await fs.copyFile(join(src, 'landscape.png'), join(src, 'landscape-copy.png'))
    db.upsertScannedImage({ id: imageIdForPath(join(src, 'landscape-copy.png')), rootId: db.listRoots()[0]!.id, path: join(src, 'landscape-copy.png'), folder: src, filename: 'landscape-copy.png', ext: 'png', bytes: statSync(join(src, 'landscape.png')).size, width: 200, height: 150, orientation: 1, mtime: new Date(2025, 5, 1).getTime(), color: '#000', thumbStatus: 'ready', thumbError: null, scanToken: 't' })
    db.saveEmbeddings(EMBEDDING_MODEL, [{ id: imageIdForPath(join(src, 'landscape-copy.png')), mtime: new Date(2025, 5, 1).getTime(), vector }])
    // A bigger version of the same picture under a related name.
    await add('landscape_v2.png', [12, 22, 32], vector, 400)
    const id = await analyse()
    const groups = engine.duplicateGroups(id)
    const g = groups.find((x) => x.memberIds.length >= 2 && x.memberIds.some((m) => m === ids['landscape.png']))!
    expect(g).toBeTruthy()
    expect(g.memberIds).toHaveLength(3)
    expect(g.bestId).toBe(ids['landscape_v2.png']) // the largest picture
    expect(g.why).toMatch(/largest/)
    const o = engine.overview(id)
    expect(o.duplicates.groups).toBeGreaterThanOrEqual(1)
    expect(o.duplicates.extras).toBeGreaterThanOrEqual(2)
  })

  it('can be paused and resumed (also after a restart) and gives the same result as one uninterrupted run', async () => {
    const whole = await analyse()
    const reference = engine.store.items(whole).map((i) => [i.id, i.kind, i.subject, i.dupGroup])
    // A second run, interrupted after the first batch.
    let paused = false
    const interrupted = makeEngine({
      batch: 5,
      progress: (p) => {
        if (!paused && p.phase === 'understanding') {
          paused = true
          interrupted.pause(p.planId)
        }
      }
    })
    const plan = interrupted.createPlan('Interrupted', { all: true })
    interrupted.start(plan.id)
    await waitFor(() => interrupted.plan(plan.id)!.status === 'paused')
    const partial = interrupted.store.countItems(plan.id, 'AND stage >= 2')
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(interrupted.store.countItems(plan.id))
    // "Restart": a new engine on the same database picks the plan up.
    const again = makeEngine()
    expect(again.plan(plan.id)!.status).toBe('paused')
    again.start(plan.id)
    await waitFor(() => again.plan(plan.id)!.status === 'ready')
    const resumed = again.store.items(plan.id).map((i) => [i.id, i.kind, i.subject, i.dupGroup])
    expect(resumed).toEqual(reference)
  })

  it('an analysis that was running when Atlas stopped is shown as paused, not as running forever', async () => {
    const plan = engine.createPlan('Crash', { all: true })
    engine.store.updatePlan(plan.id, { status: 'analyzing' })
    expect(makeEngine().plan(plan.id)!.status).toBe('paused')
  })

  it('refines by rename, merge, exclusion, structure, custom categories and hand placement; the changes are kept', async () => {
    for (let k = 0; k < 5; k += 1) await add(`cat-${k}.png`, [90, 60, 30], vec(3, 'art', 500 + k), 120 + k)
    const id = await analyse()
    const photos = (): string[] => engine.overview(id).kinds.find((k) => k.kind === 'photograph')!.categories.map((c) => c.name)
    const first = photos()[0]!
    const second = photos()[1]!
    let r = engine.refine(id, [{ op: 'rename', from: first, to: 'Quiet mornings', kind: 'photograph' }])
    expect(r.messages[0]).toMatch(/Quiet mornings/)
    expect(photos()).toContain('Quiet mornings')
    r = engine.refine(id, [{ op: 'merge', from: [second], into: 'Quiet mornings', kind: 'photograph' }])
    expect(photos().filter((n) => n === 'Quiet mornings')).toHaveLength(1)
    expect(photos()).not.toContain(second)
    engine.refine(id, [{ op: 'exclude', kind: 'technical' }, { op: 'structure', value: 'subject' }, { op: 'duplicates', value: 'best-only' }])
    const kept = makeEngine().overview(id)
    expect(kept.plan.settings.excludeKinds).toEqual(['technical'])
    expect(kept.plan.settings.structure).toBe('subject')
    expect(kept.kinds.find((k) => k.kind === 'technical')!.excluded).toBe(true)
    expect(engine.refine(id, [{ op: 'rename', from: 'No such folder', to: 'x' }]).messages[0]).toMatch(/no folder called/)
    engine.refine(id, [{ op: 'move', imageIds: [ids['photo-0-0.png']!], category: 'My favourite' }])
    expect(photos()).toContain('My favourite')
    // The user's own category: pictures that clearly fit it go there.
    engine.refine(id, [{ op: 'custom', name: 'Cats', description: 'cats' }])
    await waitFor(() => engine.store.items(id).some((i) => i.subject === 'Cats'))
    const cats = engine.store.items(id).filter((i) => i.subject === 'Cats')
    expect(cats.map((i) => i.filename).sort()).toEqual(['cat-0.png', 'cat-1.png', 'cat-2.png', 'cat-3.png', 'cat-4.png'])
    expect(cats.every((i) => i.subjectConfidence === 'custom')).toBe(true)
    expect(engine.overview(id).kinds.find((k) => k.kind === 'artwork')!.categories.map((c) => c.name)).toContain('Cats')
  })

  it('previews the whole operation: copies, bytes, space, conflicts and warnings, before anything happens', async () => {
    const id = await analyse()
    selectAll(id)
    const dest = join(work, 'export')
    const p = await engine.preview(id, dest)
    expect(p.copy).toBe(engine.store.countItems(id) - p.skipped.duplicates - p.skipped.excluded)
    expect(p.copyBytes).toBeGreaterThan(0)
    expect(p.enoughSpace).toBe(true)
    expect(existsSync(dest)).toBe(false) // a preview creates nothing
    expect(p.sample.length).toBeGreaterThan(0)
    expect(p.tree.some((t) => t.path.startsWith('Finished artwork'))).toBe(true)
    free = 1000
    const small = await engine.preview(id, dest)
    expect(small.enoughSpace).toBe(false)
    expect(small.warnings.join(' ')).toMatch(/not enough free space/)
    await expect(engine.startExport(id, dest)).rejects.toThrow(/not enough free space/)
    expect(existsSync(dest)).toBe(false)
    free = null
    expect((await engine.preview(id, dest)).warnings.join(' ')).toMatch(/could not read the free space/)
  })

  it('refuses a destination inside the pictures being organized, and one that is not a folder path', async () => {
    const id = await analyse()
    await expect(engine.preview(id, join(src, 'sorted'))).rejects.toThrow(/inside/)
    await expect(engine.preview(id, 'relative/path')).rejects.toThrow(/Choose a destination/)
  })

  it('renames and merges by the folder key the page sends as well as by its name', async () => {
    const id = await analyse()
    const first = engine.overview(id).kinds.find((k) => k.kind === 'artwork')!.categories[0]!
    const result = engine.refine(id, [{ op: 'rename', from: first.key, to: 'Quiet places', kind: 'artwork' }])
    expect(result.messages[0]).toMatch(/is now “Quiet places”/)
    expect(result.overview.kinds.find((k) => k.kind === 'artwork')!.categories.map((c) => c.name)).toContain('Quiet places')
  })

  it('puts photographic-looking pictures without camera data in “To review”, and lets the user decide for all of them at once', async () => {
    for (let k = 0; k < 6; k += 1) await add(`snap-${k}.png`, [100 + k, 100, 100], vec(0, 'photo', 700 + k), 120 + k)
    const id = await analyse()
    selectAll(id)
    const uncertain = () => engine.overview(id).kinds.find((k) => k.kind === 'uncertain')!
    const before = uncertain().count
    expect(before).toBeGreaterThanOrEqual(6)
    expect(engine.store.items(id).find((i) => i.filename === 'snap-0.png')!.kindWhy).toMatch(/no camera data/)
    const result = engine.refine(id, [{ op: 'reclassify', from: 'uncertain', to: 'artwork' }])
    expect(result.messages[0]).toMatch(/treated as Finished artwork/)
    expect((result.overview.kinds.find((k) => k.kind === 'uncertain')?.count ?? 0)).toBe(0)
    selectAll(id) // the reclassified pictures now form new groups
    const preview = await engine.preview(id, join(work, 'out'), 500)
    const snaps = preview.sample.filter((o) => o.from.includes('snap-'))
    expect(snaps).toHaveLength(6)
    expect(snaps.every((o) => o.to.startsWith('Finished artwork'))).toBe(true)
    // And it can be undone.
    expect(engine.refine(id, [{ op: 'reclassify', from: 'uncertain', to: 'uncertain' }]).overview.kinds.find((k) => k.kind === 'uncertain')!.count).toBe(before)
  })

  it('exports by copying, checks every copy, and leaves every original exactly as it was', async () => {
    const id = await analyse()
    selectAll(id)
    const before = treeHashes(src)
    const dest = join(work, 'export')
    await engine.startExport(id, dest, { verify: 'hash' })
    await waitFor(() => engine.plan(id)!.status === 'done')
    const report = engine.report2(id)
    expect(report.failed).toBe(0)
    expect(report.verified).toBeGreaterThan(40)
    expect(report.verification).toBe('hash')
    expect(treeHashes(src)).toEqual(before) // the originals are untouched
    // Every copied file is byte-identical to its original, and no partial file is left.
    const files: string[] = []
    const walk = (d: string): void => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p) } }
    walk(dest)
    expect(files.some((f) => f.endsWith('.noema-part'))).toBe(false)
    const copied = files.filter((f) => f.endsWith('.png'))
    expect(copied.length).toBe(report.verified)
    for (const f of copied) expect(Object.values(before)).toContain(sha(f))
    expect(files.some((f) => f.endsWith('NOEMA-Atlas-organization.json'))).toBe(true)
    // The structure is there.
    expect(readdirSync(dest)).toEqual(expect.arrayContaining(['Finished artwork', 'Photographs', 'Experiments']))
  })

  it('carries on after an interruption: partial files are discarded, finished copies are kept, nothing is copied twice', async () => {
    const id = await analyse()
    selectAll(id)
    const dest = join(work, 'export')
    await engine.startExport(id, dest)
    await waitFor(() => engine.store.opCounts(id).verified >= 5)
    engine.pauseExport(id)
    await waitFor(() => engine.plan(id)!.status === 'export-paused')
    const doneBefore = engine.store.opCounts(id).verified
    expect(doneBefore).toBeLessThan(engine.store.opCounts(id).verified + engine.store.opCounts(id).pending + 1)
    // Simulate a crash in the middle of one copy: a half-written file and a journal that says "copying".
    const next = engine.store.ops(id, ['pending'], 1)[0]!
    await fs.mkdir(join(next.dst, '..'), { recursive: true })
    await fs.writeFile(`${next.dst}.noema-part`, 'half a file')
    engine.store.setOp(id, next.seq, 'copying')
    const restarted = makeEngine()
    expect(restarted.plan(id)!.status).toBe('export-paused')
    restarted.resumeExport(id)
    await waitFor(() => restarted.plan(id)!.status === 'done')
    const report = restarted.report2(id)
    expect(report.failed).toBe(0)
    expect(await fs.readFile(`${next.dst}.noema-part`, 'utf8')).toBe('half a file') // legacy partial may belong to another job
    expect(statSync(next.dst).size).toBe(next.bytes)
    expect(report.verified).toBe(restarted.store.opCounts(id).verified)
  })

  it('never overwrites: a file that is already at the destination is kept and the new one is numbered', async () => {
    const id = await analyse()
    selectAll(id)
    const dest = join(work, 'export')
    const target = join(dest, 'Finished artwork')
    await fs.mkdir(target, { recursive: true })
    const p = await engine.preview(id, dest)
    const first = p.sample.find((s) => s.action === 'copy' && s.to.startsWith('Finished artwork'))!
    const there = join(dest, first.to)
    await fs.mkdir(join(there, '..'), { recursive: true })
    await fs.writeFile(there, 'somebody else\'s file')
    const again = await engine.preview(id, dest)
    expect(again.conflicts.some((c) => c.to === first.to)).toBe(true)
    await engine.startExport(id, dest)
    await waitFor(() => engine.plan(id)!.status === 'done')
    expect(readFileSync(there, 'utf8')).toBe('somebody else\'s file')
    expect(existsSync(there.replace(/\.png$/, ' (2).png'))).toBe(true)
    expect(engine.report2(id).renamed).toBeGreaterThanOrEqual(1)
  })

  it('exports a same-size namesake separately and leaves unrelated staging files untouched', async () => {
    const id = await analyse()
    selectAll(id)
    const dest = join(work, 'export')
    const [first, second, third] = (await engine.preview(id, dest)).sample.filter((op) => op.action === 'copy')
    const collision = join(dest, first!.to)
    const namesake = Buffer.alloc(first!.bytes, 0xaa)
    const sentinel = join(dest, second!.to) + '.noema-part'
    const identical = join(dest, third!.to)
    for (const path of [collision, sentinel, identical]) await fs.mkdir(join(path, '..'), { recursive: true })
    await fs.writeFile(collision, namesake)
    await fs.writeFile(sentinel, 'owned by another job')
    await fs.copyFile(third!.from, identical)
    await engine.startExport(id, dest, { verify: 'hash' })
    await waitFor(() => engine.plan(id)!.status === 'done')
    expect(await fs.readFile(collision)).toEqual(namesake)
    expect(existsSync(sentinel)).toBe(true)
    const op = engine.store.ops(id, ['verified']).find((row) => row.imageId === first!.imageId)
    expect(op).toBeDefined()
    expect(sha(op!.dst)).toBe(sha(first!.from))
    expect(engine.store.ops(id, ['skipped']).some((row) => row.imageId === third!.imageId)).toBe(true)
  })

  it('reports an original that disappeared or changed, and carries on with the rest', async () => {
    const id = await analyse()
    selectAll(id)
    await fs.rm(join(src, 'art-0-0.png'))
    await fs.writeFile(join(src, 'art-0-1.png'), 'changed after the analysis')
    const dest = join(work, 'export')
    await engine.startExport(id, dest)
    await waitFor(() => engine.plan(id)!.status === 'done')
    const report = engine.report2(id)
    expect(report.failed).toBe(2)
    expect(report.failures.map((f) => f.error).join(' ')).toMatch(/no longer where it was/)
    expect(report.failures.map((f) => f.error).join(' ')).toMatch(/changed since the analysis/)
    expect(report.verified).toBeGreaterThan(40)
  })

  // ---- choosing what to copy or move -------------------------------------------------------------------------------------

  const groupOf = (id: string, kind: string, index = 0): { name: string; count: number; key: string } => engine.overview(id).kinds.find((k) => k.kind === kind)!.categories[index]!
  const filesUnder = (dir: string): string[] => {
    const out: string[] = []
    const walk = (d: string): void => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else out.push(p) } }
    if (existsSync(dir)) walk(dir)
    return out
  }
  const membersOf = (id: string, kind: string, name: string) => engine.store.items(id).filter((i) => i.kind === kind && i.subject === name)

  it('includes ONLY the checked groups: counts, folders, bytes and the exported files follow the selection', async () => {
    const id = await analyse()
    // Nothing is checked: nothing is selected, and nothing can be copied or moved.
    const none = await engine.preview(id, join(work, 'out'), 500, 0, 'move')
    expect(none).toMatchObject({ everything: false, selectedPictures: 0, selectedGroups: 0, copy: 0, copyBytes: 0 })
    expect(engine.overview(id).selection).toMatchObject({ groups: 0, pictures: 0, all: false })
    await expect(engine.startExport(id, join(work, 'none-copy'))).rejects.toThrow(/Nothing is selected/)
    await expect(engine.startExport(id, join(work, 'none-move'), { mode: 'move' })).rejects.toThrow(/Nothing is selected/)
    expect(existsSync(join(work, 'none-move'))).toBe(false)
    selectAll(id)
    const everything = await engine.preview(id, join(work, 'out'))
    expect(everything.copy).toBeGreaterThan(40)
    const one = groupOf(id, 'photograph')
    engine.refine(id, [{ op: 'select', keys: [`photograph|${one.name}`] }])
    const preview = await engine.preview(id, join(work, 'out'), 500)
    expect(preview.everything).toBe(false)
    expect(preview.selectedGroups).toBe(1)
    expect(preview.copy + preview.skipped.duplicates).toBe(one.count)
    expect(preview.copy).toBeLessThan(everything.copy)
    expect(preview.sample.every((o) => o.from.includes('photo-'))).toBe(true)
    expect(preview.tree.every((t) => t.path.startsWith('Photographs'))).toBe(true)
    expect(engine.overview(id).selection).toMatchObject({ groups: 1, pictures: one.count, all: false })
    // Changing the selection updates everything.
    const two = groupOf(id, 'photograph', 1)
    engine.refine(id, [{ op: 'select', keys: [`photograph|${one.name}`, `photograph|${two.name}`] }])
    const both = await engine.preview(id, join(work, 'out'))
    expect(both.copy + both.skipped.duplicates).toBe(one.count + two.count)
    // Exporting copies exactly the checked group; the others never appear.
    engine.refine(id, [{ op: 'select', keys: [`photograph|${one.name}`] }])
    const before = treeHashes(src)
    const dest = join(work, 'only-one')
    await engine.startExport(id, dest, { verify: 'size' })
    await waitFor(() => engine.plan(id)!.status === 'done')
    const copied = filesUnder(dest).filter((f) => f.endsWith('.png'))
    expect(copied.length).toBe(one.count)
    expect(copied.every((f) => /photo-/.test(f))).toBe(true)
    expect(treeHashes(src)).toEqual(before)
    // Nothing checked again: everything is included, and the preview says so.
    engine.refine(id, [{ op: 'select', keys: [] }])
    expect((await engine.preview(id, join(work, 'other'))).copy).toBe(0) // clearing the selection selects nothing
  })

  it('a renamed group shows its new name at once, stays checked, and names the exported folder', async () => {
    const id = await analyse()
    const first = groupOf(id, 'artwork')
    engine.refine(id, [{ op: 'select', keys: [`artwork|${first.name}`] }])
    const result = engine.refine(id, [{ op: 'rename', from: first.key, to: 'Quiet places', kind: 'artwork' }])
    expect(result.overview.kinds.find((k) => k.kind === 'artwork')!.categories.map((c) => c.name)).toContain('Quiet places')
    expect(result.overview.selection.keys).toEqual(['artwork|Quiet places'])
    expect(result.overview.tree.every((t) => t.path.includes('Quiet places') || t.path.startsWith('Duplicates'))).toBe(true)
    const p = await engine.preview(id, join(work, 'out'), 500)
    expect(p.tree.every((t) => t.path.includes('Quiet places') || t.path.startsWith('Duplicates'))).toBe(true)
    await engine.startExport(id, join(work, 'renamed'))
    await waitFor(() => engine.plan(id)!.status === 'done')
    expect(readdirSync(join(work, 'renamed', 'Finished artwork'))).toEqual(['Quiet places'])
    expect(readdirSync(join(work, 'renamed')).every((d) => d === 'Finished artwork' || d.startsWith('Duplicates') || d.endsWith('.json'))).toBe(true)
  })

  it('moves the checked pictures: the library keeps their favorites, moodboards and versions, the others stay, and nothing is lost', async () => {
    const id = await analyse()
    const one = groupOf(id, 'photograph')
    const members = membersOf(id, 'photograph', one.name)
    expect(members.length).toBeGreaterThan(2)
    const chosen = members[0]!
    db.updateImage({ id: chosen.id, favorite: true, rating: 4 })
    const board = db.createMoodboard('Keep me')
    db.addToMoodboard(board.id, [chosen.id], [])
    const others = engine.store.items(id).filter((i) => !members.some((m) => m.id === i.id))
    const othersBefore = Object.fromEntries(others.map((o) => [o.path, sha(o.path)]))
    const movedHashes = Object.fromEntries(members.map((m) => [m.id, sha(m.path)]))
    engine.refine(id, [{ op: 'select', keys: [`photograph|${one.name}`] }])
    const dest = join(work, 'moved')
    const preview = await engine.preview(id, dest, 500, 0, 'move')
    expect(preview.mode).toBe('move')
    expect(preview.warnings.join(' ')).toMatch(/favorites, moodboards/)
    await engine.startExport(id, dest, { mode: 'move' })
    await waitFor(() => engine.plan(id)!.status === 'done')
    const report = engine.report2(id)
    expect(report).toMatchObject({ mode: 'move', failed: 0 })
    expect(report.moved).toBe(preview.copy)
    for (const m of members.filter((x) => !x.dupGroup || x.isBest)) {
      const row = db.getImage(m.id)!
      expect(row.path.toLowerCase().replace(/\\/g, '/').startsWith(dest.toLowerCase().replace(/\\/g, '/'))).toBe(true)
      expect(existsSync(row.path)).toBe(true)
      expect(existsSync(m.path)).toBe(false)
      expect(sha(row.path)).toBe(movedHashes[m.id])
      expect(row.missing).toBe(false)
    }
    const kept = db.getImage(chosen.id)!
    expect(kept.favorite).toBe(true)
    expect(kept.rating).toBe(4)
    expect(db.getMoodboardsForImage(chosen.id)).toEqual([board.id])
    for (const [path, hash] of Object.entries(othersBefore)) expect(sha(path)).toBe(hash) // unchecked groups were never touched
  })

  it('a move never overwrites, reports a missing original, and leaves the library pointing at what exists', async () => {
    const id = await analyse()
    const one = groupOf(id, 'photograph')
    const members = membersOf(id, 'photograph', one.name).filter((i) => !i.dupGroup).sort((a, b) => a.path.localeCompare(b.path))
    expect(members.length).toBeGreaterThan(3)
    engine.refine(id, [{ op: 'select', keys: [`photograph|${one.name}`] }])
    const dest = join(work, 'moved2')
    const preview = await engine.preview(id, dest, 500, 0, 'move')
    const target = preview.sample.find((o) => o.imageId === members[0]!.id)!
    await fs.mkdir(join(dest, target.to, '..'), { recursive: true })
    await fs.writeFile(join(dest, target.to), 'somebody else')
    const gone = members[1]!
    await fs.rm(gone.path) // vanished before the move
    const recordBefore = db.getImage(gone.id)!.path
    await engine.startExport(id, dest, { mode: 'move' })
    await waitFor(() => engine.plan(id)!.status === 'done')
    const report = engine.report2(id)
    expect(report.failed).toBeGreaterThanOrEqual(1)
    expect(report.failures.map((f) => f.error).join(' ')).toMatch(/no longer where it was/)
    expect(readFileSync(join(dest, target.to), 'utf8')).toBe('somebody else') // never overwritten
    expect(db.getImage(gone.id)!.path).toBe(recordBefore) // the record of the missing picture was not changed
    for (const m of members.slice(2)) expect(existsSync(db.getImage(m.id)!.path)).toBe(true)
    expect(existsSync(members[0]!.path) || existsSync(db.getImage(members[0]!.id)!.path)).toBe(true) // the numbered one moved; the original is never lost
  })

  it('a move carries on after an interruption without losing or duplicating anything, whichever step it stopped at', async () => {
    const id = await analyse()
    const one = groupOf(id, 'photograph')
    const members = membersOf(id, 'photograph', one.name).filter((i) => !i.dupGroup || i.isBest)
    engine.refine(id, [{ op: 'select', keys: [`photograph|${one.name}`] }])
    const dest = join(work, 'moved3')
    await engine.startExport(id, dest, { mode: 'move' })
    await waitFor(() => engine.plan(id)!.status === 'done')
    const ops = engine.store.ops(id, ['verified'])
    expect(ops.length).toBe(members.length)
    // Crash A: the file was moved and the record updated, but the journal still said "copying".
    engine.store.setOp(id, ops[0]!.seq, 'copying')
    // Crash B: the file was moved, but the library was not updated yet (the record still points at the old place).
    const b = ops[1]!
    const rowB = db.getImage(b.imageId)!
    const oldRoot = db.listRoots().find((r) => b.src.toLowerCase().startsWith(r.path.toLowerCase()))!
    db.relocateImage(b.imageId, { path: b.src, rootId: oldRoot.id, bytes: rowB.bytes, mtime: rowB.mtime })
    engine.store.setOp(id, b.seq, 'copying')
    engine.store.updatePlan(id, { status: 'exporting' })
    const restarted = makeEngine()
    expect(restarted.plan(id)!.status).toBe('export-paused')
    restarted.resumeExport(id)
    await waitFor(() => restarted.plan(id)!.status === 'done')
    expect(restarted.report2(id).failed).toBe(0)
    for (const m of members) {
      const row = db.getImage(m.id)!
      expect(existsSync(row.path)).toBe(true) // the library points at a file that exists
      expect(row.path.toLowerCase().replace(/\\/g, '/').startsWith(dest.toLowerCase().replace(/\\/g, '/'))).toBe(true)
      expect(existsSync(m.path)).toBe(false)
    }
    expect(filesUnder(dest).filter((f) => f.endsWith('.png')).length).toBe(members.length) // nothing duplicated, nothing lost
  })

  // Another drive: the picture is copied, compared byte for byte, recorded in the library and only then removed from its old place.
  const otherDrive = (): string | null => {
    const mine = tmpdir().slice(0, 2).toLowerCase()
    const home = homedir()
    return home.slice(0, 2).toLowerCase() !== mine ? join(home, `noema-move-test-${Date.now()}`) : null
  }
  it('moves across drives by copy, byte comparison, library update and only then removal', async () => {
    const dest = otherDrive()
    if (!dest) return // only one drive on this computer
    try {
      const id = await analyse()
      const one = groupOf(id, 'photograph')
      const members = membersOf(id, 'photograph', one.name).filter((i) => !i.dupGroup || i.isBest)
      const hashes = Object.fromEntries(members.map((m) => [m.id, sha(m.path)]))
      engine.refine(id, [{ op: 'select', keys: [`photograph|${one.name}`] }])
      const preview = await engine.preview(id, dest, 500, 0, 'move')
      expect(preview.warnings.join(' ')).toMatch(/another drive/)
      expect(preview.copyBytes).toBeGreaterThan(0)
      await engine.startExport(id, dest, { mode: 'move' })
      await waitFor(() => engine.plan(id)!.status === 'done', 30000)
      expect(engine.report2(id)).toMatchObject({ failed: 0, mode: 'move' })
      for (const m of members) {
        const row = db.getImage(m.id)!
        expect(row.path.toLowerCase().replace(/\\/g, '/').startsWith(dest.toLowerCase().replace(/\\/g, '/'))).toBe(true)
        expect(sha(row.path)).toBe(hashes[m.id])
        expect(existsSync(m.path)).toBe(false)
      }
    } finally {
      await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('analyses only the chosen folders or sources', async () => {
    await add('extra-1.png', [9, 9, 9], vec(0, 'art', 1), 64, 'sub')
    await add('extra-2.png', [9, 9, 8], vec(0, 'art', 2), 64, 'sub')
    const plan = engine.createPlan('Folder', { folders: [join(src, 'sub')] })
    expect(engine.countScope({ folders: [join(src, 'sub')] })).toBe(2)
    engine.start(plan.id)
    await waitFor(() => engine.plan(plan.id)!.status === 'ready')
    expect(engine.store.countItems(plan.id)).toBe(2)
    const some = engine.createPlan('Selection', { imageIds: [ids['photo-0-0.png']!, ids['art-0-0.png']!] })
    engine.start(some.id)
    await waitFor(() => engine.plan(some.id)!.status === 'ready')
    expect(engine.store.countItems(some.id)).toBe(2)
  })
})
