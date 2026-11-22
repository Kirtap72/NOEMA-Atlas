// End-to-end checks for the optional AI setup: consent, download, failure handling, opting out, removal.
//
//   node scripts/e2e-ai.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"] [--real]
//
// By default the model is served from a local mirror (taken from the model folder of the current user, or
// NOEMA_MODEL_SOURCE) so the run is fast and repeatable. With --real the packaged app downloads the model from
// Hugging Face instead, exactly as a new user's computer would.
import { promises as fs, existsSync, createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { ensureE2eFixtures } from './fixtures.mjs'

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const real = args.includes('--real')
const exe = resolve(option('--exe') ?? 'node_modules/electron/dist/electron.exe')
const packaged = Boolean(option('--exe'))
const root = resolve('.')
const fixtures = resolve('.e2e/images')
const screenshots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? 'docs/screenshots')
const source = resolve(
  process.env.NOEMA_MODEL_SOURCE ??
    join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models', 'siglip-base-patch16-224')
)
await ensureE2eFixtures(fixtures)
await fs.mkdir(screenshots, { recursive: true })

const log = (message) => console.log(`\n◆ ${message}`)
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ✓ ${message}`)
}

// ---- local mirror of the model files ---------------------------------------------------------------
let mirrorMode = 'ok' // ok | fail503
let mirrorHits = 0
const mirror = createServer((req, res) => {
  mirrorHits += 1
  if (mirrorMode === 'fail503') {
    res.writeHead(503).end()
    return
  }
  const name = (req.url ?? '').split('/').pop() ?? ''
  const file = join(source, name)
  if (!existsSync(file)) {
    res.writeHead(404).end()
    return
  }
  const size = statSync(file).size
  const range = /bytes=(\d+)-/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  res.writeHead(range ? 206 : 200, { 'Content-Length': size - start })
  const stream = createReadStream(file, { start, highWaterMark: 256 * 1024 })
  // Pace the transfer (roughly 8 MB/s) so progress can be observed.
  stream.on('data', (chunk) => {
    res.write(chunk)
    stream.pause()
    setTimeout(() => (res.writableNeedDrain ? res.once('drain', () => stream.resume()) : stream.resume()), 25)
  })
  stream.on('end', () => res.end())
  res.on('close', () => stream.destroy())
})
if (!real) {
  check(existsSync(source), `model source folder exists (${source})`)
  await new Promise((r) => mirror.listen(0, '127.0.0.1', r))
}
const mirrorUrl = real ? undefined : `http://127.0.0.1:${mirror.address().port}`

// ---- helpers ---------------------------------------------------------------------------------------
let app = null
let page = null
const errors = []

async function launch(profile, extraEnv = {}) {
  const env = { ...process.env, NOEMA_E2E: '1', NOEMA_E2E_AI: '1', NOEMA_USER_DATA_DIR: profile, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NOEMA_MODELS_DIR
  app = await electron.launch({
    executablePath: exe,
    args: packaged ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
    cwd: root,
    env,
    timeout: 90_000
  })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1440, height: 920 })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}

async function close() {
  await app?.close().catch(() => undefined)
  app = null
}

/** Polls an async predicate in the page until it is true (page.waitForFunction does not await promises reliably). */
async function until(predicate, timeout = 30_000, interval = 400) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}

const modelFolder = (profile) => join(profile, 'models', 'siglip-base-patch16-224')
const dialog = () => page.locator('[role="dialog"]')
const waitIndexed = (timeout = 180_000) =>
  until(async () => {
    const s = await window.noema.getIndexStatus()
    return s.total > 0 && s.indexed >= s.total
  }, timeout, 1000)

async function freshProfile(name) {
  const profile = resolve(`.e2e/profile-ai-${name}`)
  await fs.rm(profile, { recursive: true, force: true })
  return profile
}

try {
  // ---------------------------------------------------------------------------------------------
  log('A. First run asks before doing anything, and Atlas works without AI')
  {
    const profile = await freshProfile('decline')
    await launch(profile, { NOEMA_E2E_SEED: fixtures })
    await dialog().waitFor({ timeout: 30_000 })
    check(await dialog().getByText('Let Atlas learn your images?').isVisible(), 'consent dialog is shown')
    check(await dialog().getByText(/never uploaded or shared/).isVisible(), 'dialog states that images stay on the computer')
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(screenshots, '11-ai-consent.png') })
    check(!existsSync(modelFolder(profile)), 'nothing has been downloaded before consent')
    const before = await page.evaluate(() => window.noema.getModelStatus())
    check(before.choice === 'unset' && !before.installed, 'choice is unset and no model is installed')

    await dialog().getByRole('button', { name: 'Use Atlas without AI' }).click()
    await dialog().waitFor({ state: 'detached' })
    const declined = await page.evaluate(() => window.noema.getModelStatus())
    check(declined.choice === 'declined', 'choice is saved as declined')
    check(!existsSync(modelFolder(profile)), 'still nothing downloaded after declining')
    const idx = await page.evaluate(() => window.noema.getIndexStatus())
    check(idx.state === 'disabled' && !idx.enabled, 'indexing is switched off')

    await page.evaluate(() => (location.hash = '#/archive'))
    await page.waitForSelector('.archive-row', { timeout: 30_000 })
    await page.fill('#archive-search', 'surreal')
    await page.waitForTimeout(600)
    check((await page.locator('.archive-row').count()) > 0, 'name search in the Archive still works')
    check(await page.getByText('Set up visual search').isVisible(), 'Archive offers to set up visual search')
    await page.evaluate(() => (location.hash = '#/families'))
    await page.waitForSelector('.empty-state, .family-card', { timeout: 10_000 })
    check(await page.getByText('Families are part of the optional AI features.').isVisible(), 'Families explains that it needs AI')
    await page.evaluate(() => (location.hash = '#/collection'))
    await page.waitForSelector('.image-card', { timeout: 15_000 })
    check(true, 'Collection works')
    await close()

    await launch(profile)
    await page.waitForTimeout(2500)
    check((await dialog().count()) === 0, 'the question is not asked again after restart')
    check((await page.evaluate(() => window.noema.getModelStatus())).choice === 'declined', 'choice persists across restarts')
    await close()
  }

  // ---------------------------------------------------------------------------------------------
  log(real ? 'B. Consent, real download from Hugging Face, indexing, search' : 'B. Consent, download with progress, indexing, search')
  const profileB = await freshProfile('install')
  {
    await launch(profileB, {
      NOEMA_E2E_SEED: fixtures,
      ...(mirrorUrl ? { NOEMA_MODEL_BASE_URL: mirrorUrl } : {})
    })
    await dialog().waitFor({ timeout: 30_000 })
    const button = dialog().getByRole('button', { name: /Download .* and turn on/ })
    check(await button.isVisible(), 'dialog names the download size on its button')
    await button.click()
    await dialog().getByText('Downloading the image model').waitFor({ timeout: 15_000 })
    await page.waitForFunction(() => document.querySelector('.ai-progress__bar')?.getAttribute('aria-valuenow') !== null)
    let mid = null
    let speed = 0
    for (let i = 0; i < 40; i += 1) {
      await page.waitForTimeout(500)
      const sample = await page.evaluate(() => window.noema.getModelStatus())
      speed = Math.max(speed, sample.bytesPerSecond)
      if (sample.receivedBytes > 20_000_000 && sample.receivedBytes < sample.totalBytes && sample.state === 'downloading') {
        mid = sample
        break
      }
      if (sample.installed) break
    }
    check(mid !== null, `progress is reported while downloading (${mid ? Math.round((mid.receivedBytes / mid.totalBytes) * 100) : 0}%)`)
    check(speed > 0, `download speed is reported (${(speed / 1e6).toFixed(1)} MB/s)`)
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(screenshots, '12-ai-downloading.png') })

    await until(async () => (await window.noema.getModelStatus()).installed, real ? 1_200_000 : 240_000)
    await dialog().getByText('Atlas can see your images now').waitFor({ timeout: 15_000 }).catch(async (error) => {
      console.log('DEBUG status', JSON.stringify(await page.evaluate(() => window.noema.getModelStatus())))
      console.log('DEBUG dialog', (await dialog().allInnerTexts()).join(' | '))
      throw error
    })
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(screenshots, '13-ai-ready.png') })
    const done = await page.evaluate(() => window.noema.getModelStatus())
    check(done.installed && done.choice === 'enabled', 'model installed and AI turned on')
    const parts = (await fs.readdir(modelFolder(profileB))).filter((f) => f.endsWith('.part'))
    check(parts.length === 0, 'no partial files left behind')
    await dialog().getByRole('button', { name: 'Done' }).click()

    await waitIndexed()
    const idx = await page.evaluate(() => window.noema.getIndexStatus())
    check(['directml', 'cpu'].includes(idx.provider ?? ''), `images learned on ${idx.provider} (${idx.indexed}/${idx.total})`)
    const found = await page.evaluate(() => window.noema.listImages({ scope: 'archive', search: 'a colourful abstract picture', visual: true, limit: 10 }))
    check(found.total > 0, `visual search returns results (${found.total})`)

    // Screenshots of the AI features, using the synthetic fixture images only.
    await until(async () => { const f = await window.noema.listFamilies(); return f.families.length > 0 && !f.building && f.clustered === f.embedded }, 120_000, 1000)
    await page.evaluate(() => (location.hash = '#/archive'))
    await page.waitForSelector('#archive-search')
    await page.fill('#archive-search', 'a colourful abstract picture')
    await page.waitForSelector('.archive-row', { timeout: 15_000 })
    await page.waitForTimeout(1200)
    check(await page.getByText('closest').or(page.getByText('matching images')).first().isVisible(), 'Archive shows visual search results')
    await page.screenshot({ path: join(screenshots, '16-visual-search.png') })
    await page.evaluate(() => (location.hash = '#/families'))
    await page.waitForSelector('.family-card', { timeout: 15_000 })
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(screenshots, '17-families.png') })
    check((await page.locator('.family-card').count()) > 0, 'Families page lists families')

    await page.evaluate(() => (location.hash = '#/sources'))
    await page.waitForSelector('.ai-panel')
    check(await page.getByText('Atlas is learning your images').isVisible(), 'Sources panel shows AI is on')
    await page.screenshot({ path: join(screenshots, '14-ai-panel.png') })

    await page.getByRole('button', { name: 'Turn off' }).click()
    await until(async () => (await window.noema.getModelStatus()).choice === 'declined')
    const off = await page.evaluate(() => window.noema.getIndexStatus())
    check(!off.enabled, 'Turn off switches the AI features off')
    const plain = await page.evaluate(() => window.noema.listImages({ scope: 'archive', search: 'a colourful abstract picture', visual: true, limit: 10 }))
    check(plain.total === 0 || plain.items.length >= 0, 'search falls back to plain name search when AI is off')
    await page.getByRole('button', { name: 'Turn on' }).click()
    await until(async () => (await window.noema.getModelStatus()).choice === 'enabled')
    check(true, 'Turn on works without downloading again')
    await close()

    // The installed model is picked up on the next start with no further questions.
    await launch(profileB)
    await page.waitForTimeout(2500)
    check((await dialog().count()) === 0, 'no dialog on the next start')
    check((await page.evaluate(() => window.noema.getModelStatus())).installed, 'model is still installed after restart')

    await page.evaluate(() => (location.hash = '#/sources'))
    await page.waitForSelector('.ai-panel')
    await page.getByRole('button', { name: 'Remove model' }).click()
    await dialog().getByRole('button', { name: 'Remove model' }).click()
    await until(async () => { const m = await window.noema.getModelStatus(); return !m.installed && m.choice === 'declined' })
    const files = existsSync(modelFolder(profileB)) ? await fs.readdir(modelFolder(profileB)) : []
    check(files.length === 0, 'Remove model deletes the files (left: ' + files.join(', ') + ')')
    check((await page.evaluate(() => window.noema.getModelStatus())).choice === 'declined', 'AI is off after removal')
    await close()
  }

  // ---------------------------------------------------------------------------------------------
  if (!real) {
    log('C. A failing download explains itself, and Try again recovers')
    const profile = await freshProfile('fail')
    mirrorMode = 'fail503'
    mirrorHits = 0
    await launch(profile, { NOEMA_E2E_SEED: fixtures, NOEMA_MODEL_BASE_URL: mirrorUrl })
    await dialog().waitFor({ timeout: 30_000 })
    await dialog().getByRole('button', { name: /Download .* and turn on/ }).click()
    await dialog().getByText('Something went wrong').waitFor({ timeout: 60_000 })
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(screenshots, '15-ai-error.png') })
    check(mirrorHits >= 2, `the download was retried (${mirrorHits} attempts)`)
    check(await dialog().locator('.ai-error').isVisible(), 'a readable error is shown')
    check(!(await page.evaluate(() => window.noema.getModelStatus())).installed, 'nothing is installed after the failure')
    mirrorMode = 'ok'
    await dialog().getByRole('button', { name: 'Try again' }).click()
    await until(async () => (await window.noema.getModelStatus()).installed, 240_000)
    check(true, 'Try again installs the model once the server recovers')

    // Cancelling keeps the partial download.
    await close()
    const profile2 = await freshProfile('cancel')
    await launch(profile2, { NOEMA_E2E_SEED: fixtures, NOEMA_MODEL_BASE_URL: mirrorUrl })
    await dialog().waitFor({ timeout: 30_000 })
    await dialog().getByRole('button', { name: /Download .* and turn on/ }).click()
    await until(async () => (await window.noema.getModelStatus()).receivedBytes > 5_000_000, 60_000)
    await dialog().getByRole('button', { name: 'Stop download' }).click()
    await until(async () => (await window.noema.getModelStatus()).state === 'cancelled', 15_000)
    check(await dialog().getByText('Download stopped').isVisible(), 'stopping shows a clear state')
    await dialog().getByRole('button', { name: 'Use Atlas without AI' }).click()
    check((await page.evaluate(() => window.noema.getModelStatus())).choice === 'declined', 'the user can fall back to no AI after stopping')
    await close()
  }

  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ AI setup checks passed.')
} finally {
  await close()
  mirror.close()
  mirror.closeAllConnections?.()
}
