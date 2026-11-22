// Adding a source folder, end to end in the real application: a brand-new folder with real PNG artworks is added
// through "Add a source folder", and the script checks registration, scanning, thumbnails, what the window says
// at each step, and that the original files are never changed.
//
//   node scripts/e2e-add-folder.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// The system folder dialog cannot be driven by a script, so the dialog's answer is replaced with the folder the user
// would have picked (the same path Windows returns whether you select the folder or open it and press the button).
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-add-folder')
const packDir = resolve('reference')
await fs.mkdir(shots, { recursive: true })

const log = (m) => console.log(`\n◆ ${m}`)
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ✓ ${message}`)
}
check(existsSync(join(packDir, 'manifest.json')), 'the reference collection is built')
const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))

// Real PNG artworks, in brand-new folders (one with spaces and Swedish letters in its name, as a person might make).
const base = resolve('.e2e/add-folder')
await fs.rm(base, { recursive: true, force: true })
const folderA = join(base, 'Mina nya bilder åäö')
const folderB = join(base, 'Second batch')
await fs.mkdir(folderA, { recursive: true })
await fs.mkdir(folderB, { recursive: true })
const pngs = async (folder, shelf, count, offset = 0) => {
  const items = manifest.items.filter((i) => i.shelf === shelf).slice(offset, offset + count)
  let n = 0
  for (const it of items) {
    await sharp(join(packDir, 'images', it.file)).png().toFile(join(folder, `artwork ${n + 1}.png`))
    n += 1
  }
}
await pngs(folderA, 'romantic-landscape', 3)
await pngs(folderB, 'portrait', 2)
const hashAll = async (folder) => {
  const out = {}
  for (const e of await fs.readdir(folder, { withFileTypes: true })) { if (!e.isFile()) continue; const f = e.name; out[f] = createHash('sha256').update(await fs.readFile(join(folder, f))).digest('hex') }
  return out
}
const hashesA = await hashAll(folderA)
const hashesB = await hashAll(folderB)
check(Object.keys(hashesA).length === 3, 'three real PNG artworks are in the new folder')

const profile = resolve('.e2e/profile-add-folder')
await fs.rm(profile, { recursive: true, force: true })
const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models') }
delete env.ELECTRON_RUN_AS_NODE
let app = null
let page = null
const errors = []
async function until(predicate, timeout = 60_000, interval = 300) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const shot = (name) => page.screenshot({ path: join(shots, name), animations: 'disabled' })
/** Every message the window shows as a toast, remembered even after it fades. */
async function watchToasts() {
  await page.evaluate(() => {
    window.__toasts = []
    const seen = new WeakSet()
    const read = () => {
      for (const el of document.querySelectorAll('.toast')) {
        if (seen.has(el)) continue
        seen.add(el)
        const text = el.textContent?.replace(/[×✓!✳]/g, '').trim() ?? ''
        const tone = [...el.classList].find((c) => c.startsWith('toast--'))?.slice(7) ?? ''
        if (text) window.__toasts.push({ tone, text })
      }
    }
    new MutationObserver(read).observe(document.body, { childList: true, subtree: true })
    read()
  })
}
const toasts = () => page.evaluate(() => window.__toasts)
const answerDialogWith = (paths) =>
  app.evaluate(({ dialog }, folders) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: folders })
  }, paths)

try {
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1440, height: 920 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
  await watchToasts()

  // -------------------------------------------------------------------------------------------
  log('A. A brand-new library: add the new folder with "Add a source folder"')
  check((await page.evaluate(() => window.noema.bootstrap())).roots.length === 0, 'Atlas starts with no sources')
  await shot('a0-start.png')
  await answerDialogWith([folderA])
  await page.locator('.sidebar__add').click()
  await page.waitForFunction(() => window.__toasts.length > 0, null, { timeout: 10_000 }).catch(() => undefined)
  const first = await toasts()
  console.log('  · messages shown:', JSON.stringify(first.map((t) => t.text)))
  check(first.some((t) => t.tone === 'success' && /Added “Mina nya bilder åäö” as a source/.test(t.text)), 'the window confirms by name that the folder was added')
  await until(`(async () => { const b = await window.noema.bootstrap(); return b.roots.length === 1 && b.stats.images >= 3 })()`, 60_000)
  const boot = await page.evaluate(() => window.noema.bootstrap())
  check(boot.roots.length === 1 && boot.roots[0].name === 'Mina nya bilder åäö', 'the folder is registered as a source, under its own name')
  check(boot.stats.images === 3, `all 3 images were imported (${boot.stats.images})`)
  const items = await page.evaluate(() => window.noema.listImages({ scope: 'archive', limit: 50 }).then((p) => p.items))
  check(items.length === 3 && items.every((i) => i.thumbStatus === 'ready' && i.width > 0), 'each has a preview and its dimensions')
  await page.waitForFunction(() => window.__toasts.some((t) => /Imported 3 images from “Mina nya bilder åäö”/.test(t.text)), null, { timeout: 15_000 })
  check(true, 'when the scan ends the window says "Imported 3 images from …"')
  await page.locator('.nav-button', { hasText: /^Collection/ }).click()
  await page.waitForSelector('.image-card', { timeout: 15_000 })
  check((await page.locator('.image-card').count()) === 3, 'the Collection shows the 3 images')
  await page.locator('.nav-button', { hasText: 'Sources' }).click()
  await page.waitForSelector('.source-row')
  check((await page.locator('.source-row h2').allInnerTexts()).includes('Mina nya bilder åäö'), 'Sources lists the new folder')
  await shot('a1-sources-after-add.png')

  // -------------------------------------------------------------------------------------------
  log('B. The dialog is closed without a choice, the same folder again, a second folder')
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  const before = (await toasts()).length
  await page.locator('.source-row').first().waitFor()
  await page.getByRole('button', { name: /Add source folder/ }).first().click()
  await page.waitForFunction((n) => window.__toasts.length > n, before, { timeout: 8000 })
  check((await toasts()).at(-1).text.includes('No folder was chosen'), 'closing the dialog says that nothing was added')
  await answerDialogWith([folderA])
  await page.locator('.sidebar__add').click()
  await page.waitForFunction(() => window.__toasts.some((t) => /already a source/.test(t.text)), null, { timeout: 8000 })
  check(true, 'adding the same folder again says it is already a source')
  await answerDialogWith([folderB])
  await page.locator('.sidebar__add').click()
  await until(`(async () => (await window.noema.bootstrap()).stats.images === 5)()`, 60_000)
  check(true, 'a second new folder adds its 2 images (5 in total)')

  // -------------------------------------------------------------------------------------------
  log('C. A new folder INSIDE an existing source is not ignored')
  const nested = join(folderA, 'Nested new')
  await fs.mkdir(nested, { recursive: true })
  await pngs(nested, 'architecture', 3)
  const hashesNested = await hashAll(nested)
  await answerDialogWith([nested])
  await page.locator('.sidebar__add').click()
  await page.waitForFunction(() => window.__toasts.some((t) => /“Nested new” is inside your source “Mina nya bilder åäö”/.test(t.text)), null, { timeout: 8000 })
  check(true, 'the window explains it is already inside the source and checks that source again')
  await until(`(async () => (await window.noema.bootstrap()).stats.images === 8)()`, 60_000)
  check(true, 'its 3 PNG images were imported (8 in total)')
  check((await page.evaluate(() => window.noema.bootstrap())).roots.length === 2, 'and no duplicate source was created')

  // -------------------------------------------------------------------------------------------
  log('D. A folder that contains existing sources, and one that does not exist, explain themselves')
  await answerDialogWith([base])
  await page.locator('.sidebar__add').click()
  await page.waitForFunction(() => window.__toasts.some((t) => t.tone === 'error' && /contains 2 sources/.test(t.text)), null, { timeout: 8000 })
  check(true, 'a folder containing sources is declined with the reason and what to do')
  await answerDialogWith([join(base, 'does not exist')])
  await page.locator('.sidebar__add').click()
  await page.waitForFunction(() => window.__toasts.some((t) => t.tone === 'error' && /could not be opened/.test(t.text)), null, { timeout: 8000 })
  check(true, 'a folder that does not exist gives a clear error')
  await shot('d1-messages.png')

  // -------------------------------------------------------------------------------------------
  log('E. An empty folder is accepted; a damaged PNG is reported')
  const empty = join(base, 'Empty folder')
  const broken = join(base, 'Broken folder')
  await fs.mkdir(empty, { recursive: true })
  await fs.mkdir(broken, { recursive: true })
  await fs.writeFile(join(broken, 'not really.png'), Buffer.from('this is not an image'))
  await answerDialogWith([empty])
  await page.locator('.sidebar__add').click()
  await until(`(async () => (await window.noema.bootstrap()).roots.some((r) => r.name === 'Empty folder'))()`, 20_000)
  check(true, 'a genuinely empty folder is registered as a source')
  await page.waitForFunction(() => window.__toasts.some((t) => /“Empty folder” is added, but Atlas found no images in it yet/.test(t.text)), null, { timeout: 15_000 })
  check(true, 'and the window says it holds no images yet, instead of failing silently')
  // Pictures put into it later are found by "Check again".
  await pngs(empty, 'portrait', 1, 4)
  const emptyRoot = (await page.evaluate(() => window.noema.bootstrap())).roots.find((r) => r.name === 'Empty folder')
  await page.evaluate((id) => window.noema.rescanRoot(id), emptyRoot.id)
  await until(`(async () => (await window.noema.bootstrap()).stats.images === 9)()`, 30_000)
  check(true, 'a picture added later is found when the source is checked again')
  await answerDialogWith([broken])
  await page.locator('.sidebar__add').click()
  await page.waitForFunction(() => window.__toasts.some((t) => /could not be read|none could be read/.test(t.text)), null, { timeout: 20_000 })
  check(true, 'a damaged PNG is reported')
  await shot('e1-empty-broken.png')

  // -------------------------------------------------------------------------------------------
  log('F. Adding a folder by typing or pasting its path')
  const third = join(base, 'Third batch')
  await fs.mkdir(third, { recursive: true })
  await pngs(third, 'still-life', 3)
  const hashesThird = await hashAll(third)
  const countBeforeThird = (await page.evaluate(() => window.noema.bootstrap())).stats.images
  await page.locator('.nav-button', { hasText: 'Sources' }).click()
  await page.getByLabel('Folder path').fill(`"${third}"`)
  await page.getByRole('button', { name: 'Add this folder' }).click()
  await page.waitForFunction(() => window.__toasts.some((t) => /Added “Third batch” as a source/.test(t.text)), null, { timeout: 10_000 })
  await until(`(async () => (await window.noema.bootstrap()).stats.images === ${countBeforeThird + 3})()`, 60_000)
  check(true, `a pasted path (even in quotes) adds the folder and its 3 images (${countBeforeThird} to ${countBeforeThird + 3})`)
  await shot('f1-by-path.png')

  // -------------------------------------------------------------------------------------------
  log('G. Originals are untouched and nothing was lost')
  const nowA = await hashAll(folderA)
  check(Object.entries(hashesA).every(([name, hash]) => nowA[name] === hash), 'the three original PNG files are byte-for-byte unchanged')
  const nowB = await hashAll(folderB)
  check(Object.entries(hashesB).every(([name, hash]) => nowB[name] === hash), 'the second folder is unchanged too')
  check(JSON.stringify(await hashAll(nested)) === JSON.stringify(hashesNested), 'the nested folder is unchanged')
  check(JSON.stringify(await hashAll(third)) === JSON.stringify(hashesThird), 'the third folder is unchanged')
  // The library survives a restart.
  await app.close().catch(() => undefined)
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
  const afterRestart = await page.evaluate(() => window.noema.bootstrap())
  check(afterRestart.roots.length === 5 && afterRestart.stats.images === countBeforeThird + 3, `after a restart all ${afterRestart.roots.length} sources and ${afterRestart.stats.images} images are still there`)
  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Add-folder checks passed.')
} finally {
  await app?.close().catch(() => undefined)
}
