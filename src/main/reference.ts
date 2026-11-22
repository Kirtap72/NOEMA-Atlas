import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ReferenceInfo, ReferenceWork } from '../shared/types'

interface ManifestItem {
  id: string
  museum: 'aic' | 'cma' | 'met'
  objectId: string
  objectUrl: string
  title: string
  artist: string
  artistInfo: string
  date: string
  culture: string
  period: string
  classification: string
  medium: string
  department: string
  credit: string
  shelf: string
  group: string
  region: number
  x: number
  y: number
  file: string
  width: number
  height: number
  sha256: string
}

interface Manifest {
  format: number
  name: string
  version: string
  model: { name: string; dim: number }
  license: { id: string; name: string; url: string }
  museums: Record<string, { name: string; policy: string }>
  shelves: Array<{ id: string; label: string; group: string; count: number }>
  regions: Array<{ id: number; label: string; count: number; centroid: number[]; topShelves: Array<{ shelf: string; count: number }> }>
  embeddings: { file: string; rows: number; dim: number; sha256: string }
  concepts?: { file: string; ids: string[]; dim: number; sha256: string }
  items: ManifestItem[]
}

/**
 * The Atlas Reference Collection: a fixed, curated set of public-domain artworks that ships with Atlas, so discovery
 * does not depend on what is on the user's computer and works offline. Read-only.
 */
export class ReferenceCollection {
  readonly works: ReferenceWork[] = []
  readonly dim: number
  readonly matrix: Float32Array
  readonly rowOf = new Map<string, number>()
  readonly regions: Manifest['regions']
  private manifest: Manifest
  private files = new Map<string, string>()
  readonly centroids: Float32Array[]
  /** Embedded descriptions of the twelve qualities, so discovery does not need the text model. May be empty. */
  readonly poleVectors = new Map<string, Float32Array>()

  private constructor(private dir: string, manifest: Manifest, matrix: Float32Array) {
    this.manifest = manifest
    this.dim = manifest.embeddings.dim
    this.matrix = matrix
    this.regions = manifest.regions
    this.centroids = manifest.regions.map((r) => Float32Array.from(r.centroid))
    const shelfLabel = new Map(manifest.shelves.map((s) => [s.id, s.label]))
    manifest.items.forEach((item, row) => {
      this.rowOf.set(item.id, row)
      this.files.set(item.id, join(dir, 'images', item.file))
      this.works.push({
        id: item.id,
        title: item.title,
        artist: item.artist,
        artistInfo: item.artistInfo,
        date: item.date,
        culture: item.culture,
        period: item.period,
        classification: item.classification,
        medium: item.medium,
        department: item.department,
        credit: item.credit,
        museum: item.museum,
        museumName: manifest.museums[item.museum]?.name ?? item.museum,
        objectUrl: item.objectUrl,
        shelf: item.shelf,
        shelfLabel: shelfLabel.get(item.shelf) ?? item.shelf,
        group: item.group,
        region: item.region,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        imageUrl: `noema://ref/${item.id}.webp`,
        license: manifest.license.name
      })
    })
  }

  /** Loads the pack from `dir`, or returns null when it is missing or damaged. */
  static load(dir: string): ReferenceCollection | null {
    try {
      const manifestPath = join(dir, 'manifest.json')
      if (!existsSync(manifestPath)) return null
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
      if (manifest.format !== 1 || !manifest.items?.length) return null
      const bytes = readFileSync(join(dir, manifest.embeddings.file))
      const expected = manifest.embeddings.rows * manifest.embeddings.dim * 4
      if (bytes.byteLength !== expected || manifest.embeddings.rows !== manifest.items.length) return null
      if (createHash('sha256').update(bytes).digest('hex') !== manifest.embeddings.sha256) return null
      const matrix = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      const collection = new ReferenceCollection(dir, manifest, matrix)
      if (manifest.concepts) {
        const conceptBytes = readFileSync(join(dir, manifest.concepts.file))
        if (
          conceptBytes.byteLength === manifest.concepts.ids.length * manifest.concepts.dim * 4 &&
          createHash('sha256').update(conceptBytes).digest('hex') === manifest.concepts.sha256
        ) {
          const all = new Float32Array(conceptBytes.buffer.slice(conceptBytes.byteOffset, conceptBytes.byteOffset + conceptBytes.byteLength))
          manifest.concepts.ids.forEach((id, i) => collection.poleVectors.set(id, all.slice(i * manifest.concepts!.dim, (i + 1) * manifest.concepts!.dim)))
        }
      }
      return collection
    } catch {
      return null
    }
  }

  /** Absolute path of an image, only for works that are in the manifest. */
  imagePath(id: string): string | null {
    const path = this.files.get(id)
    if (!path) return null
    try {
      return statSync(path).isFile() ? path : null
    } catch {
      return null
    }
  }

  work(id: string): ReferenceWork | null {
    const row = this.rowOf.get(id)
    return row === undefined ? null : (this.works[row] ?? null)
  }

  info(): ReferenceInfo {
    const counts: Record<string, number> = {}
    for (const w of this.works) counts[w.museum] = (counts[w.museum] ?? 0) + 1
    return {
      available: true,
      name: this.manifest.name,
      version: this.manifest.version,
      works: this.works.length,
      shelves: this.manifest.shelves,
      regions: this.manifest.regions.map((r) => ({ id: r.id, label: r.label, count: r.count })),
      museums: Object.entries(this.manifest.museums)
        .filter(([code]) => counts[code])
        .map(([code, museum]) => ({ code, name: museum.name, policy: museum.policy, works: counts[code] ?? 0 })),
      license: this.manifest.license
    }
  }
}

export function emptyReferenceInfo(): ReferenceInfo {
  return {
    available: false,
    name: 'Atlas Reference Collection',
    version: '',
    works: 0,
    shelves: [],
    regions: [],
    museums: [],
    license: { id: 'CC0-1.0', name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/' }
  }
}
