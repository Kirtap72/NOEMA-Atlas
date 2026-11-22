// The companion and Retouch, in the real application: natural language in, proposals, the Retouch tab opened ready.
//   node scripts/e2e-retouch-companion.mjs --exe "release/win-unpacked/NOEMA Atlas.exe"
import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const packDir = resolve('reference')
const modelsDir = process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models')
const shots = resolve('.e2e/screenshots-retouch-companion')
await fs.mkdir(shots, { recursive: true })
const check = (c, m) => {
  if (!c) throw new Error(`FAILED: ${m}`)
  console.log(`  ✓ ${m}`)
}
const libDir = resolve('.e2e/retouch-companion-library')
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
const manifest = JSON.parse(await fs.readFile(join(packDir, 'manifest.json'), 'utf8'))
let n = 0
for (const it of manifest.items.slice(0, 6)) await sharp(join(packDir, 'images', it.file)).resize({ width: 1200 }).jpeg({ quality: 92 }).toFile(join(libDir, `landscape-${n++}.jpg`))
const profile = resolve(`.e2e/profile-rtc-${Date.now()}`)
const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir, NOEMA_STUDIO_DIR: resolve('.e2e/rtc-pictures'), NOEMA_E2E_SEED: libDir }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
const page = await app.firstWindow({ timeout: 90_000 })
await page.setViewportSize({ width: 1500, height: 1000 })
page.setDefaultTimeout(60_000)
try {
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
  await page.waitForFunction(async () => { const b = await window.noema.bootstrap(); const l = await window.noema.listImages({ scope: 'archive', limit: 50 }); return l.items.length >= 6 && !b.roots.some((r) => r.scanning) }, null, { timeout: 120_000 })
  await page.waitForTimeout(800)
  await page.keyboard.press('Control+j')
  await page.locator('.companion').waitFor()
  const ask = async (text) => {
    const box = page.locator('.companion__form textarea')
    await box.fill(text)
    await box.press('Enter')
    await page.locator('.chat-thinking').waitFor({ state: 'detached', timeout: 120_000 }).catch(() => undefined)
    await page.waitForTimeout(700)
  }
  const reply = () => page.locator('.chat-msg--atlas').last().innerText()
  const card = () => page.locator('.proposal--pending').last()
  const closeStudio = async () => {
    await page.locator('button[aria-label="Close the studio"]').click()
    await page.locator('.studio').waitFor({ state: 'detached' })
    if (!(await page.locator('.companion__form textarea').isVisible().catch(() => false))) await page.keyboard.press('Control+j')
    await page.locator('.companion__form textarea').waitFor()
  }
  await ask('find landscape paintings')
  await page.locator('.chat-images__grid img').first().waitFor({ timeout: 60_000 })

  console.log('\n◆ A named part: the tool is prefilled and the result is already showing')
  await ask('Blur the background a little, keep the edges natural')
  await card().waitFor({ timeout: 30_000 })
  check(/Soften the background/i.test(await card().innerText()), 'it proposes softening the background')
  await page.locator('[data-testid="proposal-accept"]').last().click()
  await page.locator('[data-testid="retouch"]').waitFor({ timeout: 15_000 })
  await page.locator('[data-testid="rt-result"]').waitFor({ timeout: 30_000 })
  check((await page.locator('[data-testid="rt-edge-aware"]').isChecked()) && (await page.locator('[data-region="background"].is-on').count()) === 1, 'Blur opens with the background marked, edge-aware on, and the preview showing')
  await page.screenshot({ path: join(shots, 'c1-blur-background.png') })
  await closeStudio()

  console.log('\n◆ A part it cannot locate: it says so and asks the user to paint')
  await ask('Remove the strange artifact near the hand.')
  await card().waitFor({ timeout: 30_000 })
  check(/paint/i.test(await reply()), 'it says it cannot find the artifact from words and asks the user to paint it')
  await page.locator('[data-testid="proposal-accept"]').last().click()
  await page.locator('[data-testid="retouch"]').waitFor({ timeout: 15_000 })
  check((await page.locator('[data-testid="rt-tool-remove"][aria-checked="true"]').count()) === 1 && (await page.locator('[data-testid="rt-result"]').count()) === 0, 'Remove opens with nothing marked')
  await closeStudio()

  console.log('\n◆ Heal and sharpen: not locatable, handed to the user')
  await ask('Heal the damaged texture on the cheek.')
  await card().waitFor({ timeout: 30_000 })
  check(/paint/i.test(await reply()) && /Heal/.test(await card().innerText()), 'Heal: it asks the user to mark the cheek')
  await ask('Gently sharpen the architectural details.')
  await page.waitForTimeout(500)
  check(/Sharpen/.test(await card().innerText()) && /paint/i.test(await reply()), 'Sharpen: gentle, and the details have to be marked')

  console.log('\n◆ Two steps in one sentence: plan what can be found, hand over what cannot')
  await ask('Brighten the face slightly and darken the background.')
  await page.waitForTimeout(800)
  const text = await reply()
  check(/the background/.test(text) && /paint/i.test(text), 'it plans the background and asks the user to paint the face')
  const pending = await page.locator('.proposal--pending').count()
  check(pending >= 2, `two proposals are shown (${pending} pending)`)
  await page.screenshot({ path: join(shots, 'c2-two-steps.png') })
  const plan = page.locator('.proposal--pending', { hasText: /Darken the background/ }).last()
  await plan.locator('[data-testid="proposal-accept"]').click()
  const ranCard = page.locator('.proposal--applied', { hasText: /Darken the background/ }).last()
  await ranCard.waitFor({ timeout: 180_000 })
  const done = await ranCard.innerText()
  check(/Finished|new version/.test(done), `the background step ran locally and was saved as a linked version: ${done.replace(/\s+/g, ' ').slice(0, 120)}`)
  console.log('\n✓ The companion drives Retouch.')
} catch (error) {
  console.log(`\n✗ ${error instanceof Error ? error.message : error}`)
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app.close().catch(() => undefined)
}
