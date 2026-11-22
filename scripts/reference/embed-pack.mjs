// Step 3 of building the Atlas Reference Collection: choose the final works, embed them with the same SigLIP model
// Atlas uses on the user's images, group them into regions, lay them out on a 2D map, and write manifest.json.
//
//   node scripts/reference/embed-pack.mjs
//
// Needs the SigLIP model (see README) in %APPDATA%\NOEMA Atlas\models or NOEMA_MODELS_DIR.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import { UMAP } from 'umap-js'
import { Tokenizer } from '@huggingface/tokenizers'
import { LICENSE, SHELVES } from './curation.mjs'

const ROOT = resolve('.')
const BUILD = join(ROOT, 'reference-build')
const OUT = join(ROOT, 'reference')
const IMAGES = join(OUT, 'images')
const modelDir = join(process.env.NOEMA_MODELS_DIR ?? join(process.env.APPDATA ?? '', 'NOEMA Atlas', 'models'), 'siglip-base-patch16-224')

const candidates = JSON.parse(readFileSync(join(BUILD, 'candidates.json'), 'utf8'))
const downloaded = JSON.parse(readFileSync(join(BUILD, 'downloaded.json'), 'utf8'))

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- choose the final works -----------------------------------------------------------------------------------
const globalArtist = new Map()
const seenHash = new Set()
let items = []
for (const shelf of SHELVES) {
  let taken = 0
  for (const c of candidates[shelf.id] ?? []) {
    if (taken >= shelf.target) break
    const d = downloaded[c.uid]
    if (!d?.ok || !existsSync(join(IMAGES, d.file)) || seenHash.has(d.sha256)) continue
    if (c.artist && (globalArtist.get(c.artist) ?? 0) >= 7) continue // keep any one artist from dominating
    seenHash.add(d.sha256)
    if (c.artist) globalArtist.set(c.artist, (globalArtist.get(c.artist) ?? 0) + 1)
    items.push({ ...c, file: d.file, width: d.width, height: d.height, bytes: d.bytes, sha256: d.sha256, sourceWidth: d.sourceWidth, sourceHeight: d.sourceHeight })
    taken += 1
  }
  console.log(`${shelf.id.padEnd(26)} ${taken}/${shelf.target}`)
}
console.log(`\n${items.length} works selected`)

// ---- embeddings (same preprocessing as src/main/embedder.ts) -------------------------------------------------------------
const SIZE = 224
async function preprocess(path) {
  const { data } = await sharp(path, { failOn: 'none' }).rotate().flatten({ background: '#ffffff' }).resize(SIZE, SIZE, { fit: 'fill', kernel: 'cubic' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const plane = SIZE * SIZE
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i += 1) {
    out[i] = data[i * 3] / 127.5 - 1
    out[plane + i] = data[i * 3 + 1] / 127.5 - 1
    out[2 * plane + i] = data[i * 3 + 2] / 127.5 - 1
  }
  return out
}

const options = { executionProviders: ['dml'], graphOptimizationLevel: 'disabled', logSeverityLevel: 3 }
let vision
try {
  vision = await ort.InferenceSession.create(join(modelDir, 'vision_model_fp16.onnx'), options)
} catch {
  vision = await ort.InferenceSession.create(join(modelDir, 'vision_model_fp16.onnx'), { ...options, executionProviders: ['cpu'] })
}
const DIM = 768
let matrix = new Float32Array(items.length * DIM)
const BATCH = 16
for (let start = 0; start < items.length; start += BATCH) {
  const batch = items.slice(start, start + BATCH)
  const pixels = await Promise.all(batch.map((item) => preprocess(join(IMAGES, item.file))))
  const input = new Float32Array(batch.length * 3 * SIZE * SIZE)
  pixels.forEach((p, i) => input.set(p, i * 3 * SIZE * SIZE))
  const result = await vision.run({ pixel_values: new ort.Tensor('float32', input, [batch.length, 3, SIZE, SIZE]) })
  const data = result.pooler_output.data
  batch.forEach((_, i) => {
    let norm = 0
    for (let k = 0; k < DIM; k += 1) norm += data[i * DIM + k] ** 2
    norm = Math.sqrt(norm) || 1
    for (let k = 0; k < DIM; k += 1) matrix[(start + i) * DIM + k] = data[i * DIM + k] / norm
  })
  if ((start / BATCH) % 10 === 0) process.stdout.write(`\rembedded ${Math.min(items.length, start + BATCH)}/${items.length}`)
}
console.log('')

// ---- concept vectors: the twelve qualities' descriptions, embedded once so discovery needs no text model ---------------
const dimensions = JSON.parse(readFileSync(join(ROOT, 'src', 'shared', 'dimensions.json'), 'utf8'))
// Two extra concepts used to keep screenshots and technical images out of taste comparisons (see src/main/guard.ts).
dimensions.push({ id: 'guard-tech', prompts: ['a screenshot of a computer screen or software interface', 'a document, chart, diagram or page of text', 'a user interface mockup with buttons and labels', 'a technical test image, a failed render or an image full of glitches and artifacts'] })
dimensions.push({ id: 'guard-art', prompts: ['a finished artwork', 'a photograph of a place or a person', 'a painting or illustration'] })
const textSession = await ort.InferenceSession.create(join(modelDir, 'text_model_fp16.onnx'), { ...options, executionProviders: ['cpu'] })
const tokenizer = new Tokenizer(JSON.parse(readFileSync(join(modelDir, 'tokenizer.json'), 'utf8')), JSON.parse(readFileSync(join(modelDir, 'tokenizer_config.json'), 'utf8')))
const conceptIds = dimensions.map((d) => d.id)
const concepts = new Float32Array(conceptIds.length * DIM)
for (let c = 0; c < dimensions.length; c += 1) {
  const prompts = dimensions[c].prompts
  const ids = new BigInt64Array(prompts.length * 64).fill(1n)
  prompts.forEach((text, row) => tokenizer.encode(text.toLowerCase()).ids.slice(0, 64).forEach((id, col) => { ids[row * 64 + col] = BigInt(id) }))
  const out = await textSession.run({ input_ids: new ort.Tensor('int64', ids, [prompts.length, 64]) })
  const data = out.pooler_output.data
  const sum = new Float32Array(DIM)
  for (let r = 0; r < prompts.length; r += 1) {
    let n = 0
    for (let k = 0; k < DIM; k += 1) n += data[r * DIM + k] ** 2
    n = Math.sqrt(n) || 1
    for (let k = 0; k < DIM; k += 1) sum[k] += data[r * DIM + k] / n
  }
  let n = 0
  for (let k = 0; k < DIM; k += 1) n += sum[k] ** 2
  n = Math.sqrt(n) || 1
  for (let k = 0; k < DIM; k += 1) concepts[c * DIM + k] = sum[k] / n
}
console.log(`${conceptIds.length} concept vectors embedded`)

// Drop near-duplicates (the same work photographed twice, or very similar prints).
const dot = (a, b) => {
  let s = 0
  for (let k = 0; k < DIM; k += 1) s += matrix[a * DIM + k] * matrix[b * DIM + k]
  return s
}
const keep = []
for (let i = 0; i < items.length; i += 1) {
  let dup = false
  for (const j of keep) if (dot(i, j) > 0.985) { dup = true; break }
  if (!dup) keep.push(i)
}
console.log(`${items.length - keep.length} near-duplicates removed`)
items = keep.map((i) => items[i])
const kept = new Float32Array(keep.length * DIM)
keep.forEach((i, row) => kept.set(matrix.subarray(i * DIM, (i + 1) * DIM), row * DIM))
matrix = kept
const N = items.length

// ---- regions: spherical k-means --------------------------------------------------------------------------------------
const K = 28
const rand = mulberry32(2026)
let centroids = Array.from({ length: K }, () => matrix.slice(Math.floor(rand() * N) * DIM, (Math.floor(rand() * N) + 1) * DIM))
// k-means++ style spread: re-pick centroids greedily far apart
centroids = []
centroids.push(matrix.slice(0, DIM))
const best = new Float32Array(N).fill(-2)
while (centroids.length < K) {
  const last = centroids[centroids.length - 1]
  let far = 0, farScore = 2
  for (let i = 0; i < N; i += 1) {
    let s = 0
    for (let k = 0; k < DIM; k += 1) s += matrix[i * DIM + k] * last[k]
    best[i] = Math.max(best[i], s)
    if (best[i] < farScore) { farScore = best[i]; far = i }
  }
  centroids.push(matrix.slice(far * DIM, (far + 1) * DIM))
}
const assign = new Int32Array(N)
for (let iter = 0; iter < 30; iter += 1) {
  let changed = 0
  for (let i = 0; i < N; i += 1) {
    let bi = 0, bs = -2
    for (let c = 0; c < K; c += 1) {
      let s = 0
      for (let k = 0; k < DIM; k += 1) s += matrix[i * DIM + k] * centroids[c][k]
      if (s > bs) { bs = s; bi = c }
    }
    if (assign[i] !== bi) { assign[i] = bi; changed += 1 }
  }
  const sums = Array.from({ length: K }, () => new Float32Array(DIM))
  const counts = new Int32Array(K)
  for (let i = 0; i < N; i += 1) { counts[assign[i]] += 1; for (let k = 0; k < DIM; k += 1) sums[assign[i]][k] += matrix[i * DIM + k] }
  for (let c = 0; c < K; c += 1) {
    if (!counts[c]) continue
    let n = 0; for (let k = 0; k < DIM; k += 1) n += sums[c][k] ** 2
    n = Math.sqrt(n) || 1
    centroids[c] = sums[c].map((v) => v / n)
  }
  if (!changed) break
}
// Merge regions that are too small to be a useful part of a map into their nearest neighbour.
const MIN_REGION = 14
for (;;) {
  const counts = new Int32Array(K)
  for (let i = 0; i < N; i += 1) counts[assign[i]] += 1
  const live = Array.from({ length: K }, (_, c) => c).filter((c) => counts[c] > 0)
  const small = live.filter((c) => counts[c] < MIN_REGION).sort((a, b) => counts[a] - counts[b])[0]
  if (small === undefined || live.length <= 10) break
  let target = -1, ts = -2
  for (const c of live) {
    if (c === small) continue
    let sc = 0
    for (let k = 0; k < DIM; k += 1) sc += centroids[small][k] * centroids[c][k]
    if (sc > ts) { ts = sc; target = c }
  }
  for (let i = 0; i < N; i += 1) if (assign[i] === small) assign[i] = target
  // recompute the target centroid
  const sum = new Float32Array(DIM)
  for (let i = 0; i < N; i += 1) if (assign[i] === target) for (let k = 0; k < DIM; k += 1) sum[k] += matrix[i * DIM + k]
  let n = 0; for (let k = 0; k < DIM; k += 1) n += sum[k] ** 2
  n = Math.sqrt(n) || 1
  centroids[target] = sum.map((v) => v / n)
  counts[small] = 0
}
const shelfLabel = new Map(SHELVES.map((s) => [s.id, s.label]))
const regions = []
for (let c = 0; c < K; c += 1) {
  const members = items.map((it, i) => (assign[i] === c ? i : -1)).filter((i) => i >= 0)
  if (!members.length) continue
  const tally = new Map()
  for (const i of members) tally.set(items[i].shelf, (tally.get(items[i].shelf) ?? 0) + 1)
  const top = Array.from(tally.entries()).sort((a, b) => b[1] - a[1])
  const centre = Array.from(centroids[c])
  regions.push({
    id: regions.length,
    count: members.length,
    // The name is only a description of what is most common in the region, taken from the curated shelves.
    label: top.slice(0, 2).map(([id]) => shelfLabel.get(id)).join(' · '),
    topShelves: top.slice(0, 3).map(([id, n]) => ({ shelf: id, count: n })),
    centroid: centre.map((v) => Math.round(v * 1e5) / 1e5),
    _members: members
  })
}
// renumber regions in item assignments
const regionOf = new Int32Array(N)
regions.forEach((r) => r._members.forEach((i) => { regionOf[i] = r.id }))

// ---- 2D map (UMAP on cosine distance) ----------------------------------------------------------------------------------
const vectors = Array.from({ length: N }, (_, i) => Array.from(matrix.subarray(i * DIM, (i + 1) * DIM)))
const umap = new UMAP({ nComponents: 2, nNeighbors: 18, minDist: 0.35, spread: 1.2, random: mulberry32(7), distanceFn: (a, b) => { let s = 0; for (let k = 0; k < a.length; k += 1) s += a[k] * b[k]; return 1 - s } })
const coords = umap.fit(vectors)
let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
for (const [x, y] of coords) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y) }
const norm = ([x, y]) => [Math.round(((x - minX) / (maxX - minX)) * 1e4) / 1e4, Math.round(((y - minY) / (maxY - minY)) * 1e4) / 1e4]

// ---- write ------------------------------------------------------------------------------------------------------------------
writeFileSync(join(OUT, 'embeddings.f32'), Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength))
writeFileSync(join(OUT, 'concepts.f32'), Buffer.from(concepts.buffer, concepts.byteOffset, concepts.byteLength))
const conceptsSha = createHash('sha256').update(Buffer.from(concepts.buffer, concepts.byteOffset, concepts.byteLength)).digest('hex')
const embeddingsSha = createHash('sha256').update(Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength)).digest('hex')
const museums = {
  aic: { name: 'Art Institute of Chicago', policy: 'https://www.artic.edu/open-access', api: 'https://api.artic.edu/docs/' },
  cma: { name: 'Cleveland Museum of Art', policy: 'https://www.clevelandart.org/open-access', api: 'https://openaccess-api.clevelandart.org/' },
  met: { name: 'The Metropolitan Museum of Art', policy: 'https://www.metmuseum.org/about-the-met/policies-and-documents/open-access', api: 'https://metmuseum.github.io/' }
}
const manifest = {
  format: 1,
  name: 'Atlas Reference Collection',
  version: new Date().toISOString().slice(0, 10),
  createdAt: new Date().toISOString(),
  model: { name: 'siglip-base-patch16-224', dim: DIM, preprocessing: 'resize 224x224 (fill, cubic), RGB, (x/127.5)-1' },
  license: { ...LICENSE, note: 'Every work is published by its museum as public domain or CC0 at the time of retrieval. Museums name the works in their own open-access policies, linked below.' },
  museums,
  shelves: SHELVES.map((s) => ({ id: s.id, label: s.label, group: s.group, count: items.filter((i) => i.shelf === s.id).length })),
  regions: regions.map(({ _members, ...r }) => r),
  embeddings: { file: 'embeddings.f32', dtype: 'float32', rows: N, dim: DIM, sha256: embeddingsSha },
  concepts: { file: 'concepts.f32', ids: conceptIds, dim: DIM, sha256: conceptsSha },
  retrievedAt: new Date().toISOString().slice(0, 10),
  items: items.map((it, i) => {
    const [x, y] = norm(coords[i])
    return {
      id: it.uid,
      museum: it.museum,
      objectId: it.objectId,
      objectUrl: it.objectUrl,
      apiUrl: it.apiUrl,
      imageUrl: it.imageUrl,
      title: it.title,
      artist: it.artist,
      artistInfo: it.artistInfo,
      date: it.date,
      dateBegin: it.dateBegin,
      dateEnd: it.dateEnd,
      culture: it.culture,
      period: it.period,
      classification: it.classification,
      medium: it.medium,
      department: it.department,
      credit: it.credit,
      shelf: it.shelf,
      group: it.group,
      region: regionOf[i],
      x,
      y,
      file: it.file,
      width: it.width,
      height: it.height,
      bytes: it.bytes,
      sha256: it.sha256
    }
  })
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest))

// credits for people
const perMuseum = {}
for (const it of items) perMuseum[it.museum] = (perMuseum[it.museum] ?? 0) + 1
const credits = [
  '# Atlas Reference Collection: credits and licensing',
  '',
  `${items.length} works, retrieved ${manifest.retrievedAt}. Every work was published by its museum as public domain / CC0 at that time.`,
  `License of the images and the data used here: ${LICENSE.name} (${LICENSE.url}).`,
  '',
  ...Object.entries(perMuseum).map(([m, n]) => `- **${museums[m].name}**: ${n} works. Open-access policy: ${museums[m].policy}`),
  '',
  'Each work\'s title, maker, date, credit line, museum object page and API record are stored in `manifest.json`, and shown in the app next to the image.',
  'The museums are credited here and in the app as a courtesy; CC0 does not require it. Atlas is not affiliated with these museums.',
  'Images are small web copies (at most 800 px) made for browsing. A museum may later change its own licensing statement for a work; the object page linked from each work is authoritative.'
].join('\n')
writeFileSync(join(OUT, 'CREDITS.md'), credits)
// Remove downloaded images that did not make the final selection.
import('node:fs').then(({ readdirSync: ls, unlinkSync }) => {
  const keepFiles = new Set(items.map((i) => i.file))
  for (const f of ls(IMAGES)) if (!keepFiles.has(f)) unlinkSync(join(IMAGES, f))
})
const total = items.reduce((s, i) => s + i.bytes, 0)
console.log(`Wrote manifest for ${N} works, ${regions.length} regions, ${(total / 1e6).toFixed(0)} MB of images.`)
