import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join } from 'node:path'
import sharp from './safeSharp'
import { IMAGE_EXTENSIONS } from '../shared/types'

const SUPPORTED_EXTENSIONS = new Set<string>(IMAGE_EXTENSIONS)

export interface ThumbnailResult {
  width: number
  height: number
  orientation: number | null
  color: string | null
  status: 'ready' | 'error'
  error: string | null
}

export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase())
}

export function thumbnailPath(thumbnailsDir: string, imageId: string): string {
  return join(thumbnailsDir, `${imageId}.webp`)
}

function displayDimensions(width: number, height: number, orientation: number | undefined): { width: number; height: number } {
  if (orientation && orientation >= 5 && orientation <= 8) return { width: height, height: width }
  return { width, height }
}

function colorFromRgb(data: Buffer): string | null {
  if (data.length < 3) return null
  const [r, g, b] = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0]
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

export async function createThumbnail(
  sourcePath: string,
  destinationPath: string
): Promise<ThumbnailResult> {
  const empty: ThumbnailResult = {
    width: 0,
    height: 0,
    orientation: null,
    color: null,
    status: 'error',
    error: null
  }

  try {
    const metadata = await sharp(sourcePath, {
      failOn: 'none',
      limitInputPixels: 320_000_000,
      animated: false
    }).metadata()

    const dimensions = displayDimensions(
      Number(metadata.width ?? 0),
      Number(metadata.height ?? 0),
      metadata.orientation
    )

    const buffer = await sharp(sourcePath, {
      failOn: 'none',
      limitInputPixels: 320_000_000,
      animated: false
    })
      .rotate()
      .resize({
        width: 960,
        height: 960,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: sharp.kernel.lanczos3
      })
      .webp({ quality: 82, effort: 4, smartSubsample: true })
      .toBuffer()

    await mkdir(dirname(destinationPath), { recursive: true })
    const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, buffer)
    await rm(destinationPath, { force: true })
    await rename(temporaryPath, destinationPath)

    let color: string | null = null
    try {
      const pixel = await sharp(buffer)
        .resize(1, 1, { fit: 'cover' })
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer()
      color = colorFromRgb(pixel)
    } catch {
      color = null
    }

    return {
      width: dimensions.width,
      height: dimensions.height,
      orientation: metadata.orientation ?? null,
      color,
      status: 'ready',
      error: null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...empty,
      error: message.replace(/\s+/g, ' ').slice(0, 240)
    }
  }
}

export async function removeThumbnail(thumbnailsDir: string, imageId: string): Promise<void> {
  await rm(thumbnailPath(thumbnailsDir, imageId), { force: true }).catch(() => undefined)
}
