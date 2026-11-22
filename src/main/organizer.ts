import { constants, promises as fs } from 'node:fs'
import { basename, dirname, extname, join, parse } from 'node:path'
import type { AtlasDatabase } from './db'
import { normalizePath } from './db'
import { hashFile } from './fileHash'
import type {
  ImageItem,
  OrganizeItemResult,
  OrganizeMode,
  OrganizeProgress,
  OrganizeRequest,
  OrganizeResult
} from '../shared/types'

const MOVE_BLOCKED_DRIVE_ROOT =
  'Choose a folder inside the drive, not the drive root. This keeps the Atlas catalogue safe and prevents an entire drive from ever becoming a source.'

function isDriveRoot(value: string): boolean {
  const normalized = normalizePath(value)
  return normalizePath(parse(normalized).root).toLowerCase() === normalized.toLowerCase()
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

function candidateName(filename: string, attempt: number): string {
  if (attempt === 0) return filename
  const extension = extname(filename)
  const stem = basename(filename, extension)
  return `${stem} (${attempt})${extension}`
}

async function findAvailableDestination(
  db: AtlasDatabase,
  destinationDir: string,
  filename: string,
  imageId: string,
  mode: OrganizeMode
): Promise<{ path: string; finalName: string; renamed: boolean }> {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const finalName = candidateName(filename, attempt)
    const destination = join(destinationDir, finalName)
    if (await pathExists(destination)) continue
    if (mode === 'move' && db.isPathIndexed(destination, imageId)) continue
    return { path: destination, finalName, renamed: attempt > 0 }
  }
  throw new Error(`Could not find an available filename for ${filename}.`)
}

async function preserveTimes(source: string, destination: string): Promise<void> {
  try {
    const info = await fs.stat(source)
    await fs.utimes(destination, info.atime, info.mtime)
  } catch {
    // Timestamps are a nicety; the copy itself is already complete.
  }
}

export interface OrganizeOptions {
  onProgress?: (progress: OrganizeProgress) => void
}

export async function organizeImages(
  db: AtlasDatabase,
  request: OrganizeRequest,
  options: OrganizeOptions = {}
): Promise<OrganizeResult> {
  const destination = normalizePath(request.destination)
  let destinationInfo
  try {
    destinationInfo = await fs.stat(destination)
  } catch {
    throw new Error('The destination folder could not be opened.')
  }
  if (!destinationInfo.isDirectory()) throw new Error('The destination is not a folder.')
  if (request.mode === 'move' && isDriveRoot(destination)) {
    throw new Error(MOVE_BLOCKED_DRIVE_ROOT)
  }

  const candidates = db.getOrganizeCandidates(request.selection)
  if (candidates.length === 0) throw new Error('There are no images in that selection.')

  const result: OrganizeResult = {
    mode: request.mode,
    destination,
    total: candidates.length,
    copied: 0,
    moved: 0,
    renamed: 0,
    skipped: 0,
    failed: 0,
    items: []
  }

  const destinationRootId = request.mode === 'move' ? db.getRootForDestination(destination) : null
  const progress: OrganizeProgress = {
    processed: 0,
    total: candidates.length,
    currentFile: null,
    mode: request.mode,
    copied: 0,
    moved: 0,
    renamed: 0,
    skipped: 0,
    failed: 0
  }
  const emit = (): void => {
    options.onProgress?.({ ...progress })
  }
  emit()

  for (const image of candidates) {
    progress.processed += 1
    progress.currentFile = image.filename
    const itemResult = await organizeOne(db, request.mode, destination, destinationRootId, image)
    result.items.push(itemResult)
    if (itemResult.status === 'copied') {
      result.copied += 1
      progress.copied += 1
    } else if (itemResult.status === 'moved') {
      result.moved += 1
      progress.moved += 1
    } else if (itemResult.status === 'skipped') {
      result.skipped += 1
      progress.skipped += 1
    } else {
      result.failed += 1
      progress.failed += 1
    }
    if (itemResult.renamed) {
      result.renamed += 1
      progress.renamed += 1
    }
    emit()
  }

  progress.currentFile = null
  emit()
  return result
}

async function organizeOne(
  db: AtlasDatabase,
  mode: OrganizeMode,
  destinationDir: string,
  destinationRootId: string | null,
  image: ImageItem
): Promise<OrganizeItemResult> {
  const source = normalizePath(image.path)
  if (normalizePath(dirname(source)).toLowerCase() === destinationDir.toLowerCase()) {
    return {
      id: image.id,
      filename: image.filename,
      status: 'skipped',
      finalName: image.filename,
      error: 'Already in the destination folder.'
    }
  }

  let info
  try {
    info = await fs.stat(source)
    if (!info.isFile()) throw new Error('The original is not a file.')
  } catch {
    return {
      id: image.id,
      filename: image.filename,
      status: 'failed',
      error: 'The original file could not be found.'
    }
  }

  let target: { path: string; finalName: string; renamed: boolean }
  try {
    target = await findAvailableDestination(db, destinationDir, image.filename, image.id, mode)
  } catch (error) {
    return {
      id: image.id,
      filename: image.filename,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Could not choose a destination filename.'
    }
  }

  try {
    await fs.copyFile(source, target.path, constants.COPYFILE_EXCL)
  } catch (error) {
    return {
      id: image.id,
      filename: image.filename,
      status: 'failed',
      destinationPath: target.path,
      finalName: target.finalName,
      renamed: target.renamed,
      error: error instanceof Error ? error.message : 'The file could not be copied.'
    }
  }

  await preserveTimes(source, target.path)

  if (mode === 'copy') {
    return {
      id: image.id,
      filename: image.filename,
      status: 'copied',
      destinationPath: target.path,
      finalName: target.finalName,
      renamed: target.renamed
    }
  }

  if (!destinationRootId) {
    await fs.rm(target.path, { force: true }).catch(() => undefined)
    return {
      id: image.id,
      filename: image.filename,
      status: 'failed',
      error: 'The destination source could not be prepared.'
    }
  }

  try {
    const [sourceHash, copyHash] = await Promise.all([hashFile(source), hashFile(target.path)])
    if (sourceHash !== copyHash) throw new Error('The new copy differs from the original.')
    db.relocateImage(image.id, {
      path: target.path,
      rootId: destinationRootId,
      bytes: info.size,
      mtime: Math.floor(info.mtimeMs)
    })
  } catch (error) {
    await fs.rm(target.path, { force: true }).catch(() => undefined)
    return {
      id: image.id,
      filename: image.filename,
      status: 'failed',
      destinationPath: target.path,
      finalName: target.finalName,
      renamed: target.renamed,
      error:
        error instanceof Error
          ? `The catalogue could not be updated: ${error.message}`
          : 'The catalogue could not be updated.'
    }
  }

  let sourceRemovalError: string | undefined
  try {
    const current = await fs.stat(source)
    if (current.ino !== info.ino || current.size !== info.size || current.mtimeMs !== info.mtimeMs) throw new Error('Source changed')
    await fs.unlink(source)
  } catch {
    sourceRemovalError =
      'The new copy and catalogue record are safe, but the original source file could not be removed. It remains in place.'
  }

  return {
    id: image.id,
    filename: image.filename,
    status: 'moved',
    destinationPath: target.path,
    finalName: target.finalName,
    renamed: target.renamed,
    error: sourceRemovalError
  }
}
