import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, basename, join, win32 } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import {
  type BoardImagePlacement,
  type BoardPlacement,
  type ImageDecision,
  type ImageItem,
  type ImagePage,
  type ImageQuery,
  type ImageSort,
  type LibraryStats,
  type Moodboard,
  type MoodboardDetail,
  type MoodboardImage,
  type OrganizeSelection,
  type RootFolder,
  type ScanPhase
} from '../shared/types'

export interface ScannedImageRecord {
  id: string
  rootId: string
  path: string
  folder: string
  filename: string
  ext: string
  bytes: number
  width: number
  height: number
  orientation: number | null
  mtime: number
  color: string | null
  thumbStatus: 'ready' | 'error' | 'pending'
  thumbError: string | null
  scanToken: string
}

interface ImageRow {
  id: string
  path: string
  root_id: string
  folder: string
  filename: string
  ext: string
  bytes: number
  width: number
  height: number
  mtime: number
  added_at: number
  favorite: number
  favorite_at: number | null
  rating: number
  tags: string
  reviewed_at: number | null
  decision: string | null
  missing: number
  color: string | null
  thumb_status: string
}

interface MoodboardImageRow extends ImageRow {
  layout_x: number | null
  layout_y: number | null
  layout_width: number | null
  layout_height: number | null
  board_z: number | null
  position: number
}

interface RootRow {
  id: string
  path: string
  name: string
  added_at: number
  last_scan_at: number | null
}

interface MoodboardRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  image_count: number
  cover_ids: string | null
}

export interface FamilyNameInfo {
  confidence: 'clear' | 'loose' | 'mixed'
  keywords: string[]
  note: string
  basis: string[]
}

export interface FamilySummary {
  id: number
  size: number
  cohesion: number
  covers: ImageItem[]
  /** Name made by Atlas from what the images share, or null if it could not be made yet. */
  autoName: string | null
  /** Name the user chose, or null. */
  customName: string | null
  nameInfo: FamilyNameInfo | null
}

/** A saved family as the regrouping step needs it, to recognise it again after a rebuild. */
export interface SmartCollectionRow {
  id: string
  name: string
  criteria: string
  createdAt: number
  updatedAt: number
  refreshedAt: number | null
  viewedAt: number | null
  size: number
  newCount: number
}

export interface StoredFamily {
  id: number
  stableId: string | null
  autoName: string | null
  customName: string | null
  nameInfo: FamilyNameInfo | null
  centroid: Float32Array | null
  memberIds: Set<string>
}

/** A family that was renamed by the user but could not be found again after a regroup; kept so it can come back. */
export interface ArchivedFamily {
  stableId: string
  customName: string
  centroid: Float32Array
}

export interface FamilyToSave {
  cohesion: number
  members: Array<{ id: string; score: number }>
  stableId?: string
  autoName?: string | null
  customName?: string | null
  nameInfo?: FamilyNameInfo | null
  centroid?: Float32Array | null
}

export interface DiscoveryEventRow {
  id: number
  at: number
  kind: string
  a_ref: string
  b_ref: string | null
  winner_ref: string | null
  context: string
}

export interface PendingEmbedding {
  id: string
  mtime: number
}

export interface EmbeddingStats {
  eligible: number
  indexed: number
}

export interface ScanFinishResult {
  seen: number
  missing: number
}

const SCHEMA_VERSION = 9

const DEFAULT_BOARD_COLUMNS = 4
const DEFAULT_BOARD_LEFT = 0.02
const DEFAULT_BOARD_TOP = 0.03
const DEFAULT_BOARD_CELL_WIDTH = 0.225
const DEFAULT_BOARD_CELL_HEIGHT = 0.2
const DEFAULT_BOARD_GAP_X = 0.015
const DEFAULT_BOARD_GAP_Y = 0.02
const BOARD_WORLD_ASPECT = 1.5

export function normalizePath(value: string): string {
  let normalized = win32.normalize(value)
  if (normalized.length > 3 && normalized.endsWith('\\')) normalized = normalized.slice(0, -1)
  return normalized
}

export function imageIdForPath(filePath: string): string {
  return createHash('sha1').update(normalizePath(filePath).toLowerCase(), 'utf8').digest('hex').slice(0, 24)
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = String(raw).trim().replace(/\s+/g, ' ').slice(0, 32)
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
    if (result.length >= 16) break
  }
  return result
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function roundLayout(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function sanitizePlacement(placement: Partial<BoardPlacement>): BoardPlacement {
  const width = clamp(Number(placement.width) || DEFAULT_BOARD_CELL_WIDTH, 0.02, 20)
  const height = clamp(Number(placement.height) || DEFAULT_BOARD_CELL_HEIGHT, 0.02, 20)
  const x = clamp(Number.isFinite(placement.x) ? Number(placement.x) : 0, -10_000, 10_000)
  const y = clamp(Number.isFinite(placement.y) ? Number(placement.y) : 0, -10_000, 10_000)
  const result: BoardPlacement = {
    x: roundLayout(x),
    y: roundLayout(y),
    width: roundLayout(width),
    height: roundLayout(height)
  }
  if (typeof placement.z === 'number' && Number.isFinite(placement.z)) result.z = Math.max(0, Math.floor(placement.z))
  return result
}

export function defaultBoardPlacement(index: number, imageAspect?: number): BoardPlacement {
  const slot = Math.max(0, index)
  const column = slot % DEFAULT_BOARD_COLUMNS
  const row = Math.floor(slot / DEFAULT_BOARD_COLUMNS)
  const aspect =
    typeof imageAspect === 'number' && Number.isFinite(imageAspect) && imageAspect > 0.01
      ? imageAspect
      : BOARD_WORLD_ASPECT
  return sanitizePlacement({
    x: DEFAULT_BOARD_LEFT + column * (DEFAULT_BOARD_CELL_WIDTH + DEFAULT_BOARD_GAP_X),
    y: DEFAULT_BOARD_TOP + row * (DEFAULT_BOARD_CELL_HEIGHT + DEFAULT_BOARD_GAP_Y),
    width: DEFAULT_BOARD_CELL_WIDTH,
    height: clamp((DEFAULT_BOARD_CELL_WIDTH * BOARD_WORLD_ASPECT) / aspect, 0.05, 3)
  })
}

function placementsOverlap(left: BoardPlacement, right: BoardPlacement): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  )
}

export function findFreeBoardPlacement(
  startSlot: number,
  occupied: BoardPlacement[],
  imageAspect?: number
): BoardPlacement {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = defaultBoardPlacement(startSlot + attempt, imageAspect)
    if (!occupied.some((placement) => placementsOverlap(placement, candidate))) {
      return candidate
    }
  }
  const fallback = defaultBoardPlacement(startSlot, imageAspect)
  return {
    ...fallback,
    x: roundLayout(clamp(fallback.x + 0.04 * (startSlot % 4), -10_000, 10_000)),
    y: roundLayout(clamp(fallback.y + 0.04 * (startSlot % 3), -10_000, 10_000))
  }
}

function mapMoodboardImage(row: MoodboardImageRow): MoodboardImage {
  const imageAspect = row.width > 0 && row.height > 0 ? row.width / row.height : undefined
  const fallback = defaultBoardPlacement(row.position, imageAspect)
  const placement = sanitizePlacement({
    x: row.layout_x ?? fallback.x,
    y: row.layout_y ?? fallback.y,
    width: row.layout_width ?? fallback.width,
    height: row.layout_height ?? fallback.height,
    z: row.board_z ?? row.position
  })
  return {
    ...mapImage(row),
    x: placement.x,
    y: placement.y,
    layoutWidth: placement.width,
    layoutHeight: placement.height,
    z: placement.z ?? row.position
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function toFtsQuery(search: string): string {
  const tokens = search
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
  if (!tokens) return ''
  return tokens
    .slice(0, 8)
    .map((token) => `"${token.replace(/"/g, '""')}"*`)
    .join(' AND ')
}

function makeUrls(id: string, mtime: number): { thumbUrl: string; fullUrl: string } {
  const version = Math.floor(mtime / 1000)
  return {
    thumbUrl: `noema://thumb/${id}.webp?v=${version}`,
    fullUrl: `noema://image/${id}?v=${version}`
  }
}

function mapImage(row: ImageRow): ImageItem {
  const tags = row.tags
    ? row.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    : []
  return {
    id: row.id,
    filename: row.filename,
    folder: row.folder,
    path: row.path,
    ext: row.ext,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    mtime: row.mtime,
    addedAt: row.added_at,
    favorite: row.favorite === 1,
    favoriteAt: row.favorite_at,
    rating: row.rating,
    tags,
    reviewedAt: row.reviewed_at,
    decision: row.decision === 'keep' || row.decision === 'pass' ? row.decision : null,
    missing: row.missing === 1,
    color: row.color,
    thumbStatus: (row.thumb_status as ImageItem['thumbStatus']) || 'pending',
    ...makeUrls(row.id, row.mtime)
  }
}

function mapRoot(row: RootRow, imageCount: number, missingCount: number, scanning: boolean): RootFolder {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    addedAt: row.added_at,
    lastScanAt: row.last_scan_at,
    imageCount,
    missingCount,
    scanning
  }
}

function mapMoodboard(row: MoodboardRow): Moodboard {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    imageCount: row.image_count,
    coverIds: row.cover_ids ? row.cover_ids.split('|').filter(Boolean) : []
  }
}

export class AtlasDatabase {
  readonly dbPath: string
  private db: DatabaseSync
  private ftsEnabled = true
  private statements = new Map<string, StatementSync>()

  constructor(dbPath: string) {
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `)
    try {
      this.migrate()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private ensureColumn(table: string, column: string, definition: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
    if (columns.some((entry) => entry.name === column)) return false
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    return true
  }

  private readExistingSchemaVersion(): number {
    try {
      const table = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
        .get() as { name: string } | undefined
      if (!table) return 0
      const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
        | { value: string }
        | undefined
      return Number(row?.value ?? 0)
    } catch {
      return 0
    }
  }

  private backupBeforeMigration(previousVersion: number): void {
    try {
      const backupDir = join(dirname(this.dbPath), 'backups')
      mkdirSync(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      this.db.prepare('VACUUM INTO ?').run(join(backupDir, `library-v${previousVersion}-${stamp}.db`))
    } catch (error) {
      throw new Error(`Atlas could not back up the catalogue before upgrading it. Check free space and write access, then reopen Atlas. ${error instanceof Error ? error.message : ''}`)
    }
  }

  private migrate(): void {
    const previousVersion = this.readExistingSchemaVersion()
    if (previousVersion > SCHEMA_VERSION) throw new Error('This catalogue was created by a newer Atlas version. Open it with that version.')
    if (previousVersion > 0 && previousVersion < SCHEMA_VERSION) {
      this.backupBeforeMigration(previousVersion)
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS roots (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        last_scan_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL COLLATE NOCASE UNIQUE,
        root_id TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
        folder TEXT NOT NULL,
        filename TEXT NOT NULL,
        ext TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        orientation INTEGER,
        mtime INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        favorite_at INTEGER,
        rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
        tags TEXT NOT NULL DEFAULT '',
        reviewed_at INTEGER,
        decision TEXT,
        missing INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        thumb_status TEXT NOT NULL DEFAULT 'pending',
        thumb_error TEXT,
        scan_token TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_images_root ON images(root_id);
      CREATE INDEX IF NOT EXISTS idx_images_favorite ON images(favorite, favorite_at DESC);
      CREATE INDEX IF NOT EXISTS idx_images_rating ON images(rating DESC);
      CREATE INDEX IF NOT EXISTS idx_images_added ON images(added_at DESC);
      CREATE INDEX IF NOT EXISTS idx_images_mtime ON images(mtime DESC);
      CREATE INDEX IF NOT EXISTS idx_images_reviewed ON images(reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_images_missing ON images(missing);
      CREATE INDEX IF NOT EXISTS idx_images_scan_token ON images(root_id, scan_token);

      CREATE TABLE IF NOT EXISTS moodboards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS moodboard_images (
        moodboard_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,
        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        x REAL,
        y REAL,
        width REAL,
        height REAL,
        z INTEGER,
        PRIMARY KEY (moodboard_id, image_id)
      );

      CREATE INDEX IF NOT EXISTS idx_board_images_position
        ON moodboard_images(moodboard_id, position);
    `)

    const addedDecisionColumn = this.ensureColumn('images', 'decision', 'TEXT')
    this.ensureColumn('moodboard_images', 'x', 'REAL')
    this.ensureColumn('moodboard_images', 'y', 'REAL')
    this.ensureColumn('moodboard_images', 'width', 'REAL')
    this.ensureColumn('moodboard_images', 'height', 'REAL')
    this.ensureColumn('moodboard_images', 'z', 'INTEGER')

    if (addedDecisionColumn) {
      this.db.exec(`
        UPDATE images SET decision = 'keep' WHERE favorite = 1 AND decision IS NULL;
        UPDATE images SET decision = 'pass'
          WHERE reviewed_at IS NOT NULL AND favorite = 0 AND rating = 0 AND decision IS NULL;
      `)
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_images_decision ON images(decision);')

    // Visual embeddings (schema v3). One row per image and model; image_mtime lets a changed file be re-embedded.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        image_mtime INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (image_id, model)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model);

      -- Image families (schema v4): the last clustering result, replaced wholesale on every rebuild.
      CREATE TABLE IF NOT EXISTS families (
        id INTEGER PRIMARY KEY,
        model TEXT NOT NULL,
        size INTEGER NOT NULL,
        cohesion REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS family_members (
        family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        PRIMARY KEY (family_id, image_id)
      );
      CREATE INDEX IF NOT EXISTS idx_family_members_image ON family_members(image_id);

      -- Taste Compass (schema v5): every comparison the user made. winner_id is NULL when they could not choose.
      CREATE TABLE IF NOT EXISTS taste_comparisons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        a_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        b_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        winner_id TEXT REFERENCES images(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        mode TEXT
      );
    `)

    // Family names (schema v7). stable_id follows a family through regroupings; custom_name is the user's own name.
    this.ensureColumn('families', 'stable_id', 'TEXT')
    this.ensureColumn('families', 'name', 'TEXT')
    this.ensureColumn('families', 'custom_name', 'TEXT')
    this.ensureColumn('families', 'name_info', 'TEXT')
    this.ensureColumn('families', 'centroid', 'BLOB')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS family_name_archive (
        stable_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        custom_name TEXT NOT NULL,
        centroid BLOB NOT NULL,
        archived_at INTEGER NOT NULL
      );
    `)
    this.ensureColumn('taste_comparisons', 'mode', 'TEXT')

    // Smart Collections (schema v9): measured colour per image, saved descriptions, and their current matches.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS image_stats (
        image_id TEXT PRIMARY KEY REFERENCES images(id) ON DELETE CASCADE,
        mtime INTEGER NOT NULL,
        lightness REAL NOT NULL,
        contrast REAL NOT NULL,
        saturation REAL NOT NULL,
        hues BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS smart_collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        criteria TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        refreshed_at INTEGER,
        viewed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS smart_members (
        collection_id TEXT NOT NULL REFERENCES smart_collections(id) ON DELETE CASCADE,
        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
        score REAL NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (collection_id, image_id)
      );
      CREATE INDEX IF NOT EXISTS idx_smart_members_image ON smart_members(image_id);
    `)

    // Artistic discovery (schema v6). Reference works are identified by text ids from the shipped collection.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS discovery_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        a_ref TEXT NOT NULL,
        b_ref TEXT,
        winner_ref TEXT,
        context TEXT NOT NULL DEFAULT 'explore'
      );
      CREATE INDEX IF NOT EXISTS idx_discovery_events_at ON discovery_events(at);

      CREATE TABLE IF NOT EXISTS journeys (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS taste_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        payload TEXT NOT NULL,
        reconstructed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS saved_discoveries (
        ref_id TEXT PRIMARY KEY,
        image_id TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        journey_id TEXT
      );

      -- Creative Studio: what was made from what. Image files themselves are ordinary library images.
      CREATE TABLE IF NOT EXISTS generations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        image_id TEXT,
        image_path TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        moodboard_id TEXT,
        moodboard_name TEXT NOT NULL DEFAULT '',
        source_image_ids TEXT NOT NULL DEFAULT '[]',
        roles TEXT NOT NULL DEFAULT '{}',
        prompt TEXT NOT NULL DEFAULT '',
        negative TEXT NOT NULL DEFAULT '',
        method_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        seed INTEGER,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        parent_id TEXT,
        series_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_generations_image ON generations(image_id);
      CREATE INDEX IF NOT EXISTS idx_generations_series ON generations(series_id);
      CREATE INDEX IF NOT EXISTS idx_generations_board ON generations(moodboard_id);
      CREATE TRIGGER IF NOT EXISTS relocate_studio_picture AFTER UPDATE OF path ON images
      WHEN old.path IS NOT new.path BEGIN
        UPDATE generations SET image_path = new.path WHERE image_id = new.id;
      END;

      -- A copy of a moodboard's contents and layout taken before Atlas changes it, so any change can be undone.
      CREATE TABLE IF NOT EXISTS board_snapshots (
        id TEXT PRIMARY KEY,
        moodboard_id TEXT NOT NULL,
        label TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_board ON board_snapshots(moodboard_id, created_at DESC);
    `)

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS image_search USING fts5(
          filename,
          folder,
          tags,
          content='images',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS images_search_ai AFTER INSERT ON images BEGIN
          INSERT INTO image_search(rowid, filename, folder, tags)
          VALUES (new.rowid, new.filename, new.folder, new.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS images_search_ad AFTER DELETE ON images BEGIN
          INSERT INTO image_search(image_search, rowid, filename, folder, tags)
          VALUES ('delete', old.rowid, old.filename, old.folder, old.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS images_search_au AFTER UPDATE OF filename, folder, tags ON images BEGIN
          INSERT INTO image_search(image_search, rowid, filename, folder, tags)
          VALUES ('delete', old.rowid, old.filename, old.folder, old.tags);
          INSERT INTO image_search(rowid, filename, folder, tags)
          VALUES (new.rowid, new.filename, new.folder, new.tags);
        END;
      `)

      const indexed = this.db.prepare('SELECT COUNT(*) AS count FROM image_search').get() as { count: number }
      const total = this.db.prepare('SELECT COUNT(*) AS count FROM images').get() as { count: number }
      if (indexed.count !== total.count) {
        this.db.exec(`INSERT INTO image_search(image_search) VALUES('rebuild')`)
      }
    } catch {
      this.ftsEnabled = false
    }

    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?, ?)')
      .run('version', String(SCHEMA_VERSION))
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.statements.clear()
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // A checkpoint is best-effort during shutdown.
    }
    this.db.close()
  }

  /** Images that still need an embedding for `model`: visible, previewable, and new or changed since embedded. */
  getPendingEmbeddings(model: string, limit: number, exclude: ReadonlySet<string> = new Set()): PendingEmbedding[] {
    const rows = this.stmt(
      `SELECT i.id AS id, i.mtime AS mtime
         FROM images i
         LEFT JOIN embeddings e ON e.image_id = i.id AND e.model = ?
        WHERE i.missing = 0 AND i.thumb_status = 'ready'
          AND (e.image_id IS NULL OR e.image_mtime != i.mtime)
        ORDER BY i.favorite DESC, i.rating DESC, i.added_at DESC
        LIMIT ?`
    ).all(model, limit + exclude.size) as unknown as Array<{ id: string; mtime: number }>
    return rows.filter((row) => !exclude.has(row.id)).slice(0, limit)
  }

  saveEmbeddings(model: string, rows: Array<{ id: string; mtime: number; vector: Float32Array }>): void {
    if (rows.length === 0) return
    const now = Date.now()
    const insert = this.stmt(
      `INSERT OR REPLACE INTO embeddings(image_id, model, dim, vector, image_mtime, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    )
    this.tx(() => {
      for (const row of rows) {
        const bytes = new Uint8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength)
        insert.run(row.id, model, row.vector.length, bytes, row.mtime, now)
      }
    })
  }

  getEmbeddingStats(model: string): EmbeddingStats {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN i.missing = 0 AND i.thumb_status = 'ready' THEN 1 ELSE 0 END) AS eligible,
           SUM(CASE WHEN i.missing = 0 AND i.thumb_status = 'ready' AND e.image_id IS NOT NULL
                     AND e.image_mtime = i.mtime THEN 1 ELSE 0 END) AS indexed
         FROM images i LEFT JOIN embeddings e ON e.image_id = i.id AND e.model = ?`
      )
      .get(model) as { eligible: number | null; indexed: number | null }
    return { eligible: Number(row.eligible ?? 0), indexed: Number(row.indexed ?? 0) }
  }

  /** Replaces the saved families. Families the user renamed that were not found again go to the archive. */
  replaceFamilies(model: string, families: FamilyToSave[], imagesClustered: number, archive: ArchivedFamily[] = []): void {
    const now = Date.now()
    const bytes = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    this.tx(() => {
      this.db.prepare('DELETE FROM families WHERE model = ?').run(model)
      const insertFamily = this.stmt(
        'INSERT INTO families(model, size, cohesion, created_at, stable_id, name, custom_name, name_info, centroid) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      const insertMember = this.stmt('INSERT INTO family_members(family_id, image_id, score) VALUES(?, ?, ?)')
      const liveIds = new Set<string>()
      for (const family of families) {
        const stableId = family.stableId ?? randomUUID()
        liveIds.add(stableId)
        const result = insertFamily.run(
          model,
          family.members.length,
          family.cohesion,
          now,
          stableId,
          family.autoName ?? null,
          family.customName ?? null,
          family.nameInfo ? JSON.stringify(family.nameInfo) : null,
          family.centroid ? bytes(family.centroid) : null
        )
        const familyId = Number(result.lastInsertRowid)
        for (const member of family.members) insertMember.run(familyId, member.id, member.score)
      }
      // The archive holds exactly the renamed families that are currently not in the list.
      const live = liveIds
      this.db.prepare('DELETE FROM family_name_archive WHERE model = ?').run(model)
      const insertArchive = this.stmt(
        'INSERT OR REPLACE INTO family_name_archive(stable_id, model, custom_name, centroid, archived_at) VALUES(?, ?, ?, ?, ?)'
      )
      for (const entry of archive.slice(0, 200)) {
        if (live.has(entry.stableId)) continue
        insertArchive.run(entry.stableId, model, entry.customName, bytes(entry.centroid), now)
      }
      this.db
        .prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?, ?)')
        .run(`families_built:${model}`, JSON.stringify({ at: now, clustered: imagesClustered }))
    })
  }

  private static toFloats(blob: unknown): Float32Array | null {
    if (!(blob instanceof Uint8Array) || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
  }

  private static parseNameInfo(text: unknown): FamilyNameInfo | null {
    if (typeof text !== 'string') return null
    try {
      return JSON.parse(text) as FamilyNameInfo
    } catch {
      return null
    }
  }

  /** The saved families with their members, for recognising them again after a regroup. */
  loadStoredFamilies(model: string): StoredFamily[] {
    const rows = this.db
      .prepare('SELECT id, stable_id, name, custom_name, name_info, centroid FROM families WHERE model = ?')
      .all(model) as unknown as Array<Record<string, unknown>>
    const members = new Map<number, Set<string>>()
    for (const row of this.db
      .prepare('SELECT fm.family_id AS fid, fm.image_id AS iid FROM family_members fm JOIN families f ON f.id = fm.family_id WHERE f.model = ?')
      .all(model) as unknown as Array<{ fid: number; iid: string }>) {
      const set = members.get(row.fid) ?? new Set<string>()
      set.add(row.iid)
      members.set(row.fid, set)
    }
    return rows.map((row) => ({
      id: Number(row.id),
      stableId: (row.stable_id as string | null) ?? null,
      autoName: (row.name as string | null) ?? null,
      customName: (row.custom_name as string | null) ?? null,
      nameInfo: AtlasDatabase.parseNameInfo(row.name_info),
      centroid: AtlasDatabase.toFloats(row.centroid),
      memberIds: members.get(Number(row.id)) ?? new Set<string>()
    }))
  }

  loadFamilyArchive(model: string): ArchivedFamily[] {
    const rows = this.db
      .prepare('SELECT stable_id, custom_name, centroid FROM family_name_archive WHERE model = ?')
      .all(model) as unknown as Array<Record<string, unknown>>
    const result: ArchivedFamily[] = []
    for (const row of rows) {
      const centroid = AtlasDatabase.toFloats(row.centroid)
      if (centroid) result.push({ stableId: String(row.stable_id), customName: String(row.custom_name), centroid })
    }
    return result
  }

  /** Sets the user's name for a family. An empty name returns it to the automatic one. */
  renameFamily(id: number, name: string | null): boolean {
    const clean = name === null ? '' : name.replace(/\s+/g, ' ').trim().slice(0, 80)
    const result = this.db.prepare('UPDATE families SET custom_name = ? WHERE id = ?').run(clean === '' ? null : clean, id)
    return Number(result.changes) > 0
  }

  /** Ids of all images of a family that are still present, most typical first. */
  familyImageIds(id: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT fm.image_id AS id FROM family_members fm JOIN images i ON i.id = fm.image_id
            WHERE fm.family_id = ? AND i.missing = 0 ORDER BY fm.score DESC`
        )
        .all(id) as unknown as Array<{ id: string }>
    ).map((row) => row.id)
  }

  // ---- Smart Collections ------------------------------------------------------------------------------

  /** Images whose colour has not been measured yet (or whose file changed since). */
  getPendingImageStats(limit: number, exclude: ReadonlySet<string> = new Set()): Array<{ id: string; mtime: number }> {
    const rows = this.stmt(
      `SELECT i.id AS id, i.mtime AS mtime FROM images i
         LEFT JOIN image_stats s ON s.image_id = i.id
        WHERE i.missing = 0 AND i.thumb_status = 'ready' AND (s.image_id IS NULL OR s.mtime != i.mtime)
        LIMIT ?`
    ).all(limit + exclude.size) as unknown as Array<{ id: string; mtime: number }>
    return rows.filter((row) => !exclude.has(row.id)).slice(0, limit)
  }

  saveImageStats(rows: Array<{ id: string; mtime: number; lightness: number; contrast: number; saturation: number; hues: Uint8Array }>): void {
    if (rows.length === 0) return
    const insert = this.stmt(
      'INSERT OR REPLACE INTO image_stats(image_id, mtime, lightness, contrast, saturation, hues) VALUES(?, ?, ?, ?, ?, ?)'
    )
    this.tx(() => {
      for (const row of rows) insert.run(row.id, row.mtime, row.lightness, row.contrast, row.saturation, row.hues)
    })
  }

  /** Measured colour and the shape of every image that is present. */
  loadImageStats(): Map<string, { lightness: number; contrast: number; saturation: number; hues: Uint8Array; width: number; height: number }> {
    const rows = this.db
      .prepare(
        `SELECT s.image_id AS id, s.lightness AS lightness, s.contrast AS contrast, s.saturation AS saturation, s.hues AS hues,
                i.width AS width, i.height AS height
           FROM image_stats s JOIN images i ON i.id = s.image_id
          WHERE i.missing = 0 AND s.mtime = i.mtime`
      )
      .all() as unknown as Array<{ id: string; lightness: number; contrast: number; saturation: number; hues: Uint8Array; width: number; height: number }>
    return new Map(rows.map((row) => [row.id, row]))
  }

  /** Width and height of every present image, for matching by shape. */
  loadImageShapes(): Map<string, { width: number; height: number }> {
    const rows = this.db.prepare('SELECT id, width, height FROM images WHERE missing = 0').all() as unknown as Array<{ id: string; width: number; height: number }>
    return new Map(rows.map((row) => [row.id, row]))
  }

  listSmartCollections(): SmartCollectionRow[] {
    return (
      this.db
        .prepare(
          `SELECT c.id AS id, c.name AS name, c.criteria AS criteria, c.created_at AS createdAt, c.updated_at AS updatedAt,
                  c.refreshed_at AS refreshedAt, c.viewed_at AS viewedAt,
                  (SELECT COUNT(*) FROM smart_members m JOIN images i ON i.id = m.image_id WHERE m.collection_id = c.id AND i.missing = 0) AS size,
                  (SELECT COUNT(*) FROM smart_members m JOIN images i ON i.id = m.image_id
                    WHERE m.collection_id = c.id AND i.missing = 0 AND c.viewed_at IS NOT NULL AND m.added_at > c.viewed_at) AS newCount
             FROM smart_collections c ORDER BY c.created_at ASC`
        )
        .all() as unknown as SmartCollectionRow[]
    ).map((row) => ({ ...row, size: Number(row.size), newCount: Number(row.newCount) }))
  }

  getSmartCollection(id: string): SmartCollectionRow | null {
    return this.listSmartCollections().find((row) => row.id === id) ?? null
  }

  createSmartCollection(name: string, criteria: string): string {
    const id = randomUUID()
    const now = Date.now()
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled collection'
    this.db
      .prepare('INSERT INTO smart_collections(id, name, criteria, created_at, updated_at, viewed_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(id, clean, criteria, now, now, now)
    return id
  }

  updateSmartCollection(id: string, change: { name?: string; criteria?: string }): boolean {
    const row = this.db.prepare('SELECT name, criteria FROM smart_collections WHERE id = ?').get(id) as { name: string; criteria: string } | undefined
    if (!row) return false
    const name = change.name !== undefined ? change.name.replace(/\s+/g, ' ').trim().slice(0, 80) || row.name : row.name
    this.db
      .prepare('UPDATE smart_collections SET name = ?, criteria = ?, updated_at = ? WHERE id = ?')
      .run(name, change.criteria ?? row.criteria, Date.now(), id)
    return true
  }

  deleteSmartCollection(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM smart_collections WHERE id = ?').run(id).changes) > 0
  }

  /**
   * Replaces the matches of a collection. Images that were already members keep the moment they joined, so the
   * "new" count only reflects images that arrived since the user last looked. `silent` is used for the very first
   * computation of a collection, where everything would otherwise count as new.
   */
  replaceSmartMembers(id: string, members: Array<{ id: string; score: number }>, silent = false): { added: number } {
    const now = Date.now()
    return this.tx(() => {
      const existing = new Map(
        (this.db.prepare('SELECT image_id AS id, added_at AS addedAt FROM smart_members WHERE collection_id = ?').all(id) as unknown as Array<{ id: string; addedAt: number }>).map((row) => [row.id, row.addedAt])
      )
      this.db.prepare('DELETE FROM smart_members WHERE collection_id = ?').run(id)
      const insert = this.stmt('INSERT INTO smart_members(collection_id, image_id, score, added_at) VALUES(?, ?, ?, ?)')
      let added = 0
      for (const member of members) {
        const before = existing.get(member.id)
        if (before === undefined) added += 1
        insert.run(id, member.id, member.score, before ?? (silent ? 0 : now))
      }
      this.db.prepare('UPDATE smart_collections SET refreshed_at = ? WHERE id = ?').run(now, id)
      return { added }
    })
  }

  markSmartViewed(id: string): void {
    this.db.prepare('UPDATE smart_collections SET viewed_at = ? WHERE id = ?').run(Date.now(), id)
  }

  /** Ids of the images in a smart collection that are still present, best match first. */
  smartImageIds(id: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT m.image_id AS id FROM smart_members m JOIN images i ON i.id = m.image_id
            WHERE m.collection_id = ? AND i.missing = 0 ORDER BY m.score DESC`
        )
        .all(id) as unknown as Array<{ id: string }>
    ).map((row) => row.id)
  }

  /** Which smart collections an image belongs to, for describing it. */
  smartCollectionsForImage(imageId: string): Array<{ id: string; name: string }> {
    return this.db
      .prepare('SELECT c.id AS id, c.name AS name FROM smart_members m JOIN smart_collections c ON c.id = m.collection_id WHERE m.image_id = ? ORDER BY c.name')
      .all(imageId) as unknown as Array<{ id: string; name: string }>
  }

  /** Which family each image belongs to (image id to family id), for describing images. */
  imageFamilyMap(model: string): Map<string, number> {
    const rows = this.db
      .prepare('SELECT fm.image_id AS iid, fm.family_id AS fid FROM family_members fm JOIN families f ON f.id = fm.family_id WHERE f.model = ?')
      .all(model) as unknown as Array<{ iid: string; fid: number }>
    return new Map(rows.map((row) => [row.iid, row.fid]))
  }

  /** True when saved families exist that were made before names existed. */
  familiesLackNames(model: string): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM families WHERE model = ? AND name IS NULL').get(model) as { n: number }
    return Number(row.n) > 0
  }

  /** How many embedded images the saved families were built from, or null if never built. */
  getFamilyBuildInfo(model: string): { at: number; clustered: number } | null {
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(`families_built:${model}`) as
      | { value: string }
      | undefined
    if (!row) return null
    try {
      return JSON.parse(row.value) as { at: number; clustered: number }
    } catch {
      return null
    }
  }

  listFamilies(model: string, coverCount = 3): FamilySummary[] {
    const rows = this.db
      .prepare('SELECT id, size, cohesion, name, custom_name, name_info FROM families WHERE model = ? ORDER BY size DESC, cohesion DESC')
      .all(model) as unknown as Array<{ id: number; size: number; cohesion: number; name: string | null; custom_name: string | null; name_info: string | null }>
    const live = new Map<number, number>()
    for (const row of this.db
      .prepare(
        `SELECT fm.family_id AS id, COUNT(*) AS count
           FROM family_members fm JOIN images i ON i.id = fm.image_id
          WHERE i.missing = 0 GROUP BY fm.family_id`
      )
      .all() as unknown as Array<{ id: number; count: number }>) {
      live.set(row.id, Number(row.count))
    }
    const covers = new Map<number, ImageItem[]>()
    const coverRows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT i.*, fm.family_id AS fid,
                  ROW_NUMBER() OVER (PARTITION BY fm.family_id ORDER BY fm.score DESC) AS rn
             FROM family_members fm JOIN images i ON i.id = fm.image_id
            WHERE i.missing = 0 AND i.thumb_status = 'ready'
         ) WHERE rn <= ?`
      )
      .all(coverCount) as unknown as Array<ImageRow & { fid: number; rn: number }>
    for (const row of coverRows) {
      const list = covers.get(row.fid) ?? []
      list.push(mapImage(row))
      covers.set(row.fid, list)
    }
    return rows
      .map((row) => ({
        id: row.id,
        size: live.get(row.id) ?? 0,
        cohesion: row.cohesion,
        covers: covers.get(row.id) ?? [],
        autoName: row.name,
        customName: row.custom_name,
        nameInfo: AtlasDatabase.parseNameInfo(row.name_info)
      }))
      .filter((family) => family.size > 0)
  }

  /** All current embeddings for a model as one contiguous, row-major matrix (for brute-force similarity). */
  loadEmbeddingMatrix(model: string): { ids: string[]; dim: number; matrix: Float32Array } {
    const rows = this.db
      .prepare(
        `SELECT e.image_id AS id, e.dim AS dim, e.vector AS vector
           FROM embeddings e JOIN images i ON i.id = e.image_id
          WHERE e.model = ? AND i.missing = 0 AND e.image_mtime = i.mtime`
      )
      .all(model) as unknown as Array<{ id: string; dim: number; vector: Uint8Array }>
    const dim = rows[0]?.dim ?? 0
    const matrix = new Float32Array(rows.length * dim)
    const ids: string[] = []
    rows.forEach((row, index) => {
      ids.push(row.id)
      matrix.set(new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)), index * dim)
    })
    return { ids, dim, matrix }
  }

  getStats(): LibraryStats {
    const images = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN missing = 0 THEN 1 ELSE 0 END) AS images,
          SUM(CASE WHEN missing = 0 AND favorite = 1 THEN 1 ELSE 0 END) AS favorites,
          SUM(CASE WHEN missing = 0 AND reviewed_at IS NULL THEN 1 ELSE 0 END) AS unreviewed,
          SUM(CASE WHEN missing = 1 THEN 1 ELSE 0 END) AS missing,
          SUM(CASE WHEN missing = 0 THEN bytes ELSE 0 END) AS total_bytes
        FROM images`
      )
      .get() as Record<string, number | null>
    const roots = this.db.prepare('SELECT COUNT(*) AS count FROM roots').get() as { count: number }
    const boards = this.db.prepare('SELECT COUNT(*) AS count FROM moodboards').get() as { count: number }
    return {
      images: Number(images.images ?? 0),
      favorites: Number(images.favorites ?? 0),
      unreviewed: Number(images.unreviewed ?? 0),
      missing: Number(images.missing ?? 0),
      roots: roots.count,
      moodboards: boards.count,
      totalBytes: Number(images.total_bytes ?? 0)
    }
  }

  listRoots(scanningIds: ReadonlySet<string> = new Set()): RootFolder[] {
    const rows = this.db
      .prepare('SELECT * FROM roots ORDER BY added_at ASC')
      .all() as unknown as RootRow[]
    return rows.map((row) => {
      const counts = this.db
        .prepare(
          `SELECT
            SUM(CASE WHEN missing = 0 THEN 1 ELSE 0 END) AS visible,
            SUM(CASE WHEN missing = 1 THEN 1 ELSE 0 END) AS missing
          FROM images WHERE root_id = ?`
        )
        .get(row.id) as { visible: number | null; missing: number | null }
      return mapRoot(row, Number(counts.visible ?? 0), Number(counts.missing ?? 0), scanningIds.has(row.id))
    })
  }

  getRoot(id: string): RootFolder | null {
    const row = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(id) as unknown as RootRow | undefined
    if (!row) return null
    return this.listRoots().find((root) => root.id === row.id) ?? null
  }

  findRootByPath(path: string): RootFolder | null {
    const row = this.db
      .prepare('SELECT * FROM roots WHERE path = ? COLLATE NOCASE')
      .get(normalizePath(path)) as unknown as RootRow | undefined
    if (!row) return null
    return this.getRoot(row.id)
  }

  /** The open database, for the small modules (Creative Studio) that keep their own tables. */
  raw(): DatabaseSync {
    return this.db
  }

  addRoot(path: string): RootFolder {
    const normalized = normalizePath(path)
    const existing = this.findRootByPath(normalized)
    if (existing) return existing
    const id = randomUUID()
    const now = Date.now()
    this.db
      .prepare('INSERT INTO roots(id, path, name, added_at, last_scan_at) VALUES(?, ?, ?, ?, NULL)')
      .run(id, normalized, basename(normalized) || normalized, now)
    return this.getRoot(id)!
  }

  removeRoot(rootId: string): string[] {
    const imageIds = (
      this.db.prepare('SELECT id FROM images WHERE root_id = ?').all(rootId) as unknown as Array<{ id: string }>
    ).map((row) => row.id)
    this.db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)
    return imageIds
  }

  beginScan(rootId: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE images SET scan_token = NULL WHERE root_id = ?').run(rootId)
    })
  }

  touchScanToken(imageId: string, token: string): void {
    this.db.prepare('UPDATE images SET scan_token = ? WHERE id = ?').run(token, imageId)
  }

  getImageByPath(path: string): ImageRow | null {
    const row = this.db
      .prepare('SELECT * FROM images WHERE path = ? COLLATE NOCASE')
      .get(normalizePath(path)) as unknown as ImageRow | undefined
    return row ?? null
  }

  getImageFingerprint(path: string): { id: string; mtime: number; bytes: number; thumbStatus: string } | null {
    const row = this.db
      .prepare('SELECT id, mtime, bytes, thumb_status FROM images WHERE path = ? COLLATE NOCASE')
      .get(normalizePath(path)) as
      | { id: string; mtime: number; bytes: number; thumb_status: string }
      | undefined
    return row
      ? { id: row.id, mtime: Number(row.mtime), bytes: Number(row.bytes), thumbStatus: row.thumb_status }
      : null
  }

  getImageRow(id: string): ImageRow | null {
    const row = this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) as unknown as ImageRow | undefined
    return row ?? null
  }

  getImage(id: string): ImageItem | null {
    const row = this.getImageRow(id)
    return row ? mapImage(row) : null
  }

  /** `mode` records how the pair was picked, so measurements can ignore pairs chosen *because* they were hard. */
  addTasteComparison(aId: string, bId: string, winnerId: string | null, mode: string | null = null): number {
    if (winnerId !== null && winnerId !== aId && winnerId !== bId) throw new Error('The winner must be one of the two images.')
    const result = this.stmt(
      'INSERT INTO taste_comparisons(a_id, b_id, winner_id, created_at, mode) VALUES(?, ?, ?, ?, ?)'
    ).run(aId, bId, winnerId, Date.now(), mode)
    return Number(result.lastInsertRowid)
  }

  /** Removes the most recent comparison and returns it, so the interface can show that pair again. */
  undoTasteComparison(): { a: string; b: string; winner: string | null; mode: string | null } | null {
    const row = this.db
      .prepare('SELECT id, a_id, b_id, winner_id, mode FROM taste_comparisons ORDER BY id DESC LIMIT 1')
      .get() as { id: number; a_id: string; b_id: string; winner_id: string | null; mode: string | null } | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM taste_comparisons WHERE id = ?').run(row.id)
    return { a: row.a_id, b: row.b_id, winner: row.winner_id, mode: row.mode }
  }

  listTasteComparisons(): Array<{ id: number; a: string; b: string; winner: string | null; mode: string | null }> {
    return (
      this.db
        .prepare('SELECT id, a_id, b_id, winner_id, mode FROM taste_comparisons ORDER BY id ASC')
        .all() as unknown as Array<{ id: number; a_id: string; b_id: string; winner_id: string | null; mode: string | null }>
    ).map((row) => ({ id: row.id, a: row.a_id, b: row.b_id, winner: row.winner_id, mode: row.mode }))
  }

  // ---- artistic discovery -------------------------------------------------------------------------

  addDiscoveryEvent(kind: string, aRef: string, bRef: string | null, winnerRef: string | null, context = 'explore'): number {
    const result = this.stmt(
      'INSERT INTO discovery_events(at, kind, a_ref, b_ref, winner_ref, context) VALUES(?, ?, ?, ?, ?, ?)'
    ).run(Date.now(), kind, aRef, bRef, winnerRef, context)
    return Number(result.lastInsertRowid)
  }

  /** Removes the most recent event from the comparison screen and returns it. */
  undoDiscoveryEvent(): DiscoveryEventRow | null {
    const row = this.db
      .prepare("SELECT * FROM discovery_events WHERE context = 'explore' ORDER BY id DESC LIMIT 1")
      .get() as unknown as DiscoveryEventRow | undefined
    if (!row) return null
    this.db.prepare('DELETE FROM discovery_events WHERE id = ?').run(row.id)
    return row
  }

  listDiscoveryEvents(): DiscoveryEventRow[] {
    return this.db.prepare('SELECT * FROM discovery_events ORDER BY id ASC').all() as unknown as DiscoveryEventRow[]
  }

  /** Forgets exploration answers and journey feedback. Journeys themselves, saved discoveries and history stay. */
  resetDiscoveryEvents(): void {
    this.db.exec('DELETE FROM discovery_events;')
  }

  /** Removes a journey's earlier like/dislike for a work, so feedback can be changed. */
  deleteDiscoveryFeedback(context: string, workRef: string): void {
    this.db.prepare("DELETE FROM discovery_events WHERE context = ? AND a_ref = ? AND kind IN ('like', 'dislike')").run(context, workRef)
  }

  saveJourney(id: string, title: string, payload: string, progress: number, finished: boolean): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO journeys(id, created_at, updated_at, title, payload, progress, finished) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, title = excluded.title, payload = excluded.payload,
           progress = excluded.progress, finished = excluded.finished`
      )
      .run(id, now, now, title, payload, progress, finished ? 1 : 0)
  }

  listJourneyRows(): Array<{ id: string; created_at: number; payload: string; progress: number; finished: number }> {
    return this.db
      .prepare('SELECT id, created_at, payload, progress, finished FROM journeys ORDER BY created_at DESC')
      .all() as unknown as Array<{ id: string; created_at: number; payload: string; progress: number; finished: number }>
  }

  getJourneyRow(id: string): { id: string; created_at: number; payload: string; progress: number; finished: number } | null {
    return (
      (this.db.prepare('SELECT id, created_at, payload, progress, finished FROM journeys WHERE id = ?').get(id) as unknown as
        | { id: string; created_at: number; payload: string; progress: number; finished: number }
        | undefined) ?? null
    )
  }

  deleteJourney(id: string): void {
    this.db.prepare('DELETE FROM journeys WHERE id = ?').run(id)
  }

  addSnapshot(at: number, payload: string, reconstructed: boolean): number {
    const result = this.db
      .prepare('INSERT INTO taste_snapshots(at, payload, reconstructed) VALUES(?, ?, ?)')
      .run(at, payload, reconstructed ? 1 : 0)
    return Number(result.lastInsertRowid)
  }

  listSnapshots(): Array<{ id: number; at: number; payload: string; reconstructed: number }> {
    return this.db.prepare('SELECT id, at, payload, reconstructed FROM taste_snapshots ORDER BY at ASC, id ASC').all() as unknown as Array<{
      id: number
      at: number
      payload: string
      reconstructed: number
    }>
  }

  clearReconstructedSnapshots(): void {
    this.db.exec('DELETE FROM taste_snapshots WHERE reconstructed = 1;')
  }

  recordSavedDiscovery(refId: string, imageId: string, journeyId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO saved_discoveries(ref_id, image_id, saved_at, journey_id) VALUES(?, ?, ?, ?)
         ON CONFLICT(ref_id) DO UPDATE SET image_id = excluded.image_id, saved_at = excluded.saved_at, journey_id = excluded.journey_id`
      )
      .run(refId, imageId, Date.now(), journeyId)
  }

  getSavedDiscovery(refId: string): { ref_id: string; image_id: string; saved_at: number; journey_id: string | null } | null {
    return (
      (this.db.prepare('SELECT * FROM saved_discoveries WHERE ref_id = ?').get(refId) as unknown as
        | { ref_id: string; image_id: string; saved_at: number; journey_id: string | null }
        | undefined) ?? null
    )
  }

  /** The user's explicit favorites with the time each was marked, for the artistic-identity profile. */
  listFavorites(): Array<{ id: string; favoriteAt: number | null }> {
    return (
      this.db
        .prepare('SELECT id, favorite_at FROM images WHERE favorite = 1 AND missing = 0')
        .all() as unknown as Array<{ id: string; favorite_at: number | null }>
    ).map((row) => ({ id: row.id, favoriteAt: row.favorite_at }))
  }

  resetTaste(): void {
    this.db.exec('DELETE FROM taste_comparisons;')
  }

  /** The user's existing explicit decisions: Keep/Pass and star ratings of visible images. */
  getDecisionSignals(): { keeps: string[]; passes: string[]; rated: Array<{ id: string; rating: number }> } {
    const keeps = this.db
      .prepare("SELECT id FROM images WHERE missing = 0 AND (favorite = 1 OR decision = 'keep')")
      .all() as unknown as Array<{ id: string }>
    const passes = this.db
      .prepare("SELECT id FROM images WHERE missing = 0 AND favorite = 0 AND decision = 'pass'")
      .all() as unknown as Array<{ id: string }>
    const rated = this.db
      .prepare('SELECT id, rating FROM images WHERE missing = 0 AND rating > 0')
      .all() as unknown as Array<{ id: string; rating: number }>
    return { keeps: keeps.map((r) => r.id), passes: passes.map((r) => r.id), rated }
  }

  imageInRoot(imageId: string, rootId: string): boolean {
    return Boolean(this.stmt('SELECT 1 AS ok FROM images WHERE id = ? AND root_id = ?').get(imageId, rootId))
  }

  /** Images for the given ids, in the same order. Unknown ids are dropped. */
  getImagesByIds(ids: string[]): ImageItem[] {
    const byId = new Map<string, ImageItem>()
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500)
      const rows = this.db
        .prepare(`SELECT * FROM images WHERE id IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as unknown as ImageRow[]
      for (const row of rows) byId.set(row.id, mapImage(row))
    }
    return ids.map((id) => byId.get(id)).filter((item): item is ImageItem => item !== undefined)
  }

  upsertScannedImage(record: ScannedImageRecord): void {
    const now = Date.now()
    this.stmt(`
      INSERT INTO images (
        id, path, root_id, folder, filename, ext, bytes, width, height, orientation,
        mtime, added_at, updated_at, favorite, favorite_at, rating, tags, reviewed_at,
        missing, color, thumb_status, thumb_error, scan_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, '', NULL, 0, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        root_id = excluded.root_id,
        folder = excluded.folder,
        filename = excluded.filename,
        ext = excluded.ext,
        bytes = excluded.bytes,
        width = excluded.width,
        height = excluded.height,
        orientation = excluded.orientation,
        mtime = excluded.mtime,
        updated_at = excluded.updated_at,
        missing = 0,
        color = excluded.color,
        thumb_status = excluded.thumb_status,
        thumb_error = excluded.thumb_error,
        scan_token = excluded.scan_token
    `).run(
      record.id,
      normalizePath(record.path),
      record.rootId,
      normalizePath(record.folder),
      record.filename,
      record.ext,
      record.bytes,
      record.width,
      record.height,
      record.orientation,
      record.mtime,
      now,
      now,
      record.color,
      record.thumbStatus,
      record.thumbError,
      record.scanToken
    )
  }

  finishScan(rootId: string, token: string, complete: boolean): ScanFinishResult {
    return this.tx(() => {
      let missing = 0
      if (complete) {
        missing = Number(
          (
            this.db
              .prepare(
                `SELECT COUNT(*) AS count FROM images
                 WHERE root_id = ? AND (scan_token IS NULL OR scan_token != ?)`
              )
              .get(rootId, token) as { count: number }
          ).count
        )
        this.db
          .prepare(
            `UPDATE images SET missing = 1
             WHERE root_id = ? AND (scan_token IS NULL OR scan_token != ?)`
          )
          .run(rootId, token)
        this.db
          .prepare('UPDATE images SET missing = 0 WHERE root_id = ? AND scan_token = ?')
          .run(rootId, token)
        this.db.prepare('UPDATE roots SET last_scan_at = ? WHERE id = ?').run(Date.now(), rootId)
      }
      this.db.prepare('UPDATE images SET scan_token = NULL WHERE root_id = ?').run(rootId)
      const seen = Number(
        (this.db.prepare('SELECT COUNT(*) AS count FROM images WHERE root_id = ?').get(rootId) as { count: number })
          .count
      )
      return { seen, missing }
    })
  }

  updateImage(input: {
    id: string
    favorite?: boolean
    rating?: number
    tags?: string[]
    reviewed?: boolean
    decision?: ImageDecision | null
  }): ImageItem {
    const row = this.getImageRow(input.id)
    if (!row) throw new Error('Image not found.')
    const now = Date.now()

    let favorite = row.favorite === 1
    let favoriteAt = row.favorite_at
    let decision: ImageDecision | null =
      row.decision === 'keep' || row.decision === 'pass' ? row.decision : null

    if (typeof input.favorite === 'boolean') {
      favorite = input.favorite
      favoriteAt = input.favorite ? row.favorite_at ?? now : null
      if (input.favorite) decision = 'keep'
      else if (decision === 'keep') decision = null
    }

    if (input.decision !== undefined) {
      decision = input.decision
    }

    if (decision === 'keep') {
      favorite = true
      favoriteAt = row.favorite_at ?? now
    } else if (decision === 'pass') {
      favorite = false
      favoriteAt = null
    }

    const rating =
      typeof input.rating === 'number'
        ? Math.max(0, Math.min(5, Math.round(input.rating)))
        : row.rating
    const tags = Array.isArray(input.tags) ? normalizeTags(input.tags).join(', ') : row.tags

    let reviewedAt = row.reviewed_at
    if (input.reviewed === false) reviewedAt = null
    else if (input.reviewed === true) reviewedAt = reviewedAt ?? now
    else if (reviewedAt === null && (favorite || rating > 0 || decision !== null)) reviewedAt = now

    this.db
      .prepare(
        `UPDATE images SET
          favorite = ?, favorite_at = ?, rating = ?, tags = ?, reviewed_at = ?, decision = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(favorite ? 1 : 0, favoriteAt, rating, tags, reviewedAt, decision, now, input.id)
    return this.getImage(input.id)!
  }

  markReviewed(ids: string[], reviewed: boolean): void {
    if (ids.length === 0) return
    const now = reviewed ? Date.now() : null
    this.tx(() => {
      const statement = this.db.prepare('UPDATE images SET reviewed_at = ?, updated_at = ? WHERE id = ?')
      for (const id of ids) statement.run(now, Date.now(), id)
    })
  }

  queryImages(query: ImageQuery): ImagePage {
    const limit = Math.max(1, Math.min(500, Math.floor(query.limit ?? 120)))
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    try {
      return this.runImageQuery(query, limit, offset, this.ftsEnabled)
    } catch (error) {
      if (query.search?.trim() && this.ftsEnabled) {
        this.ftsEnabled = false
        return this.runImageQuery(query, limit, offset, false)
      }
      throw error
    }
  }

  private buildWhere(query: ImageQuery, useFts: boolean): { joins: string[]; conditions: string[]; params: Array<string | number> } {
    const joins: string[] = []
    const conditions: string[] = []
    const params: Array<string | number> = []

    if (query.scope === 'moodboard') {
      if (!query.moodboardId) throw new Error('A moodboard is required.')
      joins.push('JOIN moodboard_images mi ON mi.image_id = i.id AND mi.moodboard_id = ?')
      params.push(query.moodboardId)
    }

    if (typeof query.smartId === 'string' && query.smartId) {
      joins.push('JOIN smart_members sm ON sm.image_id = i.id AND sm.collection_id = ?')
      params.push(query.smartId)
    }

    if (typeof query.familyId === 'number') {
      joins.push('JOIN family_members fm ON fm.image_id = i.id AND fm.family_id = ?')
      params.push(query.familyId)
    }

    if (typeof query.addedFrom === 'number' && Number.isFinite(query.addedFrom)) {
      conditions.push('i.added_at >= ?')
      params.push(Math.floor(query.addedFrom))
    }
    if (typeof query.addedTo === 'number' && Number.isFinite(query.addedTo)) {
      conditions.push('i.added_at <= ?')
      params.push(Math.floor(query.addedTo))
    }
    if (query.scope === 'favorites') conditions.push('i.favorite = 1')
    if (query.scope === 'review') conditions.push('i.reviewed_at IS NULL')

    if (!query.includeMissing) conditions.push('i.missing = 0')
    if (query.unreviewed) conditions.push('i.reviewed_at IS NULL')
    if (query.rootId) {
      conditions.push('i.root_id = ?')
      params.push(query.rootId)
    }
    if (typeof query.minRating === 'number' && query.minRating > 0) {
      conditions.push('i.rating >= ?')
      params.push(query.minRating)
    }
    if (typeof query.exactRating === 'number' && query.exactRating > 0) {
      conditions.push('i.rating = ?')
      params.push(Math.max(1, Math.min(5, Math.round(query.exactRating))))
    }
    if (query.decision === 'keep') {
      conditions.push("(i.decision = 'keep' OR i.favorite = 1)")
    } else if (query.decision === 'pass') {
      conditions.push("i.decision = 'pass' AND i.favorite = 0")
    }

    const search = query.search?.trim()
    if (search) {
      if (useFts) {
        const ftsQuery = toFtsQuery(search)
        if (ftsQuery) {
          joins.push('JOIN image_search ON image_search.rowid = i.rowid')
          conditions.push('image_search MATCH ?')
          params.push(ftsQuery)
        }
      } else {
        const tokens = search.split(/\s+/).filter(Boolean).slice(0, 8)
        for (const token of tokens) {
          const like = `%${escapeLike(token)}%`
          conditions.push(`(i.filename LIKE ? ESCAPE '\\' OR i.folder LIKE ? ESCAPE '\\' OR i.tags LIKE ? ESCAPE '\\')`)
          params.push(like, like, like)
        }
      }
    }

    return { joins, conditions, params }
  }

  private sortSql(sort: ImageSort | undefined, scope: ImageQuery['scope']): string {
    if (scope === 'moodboard') return 'mi.position ASC, mi.added_at ASC'
    switch (sort) {
      case 'recent':
        return 'i.added_at DESC, i.mtime DESC'
      case 'captured':
        return 'i.mtime DESC, i.added_at DESC'
      case 'rating':
        return 'i.rating DESC, i.favorite DESC, i.mtime DESC'
      case 'name':
        return 'i.filename COLLATE NOCASE ASC, i.mtime DESC'
      case 'folder':
        return 'i.folder COLLATE NOCASE ASC, i.filename COLLATE NOCASE ASC'
      case 'size':
        return 'i.bytes DESC'
      case 'curated':
        return 'i.favorite DESC, i.rating DESC, i.mtime DESC, i.added_at DESC'
      default:
        return scope === 'favorites' ? 'i.favorite_at DESC' : 'i.mtime DESC, i.added_at DESC'
    }
  }

  private runImageQuery(query: ImageQuery, limit: number, offset: number, useFts: boolean): ImagePage {
    const { joins, conditions, params } = this.buildWhere(query, useFts)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const join = joins.join('\n')
    const order = query.familyId ? 'fm.score DESC' : query.smartId ? 'sm.score DESC' : this.sortSql(query.sort, query.scope)
    const rows = this.db
      .prepare(`SELECT i.* FROM images i ${join} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as ImageRow[]
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS count FROM images i ${join} ${where}`)
      .get(...params) as { count: number }
    return {
      items: rows.map(mapImage),
      total: Number(countRow.count),
      offset,
      limit
    }
  }

  getMoodboardsForImage(imageId: string): string[] {
    return (
      this.db
        .prepare('SELECT moodboard_id FROM moodboard_images WHERE image_id = ?')
        .all(imageId) as unknown as Array<{ moodboard_id: string }>
    ).map((row) => row.moodboard_id)
  }

  listMoodboards(): Moodboard[] {
    const rows = this.db
      .prepare(
        `SELECT b.*,
          (SELECT COUNT(*) FROM moodboard_images mi WHERE mi.moodboard_id = b.id) AS image_count,
          (SELECT group_concat(image_id, '|') FROM (
            SELECT mi.image_id FROM moodboard_images mi
            JOIN images i ON i.id = mi.image_id
            WHERE mi.moodboard_id = b.id AND i.missing = 0
            ORDER BY COALESCE(mi.z, mi.position) ASC, mi.position ASC LIMIT 4
          )) AS cover_ids
        FROM moodboards b
        ORDER BY b.updated_at DESC`
      )
      .all() as unknown as MoodboardRow[]
    return rows.map(mapMoodboard)
  }

  private ensureBoardLayout(boardId: string): void {
    const rows = this.db
      .prepare(
        `SELECT image_id, position, x, y, width, height, z
         FROM moodboard_images WHERE moodboard_id = ? ORDER BY position ASC`
      )
      .all(boardId) as unknown as Array<{
      image_id: string
      position: number
      x: number | null
      y: number | null
      width: number | null
      height: number | null
      z: number | null
    }>
    if (rows.length === 0) return
    const update = this.db.prepare(
      `UPDATE moodboard_images SET x = ?, y = ?, width = ?, height = ?, z = ?
       WHERE moodboard_id = ? AND image_id = ?`
    )
    this.tx(() => {
      rows.forEach((row, index) => {
        if (row.x !== null && row.y !== null && row.width !== null && row.height !== null && row.z !== null) return
        const placement = defaultBoardPlacement(index)
        update.run(
          row.x ?? placement.x,
          row.y ?? placement.y,
          row.width ?? placement.width,
          row.height ?? placement.height,
          row.z ?? index,
          boardId,
          row.image_id
        )
      })
    })
  }

  getMoodboard(id: string): MoodboardDetail | null {
    const board = this.listMoodboards().find((entry) => entry.id === id)
    if (!board) return null
    this.ensureBoardLayout(id)
    const rows = this.db
      .prepare(
        `SELECT i.*,
          mi.x AS layout_x,
          mi.y AS layout_y,
          mi.width AS layout_width,
          mi.height AS layout_height,
          mi.z AS board_z,
          mi.position AS position
         FROM moodboard_images mi
         JOIN images i ON i.id = mi.image_id
         WHERE mi.moodboard_id = ?
         ORDER BY COALESCE(mi.z, mi.position) ASC, mi.position ASC`
      )
      .all(id) as unknown as MoodboardImageRow[]
    return { ...board, images: rows.map(mapMoodboardImage) }
  }

  createMoodboard(name: string): Moodboard {
    const clean = name.trim().slice(0, 80) || 'Untitled board'
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare('INSERT INTO moodboards(id, name, created_at, updated_at) VALUES(?, ?, ?, ?)').run(
      id,
      clean,
      now,
      now
    )
    return this.listMoodboards().find((board) => board.id === id)!
  }

  renameMoodboard(id: string, name: string): Moodboard {
    const clean = name.trim().slice(0, 80) || 'Untitled board'
    const result = this.db
      .prepare('UPDATE moodboards SET name = ?, updated_at = ? WHERE id = ?')
      .run(clean, Date.now(), id)
    if (result.changes === 0) throw new Error('Moodboard not found.')
    return this.listMoodboards().find((board) => board.id === id)!
  }

  deleteMoodboard(id: string): void {
    this.db.prepare('DELETE FROM moodboards WHERE id = ?').run(id)
  }

  addToMoodboard(boardId: string, imageIds: string[], placements?: BoardImagePlacement[]): Moodboard {
    this.tx(() => {
      const next = this.db
        .prepare(
          `SELECT COALESCE(MAX(position), -1) + 1 AS position, COALESCE(MAX(z), -1) + 1 AS z,
             COUNT(*) AS count
           FROM moodboard_images WHERE moodboard_id = ?`
        )
        .get(boardId) as { position: number; z: number; count: number }
      let position = Number(next.position)
      let nextZ = Number(next.z)
      let slot = Number(next.count)
      const existingPlacements = this.db
        .prepare(
          `SELECT x, y, width, height FROM moodboard_images
           WHERE moodboard_id = ? AND x IS NOT NULL AND y IS NOT NULL
             AND width IS NOT NULL AND height IS NOT NULL`
        )
        .all(boardId) as unknown as BoardPlacement[]
      const occupied = existingPlacements.map((placement) => sanitizePlacement(placement))
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO moodboard_images(
          moodboard_id, image_id, position, added_at, x, y, width, height, z
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const placementById = new Map((placements ?? []).map((placement) => [placement.imageId, placement]))
      for (const imageId of imageIds) {
        const exists = this.db
          .prepare('SELECT 1 AS ok FROM moodboard_images WHERE moodboard_id = ? AND image_id = ?')
          .get(boardId, imageId)
        if (exists) continue
        const dimensions = this.db
          .prepare('SELECT width, height FROM images WHERE id = ?')
          .get(imageId) as { width: number; height: number } | undefined
        const imageAspect =
          dimensions && Number(dimensions.width) > 0 && Number(dimensions.height) > 0
            ? Number(dimensions.width) / Number(dimensions.height)
            : undefined
        const explicit = placementById.get(imageId)
        let placement = explicit
          ? sanitizePlacement({ ...explicit, z: explicit.z ?? nextZ })
          : { ...findFreeBoardPlacement(slot, occupied, imageAspect), z: nextZ }
        if (explicit && imageAspect) {
          placement = {
            ...placement,
            height: roundLayout(clamp((placement.width * BOARD_WORLD_ASPECT) / imageAspect, 0.05, 20))
          }
        }
        occupied.push(placement)
        insert.run(
          boardId,
          imageId,
          position,
          Date.now(),
          placement.x,
          placement.y,
          placement.width,
          placement.height,
          placement.z ?? nextZ
        )
        position += 1
        nextZ += 1
        slot += 1
      }
      this.db.prepare('UPDATE moodboards SET updated_at = ? WHERE id = ?').run(Date.now(), boardId)
    })
    const board = this.listMoodboards().find((entry) => entry.id === boardId)
    if (!board) throw new Error('Moodboard not found.')
    return board
  }

  updateBoardItem(input: {
    moodboardId: string
    imageId: string
    x: number
    y: number
    width: number
    height: number
    z?: number
  }): MoodboardDetail {
    const placement = sanitizePlacement(input)
    const result = this.db
      .prepare(
        `UPDATE moodboard_images SET x = ?, y = ?, width = ?, height = ?, z = ?
         WHERE moodboard_id = ? AND image_id = ?`
      )
      .run(
        placement.x,
        placement.y,
        placement.width,
        placement.height,
        placement.z ?? 0,
        input.moodboardId,
        input.imageId
      )
    if (result.changes === 0) throw new Error('That image is no longer on this moodboard.')
    this.db.prepare('UPDATE moodboards SET updated_at = ? WHERE id = ?').run(Date.now(), input.moodboardId)
    const board = this.getMoodboard(input.moodboardId)
    if (!board) throw new Error('Moodboard not found.')
    return board
  }

  removeFromMoodboard(boardId: string, imageId: string): Moodboard {
    this.tx(() => {
      this.db
        .prepare('DELETE FROM moodboard_images WHERE moodboard_id = ? AND image_id = ?')
        .run(boardId, imageId)
      this.db.prepare('UPDATE moodboards SET updated_at = ? WHERE id = ?').run(Date.now(), boardId)
    })
    const board = this.listMoodboards().find((entry) => entry.id === boardId)
    if (!board) throw new Error('Moodboard not found.')
    return board
  }

  reorderMoodboard(boardId: string, imageIds: string[]): Moodboard {
    this.tx(() => {
      const update = this.db.prepare(
        'UPDATE moodboard_images SET position = ?, z = ? WHERE moodboard_id = ? AND image_id = ?'
      )
      imageIds.forEach((imageId, index) => update.run(index, index, boardId, imageId))
      this.db.prepare('UPDATE moodboards SET updated_at = ? WHERE id = ?').run(Date.now(), boardId)
    })
    const board = this.listMoodboards().find((entry) => entry.id === boardId)
    if (!board) throw new Error('Moodboard not found.')
    return board
  }

  getImagePath(id: string): string | null {
    const row = this.db.prepare('SELECT path FROM images WHERE id = ?').get(id) as { path: string } | undefined
    return row?.path ?? null
  }

  /** Moving an image keeps its ID. Its former filename can later belong to a different picture. */
  newImageId(path: string): string {
    const preferred = imageIdForPath(path)
    return this.getImagePath(preferred) ? randomUUID().replace(/-/g, '').slice(0, 24) : preferred
  }

  getImageForOrganize(id: string): ImageItem | null {
    return this.getImage(id)
  }

  getOrganizeCandidates(selection: OrganizeSelection): ImageItem[] {
    const conditions = ['missing = 0']
    const params: Array<string | number> = []
    if (selection.kind === 'keep') {
      conditions.push("(decision = 'keep' OR favorite = 1)")
    } else if (selection.kind === 'pass') {
      conditions.push("decision = 'pass' AND favorite = 0")
    } else if (selection.kind === 'stars') {
      conditions.push('rating >= ?')
      params.push(Math.max(1, Math.min(5, Math.round(selection.minRating))))
    } else if (selection.kind === 'manual') {
      const ids = Array.from(new Set(selection.ids.filter((id) => typeof id === 'string' && id.length > 0)))
      if (ids.length === 0) return []
      const results: ImageItem[] = []
      for (let index = 0; index < ids.length; index += 400) {
        const chunk = ids.slice(index, index + 400)
        const placeholders = chunk.map(() => '?').join(', ')
        const rows = this.db
          .prepare(
            `SELECT * FROM images WHERE missing = 0 AND id IN (${placeholders})
             ORDER BY folder COLLATE NOCASE ASC, filename COLLATE NOCASE ASC`
          )
          .all(...chunk) as unknown as ImageRow[]
        results.push(...rows.map(mapImage))
      }
      return results
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM images WHERE ${conditions.join(' AND ')}
         ORDER BY folder COLLATE NOCASE ASC, filename COLLATE NOCASE ASC`
      )
      .all(...params) as unknown as ImageRow[]
    return rows.map(mapImage)
  }

  /**
   * The most recent imports, newest first: pictures Atlas indexed within `gapMs` of each other belong to one import (a source added, a
   * drive discovery, a rescan that found new files). Uses the time Atlas indexed them, never the dates of the files.
   */
  listImportBatches(limit = 12, gapMs = 20 * 60_000): Array<{ from: number; to: number; count: number; roots: string[] }> {
    const rows = this.db.prepare('SELECT added_at AS at, root_id AS rootId FROM images WHERE missing = 0 ORDER BY added_at DESC LIMIT 60000').all() as unknown as Array<{ at: number; rootId: string }>
    const names = new Map((this.db.prepare('SELECT id, name FROM roots').all() as unknown as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]))
    const out: Array<{ from: number; to: number; count: number; roots: Set<string> }> = []
    for (const row of rows) {
      const last = out[out.length - 1]
      if (last && last.from - row.at <= gapMs) {
        last.from = row.at
        last.count += 1
        last.roots.add(names.get(row.rootId) ?? '')
      } else {
        if (out.length >= limit) break
        out.push({ from: row.at, to: row.at, count: 1, roots: new Set([names.get(row.rootId) ?? '']) })
      }
    }
    return out.map((b) => ({ from: b.from, to: b.to, count: b.count, roots: Array.from(b.roots).filter(Boolean).slice(0, 4) }))
  }

  getRootForDestination(folderPath: string): string {
    const normalized = normalizePath(folderPath)
    const roots = this.db.prepare('SELECT * FROM roots').all() as unknown as RootRow[]
    const containing = roots
      .filter((root) => {
        const rel = win32.relative(root.path, normalized)
        return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel))
      })
      .sort((left, right) => right.path.length - left.path.length)
    if (containing[0]) return containing[0].id
    return this.addRoot(normalized).id
  }

  isPathIndexed(path: string, excludeId?: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM images WHERE path = ? COLLATE NOCASE')
      .get(normalizePath(path)) as { id: string } | undefined
    return Boolean(row && row.id !== excludeId)
  }

  relocateImage(
    id: string,
    input: { path: string; rootId: string; bytes: number; mtime: number }
  ): ImageItem {
    const normalized = normalizePath(input.path)
    const folder = win32.dirname(normalized)
    const filename = win32.basename(normalized)
    const ext = win32.extname(normalized).replace(/^\./, '').toLowerCase()
    const result = this.db
      .prepare(
        `UPDATE images SET
          path = ?, folder = ?, filename = ?, ext = ?, root_id = ?, bytes = ?, mtime = ?,
          missing = 0, scan_token = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(normalized, normalizePath(folder), filename, ext, input.rootId, input.bytes, input.mtime, Date.now(), id)
    if (result.changes === 0) throw new Error('The image record could not be updated.')
    return this.getImage(id)!
  }

  getImageIdsForRoot(rootId: string): string[] {
    return (this.db.prepare('SELECT id FROM images WHERE root_id = ?').all(rootId) as unknown as Array<{ id: string }>).map(
      (row) => row.id
    )
  }

  getSchemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('version') as
      | { value: string }
      | undefined
    return Number(row?.value ?? 0)
  }

  getThumbStatus(id: string): string | null {
    const row = this.db.prepare('SELECT thumb_status FROM images WHERE id = ?').get(id) as
      | { thumb_status: string }
      | undefined
    return row?.thumb_status ?? null
  }
}

export type ScanPhaseName = ScanPhase
