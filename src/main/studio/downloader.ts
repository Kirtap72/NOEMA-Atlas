import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<Response>

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable = false
  ) {
    super(message)
  }
}

export interface DownloadOptions {
  url: string
  dest: string
  /** Lower-case hex SHA-256. When given, the finished file must match it or it is thrown away. */
  sha256?: string | null
  size?: number | null
  fetchImpl?: FetchFn
  signal?: AbortSignal
  onProgress?: (done: number, total: number | null) => void
  /** How many times a dropped connection is retried before giving up. */
  retries?: number
  retryDelayMs?: number
}

export const partPath = (dest: string): string => `${dest}.part`

export async function sha256Of(path: string, onProgress?: (done: number) => void): Promise<string> {
  const hash = createHash('sha256')
  let done = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    done += (chunk as Buffer).length
    onProgress?.(done)
  }
  return hash.digest('hex')
}

/**
 * Downloads one file so that an interruption never costs the whole thing: the data goes to `<name>.part` and continues from
 * where it stopped (HTTP Range) after a dropped connection, a stop or a restart of Atlas. The finished file is checked
 * against its size and SHA-256 before it gets its real name, so a half-finished or damaged file is never mistaken for a model.
 */
export async function download(options: DownloadOptions): Promise<{ path: string; bytes: number; sha256: string | null; resumedFrom: number; reused: boolean }> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit))
  const retries = options.retries ?? 4
  mkdirSync(dirname(options.dest), { recursive: true })
  const part = partPath(options.dest)
  const expected = options.sha256?.toLowerCase() ?? null

  // Already there and correct: nothing to do.
  const previous = existsSync(options.dest) ? statSync(options.dest) : null
  if (previous) {
    const have = statSync(options.dest).size
    if (!options.size || have === options.size) {
      if (!expected || (await sha256Of(options.dest)) === expected) {
        options.onProgress?.(have, have)
        return { path: options.dest, bytes: have, sha256: expected, resumedFrom: have, reused: true }
      }
    }
  }

  let resumedFrom = existsSync(part) ? statSync(part).size : 0
  const first = resumedFrom
  let attempt = 0
  for (;;) {
    if (options.signal?.aborted) throw new DownloadError('Stopped.')
    try {
      const have = existsSync(part) ? statSync(part).size : 0
      resumedFrom = have
      const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {}
      const response = await fetchImpl(options.url, { headers, signal: options.signal, redirect: 'follow' })
      if (response.status === 416) {
        // The part file is already complete (or wrong); fall through to verification.
      } else if (!response.ok) {
        throw new DownloadError(`The download server answered ${response.status}.`, response.status >= 500 || response.status === 429)
      } else {
        const partial = response.status === 206
        if (have > 0 && !partial) rmSync(part, { force: true })
        const start = have > 0 && partial ? have : 0
        const length = Number(response.headers.get('content-length') ?? 0)
        const total = options.size ?? (length > 0 ? start + length : null)
        let done = start
        options.onProgress?.(done, total)
        if (!response.body) throw new DownloadError('The download server sent nothing.', true)
        const out = createWriteStream(part, { flags: start > 0 ? 'a' : 'w' })
        const source = Readable.fromWeb(response.body as never)
        source.on('data', (chunk: Buffer) => {
          done += chunk.length
          options.onProgress?.(done, total)
        })
        await pipeline(source, out, { signal: options.signal })
      }
      const bytes = statSync(part).size
      if (options.size && bytes !== options.size) {
        if (bytes > options.size) {
          rmSync(part, { force: true })
          throw new DownloadError('The downloaded file is larger than expected. It was discarded; try again.', true)
        }
        throw new DownloadError('The connection ended early.', true)
      }
      let digest: string | null = null
      if (expected) {
        digest = await sha256Of(part)
        if (digest !== expected) {
          rmSync(part, { force: true })
          throw new DownloadError('The downloaded file does not match its published checksum, so it was thrown away. Try again.', false)
        }
      }
      if (previous && existsSync(options.dest)) {
        const current = statSync(options.dest)
        if (previous.ino !== current.ino || previous.mtimeMs !== current.mtimeMs || previous.size !== current.size) throw new DownloadError('The destination changed during the download. Both files were kept.')
        renameSync(options.dest, options.dest + '.previous-' + randomUUID())
      }
      try {
        linkSync(part, options.dest)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DownloadError('The destination is occupied. Both files were kept.')
        copyFileSync(part, options.dest, constants.COPYFILE_EXCL)
      }
      rmSync(part)
      return { path: options.dest, bytes, sha256: digest, resumedFrom: first, reused: false }
    } catch (error) {
      if (options.signal?.aborted) throw new DownloadError('Stopped.')
      const retryable = error instanceof DownloadError ? error.retryable : true
      if (!retryable || attempt >= retries) {
        if (error instanceof DownloadError) throw error
        throw new DownloadError(`The download was interrupted (${error instanceof Error ? error.message : 'network problem'}). Starting it again continues where it stopped.`)
      }
      attempt += 1
      await new Promise((r) => setTimeout(r, (options.retryDelayMs ?? 1500) * attempt))
    }
  }
}
