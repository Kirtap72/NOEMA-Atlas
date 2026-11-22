import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { missingModelFiles } from './embedder'
import type { ModelInstallState, ModelStatus } from '../shared/types'

/** The model Atlas offers to download, pinned by size and SHA-256 so a changed or corrupted file is never used. */
export const MODEL_REPO = 'Xenova/siglip-base-patch16-224'
export const MODEL_FILE_SPECS = [
  { remote: 'tokenizer_config.json', local: 'tokenizer_config.json', size: 739, sha256: '9a38d3c6b5e26fe5dcc607eda95e38d78d30d9291835bb9e8116e8174c1d4ba2' },
  { remote: 'tokenizer.json', local: 'tokenizer.json', size: 2_398_744, sha256: '4a17c975210be5ab4c36b47d8dae4eefb866dbfb1e676e394aad85dc30a3ae08' },
  { remote: 'onnx/vision_model_fp16.onnx', local: 'vision_model_fp16.onnx', size: 186_142_673, sha256: '7287a8e9cbf4f2eedd66e8dc5cf584be03108f4e4a24331879ac6ef7ac7c878f' },
  { remote: 'onnx/text_model_fp16.onnx', local: 'text_model_fp16.onnx', size: 220_867_426, sha256: 'ebffbfd71ae11b3f9df5233095815953f44b02ca241c317722edd8c49a9de0f6' }
] as const

export const MODEL_TOTAL_BYTES = MODEL_FILE_SPECS.reduce((sum, spec) => sum + spec.size, 0)

const ATTEMPTS = 4
const STALL_MS = 30_000

export interface InstallerOptions {
  modelDir: string
  onStatus: (status: ModelStatus) => void
  choice: () => ModelStatus['choice']
  /** Overridable for tests and mirrors. Defaults to the Hugging Face file URL. */
  baseUrl?: string
  /** Overridable for tests. Defaults to the pinned SigLIP files. */
  files?: ReadonlyArray<{ remote: string; local: string; size: number; sha256: string }>
  /** First wait between retries, doubled each time. */
  retryDelayMs?: number
}

class InstallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
  }
}

function describeNetworkError(error: unknown): InstallError {
  if (error instanceof InstallError) return error
  const err = error as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException }
  const code = err?.cause?.code ?? err?.code
  if (code === 'ENOSPC') return new InstallError('The disk is full. Free some space and try again.', false)
  if (code === 'EACCES' || code === 'EPERM') {
    return new InstallError('Atlas is not allowed to write to its data folder.', false)
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ENETUNREACH') {
    return new InstallError('Could not reach the download server. Check your internet connection.', true)
  }
  if (err?.name === 'TimeoutError') return new InstallError('The download stalled. Check your connection.', true)
  return new InstallError(`The download failed${err?.message ? `: ${err.message}` : '.'}`, true)
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Downloads the image model on request. Nothing here runs until the user asks: files are fetched to `.part`
 * files (resumable), checked against the pinned SHA-256, and only then moved into place.
 */
export class ModelInstaller {
  private state: ModelInstallState = 'idle'
  private error: string | null = null
  private received = 0
  private currentFile: string | null = null
  private speed = 0
  private controller: AbortController | null = null
  private running: Promise<void> | null = null
  private lastEmit = 0
  private speedSamples: Array<{ at: number; bytes: number }> = []

  private specs: ReadonlyArray<{ remote: string; local: string; size: number; sha256: string }>
  private total: number

  constructor(private options: InstallerOptions) {
    this.specs = options.files ?? MODEL_FILE_SPECS
    this.total = this.specs.reduce((sum, spec) => sum + spec.size, 0)
  }

  get installed(): boolean {
    return missingModelFiles(this.options.modelDir).length === 0
  }

  get status(): ModelStatus {
    const installed = this.installed
    return {
      state: installed && this.state !== 'downloading' && this.state !== 'verifying' ? 'installed' : this.state,
      installed,
      choice: this.options.choice(),
      receivedBytes: installed ? this.total : this.received,
      totalBytes: this.total,
      bytesPerSecond: this.speed,
      currentFile: this.currentFile,
      error: this.error,
      modelDir: this.options.modelDir
    }
  }

  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 250) return
    this.lastEmit = now
    this.options.onStatus(this.status)
  }

  private sample(): void {
    const now = Date.now()
    this.speedSamples.push({ at: now, bytes: this.received })
    while (this.speedSamples.length > 1 && now - this.speedSamples[0]!.at > 4000) this.speedSamples.shift()
    const first = this.speedSamples[0]!
    const seconds = (now - first.at) / 1000
    this.speed = seconds > 0.5 ? Math.max(0, (this.received - first.bytes) / seconds) : this.speed
  }

  /** Starts (or joins) the download. Resolves when the model is installed; rejects with a readable message. */
  install(): Promise<void> {
    if (this.running) return this.running
    if (this.installed) {
      this.state = 'installed'
      this.emit(true)
      return Promise.resolve()
    }
    this.controller = new AbortController()
    this.error = null
    this.state = 'downloading'
    this.received = 0
    this.speed = 0
    this.speedSamples = []
    this.emit(true)
    this.running = this.run(this.controller.signal)
      .then(() => {
        this.state = 'installed'
        this.error = null
        this.currentFile = null
        this.speed = 0
      })
      .catch((error: unknown) => {
        if (this.controller?.signal.aborted) {
          this.state = 'cancelled'
          this.error = null
        } else {
          this.state = 'error'
          this.error = describeNetworkError(error).message
        }
        this.currentFile = null
        this.speed = 0
        throw error
      })
      .finally(() => {
        this.running = null
        this.emit(true)
      })
    // Callers that ignore the promise (the UI only watches status events) must not trigger unhandled rejections.
    this.running.catch(() => undefined)
    return this.running
  }

  cancel(): void {
    this.controller?.abort()
  }

  /** Deletes the installed model files (the caller must release any loaded model first). */
  async remove(): Promise<void> {
    this.cancel()
    await this.running?.catch(() => undefined)
    for (const spec of this.specs) {
      await rm(join(this.options.modelDir, spec.local), { force: true })
      await rm(join(this.options.modelDir, `${spec.local}.part`), { force: true })
    }
    this.state = 'idle'
    this.error = null
    this.received = 0
    this.emit(true)
  }

  private async run(signal: AbortSignal): Promise<void> {
    const dir = this.options.modelDir
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      throw describeNetworkError(error)
    }

    // Count what is already on disk (finished files and resumable parts) before checking free space.
    let existing = 0
    for (const spec of this.specs) {
      for (const name of [spec.local, `${spec.local}.part`]) {
        try {
          existing += Math.min((await stat(join(dir, name))).size, spec.size)
        } catch {
          // Not there yet.
        }
      }
    }
    try {
      const fsStats = await statfs(dir)
      const free = Number(fsStats.bavail) * Number(fsStats.bsize)
      const needed = this.total - existing
      if (free < needed * 1.1) {
        const mb = (n: number): string => `${Math.ceil(n / 1_000_000)} MB`
        throw new InstallError(`Not enough free disk space: ${mb(needed)} needed, ${mb(free)} available.`, false)
      }
    } catch (error) {
      if (error instanceof InstallError) throw error
      // statfs is a courtesy check; carry on if the platform cannot answer.
    }

    let finishedBytes = 0
    for (const spec of this.specs) {
      const target = join(dir, spec.local)
      this.currentFile = spec.local
      const onDisk = await stat(target).then((s) => s.size).catch(() => -1)
      if (onDisk === spec.size && (await sha256Of(target)) === spec.sha256) {
        finishedBytes += spec.size
        this.received = finishedBytes
        this.emit()
        continue
      }
      await this.downloadFile(spec, finishedBytes, signal)
      finishedBytes += spec.size
      this.received = finishedBytes
      this.emit(true)
    }
  }

  private async downloadFile(
    spec: { remote: string; local: string; size: number; sha256: string },
    finishedBytes: number,
    signal: AbortSignal
  ): Promise<void> {
    const dir = this.options.modelDir
    const part = join(dir, `${spec.local}.part`)
    const target = join(dir, spec.local)
    const base = this.options.baseUrl ?? `https://huggingface.co/${MODEL_REPO}/resolve/main`
    let lastError: InstallError | null = null

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw new InstallError('Cancelled.', false)
      try {
        let offset = await stat(part).then((s) => s.size).catch(() => 0)
        if (offset > spec.size) {
          await rm(part, { force: true })
          offset = 0
        }
        if (offset < spec.size) {
          const stall = new AbortController()
          let stallTimer: NodeJS.Timeout | null = null
          const armStall = (): void => {
            if (stallTimer) clearTimeout(stallTimer)
            stallTimer = setTimeout(() => stall.abort(), STALL_MS)
          }
          const combined = AbortSignal.any([signal, stall.signal])
          armStall()
          try {
            const response = await fetch(`${base}/${spec.remote}`, {
              headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
              signal: combined,
              redirect: 'follow'
            })
            if (response.status === 416) {
              await rm(part, { force: true })
              throw new InstallError('The download server rejected the resume request. Retrying.', true)
            }
            if (!response.ok || !response.body) {
              throw new InstallError(
                response.status === 404
                  ? 'The model file is no longer available at its download address.'
                  : `The download server answered ${response.status}.`,
                response.status >= 500 || response.status === 429
              )
            }
            if (offset > 0 && response.status !== 206) offset = 0 // The server ignored the range: start over.
            const file = await open(part, offset > 0 ? 'a' : 'w')
            try {
              const reader = response.body.getReader()
              let written = offset
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                armStall()
                await file.write(value)
                written += value.byteLength
                this.received = finishedBytes + Math.min(written, spec.size)
                this.sample()
                this.emit()
              }
            } finally {
              await file.close()
            }
          } catch (error) {
            if (signal.aborted) throw new InstallError('Cancelled.', false)
            if (stall.signal.aborted) throw new InstallError('The download stalled. Check your connection.', true)
            throw error
          } finally {
            if (stallTimer) clearTimeout(stallTimer)
          }
        }

        this.state = 'verifying'
        this.emit(true)
        const size = (await stat(part)).size
        const digest = size === spec.size ? await sha256Of(part) : ''
        if (size !== spec.size || digest !== spec.sha256) {
          await rm(part, { force: true })
          throw new InstallError(
            `${spec.local} did not download correctly (it failed its integrity check). Try again.`,
            true
          )
        }
        await rename(part, target)
        this.state = 'downloading'
        return
      } catch (error) {
        this.state = 'downloading'
        if (signal.aborted) throw new InstallError('Cancelled.', false)
        lastError = describeNetworkError(error)
        if (!lastError.retryable || attempt === ATTEMPTS) throw lastError
        await sleep(Math.min(8000, (this.options.retryDelayMs ?? 800) * 2 ** (attempt - 1)), signal)
      }
    }
    throw lastError ?? new InstallError('The download failed.', true)
  }
}
