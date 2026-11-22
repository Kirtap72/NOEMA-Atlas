// End-to-end check of the Creative Studio in the real application.
//
//   node scripts/e2e-studio.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// A library is built from public-domain reference artworks. The script then works through the real interface:
// the moodboard controls do not collide with the companion, a moodboard becomes new artwork (Atlas Blend makes real
// pixels; a ComfyUI protocol stand-in proves the local-workflow path), results return to the library linked to their
// sources, variations form a series, an image is edited conversationally with a preview, an "external editor" edits a
// copy that comes back as a new version, Atlas proposes board changes that can be undone, and nothing ever touches the
// original files. The cloud path is checked for consent and price gating only: it is never called.
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const packaged = Boolean(exeArg)
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-studio')
const evidence = resolve('.e2e/studio-evidence')
const packDir = resolve('reference')
const modelsDir = process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models')
await fs.mkdir(shots, { recursive: true })
await fs.rm(evidence, { recursive: true, force: true })
await fs.mkdir(evidence, { recursive: true })

const log = (m) => console.log(`\n◆ ${m}`)
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ✓ ${message}`)
}
check(existsSync(join(packDir, 'manifest.json')), 'the reference collection is built')
check(existsSync(modelsDir), 'the image model is installed')
const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))

// ---- the user's library: real artworks --------------------------------------------------------------------------------
const libDir = resolve('.e2e/studio-library')
const studioDir = resolve('.e2e/studio-pictures')
const toolsDir = resolve('.e2e/studio-tools')
await fs.rm(libDir, { recursive: true, force: true })
await fs.rm(studioDir, { recursive: true, force: true })
await fs.rm(toolsDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
await fs.mkdir(toolsDir, { recursive: true })
const pick = async (shelf, count, prefix) => {
  const items = manifest.items.filter((i) => i.shelf === shelf).slice(0, count)
  let n = 0
  for (const it of items) {
    await sharp(join(packDir, 'images', it.file)).jpeg({ quality: 90 }).toFile(join(libDir, `${prefix}-${String(n).padStart(2, '0')}.jpg`))
    n += 1
  }
}
await pick('romantic-landscape', 14, 'landscape')
await pick('architecture', 10, 'architecture')
await pick('ukiyo-e', 8, 'print')
await fs.copyFile(join(libDir, 'landscape-00.jpg'), join(libDir, 'landscape-copy.jpg'))
const sha = async (path) => createHash('sha256').update(await fs.readFile(path)).digest('hex')
const hashAll = async () => {
  const out = {}
  for (const f of await fs.readdir(libDir)) out[f] = await sha(join(libDir, f))
  return out
}
const hashesBefore = await hashAll()

// ---- a ComfyUI stand-in (protocol only: it returns a real picture, it does not paint one) -----------------------------
const comfyLog = { queued: [], uploads: 0 }
const comfyPicture = await sharp(join(libDir, 'print-00.jpg')).resize(640, 416, { fit: 'cover' }).png().toBuffer()
const comfy = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const json = (data, status = 200) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(data))
    }
    const url = req.url ?? ''
    if (url.startsWith('/system_stats')) return json({ system: { comfyui_version: 'mock' } })
    if (url.startsWith('/object_info/CheckpointLoaderSimple')) return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['mock-dreamer.safetensors']] } } } })
    if (url.startsWith('/upload/image')) {
      comfyLog.uploads += 1
      return json({ name: 'uploaded.png' })
    }
    if (url.startsWith('/prompt')) {
      comfyLog.queued.push(JSON.parse(body.toString('utf8')).prompt)
      return json({ prompt_id: `mock${comfyLog.queued.length}` })
    }
    if (url.startsWith('/history/')) return json({ [url.split('/').pop()]: { status: { status_str: 'success' }, outputs: { 7: { images: [{ filename: 'mock.png', subfolder: '', type: 'output' }] } } } })
    if (url.startsWith('/view')) {
      res.setHeader('content-type', 'image/png')
      return res.end(comfyPicture)
    }
    json({}, 404)
  })
})
await new Promise((r) => comfy.listen(0, '127.0.0.1', r))
const comfyUrl = `http://127.0.0.1:${comfy.address().port}`

// ---- a "program" that edits the copy it is given -----------------------------------------------------------------------
await sharp(join(libDir, 'architecture-00.jpg')).modulate({ brightness: 0.55, saturation: 0.6 }).negate({ alpha: false }).jpeg().toFile(join(toolsDir, 'edited.jpg'))
const editorCmd = join(toolsDir, 'fake-editor.cmd')
await fs.writeFile(editorCmd, `@echo off\r\ncopy /Y "${join(toolsDir, 'edited.jpg')}" "%~1" >nul\r\n`)

// ---- a prepared "drive" for discovery: real collections among system, program and cache folders -----------------------
const treeDir = resolve('.e2e/discover-tree')
await fs.rm(treeDir, { recursive: true, force: true })
const fill = async (dir, count, offset = 0) => {
  await fs.mkdir(dir, { recursive: true })
  const items = manifest.items.slice(offset, offset + count)
  let n = 0
  for (const it of items) {
    await sharp(join(packDir, 'images', it.file)).resize(900, 900, { fit: 'inside' }).jpeg({ quality: 88 }).toFile(join(dir, `img-${n}.jpg`))
    n += 1
  }
}
await fill(join(treeDir, 'Photos', 'Iceland 2023'), 10, 0)
await fill(join(treeDir, 'Photos', 'Iceland 2024'), 9, 12)
await fill(join(treeDir, 'Sketchbook'), 12, 30)
await fill(join(treeDir, 'Windows', 'Web', 'Wallpaper'), 10, 5)
await fill(join(treeDir, 'Program Files', 'Game', 'textures'), 10, 8)
await fill(join(treeDir, 'AppData', 'Local', 'Cache'), 10, 3)
await fill(join(treeDir, 'node_modules', 'pkg', 'docs'), 10, 6)
await fill(join(treeDir, 'SomeApp', 'resources'), 10, 9)
for (const f of ['a.dll', 'b.dll', 'c.dll']) await fs.writeFile(join(treeDir, 'SomeApp', 'resources', f), 'x')
await fs.mkdir(join(treeDir, 'Icons'), { recursive: true })
for (let i = 0; i < 12; i += 1) await sharp({ create: { width: 32, height: 32, channels: 3, background: '#789' } }).png().toFile(join(treeDir, 'Icons', `i${i}.png`))
const treeHash = async () => {
  const out = {}
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out[p] = await sha(p)
    }
  }
  await walk(treeDir)
  return out
}
const treeBefore = JSON.stringify(await treeHash())

const profile = resolve('.e2e/profile-studio')
await fs.rm(profile, { recursive: true, force: true })
let app = null
let page = null
const errors = []
async function launch(seed) {
  const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir, NOEMA_STUDIO_DIR: studioDir, NOEMA_DISCOVER_ROOTS: treeDir }
  delete env.ELECTRON_RUN_AS_NODE
  if (seed) env.NOEMA_E2E_SEED = libDir
  app = await electron.launch({ executablePath: exe, args: packaged ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1440, height: 920 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}
async function until(predicate, timeout = 60_000, interval = 500, arg) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate, arg)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const shot = (name) => page.screenshot({ path: join(shots, name), animations: 'disabled' })
const savePicture = async (src, name) => fs.copyFile(src, join(evidence, name))
const lastReply = () => page.locator('.chat-msg--atlas').last()
async function ask(text) {
  const box = page.locator('.companion__form textarea')
  await box.fill(text)
  await box.press('Enter')
  await page.locator('.chat-thinking').waitFor({ state: 'detached', timeout: 120_000 }).catch(() => undefined)
  await page.waitForTimeout(500)
}
const overlap = (a, b) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)

try {
  log('A. The library is ready')
  await launch(true)
  await until(() => window.noema.bootstrap().then((s) => s.stats.images >= 30), 120_000)
  await page.evaluate(() => window.noema.setAiEnabled(true))
  await until(() => window.noema.getIndexStatus().then((s) => s.total > 0 && s.indexed >= s.total), 300_000, 1000)
  const items = await page.evaluate(() => window.noema.listImages({ scope: 'archive', limit: 200 }).then((p) => p.items.map((i) => ({ id: i.id, name: i.filename, path: i.path }))))
  const byName = (n) => items.find((i) => i.name === n)
  const boardPicks = ['landscape-00.jpg', 'landscape-copy.jpg', 'landscape-03.jpg', 'architecture-01.jpg', 'architecture-04.jpg', 'print-02.jpg', 'print-05.jpg'].map(byName)
  check(boardPicks.every(Boolean), 'the artworks for the moodboard are in the library')
  const board = await page.evaluate(async (ids) => {
    const b = await window.noema.createMoodboard('Quiet Valleys')
    await window.noema.addToMoodboard({ moodboardId: b.id, imageIds: ids })
    return b
  }, boardPicks.map((i) => i.id))
  const imagesBefore = await page.evaluate(() => window.noema.bootstrap().then((s) => s.stats.images))

  log('B. The moodboard controls and the companion no longer collide')
  await page.evaluate((id) => (window.location.hash = `#/moodboard/${id}`), board.id)
  await page.locator('.board-canvas__controls').waitFor()
  await page.keyboard.press('Control+j')
  await page.locator('.companion').waitFor()
  const controls = await page.locator('.board-canvas__controls').boundingBox()
  const panel = await page.locator('.companion').boundingBox()
    check(!overlap(controls, panel), 'zoom and Fit all stay clear of the open companion')
  const covered = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('.board-detail-head button, .board-canvas__controls button, .back-link')) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' })
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      if (!top || !(el === top || el.contains(top))) bad.push(el.textContent?.trim() || el.getAttribute('title') || 'button')
    }
    return bad
  })
  check(covered.length === 0, `no moodboard control is hidden behind the companion${covered.length ? ': ' + covered.join(', ') : ''}`)
  await page.evaluate(() => document.querySelector('.main-scroll')?.scrollTo({ top: 0, behavior: 'instant' }))
  const canvasBox = await page.locator('.board-canvas').boundingBox()
  check(canvasBox.x + canvasBox.width <= panel.x + 2, 'the moodboard canvas gives way to the companion instead of lying under it')
  check(!(await page.locator('.companion-launcher').isVisible()), 'the launcher steps aside while the panel is open')
  await page.setViewportSize({ width: 980, height: 800 })
  await page.waitForTimeout(400)
  const small = await page.locator('.companion').boundingBox()
  check(small.x + small.width <= 980 + 1 && small.y >= 0, 'on a narrow window the panel stays on screen (floating)')
  await page.setViewportSize({ width: 1440, height: 920 })
  await page.waitForTimeout(400)
  await page.locator('.board-canvas__controls').getByRole('button', { name: /Fit all/ }).click()
  check(true, 'Fit all can be clicked while the companion is open')
  await shot('50-board-with-companion.png')
  await page.keyboard.press('Escape')
  await page.locator('.companion').waitFor({ state: 'detached' }).catch(() => undefined)

  log('C. From moodboard to artwork: roles, concept, review, make (Atlas Blend: real pixels)')
  await page.locator('[data-testid="create-artwork"]').click()
  await page.locator('.studio').waitFor()
  check(await page.getByText('From moodboard to artwork').isVisible(), 'the Creative Studio opens from the board')
  await page.locator('.studio-ref').first().waitFor()
  const refs = page.locator('.studio-ref')
  check((await refs.count()) === 7, 'every picture on the board is offered')
  await refs.nth(2).locator('[data-role="composition"]').click()
  await refs.nth(4).locator('[data-role="colour"]').click()
  await refs.nth(5).locator('[data-role="atmosphere"]').click()
  await refs.nth(5).locator('[data-role="colour"]').click()
  check((await page.locator('.studio-ref [aria-pressed="true"]').count()) === 4, 'roles can be assigned, several to one picture')
  await page.locator('textarea[aria-label="What would you like to create"]').fill('Create a new surreal landscape inspired by this moodboard. Use the atmosphere of the prints, the composition of the first picture and the colours of the architecture.')
  await page.locator('[data-testid="develop-concept"]').click()
  await page.locator('[data-testid="concept-notes"]').waitFor({ timeout: 60_000 })
  const prompt = await page.locator('textarea[aria-label="Prompt"]').inputValue()
  check(/surreal landscape/i.test(prompt) && !/inspired by this moodboard/i.test(prompt), `Atlas developed a prompt from the request (“${prompt.slice(0, 90)}…”)`)
  check(/colour palette of/i.test(prompt), 'the palette of the colour pictures is part of it')
  check((await page.locator('[data-testid="concept-notes"] li').count()) >= 2, 'Atlas explains how it understood each role')
  check((await page.locator('.studio-variations button').count()) === 3, 'three other directions are offered')
  check((await page.locator('.studio-palette span').count()) >= 1, 'the palette is shown')
  // Methods: Atlas Blend is available; ComfyUI and the cloud say why they are not.
  const comfyCard = page.locator('[data-method="comfyui"]')
  check(/Set up ComfyUI once|not running/i.test(await comfyCard.innerText()), 'ComfyUI says in plain words that it has to be set up once')
  check(/key/i.test(await page.locator('[data-method="openai"]').innerText()), 'the cloud method says what is missing')
  check(/Free, and nothing leaves this computer/i.test(await page.locator('[data-testid="studio-estimate"]').innerText()), 'the price line says it is free and stays private')
  await shot('51-studio-concept.png')
  await page.locator('input[aria-label="How many pictures"]').fill('2')
  await page.locator('[data-testid="studio-make"]').click()
  await page.locator('[data-testid="studio-result"]').first().waitFor({ timeout: 90_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="studio-result"]').length >= 2, undefined, { timeout: 90_000 })
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="studio-result"] img')].every((i) => i.complete && i.naturalWidth > 0), undefined, { timeout: 30_000 })
  check((await page.locator('[data-testid="studio-result"]').count()) === 2, 'two pictures were made and appear straight away')
  await shot('52-studio-results.png')
  const made = await page.evaluate(() => window.noema.studioGenerations().then((g) => g.map((r) => ({ id: r.id, imageId: r.imageId, seriesId: r.seriesId, seed: r.seed, parentId: r.parentId, board: r.moodboardName, sources: r.sourceImageIds.length, roles: r.roles }))))
  check(made.length === 2 && made.every((r) => r.imageId), 'both pictures were saved into the library')
  check(new Set(made.map((r) => r.seed)).size === 2, 'each picture has its own seed')
  check(made.every((r) => r.board === 'Quiet Valleys' && r.sources === 3), 'each is linked to its moodboard and the three pictures that shaped it')
  const madeItems = await page.evaluate((ids) => Promise.all(ids.map((id) => window.noema.getImage(id))), made.map((r) => r.imageId))
  for (const [n, it] of madeItems.entries()) {
    check(it.path.startsWith(studioDir) && it.width === 1216 && it.height === 832, `picture ${n + 1} is a real ${it.width}×${it.height} file in the studio folder`)
    await savePicture(it.path, `blend-${n + 1}.png`)
  }
  const refMeans = await Promise.all([boardPicks[2], boardPicks[4], boardPicks[5]].map(async (p) => (await sharp(p.path).stats()).channels.slice(0, 3).map((c) => Math.round(c.mean))))
  const outMean = (await sharp(madeItems[0].path).stats()).channels.slice(0, 3).map((c) => Math.round(c.mean))
  check(!refMeans.some((m) => m.join() === outMean.join()), `the result is a new picture, not a copy of a reference (means ${outMean.join('/')})`)
  const a = await sha(madeItems[0].path)
  const b = await sha(madeItems[1].path)
  check(a !== b, 'the two pictures differ')
  await until((ids) => Promise.all(ids.map((id) => window.noema.getImage(id))).then((all) => all.every((i) => i && i.thumbStatus === 'ready')), 60_000, 700, made.map((r) => r.imageId))
  check(true, 'they were thumbnailed and show up in the library like any other image')
  check((await page.evaluate(() => window.noema.bootstrap().then((s) => s.stats.images))) === imagesBefore + 2, 'the library grew by exactly the two new pictures')

  log('D. Variations and a series')
  await page.locator('[data-testid="studio-result"]').first().getByRole('button', { name: 'Variation' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="studio-result"]').length >= 3, undefined, { timeout: 90_000 })
  const series = await page.evaluate(() => window.noema.studioGenerations().then((g) => g.map((r) => ({ id: r.id, parentId: r.parentId, seriesId: r.seriesId }))))
  const variation = series.find((r) => r.parentId)
  check(variation && series.find((r) => r.id === variation.parentId)?.seriesId === variation.seriesId, 'a variation is linked to its parent and stays in the same series')
  await page.locator('[data-testid="studio-result"]').first().getByRole('button', { name: 'Refine…' }).click()
  check(/Refining from/.test(await page.locator('.studio-parent').innerText()), 'Refine… continues from that picture')
  await page.locator('.studio-parent button').click()

  log('E. A local ComfyUI workflow (protocol check: the server is a stand-in that returns a picture)')
  await page.locator('button[aria-label="Studio settings"]').click()
  // The address of a ComfyUI that is already running is an advanced setting now (the folder setup is the normal way).
  await page.locator('.studio-advanced summary').click()
  await page.locator('.studio-advanced input').first().fill(comfyUrl)
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.locator('[data-method="comfyui"]:not(.is-off)').waitFor({ timeout: 20_000 }).catch(() => undefined)
  await page.locator('button[aria-label="Studio settings"]').click()
  await page.waitForFunction(() => !/not running/i.test(document.querySelector('[data-method="comfyui"]')?.textContent ?? 'not running') && !/Set up ComfyUI once/i.test(document.querySelector('[data-method="comfyui"]')?.textContent ?? ''), undefined, { timeout: 20_000 }).catch(() => undefined)
  // The dialog only reads methods when it opens, so reopen it.
  await page.locator('button[aria-label="Close the studio"]').click()
  await page.locator('[data-testid="create-artwork"]').click()
  await page.locator('.studio-ref').first().waitFor()
  check(!/not running|Set up ComfyUI once/i.test(await page.locator('[data-method="comfyui"]').innerText()), 'ComfyUI is found once its address is set')
  check(/Free/i.test(await page.locator('[data-testid="studio-estimate"]').innerText()), 'a local method is free')
  await page.locator('[data-method="comfyui"]').click()
  await page.locator('textarea[aria-label="Prompt"]').fill('A surreal valley under two moons, misty, teal and amber')
  await page.locator('input[aria-label="How many pictures"]').fill('1')
  await page.locator('[data-testid="studio-make"]').click()
  await page.locator('[data-testid="studio-result"]').first().waitFor({ timeout: 60_000 })
  check(comfyLog.queued.length === 1, 'the workflow was queued in ComfyUI')
  const wf = comfyLog.queued[0]
  check(wf['1'].inputs.ckpt_name === 'mock-dreamer.safetensors' && wf['2'].inputs.text.includes('two moons') && wf['5'].class_type === 'KSampler', 'it carried the reviewed prompt, the model and a standard sampler graph')
  const comfyMade = await page.evaluate(() => window.noema.studioGenerations().then((g) => g.find((r) => r.methodId === 'comfyui')))
  check(Boolean(comfyMade?.imageId), 'the picture ComfyUI returned came into the library, linked to the moodboard')
  await shot('53-studio-comfyui.png')

  log('F. Cloud is optional: it asks for consent and shows a price, and is never used here')
  await page.locator('button[aria-label="Studio settings"]').click()
  await page.locator('.studio-settings input[type="password"]').fill('sk-e2e-never-sent')
  await page.locator('.studio-settings input[type="number"]').fill('5')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.locator('button[aria-label="Close the studio"]').click()
  await page.locator('[data-testid="create-artwork"]').click()
  await page.locator('.studio-ref').first().waitFor()
  await page.locator('[data-method="openai"]:not(.is-off)').waitFor({ timeout: 20_000 })
  await page.locator('[data-method="openai"]').click()
  await page.locator('textarea[aria-label="Prompt"]').fill('A surreal valley')
  check(/About \$/.test(await page.locator('[data-testid="studio-estimate"]').innerText()), 'the estimated price is shown before anything is sent')
  check(/sent to OpenAI/.test(await page.locator('[data-testid="studio-estimate"]').innerText()), 'it says the prompt leaves this computer')
  check(await page.locator('[data-testid="studio-make"]').isDisabled(), 'the Make button stays disabled until the user agrees')
  await page.locator('.studio-agree input').check()
  check(await page.locator('[data-testid="studio-make"]').isEnabled(), 'it is enabled only after the user agrees to the upload and the price')
  await shot('54-studio-cloud-consent.png')
  const keyFile = await fs.readFile(join(profile, 'studio', 'cloud-key.bin')).catch(() => Buffer.alloc(0))
  check(keyFile.length > 0 && !keyFile.includes(Buffer.from('sk-e2e-never-sent')), 'the key is stored encrypted, not in plain text')
  check(!(await fs.readFile(join(profile, 'studio', 'settings.json'), 'utf8')).includes('sk-e2e-never-sent'), 'and is not in the settings file')
  await page.locator('button[aria-label="Close the studio"]').click()

  log('G. Edit an image in conversation: preview first, a new version, the original untouched')
  const source = byName('architecture-01.jpg')
  const originalHash = await sha(source.path)
  await page.evaluate(() => (window.location.hash = '#/collection'))
  await page.waitForTimeout(600)
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('atlas:open-studio', { detail: { mode: 'edit', imageId: id } })), source.id)
  await page.getByText('Edit a picture, keep the original').waitFor()
  await page.locator('[data-method="blend"]').click()
  await page.locator('textarea[aria-label="What should change"]').fill('Make the atmosphere more mysterious, but preserve the architecture and composition.')
  await page.locator('[data-testid="edit-preview"]').click()
  await page.locator('[data-testid="edit-preview-card"]').waitFor({ timeout: 60_000 })
  check(/more mysterious/.test(await page.locator('[data-testid="edit-preview-card"]').innerText()), 'a preview appears with what was understood')
  check((await page.evaluate(() => window.noema.studioGenerations().then((g) => g.filter((r) => r.kind === 'edit').length))) === 0, 'nothing is saved until the user keeps it')
  await shot('55-studio-edit-preview.png')
  await page.locator('[data-testid="edit-keep"]').click()
  await page.locator('[data-testid="edit-saved-card"]').waitFor({ timeout: 60_000 })
  const edit = await page.evaluate(() => window.noema.studioGenerations().then((g) => g.find((r) => r.kind === 'edit')))
  check(Boolean(edit?.imageId) && edit.sourceImageIds[0] === source.id, 'the edit is a new library image linked to its source')
  const editItem = await page.evaluate((id) => window.noema.getImage(id), edit.imageId)
  check((await sha(source.path)) === originalHash, 'the original file is byte-for-byte unchanged')
  const lumaOf = async (p) => (await sharp(p).greyscale().stats()).channels[0].mean
  check((await lumaOf(editItem.path)) < (await lumaOf(source.path)) * 0.95, 'the new version is darker and moodier')
  await savePicture(source.path, 'edit-before.jpg')
  await savePicture(editItem.path, 'edit-after.png')

  log('H. Edit in another program: a copy goes out, the saved result comes back as a new version')
  await page.evaluate((cmd) => window.noema.studioUpdateSettings({ editors: [{ id: 'fake', name: 'FakeEditor', path: cmd }] }), editorCmd)
  await page.locator('button[aria-label="Close the studio"]').click()
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('atlas:open-studio', { detail: { mode: 'edit', imageId: id } })), byName('architecture-04.jpg').id)
  const ext = byName('architecture-04.jpg')
  const extHash = await sha(ext.path)
  await page.locator('[data-editor="fake"]').click()
  await page.locator('[data-testid="external-session"]').waitFor()
  await page.locator('[data-testid="external-result"]').waitFor({ timeout: 45_000 })
  check(true, 'the result saved by the other program was noticed and imported on its own')
  const external = await page.evaluate(() => window.noema.studioGenerations().then((g) => g.find((r) => r.kind === 'external')))
  check(Boolean(external?.imageId) && external.sourceImageIds[0] === ext.id && external.model === 'FakeEditor', 'it is a new version linked to the source and says which program made it')
  check((await sha(ext.path)) === extHash, 'the original was never opened by the other program (only a copy)')
  const extItem = await page.evaluate((id) => window.noema.getImage(id), external.imageId)
  check((await sha(extItem.path)) === (await sha(join(toolsDir, 'edited.jpg'))), 'the imported version is exactly what the program saved')
  await shot('56-studio-external.png')
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="external-result"]').waitFor({ state: 'detached' })
  const studioClose = page.locator('button[aria-label="Close the studio"]')
  if (await studioClose.isVisible()) await studioClose.click()

  log('I. Provenance: a made picture tells where it came from')
  await page.evaluate(() => (window.location.hash = '#/collection'))
  const first = madeItems[0]
  const provenance = await page.evaluate((id) => window.noema.studioProvenance(id), first.id)
  check(provenance.record.moodboardName === 'Quiet Valleys' && provenance.sources.length === 3, 'provenance lists the moodboard and the three source pictures')
  check(provenance.series.length >= 2, 'and the series it belongs to')

  log('J. Atlas helps with moodboards in conversation: before and after, and undo')
  await page.evaluate((id) => (window.location.hash = `#/moodboard/${id}`), board.id)
  await page.locator('.board-canvas__controls').waitFor()
  await page.keyboard.press('Control+j')
  await page.locator('.companion').waitFor()
  const layoutBefore = await page.evaluate((id) => window.noema.getMoodboard(id).then((b) => b.images.map((i) => [i.id, i.x, i.y, i.layoutWidth, i.layoutHeight].join())), board.id)
  await ask('Tidy my "Quiet Valleys" moodboard')
  await page.locator('.proposal--pending').waitFor({ timeout: 30_000 })
  check(/Tidy|layout/i.test(await page.locator('.proposal--pending').innerText()), 'Atlas proposes a layout change')
  check((await page.evaluate((id) => window.noema.getMoodboard(id).then((b) => b.images.map((i) => [i.id, i.x, i.y, i.layoutWidth, i.layoutHeight].join())), board.id)).join('|') === layoutBefore.join('|'), 'nothing moved yet')
  await page.getByRole('button', { name: 'Apply the change' }).click()
  await page.locator('.proposal--applied').waitFor()
  const layoutAfter = await page.evaluate((id) => window.noema.getMoodboard(id).then((b) => b.images.map((i) => [i.id, i.x, i.y, i.layoutWidth, i.layoutHeight].join())), board.id)
  check(layoutAfter.join('|') !== layoutBefore.join('|'), 'applying tidied the board')
  await page.locator('[data-testid="board-undo"]').waitFor()
  await page.locator('[data-testid="board-undo"]').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="board-undo"]'), undefined, { timeout: 10_000 })
  const layoutUndone = await page.evaluate((id) => window.noema.getMoodboard(id).then((b) => b.images.map((i) => [i.id, i.x, i.y, i.layoutWidth, i.layoutHeight].join())), board.id)
  check([...layoutUndone].sort().join('|') === [...layoutBefore].sort().join('|'), 'Undo restores the exact earlier layout')
  await page.locator('button[aria-label="New conversation"]').click()
  await ask('Remove the redundant duplicates from my "Quiet Valleys" moodboard')
  await page.locator('.proposal--pending').waitFor({ timeout: 30_000 })
  check(await page.locator('[data-testid="board-change-preview"]').isVisible(), 'the proposal shows what would leave the board')
  check((await page.locator('[data-testid="board-change-preview"] .proposal__thumbs--out img').count()) >= 1, 'the near-identical copy is the one proposed for removal')
  await shot('57-companion-board-change.png')
  const countBefore = await page.evaluate((id) => window.noema.getMoodboard(id).then((b) => b.images.length), board.id)
  await page.getByRole('button', { name: 'Apply the change' }).click()
  await page.locator('.proposal--applied').waitFor()
  check((await page.evaluate((id) => window.noema.getMoodboard(id).then((b) => b.images.length), board.id)) < countBefore, 'applying removed the redundant picture from the board')
  check(existsSync(join(libDir, 'landscape-copy.jpg')), 'the picture itself stays in the library and on disk')
  await page.locator('[data-testid="board-undo"]').click()
  await page.waitForFunction((n) => window.noema.getMoodboard(window.location.hash.split('/').pop()).then((b) => b.images.length === n), countBefore, { timeout: 10_000 }).catch(() => undefined)
  check((await page.evaluate((id) => window.noema.getMoodboard(id).then((b) => b.images.length), board.id)) === countBefore, 'Undo brings it back')

  log('K. Atlas turns a request into a concept and hands it to the Studio on a click')
  await page.locator('button[aria-label="New conversation"]').click()
  await ask('Create a new surreal landscape from my "Quiet Valleys" moodboard')
  await page.locator('.proposal--pending').waitFor({ timeout: 30_000 })
  check(await page.locator('.proposal__artwork q').isVisible(), 'the concept shows its prompt')
  const genBefore = await page.evaluate(() => window.noema.studioGenerations().then((g) => g.length))
  await page.getByRole('button', { name: 'Open in the Studio' }).click()
  await page.locator('.studio').waitFor()
  check(/surreal/i.test(await page.locator('textarea[aria-label="Prompt"]').inputValue()), 'the Studio opens with the concept already filled in')
  check((await page.evaluate(() => window.noema.studioGenerations().then((g) => g.length))) === genBefore, 'nothing was made by accepting: that needs the user\'s approval in the Studio')
  await shot('58-studio-from-companion.png')
  await page.locator('button[aria-label="Close the studio"]').click()

  log('M. Find pictures on a whole drive: look first, then choose (a prepared drive, never a real one)')
  await page.evaluate(() => (window.location.hash = '#/sources'))
  await page.locator('[data-testid="discover-open"]').click()
  await page.locator('[data-testid="discover"]').waitFor()
  check(/read-only/i.test(await page.locator('[data-testid="discover"]').innerText()), 'the panel says searching is read-only')
  check((await page.locator('.discover__drive input').count()) === 1, 'the drives to search are offered')
  check((await page.locator('.discover__chips button').count()) >= 10, 'the folders that are always left out are listed')
  const imagesBeforeDiscover = await page.evaluate(() => window.noema.bootstrap().then((s) => s.stats.images))
  await shot('59-discover-setup.png')
  await page.locator('[data-testid="discover-start"]').click()
  await page.locator('[data-testid="discover-results"]').waitFor({ timeout: 60_000 })
  const names = await page.locator('.discover__card strong').allInnerTexts()
  check(names.sort().join('|') === 'Photos|Sketchbook', `only real collections were found (${names.join(', ')})`)
  check(/19 pictures/.test(await page.locator('[data-collection="Photos"]').innerText()) && /2 folders/.test(await page.locator('[data-collection="Photos"]').innerText()), 'two trips are offered as one collection of 19 pictures')
  check(!/Windows|Program Files|AppData|node_modules|SomeApp|Icons/.test(names.join(' ')), 'system folders, programs, caches and icons were left out')
  await page.waitForFunction(() => document.querySelectorAll('.discover__samples img').length >= 4, undefined, { timeout: 20_000 })
  check(true, 'small previews of each collection are shown before anything is indexed')
  check((await page.evaluate(() => window.noema.bootstrap().then((s) => s.stats.images))) === imagesBeforeDiscover, 'nothing was added to the library by searching')
  check(JSON.stringify(await treeHash()) === treeBefore, 'searching changed nothing on the drive')
  await shot('60-discover-results.png')
  await page.locator('[data-collection="Photos"] input[type="checkbox"]').check()
  await page.locator('[data-testid="discover-add"]').click()
  await until((n) => window.noema.bootstrap().then((s) => s.stats.images >= n), 90_000, 700, imagesBeforeDiscover + 19)
  check(true, 'choosing a collection added exactly it (19 more pictures)')
  check((await page.evaluate(() => window.noema.bootstrap().then((s) => s.stats.images))) === imagesBeforeDiscover + 19, 'and nothing else')
  await page.locator('[data-collection="Photos"].is-in').waitFor()
  check(JSON.stringify(await treeHash()) === treeBefore, 'indexing left every original untouched')
  await shot('61-discover-added.png')

  log('L. Originals are untouched, and the app stayed healthy')
  const hashesAfter = await hashAll()
  check(JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter), 'every original file in the library is byte-for-byte unchanged')
  const bad = errors.filter((e) => !/Failed to load resource|net::ERR|ResizeObserver/i.test(e))
  check(bad.length === 0, `no errors in the interface${bad.length ? `: ${bad.join(' | ')}` : ''}`)
  console.log('\n✓ The Creative Studio works end to end.')
} catch (error) {
  console.error('\n✗', error instanceof Error ? error.message : error)
  try {
    await shot('99-failure.png')
  } catch {
    // The window may be gone.
  }
  process.exitCode = 1
} finally {
  comfy.close()
  await app?.close().catch(() => undefined)
}
