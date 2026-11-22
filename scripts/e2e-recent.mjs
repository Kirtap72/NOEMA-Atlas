// Recently added, in the real application: three imports of different sizes at different times. Choosing a batch must show exactly that
// batch's pictures (by id), with the counts above the grid matching, whatever the file dates are, and with search, rating and sort still
// working on top of it; a file that disappears is left out; a thumbnail opens the right picture.
//
//   node scripts/e2e-recent.mjs --exe "release/win-unpacked/NOEMA Atlas.exe"
import { promises as fs, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const work = resolve('.e2e/recent')
const profile = join(work, 'profile')
const shots = resolve('.e2e/screenshots-recent')
await fs.rm(work, { recursive: true, force: true })
await fs.mkdir(shots, { recursive: true })
await fs.mkdir(profile, { recursive: true })
const log = (m) => console.log(`\n◆ ${m}`)
const check = (c, m) => {
  if (!c) throw new Error(`FAILED: ${m}`)
  console.log(`  ✓ ${m}`)
}

// Three folders = three imports: 7, 4 and 1 pictures. The file dates are deliberately the reverse of the import order.
const batches = [
  { name: 'first-import', count: 7, daysAgo: 3, fileYear: 2026 },
  { name: 'second-import', count: 4, daysAgo: 2, fileYear: 2020 },
  { name: 'third-import', count: 1, daysAgo: 0, fileYear: 2010 }
]
for (const b of batches) {
  b.dir = join(work, b.name)
  await fs.mkdir(b.dir, { recursive: true })
  for (let i = 0; i < b.count; i += 1) {
    const file = join(b.dir, `${b.name}-${i}.png`)
    await sharp({ create: { width: 64 + i * 4, height: 48, channels: 3, background: { r: 40 + i * 20, g: 90 + b.count * 10, b: 150 } } }).png().toFile(file)
    const t = new Date(b.fileYear, 5, 1 + i)
    await fs.utimes(file, t, t)
  }
}
const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile }
delete env.ELECTRON_RUN_AS_NODE
let app
let page
const errors = []
async function launch() {
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1440, height: 1000 })
  page.setDefaultTimeout(60_000)
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}
const visibleIds = () => page.locator('.image-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-image-id')))
const waitForGrid = async (n) => {
  await page.waitForFunction((count) => document.querySelectorAll('.image-card').length === count, n, { timeout: 30_000 })
  await page.waitForTimeout(500)
}
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x))

try {
  log('Three imports, one after another')
  await launch()
  for (const b of batches) {
    await page.evaluate((p) => window.noema.addFolders([p]), b.dir)
    await page.waitForFunction(async (n) => { const s = await window.noema.bootstrap(); return !s.roots.some((r) => r.scanning) && s.stats.images >= n }, batches.slice(0, batches.indexOf(b) + 1).reduce((n, x) => n + x.count, 0), { timeout: 120_000 })
    await page.waitForTimeout(1200)
  }
  await app.close()

  // Spread the indexing times apart (as real imports on different days would be); the files keep their own dates.
  const db = new DatabaseSync(join(profile, 'library.db'))
  const now = Date.now()
  for (const b of batches) {
    const rootRow = db.prepare('SELECT id FROM roots WHERE path LIKE ?').get(`%${b.name}`)
    const rows = db.prepare('SELECT id FROM images WHERE root_id = ? ORDER BY path').all(rootRow.id)
    rows.forEach((r, i) => db.prepare('UPDATE images SET added_at = ? WHERE id = ?').run(now - b.daysAgo * 86_400_000 - (rows.length - i) * 1000, r.id))
    b.rootId = rootRow.id
  }
  db.close()

  await launch()
  const expected = {}
  for (const b of batches) expected[b.name] = (await page.evaluate((id) => window.noema.listImages({ scope: 'collection', rootId: id, limit: 100 }), b.rootId)).items.map((i) => i.id)
  const everyId = Object.values(expected).flat()
  check(everyId.length === 12, `the library holds 12 pictures in three imports (${batches.map((b) => b.count).join(' + ')})`)

  log('Everything recent: all pictures, newest indexed first')
  await page.evaluate(() => { location.hash = '#/recent' })
  await page.locator('[data-testid="recent-batches"]').waitFor()
  await waitForGrid(12)
  const all = await visibleIds()
  check(sameSet(all, everyId), 'the grid holds all 12 pictures')
  const addedAt = await page.evaluate(async () => (await window.noema.listImages({ scope: 'collection', sort: 'recent', limit: 100 })).items.map((i) => [i.id, i.addedAt]))
  if (JSON.stringify(all) !== JSON.stringify(addedAt.map(([id]) => id))) console.log('grid', JSON.stringify(all.map((id) => addedAt.findIndex(([x]) => x === id))), 'sort select:', await page.locator('select[aria-label="Sort images"]').inputValue())
  check(JSON.stringify(all) === JSON.stringify(addedAt.map(([id]) => id)), 'in the order Atlas indexed them, newest first (not the files’ own dates)')
  check(all[0] === expected['third-import'][0], 'the newest import comes first, although its file is the oldest')
  const header = async () => (await page.locator('.page-title__count').first().innerText()).replace(/\s+/g, ' ')
  check(/\b12\b/.test(await header()), 'the count above the grid says 12')

  log('Each import shows exactly its own pictures')
  const chips = page.locator('[data-testid="recent-latest"], [data-testid="recent-batch"]')
  check((await chips.count()) === 3, 'three imports are listed')
  const order = ['third-import', 'second-import', 'first-import'] // newest first
  for (let i = 0; i < 3; i += 1) {
    const name = order[i]
    await chips.nth(i).click()
    await waitForGrid(expected[name].length)
    const ids = await visibleIds()
    check(sameSet(ids, expected[name]), `${name}: the grid holds exactly its ${expected[name].length} picture${expected[name].length === 1 ? '' : 's'}, none of the other ${12 - expected[name].length}`)
    check(new RegExp(`\\b${expected[name].length}\\b`).test(await header()), `${name}: the count above the grid says ${expected[name].length}`)
    const total = await page.evaluate(async ([from, to]) => (await window.noema.listImages({ scope: 'collection', addedFrom: from, addedTo: to, limit: 1 })).total, [0, 1e15])
    void total
  }
  await shot('recent-third.png')

  log('Switching back and forth, and “Everything recent” again')
  await chips.nth(1).click()
  await waitForGrid(4)
  check(sameSet(await visibleIds(), expected['second-import']), 'second-import again: its 4 pictures')
  await page.locator('[data-testid="recent-all"]').click()
  await waitForGrid(12)
  check(sameSet(await visibleIds(), everyId), 'Everything recent: all 12 again')
  await chips.nth(2).click()
  await waitForGrid(7)
  check(sameSet(await visibleIds(), expected['first-import']), 'first-import: its 7 pictures')

  log('Search, rating, sort and the other filters work inside a batch')
  const firstIds = expected['first-import']
  await page.evaluate((id) => window.noema.updateImage({ id, rating: 5 }), firstIds[2])
  const idOf = async (file) => page.evaluate(async ([ids, name]) => (await Promise.all(ids.map((id) => window.noema.getImage(id)))).find((i) => i.filename === name).id, [firstIds, file])
  await page.locator('input[aria-label="Search images"]').first().fill('first-import-3')
  await waitForGrid(1)
  check(sameSet(await visibleIds(), [await idOf('first-import-3.png')]), 'a search inside the batch finds that picture')
  await page.locator('input[aria-label="Search images"]').first().fill('second-import-1')
  await page.waitForTimeout(900)
  check((await visibleIds()).length === 0, 'a search for a picture of another import finds nothing inside this batch')
  await page.locator('input[aria-label="Search images"]').first().fill('')
  await waitForGrid(7)
  await page.locator('select[aria-label="Sort images"]').selectOption('name')
  await page.waitForTimeout(900)
  const byName = await page.evaluate(async (ids) => (await Promise.all(ids.map((id) => window.noema.getImage(id)))).map((i) => i.filename), await visibleIds())
  check(JSON.stringify(byName) === JSON.stringify([...byName].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) && byName.length === 7, 'sorted by name inside the batch (still 7)')
  await page.locator('select[aria-label="Sort images"]').selectOption('recent')
  await waitForGrid(7)
  await page.locator('select[aria-label="Minimum star rating"]').selectOption('5')
  await waitForGrid(1)
  check(sameSet(await visibleIds(), [firstIds[2]]), 'a rating filter inside the batch shows only its 5-star picture')
  await page.locator('select[aria-label="Minimum star rating"]').selectOption('0')
  await waitForGrid(7)
  await page.evaluate(() => { location.hash = '#/recent' })

  log('A picture that disappeared is left out, and the counts follow')
  await page.locator('[data-testid="recent-batches"]').waitFor()
  await page.locator('[data-testid="recent-batch"]').last().click()
  const victim = (await page.evaluate((ids) => Promise.all(ids.map((id) => window.noema.getImage(id))), expected['second-import']))[0]
  await fs.rm(victim.path)
  await page.evaluate((id) => window.noema.rescanRoot(id), batches[1].rootId)
  await page.waitForFunction(async () => !(await window.noema.bootstrap()).roots.some((r) => r.scanning), null, { timeout: 60_000 })
  await page.waitForTimeout(1500)
  await page.evaluate(() => { location.hash = '#/collection' })
  await page.waitForTimeout(500)
  await page.evaluate(() => { location.hash = '#/recent' })
  await page.locator('[data-testid="recent-batches"]').waitFor()
  await page.locator('[data-testid="recent-batch"]').first().click()
  await waitForGrid(3)
  const remaining = await visibleIds()
  check(sameSet(remaining, expected['second-import'].filter((id) => id !== victim.id)), 'the missing file is not shown; its 3 remaining pictures are')
  check(/\b3\b/.test(await header()), 'the count above the grid says 3')
  await page.locator('[data-testid="recent-all"]').click()
  await waitForGrid(11)
  check(!(await visibleIds()).includes(victim.id), 'Everything recent leaves it out too (11 pictures)')

  log('Clicking a thumbnail opens that picture')
  await page.locator('[data-testid="recent-latest"]').click()
  await waitForGrid(1)
  await page.locator('.image-card__open').first().click()
  await page.locator('.lightbox').waitFor()
  const opened = await page.locator('.lightbox').getAttribute('aria-label')
  check(/third-import-0\.png/.test(opened ?? ''), `the viewer shows the clicked picture (${opened})`)
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="recent-batch"]').nth(1).click()
  await waitForGrid(7)
  const second = await page.evaluate(async (id) => (await window.noema.getImage(id)).filename, (await visibleIds())[3])
  await page.locator('.image-card__open').nth(3).click()
  await page.locator('.lightbox').waitFor()
  check(new RegExp(second.replace('.', '\\.')).test((await page.locator('.lightbox').getAttribute('aria-label')) ?? ''), `the fourth thumbnail of a batch opens the fourth picture (${second})`)
  await page.keyboard.press('Escape')

  check(errors.filter((e) => !/Autofill|DevTools/.test(e)).length === 0, 'no errors in the interface')
  console.log('\nALL CHECKS PASSED')
} finally {
  await app?.close().catch(() => undefined)
}

async function shot(name) {
  await page.screenshot({ path: join(shots, name), animations: 'disabled' })
}
void existsSync
