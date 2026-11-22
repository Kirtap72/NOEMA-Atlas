import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { ensureE2eFixtures } from './fixtures.mjs'
import { waitForScanComplete } from './wait.mjs'

const root = resolve('.')
const exe = resolve('release/win-unpacked/NOEMA Atlas.exe')
const profile = resolve('.e2e/profile-packaged')
const fixtures = resolve('.e2e/images')
await ensureE2eFixtures(fixtures)
await fs.rm(profile, { recursive: true, force: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.NOEMA_E2E = '1'
env.NOEMA_E2E_SEED = fixtures
env.NOEMA_USER_DATA_DIR = profile

const app = await electron.launch({
  executablePath: exe,
  args: [],
  cwd: root,
  env,
  timeout: 60_000
})
app.process().stdout?.on('data', (data) => process.stdout.write(`[app] ${data}`))
app.process().stderr?.on('data', (data) => process.stderr.write(`[app] ${data}`))
const page = await app.firstWindow({ timeout: 60_000 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

try {
  await waitForScanComplete(page, 28)
  await page.waitForSelector('.image-card', { timeout: 20_000 })
  await page.waitForFunction(() => {
    const image = document.querySelector('.image-card__img')
    return image && image.complete && image.naturalWidth > 0
  })
  const result = await page.evaluate(async () => {
    const bootstrap = await window.noema.bootstrap()
    const archive = await window.noema.listImages({ scope: 'archive', limit: 30 })
    return {
      stats: bootstrap.stats,
      thumbStatuses: Array.from(new Set(archive.items.map((item) => item.thumbStatus))),
      missingPreviews: archive.items.filter((item) => item.thumbStatus !== 'ready').length,
      title: document.title
    }
  })
  console.log(JSON.stringify(result, null, 2))
  await page.screenshot({ path: resolve(process.env.NOEMA_SCREENSHOT_DIR ?? 'docs/screenshots', 'packaged.png'), animations: 'disabled' })
  if (result.stats.images < 28) throw new Error('Packaged app did not index the collection')
  if (result.missingPreviews > 0) throw new Error('Packaged app could not generate thumbnails (sharp packaging issue)')
  if (errors.length > 0) throw new Error(`Renderer errors in packaged app: ${errors.join(' | ')}`)
  console.log('✓ Packaged application works.')
} finally {
  await app.close().catch(() => undefined)
}
