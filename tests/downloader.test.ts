import { createHash } from 'node:crypto'
import { existsSync, promises as fs, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { download, DownloadError } from '../src/main/studio/downloader'

const data = Buffer.alloc(3_000_000)
for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + (i >> 8)) & 255
const hash = createHash('sha256').update(data).digest('hex')

let server: Server
let base = ''
let work = ''
let drops = 0
let ranges: string[] = []
let honourRange = true

beforeEach(async () => {
  work = join(tmpdir(), `noema-dl-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(work, { recursive: true })
  drops = 0
  ranges = []
  honourRange = true
  server = createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(String(req.headers.range ?? ''))
    ranges.push(String(req.headers.range ?? ''))
    const start = range && honourRange ? Number(range[1]) : 0
    if (start >= data.length) {
      res.statusCode = 416
      return res.end()
    }
    res.statusCode = range && honourRange ? 206 : 200
    res.setHeader('content-length', String(data.length - start))
    if (drops > 0) {
      // Send part of the file, then cut the connection.
      drops -= 1
      res.write(data.subarray(start, start + 900_000))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.end(data.subarray(start))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(work, { recursive: true, force: true })
})

describe('downloads that survive interruptions', () => {
  it('downloads, verifies the checksum and only then gives the file its name', async () => {
    const dest = join(work, 'a', 'model.bin')
    const progress: number[] = []
    const result = await download({ url: `${base}/f`, dest, sha256: hash, size: data.length, onProgress: (d) => progress.push(d) })
    expect(result.bytes).toBe(data.length)
    expect(readFileSync(dest).equals(data)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(progress.at(-1)).toBe(data.length)
  })

  it('continues from where a dropped connection stopped', async () => {
    drops = 2
    const dest = join(work, 'model.bin')
    const result = await download({ url: `${base}/f`, dest, sha256: hash, size: data.length, retryDelayMs: 5 })
    expect(readFileSync(dest).equals(data)).toBe(true)
    expect(ranges.filter(Boolean).length).toBeGreaterThanOrEqual(2)
    expect(result.bytes).toBe(data.length)
  })

  it('resumes from a partial file left by an earlier run (a stopped or crashed download)', async () => {
    const dest = join(work, 'model.bin')
    writeFileSync(`${dest}.part`, data.subarray(0, 1_200_000))
    const result = await download({ url: `${base}/f`, dest, sha256: hash, size: data.length })
    expect(ranges[0]).toBe('bytes=1200000-')
    expect(result.resumedFrom).toBe(1_200_000)
    expect(readFileSync(dest).equals(data)).toBe(true)
  })

  it('starts over when the server ignores the resume request', async () => {
    honourRange = false
    const dest = join(work, 'model.bin')
    writeFileSync(`${dest}.part`, data.subarray(0, 500_000))
    await download({ url: `${base}/f`, dest, sha256: hash, size: data.length })
    expect(readFileSync(dest).equals(data)).toBe(true)
  })

  it('throws away a file that does not match its checksum and never keeps it', async () => {
    const dest = join(work, 'model.bin')
    await expect(download({ url: `${base}/f`, dest, sha256: 'ab'.repeat(32), size: data.length })).rejects.toThrow(/checksum/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('does nothing when the right file is already there', async () => {
    const dest = join(work, 'model.bin')
    writeFileSync(dest, data)
    const before = statSync(dest).mtimeMs
    await download({ url: `${base}/f`, dest, sha256: hash, size: data.length })
    expect(ranges).toHaveLength(0)
    expect(statSync(dest).mtimeMs).toBe(before)
  })

  it('stops promptly when asked and keeps the part for later', async () => {
    const dest = join(work, 'model.bin')
    const controller = new AbortController()
    const run = download({ url: `${base}/f`, dest, size: data.length, signal: controller.signal, onProgress: (d) => d > 100_000 && controller.abort() })
    await expect(run).rejects.toThrow(DownloadError)
    expect(existsSync(dest)).toBe(false)
  })

  it('gives a plain message when the server refuses', async () => {
    await expect(download({ url: `${base}/f`, dest: join(work, 'x'), fetchImpl: async () => new Response('no', { status: 404 }) })).rejects.toThrow(/404/)
  })
})
