import { randomUUID } from 'node:crypto'
import type { AtlasDatabase } from '../db'
import { DEFAULT_SETTINGS, type ExportOpStatus, type OrganizeKind, type OrganizePhase, type OrganizeScope, type OrganizeSettings, type OrganizeStatus } from '../../shared/organizer'
import type { OrganizeItem } from './structure'

// Plans, per-picture analysis and the export journal live in their own tables of the library database, so an analysis
// or an export that is interrupted (a crash, a power cut, the window closed) can be picked up again where it stopped.

export interface PlanRow {
  id: string
  name: string
  status: OrganizeStatus
  scope: OrganizeScope
  settings: OrganizeSettings
  phase: OrganizePhase
  done: number
  total: number
  message: string
  destination: string | null
  createdAt: number
  updatedAt: number
  verification: 'size' | 'hash'
}

export interface ItemRow extends OrganizeItem {
  stage: number
  hash: string | null
}

export interface OpRow {
  seq: number
  imageId: string
  src: string
  dst: string
  bytes: number
  status: ExportOpStatus
  error: string | null
  renamed: boolean
}

type Params = Array<string | number | null>

export class OrganizerStore {
  constructor(private db: AtlasDatabase) {
    this.db.raw().exec(`
      CREATE TABLE IF NOT EXISTS organize_plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        scope TEXT NOT NULL,
        settings TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'facts',
        done INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        destination TEXT,
        verification TEXT NOT NULL DEFAULT 'size',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organize_items (
        plan_id TEXT NOT NULL,
        image_id TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        ext TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        year INTEGER NOT NULL,
        stage INTEGER NOT NULL DEFAULT 0,
        hash TEXT,
        kind TEXT NOT NULL DEFAULT 'uncertain',
        kind_why TEXT NOT NULL DEFAULT '',
        subject TEXT,
        subject_conf TEXT,
        cluster INTEGER,
        dup_group TEXT,
        dup_type TEXT,
        is_best INTEGER NOT NULL DEFAULT 0,
        model_read INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (plan_id, image_id)
      );
      CREATE INDEX IF NOT EXISTS idx_organize_items_stage ON organize_items(plan_id, stage);
      CREATE INDEX IF NOT EXISTS idx_organize_items_bytes ON organize_items(plan_id, bytes);
      CREATE TABLE IF NOT EXISTS organize_ops (
        plan_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        image_id TEXT NOT NULL,
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        renamed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (plan_id, seq)
      );
    `)
  }

  private run(sql: string, params: Params = []): void {
    this.db.raw().prepare(sql).run(...params)
  }
  private all<T>(sql: string, params: Params = []): T[] {
    return this.db.raw().prepare(sql).all(...params) as T[]
  }

  /** Several statements as one step: all of them, or none. */
  transaction<T>(work: () => T): T {
    this.db.raw().exec('BEGIN')
    try {
      const result = work()
      this.db.raw().exec('COMMIT')
      return result
    } catch (error) {
      this.db.raw().exec('ROLLBACK')
      throw error
    }
  }

  // ---- plans ----------------------------------------------------------------------------------------------------------

  private toPlan(row: Record<string, unknown>): PlanRow {
    const parse = <T>(text: unknown, fallback: T): T => {
      try {
        return JSON.parse(String(text)) as T
      } catch {
        return fallback
      }
    }
    return {
      id: String(row.id),
      name: String(row.name),
      status: row.status as OrganizeStatus,
      scope: parse<OrganizeScope>(row.scope, {}),
      settings: { ...DEFAULT_SETTINGS, ...parse<Partial<OrganizeSettings>>(row.settings, {}) },
      phase: row.phase as OrganizePhase,
      done: Number(row.done),
      total: Number(row.total),
      message: String(row.message ?? ''),
      destination: row.destination === null || row.destination === undefined ? null : String(row.destination),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      verification: row.verification === 'hash' ? 'hash' : 'size'
    }
  }

  createPlan(name: string, scope: OrganizeScope, settings: OrganizeSettings): PlanRow {
    const id = randomUUID()
    const now = Date.now()
    this.run('INSERT INTO organize_plans(id, name, status, scope, settings, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', [id, name, 'draft', JSON.stringify(scope), JSON.stringify(settings), now, now])
    return this.plan(id)!
  }

  plan(id: string): PlanRow | null {
    const row = this.all<Record<string, unknown>>('SELECT * FROM organize_plans WHERE id = ?', [id])[0]
    return row ? this.toPlan(row) : null
  }

  plans(): PlanRow[] {
    return this.all<Record<string, unknown>>('SELECT * FROM organize_plans ORDER BY updated_at DESC LIMIT 50').map((r) => this.toPlan(r))
  }

  updatePlan(id: string, change: Partial<Pick<PlanRow, 'name' | 'status' | 'phase' | 'done' | 'total' | 'message' | 'destination' | 'verification'>> & { settings?: OrganizeSettings; scope?: OrganizeScope }): void {
    const sets: string[] = []
    const params: Params = []
    const add = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      params.push(value)
    }
    if (change.name !== undefined) add('name', change.name)
    if (change.status !== undefined) add('status', change.status)
    if (change.phase !== undefined) add('phase', change.phase)
    if (change.done !== undefined) add('done', change.done)
    if (change.total !== undefined) add('total', change.total)
    if (change.message !== undefined) add('message', change.message)
    if (change.destination !== undefined) add('destination', change.destination)
    if (change.verification !== undefined) add('verification', change.verification)
    if (change.settings) add('settings', JSON.stringify(change.settings))
    if (change.scope) add('scope', JSON.stringify(change.scope))
    add('updated_at', Date.now())
    this.run(`UPDATE organize_plans SET ${sets.join(', ')} WHERE id = ?`, [...params, id])
  }

  deletePlan(id: string): void {
    this.transaction(() => {
      this.run('DELETE FROM organize_ops WHERE plan_id = ?', [id])
      this.run('DELETE FROM organize_items WHERE plan_id = ?', [id])
      this.run('DELETE FROM organize_plans WHERE id = ?', [id])
    })
  }

  // ---- items ----------------------------------------------------------------------------------------------------------

  private toItem(row: Record<string, unknown>): ItemRow {
    return {
      id: String(row.image_id),
      path: String(row.path),
      filename: String(row.filename),
      ext: String(row.ext),
      bytes: Number(row.bytes),
      width: Number(row.width),
      height: Number(row.height),
      year: Number(row.year),
      stage: Number(row.stage),
      hash: row.hash === null ? null : String(row.hash),
      kind: row.kind as OrganizeKind,
      kindWhy: String(row.kind_why ?? ''),
      subject: row.subject === null ? null : String(row.subject),
      subjectConfidence: (row.subject_conf as OrganizeItem['subjectConfidence']) ?? null,
      cluster: row.cluster === null ? null : Number(row.cluster),
      dupGroup: row.dup_group === null ? null : String(row.dup_group),
      dupType: (row.dup_type as OrganizeItem['dupType']) ?? null,
      isBest: Number(row.is_best) === 1,
      modelRead: Number(row.model_read) === 1
    }
  }

  insertFacts(planId: string, rows: Array<{ id: string; path: string; filename: string; ext: string; bytes: number; width: number; height: number; year: number }>): void {
    this.transaction(() => {
      const stmt = this.db.raw().prepare('INSERT OR IGNORE INTO organize_items(plan_id, image_id, path, filename, ext, bytes, width, height, year, stage) VALUES(?,?,?,?,?,?,?,?,?,1)')
      for (const r of rows) stmt.run(planId, r.id, r.path, r.filename, r.ext, r.bytes, r.width, r.height, r.year)
    })
  }

  countItems(planId: string, where = ''): number {
    return Number(this.all<{ n: number }>(`SELECT COUNT(*) AS n FROM organize_items WHERE plan_id = ? ${where}`, [planId])[0]?.n ?? 0)
  }

  items(planId: string, where = '', limit = 1_000_000, offset = 0): ItemRow[] {
    return this.all<Record<string, unknown>>(`SELECT * FROM organize_items WHERE plan_id = ? ${where} ORDER BY path LIMIT ? OFFSET ?`, [planId, limit, offset]).map((r) => this.toItem(r))
  }

  item(planId: string, imageId: string): ItemRow | null {
    const r = this.all<Record<string, unknown>>('SELECT * FROM organize_items WHERE plan_id = ? AND image_id = ?', [planId, imageId])[0]
    return r ? this.toItem(r) : null
  }

  /** Sizes shared by more than one picture: only those files can be exact copies, so only those are read to be hashed. */
  sharedSizes(planId: string): number[] {
    return this.all<{ bytes: number }>('SELECT bytes FROM organize_items WHERE plan_id = ? GROUP BY bytes HAVING COUNT(*) > 1', [planId]).map((r) => Number(r.bytes))
  }

  itemsToHash(planId: string, limit: number): ItemRow[] {
    return this.all<Record<string, unknown>>(
      'SELECT * FROM organize_items WHERE plan_id = ? AND hash IS NULL AND bytes IN (SELECT bytes FROM organize_items WHERE plan_id = ? GROUP BY bytes HAVING COUNT(*) > 1) ORDER BY path LIMIT ?',
      [planId, planId, limit]
    ).map((r) => this.toItem(r))
  }

  setHashes(planId: string, hashes: Array<{ id: string; hash: string }>): void {
    this.transaction(() => {
      const stmt = this.db.raw().prepare('UPDATE organize_items SET hash = ? WHERE plan_id = ? AND image_id = ?')
      for (const h of hashes) stmt.run(h.hash, planId, h.id)
    })
  }

  setUnderstanding(planId: string, rows: Array<{ id: string; kind: OrganizeKind; why: string; modelRead: boolean }>): void {
    this.transaction(() => {
      const stmt = this.db.raw().prepare('UPDATE organize_items SET kind = ?, kind_why = ?, model_read = ?, stage = 2 WHERE plan_id = ? AND image_id = ?')
      for (const r of rows) stmt.run(r.kind, r.why, r.modelRead ? 1 : 0, planId, r.id)
    })
  }

  setSubjects(planId: string, rows: Array<{ id: string; subject: string | null; confidence: OrganizeItem['subjectConfidence']; cluster: number | null }>): void {
    this.transaction(() => {
      const stmt = this.db.raw().prepare('UPDATE organize_items SET subject = ?, subject_conf = ?, cluster = ?, stage = 3 WHERE plan_id = ? AND image_id = ?')
      for (const r of rows) stmt.run(r.subject, r.confidence, r.cluster, planId, r.id)
    })
  }

  clearDuplicates(planId: string): void {
    this.run('UPDATE organize_items SET dup_group = NULL, dup_type = NULL, is_best = 0 WHERE plan_id = ?', [planId])
  }

  setDuplicates(planId: string, rows: Array<{ id: string; group: string; type: 'exact' | 'near' | 'versions'; best: boolean }>): void {
    this.transaction(() => {
      const stmt = this.db.raw().prepare('UPDATE organize_items SET dup_group = ?, dup_type = ?, is_best = ?, stage = 4 WHERE plan_id = ? AND image_id = ?')
      for (const r of rows) stmt.run(r.group, r.type, r.best ? 1 : 0, planId, r.id)
    })
  }

  markStage(planId: string, stage: number): void {
    this.run('UPDATE organize_items SET stage = MAX(stage, ?) WHERE plan_id = ?', [stage, planId])
  }

  // ---- the export journal ---------------------------------------------------------------------------------------------

  replaceOps(planId: string, ops: Array<{ imageId: string; src: string; dst: string; bytes: number; status: ExportOpStatus; renamed: boolean }>): void {
    this.transaction(() => {
      this.run('DELETE FROM organize_ops WHERE plan_id = ?', [planId])
      const stmt = this.db.raw().prepare('INSERT INTO organize_ops(plan_id, seq, image_id, src, dst, bytes, status, renamed) VALUES(?,?,?,?,?,?,?,?)')
      ops.forEach((o, i) => stmt.run(planId, i, o.imageId, o.src, o.dst, o.bytes, o.status, o.renamed ? 1 : 0))
    })
  }

  ops(planId: string, statuses: ExportOpStatus[], limit = 1_000_000): OpRow[] {
    const marks = statuses.map(() => '?').join(',')
    return this.all<Record<string, unknown>>(`SELECT * FROM organize_ops WHERE plan_id = ? AND status IN (${marks}) ORDER BY seq LIMIT ?`, [planId, ...statuses, limit]).map((r) => ({
      seq: Number(r.seq),
      imageId: String(r.image_id),
      src: String(r.src),
      dst: String(r.dst),
      bytes: Number(r.bytes),
      status: r.status as ExportOpStatus,
      error: r.error === null ? null : String(r.error),
      renamed: Number(r.renamed) === 1
    }))
  }

  setOp(planId: string, seq: number, status: ExportOpStatus, error: string | null = null): void {
    this.run('UPDATE organize_ops SET status = ?, error = ? WHERE plan_id = ? AND seq = ?', [status, error, planId, seq])
  }

  opCounts(planId: string): Record<ExportOpStatus, number> {
    const counts: Record<ExportOpStatus, number> = { pending: 0, copying: 0, copied: 0, verified: 0, skipped: 0, failed: 0 }
    for (const r of this.all<{ status: ExportOpStatus; n: number }>('SELECT status, COUNT(*) AS n FROM organize_ops WHERE plan_id = ? GROUP BY status', [planId])) counts[r.status] = Number(r.n)
    return counts
  }

  opBytes(planId: string, statuses: ExportOpStatus[]): number {
    const marks = statuses.map(() => '?').join(',')
    return Number(this.all<{ n: number | null }>(`SELECT SUM(bytes) AS n FROM organize_ops WHERE plan_id = ? AND status IN (${marks})`, [planId, ...statuses])[0]?.n ?? 0)
  }

  renamedOps(planId: string): number {
    return Number(this.all<{ n: number }>('SELECT COUNT(*) AS n FROM organize_ops WHERE plan_id = ? AND renamed = 1', [planId])[0]?.n ?? 0)
  }
}
