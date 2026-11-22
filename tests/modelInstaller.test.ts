import { createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelInstaller } from '../src/main/modelInstaller'
import type { ModelStatus } from '../src/shared/types'

// Fake model files with the real names, so the installer's "is it installed" check applies unchanged.
const CONTENT: Record<string, Buffer> = {
  'tokenizer_config.json': randomBytes(400),
  'tokenizer.json': randomBytes(30_000),
  'vision_model_fp16.onnx': randomBytes(300_000),
  'text_model_fp16.onnx': randomBytes(250_000)
}
const FILES = Object.entries(CONTENT).map(([local, data]) => ({
  remote: local.endsWith('.onnx') ? `onnx/${local}` : local,
  local,
  size: data.length,
  sha256: createHash('sha256').update(data).digest('hex')
}))
const bodyFor = (url: string): Buffer | undefined => CONTENT[url.split('/').pop() ?? '']

let workDir = ''
let server: Server | null = null
let baseUrl = ''
let handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean | void = () => undefined
const requests: Array<{ url: string; range?: string }> = []

beforeEach(async () => {
  workDir = join(tmpdir(), `noema-model-test-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(workDir, { recursive: true })
  requests.length = 0
  handler = () => undefined
  server = createServer((req, res) => {
    const body = bodyFor(req.url ?? '')
    requests.push({ url: req.url ?? '', range: req.headers.range })
    if (handler(req, res, body ?? Buffer.alloc(0))) return
    if (!body) {
      res.writeHead(404).end()
      return
    }
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    if (range) {
      const start = Number(range[1])
      res.writeHead(206, { 'Content-Length': body.length - start }).end(body.subarray(start))
    } else {
      res.writeHead(200, { 'Content-Length': body.length }).end(body)
    }
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server?.closeAllConnections?.()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function installer(overrides: { baseUrl?: string; choice?: ModelStatus['choice'] } = {}) {
  const statuses: ModelStatus[] = []
  const instance = new ModelInstaller({
    modelDir: join(workDir, 'models', 'siglip'),
    choice: () => overrides.choice ?? 'unset',
    onStatus: (s) => statuses.push(s),
    baseUrl: overrides.baseUrl ?? baseUrl,
    files: FILES,
    retryDelayMs: 5
  })
  return { instance, statuses }
}

describe('ModelInstaller', () => {
  it('downloads, verifies and installs the model with steadily rising progress', async () => {
    const { instance, statuses } = installer()
    expect(instance.status.installed).toBe(false)
    expect(instance.status.totalBytes).toBe(FILES.reduce((n, f) => n + f.size, 0))
    await instance.install()
    expect(instance.status.state).toBe('installed')
    expect(instance.status.installed).toBe(true)
    expect(instance.status.receivedBytes).toBe(instance.status.totalBytes)
    for (const spec of FILES) {
      expect(await fs.readFile(join(workDir, 'models', 'siglip', spec.local))).toEqual(CONTENT[spec.local])
    }
    const files = await fs.readdir(join(workDir, 'models', 'siglip'))
    expect(files.some((name) => name.endsWith('.part'))).toBe(false)
    const received = statuses.filter((s) => s.state === 'downloading').map((s) => s.receivedBytes)
    expect(received.length).toBeGreaterThan(1)
    expect([...received].sort((a, b) => a - b)).toEqual(received)

    // Installing again is a no-op and makes no requests.
    const before = requests.length
    await instance.install()
    expect(requests.length).toBe(before)
  })

  it('resumes a partial download with a Range request', async () => {
    const big = FILES.find((f) => f.local === 'vision_model_fp16.onnx')!
    const dir = join(workDir, 'models', 'siglip')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, `${big.local}.part`), CONTENT[big.local]!.subarray(0, 120_000))
    const { instance } = installer()
    await instance.install()
    expect(requests.find((r) => r.url.endsWith(big.local))?.range).toBe('bytes=120000-')
    expect(await fs.readFile(join(dir, big.local))).toEqual(CONTENT[big.local])
  })

  it('retries a temporary server error and then succeeds', async () => {
    let failures = 0
    handler = (_req, res) => {
      if (failures < 2) {
        failures += 1
        res.writeHead(503).end()
        return true
      }
    }
    const { instance } = installer()
    await instance.install()
    expect(instance.status.installed).toBe(true)
    expect(failures).toBe(2)
  })

  it('rejects a corrupted download, deletes it and reports a clear error', async () => {
    handler = (_req, res, body) => {
      const bad = Buffer.from(body)
      bad[0] = bad[0]! ^ 0xff
      res.writeHead(200, { 'Content-Length': bad.length }).end(bad)
      return true
    }
    const { instance } = installer()
    await expect(instance.install()).rejects.toThrow()
    expect(instance.status.state).toBe('error')
    expect(instance.status.error).toMatch(/integrity check/)
    expect(instance.status.installed).toBe(false)
    const files = await fs.readdir(join(workDir, 'models', 'siglip'))
    expect(files).toEqual([])
  })

  it('explains a missing file and an unreachable server without retrying forever', async () => {
    handler = (_req, res) => {
      res.writeHead(404).end()
      return true
    }
    const missing = installer()
    await expect(missing.instance.install()).rejects.toThrow()
    expect(missing.instance.status.error).toMatch(/no longer available/)
    expect(requests.length).toBe(1)

    const offline = installer({ baseUrl: 'http://127.0.0.1:1' })
    await expect(offline.instance.install()).rejects.toThrow()
    expect(offline.instance.status.state).toBe('error')
    expect(offline.instance.status.error).toMatch(/internet connection|download failed/)
  })

  it('can be cancelled mid-download, keeps the partial file, and later resumes', async () => {
    let stall = true
    handler = (req, res, body) => {
      if (stall && req.url?.endsWith('vision_model_fp16.onnx')) {
        res.writeHead(200, { 'Content-Length': body.length })
        res.write(body.subarray(0, 50_000))
        return true // never finishes
      }
    }
    const { instance } = installer()
    const done = instance.install()
    done.catch(() => undefined)
    for (let i = 0; i < 150 && instance.status.receivedBytes < 50_000; i += 1) await new Promise((r) => setTimeout(r, 20))
    instance.cancel()
    await expect(done).rejects.toThrow()
    expect(instance.status.state).toBe('cancelled')
    expect(instance.status.error).toBeNull()
    expect(instance.status.installed).toBe(false)
    const part = await fs.stat(join(workDir, 'models', 'siglip', 'vision_model_fp16.onnx.part'))
    expect(part.size).toBeGreaterThan(0)

    stall = false
    const again = installer()
    await again.instance.install()
    expect(again.instance.status.installed).toBe(true)
  })

  it('removes the model files', async () => {
    const { instance } = installer()
    await instance.install()
    await instance.remove()
    expect(instance.status.installed).toBe(false)
    expect(instance.status.state).toBe('idle')
    expect(await fs.readdir(join(workDir, 'models', 'siglip'))).toEqual([])
  })
})
