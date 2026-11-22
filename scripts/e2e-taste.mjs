// End-to-end check of the Taste Compass on a real image library, using simulated users.
//
//   node scripts/e2e-taste.mjs --library "G:/some/folder/of/images" [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// Needs the AI model to be installed (or NOEMA_MODELS_DIR to point at it). Simulated users make their choices in the
// real interface (keyboard and buttons). Their taste comes from the app's own visual search, so no hidden labels are
// involved: a "dark" user always prefers the image that ranks higher for "a dark, moody, low-key image" (10% of the
// time they pick the other one), and a user choosing at random must NOT produce a confident profile.
import { promises as fs, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const library = option('--library')
if (!library) throw new Error('Pass --library <folder of images>.')
const exe = resolve(option('--exe') ?? 'node_modules/electron/dist/electron.exe')
const packaged = Boolean(option('--exe'))
const root = resolve('.')
const screenshots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-taste')
const modelsDir = process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models')
await fs.mkdir(screenshots, { recursive: true })

const log = (message) => console.log(`\n◆ ${message}`)
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ✓ ${message}`)
}

const profile = resolve('.e2e/profile-taste')
await fs.rm(profile, { recursive: true, force: true })
const env = {
  ...process.env,
  NOEMA_E2E: '1',
  NOEMA_USER_DATA_DIR: profile,
  NOEMA_E2E_SEED: library,
  NOEMA_MODELS_DIR: modelsDir
}
delete env.ELECTRON_RUN_AS_NODE
check(existsSync(modelsDir), `model folder exists (${modelsDir})`)

const app = await electron.launch({
  executablePath: exe,
  args: packaged ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'],
  cwd: root,
  env,
  timeout: 90_000
})
const page = await app.firstWindow({ timeout: 90_000 })
await page.setViewportSize({ width: 1500, height: 1000 })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})

async function until(predicate, timeout = 30_000, interval = 500) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}

// Deterministic coin for the simulated users.
let seed = 12345
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296
}

async function rankMap(queries) {
  // The whole library ranked by how well each image matches a description (averaged over a few phrasings).
  const lists = await page.evaluate(async (qs) => {
    const all = []
    for (const q of qs) {
      const out = []
      for (let offset = 0; offset < 400; offset += 120) {
        const p = await window.noema.listImages({ scope: 'archive', search: q, visual: true, limit: 120, offset })
        out.push(...p.items.map((i) => i.id))
        if (out.length >= p.total) break
      }
      all.push(out)
    }
    return all
  }, queries)
  const total = new Map()
  for (const list of lists) {
    const ranks = new Map(list.map((id, index) => [id, index]))
    for (const id of new Set(lists.flat())) total.set(id, (total.get(id) ?? 0) + (ranks.get(id) ?? 400))
  }
  return new Map(Array.from(total.entries()).map(([id, sum]) => [id, sum / queries.length]))
}

const idOf = (src) => /thumb\/([^.]+)\.webp/.exec(src)?.[1]

/** Make `count` choices in the real interface with the given user model. */
async function chooseMany(count, preferred /* Map id -> rank, or null for random */, flip = 0.1) {
  for (let i = 0; i < count; i += 1) {
    await page.waitForSelector('.taste-choice:not([disabled])', { timeout: 20_000 })
    const [a, b] = await page.locator('.taste-choice img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')))
    let left = rand() < 0.5
    if (preferred) {
      const ra = preferred.get(idOf(a)) ?? 1000
      const rb = preferred.get(idOf(b)) ?? 1000
      left = ra === rb ? rand() < 0.5 : ra < rb
      if (rand() < flip) left = !left
    }
    // Mostly the keyboard, sometimes the mouse, to exercise both.
    if (i % 7 === 3) await page.locator('.taste-choice').nth(left ? 0 : 1).click()
    else await page.keyboard.press(left ? 'ArrowLeft' : 'ArrowRight')
    await page.waitForFunction((n) => {
      const el = document.querySelector('.taste-compass__count')
      return el && Number(el.textContent) >= n
    }, i + 1 - 0, { timeout: 20_000 }).catch(() => undefined)
    await page.waitForTimeout(260)
  }
}

const dimension = (state, id) => state.dimensions.find((d) => d.id === id)

try {
  await until(() => !!window.noema && !!document.querySelector('.app-shell'), 60_000)
  log('Preparing: scanning and learning the library')
  await until(async () => {
    const s = await window.noema.getIndexStatus()
    const boot = await window.noema.bootstrap()
    return !boot.roots.some((r) => r.scanning) && s.total > 40 && s.indexed >= s.total
  }, 900_000, 2000)
  const idx = await page.evaluate(() => window.noema.getIndexStatus())
  check(idx.indexed > 40, `${idx.indexed} images learned on ${idx.provider}`)

  await page.evaluate(() => (location.hash = '#/taste'))
  await page.waitForSelector('.taste-compare', { timeout: 30_000 })
  await page.waitForSelector('.taste-choice img')
  await page.waitForTimeout(900)
  check(await page.getByText('Which do you prefer?').isVisible(), 'the comparison screen is shown')
  check(await page.locator('.taste-petal').count() === 12, 'the compass has 12 petals (6 axes, 2 poles each)')
  let state = await page.evaluate(() => window.noema.getTasteState())
  check(state.choices === 0 && state.stage === 'start' && !state.canRecommend, 'a new profile starts empty and says so')
  check(state.dimensions.every((d) => !d.certain), 'no petal claims anything before the user has chosen')
  await page.screenshot({ path: join(screenshots, '18-taste-start.png') })

  // ---------------------------------------------------------------------------------------------
  log('A. A user who chooses at random must not get a confident profile')
  await chooseMany(30, null)
  state = await page.evaluate(() => window.noema.getTasteState())
  check(state.choices === 30, `30 random choices recorded (${state.choices})`)
  const spurious = state.dimensions.filter((d) => d.certain && Math.abs(d.lean) > 0.3)
  check(spurious.length <= 2, `random choices give no confident preferences (${spurious.length} of 12 petals flagged: ${spurious.map((d) => d.id).join(', ') || 'none'})`)
  await page.waitForTimeout(500)
  state = await page.evaluate(() => window.noema.getTasteState())
  check(state.accuracy === null || state.accuracy < 0.68, `prediction accuracy stays near chance for random choices (${state.accuracy === null ? 'n/a' : Math.round(state.accuracy * 100) + '%'})`)

  // ---------------------------------------------------------------------------------------------
  log('B. Skip, undo and start over')
  await page.getByRole('button', { name: /Can't say/ }).click()
  await page.waitForTimeout(500)
  state = await page.evaluate(() => window.noema.getTasteState())
  check(state.skipped === 1 && state.choices === 30, 'skipping records nothing about taste')
  await page.getByRole('button', { name: /Undo/ }).click()
  await page.waitForTimeout(500)
  state = await page.evaluate(() => window.noema.getTasteState())
  check(state.skipped === 0, 'undo removes the skip')
  await page.getByRole('button', { name: /Start over/ }).click()
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Start over' }).click()
  await page.waitForTimeout(800)
  state = await page.evaluate(() => window.noema.getTasteState())
  check(state.choices === 0 && state.skipped === 0, 'start over forgets all comparisons')
  check(await page.locator('.taste-choice').count() === 2, 'a fresh pair is shown after starting over')

  // ---------------------------------------------------------------------------------------------
  log('C. A user who prefers dark, moody images')
  const dark = await rankMap(['a dark, moody, low-key image', 'a scene lit only by a little light in deep shadow', 'a night scene'])
  check(dark.size > 100, `taste oracle built from ${dark.size} ranked images`)
  await chooseMany(12, dark)
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(screenshots, '19-taste-early.png') })
  await chooseMany(28, dark)
  await page.waitForTimeout(1500)
  state = await page.evaluate(() => window.noema.getTasteState())
  const d = dimension(state, 'dark')
  const b = dimension(state, 'bright')
  check(state.choices === 40, `40 choices made (${state.choices})`)
  check(d.lean > 0.25 && b.lean < -0.25, `after 40 choices the compass already leans the right way (dark ${d.lean.toFixed(2)}, bright ${b.lean.toFixed(2)}), still marked ${d.certain ? 'reliable' : 'not yet reliable'}`)
  check(state.canRecommend && state.stage === 'growing', `recommendations unlocked, stage "${state.stage}"`)
  console.log(`  · accuracy on own choices: ${state.accuracy === null ? 'n/a' : Math.round(state.accuracy * 100) + '%'}`)

  const ranked = Array.from(dark.entries()).sort((x, y) => x[1] - y[1]).map(([id]) => id)
  const percentileOf = (id) => (ranked.indexOf(id) < 0 ? 100 : (ranked.indexOf(id) / ranked.length) * 100)
  const recs = await page.evaluate(() => window.noema.tasteRecommend(24))
  const percentiles = recs.items.map((r) => percentileOf(r.image.id))
  const mean = percentiles.reduce((sum, v) => sum + v, 0) / percentiles.length
  const top30 = percentiles.filter((v) => v <= 30).length
  check(recs.items.length >= 12, `${recs.items.length} recommendations`)
  console.log(`  · where the recommendations rank for this user's real taste: mean top ${mean.toFixed(0)}% (random would be 50%), ${top30} of ${recs.items.length} in the top 30%`)
  check(mean <= 35, 'recommendations are clearly better than random for this user')
  check(recs.items.every((r) => r.because), 'every recommendation says which of your choices it resembles')

  await chooseMany(20, dark)
  await page.waitForTimeout(1500)
  state = await page.evaluate(() => window.noema.getTasteState())
  check(state.choices === 60 && state.stage === 'steady', `60 choices: stage "${state.stage}"`)
  check(dimension(state, 'dark').lean > 0.3, `Dark & moody lean at 60 choices: ${dimension(state, 'dark').lean.toFixed(2)} (${dimension(state, 'dark').certain ? 'reliable' : 'not yet reliable'})`)
  // A moderately consistent, noisy user needs on the order of 100 to 150 choices before the strict 99% test is passed.
  let dk = dimension(state, 'dark')
  while (!dk.certain && state.choices < 160) {
    await chooseMany(20, dark)
    await page.waitForTimeout(1200)
    state = await page.evaluate(() => window.noema.getTasteState())
    dk = dimension(state, 'dark')
  }
  check(dk.certain && dk.lean > 0.3, `after ${state.choices} choices Dark & moody is a reliable preference (lean ${dk.lean.toFixed(2)}, range ${dk.low.toFixed(2)} to ${dk.high.toFixed(2)}, 99% interval)`)
  check(dimension(state, 'bright').certain && dimension(state, 'bright').lean < -0.3, 'and Bright & luminous reliably leans the other way')
  console.log(`  · other qualities flagged as reliable: ${state.dimensions.filter((x) => x.axis !== 'light' && x.certain).map((x) => x.id).join(', ') || 'none'}`)
  console.log(`  · accuracy on own choices: ${state.accuracy === null ? 'n/a' : Math.round(state.accuracy * 100) + '%'}`)

  // The compass, the examples and the recommendations in the interface.
  await page.waitForSelector('.taste-rec', { timeout: 20_000 })
  await page.locator('.taste-petal[aria-label^="Dark & moody"]').click()
  await page.waitForSelector('.taste-examples', { timeout: 10_000 })
  await page.waitForTimeout(1200)
  check(await page.locator('.taste-readout').getByText('Dark & moody').first().isVisible(), 'the selected dimension is explained in plain words')
  check((await page.locator('.taste-examples__strip img').count()) >= 6, 'example images are shown for the dimension')
  await page.mouse.move(5, 5)
  await page.screenshot({ path: join(screenshots, '20-taste-compass.png') })
  await page.locator('.taste-recs').scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(screenshots, '21-taste-recommendations.png') })
  await page.locator('.taste-rec').first().click()
  await page.waitForSelector('.lightbox', { timeout: 10_000 })
  await page.keyboard.press('Escape')
  check(true, 'a recommendation opens in the viewer')

  // ---------------------------------------------------------------------------------------------
  log('D. The profile follows the user: a new taste reverses the compass')
  await page.locator('.taste-compare').scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: /Start over/ }).click()
  await page.locator('[role="dialog"]').getByRole('button', { name: 'Start over' }).click()
  await page.waitForTimeout(800)
  // The opposite user: whatever the dark user ranked highest, this one ranks lowest.
  const bright = new Map(Array.from(dark.entries()).map(([id, rank]) => [id, 400 - rank]))
  await chooseMany(60, bright)
  await page.waitForTimeout(1500)
  state = await page.evaluate(() => window.noema.getTasteState())
  const nowBright = dimension(state, 'bright')
  const nowDark = dimension(state, 'dark')
  check(nowBright.lean > 0.2 && nowDark.lean < -0.2, `the compass reversed: Bright & luminous ${nowBright.lean.toFixed(2)}, Dark & moody ${nowDark.lean.toFixed(2)} (${nowBright.certain ? 'reliable' : 'not yet marked reliable, which needs more choices'})`)

  // ---------------------------------------------------------------------------------------------
  log('E. The profile is saved and everything else still works');
  await app.close().catch(() => undefined)
  const app2 = await electron.launch({ executablePath: exe, args: packaged ? [] : ['.'], cwd: root, env: { ...env, NOEMA_E2E_SEED: '' }, timeout: 90_000 })
  const page2 = await app2.firstWindow({ timeout: 90_000 })
  page2.on('pageerror', (error) => errors.push(error.message))
  await page2.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
  const again = await page2.evaluate(async () => {
    for (let i = 0; i < 60; i += 1) {
      const s = await window.noema.getTasteState()
      if (s.available) return s
      await new Promise((r) => setTimeout(r, 500))
    }
    return window.noema.getTasteState()
  })
  check(again.choices === 60, `the 60 choices survive a restart (${again.choices})`)
  for (const hash of ['#/collection', '#/archive', '#/families', '#/favorites', '#/moodboards', '#/sources']) {
    await page2.evaluate((h) => (location.hash = h), hash)
    await page2.waitForTimeout(700)
    check((await page2.locator('.page').count()) > 0, `${hash.slice(2)} still opens`)
  }
  const found = await page2.evaluate(() => window.noema.listImages({ scope: 'archive', search: 'a bright image', visual: true, limit: 5 }))
  check(found.total > 0, 'visual search still works')
  await app2.close().catch(() => undefined)

  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Taste Compass checks passed.')
} finally {
  await app.close().catch(() => undefined)
}
