// End-to-end check of named families, renaming and selecting images for moodboards in the real application.
//
//   node scripts/e2e-families.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// The library is made from public-domain reference artworks of known kinds (landscapes, architecture, still lifes,
// portraits, prints) plus a deliberately mixed group, so the names Atlas gives can be compared with what the images are.
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-families')
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

const libDir = resolve('.e2e/families-library')
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
const pick = async (shelf, count, prefix) => {
  const items = manifest.items.filter((i) => i.shelf === shelf).slice(0, count)
  let n = 0
  for (const it of items) {
    await sharp(join(packDir, 'images', it.file)).jpeg({ quality: 90 }).toFile(join(libDir, `${prefix}-${String(n).padStart(2, '0')}.jpg`))
    n += 1
  }
}
await pick('romantic-landscape', 30, 'landscape')
await pick('architecture', 24, 'architecture')
await pick('still-life', 20, 'stilllife')
await pick('portrait', 20, 'portrait')
await pick('ukiyo-e', 18, 'print')
for (const shelf of ['abstraction', 'jewelry-metalwork', 'egyptian', 'africa', 'textiles-costume', 'drawings', 'fantastic', 'botanical-natural', 'east-asian-ceramics', 'posters-graphic']) {
  await pick(shelf, 2, `mixed-${shelf}`)
}
const hashAll = async () => {
  const out = {}
  for (const f of await fs.readdir(libDir)) out[f] = createHash('sha256').update(await fs.readFile(join(libDir, f))).digest('hex')
  return out
}
const hashesBefore = await hashAll()
const total = Object.keys(hashesBefore).length

const profile = resolve('.e2e/profile-families')
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
const familiesReady = `(async () => { const f = await window.noema.listFamilies(); return f.families.length > 0 && !f.building && f.clustered === f.embedded && f.families.every((x) => x.name) })()`
const listFamilies = () => page.evaluate(() => window.noema.listFamilies())
const shelfOfFile = (name) => name.replace(/-\d+\.jpg$/, '').replace(/^mixed-.*/, 'mixed')
const composition = (names) => {
  const c = {}
  for (const n of names) c[shelfOfFile(n)] = (c[shelfOfFile(n)] ?? 0) + 1
  return c
}
async function membersOf(familyId) {
  return page.evaluate(async (id) => (await window.noema.listImages({ scope: 'archive', familyId: id, limit: 400 })).items.map((i) => i.filename), familyId)
}

try {
  await launch(true)
  log('Preparing: scanning, learning and grouping the library')
  await until(`(async () => {
    const boot = await window.noema.bootstrap()
    const s = await window.noema.getIndexStatus()
    return !boot.roots.some((r) => r.scanning) && s.total >= ${total} && s.indexed >= s.total
  })()`, 600_000, 2000)
  await until(familiesReady, 180_000, 1500)

  // -------------------------------------------------------------------------------------------
  log('A. Every family gets a meaningful, honest name from what its images share')
  let list = await listFamilies()
  const details = []
  for (const f of list.families) details.push({ f, comp: composition(await membersOf(f.id)) })
  for (const { f, comp } of details) console.log(`  · ${f.name} [${f.nameConfidence}] ${f.size} images: ${Object.entries(comp).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  check(list.families.every((f) => f.name && !/^Family \d+$/.test(f.name)), `${list.families.length} families, all named`)
  check(new Set(list.families.map((f) => f.name.toLowerCase())).size === list.families.length, 'no two families share a name')
  check(list.families.every((f) => f.nameNote), 'each name carries a short explanation of what it rests on')
  const landscape = details.find((d) => (d.comp.landscape ?? 0) >= d.f.size * 0.5)
  check(!!landscape, 'a family made mostly of landscapes exists')
  console.log(`  · landscape family is called "${landscape.f.name}"`)
  check(/landscape|scene|tree|forest|sky|cloud|mountain|field|river|lake|sea|coast|winter|sunset|garden|flower|farm|rural/i.test(landscape.f.name), 'the landscape family is named after landscape-like subjects')
  const architecture = details.find((d) => (d.comp.architecture ?? 0) >= d.f.size * 0.5)
  if (architecture) console.log(`  · architecture family is called "${architecture.f.name}"`)
  // A family made of many different shelves must never get a confident, specific name.
  const mixed = details.filter((d) => Object.keys(d.comp).length >= 4 && Math.max(...Object.values(d.comp)) < d.f.size * 0.5)
  for (const m of mixed) check(m.f.nameConfidence !== 'clear', `"${m.f.name}" mixes ${Object.keys(m.comp).length} kinds of image and is not claimed to be a clear subject`)
  console.log(`  · ${mixed.length} mixed families, ${list.families.filter((f) => f.name === 'Mixed images').length} named "Mixed images"`)

  await page.evaluate(() => (location.hash = '#/families'))
  await page.waitForSelector('.family-card', { timeout: 20_000 })
  await page.waitForTimeout(1200)
  const cardNames = await page.locator('.family-card__name').allInnerTexts()
  check(cardNames.length === list.families.length && cardNames.every((n) => !/^Family \d+$/.test(n)), 'the Families page shows the names')
  await page.screenshot({ path: join(shots, 'f1-families-named.png') })

  // -------------------------------------------------------------------------------------------
  log('B. Renaming a family, and returning to the automatic name')
  const target = landscape.f
  await page.locator('.family-card', { hasText: target.name }).first().click()
  await page.waitForSelector('.family-title__edit', { timeout: 15_000 })
  await page.locator('.family-title__edit').click()
  await page.fill('.family-rename input', 'My quiet place')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.family-title__name')?.textContent === 'My quiet place', null, { timeout: 10_000 })
  check(true, 'the title shows the new name')
  list = await listFamilies()
  const renamed = list.families.find((f) => f.id === target.id)
  check(renamed.customName === 'My quiet place' && renamed.autoName === target.name, 'the user name is stored and the automatic name is kept beside it')
  check(await page.getByText(new RegExp(`Atlas would call it “${target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}”`)).isVisible(), 'the page says what Atlas would have called it')
  await page.screenshot({ path: join(shots, 'f2-family-renamed.png') })

  // -------------------------------------------------------------------------------------------
  log('C. Regrouping keeps the name, and so does a restart')
  const beforeMembers = new Set(await membersOf(target.id))
  await page.getByRole('button', { name: /All families/ }).click()
  await page.getByRole('button', { name: 'Regroup' }).click()
  await page.waitForTimeout(1500)
  await until(familiesReady, 180_000, 1000)
  list = await listFamilies()
  const kept = list.families.find((f) => f.customName === 'My quiet place')
  check(!!kept, 'the renamed family is still there after regrouping')
  const afterMembers = new Set(await membersOf(kept.id))
  const overlap = [...beforeMembers].filter((id) => afterMembers.has(id)).length / beforeMembers.size
  check(overlap > 0.9, `it holds the same images (${Math.round(overlap * 100)}% of them)`)
  check(list.families.filter((f) => f.customName).length === 1, 'no other family received the name')
  await page.waitForSelector('.family-card', { timeout: 15_000 })
  check((await page.locator('.family-card__name', { hasText: 'My quiet place' }).count()) === 1, 'the Families page lists it under the new name')

  await app.close().catch(() => undefined)
  await launch(false)
  await until(async () => (await window.noema.getIndexStatus()).state !== 'loading', 60_000, 1000)
  list = await listFamilies()
  check(list.families.some((f) => f.customName === 'My quiet place'), 'the name survives a restart of the application')

  // -------------------------------------------------------------------------------------------
  log('D. Selecting images in a family and putting them on moodboards')
  await page.evaluate(() => (location.hash = '#/families'))
  await page.locator('.family-card', { hasText: 'My quiet place' }).first().click()
  await page.waitForSelector('.image-card', { timeout: 20_000 })
  const familySize = (await listFamilies()).families.find((f) => f.customName === 'My quiet place').size
  await page.getByRole('button', { name: 'Select images' }).click()
  await page.waitForSelector('.image-card__select')
  const cards = page.locator('.image-card__open')
  await cards.nth(0).click()
  await cards.nth(1).click()
  await cards.nth(2).click()
  check((await page.locator('.selection-bar strong').innerText()).startsWith('3 selected'), 'clicking images selects them')
  await cards.nth(6).click({ modifiers: ['Shift'] })
  await page.waitForTimeout(300)
  const rangeText = await page.locator('.selection-bar strong').innerText()
  check(rangeText.startsWith('7 selected'), `Shift-click selects a range (${rangeText})`)
  await page.locator('.image-card__select').nth(3).click()
  check((await page.locator('.selection-bar strong').innerText()).startsWith('6 selected'), 'one image can be taken out of the selection')
  await page.screenshot({ path: join(shots, 'f3-selecting.png') })
  // Two clearly different actions, each stating its exact count.
  const selectedButton = page.locator('[data-action="selected-board"]')
  const allButton = page.locator('[data-action="all-board"]')
  check((await selectedButton.innerText()).includes('Create moodboard from 6 selected images'), 'the main action says "Create moodboard from 6 selected images"')
  check((await allButton.innerText()).includes(`Create moodboard from all ${familySize} images`), `the other action says "Create moodboard from all ${familySize} images"`)
  const boardsBefore = (await page.evaluate(() => window.noema.listMoodboards())).length
  await allButton.click()
  await page.waitForSelector('.moodboard-dialog')
  check((await page.locator('.moodboard-dialog__title').innerText()) === `Create moodboard from all ${familySize} images`, 'the all-images dialog states the whole family')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.waitForTimeout(300)
  check((await page.evaluate(() => window.noema.listMoodboards())).length === boardsBefore, 'cancelling changes nothing')
  check((await page.locator('.selection-bar strong').innerText()).startsWith('6 selected'), 'the selection survives cancelling')

  await selectedButton.click()
  await page.waitForSelector('.moodboard-dialog')
  check((await page.locator('.moodboard-dialog__title').innerText()) === 'Create moodboard from 6 selected images', 'the selected-images dialog states 6 images')
  await page.waitForFunction(() => document.querySelector('.moodboard-dialog__count')?.textContent?.includes('6 images'), null, { timeout: 8000 })
  check((await page.getByLabel('New moodboard name').inputValue()) === 'My quiet place', 'a new moodboard is offered, named after the family')
  await page.screenshot({ path: join(shots, 'f4-board-dialog.png') })
  check((await page.getByRole('button', { name: /Create moodboard with 6 images/ }).count()) === 1, 'the confirm button repeats the exact count')
  await page.getByRole('button', { name: /Create moodboard with 6 images/ }).click()
  await until(`(async () => (await window.noema.listMoodboards()).some((b) => b.name === 'My quiet place' && b.imageCount === 6))()`, 15_000, 300)
  check(true, 'a moodboard "My quiet place" was created with exactly the 6 selected images, not the whole family')
  await page.waitForFunction(() => !document.querySelector('.selection-bar'), null, { timeout: 8000 })
  check(true, 'selection mode ends after adding')

  // Add to an existing board, with "Select all" reaching images that have not been scrolled into view.
  await page.evaluate(() => window.noema.createMoodboard('Existing board'))
  await page.getByRole('button', { name: 'Select images' }).click()
  await page.getByRole('button', { name: /Select all/ }).click()
  await page.waitForFunction((n) => document.querySelector('.selection-bar strong')?.textContent?.startsWith(`${n} selected`), familySize, { timeout: 10_000 })
  check(true, `"Select all" selects the whole family (${familySize} images)`)
  await page.locator('[data-action="selected-board"]').click()
  await page.waitForSelector('.moodboard-dialog')
  await page.getByText('An existing moodboard').click()
  await page.locator('.moodboard-dialog__boards button', { hasText: 'Existing board' }).click()
  check((await page.getByRole('button', { name: new RegExp(`Add ${familySize} images to “Existing board”`) }).count()) === 1, 'adding to an existing board also states the count')
  await page.getByRole('button', { name: new RegExp(`Add ${familySize} images to`) }).click()
  await until(`(async () => (await window.noema.listMoodboards()).some((b) => b.name === 'Existing board' && b.imageCount === ${familySize}))()`, 20_000, 300)
  check(true, `all ${familySize} images were added to the existing moodboard`)

  // Without a selection, the one button works on the whole family.
  await page.waitForFunction(() => !document.querySelector('.selection-bar'), null, { timeout: 10_000 })
  const wholeButton = page.locator('.page-head__actions').getByRole('button', { name: `Create moodboard from all ${familySize} images` })
  check((await wholeButton.count()) === 1, 'outside selection mode the whole-family button names its count')
  await wholeButton.click()
  await page.waitForSelector('.moodboard-dialog')
  await page.getByRole('button', { name: new RegExp(`Create moodboard with ${familySize} images`) }).click()
  await until(`(async () => (await window.noema.listMoodboards()).filter((b) => b.name === 'My quiet place' && b.imageCount === ${familySize}).length === 1)()`, 20_000, 300)
  check(true, 'a moodboard from the entire family can still be created in one step')
  await page.screenshot({ path: join(shots, 'f5-after-boards.png') })

  // Resetting the name.
  await page.getByRole('button', { name: /Use Atlas.s name/ }).click()
  await page.waitForFunction((n) => document.querySelector('.family-title__name')?.textContent === n, target.name, { timeout: 10_000 })
  check((await listFamilies()).families.every((f) => !f.customName), 'the automatic name comes back when the user resets it')

  // -------------------------------------------------------------------------------------------
  log('E. Everything else still works, and the originals are untouched');
  for (const hash of ['#/collection', '#/archive', '#/favorites', '#/moodboards', '#/sources', '#/taste', '#/families']) {
    await page.evaluate((h) => (location.hash = h), hash)
    await page.waitForTimeout(700)
    check((await page.locator('.page').count()) > 0, `${hash.slice(2)} opens`)
  }
  const found = await page.evaluate(() => window.noema.listImages({ scope: 'archive', search: 'a calm landscape with trees', visual: true, limit: 5 }))
  check(found.total > 0, 'visual search still works')
  check(JSON.stringify(await hashAll()) === JSON.stringify(hashesBefore), `none of the ${total} original image files was changed`)
  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Family checks passed.')
} finally {
  await app?.close().catch(() => undefined)
}
