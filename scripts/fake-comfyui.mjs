// A stand-in for ComfyUI's HTTP server, for testing Atlas's ComfyUI setup without a GPU or real models.
// It speaks the parts of the API Atlas uses (system_stats, object_info, upload, prompt, history, view) and makes real
// pictures with sharp: a colour field from the seed and prompt, or a 2x enlargement of the uploaded picture when the
// workflow upscales. Everything it receives is appended to the file named by NOEMA_FAKE_COMFY_LOG.
//
//   node scripts/fake-comfyui.mjs --port 8188 [--delay 2500]
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const port = Number(arg('--port', '8188'))
const delay = Number(arg('--delay', process.env.NOEMA_FAKE_COMFY_DELAY ?? '1500'))
const logFile = process.env.NOEMA_FAKE_COMFY_LOG ?? ''
const failFlag = process.env.NOEMA_FAKE_COMFY_FAIL_FLAG ?? ''
if (logFile) mkdirSync(dirname(logFile), { recursive: true })
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`)
}

console.log('** ComfyUI (stand-in) **')
console.log('Import times for custom nodes: 0.0 seconds')
if (failFlag && existsSync(failFlag)) {
  console.error('OSError: [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted')
  log({ type: 'failed-start' })
  process.exit(1)
}

const files = new Map()
const history = new Map()

const text = (name) => [name, { multiline: true }]
const NODE_INFO = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['fake-model.safetensors']] } }, output_node: false },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } } },
  KSampler: {
    input: { required: { model: ['MODEL'], seed: ['INT', { control_after_generate: true }], steps: ['INT', {}], cfg: ['FLOAT', {}], sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT', {}] } }
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } }, output_node: true },
  LoadImage: { input: { required: { image: [['example.png']] } } },
  UpscaleModelLoader: { input: { required: { model_name: [['4x.pth']] } } },
  ImageUpscaleWithModel: { input: { required: { upscale_model: ['UPSCALE_MODEL'], image: ['IMAGE'] } } },
  VAEEncode: { input: { required: { pixels: ['IMAGE'], vae: ['VAE'] } } },
  ImageScale: { input: { required: { image: ['IMAGE'], upscale_method: [['lanczos']], width: ['INT', {}], height: ['INT', {}], crop: [['center']] } } }
}

async function render(prompt) {
  const nodes = Object.values(prompt)
  const loader = Object.values(prompt).find((n) => n.class_type === 'LoadImage')
  const upscale = nodes.some((n) => n.class_type === 'ImageUpscaleWithModel')
  if (upscale && loader && files.has(loader.inputs.image)) {
    const source = files.get(loader.inputs.image)
    const meta = await sharp(source).metadata()
    return sharp(source).resize((meta.width ?? 64) * 2, (meta.height ?? 64) * 2, { kernel: 'lanczos3' }).png().toBuffer()
  }
  const latent = nodes.find((n) => /^Empty.*Latent/.test(n.class_type))
  const width = Math.max(64, Math.min(1024, Number(latent?.inputs.width ?? 512)))
  const height = Math.max(64, Math.min(1024, Number(latent?.inputs.height ?? 512)))
  const sampler = nodes.find((n) => n.class_type === 'KSampler')
  const words = nodes.filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs.text).join('|')
  const h = createHash('sha1').update(`${sampler?.inputs.seed ?? 0}:${words}`).digest()
  return sharp({ create: { width, height, channels: 3, background: { r: h[0], g: h[1], b: h[2] } } })
    .composite([{ input: await sharp({ create: { width: Math.round(width / 2), height: Math.round(height / 2), channels: 3, background: { r: h[3], g: h[4], b: h[5] } } }).png().toBuffer(), left: Math.round(width / 4), top: Math.round(height / 4) }])
    .png()
    .toBuffer()
}

const send = (res, status, body, type = 'application/json') => {
  res.statusCode = status
  res.setHeader('content-type', type)
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  try {
    if (url.pathname === '/system_stats') return send(res, 200, { system: { os: 'nt', comfyui_version: 'fake' }, devices: [{ name: 'fake gpu' }] })
    if (url.pathname === '/object_info') return send(res, 200, NODE_INFO)
    if (url.pathname.startsWith('/object_info/')) {
      const name = url.pathname.slice('/object_info/'.length)
      return send(res, 200, NODE_INFO[name] ? { [name]: NODE_INFO[name] } : {})
    }
    if (url.pathname === '/upload/image' && req.method === 'POST') {
      const request = new Request(`http://x${req.url}`, { method: 'POST', headers: req.headers, body: req, duplex: 'half' })
      const form = await request.formData()
      const file = form.get('image')
      const name = file.name
      files.set(name, Buffer.from(await file.arrayBuffer()))
      log({ type: 'upload', name, bytes: files.get(name).length })
      return send(res, 200, { name, subfolder: '', type: 'input' })
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const { prompt } = JSON.parse(body)
      const id = randomUUID()
      log({ type: 'prompt', prompt })
      const buffer = await render(prompt)
      const outputs = {}
      for (const [nodeId, node] of Object.entries(prompt)) {
        if (node.class_type === 'SaveImage') {
          const filename = `fake_${id.slice(0, 8)}_${nodeId}.png`
          files.set(filename, buffer)
          outputs[nodeId] = { images: [{ filename, subfolder: '', type: 'output' }] }
        }
      }
      history.set(id, { outputs, status: { status_str: 'success' } })
      return send(res, 200, { prompt_id: id })
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length)
      return send(res, 200, history.has(id) ? { [id]: history.get(id) } : {})
    }
    if (url.pathname === '/view') {
      const file = files.get(url.searchParams.get('filename') ?? '')
      return file ? send(res, 200, file, 'image/png') : send(res, 404, { error: 'no such file' })
    }
    if (url.pathname === '/interrupt') return send(res, 200, {})
    return send(res, 404, { error: 'not found' })
  } catch (error) {
    log({ type: 'error', message: String(error) })
    return send(res, 500, { error: String(error) })
  }
})

setTimeout(() => {
  server.listen(port, '127.0.0.1', () => {
    console.log(`Starting server on 127.0.0.1:${port}`)
    log({ type: 'started', port })
  })
}, delay)
process.on('SIGTERM', () => process.exit(0))
