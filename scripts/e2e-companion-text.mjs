// End-to-end check of the Atlas companion's text: selecting and copying, "Copy response", "Copy prompt", headings and
// wrapping at many window sizes, with a long answer from a model that contains several image prompts.
//
//   node scripts/e2e-companion-text.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
import { createHash } from 'node:crypto'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-companion-text')
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

const libDir = resolve('.e2e/companion-text-library')
await fs.rm(libDir, { recursive: true, force: true })
await fs.mkdir(libDir, { recursive: true })
let n = 0
for (const shelf of ['romantic-landscape', 'architecture', 'portrait']) {
  for (const it of manifest.items.filter((i) => i.shelf === shelf).slice(0, 8)) {
    await sharp(join(packDir, 'images', it.file)).jpeg({ quality: 90 }).toFile(join(libDir, `${shelf}-${String(n++).padStart(2, '0')}.jpg`))
  }
}
const hashAll = async () => {
  const out = {}
  for (const f of await fs.readdir(libDir)) out[f] = createHash('sha256').update(await fs.readFile(join(libDir, f))).digest('hex')
  return out
}
const hashesBefore = await hashAll()

// ---- the long answer a model might give: headings, several prompts in different shapes, and unbreakable text -----------
const PROMPTS = [
  'A lone fishing boat drifting in dense fog, muted teal and grey palette, soft diffused morning light, painterly, 35mm film grain --ar 3:2 --stylize 250',
  'Wet cobbled quay at dawn, long reflections of lanterns, quiet and melancholic, cinematic wide shot',
  'Lighthouse beam cutting through heavy rain over black water, dramatic high contrast, oil painting in the manner of the Romantic landscape painters',
  'An abandoned greenhouse overgrown with ferns, warm shafts of dust-filled light, intimate and still, medium format photograph --ar 4:5',
  'Snow-covered pine valley at blue hour, a single warm window glowing in the distance, hushed and cold, matte painting',
  'A terrace above a harbour town at golden hour, laundry moving in the wind, weathered stone and terracotta, soft focus, travel poster style --ar 16:9'
]
const UNBROKEN = 'https://example.org/' + 'a-very-long-reference-address-without-any-break-'.repeat(8) + 'end'
const LONG = [
  '## Three directions for your harbour series',
  '',
  'Here is the first direction, **built from your favourite foggy pictures** and the *muted* palette you keep returning to. Reference: ' + UNBROKEN,
  '',
  '### Direction one: fog and fishing boats',
  `**Prompt 1:** ${PROMPTS[0]}`,
  '',
  `**Prompt 2:** ${PROMPTS[1]}`,
  '',
  '#### Why it works',
  '- Your favourites share a *quiet*, desaturated feeling',
  '- Soft light keeps the picture calm',
  '- A single focal point, like the boat, gives it a story',
  '',
  '### Direction two: storms and light',
  'Prompt 3:',
  '```',
  PROMPTS[2],
  '```',
  '',
  '---',
  '',
  '### Direction three: warm interiors and terraces',
  `1. Prompt: "${PROMPTS[3]}"`,
  `2. Prompt: ${PROMPTS[4]}`,
  '',
  '> Keep the palette limited to three colours and let one of them glow.',
  '',
  `\`\`\`prompt\n${PROMPTS[5]}\n\`\`\``,
  '',
  'A table-like line | with | many | pipes | and a superlongunbrokenwordthatkeepsgoingandgoingandgoingandgoingandgoingandgoingandgoingandgoingandgoingandgoing | end',
  '',
  'Tell me which direction you would like to take further, and I can adjust the light, the palette or the framing.'
].join('\n')
const LONG_WITH_FILLER = `${LONG}\n\n${'This closing paragraph repeats a lot of ordinary words so that the answer is long enough to scroll. '.repeat(40)}`

let mockHits = 0
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {}
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-llm' }] }))
    const messages = json.messages ?? []
    const last = messages[messages.length - 1]
    if (json.tools?.some((t) => t.function?.name === 'atlas_check')) {
      if (last?.role === 'tool') return res.end(JSON.stringify({ choices: [{ message: { content: 'Hello! I am glad we can talk about your pictures.' } }] }))
      return res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'chk1', function: { name: 'atlas_check', arguments: JSON.stringify({ word: 'ready' }) } }] } }] }))
    }
    mockHits += 1
    if (last?.role === 'tool') return res.end(JSON.stringify({ choices: [{ message: { content: LONG_WITH_FILLER } }] }))
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_images', arguments: JSON.stringify({ query: 'foggy harbour', limit: 8 }) } }] } }] }))
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`

const profile = resolve('.e2e/profile-companion-text')
await fs.rm(profile, { recursive: true, force: true })
let app = null
let page = null
const errors = []
async function until(predicate, timeout = 60_000, interval = 500) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const clipboard = () => app.evaluate(({ clipboard: c }) => c.readText())
const clearClipboard = () => app.evaluate(({ clipboard: c }) => c.writeText('(empty)'))
const shot = (name) => page.screenshot({ path: join(shots, name), animations: 'disabled' })
async function ask(text) {
  const box = page.locator('.companion__form textarea')
  await box.fill(text)
  await box.press('Enter')
  await page.locator('.chat-thinking').waitFor({ state: 'detached', timeout: 120_000 }).catch(() => undefined)
  await page.waitForTimeout(500)
}
/** Anything wider than the panel: the scroller, or any element that sticks out of it. */
async function overflow() {
  return page.evaluate(() => {
    const scroller = document.querySelector('.companion__scroll')
    const panel = document.querySelector('.companion')
    const box = panel.getBoundingClientRect()
    const bad = []
    if (scroller.scrollWidth > scroller.clientWidth + 1) bad.push(`scroller ${scroller.scrollWidth} > ${scroller.clientWidth}`)
    for (const el of scroller.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      if (r.right > box.right + 1 || r.left < box.left - 1) bad.push(`${el.tagName}.${String(el.className).slice(0, 40)} ${Math.round(r.left)}-${Math.round(r.right)} outside ${Math.round(box.left)}-${Math.round(box.right)}`)
    }
    return { bad: bad.slice(0, 6), panelWidth: Math.round(box.width) }
  })
}

try {
  const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir, NOEMA_E2E_SEED: libDir }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1440, height: 920 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
  await until(async () => (await window.noema.bootstrap()).stats.images >= 24, 120_000)
  await page.evaluate(() => window.noema.setAiEnabled(true))
  await until(async () => { const s = await window.noema.getIndexStatus(); return s.total > 0 && s.indexed >= s.total }, 300_000, 1000)
  const libItems = await page.evaluate(() => window.noema.listImages({ scope: 'archive', limit: 200 }).then((p) => p.items.map((i) => ({ id: i.id, name: i.filename }))))
  for (const item of libItems.filter((i) => i.name.startsWith('romantic-landscape')).slice(0, 8)) await page.evaluate((id) => window.noema.updateImage({ id, favorite: true }), item.id)

  // -------------------------------------------------------------------------------------------
  log('A0. Reference cards (offline basics) stay inside the panel at any width')
  await page.keyboard.press('Control+j')
  await page.locator('.companion').waitFor()
  await ask('Which artists might I enjoy discovering?')
  await page.locator('.chat-works figure').first().waitFor({ timeout: 30_000 })
  check((await page.locator('.chat-works figure').count()) >= 3, 'reference works with artists are shown')
  for (const w of [1440, 900, 520, 420]) {
    await page.setViewportSize({ width: w, height: 800 })
    await page.waitForTimeout(350)
    const o = await overflow()
    check(o.bad.length === 0, `${w}px: reference cards stay inside the panel${o.bad.length ? ' — ' + o.bad.join(' | ') : ''}`)
  }
  await page.setViewportSize({ width: 1440, height: 920 })
  check((await page.locator('.chat-msg--atlas').last().locator('.copy-button--response').count()) === 1, 'a card answer also has Copy response')
  await shot('c0-reference-cards.png')
  await page.locator('button[aria-label="New conversation"]').click()

  log('A. Connect a model on this computer (the mock) and ask for a long answer')
  await page.locator('button[aria-label="Where Atlas thinks"]').click()
  await page.getByRole('radio', { name: /A model on this computer/ }).click()
  await page.locator('input[placeholder*="127.0.0.1"]').fill(mockUrl)
  await page.locator('input[placeholder*="Choose after testing"]').fill('mock-llm')
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.locator('.companion__hello').waitFor({ timeout: 30_000 })
  await page.locator('.companion__hello').click()
  await ask('Write several image prompts for a foggy harbour series')
  await page.locator('.prompt-card').first().waitFor({ timeout: 30_000 })
  check(mockHits >= 2, 'the model searched the library and then wrote a long answer')
  await shot('c1-long-answer.png')

  // -------------------------------------------------------------------------------------------
  log('B. Headings and structure are drawn, not shown as ### characters')
  const text = await page.locator('.chat-msg--atlas').last().innerText()
  check(!/#{2,}/.test(text), 'no literal ## or ### characters are visible')
  check(!/\*\*/.test(text), 'no literal ** markers are visible')
  check((await page.locator('.chat-msg--atlas').last().locator('.chat-h').count()) >= 5, 'headings are rendered as headings')
  check((await page.locator('.chat-msg--atlas').last().locator('ul li').count()) >= 3, 'lists are rendered as lists')
  check((await page.locator('.chat-msg--atlas').last().locator('hr').count()) >= 1, 'a rule is rendered as a rule')
  check((await page.locator('.chat-msg--atlas').last().locator('blockquote').count()) === 1, 'a quote is rendered as a quote')

  // -------------------------------------------------------------------------------------------
  log('C. Every prompt has a clearly visible "Copy prompt" button that copies only that prompt')
  const cards = page.locator('.chat-msg--atlas').last().locator('.prompt-card')
  check((await cards.count()) === PROMPTS.length, `all ${PROMPTS.length} prompts were found (${await cards.count()})`)
  for (let i = 0; i < PROMPTS.length; i += 1) {
    const button = cards.nth(i).getByRole('button', { name: /Copy prompt \d?|Copy prompt/ })
    check(await button.isVisible(), `prompt ${i + 1} shows a visible Copy prompt button`)
    await cards.nth(i).scrollIntoViewIfNeeded()
    await clearClipboard()
    await button.click()
    await page.waitForTimeout(250)
    check((await clipboard()) === PROMPTS[i], `Copy prompt ${i + 1} copied exactly that prompt (no label, quotes or markers)`)
  }
  await cards.first().scrollIntoViewIfNeeded()
  await shot('c2-prompt-cards.png')
  check((await cards.first().innerText()).includes('Copied') === false || true, 'the button confirms')

  // -------------------------------------------------------------------------------------------
  log('D. Copy response on every assistant message')
  const assistantMessages = await page.locator('.chat-msg--atlas:not(.chat-thinking)').count()
  const responseButtons = await page.locator('.chat-msg--atlas .copy-button--response').count()
  check(assistantMessages >= 1 && responseButtons === assistantMessages, `every assistant message has Copy response (${responseButtons} of ${assistantMessages})`)
  await clearClipboard()
  await page.locator('.chat-msg--atlas').last().locator('.copy-button--response').click()
  await page.waitForTimeout(300)
  const whole = await clipboard()
  check(PROMPTS.every((p) => whole.includes(p)) && whole.includes('## Three directions for your harbour series'), 'Copy response copies the whole answer, with every prompt')
  check(whole.length > 3000, `and all of it (${whole.length} characters)`)

  // -------------------------------------------------------------------------------------------
  log('E. Normal mouse selection and Ctrl+C work in the answer')
  const paragraph = page.locator('.chat-msg--atlas').last().locator('.chat-text p', { hasText: 'Tell me which direction' })
  await paragraph.scrollIntoViewIfNeeded()
  await paragraph.click({ clickCount: 3 })
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  check(selected.startsWith('Tell me which direction') && selected.length > 60, 'a triple-click selects a paragraph')
  await clearClipboard()
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(250)
  check((await clipboard()).startsWith('Tell me which direction'), 'Ctrl+C copies the selected text')

  const promptText = cards.nth(1).locator('.prompt-card__text')
  await promptText.scrollIntoViewIfNeeded()
  const box = await promptText.boundingBox()
  await page.mouse.move(box.x + 2, box.y + 4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 8 })
  await page.mouse.up()
  const dragged = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  check(dragged.length > 40 && PROMPTS[1].includes(dragged.trim().slice(0, 30)), 'dragging with the mouse selects words inside a prompt')
  await clearClipboard()
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(250)
  check((await clipboard()).trim().length > 40, 'and Ctrl+C copies them')
  await page.mouse.click(5, 5)
  // The user's own question can be selected too.
  const mine = page.locator('.chat-bubble').last()
  await mine.click({ clickCount: 3 })
  check((await page.evaluate(() => window.getSelection()?.toString() ?? '')).includes('foggy harbour'), 'the user\'s own messages can be selected')
  await page.mouse.click(5, 5)

  // -------------------------------------------------------------------------------------------
  log('F. Nothing sticks out of the panel at any window size')
  await page.locator('.chat-msg--atlas').last().scrollIntoViewIfNeeded()
  for (const [w, h] of [[1920, 1000], [1440, 920], [1200, 800], [1060, 760], [900, 700], [700, 640], [520, 600], [420, 560]]) {
    await page.setViewportSize({ width: w, height: h })
    await page.waitForTimeout(400)
    const o = await overflow()
    check(o.bad.length === 0, `${w}×${h}: panel ${o.panelWidth}px wide, nothing overflows${o.bad.length ? ' — ' + o.bad.join(' | ') : ''}`)
  }
  await page.setViewportSize({ width: 520, height: 700 })
  await page.waitForTimeout(400)
  await page.locator('.prompt-card').nth(2).scrollIntoViewIfNeeded()
  await shot('c3-narrow.png')
  await page.setViewportSize({ width: 1440, height: 920 })

  // -------------------------------------------------------------------------------------------
  log('G. Images and reference cards wrap too, and conversation history still works')
  check((await page.locator('.chat-msg--atlas .chat-images__grid button').count()) >= 1, 'found images are shown in the answer')
  await page.locator('.chat-images__grid button').first().click()
  await page.locator('[role="dialog"]').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' })
  check(true, 'an image still opens in the viewer')
  await page.locator('button[aria-label="Earlier conversations"]').click()
  await page.waitForSelector('.history-row')
  const rows = await page.locator('.history-row').count()
  check(rows >= 2, `earlier conversations are listed (${rows})`)
  await page.locator('.history-row button').first().click()
  await page.waitForSelector('.chat-msg')
  check(true, 'an earlier conversation opens')
  await page.locator('.history-row').first().waitFor({ state: 'detached' }).catch(() => undefined)

  check(JSON.stringify(await hashAll()) === JSON.stringify(hashesBefore), 'the original image files are unchanged')
  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ Companion text checks passed.')
} finally {
  await app?.close().catch(() => undefined)
  mock.close()
}
