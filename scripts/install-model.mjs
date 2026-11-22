// Installs the local image model (SigLIP base, fp16 ONNX, ~400 MB) used for visual search.
//
//   node scripts/install-model.mjs                 download from Hugging Face (Xenova/siglip-base-patch16-224)
//   node scripts/install-model.mjs --from <dir>    copy from a folder that already holds the model files
//   node scripts/install-model.mjs --to <dir>      install somewhere other than %APPDATA%\NOEMA Atlas\models
//
// This is the only place Atlas touches the network, and only when you run it yourself.
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODEL = 'siglip-base-patch16-224'
const REMOTE = `https://huggingface.co/Xenova/${MODEL}/resolve/main`
const FILES = [
  ['tokenizer.json', 'tokenizer.json'],
  ['tokenizer_config.json', 'tokenizer_config.json'],
  ['onnx/vision_model_fp16.onnx', 'vision_model_fp16.onnx'],
  ['onnx/text_model_fp16.onnx', 'text_model_fp16.onnx']
]

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const from = option('--from')
const base =
  option('--to') ?? process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'NOEMA Atlas', 'models')
const destination = join(base, MODEL)
await mkdir(destination, { recursive: true })

for (const [remotePath, name] of FILES) {
  const target = join(destination, name)
  if (existsSync(target) && (await stat(target)).size > 0) {
    console.log(`have      ${name}`)
    continue
  }
  if (from) {
    const candidates = [join(from, remotePath), join(from, name)]
    const source = candidates.find((candidate) => existsSync(candidate))
    if (!source) throw new Error(`Cannot find ${name} in ${from}`)
    await copyFile(source, target)
    console.log(`copied    ${name}`)
  } else {
    process.stdout.write(`download  ${name} … `)
    const response = await fetch(`${REMOTE}/${remotePath}`)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${remotePath}`)
    await writeFile(target, Buffer.from(await response.arrayBuffer()))
    console.log('done')
  }
}
console.log(`\nModel installed in ${destination}`)
