// Artistic discovery on a computer with NO image model installed, and no library: the packaged reference collection
// alone must be enough for exploring, journeys, saving and history (all offline).
//
//   node scripts/e2e-discovery-offline.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
import { promises as fs, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const log = (m) => console.log(`\n◆ ${m}`)
const check = (c, m) => {
  if (!c) throw new Error(`FAILED: ${m}`)
  console.log(`  ✓ ${m}`)
}
const manifest = JSON.parse(readFileSync(resolve('reference/manifest.json'), 'utf8'))
const shelfOf = new Map(manifest.items.map((i) => [i.id, i.shelf]))
const idOf = (src) => /ref\/([a-z]+-\d+)/.exec(src)?.[1]

const profile = resolve('.e2e/profile-discovery-offline')
const emptyModels = resolve('.e2e/no-models')
await fs.rm(profile, { recursive: true, force: true })
await fs.rm(emptyModels, { recursive: true, force: true })
await fs.mkdir(emptyModels, { recursive: true })
const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: emptyModels }
delete env.ELECTRON_RUN_AS_NODE
delete env.NOEMA_REFERENCE_DIR

const app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
const page = await app.firstWindow({ timeout: 90_000 })
await page.setViewportSize({ width: 1500, height: 1000 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
try {
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
  log('No model, no library, no network needed')
  const model = await page.evaluate(() => window.noema.getModelStatus())
  check(!model.installed, 'the image model is not installed')
  const info = await page.evaluate(() => window.noema.getReferenceInfo())
  check(info.available && info.works >= 1000, `the reference collection is installed with the app (${info.works} works)`)
  await page.evaluate(() => (location.hash = '#/taste'))
  await page.waitForSelector('.taste-choice img', { timeout: 30_000 })
  await page.waitForTimeout(800)
  const likes = new Set(['baroque', 'renaissance', 'portrait', 'still-life'])
  for (let i = 0; i < 30; i += 1) {
    await page.waitForSelector('.taste-choice:not([disabled])')
    await page.evaluate(() => document.activeElement?.blur?.())
    const srcs = await page.locator('.taste-choice img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')))
    const [a, b] = srcs.map((s) => likes.has(shelfOf.get(idOf(s))))
    const before = await page.evaluate(async () => { const s = await window.noema.getDiscovery(); return s.informative + s.counts.undecided })
    await page.keyboard.press(a && b ? 'ArrowUp' : !a && !b ? 'ArrowDown' : a ? 'ArrowLeft' : 'ArrowRight')
    for (let w = 0; w < 60; w += 1) {
      const now = await page.evaluate(async () => { const s = await window.noema.getDiscovery(); return s.informative + s.counts.undecided })
      if (now > before) break
      await page.waitForTimeout(150)
    }
  }
  const ds = await page.evaluate(() => window.noema.getDiscovery())
  check(ds.informative >= 28 && ds.modes.length >= 1, `exploration works offline (${ds.informative} answers, ${ds.modes.length} direction(s) found)`)

  await page.getByRole('tab', { name: 'My identity' }).click()
  await page.waitForTimeout(1000)
  const identity = await page.evaluate(() => window.noema.getIdentity())
  check(!identity.available && /model|favorite/i.test(identity.reason ?? ''), `identity explains what it needs: "${identity.reason}"`)
  check(await page.locator('.empty-state').isVisible(), 'the identity tab shows a clear empty state, not an error')

  await page.getByRole('tab', { name: 'Compare' }).click()
  await page.waitForSelector('.artmap svg', { timeout: 30_000 })
  const cmp = await page.evaluate(() => window.noema.getCompare())
  check(cmp.points.some((p) => p.kind === 'liked') && cmp.discovery.informative >= 28, 'the map still shows discoveries without favorites')
  check(cmp.headline.some((h) => /model|favorite/i.test(h)), 'the comparison says why the identity half is missing')

  await page.getByRole('tab', { name: 'Journeys' }).click()
  await page.waitForSelector('.suggestion', { timeout: 30_000 })
  await page.locator('.suggestion', { hasText: /Beyond|emerging/i }).first().getByRole('button', { name: 'Begin the journey' }).click()
  await page.waitForSelector('.exhibition', { timeout: 30_000 })
  for (let i = 0; i < 5; i += 1) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250) }
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  // Saving a discovery works without the model: it only copies a file and makes a preview.
  const journey = (await page.evaluate(() => window.noema.listJourneys())).journeys[0]
  const work = journey.chapters[0].works[0].work
  const saved = await page.evaluate((id) => window.noema.saveDiscovery({ workId: id, favorite: true }), work.id)
  check(!!saved.imageId, 'a discovery can be saved to the library without the image model')
  const item = await page.evaluate((id) => window.noema.getImage(id), saved.imageId)
  check(item.thumbStatus === 'ready' && item.favorite && item.tags.includes('atlas-discovery'), 'it is a normal, favorited library image with its museum details')

  await page.getByRole('tab', { name: 'History' }).click()
  await page.waitForSelector('.history', { timeout: 20_000 })
  const hist = await page.evaluate(() => window.noema.getHistory())
  check(hist.snapshots.length >= 1, `history is recorded (${hist.snapshots.length} snapshots)`)

  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Offline discovery checks passed.')
} finally {
  await app.close().catch(() => undefined)
}
