// End-to-end check of the Atlas companion (the creative assistant) in the real application.
//
//   node scripts/e2e-assistant.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// A library is built from public-domain reference artworks. The script talks to Atlas through the real interface:
// the offline basics (no model of any kind), proposals that need the user's yes, a language model on "this computer"
// (a mock server on 127.0.0.1 speaking the OpenAI chat format, so tool use and privacy can be inspected), consent for
// cloud providers, key storage, persistence across restarts, and that the user's files are never touched.
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
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-assistant')
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

// ---- the user's library --------------------------------------------------------------------------------------------
const libDir = resolve('.e2e/assistant-library')
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
await pick('romantic-landscape', 24, 'landscape')
await pick('architecture', 16, 'architecture')
await pick('ukiyo-e', 10, 'print')
const hashAll = async () => {
  const out = {}
  for (const f of await fs.readdir(libDir)) out[f] = createHash('sha256').update(await fs.readFile(join(libDir, f))).digest('hex')
  return out
}
const hashesBefore = await hashAll()

// ---- a language model "on this computer" (mock): OpenAI chat format, and the Responses API for gpt-6.1-sol -------------
const requests = []
const responsesProblems = []
const GREETING = 'Hello! I am glad we can talk about your pictures.'
const callItem = (id, name, args) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) })
const msgItem = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const reasoningItem = (n) => ({ type: 'reasoning', id: `rs_${n}`, encrypted_content: `enc-${n}`, summary: [] })
function respondResponses(json, res) {
  // Reject anything the real API would reject, and remember it so the test can say so.
  if ('reasoning_effort' in json || json.reasoning?.effort === 'none') responsesProblems.push('reasoning_effort was sent')
  if (json.store !== false) responsesProblems.push('store was not false')
  for (const t of json.tools ?? []) if (t.type !== 'function' || !t.name || t.function) responsesProblems.push('tools are not flat function tools')
  const input = json.input ?? []
  const seen = new Set()
  for (const item of input) {
    if (item.type === 'function_call') seen.add(item.call_id)
    if (item.type === 'function_call_output' && !seen.has(item.call_id)) {
      responsesProblems.push('a tool result had no matching call')
      res.statusCode = 400
      return res.end(JSON.stringify({ error: { message: 'No tool call found for function call output.' } }))
    }
  }
  const reply = (output) => res.end(JSON.stringify({ status: 'completed', output }))
  const outputs = input.filter((i) => i.type === 'function_call_output')
  if (json.tools?.some((t) => t.name === 'atlas_check')) {
    return outputs.length ? reply([reasoningItem(9), msgItem(GREETING)]) : reply([reasoningItem(8), callItem('chk1', 'atlas_check', { word: 'ready' })])
  }
  const lastUser = input.map((i) => i.role === 'user').lastIndexOf(true)
  const text = String(input[lastUser]?.content ?? '').toLowerCase()
  const step = input.slice(lastUser + 1).filter((i) => i.type === 'function_call_output').length
  const lastOut = (() => {
    try {
      return JSON.parse(String(outputs.at(-1)?.output ?? '{}'))
    } catch {
      return {}
    }
  })()
  if (/taste|smak/.test(text)) {
    if (step === 0) return reply([reasoningItem(1), callItem('t1', 'favorites_profile', {})])
    if (step === 1) return reply([reasoningItem(2), callItem('t2', 'taste_summary', {})])
    return reply([reasoningItem(3), msgItem('[library] Your favorites share a calm, romantic landscape feeling.\n\n[idea] You might enjoy pushing it toward dusk light.')])
  }
  if (/moodboard/.test(text)) {
    if (step === 0) return reply([reasoningItem(1), callItem('m1', 'search_images', { query: 'calm landscape', limit: 6 })])
    if (step === 1) {
      const refs = (lastOut.images ?? []).map((i) => i.ref)
      return reply([reasoningItem(2), callItem('m2', 'propose_moodboard', { name: 'Calm landscapes', refs, reason: 'They look closest to each other.' })])
    }
    return reply([msgItem('[library] I gathered calm landscapes and drafted a moodboard for you to review.')])
  }
  if (step === 0) return reply([reasoningItem(1), callItem('s1', 'search_images', { query: 'misty landscape', limit: 6 })])
  return reply([msgItem('[library] These images from your library look misty and calm.')])
}
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {}
    requests.push({ url: req.url, auth: req.headers.authorization ?? null, body })
    res.setHeader('content-type', 'application/json')
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-llm' }, { id: 'gpt-6.1-sol' }, { id: 'mock-embed-nomic' }] }))
    if (json.model && json.model !== 'mock-llm' && json.model !== 'gpt-6.1-sol') {
      res.statusCode = 404
      return res.end(JSON.stringify({ error: { message: `model ${json.model} not found` } }))
    }
    if (req.url?.endsWith('/responses')) return respondResponses(json, res)
    if (json.model === 'gpt-6.1-sol') {
      // The real error that started this: function tools cannot be used with reasoning on Chat Completions.
      res.statusCode = 400
      return res.end(JSON.stringify({ error: { message: 'Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions.' } }))
    }
    const messages = json.messages ?? []
    const last = messages[messages.length - 1]
    if (json.tools?.some((t) => t.function?.name === 'atlas_check')) {
      if (last?.role === 'tool') return res.end(JSON.stringify({ choices: [{ message: { content: GREETING } }] }))
      return res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'chk1', function: { name: 'atlas_check', arguments: JSON.stringify({ word: 'ready' }) } }] } }] }))
    }
    if (last?.role === 'tool') {
      return res.end(
        JSON.stringify({
          choices: [{ message: { content: '[library] I looked through your pictures and found calm landscapes.\n\n[idea] You might enjoy pushing them toward dusk light.\n\n1. misty valley at dawn, painterly --ar 3:2 --stylize 250' } }]
        })
      )
    }
    res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'search_images', arguments: JSON.stringify({ query: 'calm landscape', limit: 6 }) } }] } }] }))
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1`

// ---- helpers ---------------------------------------------------------------------------------------------------------
const profile = resolve('.e2e/profile-assistant')
await fs.rm(profile, { recursive: true, force: true })
let app = null
let page = null
const errors = []
async function launch(seed) {
  const env = { ...process.env, NOEMA_E2E: '1', NOEMA_USER_DATA_DIR: profile, NOEMA_MODELS_DIR: modelsDir }
  delete env.ELECTRON_RUN_AS_NODE
  if (seed) env.NOEMA_E2E_SEED = libDir
  app = await electron.launch({ executablePath: exe, args: packaged ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1440, height: 920 })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}
async function until(predicate, timeout = 60_000, interval = 500) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const shot = (name) => page.screenshot({ path: join(shots, name), animations: 'disabled' })
const lastReply = () => page.locator('.chat-msg--atlas').last()
const searchResults = async () => {
  // Evidence from the favorites (labelled "N favorites") is not a search result; anything else would be.
  const labels = await lastReply().locator('.chat-images__label').allInnerTexts()
  return labels.filter((l) => !/favorites|reference collection/i.test(l)).length + ((await lastReply().innerText()).match(/matched by/gi)?.length ?? 0)
}
async function ask(text) {
  const box = page.locator('.companion__form textarea')
  await box.fill(text)
  await box.press('Enter')
  await page.locator('.chat-thinking').waitFor({ state: 'detached', timeout: 120_000 }).catch(() => undefined)
  await page.waitForFunction((n) => document.querySelectorAll('.chat-msg--user').length >= n, undefined, { timeout: 10_000 }).catch(() => undefined)
  await page.waitForTimeout(400)
}

try {
  // -------------------------------------------------------------------------------------------------------------------
  log('A. The companion is there, calm, and works without any language model')
  await launch(true)
  await until(async () => {
    const s = await window.noema.bootstrap()
    return s.stats.images >= 50
  }, 120_000)
  await page.evaluate(() => window.noema.setAiEnabled(true))
  await until(async () => {
    const s = await window.noema.getIndexStatus()
    return s.total > 0 && s.indexed >= s.total
  }, 300_000, 1000)
  const items = await page.evaluate(() => window.noema.listImages({ scope: 'archive', limit: 200 }).then((p) => p.items.map((i) => ({ id: i.id, name: i.filename }))))
  for (const item of items.filter((i) => i.name.startsWith('landscape-')).slice(0, 8)) {
    await page.evaluate((id) => window.noema.updateImage({ id, favorite: true }), item.id)
  }
  check(await page.locator('.companion-launcher').isVisible(), 'the Atlas character is in the corner')
  check(!(await page.locator('.companion').isVisible()), 'the panel is closed until asked for')
  await page.keyboard.press('Control+j')
  await page.locator('.companion').waitFor()
  check(await page.getByText('Shall we look at your pictures?').isVisible(), 'the welcome greets the user')
  check((await page.locator('.companion__chips button').count()) >= 4, 'example requests are offered')
  check(await page.getByText('Atlas basics · offline').isVisible(), 'the panel says it is running offline')
  await shot('30-companion-welcome.png')

  log('B. Find images (visual search) through the conversation')
  await page.locator('.companion__chips button').first().click()
  await page.locator('.chat-images__grid img').first().waitFor({ timeout: 60_000 })
  check((await page.locator('.chat-images__grid button').count()) >= 4, 'matching images are shown in the conversation')
  check(await page.locator('.chat-text--library').first().isVisible(), 'what comes from the library is labelled as such')
  await shot('31-companion-search.png')
  await page.locator('.chat-images__grid button').first().click()
  await page.locator('[role="dialog"]').waitFor()
  check(true, 'an image opens in the viewer')
  await page.keyboard.press('Escape')
  await page.locator('[role="dialog"]').waitFor({ state: 'detached' })

  log('C. What favorites share, and artists to discover')
  await ask('What do my favorites have in common?')
  const favText = await lastReply().innerText()
  check(/favorites/i.test(favText), 'it talks about the favorites')
  await shot('32-companion-favorites.png')
  await ask('Which artists might I enjoy discovering?')
  await page.locator('.chat-works figure').first().waitFor({ timeout: 30_000 })
  check((await page.locator('.chat-works figure').count()) >= 3, 'reference works with artists are shown')
  check(/visual resemblance/i.test(await lastReply().innerText()), 'it says this is resemblance, not influence')
  await shot('33-companion-artists.png')

  log('C2. Questions about personal taste are not image searches (English and Swedish)')
  for (const text of ['What is my personal taste?', 'Vad är min smak?', 'How would you describe my aesthetic?', 'Berätta om min stil']) {
    await ask(text)
    check((await searchResults()) === 0, `"${text}" shows no search results`)
    check(/favorites|taste|smak|comparisons/i.test(await lastReply().innerText()), `"${text}" is answered from favorites and taste`)
  }
  await ask('Find images that match my taste')
  check((await lastReply().locator('.chat-images__grid img').count()) === 0 && (await searchResults()) === 0, 'a mixed request is not silently searched')
  check(/describe your taste|should I search/i.test(await lastReply().innerText()), 'it asks one short question instead')
  await ask('Vad gillar jag?')
  check((await searchResults()) === 0, 'Swedish "what do I like" is not a search either')
  await ask('find foggy forests')
  check((await lastReply().locator('.chat-images__grid img').count()) > 0, 'a plain request to find images still searches')
  await shot('39-companion-taste.png')

  log('D. Moodboards: a proposal changes nothing until the user accepts')
  const boardsBefore = await page.evaluate(() => window.noema.listMoodboards().then((b) => b.length))
  await ask('Create a moodboard of ukiyo-e prints')
  await page.locator('.proposal--pending').waitFor({ timeout: 30_000 })
  check((await page.evaluate(() => window.noema.listMoodboards().then((b) => b.length))) === boardsBefore, 'nothing was created by asking')
  check(await page.getByText('Nothing changes until you accept.').isVisible(), 'the proposal says so')
  await shot('34-companion-proposal.png')
  await page.getByRole('button', { name: 'Not now' }).click()
  await page.locator('.proposal--dismissed').waitFor()
  check((await page.evaluate(() => window.noema.listMoodboards().then((b) => b.length))) === boardsBefore, 'declining leaves the library as it was')
  await ask('Create a moodboard of ukiyo-e prints')
  await page.locator('.proposal--pending').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Accept' }).click()
  await page.locator('.proposal--applied').waitFor()
  const boards = await page.evaluate(() => window.noema.listMoodboards())
  check(boards.length === boardsBefore + 1 && boards.at(-1).imageCount > 0, `accepting creates the moodboard (${boards.at(-1)?.name}, ${boards.at(-1)?.imageCount} images)`)
  const boardName = boards.at(-1).name
  await ask(`Find images that would complement my "${boardName}" moodboard`)
  await page.locator('.proposal--pending').waitFor({ timeout: 30_000 })
  const before = (await page.evaluate(() => window.noema.listMoodboards())).find((b) => b.name === boardName).imageCount
  await page.getByRole('button', { name: 'Accept' }).last().click()
  await page.waitForFunction(() => document.querySelectorAll('.proposal--applied').length >= 2)
  const after = (await page.evaluate(() => window.noema.listMoodboards())).find((b) => b.name === boardName).imageCount
  check(after > before, `suggested images were added only after accepting (${before} to ${after})`)

  log('E. Prompts from images')
  await ask('Write Midjourney prompts from these images')
  check((await page.locator('.prompt-card').count()) >= 1, 'prompts are shown, each with a copy button')
  await shot('35-companion-prompts.png')

  log('F. Settings: a model on this computer, tool use and privacy')
  await page.locator('button[aria-label="Where Atlas thinks"]').click()
  await page.getByText('Where should Atlas think?').waitFor()
  await shot('36-companion-settings.png')
  await page.getByRole('radio', { name: /A model on this computer/ }).click()
  await page.locator('input[placeholder*="127.0.0.1"]').fill(mockUrl)
  await page.locator('input[type="password"]').count().then(() => undefined)
  check(await page.getByText(/nothing is sent over the internet/i).isVisible(), 'an address on this computer says nothing leaves it')
  // Reachable, but the chosen model does not exist: connected is not the same as ready.
  await page.locator('input[placeholder*="Choose after testing"]').fill('no-such-model')
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.getByText(/did not answer/).waitFor({ timeout: 30_000 })
  check(await page.getByText('Where should Atlas think?').isVisible(), 'a model that did not answer keeps the user in the settings')
  check(!(await page.locator('.companion__hello').count()), 'and no greeting is shown')
  await page.locator('input[placeholder*="Choose after testing"]').fill('mock-llm')
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.locator('.companion__hello').waitFor({ timeout: 30_000 })
  check(!(await page.getByText('Where should Atlas think?').isVisible()), 'after the model answered, Atlas returns to the conversation')
  check(/Hello! I am glad/.test(await page.locator('.companion__hello').innerText()), 'Atlas greets with the words the model itself wrote')
  const subtitle = await page.locator('.companion__title span').innerText()
  check(/mock-llm/.test(subtitle) && !/offline/i.test(subtitle), `the header names the provider and model (${subtitle})`)
  check(await page.locator('.companion__head .atlas-character--hello').count() > 0, 'the character does its hello animation')
  await shot('40-companion-hello.png')
  // Opening settings and testing again does not greet a second time.
  await page.locator('.companion__hello').click()
  await page.locator('button[aria-label="Where Atlas thinks"]').click()
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.getByText(/answered\. Atlas is ready/).first().waitFor({ timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(600)
  check(!(await page.locator('.companion__hello').count()), 'the greeting is not repeated')
  if (await page.getByRole('button', { name: 'Back to the conversation' }).count()) await page.getByRole('button', { name: 'Back to the conversation' }).click()
  await page.locator('button[aria-label="New conversation"]').click()
  requests.length = 0
  await ask('Show me something calm')
  await page.waitForFunction(() => document.querySelector('.chat-text--idea'), undefined, { timeout: 60_000 })
  check(await page.locator('.chat-text--library').first().isVisible(), 'the model answer marks library-based statements')
  check(await page.locator('.chat-text--idea').first().isVisible(), 'and marks its own ideas separately')
  check((await page.locator('.chat-images__grid button').count()) >= 1, 'the images found by the tool call are shown')
  check(await page.locator('.prompt-card').last().isVisible(), 'a prompt in the answer gets a copy button')
  const chatRequests = requests.filter((r) => r.url?.endsWith('/chat/completions'))
  check(chatRequests.length === 2, `the model used a tool, then answered (${chatRequests.length} requests)`)
  const sent = chatRequests.map((r) => r.body).join('\n')
  check(!sent.includes(libDir.replace(/\\/g, '\\\\')) && !sent.includes('thumb') && !sent.includes('noema://'), 'no full paths, thumbnails or image data were sent (file names only go to a model on this computer)')
  check(sent.includes('search_images'), 'tools are offered to the model')
  await shot('37-companion-model.png')

  log('F2. A model that needs the Responses API (gpt-6.1-sol): connection check and real conversations')
  await page.locator('button[aria-label="Where Atlas thinks"]').click()
  await page.locator('input[placeholder*="Choose after testing"]').fill('gpt-6.1-sol')
  requests.length = 0
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.locator('.companion__hello').waitFor({ timeout: 40_000 })
  check(/gpt-6\.1-sol/.test(await page.locator('.companion__title span').innerText()), 'the header names gpt-6.1-sol once it has answered')
  const urlsUsed = requests.map((r) => r.url ?? '')
  check(urlsUsed.some((u) => u.endsWith('/chat/completions')), 'Atlas first tried Chat Completions and got the real GPT-6.1 Sol refusal')
  check(urlsUsed.some((u) => u.endsWith('/responses')), 'then switched to the Responses API on its own')
  check(requests.filter((r) => r.url?.endsWith('/responses')).length >= 2, 'the check made a real tool round trip (call, result, reply)')
  await page.locator('button[aria-label="New conversation"]').click()
  requests.length = 0
  await ask('What is my personal taste?')
  check(/calm, romantic landscape/.test(await lastReply().innerText()), 'a taste question is answered through the Responses API')
  const tasteBodies = requests.filter((r) => r.url?.endsWith('/responses')).map((r) => r.body)
  check(tasteBodies.length === 3, `the model called two taste tools, then answered (${tasteBodies.length} requests)`)
  check(tasteBodies.every((b) => !b.includes('/chat/completions')) && !requests.some((r) => r.url?.endsWith('/chat/completions')), 'the learned choice is remembered: no more Chat Completions requests')
  check(tasteBodies[2].includes('function_call_output') && tasteBodies[2].includes('encrypted_content'), 'tool results and reasoning items were passed back')
  check((await lastReply().locator('.chat-images__label').allInnerTexts()).every((l) => /favorites|reference collection/i.test(l)), 'no unrelated search results were shown')
  await ask('Find my calmest landscapes')
  await page.locator('.chat-images__grid img').first().waitFor({ timeout: 30_000 })
  check((await page.locator('.chat-images__grid button').count()) >= 3, 'image search through the Responses API shows images')
  const boardsBeforeR = await page.evaluate(() => window.noema.listMoodboards().then((b) => b.length))
  await ask('Make a moodboard of calm landscapes')
  await page.locator('.proposal--pending').last().waitFor({ timeout: 30_000 })
  check((await page.evaluate(() => window.noema.listMoodboards().then((b) => b.length))) === boardsBeforeR, 'the moodboard proposal changed nothing yet')
  await page.locator('.proposal--pending').last().getByRole('button', { name: /accept/i }).click()
  await page.waitForFunction((n) => window.noema.listMoodboards().then((b) => b.length === n + 1), boardsBeforeR, { timeout: 15_000 })
  check(true, 'accepting created the moodboard')
  check(responsesProblems.length === 0, `every Responses request was valid (no reasoning_effort, nothing stored, flat tools)${responsesProblems.length ? ': ' + responsesProblems.join('; ') : ''}`)
  await shot('41-companion-responses.png')
  // Back to the simple model for the rest of the run.
  await page.locator('button[aria-label="Where Atlas thinks"]').click()
  await page.locator('input[placeholder*="Choose after testing"]').fill('mock-llm')
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.locator('.companion__title span', { hasText: 'mock-llm' }).waitFor({ timeout: 30_000 })
  await page.locator('.companion__hello').click().catch(() => undefined)

  log('G. Cloud providers need explicit consent; keys are stored encrypted')
  await page.locator('button[aria-label="Where Atlas thinks"]').click()
  await page.getByRole('radio', { name: /Claude \(Anthropic\)/ }).click()
  await page.getByText('What leaves this computer').waitFor({ timeout: 10_000 })
  check(true, 'the consent explains what is sent')
  check(await page.getByText(/Never sent:/).isVisible(), 'and what is never sent')
  await page.locator('input[type="password"]').fill('sk-ant-e2e-SECRET-123')
  const saveButton = page.getByRole('button', { name: 'Save and test the connection' })
  check(await saveButton.isDisabled(), 'testing is disabled until the user agrees')
  await shot('38-companion-consent.png')
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: 'Save and test the connection' }).click()
  await page.waitForTimeout(1500)
  const stored = await page.evaluate(() => window.noema.assistantSettings())
  check(stored.hasKey === true && !JSON.stringify(stored).includes('SECRET'), 'the interface only learns that a key exists, never the key')
  const files = []
  for (const name of await fs.readdir(join(profile, 'assistant'))) {
    if (name.endsWith('.json')) files.push(await fs.readFile(join(profile, 'assistant', name), 'utf8'))
  }
  check(!files.join('\n').includes('SECRET-123'), 'the key is not stored in plain text')
  // Revoke consent: no contact.
  await page.getByRole('checkbox').first().uncheck()
  await page.evaluate(() => window.noema.assistantUpdateSettings({ consent: { granted: false, shareNames: false } }))
  await page.getByRole('button', { name: 'Back to the conversation' }).click()
  requests.length = 0
  await ask('hello again')
  check(await page.getByRole('button', { name: 'Review what would be shared' }).isVisible(), 'without consent Atlas asks instead of contacting the provider')
  await page.evaluate(() => window.noema.assistantUpdateSettings({ provider: 'basics' }))

  log('H. Conversations persist across restarts; settings survive; other rooms still work')
  const countBefore = (await page.evaluate(() => window.noema.assistantChats())).length
  check(countBefore >= 2, `conversations are saved (${countBefore})`)
  await app.close()
  await launch(false)
  const chatsAfter = await page.evaluate(() => window.noema.assistantChats())
  check(chatsAfter.length === countBefore, 'conversations are still there after a restart')
  const restored = await page.evaluate(async () => {
    const list = await window.noema.assistantChats()
    const chat = await window.noema.assistantChat(list[0].id)
    return { messages: chat.messages.length, images: chat.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'images').every((b) => (b.items ?? []).length > 0) }
  })
  check(restored.messages >= 2 && restored.images, 'the latest conversation reopens with its images')
  await page.keyboard.press('Control+j')
  await page.locator('.companion').waitFor()
  await page.locator('.chat-msg').first().waitFor({ timeout: 15_000 }).catch(() => undefined)
  check((await page.locator('.chat-msg').count()) >= 2, 'the panel shows the last conversation')
  await page.keyboard.press('Escape')
  for (const route of ['families', 'taste', 'moodboards', 'collection', 'archive', 'sources']) {
    await page.evaluate((r) => (window.location.hash = `#/${r}`), route)
    await page.waitForTimeout(600)
  }
  check(await page.locator('.app-shell').isVisible(), 'every room still opens')

  log('I. The user\'s files were never touched, and nothing broke')
  const hashesAfter = await hashAll()
  check(JSON.stringify(hashesAfter) === JSON.stringify(hashesBefore), 'originals are byte-for-byte unchanged')
  check(errors.length === 0, `no renderer errors (${errors.slice(0, 3).join(' | ')})`)
  console.log('\n✓ The Atlas companion works end to end.')
} finally {
  await app?.close().catch(() => undefined)
  mock.close()
}
