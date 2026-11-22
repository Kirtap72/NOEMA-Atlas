// End-to-end check of the Smart Organizer and of looking at pictures, in the real application with the real local image model.
//
//   node scripts/e2e-organizer.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// A library with finished artworks, real camera photographs (EXIF), screenshots, an exact copy and an upscaled version is
// organized through the interface and through the companion; the approved structure is copied to a folder that already holds a
// file with a clashing name. Originals are hashed before and after. A model "on this computer" and one "not on this computer"
// (the same mock server on 127.0.0.2, which Atlas treats as leaving the computer) show what is attached and what needs consent.
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const packaged = Boolean(exeArg)
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-organizer')
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
const shelf = (name) => manifest.items.filter((i) => i.shelf === name)
const src = (item) => join(packDir, 'images', item.file)

// ---- the library ----------------------------------------------------------------------------------------------------------
const libDir = resolve('.e2e/organizer-library')
const outDir = resolve('.e2e/organizer-out')
const profile = resolve('.e2e/organizer-profile')
await fs.rm(libDir, { recursive: true, force: true })
await fs.rm(outDir, { recursive: true, force: true })
await fs.rm(profile, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
await fs.mkdir(outDir, { recursive: true })

const art = [...shelf('romantic-landscape').slice(0, 14), ...shelf('ukiyo-e').slice(0, 8)]
for (const [i, it] of art.entries()) await sharp(src(it)).jpeg({ quality: 90 }).toFile(join(libDir, `${it.shelf === 'ukiyo-e' ? 'print' : 'landscape'} ${String(i).padStart(2, '0')}.jpg`))
// Real camera photographs: JPEG with EXIF camera data.
const photos = shelf('photo-documentary').slice(0, 8)
for (const [i, it] of photos.entries()) await sharp(src(it)).jpeg({ quality: 90 }).withExif({ IFD0: { Make: 'Canon', Model: 'Canon EOS 30D' } }).toFile(join(libDir, `IMG_${String(3000 + i)}.jpg`))
// Screenshots of working software: a dark window with panels and text.
for (let i = 0; i < 4; i += 1) {
  const rows = Array.from({ length: 14 }, (_, r) => `<rect x="30" y="${90 + r * 40}" width="${300 + ((r * 97 + i * 31) % 500)}" height="14" rx="4" fill="#6b6b6b"/><text x="900" y="${102 + r * 40}" font-size="15" fill="#aaa">value ${r * 7 + i}</text>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" font-family="Segoe UI, Arial"><rect width="1600" height="900" fill="#262626"/><rect width="1600" height="40" fill="#1a1a1a"/><text x="14" y="26" font-size="16" fill="#ccc">File  Edit  Render  Window  Help        Properties  Output  Modifiers</text>${rows}<rect x="1100" y="60" width="480" height="800" fill="#202020"/><text x="1120" y="90" font-size="16" fill="#ccc">Settings ${i}</text></svg>`
  await sharp(Buffer.from(svg)).png().toFile(join(libDir, `Screenshot 2026-01-0${i + 1} 101010.png`))
}
// An exact copy and an upscaled version of one picture.
await fs.copyFile(join(libDir, 'landscape 00.jpg'), join(libDir, 'landscape 00 - Copy.jpg'))
const first = sharp(join(libDir, 'landscape 01.jpg'))
const firstMeta = await first.metadata()
await sharp(join(libDir, 'landscape 01.jpg')).resize(Math.round(firstMeta.width * 1.5)).jpeg({ quality: 92 }).toFile(join(libDir, 'landscape 01_upscaled.jpg'))
const hashAll = async (dir) => {
  const out = {}
  for (const f of await fs.readdir(dir, { recursive: true })) {
    const full = join(dir, f)
    if ((await fs.stat(full)).isFile()) out[f] = createHash('sha256').update(await fs.readFile(full)).digest('hex')
  }
  return out
}
const hashesBefore = await hashAll(libDir)
const libraryFiles = Object.keys(hashesBefore).length
// A file already at the destination whose name a copied picture will want.
await fs.mkdir(join(outDir, 'Finished artwork'), { recursive: true })
await fs.writeFile(join(outDir, 'precious.txt'), 'must survive')

// ---- a mock language model, reachable at 127.0.0.1 (on this computer) and 127.0.0.2 (counts as not on this computer) -----------
const requests = []
const imagePartsOf = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : [])
const textOf = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '')
const call = (id, name, a) => ({ choices: [{ message: { content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(a) } }] } }] })
const say = (text) => ({ choices: [{ message: { content: text } }] })
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {}
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-vlm' }] }))
    requests.push({ url: req.url, host: req.headers.host, json })
    const messages = json.messages ?? []
    const last = messages[messages.length - 1]
    if (json.tools?.some((t) => t.function?.name === 'atlas_check')) return res.end(JSON.stringify(last?.role === 'tool' ? say('Hello! Ready.') : call('c1', 'atlas_check', { word: 'ready' })))
    const userTexts = messages.filter((m) => m.role === 'user' && typeof m.content === 'string')
    const ask = (userTexts.at(-1)?.content ?? '').toLowerCase()
    const afterAsk = messages.slice(messages.lastIndexOf(userTexts.at(-1)) + 1)
    const toolResults = afterAsk.filter((m) => m.role === 'tool')
    const step = toolResults.length
    const lastTool = (() => { try { return JSON.parse(toolResults.at(-1)?.content ?? '{}') } catch { return {} } })()
    const seenImages = afterAsk.flatMap(imagePartsOf).length
    if (/rename|layout/.test(ask)) {
      if (step === 0) return res.end(JSON.stringify(call('o1', 'organize_overview', {})))
      if (step === 1) return res.end(JSON.stringify(call('o2', 'organize_refine', { operations: [{ op: 'structure', value: 'kind' }, { op: 'exclude', kind: 'technical' }] })))
      return res.end(JSON.stringify(say('[library] Done: the folders are arranged by kind only, and the screenshots are left out. Nothing was copied.')))
    }
    if (/export|copy/.test(ask)) {
      if (step === 0) return res.end(JSON.stringify(call('x1', 'organize_export', {})))
      return res.end(JSON.stringify(say('[library] I put a request on screen. You choose the destination folder there.')))
    }
    if (/look|compare/.test(ask)) {
      if (step === 0) return res.end(JSON.stringify(call('l0', 'search_images', { query: 'landscape', limit: 3 })))
      if (step === 1) {
        const refs = (lastTool.images ?? []).map((i) => i.ref).slice(0, 3)
        return res.end(JSON.stringify(call('l1', 'look_at_images', { refs, question: 'Which details could be improved?' })))
      }
      if (seenImages > 0) return res.end(JSON.stringify(say(`[seen] I can see ${seenImages} picture${seenImages === 1 ? '' : 's'}; the sky is the weakest part.\n\n[library] Your notes call them calm landscapes.`)))
      return res.end(JSON.stringify(say('I will look at them once you agree.')))
    }
    return res.end(JSON.stringify(say('[library] Fine.')))
  })
})
await new Promise((r) => mock.listen(0, '0.0.0.0', r))
const mockPort = mock.address().port

// ---- the app ----------------------------------------------------------------------------------------------------------------
let app
let page
const errors = []
async function launch(seed) {
  const env = { ...process.env, NOEMA_E2E: '1', NOEMA_E2E_AI: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir, NOEMA_E2E_DESTINATION: outDir }
  delete env.ELECTRON_RUN_AS_NODE
  if (seed) env.NOEMA_E2E_SEED = libDir
  app = await electron.launch({ executablePath: exe, args: packaged ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1440, height: 1000 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}
async function until(predicate, arg, timeout = 90_000, interval = 400) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate, arg)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const shot = (name) => page.screenshot({ path: join(shots, name), animations: 'disabled' })
const lastReply = () => page.locator('.chat-msg--atlas').last()
async function ask(text) {
  const box = page.locator('.companion__form textarea')
  await box.fill(text)
  await box.press('Enter')
  await page.locator('.chat-thinking').waitFor({ state: 'detached', timeout: 120_000 }).catch(() => undefined)
  await page.waitForTimeout(500)
}
const settle = async () => {
  await until(() => window.noema.getIndexStatus().then((s) => s.total > 0 && s.indexed >= s.total), undefined, 300_000, 1000)
}

try {
  log('A. The library is seeded and read by the image model')
  await launch(true)
  await until((n) => window.noema.bootstrap().then((s) => s.stats.images >= n), libraryFiles, 120_000)
  await page.evaluate(() => window.noema.setAiEnabled(true))
  await settle()
  check(true, `${libraryFiles} pictures are indexed and embedded`)

  log('B. Asking the companion (no language model yet) starts the analysis; nothing is copied or moved')
  await page.keyboard.press('Control+j')
  await page.locator('.companion').waitFor()
  await ask('Please organize my pictures into folders')
  check(/Nothing is copied or moved/.test(await lastReply().innerText()), 'it says nothing is copied or moved')
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.evaluate(() => { window.location.hash = '#/organizer' })
  await page.locator('[data-testid="organizer-page"]').waitFor()
  await page.locator('.org-plan').first().waitFor({ timeout: 30_000 })
  await page.locator('.org-plan').first().click()
  await page.locator('[data-testid="org-status"][data-status="ready"]').waitFor({ timeout: 180_000 })
  await shot('50-organizer-review.png')
  const planId = (await page.evaluate(() => window.noema.organizerPlans()))[0].id
  const ov = await page.evaluate((id) => window.noema.organizerOverview(id), planId)
  const kinds = Object.fromEntries(ov.kinds.map((k) => [k.kind, k.count]))
  console.log('    kinds found:', JSON.stringify(kinds), 'copies/versions:', JSON.stringify({ groups: ov.duplicates.groups, exact: ov.duplicates.exact, near: ov.duplicates.near, versions: ov.duplicates.versions }))
  check(kinds.photograph === photos.length, `the ${photos.length} pictures with camera data are photographs (${kinds.photograph})`)
  check(kinds.technical >= 3, `screenshots are recognised as technical images (${kinds.technical} of 4)`)
  check((kinds.artwork ?? 0) >= 14, `finished artwork is found (${kinds.artwork})`)
  check(ov.duplicates.exact >= 1, `the exact copy is found (${ov.duplicates.exact})`)
  check(ov.duplicates.groups >= 2, `the upscaled version is grouped with its original (${ov.duplicates.groups} groups)`)
  check(ov.duplicates.sample.some((g) => g.memberIds.length >= 2 && g.why.length > 0), 'a best version is suggested with a reason')
  check(await page.locator('[data-testid="org-kind-photograph"]').isVisible(), 'the page shows the kinds with their folders')
  check((await page.locator('.org-cat').count()) >= 3, 'proposed folders have names and counts')

  log('C. Refining on the page: structure, leaving a kind out, renaming a folder')
  await page.locator('[data-testid="org-settings"] select').first().selectOption('kind-subject')
  const technical = page.locator('[data-testid="org-kind-technical"]')
  await technical.getByRole('button', { name: 'Leave out' }).click()
  await until(([id]) => window.noema.organizerPlan(id).then((p) => p.settings.excludeKinds.includes('technical')), [planId])
  check(true, 'leaving out the screenshots is kept in the plan')
  const artCard = page.locator('[data-testid="org-kind-artwork"]')
  const firstCat = (await artCard.locator('.org-cat__copy strong').first().innerText()).trim()
  await artCard.locator('.org-cat').first().getByRole('button', { name: 'Rename' }).click()
  await page.getByRole('dialog').locator('input').fill('Quiet places')
  await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click()
  await page.locator('.org-cat__copy strong', { hasText: 'Quiet places' }).first().waitFor({ timeout: 15_000 })
  check(true, `“${firstCat}” was renamed to “Quiet places”`)

  log('D. Talking to the companion with a model on this computer: refine and offer the export')
  await page.locator('[data-testid="org-back"]').click()
  await page.evaluate((port) => window.noema.assistantUpdateSettings({ provider: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-vlm' }), mockPort)
  await page.evaluate(() => window.noema.assistantTest())
  await page.locator('.org-plan').first().click()
  if (!(await page.locator('.companion').isVisible())) await page.keyboard.press('Control+j')
  await page.locator('button[aria-label="New conversation"]').click().catch(() => undefined)
  await ask('Please change the layout and leave out the screenshots')
  const settings1 = await page.evaluate((id) => window.noema.organizerPlan(id), planId)
  check(settings1.settings.structure === 'kind', `the companion changed the layout through its tools (${settings1.settings.structure})`)
  check(/Nothing was copied/.test(await lastReply().innerText()), 'and says nothing was copied')
  check((await hashAll(outDir))['precious.txt'] !== undefined && Object.keys(await hashAll(outDir)).length === 1, 'nothing has been written to the destination yet')
  await ask('Please export it')
  await page.locator('.proposal--pending').last().waitFor({ timeout: 30_000 })
  check(/choose the destination/i.test(await page.locator('.proposal--pending').last().innerText()) || /destination/i.test(await page.locator('.proposal--pending').last().innerText()), 'the export is a request; the user chooses the destination')
  check(Object.keys(await hashAll(outDir)).length === 1, 'asking for an export copied nothing')
  await shot('51-organizer-companion-export.png')
  await page.locator('[data-testid="proposal-accept"]').last().click()
  await page.locator('[data-testid="org-export"]').waitFor({ timeout: 30_000 })
  check(true, 'accepting opens the Organizer at its export step')
  await page.evaluate(() => window.noema.organizerPlan)
  await page.locator('[data-testid="org-structure"]').count()
  await page.locator('[data-testid="org-settings"] select').first().selectOption('kind-subject')
  await until(([id]) => window.noema.organizerPlan(id).then((p) => p.settings.structure === 'kind-subject'), [planId])

  log('E. The copy: the whole operation is shown first, conflicts are renamed, nothing is overwritten')
  await page.locator('[data-testid="org-choose"]').click()
  await page.locator('[data-testid="org-preview"]').waitFor({ timeout: 60_000 })
  check(await page.locator('[data-testid="org-copy"]').isDisabled() && /Nothing is selected/.test(await page.locator('[data-testid="org-preview"]').innerText()), 'with nothing checked, Copy is disabled and the preview says nothing is selected')
  await page.locator('[data-testid="org-check-all"]').click()
  await page.waitForFunction(() => /files to copy/.test(document.querySelector('[data-testid="org-preview"]')?.textContent ?? '') && !document.querySelector('[data-testid="org-copy"]')?.disabled, null, { timeout: 30_000 })
  check(true, 'after “Check all” the copy is enabled')
  const previewText = await page.locator('[data-testid="org-preview"]').innerText()
  console.log('    ' + previewText.split('\n').slice(0, 6).join(' | '))
  check(/files to copy/.test(previewText) && /Free space/.test(previewText), 'the preview shows how many files, how many bytes and the free space')
  check(/No name conflicts|name conflicts/.test(previewText), 'conflicts are reported')
  await shot('52-organizer-preview.png')
  const preview = await page.evaluate(([id, dest]) => window.noema.organizerPreview(id, dest, 0), [planId, outDir])
  // The destination holds nothing that clashes yet. Put a file where a copied picture wants to go, then look again.
  const wanted = preview.sample.find((o) => o.action === 'copy')
  await fs.mkdir(join(outDir, wanted.to, '..'), { recursive: true })
  await fs.writeFile(join(outDir, wanted.to), 'another file with the same name')
  await page.locator('[data-testid="org-choose"]').click()
  await page.waitForFunction(() => /name conflicts/.test(document.querySelector('[data-testid="org-preview"]')?.textContent ?? ''), null, { timeout: 30_000 })
  check(true, 'a file already at the destination is reported as a conflict')
  await page.locator('[data-testid="org-copy"]').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Copy', exact: true }).click()
  await page.locator('[data-testid="org-report"]').waitFor({ timeout: 180_000 })
  await shot('53-organizer-report.png')
  const report = await page.evaluate((id) => window.noema.organizerReport(id), planId)
  check(report.failed === 0 && report.verified > 0, `every copy was checked (${report.verified} verified, ${report.failed} failed)`)
  check(report.renamed >= 1, `the clash was resolved by renaming (${report.renamed} renamed)`)
  const afterOut = await hashAll(outDir)
  check(afterOut[wanted.to] === createHash('sha256').update('another file with the same name').digest('hex'), 'the file that was already there is untouched')
  check(afterOut['precious.txt'] === createHash('sha256').update('must survive').digest('hex'), 'other files at the destination are untouched')
  const copied = Object.entries(afterOut).filter(([f]) => !/precious|NOEMA-Atlas-organization|\.noema/.test(f) && f !== wanted.to)
  const bySource = new Set(Object.values(hashesBefore))
  check(copied.every(([, h]) => bySource.has(h)), `every copied file is byte-identical to an original (${copied.length} files)`)
  check(!Object.keys(afterOut).some((f) => /Screenshot/.test(f)), 'the screenshots that were left out were not copied')
  check(!Object.keys(afterOut).some((f) => /\.noema-part/.test(f)), 'no half-copied temporary files remain')
  const hashesAfter = await hashAll(libDir)
  check(JSON.stringify(hashesAfter) === JSON.stringify(hashesBefore), `all ${libraryFiles} originals are unchanged, none moved or removed`)

  log('F. Looking at pictures: a model on this computer gets them straight away')
  await page.evaluate((port) => window.noema.assistantUpdateSettings({ provider: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-vlm' }), mockPort)
  await page.locator('button[aria-label="New conversation"]').click().catch(() => undefined)
  requests.length = 0
  await ask('Look closely at these landscape pictures')
  await page.locator('.chat-looked').first().waitFor({ timeout: 60_000 })
  const looked = await page.locator('.chat-looked').first().innerText()
  check(/looked|this computer/i.test(looked), `a block says the pictures were looked at (${looked.replace(/\s+/g, ' ').slice(0, 80)})`)
  check(await page.locator('.chat-text--seen').first().isVisible(), 'what the model saw is labelled “seen”')
  check(await page.locator('.chat-text--library').last().isVisible(), 'what comes from library notes is labelled separately')
  const withImages = requests.filter((r) => (r.json.messages ?? []).some((m) => imagePartsOf(m).length > 0))
  check(withImages.length >= 1, 'the pictures were attached to a request')
  const parts = (withImages[0].json.messages ?? []).flatMap(imagePartsOf)
  const meta = await sharp(Buffer.from(parts[0].image_url.url.split(',')[1], 'base64')).metadata()
  check(parts.length >= 1 && parts.length <= 6 && meta.format === 'jpeg' && Math.max(meta.width, meta.height) <= 1568, `real JPEG pictures, at most 1568 px (${parts.length} sent, ${meta.width}×${meta.height})`)
  await shot('54-looked-local.png')

  log('G. A model that is not on this computer: nothing is sent until the user agrees');
  await page.evaluate((port) => window.noema.assistantUpdateSettings({ provider: 'custom', baseUrl: `http://127.0.0.2:${port}/v1`, model: 'mock-vlm', apiKey: 'test-key', consent: { granted: true, shareNames: false } }), mockPort)
  await page.locator('button[aria-label="New conversation"]').click().catch(() => undefined)
  requests.length = 0
  await ask('Look closely at these landscape pictures')
  await page.locator('.proposal--pending').last().waitFor({ timeout: 60_000 })
  const cardText = await page.locator('.proposal--pending').last().innerText()
  check(/not on this computer/i.test(cardText), 'the request says the pictures would leave the computer')
  const before = requests.filter((r) => (r.json.messages ?? []).some((m) => imagePartsOf(m).length > 0)).length
  check(before === 0, 'no picture was sent before the user agreed')
  await shot('55-look-consent.png')
  await page.locator('[data-testid="proposal-accept"]').last().click()
  await page.locator('.chat-looked').last().waitFor({ timeout: 60_000 })
  const after = requests.filter((r) => (r.json.messages ?? []).some((m) => imagePartsOf(m).length > 0)).length
  console.log('    requests carrying pictures:', requests.filter((r) => (r.json.messages ?? []).some((m) => imagePartsOf(m).length > 0)).map((r) => `${r.url} host=${r.host} messages=${r.json.messages.length} pictures=${r.json.messages.flatMap(imagePartsOf).length}`).join(' | '))
  check(after === 1, `after Accept the pictures were sent, in exactly one request (${after})`)
  check(/not on this computer|cloud|127\.0\.0\.2|mock-vlm/i.test(await page.locator('.chat-looked').last().innerText()), 'the answer says which model looked and that it was not local')
  await shot('56-looked-cloud.png')

  log('H. Checking groups decides what is included; Move keeps the library; thumbnails open for viewing without changing the selection')
  const moveDest = resolve('.e2e/organizer-moved')
  await fs.rm(moveDest, { recursive: true, force: true })
  await app.evaluate((_e, dest) => { process.env.NOEMA_E2E_DESTINATION = dest }, moveDest)
  const created = await page.evaluate(() => window.noema.organizerCreate('Selection test', { all: true }, { structure: 'kind-subject', duplicates: 'separate' }))
  await page.evaluate((id) => { window.location.hash = `#/organizer/${id}` }, created.id)
  await page.locator('[data-testid="org-status"][data-status="ready"]').waitFor({ timeout: 180_000 })
  const ov2 = await page.evaluate((id) => window.noema.organizerOverview(id), created.id)
  const total2 = ov2.kinds.reduce((n, k) => n + k.count, 0)
  check(ov2.selection.pictures === 0 && /Nothing is selected/.test(await page.locator('[data-testid="org-selection"]').innerText()), `nothing is checked at first, so zero of the ${total2} pictures are selected`)
  const noneDest = resolve('.e2e/organizer-none')
  await fs.rm(noneDest, { recursive: true, force: true })
  await app.evaluate((_e, dest) => { process.env.NOEMA_E2E_DESTINATION = dest }, noneDest)
  await page.locator('[data-testid="org-mode-move"]').check()
  await page.locator('[data-testid="org-choose"]').click()
  await page.locator('[data-testid="org-preview"]').waitFor({ timeout: 60_000 })
  await page.waitForFunction(() => /Nothing is selected/.test(document.querySelector('[data-testid="org-preview-scope"]')?.textContent ?? ''), null, { timeout: 30_000 })
  check(await page.locator('[data-testid="org-move"]').isDisabled(), 'with nothing checked, Move is disabled')
  await page.locator('[data-testid="org-mode-copy"]').check()
  await page.waitForFunction(() => document.querySelector('[data-testid="org-copy"]')?.disabled === true, null, { timeout: 15_000 })
  check(await page.locator('[data-testid="org-copy"]').isDisabled(), 'and so is Copy')
  const refused = await page.evaluate(([id, dest]) => window.noema.organizerExport(id, dest, 'size', 'move').then(() => 'started', (e) => String(e.message)), [created.id, noneDest])
  check(/Nothing is selected/.test(refused) && !existsSync(noneDest), 'even a direct request to move with nothing selected is refused, and nothing is created')
  await app.evaluate((_e, dest) => { process.env.NOEMA_E2E_DESTINATION = dest }, moveDest)
  // Check ONE group on the page.
  const artworkCard = page.locator('[data-testid="org-kind-artwork"]')
  const group = ov2.kinds.find((k) => k.kind === 'artwork').categories[0]
  await artworkCard.locator('.org-cat').first().locator('[data-testid="org-pick"]').check()
  await page.waitForFunction(() => /1 folder checked/.test(document.querySelector('[data-testid="org-selection"]')?.textContent ?? ''), null, { timeout: 15_000 })
  const sel = (await page.evaluate((id) => window.noema.organizerOverview(id), created.id)).selection
  check(sel.groups === 1 && sel.pictures === group.count && sel.pictures < total2, `only the checked group is included: ${sel.pictures} of ${total2} pictures`)
  await page.locator('[data-testid="org-choose"]').click()
  await page.locator('[data-testid="org-preview"]').waitFor({ timeout: 60_000 })
  await page.waitForFunction((n) => new RegExp(`${n} pictures`).test(document.querySelector('[data-testid="org-preview-scope"]')?.textContent ?? ''), group.count, { timeout: 30_000 })
  const pv = await page.evaluate(([id, dest]) => window.noema.organizerPreview(id, dest, 0, 0, 'copy'), [created.id, moveDest])
  check(pv.copy + pv.skipped.duplicates === group.count && pv.everything === false, `the proposed operation has ${pv.copy} files for the ${group.count} pictures of that group, not ${total2}`)
  // Looking at a thumbnail opens it and changes nothing.
  await artworkCard.locator('.org-cat').first().locator('[data-testid="org-thumb"]').first().click()
  await page.locator('.lightbox').waitFor({ timeout: 15_000 })
  check(true, 'a thumbnail opens in the picture viewer')
  await page.keyboard.press('Escape')
  await page.locator('.lightbox').waitFor({ state: 'detached' })
  const selAfter = (await page.evaluate((id) => window.noema.organizerOverview(id), created.id)).selection
  check(selAfter.groups === 1 && selAfter.pictures === group.count, 'viewing it did not change what is checked')
  // A favorite and a moodboard membership must survive a move.
  const members = await page.evaluate(([id, kind, name]) => window.noema.organizerGroupImages(id, kind, name), [created.id, 'artwork', group.name])
  const chosenOne = members[0]
  await page.evaluate((id) => window.noema.updateImage({ id, favorite: true, rating: 5 }), chosenOne.id)
  const board = await page.evaluate(() => window.noema.createMoodboard('Survives the move'))
  await page.evaluate(([b, id]) => window.noema.addToMoodboard({ moodboardId: b.id, imageIds: [id] }), [board, chosenOne.id])
  const untouchedBefore = await hashAll(libDir)
  // Move.
  await page.locator('[data-testid="org-mode-move"]').check()
  await page.waitForFunction(() => /files to move/.test(document.querySelector('[data-testid="org-preview"]')?.textContent ?? ''), null, { timeout: 30_000 })
  check(/favorites, moodboards/.test(await page.locator('[data-testid="org-preview"]').innerText()), 'the preview for a move says the library keeps favorites and moodboards')
  await shot('57-organizer-move-preview.png')
  await page.locator('[data-testid="org-move"]').click()
  await page.getByRole('dialog').getByRole('button', { name: 'Move', exact: true }).click()
  await page.locator('[data-testid="org-report"]').waitFor({ timeout: 180_000 })
  const moveReport = await page.evaluate((id) => window.noema.organizerReport(id), created.id)
  check(moveReport.mode === 'move' && moveReport.failed === 0 && moveReport.moved === pv.copy, `${moveReport.moved} pictures were moved, none failed`)
  const nowAt = await page.evaluate((ids) => Promise.all(ids.map((id) => window.noema.getImage(id))), members.filter((m) => !m.missing).map((m) => m.id))
  const movedRows = nowAt.filter((r) => r.path.toLowerCase().startsWith(moveDest.toLowerCase().replace(/\//g, '\\')))
  check(movedRows.length >= pv.copy, `the library now points at the new places (${movedRows.length} records)`)
  const keptRow = await page.evaluate((id) => window.noema.getImage(id), chosenOne.id)
  check(keptRow.favorite === true && keptRow.rating === 5, 'the favorite and the rating moved with the picture')
  check((await page.evaluate((id) => window.noema.moodboardsForImage(id), chosenOne.id)).length === 1, 'its moodboard membership is kept')
  const untouchedAfter = await hashAll(libDir)
  const gone = Object.keys(untouchedBefore).filter((f) => !(f in untouchedAfter))
  check(gone.length === pv.copy && Object.keys(untouchedAfter).every((f) => untouchedAfter[f] === untouchedBefore[f]), `only the ${gone.length} checked pictures left the old folder; every other original is unchanged`)
  await shot('58-organizer-move-done.png')

  const real = errors.filter((e) => !/Autofill|DevTools|favicon/i.test(e))
  check(real.length === 0, `no errors in the interface${real.length ? ': ' + real.slice(0, 3).join(' | ') : ''}`)
  console.log('\nAll checks passed.')
} catch (error) {
  console.error('\n' + (error instanceof Error ? error.message : String(error)))
  if (page) await shot('99-failure.png').catch(() => undefined)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  mock.close()
}
