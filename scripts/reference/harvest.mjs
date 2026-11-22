// Step 1 and 2 of building the Atlas Reference Collection: find eligible public-domain works on each shelf, then
// download small web copies. Resumable: results are cached in reference-build/.
//
//   node scripts/reference/harvest.mjs [--only shelf-id,shelf-id] [--skip-download]
//
// Network use: public JSON APIs and image files of the three museums named in curation.mjs. Nothing is sent about the
// user or their computer.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { LICENSE, SHELVES } from './curation.mjs'

const ROOT = resolve('.')
const BUILD = join(ROOT, 'reference-build')
const OUT = join(ROOT, 'reference')
const IMAGES = join(OUT, 'images')
mkdirSync(BUILD, { recursive: true })
mkdirSync(IMAGES, { recursive: true })

const args = process.argv.slice(2)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null
const skipDownload = args.includes('--skip-download')
const UA = 'NOEMA-Atlas-reference-builder/1.0 (open-access research tool)'
// The Art Institute of Chicago asks API and image clients to identify themselves with this header (no personal details).
const AIC_HEADERS = { 'AIC-User-Agent': UA }

const MUSEUMS = {
  met: { name: 'The Metropolitan Museum of Art', policy: 'https://www.metmuseum.org/about-the-met/policies-and-documents/open-access' },
  aic: { name: 'Art Institute of Chicago', policy: 'https://www.artic.edu/open-access' },
  cma: { name: 'Cleveland Museum of Art', policy: 'https://www.clevelandart.org/open-access' }
}

// ---- helpers ------------------------------------------------------------------------------------------

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
const hashSeed = (text) => parseInt(createHash('sha1').update(text).digest('hex').slice(0, 8), 16)
function shuffled(list, seed) {
  const random = mulberry32(seed)
  const copy = list.slice()
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The Met's firewall is easily triggered, so The Met is only used when explicitly asked for (--met).
let metBlocked = !process.argv.includes('--met')
async function getJson(url, attempts = 4, init = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers ?? {}) } })
      if (response.status === 403 && url.includes('metmuseum.org')) {
        metBlocked = true // The Met's firewall asked us to slow down: stop using it rather than push.
        console.warn('  ! The Met API is refusing requests; skipping The Met.')
        return null
      }
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`)
      if (!response.ok) return null
      return await response.json()
    } catch (error) {
      if (attempt === attempts) {
        console.warn(`  ! ${url.slice(0, 110)} -> ${error.message}`)
        return null
      }
      await sleep(900 * attempt)
    }
  }
  return null
}

async function pool(items, concurrency, work) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next++
        if (index >= items.length) return
        results[index] = await work(items[index], index)
      }
    })
  )
  return results
}

const year = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n !== 0 ? n : null
}

// ---- museum adapters ---------------------------------------------------------------------------------

async function harvestMet(source, want, seed) {
  if (metBlocked) return []
  const params = new URLSearchParams({ isPublicDomain: 'true', hasImages: 'true', q: source.q, limit: '400' })
  if (source.dept) params.set('departmentId', String(source.dept))
  if (source.dateBegin !== undefined) params.set('dateBegin', String(source.dateBegin))
  if (source.dateEnd !== undefined) params.set('dateEnd', String(source.dateEnd))
  if (source.artist) params.set('artistOrCulture', 'true')
  if (source.medium) params.set('medium', source.medium)
  if (source.geo) params.set('geoLocation', source.geo)
  const search = await getJson(`https://collectionapi.metmuseum.org/public/collection/v1.1/search?${params}`)
  const ids = shuffled(search?.objectIDs ?? [], seed).slice(0, want)
  const objects = await pool(ids, 1, async (id) => {
    if (metBlocked) return null
    await sleep(260)
    return getJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`)
  })
  return objects
    .filter((o) => o && o.isPublicDomain && o.primaryImageSmall)
    .map((o) => ({
      uid: `met-${o.objectID}`,
      museum: 'met',
      objectId: String(o.objectID),
      objectUrl: o.objectURL,
      apiUrl: `https://collectionapi.metmuseum.org/public/collection/v1/objects/${o.objectID}`,
      title: o.title || 'Untitled',
      artist: o.artistDisplayName || '',
      artistInfo: [o.artistNationality, o.artistDisplayBio].filter(Boolean).join(' · '),
      date: o.objectDate || '',
      dateBegin: year(o.objectBeginDate),
      dateEnd: year(o.objectEndDate),
      culture: o.culture || '',
      period: o.period || '',
      classification: o.classification || '',
      medium: o.medium || '',
      department: o.department || '',
      credit: o.creditLine || '',
      imageUrl: o.primaryImageSmall
    }))
}

async function harvestAic(source, want, seed) {
  const fields = ['id', 'title', 'artist_title', 'artist_display', 'date_display', 'date_start', 'date_end', 'style_title', 'classification_title', 'place_of_origin', 'medium_display', 'credit_line', 'image_id', 'is_public_domain', 'department_title']
  const must = [{ term: { is_public_domain: true } }, { exists: { field: 'image_id' } }]
  if (source.cls) must.push({ terms: { 'classification_title.keyword': Array.isArray(source.cls) ? source.cls : [source.cls] } })
  if (source.style) must.push({ term: { 'style_title.keyword': source.style } })
  if (source.dept) must.push({ term: { 'department_title.keyword': source.dept } })
  if (source.from !== undefined) must.push({ range: { date_end: { gte: source.from } } })
  if (source.to !== undefined) must.push({ range: { date_start: { lte: source.to } } })
  const results = []
  for (let page = 1; page <= 3; page += 1) {
    const body = { q: source.q || undefined, query: { bool: { must } }, fields, limit: 100, page }
    if (!source.q) delete body.q
    const data = await getJson('https://api.artic.edu/api/v1/artworks/search', 4, { method: 'POST', headers: { 'Content-Type': 'application/json', ...AIC_HEADERS }, body: JSON.stringify(body) })
    if (!data?.data?.length) break
    results.push(...data.data)
    await sleep(350)
    if (data.data.length < 100) break
  }
  return shuffled(results, seed)
    .filter((o) => o.is_public_domain && o.image_id)
    .slice(0, want)
    .map((o) => ({
      uid: `aic-${o.id}`,
      museum: 'aic',
      objectId: String(o.id),
      objectUrl: `https://www.artic.edu/artworks/${o.id}`,
      apiUrl: `https://api.artic.edu/api/v1/artworks/${o.id}`,
      title: o.title || 'Untitled',
      artist: o.artist_title || '',
      artistInfo: (o.artist_display ?? '').split('\n').slice(1).join(' · '),
      date: o.date_display || '',
      dateBegin: year(o.date_start),
      dateEnd: year(o.date_end),
      culture: o.place_of_origin || '',
      period: o.style_title || '',
      classification: o.classification_title || '',
      medium: o.medium_display || '',
      department: o.department_title || '',
      credit: o.credit_line || '',
      imageUrl: `https://www.artic.edu/iiif/2/${o.image_id}/full/843,/0/default.jpg`
    }))
}

async function harvestCma(source, want, seed) {
  const params = new URLSearchParams({ cc0: '1', has_image: '1', limit: '100' })
  if (source.q) params.set('q', source.q)
  if (source.type) params.set('type', source.type)
  if (source.dept) params.set('department', source.dept)
  if (source.culture) params.set('culture', source.culture)
  if (source.from !== undefined) params.set('created_after', String(source.from))
  if (source.to !== undefined) params.set('created_before', String(source.to))
  // Cleveland returns results in a fixed order, so jump to a seeded offset to avoid always taking the same first ones.
  const probe = await getJson(`https://openaccess-api.clevelandart.org/api/artworks/?${params}&limit=1`)
  const total = probe?.info?.total ?? 0
  if (!total) return []
  const skip = Math.max(0, Math.min(total - 100, Math.floor(mulberry32(seed)() * Math.max(1, total - 100))))
  const data = await getJson(`https://openaccess-api.clevelandart.org/api/artworks/?${params}&skip=${skip}`)
  return shuffled(data?.data ?? [], seed)
    .filter((o) => o.share_license_status === 'CC0' && o.images?.web?.url)
    .slice(0, want)
    .map((o) => {
      const creator = o.creators?.[0]
      return {
        uid: `cma-${o.id}`,
        museum: 'cma',
        objectId: String(o.id),
        objectUrl: o.url,
        apiUrl: `https://openaccess-api.clevelandart.org/api/artworks/${o.id}`,
        title: o.title || 'Untitled',
        artist: creator ? creator.description.replace(/\s*\(.*$/, '') : '',
        artistInfo: creator ? (/\((.*)\)/.exec(creator.description)?.[1] ?? '') : '',
        date: o.creation_date || '',
        dateBegin: year(o.creation_date_earliest),
        dateEnd: year(o.creation_date_latest),
        culture: (o.culture ?? []).join(', '),
        period: '',
        classification: o.type || '',
        medium: o.technique || '',
        department: o.department || '',
        credit: o.creditline || '',
        imageUrl: o.images.web.url
      }
    })
}

const adapters = { met: harvestMet, aic: harvestAic, cma: harvestCma }

// ---- stage 1: harvest ------------------------------------------------------------------------------------

const candidatesPath = join(BUILD, 'candidates.json')
const candidates = existsSync(candidatesPath) ? JSON.parse(readFileSync(candidatesPath, 'utf8')) : {}

await pool(SHELVES, 4, async (shelf) => {
  if (only && !only.has(shelf.id)) return
  if (candidates[shelf.id]) {
    console.log(`= ${shelf.id}: ${candidates[shelf.id].length} cached`)
    return
  }
  const perSource = Math.ceil((shelf.target * 2.4) / shelf.sources.length)
  const found = []
  for (const source of shelf.sources) {
    const items = await adapters[source.m](source, perSource, hashSeed(`${shelf.id}:${source.m}:${source.q}`))
    found.push(...items)
    console.log(`    · ${source.m} "${source.q}"${source.dept ? ' dept ' + source.dept : ''}: ${items.length}`)
  }
  // Variety rules: no duplicate works, at most 3 per artist on a shelf (unknown artists are not capped).
  const seen = new Set()
  const perArtist = new Map()
  const chosen = []
  for (const item of shuffled(found, hashSeed(shelf.id))) {
    const key = `${item.title.toLowerCase().slice(0, 40)}|${item.artist.toLowerCase()}`
    if (seen.has(key) || seen.has(item.uid)) continue
    const count = perArtist.get(item.artist) ?? 0
    if (item.artist && count >= 3) continue
    seen.add(key)
    seen.add(item.uid)
    perArtist.set(item.artist, count + 1)
    chosen.push({ ...item, shelf: shelf.id, group: shelf.group })
  }
  candidates[shelf.id] = chosen.slice(0, Math.ceil(shelf.target * 1.5))
  writeFileSync(candidatesPath, JSON.stringify(candidates))
  console.log(`+ ${shelf.id}: ${candidates[shelf.id].length} candidates (target ${shelf.target})`)
})

if (skipDownload) process.exit(0)

// ---- stage 2: download ---------------------------------------------------------------------------------------

const downloadedPath = join(BUILD, 'downloaded.json')
const downloaded = existsSync(downloadedPath) ? JSON.parse(readFileSync(downloadedPath, 'utf8')) : {}
const globalArtist = new Map()

await pool(SHELVES, 2, async (shelf) => {
  if (only && !only.has(shelf.id)) return
  const list = candidates[shelf.id] ?? []
  let have = list.filter((c) => downloaded[c.uid]?.ok).length
  const todo = list.filter((c) => !(c.uid in downloaded))
  const need = shelf.target - have
  if (need <= 0) return
  const batch = todo.slice(0, Math.ceil(need * 1.4))
  await pool(batch, 3, async (item) => {
    if (have >= shelf.target) return
    try {
      await sleep(120)
      const response = await fetch(item.imageUrl, { headers: { 'User-Agent': UA, ...(item.museum === 'aic' ? AIC_HEADERS : {}) } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      const meta = await sharp(buffer, { failOn: 'none' }).metadata()
      if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 300) {
        downloaded[item.uid] = { ok: false, reason: 'too small' }
        return
      }
      const out = await sharp(buffer, { failOn: 'none' })
        .rotate()
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true })
      const file = `${item.uid}.webp`
      writeFileSync(join(IMAGES, file), out.data)
      downloaded[item.uid] = {
        ok: true,
        file,
        width: out.info.width,
        height: out.info.height,
        bytes: out.data.length,
        sha256: createHash('sha256').update(out.data).digest('hex'),
        sourceWidth: meta.width,
        sourceHeight: meta.height
      }
      have += 1
    } catch (error) {
      downloaded[item.uid] = { ok: false, reason: String(error.message ?? error) }
    }
  })
  writeFileSync(downloadedPath, JSON.stringify(downloaded))
  console.log(`↓ ${shelf.id}: ${list.filter((c) => downloaded[c.uid]?.ok).length}/${shelf.target}`)
})

// A short summary the next step (embedding and manifest) reads.
const ok = Object.values(downloaded).filter((d) => d.ok)
console.log(`\nDownloaded ${ok.length} images, ${(ok.reduce((s, d) => s + d.bytes, 0) / 1e6).toFixed(1)} MB. License: ${LICENSE.name}`)
console.log('Museums:', JSON.stringify(MUSEUMS))
