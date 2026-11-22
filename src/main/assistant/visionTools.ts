import { randomUUID } from 'node:crypto'
import sharp from '../safeSharp'
import type { ImageItem } from '../../shared/types'
import type { VisionFocusRequest } from '../../shared/assistant'
import type { ImagePart } from './providers'
import type { Tool, ToolResult } from './tools'
import type { ToolHelpers } from './studioTools'

// Real visual understanding. The other tools give the language model words about the library (tags, descriptions from
// the local image model, names). These two hand it the pictures themselves, when a question needs looking.
//
// A picture is only ever sent after the user said yes for that send, unless the language model runs on this computer
// (Ollama, LM Studio, a local server): then nothing leaves the machine and the pictures are attached at once. Pictures are
// shrunk and re-encoded (the originals are only read), at most six at a time.

/** Pictures that may be looked at in one go. */
export const MAX_VISION_IMAGES = 6
const LONG_EDGE = { normal: 1280, close: 1568 } as const
const GRID = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const

/** One picture prepared for a model, with the short reference it goes by. */
export interface VisionAttachment {
  imageId: string
  /** "Picture 2 (i5)", so the model can say which one it means. */
  label: string
  ref: string
  part: ImagePart
  /** What was sent: the whole picture, or a close look at a part. */
  note: string
}

const clamp01 = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback)

/** The part of a picture to look at as a rectangle in fractions, or null for the whole picture. */
export function focusRect(focus: VisionFocusRequest | undefined): { x: number; y: number; w: number; h: number; name: string } | null {
  if (!focus) return null
  if (focus.rect) {
    const w = clamp01(focus.rect.w, 0)
    const h = clamp01(focus.rect.h, 0)
    if (w < 0.04 || h < 0.04) return null
    const x = Math.min(clamp01(focus.rect.x, 0), 1 - w)
    const y = Math.min(clamp01(focus.rect.y, 0), 1 - h)
    return { x, y, w, h, name: `the part from ${Math.round(x * 100)}% across and ${Math.round(y * 100)}% down, ${Math.round(w * 100)}% wide and ${Math.round(h * 100)}% high` }
  }
  if (focus.grid) {
    const i = GRID.indexOf(focus.grid)
    if (i < 0) return null
    const col = i % 3
    const row = Math.floor(i / 3)
    // A third of the picture in each direction, with a little overlap so nothing at an edge between cells is cut off.
    const pad = 0.04
    const x = Math.max(0, col / 3 - pad)
    const y = Math.max(0, row / 3 - pad)
    return { x, y, w: Math.min(1 - x, 1 / 3 + 2 * pad), h: Math.min(1 - y, 1 / 3 + 2 * pad), name: `the ${focus.grid.replace('-', ' ')} of the picture` }
  }
  return null
}

/**
 * Reads the pictures (never writes them) and makes the JPEGs a model is sent. With a focus, only that part is cut out of
 * the full-size picture, so a close look is really closer and not an enlarged thumbnail.
 */
export async function prepareVisionImages(items: ImageItem[], options: { detail: 'normal' | 'close'; focus?: VisionFocusRequest; refs: string[]; labelPrefix?: string }): Promise<VisionAttachment[]> {
  const rect = focusRect(options.focus)
  const edge = LONG_EDGE[options.detail]
  const out: VisionAttachment[] = []
  for (const [i, item] of items.slice(0, MAX_VISION_IMAGES).entries()) {
    const meta = await sharp(item.path, { failOn: 'none', limitInputPixels: false }).rotate().metadata()
    let pipeline = sharp(item.path, { failOn: 'none', limitInputPixels: false }).rotate().flatten({ background: '#ffffff' })
    // `rotate()` applies the camera's orientation, so the size to cut from is the displayed one.
    const turned = (meta.orientation ?? 1) >= 5
    const w = (turned ? meta.height : meta.width) ?? item.width
    const h = (turned ? meta.width : meta.height) ?? item.height
    if (rect && w > 0 && h > 0) {
      const left = Math.max(0, Math.round(rect.x * w))
      const top = Math.max(0, Math.round(rect.y * h))
      const width = Math.max(8, Math.min(w - left, Math.round(rect.w * w)))
      const height = Math.max(8, Math.min(h - top, Math.round(rect.h * h)))
      pipeline = sharp(await pipeline.png().toBuffer()).extract({ left, top, width, height })
    }
    const buffer = await pipeline.resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
    const ref = options.refs[i] ?? `i${i + 1}`
    out.push({
      imageId: item.id,
      ref,
      label: `${options.labelPrefix ?? 'Picture'} ${i + 1} (${ref})`,
      part: { type: 'image', mime: 'image/jpeg', base64: buffer.toString('base64'), label: `${options.labelPrefix ?? 'Picture'} ${i + 1}` },
      note: rect ? `a close look at ${rect.name}` : 'the whole picture'
    })
  }
  return out
}

const FOCUS_PROPERTIES = {
  detail: { type: 'string', enum: ['normal', 'close'], description: '"close" sends a larger picture (and, with a focus, a closer crop) for questions about fine detail, texture or small flaws.' },
  focus_grid: { type: 'string', enum: [...GRID], description: 'Look closely at one ninth of the picture, for example "top-left". Use it to check a detail.' },
  focus_rect: { type: 'object', description: 'Alternative to focus_grid: a rectangle {x, y, w, h} in fractions of the picture (0 to 1).' }
}

function focusFrom(args: Record<string, unknown>): VisionFocusRequest | undefined {
  const grid = typeof args.focus_grid === 'string' && (GRID as readonly string[]).includes(args.focus_grid) ? (args.focus_grid as VisionFocusRequest['grid']) : undefined
  const r = args.focus_rect && typeof args.focus_rect === 'object' ? (args.focus_rect as Record<string, unknown>) : null
  const rect = r ? { x: clamp01(r.x, 0), y: clamp01(r.y, 0), w: clamp01(r.w, 0), h: clamp01(r.h, 0) } : undefined
  if (!grid && !rect) return undefined
  return { grid, rect }
}

/** The two tools that let a model look at pictures. Registered by tools.ts. */
export function visionTools(h: ToolHelpers): Tool[] {
  const make = (kind: 'look' | 'compare'): Tool => ({
    progress: kind === 'look' ? 'Getting the pictures ready to look at…' : 'Getting the versions ready to compare…',
    spec: {
      name: kind === 'look' ? 'look_at_images' : 'compare_images',
      description:
        kind === 'look'
          ? `Look at up to ${MAX_VISION_IMAGES} pictures THEMSELVES (not their descriptions), to answer a question about composition, light, materials, colour, mood, artistic qualities, details that could be improved, flaws or artifacts. Use it when the user asks you to look closely, analyse or judge how pictures look, and when descriptions are not enough. After it, what you SEE is a direct observation (start those paragraphs with [seen]); anything from tags, descriptions, names or taste is a library inference ([library]). With a cloud language model the user is asked first and the pictures are sent only if they agree, so tell them what you are asking. For fine detail use detail "close" and a focus.`
          : 'Look at 2 to 4 versions or variations of a picture side by side (the pictures themselves) and compare them: which is more visually coherent, what differs, what each does better. Direct observations start with [seen]. With a cloud language model the user is asked first.',
      parameters: h.obj(
        {
          refs: { type: 'array', items: { type: 'string' }, description: kind === 'look' ? `References of the pictures to look at (up to ${MAX_VISION_IMAGES}).` : 'References of the versions to compare (2 to 4), in the order to present them.' },
          board: { type: 'string', description: 'Alternative to refs: the name of a moodboard whose pictures (the first ones) to look at.' },
          question: { type: 'string', description: 'What to find out, in the user\'s words.' },
          ...FOCUS_PROPERTIES
        },
        ['question']
      )
    },
    async run(args, session): Promise<ToolResult> {
      let ids = h.idsFromRefs(args, session).ids
      const boardName = h.text(args.board, 120)
      if (ids.length === 0 && boardName) {
        const board = h.resolveBoard(session.ctx, boardName)
        if ('error' in board) return { model: { error: board.error }, blocks: [] }
        ids = (session.ctx.db.getMoodboard(board.id)?.images ?? []).filter((i) => !i.missing).map((i) => i.id)
      }
      ids = ids.slice(0, kind === 'compare' ? 4 : MAX_VISION_IMAGES)
      const items = session.ctx.db.getImagesByIds(ids).filter((i) => !i.missing)
      const question = h.text(args.question, 600)
      if (items.length === 0) return { model: { error: 'I need pictures I have shown (by reference) to look at.' }, blocks: [] }
      if (kind === 'compare' && items.length < 2) return { model: { error: 'Comparing needs at least two pictures.' }, blocks: [] }
      if (!question) return { model: { error: 'Say what to find out about the pictures.' }, blocks: [] }
      const mode = session.ctx.vision?.mode()
      if (!mode || mode.provider === 'basics') {
        return { model: { error: 'No language model that can look at pictures is connected. Tell the user to connect one in the companion settings (a cloud model, or a vision model in Ollama or LM Studio).' }, blocks: [] }
      }
      const detail = args.detail === 'close' ? 'close' : 'normal'
      const focus = focusFrom(args)
      const refs = items.map((i) => session.refs.refFor(i.id))
      if (!mode.staysLocal) {
        // The pictures would leave this computer: nothing is sent until the user agrees to exactly this.
        const where = `${mode.label}${mode.model ? ` (${mode.model})` : ''}`
        return {
          model: { status: 'WAITING_FOR_THE_USER: the pictures have NOT been sent. A request was shown asking whether to send them to the provider. Do not describe or guess what the pictures show; tell the user briefly what you will look for once they agree.', pictures: items.length, provider: where },
          blocks: [
            {
              type: 'proposal',
              id: randomUUID(),
              title: `Let ${mode.label} look at ${items.length === 1 ? 'this picture' : `these ${items.length} pictures`}`,
              reason: `${question} The pictures themselves${detail === 'close' ? ' (at higher detail)' : ''} would be sent to ${where}, which is not on this computer. Only these, only once, and only if you agree.`,
              proposal: { kind: 'look', imageId: items[0]!.id, imageIds: items.map((i) => i.id), question, detail, focus, compare: kind === 'compare', providerLabel: mode.label, model: mode.model },
              status: 'pending'
            }
          ]
        }
      }
      const attachments = await prepareVisionImages(items, { detail, focus, refs, labelPrefix: kind === 'compare' ? 'Version' : 'Picture' })
      return {
        model: { status: 'The pictures are attached to the next message, from this computer only. Look at them and answer from what you can see.', pictures: attachments.map((a) => ({ label: a.label, sent: a.note })) },
        blocks: [],
        images: attachments,
        visionIntent: { compare: kind === 'compare', detail, focus: focusRect(focus)?.name }
      }
    }
  })
  return [make('look'), make('compare')]
}
