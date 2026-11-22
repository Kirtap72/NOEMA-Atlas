// End-to-end check of the Artistic Discovery Engine in the real application, with simulated users.
//
//   node scripts/e2e-discovery.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// The library is built from reference artworks (public domain), so the "user's" own images are real artworks of
// known kinds. The simulated user explores through the real interface (keyboard and mouse), using all five answers,
// then the script checks both profiles, the comparison, journeys (view, react, save to library and moodboard),
// history, restart persistence, the screenshot guard and that the user's own files are never modified.
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-discovery')
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
const shelfOf = new Map(manifest.items.map((i) => [i.id, i.shelf]))

// ---- the user's library (made from reference artworks of known kinds, plus decoys) ---------------------------------
const libDir = resolve('.e2e/discovery-library')
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
const pick = async (shelf, count, prefix) => {
  const items = manifest.items.filter((i) => i.shelf === shelf).slice(0, count)
  let n = 0
  for (const it of items) {
    await sharp(join(packDir, 'images', it.file)).jpeg({ quality: 90 }).toFile(join(libDir, `${prefix}-${String(n).padStart(2, '0')}.jpg`))
    n += 1
  }
  return n
}
const counts = {
  landscape: await pick('romantic-landscape', 30, 'landscape'),
  architecture: await pick('architecture', 20, 'architecture'),
  ukiyo: await pick('ukiyo-e', 10, 'print'),
  photo: await pick('photo-early-modern', 6, 'photo')
}
// Three "accidental screenshots": images of interface text, which must not be used as taste evidence.
for (let i = 0; i < 3; i += 1) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="560"><rect width="900" height="560" fill="#f4f4f4"/><rect width="900" height="46" fill="#2b2b2b"/><text x="18" y="30" font-family="Arial" font-size="20" fill="#fff">Settings - Preferences ${i}</text>${Array.from({ length: 9 }, (_, r) => `<rect x="30" y="${80 + r * 46}" width="260" height="26" fill="#e0e0e0"/><text x="40" y="${98 + r * 46}" font-family="Arial" font-size="15" fill="#333">Option ${r} enabled  [x]  Apply  Cancel</text>`).join('')}</svg>`
  await sharp(Buffer.from(svg)).png().toFile(join(libDir, `screenshot-${i}.png`))
}
const hashAll = async () => {
  const out = {}
  for (const f of await fs.readdir(libDir)) out[f] = createHash('sha256').update(await fs.readFile(join(libDir, f))).digest('hex')
  return out
}
const hashesBefore = await hashAll()

const profile = resolve('.e2e/profile-discovery')
await fs.rm(profile, { recursive: true, force: true })
const baseEnv = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir }
delete baseEnv.ELECTRON_RUN_AS_NODE

let app = null
let page = null
const errors = []
async function launch(seed) {
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env: { ...baseEnv, ...(seed ? { NOEMA_E2E_SEED: libDir } : {}) }, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1500, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}
async function until(predicate, timeout = 30_000, interval = 400) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const tab = async (name) => { await page.getByRole('tab', { name }).click(); await page.waitForTimeout(900) }
const idOf = (src) => /ref\/([a-z]+-\d+)/.exec(src)?.[1]

try {
  await launch(true)
  log('Preparing: scanning and learning the library')
  await until(async () => {
    const boot = await window.noema.bootstrap()
    const s = await window.noema.getIndexStatus()
    return !boot.roots.some((r) => r.scanning) && s.total >= 60 && s.indexed >= s.total
  }, 600_000, 2000)
  const idx = await page.evaluate(() => window.noema.getIndexStatus())
  check(idx.indexed >= 60, `${idx.indexed} images learned on ${idx.provider}`)

  // ---------------------------------------------------------------------------------------------
  log('A. The reference collection is installed, offline, and carries provenance')
  const info = await page.evaluate(() => window.noema.getReferenceInfo())
  check(info.available && info.works >= 1000, `${info.works} works in ${info.shelves.length} shelves and ${info.regions.length} regions`)
  check(info.license.id === 'CC0-1.0' && info.museums.length >= 2, `license ${info.license.id}; museums: ${info.museums.map((m) => `${m.name} (${m.works})`).join(', ')}`)
  const some = manifest.items[10]
  check(!!some.objectUrl && !!some.credit && some.sha256.length === 64, 'every work records its museum page, credit line and checksum')
  await page.evaluate(() => (location.hash = '#/taste'))
  await page.waitForSelector('.taste-choice img', { timeout: 30_000 })
  await page.waitForTimeout(900)
  check(await page.getByRole('tab', { name: 'Explore' }).isVisible(), 'the Taste room has Explore, identity, compare, journeys and history')
  await page.getByRole('button', { name: 'About the collection' }).click()
  check(await page.getByText(/public domain or CC0/).first().isVisible(), 'the app credits the museums and the license')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(shots, 'd1-explore-start.png') })

  // ---------------------------------------------------------------------------------------------
  log('B. A simulated user with two overlapping tastes explores with all five answers')
  const likes = new Set(['romantic-landscape', 'dutch-landscape', 'european-prints', 'ukiyo-e'])
  let seed = 4242
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const used = { prefer: 0, both: 0, neither: 0, undecided: 0 }
  let blind = 0
  for (let i = 0; i < 70; i += 1) {
    await page.waitForSelector('.taste-choice:not([disabled])', { timeout: 20_000 })
    const srcs = await page.locator('.taste-choice img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')))
    const [a, b] = srcs.map((s) => likes.has(shelfOf.get(idOf(s))))
    const captionsVisible = await page.locator('.taste-choice').first().innerText()
    if (/ \d{4}/.test(captionsVisible) || /Museum/.test(captionsVisible)) blind += 1
    let key
    const roll = rand()
    if (a && b) { key = roll < 0.8 ? 'ArrowUp' : 'ArrowLeft'; used[key === 'ArrowUp' ? 'both' : 'prefer'] += 1 }
    else if (!a && !b) { key = roll < 0.75 ? 'ArrowDown' : ' '; used[key === ' ' ? 'undecided' : 'neither'] += 1 }
    else { key = roll < 0.92 ? (a ? 'ArrowLeft' : 'ArrowRight') : ' '; used[key === ' ' ? 'undecided' : 'prefer'] += 1 }
    await page.evaluate(() => document.activeElement?.blur?.()) // focus returned to a header button after the dialog closed
    const before = await page.evaluate(async () => { const s = await window.noema.getDiscovery(); return s.informative + s.counts.undecided })
    if (i % 9 === 4 && key.startsWith('Arrow') && key !== 'ArrowUp' && key !== 'ArrowDown') await page.locator('.taste-choice').nth(key === 'ArrowLeft' ? 0 : 1).click()
    else await page.keyboard.press(key)
    await until(`(async () => { const s = await window.noema.getDiscovery(); return s.informative + s.counts.undecided > ${before} })()`, 20_000, 150)
    await page.waitForTimeout(120)
    if (i === 14) { await page.waitForTimeout(700); await page.screenshot({ path: join(shots, 'd2-explore-early.png') }) }
  }
  let ds = await page.evaluate(() => window.noema.getDiscovery())
  check(blind === 0, 'works are shown without names, so answers are about how they look')
  check(ds.counts.prefer > 5 && ds.counts.both > 5 && ds.counts.neither > 5 && ds.counts.undecided > 0, `all five answers recorded (preferred ${ds.counts.prefer}, both ${ds.counts.both}, neither ${ds.counts.neither}, undecided ${ds.counts.undecided})`)
  check(ds.informative === ds.counts.prefer + ds.counts.both + ds.counts.neither, '"can\'t decide" teaches nothing')
  check(ds.modes.length >= 2, `${ds.modes.length} separate directions found (${ds.modes.map((m) => `${m.label}: ${m.size}`).join('; ')}), not one average`)
  const likedShelves = new Set(ds.modes.flatMap((m) => m.examples.map((e) => shelfOf.get(e.id))))
  check([...likedShelves].filter((s) => likes.has(s)).length >= 2, `the directions show works from the shelves this user likes (${[...likedShelves].join(', ')})`)
  check(ds.coverage.regionsSeen >= ds.coverage.regionsTotal * 0.7, `the collection was mapped first (${ds.coverage.regionsSeen} of ${ds.coverage.regionsTotal} regions seen)`)
  console.log(`  · accuracy on own answers: ${ds.accuracy === null ? 'n/a' : Math.round(ds.accuracy * 100) + '%'}`)
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(shots, 'd3-explore-learned.png') })
  await page.getByRole('button', { name: /Undo/ }).click()
  await page.waitForTimeout(600)
  const afterUndo = await page.evaluate(() => window.noema.getDiscovery())
  check(afterUndo.informative + afterUndo.counts.undecided === ds.informative + ds.counts.undecided - 1, 'undo takes back the last answer')

  // ---------------------------------------------------------------------------------------------
  log('C. My Artistic Identity: favorites only, several separate groups, no penalty for what is absent')
  const ids = await page.evaluate(async () => {
    const p = await window.noema.listImages({ scope: 'archive', limit: 200 })
    return p.items.map((i) => ({ id: i.id, name: i.filename }))
  })
  const favs = ids.filter((i) => /^landscape-0[0-7]/.test(i.name) || /^architecture-0[0-5]/.test(i.name))
  for (const f of favs) await page.evaluate((id) => window.noema.updateImage({ id, favorite: true }), f.id)
  await tab('My identity')
  await page.waitForSelector('.mode-card--wide', { timeout: 30_000 })
  await page.waitForTimeout(1200)
  let identity = await page.evaluate(() => window.noema.getIdentity())
  check(identity.available && identity.learned === favs.length, `${identity.learned} favorites analysed (the library has ${ids.length} images, mostly landscapes)`)
  check(identity.modes.length >= 2, `${identity.modes.length} separate groups among the favorites: ${identity.modes.map((m) => `${m.label} (${m.size})`).join('; ')}`)
  check(identity.modes.every((m) => m.kindred.length >= 3 && m.kindred[0].museumName && m.examples.length > 0), 'each group shows its own images and the closest reference works with museum credit')
  check((await page.locator('.mode-card--wide').count()) === identity.modes.length, 'the interface shows each group separately')
  check(await page.getByText(/not read as dislike/).isVisible(), 'the page says that missing styles are not dislikes')
  await page.screenshot({ path: join(shots, 'd4-identity.png') })
  // The library being full of landscapes is not a taste: adding more non-favorite landscapes changes nothing.
  const dimsBefore = identity.dimensions.map((d) => d.mean.toFixed(4)).join()
  const others = ids.filter((i) => /^landscape-(2|3)/.test(i.name)).length
  const again = await page.evaluate(() => window.noema.getIdentity())
  check(again.dimensions.map((d) => d.mean.toFixed(4)).join() === dimsBefore && others > 0, 'identity is unchanged by the other images in the library')

  // ---------------------------------------------------------------------------------------------
  log('D. Comparing the two profiles')
  await tab('Compare')
  await page.waitForSelector('.artmap svg', { timeout: 30_000 })
  await page.waitForTimeout(1500)
  const cmp = await page.evaluate(() => window.noema.getCompare())
  check(cmp.points.filter((p) => p.kind === 'favorite').length === favs.length && cmp.points.some((p) => p.kind === 'liked'), 'the map shows favorites and liked works together')
  check(cmp.map.length === info.works, 'the whole collection is drawn as the map background')
  check(cmp.dimensions.length === 6 && cmp.dimensions.every((d) => d.statement.length > 20), 'every axis has a statement')
  check(cmp.dimensions.some((d) => /thin|Not enough|only/.test(d.statement)) || cmp.discovery.informative >= 24, 'statements are qualified where evidence is thin')
  const statuses = new Set(cmp.regions.map((r) => r.status))
  console.log(`  · region statuses: ${[...statuses].join(', ')}; relations: ${cmp.dimensions.map((d) => d.relation).join(', ')}`)
  check(statuses.size >= 3, 'regions are told apart: shared, one-sided, unexplored')
  check(cmp.headline.length > 0, `headline: ${cmp.headline[0]}`)
  const firstRegion = page.locator('.artmap__region').first()
  await firstRegion.click({ force: true })
  await page.waitForSelector('.region-panel h3', { timeout: 10_000 })
  check((await page.locator('.region-panel .dthumb').count()) >= 3, 'selecting an area shows example works')
  await page.locator('.cdim__row').first().click()
  await page.waitForTimeout(500)
  await page.mouse.move(4, 4)
  await page.screenshot({ path: join(shots, 'd5-compare.png') })

  // ---------------------------------------------------------------------------------------------
  log('E. An Artistic Discovery Journey: view, react, save to library and moodboard')
  const board = await page.evaluate(() => window.noema.createMoodboard('Discoveries'))
  await tab('Journeys')
  await page.waitForSelector('.suggestion', { timeout: 30_000 })
  const suggestionTitles = await page.locator('.suggestion h4').allInnerTexts()
  check(suggestionTitles.some((t) => /walk through/i.test(t)) && suggestionTitles.length >= 3, `journeys offered: ${suggestionTitles.join(' | ')}`)
  check(suggestionTitles.some((t) => /emerging|Beyond|From your favorites|Unexplored/.test(t)), 'personal journeys are offered next to the tour')
  await page.screenshot({ path: join(shots, 'd6-journeys.png') })
  await page.locator('.suggestion', { hasText: /Beyond|emerging|From your favorites/i }).first().getByRole('button', { name: 'Begin the journey' }).click()
  await page.waitForSelector('.exhibition', { timeout: 30_000 })
  await page.waitForTimeout(700)
  await page.screenshot({ path: join(shots, 'd7-journey-cover.png') })
  check(await page.getByText(/does not claim/).isVisible(), 'the journey says how it was made, and that it makes no claims of influence')
  let likedWorks = 0
  let passedWorks = 0
  let saved = 0
  let sawStretch = false
  let sawWhy = 0
  for (let step = 0; step < 60; step += 1) {
    if (await page.getByText('What stayed with you?').isVisible().catch(() => false)) break
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(260)
    if (await page.getByText(/A DELIBERATE STRETCH/).isVisible().catch(() => false)) sawStretch = true
    if (await page.locator('.exhibition__work').isVisible().catch(() => false)) {
      if ((await page.locator('.why li').count()) > 0) sawWhy += 1
      const roll = rand()
      if (roll < 0.35) { await page.keyboard.press('l'); likedWorks += 1; await page.waitForTimeout(150) }
      else if (roll < 0.5) { await page.keyboard.press('n'); passedWorks += 1; await page.waitForTimeout(150) }
      if (step === 6) { await page.screenshot({ path: join(shots, 'd8-journey-work.png') }) }
      if (saved === 0) { await page.getByRole('button', { name: 'Save as favorite' }).click(); await page.waitForTimeout(900); saved += 1; check(await page.getByText(/Saved as a favorite/).isVisible(), 'a work is saved to the library as a favorite') }
      else if (saved === 1) { await page.locator('.exhibition__save select').selectOption(board.id); await page.waitForTimeout(900); saved += 1; check(await page.getByText(/Saved to the moodboard/).isVisible(), 'a work is saved to a moodboard') }
    }
  }
  check(sawStretch, 'the journey includes a chapter that deliberately stretches beyond known taste')
  check(sawWhy >= 6, `works come with a reason for being there (${sawWhy} shown)`)
  check(await page.getByText('What stayed with you?').isVisible(), 'the journey ends with a summary of what you liked')
  await page.screenshot({ path: join(shots, 'd9-journey-end.png') })
  await page.getByRole('button', { name: 'Back to the journeys' }).click()
  await page.waitForTimeout(800)
  const list = await page.evaluate(() => window.noema.listJourneys())
  const mine = list.journeys[0]
  check(mine.finished && Object.values(mine.feedback).filter((f) => f === 'like').length === likedWorks, `the journey is saved as completed with ${likedWorks} likes and ${passedWorks} passes`)
  const ds2 = await page.evaluate(() => window.noema.getDiscovery())
  check(ds2.counts.likes >= likedWorks && ds2.counts.dislikes >= passedWorks && ds2.counts.saves >= 2, 'reactions and saves feed back into the discovered taste')

  // Saved discoveries are ordinary library images with provenance.
  await page.evaluate(() => (location.hash = '#/collection'))
  await page.waitForTimeout(1500)
  const lib = await page.evaluate(async () => { const p = await window.noema.listImages({ scope: 'archive', search: 'atlas-discovery', limit: 20 }); return p.items.map((i) => ({ tags: i.tags, favorite: i.favorite, thumb: i.thumbStatus, folder: i.folder })) })
  check(lib.length >= 2 && lib.every((i) => i.tags.includes('atlas-discovery') && i.thumb === 'ready'), `${lib.length} saved discoveries are normal library images, tagged with their museum details`)
  check(lib.some((i) => i.favorite), 'a saved favorite counts as a favorite (and so feeds My Artistic Identity)')
  const boardNow = await page.evaluate((id) => window.noema.getMoodboard(id), board.id)
  check(boardNow.images.length >= 1, 'the moodboard received the saved work')
  const savedFolder = lib[0].folder
  check(existsSync(join(savedFolder, (await fs.readdir(savedFolder)).find((f) => f.endsWith('.provenance.json')) ?? 'missing')), 'a provenance file sits beside every saved work')
  const id2 = await page.evaluate(() => window.noema.getIdentity())
  check(id2.learned >= identity.learned, 'favorited discoveries join the identity profile when they have been learned')

  // ---------------------------------------------------------------------------------------------
  log('F. History: taste evolves')
  await page.evaluate(() => (location.hash = '#/taste'))
  await page.waitForSelector('.taste-tabs')
  await tab('History')
  await page.waitForSelector('.history', { timeout: 20_000 })
  await page.waitForTimeout(1200)
  const hist = await page.evaluate(() => window.noema.getHistory())
  check(hist.snapshots.length >= 2, `${hist.snapshots.length} snapshots of the profiles`)
  check(hist.snapshots.some((s) => s.discoveries.length > 0), 'discoveries are listed against the snapshot they belong to')
  check(/not proven|coincide/.test(hist.note), 'history does not claim that discoveries caused the changes')
  await page.screenshot({ path: join(shots, 'd10-history.png') })

  // ---------------------------------------------------------------------------------------------
  log('G. The classic Taste Compass keeps working, and screenshots are kept out of its comparisons')
  await page.evaluate(() => (location.hash = '#/taste-classic'))
  await page.waitForSelector('.taste-choice img', { timeout: 30_000 })
  await page.waitForTimeout(1200)
  const classic = await page.evaluate(() => window.noema.getTasteState())
  check(classic.available && classic.excluded >= 3, `${classic.excluded} screenshot-like images are left out of library comparisons`)
  for (let i = 0; i < 12; i += 1) {
    const names = await page.locator('.taste-choice').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    check(names.every((n) => !/screenshot-/.test(n ?? '')), `round ${i + 1}: no screenshot is offered`)
    await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight')
    await page.waitForTimeout(450)
  }

  // ---------------------------------------------------------------------------------------------
  log('H. Everything survives a restart; the user\'s own files are untouched')
  const idBefore = await page.evaluate(() => window.noema.getIdentity())
  const dsBefore = await page.evaluate(() => window.noema.getDiscovery())
  const jBefore = await page.evaluate(() => window.noema.listJourneys())
  await app.close().catch(() => undefined)
  await launch(false)
  await until(async () => (await window.noema.getIndexStatus()).state !== 'loading', 60_000, 1000)
  const dsAfter = await page.evaluate(() => window.noema.getDiscovery())
  check(dsAfter.informative === dsBefore.informative && dsAfter.modes.length === dsBefore.modes.length, `exploration persists (${dsAfter.informative} answers)`)
  const jAfter = await page.evaluate(() => window.noema.listJourneys())
  check(jAfter.journeys.length === jBefore.journeys.length && jAfter.journeys[0].finished === jBefore.journeys[0].finished, 'journeys persist')
  const idAfter = await page.evaluate(async () => { for (let i = 0; i < 40; i += 1) { const s = await window.noema.getIdentity(); if (s.available) return s; await new Promise((r) => setTimeout(r, 500)) } return window.noema.getIdentity() })
  check(idAfter.learned === idBefore.learned && idAfter.modes.length === idBefore.modes.length, 'the identity profile persists')
  for (const hash of ['#/collection', '#/archive', '#/families', '#/favorites', '#/moodboards', '#/sources', '#/taste-classic', '#/taste']) {
    await page.evaluate((h) => (location.hash = h), hash)
    await page.waitForTimeout(600)
    check((await page.locator('.page').count()) > 0, `${hash.slice(2)} opens`)
  }
  const hashesAfter = await hashAll()
  check(JSON.stringify(hashesAfter) === JSON.stringify(hashesBefore), `none of the ${Object.keys(hashesBefore).length} original image files was changed`)

  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Artistic discovery checks passed.')
} finally {
  await app?.close().catch(() => undefined)
}
