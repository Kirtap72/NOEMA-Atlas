import { createReadStream, promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import type { AtlasDatabase } from './db'

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jxl': 'image/jxl',
  '.svg': 'image/svg+xml'
}

export function registerMediaProtocol(db: AtlasDatabase, thumbnailsDir: string, referenceImage?: (id: string) => string | null): void {
  protocol.handle('noema', async (request) => {
    try {
      const url = new URL(request.url)
      const kind = url.hostname
      const filename = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const id = filename.replace(/\.[a-z0-9]+$/i, '')
      if (kind === 'ref') {
        // The shipped reference collection: only ids listed in its manifest resolve to a file.
        const refPath = /^[a-z]{2,5}-\d{1,12}$/.test(id) ? referenceImage?.(id) : null
        if (!refPath) return new Response('Not found', { status: 404 })
        const refInfo = await fs.stat(refPath)
        const refHeaders = new Headers({
          'Content-Type': 'image/webp',
          'Content-Length': String(refInfo.size),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff'
        })
        if (request.method === 'HEAD') return new Response(null, { status: 200, headers: refHeaders })
        return new Response(Readable.toWeb(createReadStream(refPath)) as unknown as BodyInit, { status: 200, headers: refHeaders })
      }
      if (!/^[a-f0-9]{24}$/i.test(id)) {
        return new Response('Not found', { status: 404 })
      }

      let filePath: string
      let mime: string
      let cacheControl: string

      if (kind === 'thumb') {
        filePath = join(thumbnailsDir, `${id}.webp`)
        mime = 'image/webp'
        cacheControl = 'public, max-age=31536000, immutable'
      } else if (kind === 'image') {
        const original = db.getImagePath(id)
        if (!original) return new Response('Not found', { status: 404 })
        filePath = original
        mime = MIME_TYPES[extname(original).toLowerCase()] ?? 'application/octet-stream'
        cacheControl = 'private, max-age=3600'
      } else {
        return new Response('Not found', { status: 404 })
      }

      const info = await fs.stat(filePath)
      if (!info.isFile()) return new Response('Not found', { status: 404 })

      const headers = new Headers({
        'Content-Type': mime,
        'Content-Length': String(info.size),
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff'
      })

      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers })
      }

      const nodeStream = createReadStream(filePath, { highWaterMark: 1024 * 256 })
      const body = Readable.toWeb(nodeStream) as unknown as BodyInit
      return new Response(body, { status: 200, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
