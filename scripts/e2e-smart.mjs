// End-to-end check of Smart Collections (and the moodboard selection fix) in the real application.
//
//   node scripts/e2e-smart.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// The library is made from public-domain reference artworks, plus landscapes that were recoloured on purpose
// (teal-toned, warm-toned, black and white), so what Atlas matches can be compared with what the images are.
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-smart')
const packDir = resolve('reference')
const modelsDir = process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models')
await fs.mkdir(shots, { recursive: true })

const log = (m) => console.log(`\n◆ ${m}`)
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ✓ ${message}`)
}
check(existsSync(join(packDir, 'manifest.json')), 'the reference collection is built')
check(existsSync(modelsDir), 'the image model is installed')
const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))

const libDir = resolve('.e2e/smart-library')
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
const shelf = (name) => manifest.items.filter((i) => i.shelf === name)
const source = (item) => join(packDir, 'images', item.file)
const copyPlain = async (items, prefix) => {
  let n = 0
  for (const it of items) {
    await sharp(source(it)).jpeg({ quality: 90 }).toFile(join(libDir, `${prefix}-${String(n).padStart(2, '0')}.jpg`))
    n += 1
  }
}
const landscapes = shelf('romantic-landscape')
check(landscapes.length >= 36, `there are enough landscapes to recolour (${landscapes.length})`)
await copyPlain(landscapes.slice(0, 12), 'landscape')
await copyPlain(shelf('architecture').slice(0, 14), 'architecture')
await copyPlain(shelf('still-life').slice(0, 12), 'stilllife')
await copyPlain(shelf('portrait').slice(0, 14), 'portrait')
// Recoloured landscapes: the same kind of picture, in a colour known for certain.
const duotone = async (it, tint, file) => {
  // Every grey level becomes the same level of the chosen colour, so the picture is certainly that colour.
  const { data, info } = await sharp(source(it)).resize(900, 900, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.alloc(info.width * info.height * 3)
  for (let p = 0; p < info.width * info.height; p += 1) {
    const g = data[p] / 255
    out[p * 3] = Math.round(tint ? tint.r * g : data[p])
    out[p * 3 + 1] = Math.round(tint ? tint.g * g : data[p])
    out[p * 3 + 2] = Math.round(tint ? tint.b * g : data[p])
  }
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 90 }).toFile(join(libDir, file))
}
const tinted = async (items, prefix, tint) => {
  let n = 0
  for (const it of items) {
    await duotone(it, tint, `${prefix}-${String(n).padStart(2, '0')}.jpg`)
    n += 1
  }
}
await tinted(landscapes.slice(12, 20), 'teal', { r: 40, g: 235, b: 225 })
await tinted(landscapes.slice(20, 28), 'warm', { r: 255, g: 150, b: 50 })
await tinted(landscapes.slice(28, 36), 'mono', null)

const hashAll = async () => {
  const out = {}
  for (const f of await fs.readdir(libDir)) out[f] = createHash('sha256').update(await fs.readFile(join(libDir, f))).digest('hex')
  return out
}
const hashesBefore = await hashAll()
const total = Object.keys(hashesBefore).length

const profile = resolve('.e2e/profile-smart')
await fs.rm(profile, { recursive: true, force: true })
const baseEnv = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir }
delete baseEnv.ELECTRON_RUN_AS_NODE

let app = null
let page = null
const errors = []
async function launch(seed) {
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env: { ...baseEnv, ...(seed ? { NOEMA_E2E_SEED: libDir } : {}) }, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1500, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}
async function until(predicate, timeout = 30_000, interval = 400) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const kindOf = (filename) => filename.replace(/-\d+\.jpg$/, '')
const preview = (criteria, limit = 200) => page.evaluate(([c, l]) => window.noema.previewSmartCollection(c, l, 0), [criteria, limit])
const base = { text: '', avoid: '', colours: [], tone: 'any', vividness: 'any', shape: 'any', likes: [], dislikes: [], strictness: 50 }
const composition = (items) => {
  const c = {}
  for (const i of items) c[kindOf(i.filename)] = (c[kindOf(i.filename)] ?? 0) + 1
  return c
}
/** The number in "12 images match", once the preview has stopped changing. */
async function settledCount() {
  let last = ''
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(500)
    const text = (await page.locator('[data-testid="smart-count"]').innerText().catch(() => '')) ?? ''
    if (text && !text.startsWith('Looking') && text === last) return Number(text.replace(/[^\d]/g, ''))
    last = text
  }
  throw new Error('The preview did not settle')
}
const listBoards = () => page.evaluate(() => window.noema.listMoodboards())

try {
  await launch(true)
  log('Preparing: scanning, learning and measuring the library')
  await until(`(async () => {
    const boot = await window.noema.bootstrap()
    const s = await window.noema.getIndexStatus()
    return !boot.roots.some((r) => r.scanning) && s.total >= ${total} && s.indexed >= s.total
  })()`, 600_000, 2000)
  await page.evaluate(() => window.noema.refreshSmartCollections())
  check(true, `${total} images scanned, learned and measured`)

  // -------------------------------------------------------------------------------------------
  log('A. The room, the empty state and the nav')
  await page.locator('.nav-button', { hasText: 'Smart Collections' }).click()
  await page.waitForSelector('.page--smart')
  check((await page.locator('.smart-example').count()) >= 3, 'an empty room offers example descriptions')
  check((await page.locator('.nav-button', { hasText: 'Families' }).count()) === 1, 'Families is still in the sidebar beside it')
  await page.screenshot({ path: join(shots, 's1-empty.png') })

  // -------------------------------------------------------------------------------------------
  log('B. Describing a look: colour is read from the words and measured in the pixels')
  await page.locator('[data-action="new-smart"]').click()
  await page.waitForSelector('textarea[aria-label="Describe the look"]')
  await page.fill('textarea[aria-label="Describe the look"]', 'teal-toned landscapes')
  const tealChip = page.locator('.smart-chip', { hasText: 'Teal' })
  await page.waitForFunction(() => [...document.querySelectorAll('.smart-chip')].some((c) => c.textContent.includes('Teal') && c.getAttribute('aria-pressed') === 'true'), null, { timeout: 8000 })
  check((await tealChip.getAttribute('aria-pressed')) === 'true', 'the word "teal" switches on the Teal colour chip')
  const tealCount = await settledCount()
  check(tealCount > 0, `the preview finds images (${tealCount})`)
  await page.screenshot({ path: join(shots, 's2-teal.png') })
  const tealCriteria = { ...base, text: 'teal-toned landscapes', colours: ['teal'] }
  const tealPreview = await preview(tealCriteria)
  const tealComp = composition(tealPreview.items)
  console.log(`  · teal-toned landscapes → ${JSON.stringify(tealComp)}`)
  check((tealComp.teal ?? 0) >= 5, `at least 5 of the 8 teal pictures are found (${tealComp.teal ?? 0})`)
  check((tealComp.warm ?? 0) === 0 && (tealComp.mono ?? 0) === 0, 'no warm or black and white picture is included')
  check(tealPreview.items.length === tealPreview.total && tealPreview.explanation.includes('teal colour'), 'the explanation names the measured colour')

  const warmPreview = await preview({ ...base, text: 'warm-toned landscapes', colours: ['warm'] })
  const warmComp = composition(warmPreview.items)
  console.log(`  · warm-toned landscapes → ${JSON.stringify(warmComp)}`)
  check((warmComp.warm ?? 0) >= 5 && (warmComp.teal ?? 0) === 0, `the warm pictures are found and not the teal ones (${warmComp.warm ?? 0})`)
  const monoPreview = await preview({ ...base, text: 'black and white landscapes', vividness: 'mono' })
  const monoComp = composition(monoPreview.items)
  console.log(`  · black and white landscapes → ${JSON.stringify(monoComp)}`)
  check((monoComp.mono ?? 0) >= 6 && (monoComp.teal ?? 0) === 0 && (monoComp.warm ?? 0) === 0, `the black and white pictures are found (${monoComp.mono ?? 0})`)
  const moody = await preview({ ...base, text: 'melancholic landscapes' })
  console.log(`  · melancholic landscapes → ${moody.total} images, ${JSON.stringify(composition(moody.items))}`)
  check(moody.total > 0 && moody.semantic, 'a description of feeling alone works through the image model')
  const noColour = await preview({ ...base, text: 'portraits of people' })
  const portraitShare = (composition(noColour.items).portrait ?? 0) / Math.max(1, noColour.total)
  console.log(`  · portraits of people → ${noColour.total} images, ${Math.round(portraitShare * 100)}% from the portrait shelf`)
  check(portraitShare >= 0.5, 'a description of a subject finds that subject')

  // -------------------------------------------------------------------------------------------
  log('C. Strictness changes how many images match')
  const slider = page.locator('input[aria-label="Matching strictness"]')
  await slider.fill('10')
  const relaxed = await settledCount()
  await slider.fill('95')
  const strict = await settledCount()
  console.log(`  · relaxed ${relaxed}, strict ${strict}`)
  check(relaxed >= strict, 'a relaxed setting never matches fewer images than a strict one')
  check(relaxed > strict || relaxed === strict, 'both settings give a result')
  await page.screenshot({ path: join(shots, 's3-strict.png') })
  await slider.fill('50')
  await settledCount()

  // -------------------------------------------------------------------------------------------
  log('D. Refining: pin images, rule images out, and a "not like this" description')
  await page.getByRole('button', { name: 'Select images' }).click()
  await page.waitForSelector('.image-card__select')
  const firstIds = await page.evaluate(async (c) => (await window.noema.previewSmartCollection(c, 3, 0)).items.map((i) => i.id), tealCriteria)
  const cards = page.locator('.image-card__open')
  await cards.nth(0).click()
  await cards.nth(1).click()
  check((await page.locator('.selection-bar strong').innerText()).startsWith('2 selected'), 'images are selected with clicks')
  check((await page.locator('[data-action="selected-board"]').innerText()).includes('Create moodboard from 2 selected images'), 'the main action names the 2 selected images')
  await page.locator('[data-action="rule-out"]').click()
  await page.waitForTimeout(800)
  const afterRule = await settledCount()
  check(afterRule === tealCount - 2, `ruling out 2 images removes exactly those 2 (${tealCount} → ${afterRule})`)
  const ruledPreview = await preview({ ...tealCriteria, dislikes: firstIds.slice(0, 2) })
  check(!ruledPreview.items.some((i) => firstIds.slice(0, 2).includes(i.id)), 'the ruled-out images are gone from the results')
  await page.screenshot({ path: join(shots, 's4-refined.png') })

  // -------------------------------------------------------------------------------------------
  log('E. Saving, and moodboards from exactly the selected images or from everything')
  await page.fill('input[aria-label="Collection name"]', 'Teal landscapes')
  await page.locator('[data-action="save-smart"]').click()
  await page.waitForFunction(() => document.querySelector('.page-title .family-title__name')?.textContent === 'Teal landscapes' && document.querySelector('.family-title__edit'), null, { timeout: 15_000 })
  let saved = (await page.evaluate(() => window.noema.listSmartCollections())).find((c) => c.name === 'Teal landscapes')
  check(!!saved && saved.size === afterRule, `the collection is saved with its ${afterRule} matches`)
  check(saved.criteria.colours.join() === 'teal' && saved.criteria.dislikes.length === 2, 'its description, colour and refinements are stored')
  await page.screenshot({ path: join(shots, 's5-saved.png') })

  await page.getByRole('button', { name: 'Select images' }).click()
  await page.waitForSelector('.image-card__select')
  const cards2 = page.locator('.image-card__open')
  await cards2.nth(0).click()
  await cards2.nth(1).click()
  await cards2.nth(2).click()
  check((await page.locator('[data-action="selected-board"]').innerText()).includes('Create moodboard from 3 selected images'), 'the main action says "Create moodboard from 3 selected images"')
  check((await page.locator('[data-action="all-board"]').innerText()).includes(`Create moodboard from all ${saved.size} images`), `and the other says "Create moodboard from all ${saved.size} images"`)
  await page.locator('[data-action="selected-board"]').click()
  await page.waitForSelector('.moodboard-dialog')
  await page.waitForFunction(() => document.querySelector('.moodboard-dialog__count')?.textContent?.includes('3 images'), null, { timeout: 8000 })
  await page.screenshot({ path: join(shots, 's6-board-dialog.png') })
  await page.getByLabel('New moodboard name').fill('Three teal')
  await page.getByRole('button', { name: /Create moodboard with 3 images/ }).click()
  await until(`(async () => (await window.noema.listMoodboards()).some((b) => b.name === 'Three teal' && b.imageCount === 3))()`, 15_000, 300)
  check(true, 'the moodboard holds exactly the 3 selected images')

  await page.locator('.smart-actions').getByRole('button', { name: `Create moodboard from all ${saved.size} images` }).click()
  await page.waitForSelector('.moodboard-dialog')
  check((await page.locator('.moodboard-dialog__title').innerText()) === `Create moodboard from all ${saved.size} images`, 'the whole-collection dialog states the full count')
  await page.getByLabel('New moodboard name').fill('All teal')
  await page.getByRole('button', { name: new RegExp(`Create moodboard with ${saved.size} images`) }).click()
  await until(`(async () => (await window.noema.listMoodboards()).some((b) => b.name === 'All teal' && b.imageCount === ${saved.size}))()`, 20_000, 300)
  check(true, `a moodboard from the whole collection holds all ${saved.size} images`)

  // -------------------------------------------------------------------------------------------
  log('F. The collection keeps itself up to date when new images arrive')
  const rootId = (await page.evaluate(() => window.noema.bootstrap())).roots[0].id
  // New pictures of the same kind: more recoloured landscapes (teal, and one warm).
  await tinted(landscapes.slice(12, 20), 'teal-new', { r: 30, g: 225, b: 215 })
  await duotone(landscapes[20], { r: 255, g: 150, b: 50 }, 'warm-new-00.jpg')
  await page.getByRole('button', { name: /All smart collections/ }).click()
  await page.waitForSelector('.smart-card')
  await page.evaluate((id) => window.noema.rescanRoot(id), rootId)
  await until(`(async () => (await window.noema.listSmartCollections()).some((c) => c.name === 'Teal landscapes' && c.size >= ${saved.size + 3}))()`, 240_000, 2000)
  saved = (await page.evaluate(() => window.noema.listSmartCollections())).find((c) => c.name === 'Teal landscapes')
  check(saved.size >= afterRule + 3, `new teal pictures joined by themselves (${afterRule} → ${saved.size})`)
  const members = await page.evaluate((id) => window.noema.smartCollectionImageIds(id), saved.id)
  const memberNames = await page.evaluate(async (ids) => (await Promise.all(ids.slice(0, 200).map((id) => window.noema.getImage(id)))).map((i) => i.filename), members)
  check(!memberNames.some((n) => n.startsWith('warm-new')), 'the new warm picture did not')
  check(saved.newCount >= 3, `the card says how many are new (${saved.newCount})`)
  await page.waitForFunction(() => document.querySelector('.smart-card .family-card__tag--own')?.textContent?.includes('new'), null, { timeout: 10_000 })
  await page.screenshot({ path: join(shots, 's7-new.png') })
  await page.locator('.smart-card', { hasText: 'Teal landscapes' }).click()
  await page.waitForSelector('textarea[aria-label="Describe the look"]')
  await until(`(async () => (await window.noema.listSmartCollections()).find((c) => c.name === 'Teal landscapes').newCount === 0)()`, 10_000, 300)
  check(true, 'opening the collection clears the "new" count')

  // -------------------------------------------------------------------------------------------
  log('G. It survives a restart, coexists with Families, and never touches the originals')
  await app.close().catch(() => undefined)
  await launch(false)
  await until(`(async () => (await window.noema.getIndexStatus()).state !== 'loading')()`, 60_000, 1000)
  const afterRestart = (await page.evaluate(() => window.noema.listSmartCollections())).find((c) => c.name === 'Teal landscapes')
  check(!!afterRestart && afterRestart.size === saved.size, 'the collection and its matches are still there after a restart')
  await page.locator('.nav-button', { hasText: 'Families' }).click()
  await page.waitForTimeout(1500)
  check((await page.locator('.page--families').count()) === 1, 'the Families room still opens')
  await page.locator('.nav-button', { hasText: 'Smart Collections' }).click()
  await page.waitForSelector('.smart-card')
  check((await page.locator('.smart-card').count()) === 1, 'the Smart Collections room lists the saved collection')
  for (const hash of ['#/collection', '#/archive', '#/favorites', '#/moodboards', '#/sources', '#/taste']) {
    await page.evaluate((h) => (location.hash = h), hash)
    await page.waitForTimeout(600)
    check((await page.locator('.page').count()) > 0, `${hash.slice(2)} opens`)
  }
  const nowHashes = await hashAll()
  check(Object.entries(hashesBefore).every(([name, hash]) => nowHashes[name] === hash), `none of the ${total} original image files was changed`)

  // -------------------------------------------------------------------------------------------
  log('H. Deleting a collection removes only the description')
  await page.evaluate(() => (location.hash = '#/smart'))
  await page.locator('.smart-card', { hasText: 'Teal landscapes' }).click()
  await page.waitForSelector('textarea[aria-label="Describe the look"]')
  const imagesBefore = (await page.evaluate(() => window.noema.bootstrap())).stats.images
  await page.getByRole('button', { name: /Delete collection/ }).first().click()
  await page.getByRole('button', { name: 'Delete collection' }).last().click()
  await until(`(async () => (await window.noema.listSmartCollections()).length === 0)()`, 10_000, 300)
  check((await page.evaluate(() => window.noema.bootstrap())).stats.images === imagesBefore, 'no image was removed from the library')
  check((await listBoards()).some((b) => b.name === 'All teal'), 'the moodboards made from it remain')
  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Smart Collection checks passed.')
} finally {
  await app?.close().catch(() => undefined)
}
