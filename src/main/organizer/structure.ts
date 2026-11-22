import { basename, extname, join } from 'node:path'
import type { DuplicatePolicy, OrganizeKind, OrganizeOpPreview, OrganizeSettings, StructurePreset } from '../../shared/organizer'

// The pure part of the Smart Organizer: where each picture would go, under which name, and what clashes. Nothing here
// touches the disk; the caller says which files already exist.

/** The row the analysis keeps for each picture. */
export interface OrganizeItem {
  id: string
  path: string
  filename: string
  ext: string
  bytes: number
  width: number
  height: number
  /** The year from the file's date. */
  year: number
  kind: OrganizeKind
  kindWhy: string
  /** The automatic folder name (or the user's category name), before renames and merges. */
  subject: string | null
  subjectConfidence: 'clear' | 'loose' | 'mixed' | 'custom' | null
  cluster: number | null
  dupGroup: string | null
  dupType: 'exact' | 'near' | 'versions' | null
  isBest: boolean
  modelRead: boolean
}

export const SHORT_KIND: Record<OrganizeKind, string> = {
  artwork: 'Finished artwork',
  photograph: 'Photographs',
  experiment: 'Experiments',
  technical: 'Screenshots and technical',
  uncertain: 'To review'
}
export const DUPLICATES_FOLDER = 'Duplicates and versions'
const OTHER = 'Other'
const UNSORTED = 'Unsorted'

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** A name that is safe as a Windows file or folder name. */
export function safeName(name: string, fallback = 'Untitled'): string {
  let n = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
  if (n.length > 80) n = n.slice(0, 80).trim()
  if (!n) return fallback
  if (RESERVED.test(n)) n = `${n}_`
  return n
}

export function categoryKey(kind: OrganizeKind, subject: string | null): string {
  return `${kind}|${subject ?? UNSORTED}`
}

export interface Placement {
  kind: OrganizeKind
  key: string
  /** The folder name after renames and merges; null when the picture has no subject folder. */
  name: string
}

/** The kind and folder name a picture ends up with, after the user's own placements, renames and merges. */
export function placementOf(item: OrganizeItem, settings: OrganizeSettings): Placement {
  const override = settings.overrides[item.id]
  const kind = override?.kind ?? settings.kindMap?.[item.kind] ?? item.kind
  if (override?.subject) return { kind, key: categoryKey(kind, override.subject), name: override.subject }
  // Working images and uncertain ones are collected as they are, without subject folders.
  if (kind === 'technical' || kind === 'uncertain') return { kind, key: categoryKey(kind, null), name: UNSORTED }
  // A kind the user changed picture by picture has no automatic subject of its own for that kind.
  if (override?.kind && override.kind !== item.kind) return { kind, key: categoryKey(kind, UNSORTED), name: UNSORTED }
  const key = categoryKey(kind, item.subject)
  const merged = settings.merges[key]
  const renamed = settings.renames[key]
  return { kind, key, name: merged ?? renamed ?? item.subject ?? UNSORTED }
}

/**
 * The pictures an operation covers. With nothing checked, all of them; with groups checked, ONLY the pictures of those groups (a group is a
 * final folder name within a kind, after renames and merges). A group of copies or versions whose best picture is not among the chosen ones
 * gets a new best among the chosen members, so the copies policy still places them sensibly.
 */
export function selectItems<T extends OrganizeItem>(items: T[], settings: OrganizeSettings): T[] {
  const keys = settings.selection ?? []
  // Nothing checked means nothing selected: an empty selection is never read as "everything".
  if (keys.length === 0) return []
  const wanted = new Set(keys)
  const chosen = items.filter((item) => {
    const p = placementOf(item, settings)
    return wanted.has(`${p.kind}|${p.name}`)
  })
  const hasBest = new Set(chosen.filter((i) => i.dupGroup && i.isBest).map((i) => i.dupGroup as string))
  const needs = new Map<string, T[]>()
  for (const item of chosen) if (item.dupGroup && !hasBest.has(item.dupGroup)) needs.set(item.dupGroup, [...(needs.get(item.dupGroup) ?? []), item])
  const promote = new Set<string>()
  for (const members of needs.values()) {
    const best = [...members].sort((a, b) => b.width * b.height - a.width * a.height || b.bytes - a.bytes || a.path.localeCompare(b.path))[0]!
    promote.add(best.id)
  }
  return chosen.map((i) => (promote.has(i.id) ? { ...i, isBest: true } : i))
}

/** Counts per final folder name within each kind, for folding small folders into “Other”. */
function smallFolders(items: OrganizeItem[], settings: OrganizeSettings): Set<string> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const p = placementOf(item, settings)
    const k = `${p.kind}|${p.name}`
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const small = new Set<string>()
  const customNames = new Set(settings.custom.map((c) => c.name.toLowerCase()))
  for (const [k, n] of counts) {
    const name = k.slice(k.indexOf('|') + 1)
    if (n < settings.minGroup && name !== UNSORTED && !customNames.has(name.toLowerCase()) && !Object.values(settings.overrides).some((o) => o.subject === name)) small.add(k)
  }
  return small
}

export interface PlacedItem {
  item: OrganizeItem
  /** Folder segments below the destination. */
  folder: string[]
  action: 'copy' | 'skip-excluded' | 'skip-duplicate'
  kind: OrganizeKind
}

function topFolder(kind: OrganizeKind, structure: StructurePreset): string[] {
  // Working images and uncertain ones never mix with the artwork, whatever the arrangement.
  if (kind === 'technical' || kind === 'uncertain') return [SHORT_KIND[kind]]
  if (structure === 'kind-subject' || structure === 'kind') return [SHORT_KIND[kind]]
  return []
}

/** Where every picture goes. Duplicates follow the policy. */
export function placeItems(items: OrganizeItem[], settings: OrganizeSettings): PlacedItem[] {
  const small = smallFolders(items, settings)
  const names = new Map<string, string>()
  // Duplicate groups are labelled with the best version's name, so the set-apart folders say what they hold.
  const bestOf = new Map<string, OrganizeItem>()
  for (const item of items) if (item.dupGroup && item.isBest) bestOf.set(item.dupGroup, item)
  const out: PlacedItem[] = []
  for (const item of items) {
    const p = placementOf(item, settings)
    if (settings.excludeKinds.includes(p.kind)) {
      out.push({ item, folder: [], action: 'skip-excluded', kind: p.kind })
      continue
    }
    let folder: string[]
    const subject = small.has(`${p.kind}|${p.name}`) ? OTHER : p.name
    const top = topFolder(p.kind, settings.structure)
    const usesSubject = settings.structure !== 'kind' && settings.structure !== 'flat' && p.kind !== 'technical' && p.kind !== 'uncertain'
    if (settings.structure === 'flat') folder = []
    else if (settings.structure === 'year-subject' && p.kind !== 'technical' && p.kind !== 'uncertain') folder = [String(item.year || 'Undated'), safeName(subject)]
    else folder = [...top, ...(usesSubject ? [safeName(subject)] : [])]
    let action: PlacedItem['action'] = 'copy'
    if (item.dupGroup && !item.isBest) {
      if (settings.duplicates === 'best-only') action = 'skip-duplicate'
      else if (settings.duplicates === 'separate') {
        const best = bestOf.get(item.dupGroup)
        const label = best ? safeName(best.filename.replace(/\.[^.]+$/, ''), 'group').slice(0, 50) : item.dupGroup
        folder = [DUPLICATES_FOLDER, label]
      }
    }
    names.set(item.id, folder.join('/'))
    out.push({ item, folder: folder.map((s) => safeName(s)), action, kind: p.kind })
  }
  return out
}

function stemAndExt(filename: string): { stem: string; ext: string } {
  const ext = extname(filename)
  return { stem: basename(filename, ext), ext }
}

export interface ExistingFile {
  size: number
  mtimeMs: number
}

export interface OperationPlan {
  ops: Array<OrganizeOpPreview & { dest: string }>
  conflicts: Array<{ to: string; reason: string; renamedTo: string }>
  warnings: string[]
  tree: Array<{ path: string; count: number }>
  copyBytes: number
  skipped: { same: number; excluded: number; duplicates: number }
}

const MAX_PATH = 240

/**
 * Turns the placement into exact copy operations. Names that clash with another picture in the plan, or with a file
 * already at the destination, get a number (“name (2).png”); nothing is ever overwritten. A file that is already there
 * with verified identical contents is skipped as “already there”.
 */
export async function planOperations(items: OrganizeItem[], settings: OrganizeSettings, destination: string,
  existing: (path: string) => ExistingFile | null, identical: (source: string, destination: string) => Promise<boolean>): Promise<OperationPlan> {
  const placed = placeItems(items, settings)
  const taken = new Map<string, number>()
  const ops: OperationPlan['ops'] = []
  const conflicts: OperationPlan['conflicts'] = []
  const warnings: string[] = []
  const folders = new Map<string, number>()
  const skipped = { same: 0, excluded: 0, duplicates: 0 }
  let copyBytes = 0
  let longNames = 0
  // A stable order, so the same plan always gives the same names.
  const ordered = [...placed].sort((a, b) => a.item.path.localeCompare(b.item.path))
  for (const p of ordered) {
    if (p.action === 'skip-excluded') {
      skipped.excluded += 1
      ops.push({ imageId: p.item.id, from: p.item.path, to: '', dest: '', bytes: p.item.bytes, action: 'skip-excluded' })
      continue
    }
    if (p.action === 'skip-duplicate') {
      skipped.duplicates += 1
      ops.push({ imageId: p.item.id, from: p.item.path, to: '', dest: '', bytes: p.item.bytes, action: 'skip-duplicate', note: 'a copy or version that is not the best one' })
      continue
    }
    const { stem: rawStem, ext } = stemAndExt(p.item.filename)
    let stem = safeName(rawStem, 'picture')
    const folder = join(destination, ...p.folder)
    // Keep the whole path short enough for Windows tools.
    const room = MAX_PATH - folder.length - ext.length - 8
    if (stem.length > room && room > 12) {
      stem = stem.slice(0, room)
      longNames += 1
    }
    let name = `${stem}${ext}`
    let n = 1
    let reason = ''
    let dest = join(folder, name)
    const folderKey = p.folder.join('/')
    for (;;) {
      const clash = taken.get(dest.toLowerCase())
      const there = existing(dest)
      if (!clash && !there) break
      if (there && !clash && there.size === p.item.bytes && await identical(p.item.path, dest)) {
        // Already exported before (or the same file is simply there): leave it.
        skipped.same += 1
        ops.push({ imageId: p.item.id, from: p.item.path, to: join(...p.folder, name), dest, bytes: p.item.bytes, action: 'skip-same', note: 'identical contents already there' })
        folders.set(folderKey, (folders.get(folderKey) ?? 0) + 1)
        dest = ''
        break
      }
      reason = clash ? 'another picture of the plan has this name in the same folder' : 'a different file with this name is already at the destination'
      n += 1
      name = `${stem} (${n})${ext}`
      dest = join(folder, name)
    }
    if (!dest) continue
    taken.set(dest.toLowerCase(), 1)
    if (reason) conflicts.push({ to: join(...p.folder, `${stem}${ext}`), reason, renamedTo: join(...p.folder, name) })
    copyBytes += p.item.bytes
    folders.set(folderKey, (folders.get(folderKey) ?? 0) + 1)
    ops.push({ imageId: p.item.id, from: p.item.path, to: join(...p.folder, name), dest, bytes: p.item.bytes, action: 'copy', ...(reason ? { note: `renamed: ${reason}` } : {}) })
  }
  if (longNames > 0) warnings.push(`${longNames} file name${longNames === 1 ? ' was' : 's were'} shortened to keep the full path under ${MAX_PATH} characters.`)
  const tree = Array.from(folders.entries())
    .map(([path, count]) => ({ path: path || '(the destination folder itself)', count }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return { ops, conflicts, warnings, tree, copyBytes, skipped }
}

/** Best version of a group, and why: favourites and ratings first, then the largest picture, then the larger file, then the oldest. */
export function chooseBest<T extends { id: string; width: number; height: number; bytes: number; favorite: boolean; rating: number; decision: string | null; mtime: number }>(members: T[]): { best: T; why: string } {
  const keep = members.filter((m) => m.decision !== 'pass')
  const pool = keep.length > 0 ? keep : members
  const score = (m: T): number[] => [m.favorite ? 1 : 0, m.rating, m.width * m.height, m.bytes, -m.mtime]
  const best = [...pool].sort((a, b) => {
    const sa = score(a)
    const sb = score(b)
    for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return sb[i]! - sa[i]!
    return 0
  })[0]!
  const others = members.filter((m) => m.id !== best.id)
  let why = 'the largest picture'
  if (best.favorite && others.some((m) => !m.favorite)) why = 'it is one of your favorites'
  else if (best.rating > 0 && others.some((m) => m.rating < best.rating)) why = `you rated it highest (${best.rating})`
  else if (others.every((m) => m.width * m.height === best.width * best.height)) why = others.every((m) => m.bytes === best.bytes) ? 'an identical copy (the oldest is kept)' : 'the largest file at the same size'
  else why = `the largest picture (${best.width}×${best.height})`
  return { best, why }
}

export type { DuplicatePolicy }
