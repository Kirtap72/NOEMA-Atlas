import { randomUUID } from 'node:crypto'
import type { AtlasDatabase } from '../db'
import type { ImageItem } from '../../shared/types'

const WORLD_W = 1500
const WORLD_H = 1000

export type ArrangeMode = 'tidy' | 'hero' | 'keep'

/** A change to a moodboard that Atlas proposes. Nothing happens until it is applied, and it can always be undone. */
export interface BoardChange {
  remove: string[]
  add: string[]
  arrange: ArrangeMode
}

export interface BoardChangePreview {
  boardId: string
  boardName: string
  removed: ImageItem[]
  added: ImageItem[]
  arrange: ArrangeMode
  /** Counts after the change. */
  resulting: number
}

interface SnapshotItem {
  imageId: string
  position: number
  x: number | null
  y: number | null
  width: number | null
  height: number | null
  z: number | null
  addedAt: number
}

export interface SnapshotInfo {
  id: string
  label: string
  createdAt: number
}

const aspectOf = (i: ImageItem): number => (i.width > 0 && i.height > 0 ? i.width / i.height : 1.5)

/** Packs pictures into justified rows inside a region, keeping every picture's own proportions. */
export function justified(images: ImageItem[], x0: number, y0: number, width: number, target: number, gap = 14): Array<{ id: string; x: number; y: number; w: number; h: number }> {
  const out: Array<{ id: string; x: number; y: number; w: number; h: number }> = []
  let row: ImageItem[] = []
  let y = y0
  const flush = (last: boolean): void => {
    if (row.length === 0) return
    const sum = row.reduce((s, i) => s + aspectOf(i), 0)
    let h = (width - gap * (row.length - 1)) / sum
    if (last) h = Math.min(h, target * 1.15)
    let x = x0
    for (const item of row) {
      const w = aspectOf(item) * h
      out.push({ id: item.id, x, y, w, h })
      x += w + gap
    }
    y += h + gap
    row = []
  }
  for (const item of images) {
    row.push(item)
    const sum = row.reduce((s, i) => s + aspectOf(i), 0)
    if ((width - gap * (row.length - 1)) / sum <= target) flush(false)
  }
  flush(true)
  return out
}

export function layoutFor(images: ImageItem[], mode: ArrangeMode): Array<{ id: string; x: number; y: number; w: number; h: number }> {
  if (images.length === 0) return []
  if (mode === 'hero' && images.length > 2) {
    const [first, ...rest] = images
    const heroW = 720
    const heroH = Math.min(760, heroW / aspectOf(first!))
    const hero = { id: first!.id, x: 50, y: 50, w: heroW, h: heroH }
    return [hero, ...justified(rest, 50 + heroW + 40, 50, WORLD_W - 100 - heroW - 40, 200)]
  }
  return justified(images, 50, 50, WORLD_W - 100, 230)
}

/**
 * Changes moodboards on request: replace, remove, rearrange. Every change first takes a snapshot, so “undo” brings back
 * exactly what was there, positions and sizes included.
 */
export class BoardEditor {
  constructor(
    private db: AtlasDatabase,
    private onChanged: () => void
  ) {}

  private items(boardId: string): SnapshotItem[] {
    const rows = this.db.raw().prepare('SELECT image_id, position, x, y, width, height, z, added_at FROM moodboard_images WHERE moodboard_id = ? ORDER BY position ASC').all(boardId) as Array<Record<string, unknown>>
    return rows.map((r) => ({ imageId: String(r.image_id), position: Number(r.position), x: r.x as number | null, y: r.y as number | null, width: r.width as number | null, height: r.height as number | null, z: r.z as number | null, addedAt: Number(r.added_at) }))
  }

  snapshot(boardId: string, label: string): SnapshotInfo {
    const id = randomUUID()
    const createdAt = Date.now()
    this.db.raw().prepare('INSERT INTO board_snapshots(id, moodboard_id, label, items, created_at) VALUES(?, ?, ?, ?, ?)').run(id, boardId, label.slice(0, 160), JSON.stringify(this.items(boardId)), createdAt)
    // Keep the last 20 per board.
    this.db.raw().prepare('DELETE FROM board_snapshots WHERE moodboard_id = ? AND id NOT IN (SELECT id FROM board_snapshots WHERE moodboard_id = ? ORDER BY created_at DESC LIMIT 20)').run(boardId, boardId)
    return { id, label, createdAt }
  }

  lastSnapshot(boardId: string): SnapshotInfo | null {
    const row = this.db.raw().prepare('SELECT id, label, created_at FROM board_snapshots WHERE moodboard_id = ? ORDER BY created_at DESC LIMIT 1').get(boardId) as { id: string; label: string; created_at: number } | undefined
    return row ? { id: row.id, label: row.label, createdAt: Number(row.created_at) } : null
  }

  preview(boardId: string, change: BoardChange): BoardChangePreview {
    const board = this.db.getMoodboard(boardId)
    if (!board) throw new Error('That moodboard no longer exists.')
    const inBoard = new Set(board.images.map((i) => i.id))
    const removed = board.images.filter((i) => change.remove.includes(i.id))
    const added = this.db.getImagesByIds(change.add.filter((id) => !inBoard.has(id) || change.remove.includes(id)))
    return { boardId, boardName: board.name, removed, added, arrange: change.arrange, resulting: board.images.length - removed.length + added.length }
  }

  apply(boardId: string, change: BoardChange, label: string): SnapshotInfo {
    const board = this.db.getMoodboard(boardId)
    if (!board) throw new Error('That moodboard no longer exists.')
    const snapshot = this.snapshot(boardId, label)
    const raw = this.db.raw()
    for (const id of change.remove) raw.prepare('DELETE FROM moodboard_images WHERE moodboard_id = ? AND image_id = ?').run(boardId, id)
    const have = new Set(this.items(boardId).map((i) => i.imageId))
    const toAdd = change.add.filter((id) => !have.has(id))
    if (toAdd.length) this.db.addToMoodboard(boardId, toAdd)
    if (change.arrange !== 'keep') this.arrange(boardId, change.arrange, false)
    raw.prepare('UPDATE moodboards SET updated_at = ? WHERE id = ?').run(Date.now(), boardId)
    this.onChanged()
    return snapshot
  }

  /** Lays the pictures out neatly again. Takes a snapshot first so it can be undone. */
  arrange(boardId: string, mode: Exclude<ArrangeMode, 'keep'>, withSnapshot = true): void {
    const board = this.db.getMoodboard(boardId)
    if (!board) throw new Error('That moodboard no longer exists.')
    if (withSnapshot) this.snapshot(boardId, mode === 'hero' ? 'Arranged with one large picture' : 'Tidied the layout')
    const raw = this.db.raw()
    const place = raw.prepare('UPDATE moodboard_images SET x = ?, y = ?, width = ?, height = ?, z = ? WHERE moodboard_id = ? AND image_id = ?')
    layoutFor(board.images, mode).forEach((p, index) => place.run(p.x / WORLD_W, p.y / WORLD_H, p.w / WORLD_W, p.h / WORLD_H, index, boardId, p.id))
    this.onChanged()
  }

  /** Restores the most recent snapshot exactly, then forgets it. Returns false when there is nothing to undo. */
  undo(boardId: string): boolean {
    const raw = this.db.raw()
    const row = raw.prepare('SELECT id, items FROM board_snapshots WHERE moodboard_id = ? ORDER BY created_at DESC LIMIT 1').get(boardId) as { id: string; items: string } | undefined
    if (!row) return false
    const items = JSON.parse(row.items) as SnapshotItem[]
    raw.exec('BEGIN IMMEDIATE')
    try {
      raw.prepare('DELETE FROM moodboard_images WHERE moodboard_id = ?').run(boardId)
      const insert = raw.prepare('INSERT INTO moodboard_images(moodboard_id, image_id, position, added_at, x, y, width, height, z) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const i of items) {
        // A picture that has since left the library cannot come back; skip it rather than fail.
        if (!this.db.getImageRow(i.imageId)) continue
        insert.run(boardId, i.imageId, i.position, i.addedAt, i.x, i.y, i.width, i.height, i.z)
      }
      raw.prepare('DELETE FROM board_snapshots WHERE id = ?').run(row.id)
      raw.prepare('UPDATE moodboards SET updated_at = ? WHERE id = ?').run(Date.now(), boardId)
      raw.exec('COMMIT')
    } catch (error) {
      raw.exec('ROLLBACK')
      throw error
    }
    this.onChanged()
    return true
  }
}
