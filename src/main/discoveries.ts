import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, win32 } from 'node:path'
import type { AtlasDatabase, ScannedImageRecord } from './db'
import { createThumbnail, thumbnailPath } from './media'
import type { ReferenceCollection } from './reference'
import type { ReferenceWork, SavedDiscovery } from '../shared/types'

const safe = (text: string, max = 60): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'Untitled'

export const DISCOVERIES_FOLDER = 'Atlas Discoveries'

/**
 * Saves a work from the reference collection into the user's own library: a copy of the image (public domain, CC0)
 * in `Atlas Discoveries`, with a provenance file beside it and the museum details as tags. It is registered as a
 * source, so it can be favorited, rated and placed on moodboards like any other image. Nothing the user owns is touched.
 */
export async function saveDiscoveryToLibrary(
  deps: { db: AtlasDatabase; reference: ReferenceCollection; dataDir: string; thumbnailsDir: string },
  work: ReferenceWork,
  options: { favorite?: boolean; moodboardId?: string; journeyId?: string | null } = {}
): Promise<SavedDiscovery> {
  const { db, reference, dataDir, thumbnailsDir } = deps
  const source = reference.imagePath(work.id)
  if (!source) throw new Error('The image for this work is missing from the reference collection.')

  const folder = join(dataDir, DISCOVERIES_FOLDER)
  await mkdir(folder, { recursive: true })
  const filename = `${safe(work.artist || 'Unknown maker', 40)} - ${safe(work.title, 60)} [${work.id}].webp`
  const target = join(folder, filename)
  if (!existsSync(target)) await copyFile(source, target)
  const sidecar = `${target}.provenance.json`
  if (!existsSync(sidecar)) {
    await writeFile(
      sidecar,
      JSON.stringify(
        {
          title: work.title,
          artist: work.artist,
          artistInfo: work.artistInfo,
          date: work.date,
          culture: work.culture,
          medium: work.medium,
          classification: work.classification,
          creditLine: work.credit,
          museum: work.museumName,
          objectPage: work.objectUrl,
          license: work.license,
          note: 'A small web copy from the Atlas Reference Collection. The museum publishes this work as public domain / CC0; its object page is authoritative.'
        },
        null,
        2
      ),
      'utf8'
    )
  }

  const root = db.addRoot(folder)
  const id = db.getImageFingerprint(target)?.id ?? db.newImageId(target)
  const info = await stat(target)
  const result = await createThumbnail(target, thumbnailPath(thumbnailsDir, id))
  const record: ScannedImageRecord = {
    id,
    rootId: root.id,
    path: target,
    folder: dirname(target),
    filename: basename(target),
    ext: win32.extname(target).slice(1).toLowerCase(),
    bytes: info.size,
    width: result.width,
    height: result.height,
    orientation: result.orientation,
    mtime: Math.floor(info.mtimeMs),
    color: result.color,
    thumbStatus: result.status,
    thumbError: result.error,
    scanToken: 'atlas-discovery'
  }
  db.upsertScannedImage(record)
  const tags = ['atlas-discovery', work.artist, work.culture, work.museum.toUpperCase(), work.shelfLabel].filter(Boolean).map((t) => t.slice(0, 32))
  db.updateImage({ id, tags, favorite: options.favorite === true ? true : undefined })
  if (options.moodboardId) db.addToMoodboard(options.moodboardId, [id], [])
  db.recordSavedDiscovery(work.id, id, options.journeyId ?? null)
  return { imageId: id, path: target, work }
}
