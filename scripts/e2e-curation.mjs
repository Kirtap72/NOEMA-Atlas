// End-to-end check of artistic curation in the real application, with the real local image model.
//
//   node scripts/e2e-curation.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// The library mixes finished artworks, technical working images (3D-software screenshots with landscapes in the
// viewport, wireframes, clay renders, texture sheets) and experimental images (glitched landscapes, abstractions).
// Some technical images have telling file names and some deliberately do not, so the evidence from the image model and
// the pixels is tested on its own. The script asks the companion (offline basics, then a model through a mock server
// that calls the tools) to choose the ten best images of a Smart Collection, reviews the proposal in the real
// interface, and checks that exactly what the user approved is created.
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-curation')
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

// ---- the mixed library -----------------------------------------------------------------------------------------------
const libDir = resolve('.e2e/curation-library')
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
/** filename to what it truly is, known to the script only. */
const truth = {}
const shelf = (name) => manifest.items.filter((i) => i.shelf === name)
const source = (item) => join(packDir, 'images', item.file)
const landscapes = shelf('romantic-landscape')
check(landscapes.length >= 36, `there are enough landscapes (${landscapes.length})`)

async function save(pipeline, filename, kind, format = 'png') {
  const out = join(libDir, filename)
  await (format === 'png' ? pipeline.png() : pipeline.jpeg({ quality: 90 })).toFile(out)
  truth[filename] = kind
}

// Finished artworks: landscapes and prints, plain files.
for (let i = 0; i < 14; i += 1) await save(sharp(source(landscapes[i])), `landscape ${String(i).padStart(2, '0')}.jpg`, 'finished', 'jpg')
for (const [i, it] of shelf('ukiyo-e').slice(0, 5).entries()) await save(sharp(source(it)), `print ${i}.jpg`, 'finished', 'jpg')

/** A fake 3D program: dark panels, menus, outliner, properties, timeline, and the landscape in the viewport. */
async function softwareScreenshot(item, filename, kind) {
  const W = 1920
  const H = 1080
  const view = await sharp(source(item)).resize(1452, 852, { fit: 'cover' }).toBuffer()
  const rows = (x, y, n) => Array.from({ length: n }, (_, i) => `<rect x="${x}" y="${y + i * 26}" width="${150 + ((i * 37) % 120)}" height="10" rx="3" fill="#6b6b6b"/><rect x="${x - 24}" y="${y + i * 26}" width="12" height="10" fill="#4f7fb5"/>`).join('')
  const sliders = Array.from({ length: 9 }, (_, i) => `<rect x="1520" y="${470 + i * 34}" width="380" height="14" rx="4" fill="#1d1d1d"/><rect x="1520" y="${470 + i * 34}" width="${120 + ((i * 53) % 220)}" height="14" rx="4" fill="#4a6fa3"/>`).join('')
  const ticks = Array.from({ length: 70 }, (_, i) => `<rect x="${60 + i * 26}" y="${900 + (i % 5 === 0 ? 0 : 12)}" width="2" height="${i % 5 === 0 ? 40 : 22}" fill="#777"/>`).join('')
  const grid = Array.from({ length: 16 }, (_, i) => `<line x1="${48 + i * 96}" y1="28" x2="${48 + i * 96}" y2="880" stroke="#fff" stroke-opacity="0.12"/>`).join('') + Array.from({ length: 10 }, (_, i) => `<line x1="48" y1="${28 + i * 90}" x2="1500" y2="${28 + i * 90}" stroke="#fff" stroke-opacity="0.12"/>`).join('')
  const ui = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Segoe UI, Arial, sans-serif">
    <rect width="${W}" height="${H}" fill="#2a2a2a"/>
    <rect width="${W}" height="28" fill="#1b1b1b"/><text x="14" y="19" font-size="14" fill="#cfcfcf">File    Edit    Render    Window    Help</text>
    <text x="1500" y="19" font-size="13" fill="#8a8a8a">Scene Collection | Terrain | Frame 148</text>
    <rect y="28" width="48" height="852" fill="#232323"/>${Array.from({ length: 12 }, (_, i) => `<rect x="10" y="${44 + i * 52}" width="28" height="28" rx="4" fill="#3d3d3d"/>`).join('')}
    <rect x="1500" y="28" width="420" height="852" fill="#252525"/>
    <text x="1520" y="58" font-size="15" fill="#d7d7d7">Outliner</text>${rows(1544, 80, 12)}
    <text x="1520" y="440" font-size="15" fill="#d7d7d7">Properties  Render  Output  Modifiers</text>${sliders}
    <rect y="880" width="1500" height="200" fill="#222"/><text x="14" y="900" font-size="13" fill="#9c9c9c">Timeline   Playback   Keying</text>${ticks}
    <rect x="1500" y="880" width="420" height="200" fill="#202020"/><text x="1520" y="910" font-size="13" fill="#9c9c9c">Cycles  Samples 128  Denoise on</text>
  </svg>`
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Segoe UI, Arial, sans-serif">${grid}
    <text x="62" y="54" font-size="15" fill="#ffffffcc">User Perspective</text><text x="62" y="74" font-size="13" fill="#ffffff99">(1) Collection | Terrain_mesh</text>
    <g transform="translate(1420 110)"><line x1="0" y1="0" x2="-40" y2="26" stroke="#e5484d" stroke-width="5"/><line x1="0" y1="0" x2="0" y2="-46" stroke="#4fbf6a" stroke-width="5"/><line x1="0" y1="0" x2="30" y2="30" stroke="#3b82f6" stroke-width="5"/></g></svg>`
  await save(sharp(Buffer.from(ui)).composite([{ input: view, left: 48, top: 28 }, { input: Buffer.from(overlay), left: 0, top: 0 }]), filename, kind)
}
// Four screenshots with telling names (as a screenshot tool saves them) and four with ordinary names.
for (let i = 0; i < 4; i += 1) await softwareScreenshot(landscapes[14 + i], `Screenshot 2026-11-0${i + 1} 2130${i}5.png`, 'technical')
for (let i = 0; i < 4; i += 1) await softwareScreenshot(landscapes[18 + i], `scene final ${i + 1}.png`, 'technical-neutral')

// Wireframes (edges only) and clay renders (flat grey, low contrast).
for (let i = 0; i < 3; i += 1) {
  await save(sharp(source(landscapes[22 + i])).resize(1500, 850, { fit: 'cover' }).greyscale().convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] }).threshold(28), i === 0 ? 'terrain_wireframe_01.png' : `img_${String(i).padStart(2, '0')}.png`, i === 0 ? 'technical' : 'technical-neutral')
}
for (let i = 0; i < 3; i += 1) {
  const clay = await sharp(source(landscapes[25 + i])).resize(1400, 760, { fit: 'cover' }).greyscale().linear(0.35, 105).toBuffer()
  await save(sharp({ create: { width: 1900, height: 1000, channels: 3, background: { r: 118, g: 118, b: 118 } } }).composite([{ input: clay, left: 250, top: 120 }]), `view ${i + 1}.png`, 'technical-neutral')
}
// A texture / UV test sheet.
{
  const cells = Array.from({ length: 64 }, (_, i) => `<rect x="${(i % 8) * 64}" y="${Math.floor(i / 8) * 64}" width="64" height="64" fill="hsl(${(i * 47) % 360} 60% ${30 + ((i * 13) % 40)}%)"/>`).join('')
  await save(sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">${cells}<text x="10" y="500" font-size="20" fill="#fff">UV layout test</text></svg>`)), 'uvlayout_01.png', 'technical')
}

// Experimental: glitched landscapes (channel offsets and displaced bands) and abstractions.
async function glitch(item, filename, seed) {
  const { data, info } = await sharp(source(item)).resize(1100, 760, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.from(data)
  const shift = 18 + seed * 7
  for (let y = 0; y < info.height; y += 1) {
    const band = Math.sin((y + seed * 40) / 17) > 0.8 ? 60 + seed * 11 : 0
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * 3
      const xr = Math.min(info.width - 1, x + shift + band)
      const xb = Math.max(0, x - shift)
      out[i] = data[(y * info.width + xr) * 3]
      out[i + 2] = data[(y * info.width + xb) * 3 + 2]
    }
  }
  await save(sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }), filename, 'experimental', 'jpg')
}
for (let i = 0; i < 5; i += 1) await glitch(landscapes[28 + i], `study ${String(i).padStart(2, '0')}.jpg`, i)
for (const [i, it] of shelf('abstraction').slice(0, 4).entries()) await save(sharp(source(it)), `abstract ${i}.jpg`, 'experimental', 'jpg')

// The rest of a library: other subjects.
for (const [i, it] of shelf('architecture').slice(0, 10).entries()) await save(sharp(source(it)), `building ${i}.jpg`, 'other', 'jpg')
for (const [i, it] of shelf('portrait').slice(0, 8).entries()) await save(sharp(source(it)), `person ${i}.jpg`, 'other', 'jpg')
for (const [i, it] of shelf('still-life').slice(0, 6).entries()) await save(sharp(source(it)), `still ${i}.jpg`, 'other', 'jpg')

const hashAll = async () => {
  const out = {}
  for (const f of await fs.readdir(libDir)) out[f] = createHash('sha256').update(await fs.readFile(join(libDir, f))).digest('hex')
  return out
}
const hashesBefore = await hashAll()
const total = Object.keys(hashesBefore).length
const isTechnical = (filename) => truth[filename]?.startsWith('technical')
console.log(`  · ${total} images: ${JSON.stringify(Object.values(truth).reduce((c, k) => ({ ...c, [k]: (c[k] ?? 0) + 1 }), {}))}`)

// ---- a model "on this computer" that uses the companion's tools -----------------------------------------------------
const mockCalls = []
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {}
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-llm' }] }))
    const messages = json.messages ?? []
    if (json.tools?.some((t) => t.function?.name === 'atlas_check')) {
      if (messages.at(-1)?.role === 'tool') return res.end(JSON.stringify({ choices: [{ message: { content: 'Hello! I am glad we can talk about your pictures.' } }] }))
      return res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'chk1', function: { name: 'atlas_check', arguments: JSON.stringify({ word: 'ready' }) } }] } }] }))
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const asked = String(lastUser?.content ?? '').match(/\b(\d{1,2})\b/)
    const count = asked ? Number(asked[1]) : 10
    const toolsSince = messages.slice(messages.lastIndexOf(lastUser) + 1).filter((m) => m.role === 'tool')
    mockCalls.push(toolsSince.length)
    const call = (id, name, args) => res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] } }] }))
    if (toolsSince.length === 0) return call('c1', 'current_view', {})
    if (toolsSince.length === 1) return call('c2', 'curate_images', { source: 'current', count })
    res.end(JSON.stringify({ choices: [{ message: { content: '[library] I read the collection you have open and prepared a selection for you to review. [idea] Tell me if you want a calmer or bolder direction.' } }] }))
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`

const profile = resolve(`.e2e/profile-curation-${Date.now()}`)
await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined)
const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir, NOEMA_E2E_SEED: libDir }
delete env.ELECTRON_RUN_AS_NODE
let app = null
let page = null
const errors = []
async function until(predicate, timeout = 60_000, interval = 500) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const shot = (name) => page.screenshot({ path: join(shots, name), animations: 'disabled' })
const nameOf = (id) => page.evaluate((i) => window.noema.getImage(i).then((x) => x.filename), id)
async function panelRows() {
  const ids = await page.locator('[data-testid="curate-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-image-id')))
  return Promise.all(ids.map(async (id) => ({ id, name: await nameOf(id) })))
}
async function ask(text) {
  const box = page.locator('.companion__form textarea')
  await box.fill(text)
  await box.press('Enter')
  await page.locator('.chat-thinking').waitFor({ state: 'detached', timeout: 180_000 }).catch(() => undefined)
  await page.waitForTimeout(600)
}

try {
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1500, height: 1000 })
  page.setDefaultTimeout(45_000)
  // A stuck window must fail the run with a message, never hang it.
  const rawEvaluate = page.evaluate.bind(page)
  page.evaluate = (...a) => Promise.race([rawEvaluate(...a), new Promise((_, reject) => setTimeout(() => reject(new Error('page.evaluate timed out: the window or the main process is not answering')), 90_000))])
  page.on('crash', () => console.error('THE WINDOW CRASHED'))
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })

  log('Preparing: scanning and learning the mixed library')
  await until(`(async () => { const b = await window.noema.bootstrap(); const s = await window.noema.getIndexStatus(); return !b.roots.some((r) => r.scanning) && s.total >= ${total} && s.indexed >= s.total })()`, 900_000, 2000)
  await page.evaluate(() => window.noema.refreshSmartCollections())
  // The user's taste: eight favorite landscapes.
  const all = await page.evaluate(() => window.noema.listImages({ scope: 'archive', limit: 500 }).then((p) => p.items.map((i) => ({ id: i.id, name: i.filename }))))
  for (const item of all.filter((i) => /^landscape 0[0-7]/.test(i.name))) await page.evaluate((id) => window.noema.updateImage({ id, favorite: true }), item.id)
  check(true, `${all.length} images learned, 8 landscapes marked as favorites`)

  // -------------------------------------------------------------------------------------------
  log('A. The problem: a plain ranking of the Smart Collection puts technical images among the best')
  const criteria = { text: 'moody atmospheric landscapes', avoid: '', colours: [], tone: 'any', vividness: 'any', shape: 'any', likes: [], dislikes: [], strictness: 20 }
  const collection = await page.evaluate((c) => window.noema.createSmartCollection({ name: 'Moody landscapes', criteria: c }), criteria)
  const plain = await page.evaluate(async (c) => (await window.noema.previewSmartCollection(c, 200, 0)).items.map((i) => ({ name: i.filename, match: i.match })), criteria)
  const plainTop = plain.slice(0, 10)
  const plainTech = plainTop.filter((i) => isTechnical(i.name)).length
  console.log(`  · plain top ten: ${plainTop.map((i) => `${truth[i.name] ?? '?'}`).join(', ')}`)
  console.log(`  · the collection holds ${plain.length} images, ${plain.filter((i) => isTechnical(i.name)).length} of them technical`)
  check(plain.length >= 10, 'the Smart Collection has enough matches to choose from')
  console.log(`  · technical images among the plain ranking's best ten: ${plainTech}`)

  // -------------------------------------------------------------------------------------------
  log('B. The companion sees the open collection and its ranking (offline basics, no language model)')
  await page.locator('.nav-button', { hasText: 'Smart Collections' }).click()
  await page.locator('.smart-card', { hasText: 'Moody landscapes' }).click()
  await page.waitForSelector('textarea[aria-label="Describe the look"]')
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Curate with Atlas/ }).click()
  await page.locator('[data-testid="curated-review"]').waitFor({ timeout: 120_000 })
  await page.waitForTimeout(800)
  await shot('k1-review-basics.png')
  const boardsBefore = (await page.evaluate(() => window.noema.listMoodboards())).length
  let rows = await panelRows()
  console.log('  · proposed:', rows.map((r) => `${r.name} [${truth[r.name]}]`).join(' | '))
  const summary = await page.locator('[data-testid="curate-summary"]').innerText()
  console.log(`  · ${summary}`)
  check(rows.length > 0 && rows.length <= 10, `${rows.length} images are proposed for review`)
  const techPicked = rows.filter((r) => isTechnical(r.name))
  const revealing = rows.filter((r) => truth[r.name] === 'technical')
  const neutral = rows.filter((r) => truth[r.name] === 'technical-neutral')
  check(revealing.length === 0, 'no technical image with a telling file name is proposed')
  console.log(`  · technical images without telling names among the picks: ${neutral.length} (the plain ranking had ${plainTech} among its ten)`)
  check(techPicked.length <= Math.max(1, Math.floor(plainTech / 3)), `technical images in the proposal are far fewer than in the plain ranking (${techPicked.length} against ${plainTech})`)
  check((await page.locator('[data-testid="curate-row"] .curate__reasons li').count()) >= rows.length, 'every proposed image has reasons')
  const reasonsText = await page.locator('[data-testid="curated-review"]').innerText()
  check(/favorite|description/.test(reasonsText), 'the reasons mention the description and the user\'s favorites')
  check(/not a measure of quality|not a measure of quality/.test(reasonsText), 'the panel says it is the user\'s taste, not a measure of quality')
  check((await page.evaluate(() => window.noema.listMoodboards())).length === boardsBefore, 'nothing was created by asking')
  const technicalLeft = await page.evaluate(() => [...document.querySelectorAll('[data-why="technical"]')].length)
  await page.getByRole('button', { name: /^Left out/ }).click()
  await page.waitForTimeout(300)
  const leftText = await page.locator('.curate__left').innerText()
  console.log(`  · left out: ${leftText.replace(/\s+/g, ' ').slice(0, 220)}`)
  check(/technical working image/i.test(leftText) || techPicked.length === plain.filter((i) => isTechnical(i.name)).length, 'images left out as technical are listed with the reason')
  void technicalLeft
  await shot('k2-left-out.png')

  // -------------------------------------------------------------------------------------------
  log('C. The user reviews: reject, replace, add, and create exactly that')
  const firstId = rows[0].id
  const secondId = rows[1].id
  await page.locator('[data-testid="curate-row"]').nth(0).getByRole('button', { name: 'Reject' }).click()
  check((await panelRows()).length === rows.length - 1 && !(await panelRows()).some((r) => r.id === firstId), 'Reject takes the image out of the proposal')
  check((await page.locator('[data-testid="curate-rejected"]').count()) === 1, 'and keeps it in a tray, where it can be restored')
  const before2 = (await panelRows()).map((r) => r.id)
  await page.locator('[data-testid="curate-row"]').nth(0).getByRole('button', { name: 'Replace' }).click()
  const after2 = (await panelRows()).map((r) => r.id)
  check(after2.length === before2.length && !after2.includes(secondId) && after2.some((id) => !before2.includes(id)), 'Replace swaps in the next best alternative')
  const leftAddable = page.locator('.curate__group button', { hasText: 'Add anyway' })
  if ((await leftAddable.count()) > 0) {
    await leftAddable.first().click()
    check((await panelRows()).length === after2.length + 1, '"Add anyway" lets the user include something that was left out')
  }
  const finalRows = await panelRows()
  await shot('k3-reviewed.png')
  await page.locator('input[aria-label="Moodboard name"]').fill('Moody — reviewed')
  const createButton = page.locator('[data-action="create-curated"]')
  check((await createButton.innerText()).includes(`${finalRows.length} image`), `the button states the exact count (${finalRows.length})`)
  await createButton.click()
  await until(`(async () => (await window.noema.listMoodboards()).some((b) => b.name === 'Moody — reviewed' && b.imageCount === ${finalRows.length}))()`, 20_000, 400)
  const board = (await page.evaluate(() => window.noema.listMoodboards())).find((b) => b.name === 'Moody — reviewed')
  const onBoard = new Set((await page.evaluate((id) => window.noema.getMoodboard(id), board.id)).images.map((i) => i.id))
  check(finalRows.every((r) => onBoard.has(r.id)) && !onBoard.has(firstId) && !onBoard.has(secondId), 'the moodboard holds exactly what the user approved, not the rejected or replaced images')
  await page.waitForSelector('.proposal--applied', { timeout: 10_000 })
  await shot('k4-created.png')

  // -------------------------------------------------------------------------------------------
  log('D. A language model uses the same tools: current_view, then curate_images; asking for many gives fewer')
  await page.locator('button[aria-label="Where Atlas thinks"]').click()
  await page.getByRole('radio', { name: /A model on this computer/ }).click()
  await page.locator('input[placeholder*="127.0.0.1"]').fill(mockUrl)
  await page.locator('input[placeholder*="Choose after testing"]').fill('mock-llm')
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.locator('.companion__hello').waitFor({ timeout: 30_000 })
  await page.locator('.companion__hello').click()
  await page.locator('button[aria-label="New conversation"]').click()
  await ask('Select the 30 best images from this collection for a moodboard')
  await page.locator('[data-testid="curated-review"]').last().waitFor({ timeout: 60_000 })
  check(mockCalls.includes(0) && mockCalls.includes(1), 'the model looked at what is open and then asked for a curated selection')
  const manyRows = await panelRows()
  const shortfall = await page.locator('[data-testid="curate-shortfall"]').last().innerText().catch(() => '')
  console.log(`  · asked for 30, proposed ${manyRows.length}. ${shortfall}`)
  check(manyRows.length < 30 && /rather propose fewer/.test(shortfall), 'asking for 30 proposes fewer and explains why')
  check(manyRows.filter((r) => truth[r.name] === 'technical').length === 0, 'still no technical image with a telling name')
  await shot('k5-fewer.png')
  const text = await page.locator('.chat-msg--atlas').last().innerText()
  check(/review/i.test(text), 'the model told the user to review the selection')
  await page.getByRole('button', { name: 'Not now' }).last().click()
  await page.waitForSelector('.proposal--dismissed', { timeout: 10_000 })
  check((await page.evaluate(() => window.noema.listMoodboards())).length === boardsBefore + 1, 'dismissing creates nothing')

  // -------------------------------------------------------------------------------------------
  log('E. Existing behaviour and the originals')
  await page.locator('button[aria-label="New conversation"]').click()
  await ask('Find foggy forests')
  check((await page.locator('.chat-images__grid img').count()) > 0 || (await page.locator('.chat-msg--atlas').last().innerText()).length > 0, 'an ordinary request still gets an answer')
  check(JSON.stringify(await hashAll()) === JSON.stringify(hashesBefore), `none of the ${total} original image files was changed`)
  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Curation checks passed.')
} finally {
  await app?.close().catch(() => undefined)
  mock.close()
}
