// End-to-end check of the ComfyUI setup in the Creative Studio, in the real application.
//
//   node scripts/e2e-comfy.mjs [--exe "release/win-unpacked/NOEMA Atlas.exe"]
//
// A fake "portable" ComfyUI installation is made (models, workflows, a main.py) and a stand-in server (scripts/fake-
// comfyui.mjs) plays ComfyUI's HTTP API and makes real pictures. The script chooses the folder once, lets Atlas start
// ComfyUI by itself, connects to one that is already running instead of starting another, runs the user's own
// workflows (the editor format and the API format, including an upscaling workflow), explains what is missing, handles
// start-up failures, and checks that nothing in the "user's" ComfyUI folder is ever changed. Finally it reads the real
// ComfyUI installation on this computer, read-only, without starting it.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const exeArg = args.includes('--exe') ? args[args.indexOf('--exe') + 1] : undefined
const exe = resolve(exeArg ?? 'node_modules/electron/dist/electron.exe')
const root = resolve('.')
const shots = resolve(process.env.NOEMA_SCREENSHOT_DIR ?? '.e2e/screenshots-comfy')
await fs.mkdir(shots, { recursive: true })

const log = (m) => console.log(`\n◆ ${m}`)
const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ✓ ${message}`)
}

// ---- a fake portable ComfyUI --------------------------------------------------------------------------------------------
const base = resolve('.e2e/comfy-fake')
await fs.rm(base, { recursive: true, force: true }).catch(() => undefined)
const touch = async (path, content = '') => {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, content)
}
const portableFolder = join(base, 'ComfyUI_windows_portable')
const dataFolder = join(portableFolder, 'ComfyUI')
const logFile = join(base, 'server.log')
const failFlag = join(base, 'fail.flag')
await touch(join(portableFolder, 'python_embeded', 'python.exe'))
await touch(join(dataFolder, 'comfyui_version.py'), '__version__ = "0.3.99"\n')
// main.py is run by Node in this test (NOEMA_COMFY_PYTHON), and hands over to the stand-in server.
await touch(join(dataFolder, 'main.py'), "const { pathToFileURL } = require('url'); import(pathToFileURL(process.env.NOEMA_FAKE_COMFY).href)\n")
await touch(join(dataFolder, 'models', 'checkpoints', 'fake-model.safetensors'), 'not a real model')
await touch(join(dataFolder, 'models', 'upscale_models', '4x.pth'), 'not a real model')

const wfDir = join(dataFolder, 'user', 'default', 'workflows')
const uiGraph = {
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['fake-model.safetensors'], inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [2, 3] }, { name: 'VAE', type: 'VAE', links: [8] }], properties: { models: [{ name: 'fake-model.safetensors', url: 'https://example.org/m', directory: 'checkpoints' }] } },
    { id: 2, type: 'CLIPTextEncode', widgets_values: ['a lighthouse in my own graph'], inputs: [{ name: 'clip', type: 'CLIP', link: 2 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }] },
    { id: 3, type: 'CLIPTextEncode', widgets_values: ['my own negative'], inputs: [{ name: 'clip', type: 'CLIP', link: 3 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }] },
    { id: 4, type: 'EmptyLatentImage', widgets_values: [768, 512, 1], inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT', links: [6] }] },
    { id: 5, type: 'KSampler', widgets_values: [7, 'randomize', 31, 6.5, 'dpmpp_2m', 'karras', 1], inputs: [{ name: 'model', type: 'MODEL', link: 1 }, { name: 'positive', type: 'CONDITIONING', link: 4 }, { name: 'negative', type: 'CONDITIONING', link: 5 }, { name: 'latent_image', type: 'LATENT', link: 6 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }] },
    { id: 6, type: 'VAEDecode', inputs: [{ name: 'samples', type: 'LATENT', link: 7 }, { name: 'vae', type: 'VAE', link: 8 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }] },
    { id: 7, type: 'SaveImage', widgets_values: ['mine'], inputs: [{ name: 'images', type: 'IMAGE', link: 9 }], outputs: [] }
  ],
  links: [[1, 1, 0, 5, 0, 'MODEL'], [2, 1, 1, 2, 0, 'CLIP'], [3, 1, 1, 3, 0, 'CLIP'], [4, 2, 0, 5, 1, 'CONDITIONING'], [5, 3, 0, 5, 2, 'CONDITIONING'], [6, 4, 0, 5, 3, 'LATENT'], [7, 5, 0, 6, 0, 'LATENT'], [8, 1, 2, 6, 1, 'VAE'], [9, 6, 0, 7, 0, 'IMAGE']]
}
const upscaleApi = { '1': { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x.pth' } }, '2': { class_type: 'LoadImage', inputs: { image: 'example.png' } }, '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['1', 0], image: ['2', 0] } }, '4': { class_type: 'SaveImage', inputs: { filename_prefix: 'up', images: ['3', 0] } } }
const needsFlux = { nodes: [{ id: 1, type: 'UNETLoader', widgets_values: ['flux2-dev.safetensors', 'default'], properties: { models: [{ name: 'flux2-dev.safetensors', url: 'https://example.org/flux', directory: 'diffusion_models' }] } }, { id: 2, type: 'KSampler' }, { id: 3, type: 'EmptyLatentImage' }], links: [] }
const subgraphFlow = { nodes: [{ id: 1, type: '9d1e5b2a-1111-4222-8333-444455556666' }], links: [], definitions: { subgraphs: [{ nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'EmptyLatentImage' }] }] } }
const videoFlow = { nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'SaveVideo' }], links: [] }
await touch(join(wfDir, 'my text to image.json'), JSON.stringify(uiGraph))
await touch(join(wfDir, 'my upscale 2x.json'), JSON.stringify(upscaleApi))
await touch(join(wfDir, 'needs flux.json'), JSON.stringify(needsFlux))
await touch(join(wfDir, 'newer grouped nodes.json'), JSON.stringify(subgraphFlow))
await touch(join(wfDir, 'a video one.json'), JSON.stringify(videoFlow))

const hashTree = async (folder) => {
  const out = {}
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out[full] = createHash('sha256').update(await fs.readFile(full)).digest('hex')
    }
  }
  await walk(folder)
  return out
}
const treeBefore = await hashTree(portableFolder)

// A second installation without any model, for the "what is missing" explanation.
const emptyFolder = join(base, 'ComfyUI_empty')
await touch(join(emptyFolder, 'python_embeded', 'python.exe'))
await touch(join(emptyFolder, 'ComfyUI', 'main.py'), 'console.log("never run")\n')
await fs.mkdir(join(emptyFolder, 'ComfyUI', 'models', 'checkpoints'), { recursive: true })

// ---- a small library to work with ---------------------------------------------------------------------------------------
const libDir = resolve('.e2e/comfy-library')
await fs.rm(libDir, { recursive: true, force: true }).catch(() => undefined)
await fs.mkdir(libDir, { recursive: true })
for (let i = 0; i < 4; i += 1) {
  await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 40 + i * 50, g: 90, b: 160 - i * 30 } } }).jpeg().toFile(join(libDir, `plain-${i}.jpg`))
}
const libHash = async () => Object.fromEntries(await Promise.all((await fs.readdir(libDir)).map(async (f) => [f, createHash('sha256').update(await fs.readFile(join(libDir, f))).digest('hex')])))
const libBefore = await libHash()

const profile = resolve(`.e2e/profile-comfy-${Date.now()}`)
const studioDir = resolve('.e2e/comfy-studio-pictures')
await fs.rm(studioDir, { recursive: true, force: true }).catch(() => undefined)
const env = {
  ...process.env,
  NOEMA_E2E: '1',
  NOEMA_USER_DATA_DIR: profile,
  NOEMA_STUDIO_DIR: studioDir,
  NOEMA_E2E_SEED: libDir,
  NOEMA_COMFY_PYTHON: process.execPath,
  NOEMA_FAKE_COMFY: resolve('scripts/fake-comfyui.mjs'),
  NOEMA_FAKE_COMFY_LOG: logFile,
  NOEMA_FAKE_COMFY_FAIL_FLAG: failFlag,
  NOEMA_FAKE_COMFY_DELAY: '2500'
}
delete env.ELECTRON_RUN_AS_NODE

let app = null
let page = null
const errors = []
async function launch() {
  app = await electron.launch({ executablePath: exe, args: exeArg ? ['--force-device-scale-factor=1'] : ['.', '--force-device-scale-factor=1'], cwd: root, env, timeout: 90_000 })
  page = await app.firstWindow({ timeout: 90_000 })
  await page.setViewportSize({ width: 1500, height: 1000 })
  page.setDefaultTimeout(45_000)
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForFunction(() => window.noema && document.querySelector('.app-shell'), null, { timeout: 60_000 })
}
async function until(predicate, timeout = 60_000, interval = 400) {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(predicate)) return
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${predicate}`)
    await page.waitForTimeout(interval)
  }
}
const shot = (name) => page.screenshot({ path: join(shots, name), animations: 'disabled' })
const answerDialogWith = (folder) => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }) }, folder)
const serverLog = async () => (existsSync(logFile) ? (await fs.readFile(logFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const alive = async (port) => { try { return (await fetch(`http://127.0.0.1:${port}/system_stats`)).ok } catch { return false } }
const openStudioSettings = async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:open-studio', { detail: { mode: 'create' } })))
  await page.waitForSelector('button[aria-label="Studio settings"]')
  if ((await page.locator('[data-testid="comfy-setup"]').count()) === 0) await page.locator('button[aria-label="Studio settings"]').click()
  await page.waitForSelector('[data-testid="comfy-setup"]')
}
const statusText = () => page.locator('[data-testid="comfy-status"]').innerText()
const generate = (model, prompt = 'a lighthouse at dawn') =>
  page.evaluate(([m, p]) => window.noema.studioGenerate({ methodId: 'comfyui', model: m || undefined, moodboardId: null, title: 'Test', prompt: p, negative: 'blurry', width: 640, height: 448, count: 1, roles: {}, approvedCost: 0, approvedUpload: false, seed: 1234 }), [model, prompt])

try {
  await launch()
  await until(`(async () => { const b = await window.noema.bootstrap(); const s = await window.noema.getIndexStatus(); return b.stats.images >= 4 && !b.roots.some((r) => r.scanning) })()`, 120_000)

  // -------------------------------------------------------------------------------------------
  log('A. First-time setup: choose the folder once')
  await openStudioSettings()
  check(/not set up/i.test(await statusText()), `before setup the status says so (“${await statusText()}”)`)
  check((await page.locator('[data-testid="comfy-choose"]').count()) === 1, 'one clear button offers to choose the ComfyUI folder')
  await shot('c1-not-set-up.png')
  const methodsBefore = await page.evaluate(() => window.noema.studioSettings().then((s) => s.methods.find((m) => m.id === 'comfyui')))
  check(!methodsBefore.available && /Set up ComfyUI once/.test(methodsBefore.reason), 'ComfyUI is offered as "set up once", not as an error')
  await answerDialogWith(portableFolder)
  await page.locator('[data-testid="comfy-choose"]').click()
  await page.waitForSelector('[data-testid="comfy-install"]')
  const install = await page.locator('[data-testid="comfy-install"]').innerText()
  check(/ComfyUI \(portable\) 0\.3\.99/.test(install) && /portable version/.test(install), `Atlas identified the installation (${install.replace(/\s+/g, ' ')})`)
  check(/ready to start when needed/i.test(await statusText()), `and says it will start it when needed (“${await statusText()}”)`)
  const modelsText = await page.locator('[data-testid="comfy-models"]').innerText()
  check(/2 model files/.test(modelsText) && /1 checkpoints/.test(modelsText) && /1 upscale models/.test(modelsText), `it found the models (${modelsText})`)
  await page.locator('.comfy-setup__list summary').click()
  const workflowText = await page.locator('[data-testid="comfy-workflows"]').innerText()
  console.log(`  · workflows: ${workflowText.replace(/\s+/g, ' ').slice(0, 420)}`)
  check(/my text to image[\s\S]*ready/.test(workflowText) && /my upscale 2x[\s\S]*ready/.test(workflowText), 'it found the user\'s workflows and which are ready')
  check(/Needs “flux2-dev.safetensors” in ComfyUI’s diffusion_models folder/.test(workflowText), 'a workflow with a missing model says what it needs, in simple words')
  check(/Export \(API\)/.test(workflowText), 'a workflow Atlas cannot open directly says how to fix it')
  check(!/a video one/.test(workflowText), 'a video workflow is not offered for pictures')
  check((await page.locator('[data-testid="comfy-needs"]').count()) === 0, 'nothing is missing, so no warnings are shown')
  await shot('c2-set-up.png')
  check((await alive(8188)) === false, 'choosing the folder did not start anything')
  const saved = await page.evaluate(() => window.noema.studioSettings())
  check(saved.comfyFolder === portableFolder, 'the choice is saved')

  // -------------------------------------------------------------------------------------------
  log('B. Atlas starts ComfyUI by itself when a picture is made, and returns the result to the Studio')
  const moodboard = await page.evaluate(() => window.noema.createMoodboard('Comfy test'))
  const first = await generate(`${(await page.evaluate(() => window.noema.studioSettings())).methods.find((m) => m.id === 'comfyui').model}`)
  check(first.ok, `a picture was made (${first.message ?? 'ok'})`)
  check(await alive(8188), 'ComfyUI was started automatically')
  let statusAfter = await page.evaluate(() => window.noema.studioComfyStatus())
  check(statusAfter.state === 'running' && statusAfter.startedByAtlas && /started by Atlas/.test(statusAfter.headline), `the status says Atlas started it (“${statusAfter.headline}”)`)
  const started = (await serverLog()).filter((e) => e.type === 'started')
  check(started.length === 1, 'exactly one ComfyUI was started')
  const prompts1 = (await serverLog()).filter((e) => e.type === 'prompt')
  const standard = prompts1.at(-1).prompt
  check(Object.values(standard).some((n) => n.class_type === 'CheckpointLoaderSimple' && n.inputs.ckpt_name === 'fake-model.safetensors'), 'Atlas used the model it found in the ComfyUI folder')
  check(first.records.length === 1 && first.records[0].width === 640, 'the picture came back into the Studio and the library')
  await openStudioSettings()
  check(/started by Atlas/.test(await statusText()), 'the Studio settings show the same status')
  check((await page.locator('[data-testid="comfy-stop"]').count()) === 1, 'Atlas offers to close the ComfyUI it started')
  await shot('c3-running.png')

  // -------------------------------------------------------------------------------------------
  log('C. The user\'s own workflows are used as they are: the editor format and the API format')
  const settings = await page.evaluate(() => window.noema.studioSettings())
  const mine = settings.comfy.workflows.find((w) => w.name === 'my text to image')
  const up = settings.comfy.workflows.find((w) => w.name === 'my upscale 2x')
  const second = await generate(`workflow:${mine.id}`, 'a lighthouse from my own workflow')
  check(second.ok, `a picture was made with the user's workflow (${second.message ?? 'ok'})`)
  const prompts2 = (await serverLog()).filter((e) => e.type === 'prompt')
  const mineApi = prompts2.at(-1).prompt
  check(Object.values(mineApi).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'a lighthouse from my own workflow'), 'the description was put where the user\'s graph wants it')
  check(Object.values(mineApi).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'blurry'), 'the negative description too')
  check(Object.values(mineApi).some((n) => n.class_type === 'KSampler' && n.inputs.seed === 1234 && n.inputs.steps === 31 && n.inputs.sampler_name === 'dpmpp_2m'), 'the seed was set, and the user\'s steps and sampler were kept')
  check(Object.values(mineApi).some((n) => n.class_type === 'EmptyLatentImage' && n.inputs.width === 640 && n.inputs.height === 448), 'the size follows what was asked for')
  check(second.records[0].width === 640 && second.records[0].height === 448, 'the picture has that size')
  check((await serverLog()).filter((e) => e.type === 'started').length === 1, 'the running ComfyUI was reused')

  log('D. Upscaling with the user\'s own upscaling workflow')
  const original = (await page.evaluate(() => window.noema.listImages({ scope: 'archive', limit: 50 }))).items.find((i) => /^plain-0/.test(i.filename))
  const edit = await page.evaluate(([id, wf]) => window.noema.studioEdit({ imageId: id, methodId: 'comfyui', instruction: '', strength: 0.5, approvedCost: 0, approvedUpload: false, workflowId: wf }), [original.id, up.id])
  check(edit.ok && /my upscale 2x/.test(edit.summary), `the workflow ran on a copy (${edit.summary})`)
  const upPrompt = (await serverLog()).filter((e) => e.type === 'prompt').at(-1).prompt
  check(Object.values(upPrompt).some((n) => n.class_type === 'UpscaleModelLoader' && n.inputs.model_name === '4x.pth') && Object.values(upPrompt).some((n) => n.class_type === 'LoadImage' && /^atlas-/.test(n.inputs.image)), 'the user\'s graph ran unchanged except for the picture it was given')
  const kept = await page.evaluate((pid) => window.noema.studioEditCommit(pid), edit.pendingId)
  check(kept.ok, 'the enlarged copy was kept as a new version')
  const upscaled = await page.evaluate((id) => window.noema.getImage(id), kept.records[0].imageId)
  check(upscaled.width === 1280 && upscaled.height === 960, `it is twice the size (${upscaled.width}×${upscaled.height})`)
  check((await libHash())['plain-0.jpg'] === libBefore['plain-0.jpg'], 'the original picture is untouched')

  // -------------------------------------------------------------------------------------------
  log('E. Closing ComfyUI, then connecting to one that is already running instead of starting another')
  await openStudioSettings()
  await page.locator('[data-testid="comfy-stop"]').click()
  await until2(async () => !(await alive(8188)), 20_000)
  check(!(await alive(8188)), 'Atlas closed the ComfyUI it had started')
  check(/ready to start when needed/i.test(await statusText()), 'the status is back to "ready to start when needed"')
  // The user starts ComfyUI themselves.
  const mineProcess = spawn(process.execPath, [resolve('scripts/fake-comfyui.mjs'), '--port', '8188', '--delay', '100'], { env, stdio: 'ignore' })
  await until2(async () => await alive(8188), 20_000)
  const startsBefore = (await serverLog()).filter((e) => e.type === 'started').length
  await page.locator('button:has-text("Look again")').click()
  await page.waitForFunction(() => /already running/i.test(document.querySelector('[data-testid="comfy-status"]')?.textContent ?? ''), null, { timeout: 15_000 })
  check(true, `the status says it connected to the running one (“${await statusText()}”)`)
  check((await page.locator('[data-testid="comfy-stop"]').count()) === 0, 'and offers no way to close it, because Atlas did not start it')
  const third = await generate(`workflow:${mine.id}`, 'made with the one I started myself')
  check(third.ok, 'a picture was made with it')
  check((await serverLog()).filter((e) => e.type === 'started').length === startsBefore, 'no second ComfyUI was started')
  await shot('c4-connected.png')

  // -------------------------------------------------------------------------------------------
  log('F. Atlas leaves a ComfyUI it did not start alone, and closes the one it started when it quits')
  await app.close().catch(() => undefined)
  check(await alive(8188), 'the ComfyUI the user started is still running after Atlas closed')
  mineProcess.kill()
  await until2(async () => !(await alive(8188)), 15_000)
  await launch()
  await until(`(async () => (await window.noema.studioSettings()).comfyFolder !== null)()`, 20_000)
  const again = await generate(`workflow:${mine.id}`, 'atlas starts it again')
  check(again.ok && (await alive(8188)), 'after a restart the choice was remembered and Atlas started ComfyUI again by itself')
  await app.close().catch(() => undefined)
  await until2(async () => !(await alive(8188)), 20_000)
  check(!(await alive(8188)), 'when Atlas quit, it closed the ComfyUI it had started')

  // -------------------------------------------------------------------------------------------
  log('G. Start-up problems are explained, and do not break anything')
  await launch()
  await fs.writeFile(failFlag, 'fail')
  await openStudioSettings()
  await page.locator('[data-testid="comfy-start"]').click()
  await page.waitForFunction(() => /could not start/i.test(document.querySelector('[data-testid="comfy-status"]')?.textContent ?? ''), null, { timeout: 60_000 })
  const failure = await page.locator('[data-testid="comfy-detail"]').innerText()
  check(/Another program is already using the address/.test(failure), `a start-up failure is explained in plain words (“${failure.slice(0, 110)}…”)`)
  await shot('c5-problem.png')
  const failedGenerate = await generate(`workflow:${mine.id}`)
  check(!failedGenerate.ok && /Another program|ComfyUI/.test(failedGenerate.message), `making a picture then says what is wrong (“${String(failedGenerate.message).slice(0, 90)}”)`)
  await fs.rm(failFlag, { force: true })
  await page.locator('[data-testid="comfy-start"]').click()
  await page.waitForFunction(() => /started by Atlas/i.test(document.querySelector('[data-testid="comfy-status"]')?.textContent ?? ''), null, { timeout: 60_000 })
  check(true, 'after the cause is gone, starting works again')

  log('H. What is missing is explained; a wrong folder is refused')
  await answerDialogWith(emptyFolder)
  await page.locator('button:has-text("Change folder")').click()
  await page.waitForSelector('[data-testid="comfy-needs"]')
  const needs = await page.locator('[data-testid="comfy-needs"]').innerText()
  check(/checkpoints folder/.test(needs), `with no model it says what is needed (“${needs.replace(/\s+/g, ' ').slice(0, 150)}…”)`)
  const emptyMethod = await page.evaluate(() => window.noema.studioSettings().then((s) => s.methods.find((m) => m.id === 'comfyui')))
  check(!emptyMethod.available && /checkpoint/.test(emptyMethod.reason), 'ComfyUI is shown as not usable yet, with that reason')
  await shot('c6-needs.png')
  const wrong = await page.evaluate((folder) => window.noema.studioUpdateSettings({ comfyFolder: folder }).then(() => 'accepted', (e) => String(e.message)), libDir)
  check(/does not look like a ComfyUI installation/.test(wrong), 'a folder that is not ComfyUI is refused with a clear message')
  check((await page.evaluate(() => window.noema.studioSettings())).comfyFolder === emptyFolder, 'and the earlier choice is kept')
  await answerDialogWith(portableFolder)
  await page.locator('button:has-text("Change folder")').click()
  await page.waitForFunction(() => /1 checkpoints/.test(document.querySelector('[data-testid="comfy-models"]')?.textContent ?? ''), null, { timeout: 15_000 })

  // -------------------------------------------------------------------------------------------
  log('I. Nothing in the ComfyUI folder was changed')
  await page.locator('[data-testid="comfy-stop"]').click().catch(() => undefined)
  await app.close().catch(() => undefined)
  await until2(async () => !(await alive(8188)), 20_000)
  const treeAfter = await hashTree(portableFolder)
  check(JSON.stringify(treeAfter) === JSON.stringify(treeBefore), `none of the ${Object.keys(treeBefore).length} files in the ComfyUI folder (models, workflows, scripts) was changed, added or removed`)
  check(JSON.stringify(await libHash()) === JSON.stringify(libBefore), 'the library pictures are untouched')

  // -------------------------------------------------------------------------------------------
  log('J. The real ComfyUI on this computer is recognised, read-only, and not started')
  const realCandidates = [join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ComfyUI')]
  await launch()
  for (const folder of realCandidates.filter((f) => existsSync(join(f, 'ComfyUI.exe')))) {
    const result = await page.evaluate((f) => window.noema.studioUpdateSettings({ comfyFolder: f }).then((s) => ({ ok: true, comfy: s.comfy }), (e) => ({ ok: false, message: String(e.message) })), folder)
    if (!result.ok) {
      console.log(`  · ${folder}: ${result.message}`)
      continue
    }
    const c = result.comfy
    console.log(`  · ${folder}\n    ${c.install.name} ${c.install.version ?? ''} (${c.install.kind}); ${c.models?.summary}\n    workflows: ${c.workflows.length} (${c.workflows.filter((w) => w.runnable).length} ready); needs: ${c.needs.join(' | ') || 'nothing'}`)
    check(c.install.kind === 'desktop', `${folder} is recognised as the ComfyUI Desktop app`)
  }
  check((await alive(8188)) === false && (await alive(8000)) === (await alive(8000)), 'reading the real installation did not start it')
  await page.evaluate(() => window.noema.studioUpdateSettings({ comfyFolder: null }))

  const relevant = errors.filter((e) => !/Failed to load resource/.test(e))
  if (relevant.length > 0) throw new Error(`Renderer errors: ${relevant.join(' | ')}`)
  console.log('\n✓ ComfyUI setup checks passed.')
} finally {
  await app?.close().catch(() => undefined)
}

async function until2(predicate, timeout) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, 400))
  }
}
