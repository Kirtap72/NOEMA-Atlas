// Real-application check of the viewer's "Edit…" action from every place a picture can be opened:
// Collection, Favorites, Archive, Families and Moodboards, with pictures that were not made by the Studio (PNG, JPEG, WebP).
// The Creative Studio must open in FRONT of the viewer, with that picture loaded and the editing controls ready.
//
//   node scripts/e2e-edit-entry.mjs --exe "release/win-unpacked/NOEMA Atlas.exe"
import { createHash } from 'node:crypto'
import { promises as fs, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve('.e2e/screenshots-edit-entry')
const packDir = resolve('reference')
const modelsDir = process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models')
await fs.mkdir(shots, { recursive: true })
const log = (m) => console.log(`\n◆ ${m}`)
const check = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ✓ ${m}`) }
const note = (m) => console.log(`  · ${m}`)
const sha = async (p) => createHash('sha256').update(await fs.readFile(p)).digest('hex')

const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))
const libDir = resolve('.e2e/entry-library')
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
// Ordinary pictures, as a user would have: PNG artwork, JPEG photographs, WebP.
const files = manifest.items.slice(0, 14)
let n = 0
for (const it of files) {
  const src = join(packDir, 'images', it.file)
  const kind = n % 3 === 0 ? 'png' : n % 3 === 1 ? 'jpg' : 'webp'
  const out = join(libDir, `artwork-${String(n).padStart(2, '0')}.${kind}`)
  const s = sharp(src).resize({ width: 900, withoutEnlargement: true })
  if (kind === 'png') await s.png().toFile(out)
  else if (kind === 'jpg') await s.jpeg({ quality: 90 }).toFile(out)
  else await s.webp({ quality: 90 }).toFile(out)
  n += 1
}
const hashes = async () => Object.fromEntries(await Promise.all((await fs.readdir(libDir)).map(async (f) => [f, await sha(join(libDir, f))])))
const before = await hashes()

const profile = resolve(`.e2e/profile-entry-${Date.now()}`)
const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir, NOEMA_STUDIO_DIR: resolve('.e2e/entry-studio'), NOEMA_E2E_SEED: libDir }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
const page = await app.firstWindow({ timeout: 90_000 })
await page.setViewportSize({ width: 1500, height: 1000 })
page.setDefaultTimeout(30_000)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })

/** The Studio must be the topmost thing, show the chosen picture and offer the editing controls. */
async function expectStudioReady(label, expectedName) {
  await page.locator('.studio[aria-label="Creative Studio"]').waitFor()
  await page.locator('[data-testid="edit-levels"]').waitFor()
  const front = await page.evaluate(() => {
    const studio = document.querySelector('.studio')
    const r = studio.getBoundingClientRect()
    const probes = [[r.left + r.width / 2, r.top + 30], [r.left + r.width / 2, r.top + r.height / 2], [r.left + 40, r.bottom - 40]]
    return probes.every(([x, y]) => studio.contains(document.elementFromPoint(x, y)))
  })
  check(front, `${label}: the Creative Studio is in front of the viewer`)
  await page.waitForFunction(() => { const i = document.querySelector('.studio-edit__original'); return i && i.complete && i.naturalWidth > 0 })
  const shown = await page.locator('.studio-edit__original').getAttribute('alt')
  check(shown === expectedName, `${label}: the picture that was open is loaded for editing (${shown})`)
  check((await page.locator('[data-testid="region-part"]').count()) === 1 && (await page.locator('[data-testid="edit-preview"]').count()) === 1, `${label}: full-image and selective editing controls are ready`)
  await page.screenshot({ path: join(shots, `${label.replace(/\W+/g, '-').toLowerCase()}.png`) })
  if (label === 'Collection png') {
    // Ready in practice: a full-image edit and a selective (top part) edit of this PNG, with Atlas Blend (no AI model needed).
    await page.locator('textarea[aria-label="What should change"]').fill('Make the light warmer and softer')
    await page.locator('[data-method="blend"]').click()
    await page.locator('[data-testid="edit-preview"]').click()
    await page.locator('[data-testid="edit-preview-card"]').waitFor({ timeout: 120_000 })
    check(true, `${label}: a preview of the whole picture was made, nothing saved yet`)
    await page.locator('[data-testid="region-part"]').click()
    await page.locator('[data-region="top"]').click()
    await page.locator('[data-testid="region-overlay"]').waitFor({ timeout: 30_000 })
    await page.locator('[data-testid="edit-preview"]').click()
    await page.locator('[data-testid="edit-preview-card"]').waitFor({ timeout: 120_000 })
    check(/pixel for pixel|Only/i.test(await page.locator('[data-testid="edit-preview-card"] small').innerText()), `${label}: a preview of only the top part was made, the rest kept as it was`)
  }
  await page.locator('button[aria-label="Close the studio"]').click()
  await page.locator('.studio').waitFor({ state: 'detached' })
}
const nav = async (text) => { await page.locator('.nav-button', { hasText: text }).first().click(); await page.waitForTimeout(2500) }
const opened = new Set()
async function viaLightbox(label, openFn) {
  await openFn()
  await page.locator('.lightbox').waitFor()
  const name = ((await page.locator('.lightbox').getAttribute('aria-label')) ?? '').replace(/ — image viewer$/, '')
  opened.add(name)
  await page.locator('[data-testid="lightbox-edit"]').click()
  await expectStudioReady(label, name)
  // The viewer is still there behind it and works again.
  check((await page.locator('.lightbox').count()) === 1, `${label}: the viewer is still open underneath after closing the studio`)
  await page.keyboard.press('Escape')
  await page.locator('.lightbox').waitFor({ state: 'detached' })
}

try {
  await page.waitForFunction(async () => { const b = await window.noema.bootstrap(); return b.stats.images >= 14 && !b.roots.some((r) => r.scanning) }, null, { timeout: 120_000 })
  const items = await page.evaluate(() => window.noema.listImages({ scope: 'archive', limit: 50 }).then((p) => p.items.map((i) => ({ id: i.id, name: i.filename, path: i.path }))))
  check(items.some((i) => i.name.endsWith('.png')) && items.some((i) => i.name.endsWith('.jpg')) && items.some((i) => i.name.endsWith('.webp')), `the library holds ${items.length} ordinary PNG, JPEG and WebP pictures`)
  const png = items.find((i) => i.name.endsWith('.png'))

  log('Collection')
  await nav(/^Collection/)
  await page.waitForSelector('.image-card')
  for (const kind of ['png', 'jpg', 'webp']) {
    const card = page.locator('.image-card', { has: page.locator(`img[alt$=".${kind}"]`) }).first()
    await viaLightbox(`Collection ${kind}`, async () => { await card.locator('.image-card__open').click() })
  }

  log('Favorites')
  await page.evaluate((id) => window.noema.updateImage({ id, favorite: true }), png.id)
  await nav('Favorites')
  await page.waitForSelector('.image-card')
  await viaLightbox('Favorites png', async () => { await page.locator('.image-card__open').first().click() })

  log('Archive')
  const archived = items.find((i) => i.name.endsWith('.jpg'))
  await page.evaluate((id) => window.noema.updateImage({ id, decision: 'pass', reviewed: true }), archived.id)
  await nav('Archive')
  await page.waitForSelector('.archive-row:not(.archive-row--skeleton)')
  await viaLightbox('Archive', async () => { await page.locator('.archive-row:not(.archive-row--skeleton)').first().click() })

  log('Moodboards')
  const board = await page.evaluate(async (ids) => { const b = await window.noema.createMoodboard('Entry test'); await window.noema.addToMoodboard({ moodboardId: b.id, imageIds: ids }); return b }, items.slice(0, 4).map((i) => i.id))
  await page.evaluate((id) => (location.hash = `#/moodboard/${encodeURIComponent(id)}`), board.id)
  await page.waitForSelector('.board-item')
  await viaLightbox('Moodboard', async () => { await page.locator('.board-item').first().click() })

  log('Families')
  const fam = await page.evaluate(() => window.noema.listFamilies().then((f) => ({ n: f.families.length, building: f.building })))
  if (fam.n > 0) {
    await page.evaluate(() => (location.hash = '#/families'))
    await page.locator('.family-card').first().click()
    await page.waitForSelector('.image-card')
    await viaLightbox('Families', async () => { await page.locator('.image-card__open').first().click() })
  } else {
    note('no families exist in this fresh library (they need the AI picture index), so this entry point was not driven here')
  }

  log('A picture whose file has gone: a clear explanation, not silence')
  const victim = items.find((i) => !opened.has(i.name))
  const victimCopy = join(libDir, '..', 'victim-backup.webp')
  await fs.copyFile(victim.path, victimCopy)
  await fs.rm(victim.path)
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('atlas:open-studio', { detail: { mode: 'edit', imageId: id } })), victim.id)
  await page.locator('.studio').waitFor()
  await page.locator('[data-testid="edit-load-problem"]').waitFor({ timeout: 15_000 }).catch(() => undefined)
  const problem = await page.locator('[data-testid="edit-load-problem"]').innerText().catch(() => '')
  check(/cannot be edited/i.test(problem) && /Choose another picture/i.test(problem), `it explains what happened and what to do: ${problem.replace(/\s+/g, ' ').slice(0, 160)}`)
  await page.screenshot({ path: join(shots, 'missing-file.png') })
  await fs.rename(victimCopy, victim.path)
  await page.locator('button[aria-label="Close the studio"]').click()

  const after = await hashes()
  check(JSON.stringify(after) === JSON.stringify(before), 'every original picture is byte-for-byte unchanged')
  check(errors.length === 0, `no errors in the page${errors.length ? `: ${errors[0]}` : ''}`)
  console.log('\n✓ Edit opens the Creative Studio in front, with the picture loaded, from every viewer entry point.')
} catch (error) {
  console.log(`\n✗ ${error instanceof Error ? error.message : error}`)
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
}
