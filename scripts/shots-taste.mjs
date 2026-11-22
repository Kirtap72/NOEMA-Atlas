// Takes the Taste Compass screenshots used in the manual, from the synthetic fixture images (never personal images).
//   node scripts/shots-taste.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'
import { ensureE2eFixtures } from './fixtures.mjs'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const screenshots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? 'docs/screenshots')
const fixtures = resolve('.e2e/images')
const profile = resolve('.e2e/profile-taste-shots')
const modelsDir = process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models')
await ensureE2eFixtures(fixtures)
await fs.rm(profile, { recursive: true, force: true })
const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_E2E_SEED: fixtures, NOEMA_MODELS_DIR: modelsDir }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
const page = await app.firstWindow({ timeout: 90_000 })
await page.setViewportSize({ width: 1500, height: 1000 })

async function until(predicate, timeout = 60_000) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out: ${predicate}`)
    await page.waitForTimeout(500)
  }
}

try {
  await until(async () => {
    const s = await window.noema.getIndexStatus()
    const boot = await window.noema.bootstrap()
    return !boot.roots.some((r) => r.scanning) && s.total >= 20 && s.indexed >= s.total
  }, 180_000)
  // A made-up taste: the fixtures are soft glowing studies, so prefer the ones that look warmer and brighter.
  const order = await page.evaluate(async () => {
    const p = await window.noema.listImages({ scope: 'archive', search: 'a bright, luminous, warm golden image', visual: true, limit: 120 })
    return p.items.map((i) => i.id)
  })
  const rank = new Map(order.map((id, i) => [id, i]))
  await page.evaluate(() => (location.hash = '#/taste'))
  await page.waitForSelector('.taste-choice img')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(screenshots, '18-taste-start.png') })
  for (let i = 0; i < 60; i += 1) {
    await page.waitForSelector('.taste-choice:not([disabled])')
    const srcs = await page.locator('.taste-choice img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')))
    const id = (src) => /thumb\/([^.]+)\.webp/.exec(src)?.[1]
    const ra = rank.get(id(srcs[0])) ?? 999
    const rb = rank.get(id(srcs[1])) ?? 999
    await page.keyboard.press(ra <= rb ? 'ArrowLeft' : 'ArrowRight')
    await page.waitForTimeout(300)
    if (i === 11) {
      await page.waitForTimeout(900)
      await page.screenshot({ path: join(screenshots, '19-taste-early.png') })
    }
  }
  await page.waitForTimeout(1500)
  const brightPetal = page.locator('.taste-petal[aria-label^="Bright"]')
  await brightPetal.click()
  await page.waitForSelector('.taste-examples')
  await page.mouse.move(5, 5)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(screenshots, '20-taste-compass.png') })
  await page.locator('.taste-recs').scrollIntoViewIfNeeded()
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(screenshots, '21-taste-recommendations.png') })
  console.log('Saved Taste screenshots to', screenshots)
} finally {
  await app.close().catch(() => undefined)
}
