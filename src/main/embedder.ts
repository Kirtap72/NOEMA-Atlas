import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type * as ort from 'onnxruntime-node'
import sharp from './safeSharp'
import { Tokenizer } from '@huggingface/tokenizers'

export const EMBEDDING_MODEL = 'siglip-base-patch16-224'
export const EMBEDDING_DIM = 768
export const MODEL_FILES = ['vision_model_fp16.onnx', 'text_model_fp16.onnx', 'tokenizer.json', 'tokenizer_config.json'] as const

const IMAGE_SIZE = 224
const TEXT_LENGTH = 64
const PAD_ID = 1

export type EmbedderProvider = 'directml' | 'cpu'

export function modelDirectory(dataDir: string): string {
  const root = process.env.NOEMA_MODELS_DIR || join(dataDir, 'models')
  return join(root, EMBEDDING_MODEL)
}

export function missingModelFiles(modelDir: string): string[] {
  return MODEL_FILES.filter((file) => !existsSync(join(modelDir, file)))
}

export function l2normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (let i = 0; i < vector.length; i += 1) sum += vector[i]! * vector[i]!
  const norm = Math.sqrt(sum) || 1
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / norm
  return out
}

/** Squash to 224x224 (SigLIP does not crop), RGB, scaled to [-1, 1], planar CHW float32. */
export async function preprocessImage(source: string | Buffer): Promise<Float32Array> {
  const { data } = await sharp(source, { failOn: 'none', limitInputPixels: 320_000_000 })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'fill', kernel: 'cubic' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const plane = IMAGE_SIZE * IMAGE_SIZE
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i += 1) {
    out[i] = data[i * 3]! / 127.5 - 1
    out[plane + i] = data[i * 3 + 1]! / 127.5 - 1
    out[2 * plane + i] = data[i * 3 + 2]! / 127.5 - 1
  }
  return out
}

export class Embedder {
  readonly provider: EmbedderProvider
  private vision: ort.InferenceSession
  private text: ort.InferenceSession
  private tokenizer: Tokenizer

  private constructor(provider: EmbedderProvider, vision: ort.InferenceSession, text: ort.InferenceSession, tokenizer: Tokenizer, private Tensor: typeof ort.Tensor) {
    this.provider = provider
    this.vision = vision
    this.text = text
    this.tokenizer = tokenizer
  }

  /** Loads on the GPU through DirectML and falls back to the CPU. fp16 graphs crash ORT's optimizer, so it is disabled. */
  static async load(modelDir: string, preferred: EmbedderProvider[] = ['directml', 'cpu']): Promise<Embedder> {
    const missing = missingModelFiles(modelDir)
    if (missing.length > 0) throw new Error(`The image model is not installed (missing ${missing.join(', ')}).`)
    // The official Windows binary reads this switch when its native telemetry provider starts.
    process.env.ORT_DISABLE_TELEMETRY = '1'
    const runtime = await import('onnxruntime-node').catch((error: unknown) => {
      throw new Error(`The image-model runtime could not load. On Windows, check the Microsoft Visual C++ x64 Redistributable. ${error instanceof Error ? error.message : String(error)}`)
    })
    const tokenizerJson = JSON.parse(await readFile(join(modelDir, 'tokenizer.json'), 'utf8'))
    const tokenizerConfig = JSON.parse(await readFile(join(modelDir, 'tokenizer_config.json'), 'utf8'))
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig)

    let lastError: unknown = null
    for (const provider of preferred) {
      let vision: ort.InferenceSession | undefined
      let text: ort.InferenceSession | undefined
      try {
        const options: ort.InferenceSession.SessionOptions = {
          executionProviders: [provider === 'directml' ? 'dml' : 'cpu'],
          graphOptimizationLevel: 'disabled',
          logSeverityLevel: 3
        }
        vision = await runtime.InferenceSession.create(join(modelDir, 'vision_model_fp16.onnx'), options)
        text = await runtime.InferenceSession.create(join(modelDir, 'text_model_fp16.onnx'), options)
        const embedder = new Embedder(provider, vision, text, tokenizer, runtime.Tensor)
        await embedder.embedImages([new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE)]) // warm-up and early failure
        return embedder
      } catch (error) {
        await Promise.allSettled([vision?.release(), text?.release()])
        lastError = error
      }
    }
    throw new Error(
      `The image model could not be started: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    )
  }

  async embedImages(batch: Float32Array[]): Promise<Float32Array[]> {
    if (batch.length === 0) return []
    const per = 3 * IMAGE_SIZE * IMAGE_SIZE
    const input = new Float32Array(batch.length * per)
    batch.forEach((pixels, index) => input.set(pixels, index * per))
    const result = await this.vision.run({
      pixel_values: new this.Tensor('float32', input, [batch.length, 3, IMAGE_SIZE, IMAGE_SIZE])
    })
    const output = result.pooler_output
    if (!output) throw new Error('The image model returned no embedding.')
    const data = output.data as Float32Array
    const dim = Number(output.dims[1])
    return batch.map((_, index) => l2normalize(data.slice(index * dim, (index + 1) * dim)))
  }

  async embedTexts(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const ids = new BigInt64Array(texts.length * TEXT_LENGTH).fill(BigInt(PAD_ID))
    texts.forEach((text, row) => {
      const encoded = this.tokenizer.encode(text.toLowerCase()).ids.slice(0, TEXT_LENGTH)
      encoded.forEach((id, column) => {
        ids[row * TEXT_LENGTH + column] = BigInt(id)
      })
    })
    const result = await this.text.run({ input_ids: new this.Tensor('int64', ids, [texts.length, TEXT_LENGTH]) })
    const output = result.pooler_output
    if (!output) throw new Error('The text model returned no embedding.')
    const data = output.data as Float32Array
    const dim = Number(output.dims[1])
    return texts.map((_, index) => l2normalize(data.slice(index * dim, (index + 1) * dim)))
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([this.vision.release(), this.text.release()])
  }
}
