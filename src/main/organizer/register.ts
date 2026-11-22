import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { AtlasDatabase } from '../db'
import type { Embedder } from '../embedder'
import type { ReferenceCollection } from '../reference'
import type { SemanticSearch } from '../semantic'
import type { SmartCollections } from '../smartCollections'
import type { IdentityEngine } from '../identity'
import type { TasteEngine } from '../tasteEngine'
import { CurationService } from '../curationService'
import type { OrganizeKind, OrganizeScope, OrganizeSettings } from '../../shared/organizer'
import { OrganizerEngine, type RefineOp } from './engine'

export interface OrganizerWiring {
  dataDir: string
  db: () => AtlasDatabase
  semantic: () => SemanticSearch | null
  reference: () => ReferenceCollection | null
  identity: () => IdentityEngine | null
  taste: () => TasteEngine | null
  smart: () => SmartCollections | null
  embedder: () => Promise<Embedder>
  thumbnailsDir: string
  broadcast: (channel: string, payload?: unknown) => void
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '')
const KINDS: OrganizeKind[] = ['artwork', 'photograph', 'experiment', 'technical', 'uncertain']
const kindOf = (v: unknown): OrganizeKind | undefined => KINDS.find((k) => k === v)

function cleanScope(value: unknown): OrganizeScope {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const strings = (x: unknown, n: number): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, n) : [])
  return { all: v.all === true, rootIds: strings(v.rootIds, 200), folders: strings(v.folders, 200), imageIds: strings(v.imageIds, 50_000) }
}

function cleanOps(value: unknown): RefineOp[] {
  if (!Array.isArray(value)) return []
  const out: RefineOp[] = []
  for (const raw of value.slice(0, 40)) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    switch (o.op) {
      case 'structure':
        if (['kind-subject', 'subject', 'year-subject', 'kind', 'flat'].includes(String(o.value))) out.push({ op: 'structure', value: o.value as OrganizeSettings['structure'] })
        break
      case 'duplicates':
        if (['separate', 'best-only', 'keep-all'].includes(String(o.value))) out.push({ op: 'duplicates', value: o.value as OrganizeSettings['duplicates'] })
        break
      case 'select':
        out.push({ op: 'select', keys: Array.isArray(o.keys) ? o.keys.map((x) => str(x, 200)).filter(Boolean).slice(0, 400) : [] })
        break
      case 'rename':
        out.push({ op: 'rename', from: str(o.from, 120), to: str(o.to, 80), kind: kindOf(o.kind) })
        break
      case 'merge':
        out.push({ op: 'merge', from: Array.isArray(o.from) ? o.from.map((x) => str(x, 120)).slice(0, 40) : [], into: str(o.into, 80), kind: kindOf(o.kind) })
        break
      case 'exclude':
      case 'include': {
        const kind = kindOf(o.kind)
        if (kind) out.push({ op: o.op, kind })
        break
      }
      case 'custom':
        out.push({ op: 'custom', name: str(o.name, 80), description: str(o.description, 300) })
        break
      case 'remove_custom':
        out.push({ op: 'remove_custom', name: str(o.name, 80) })
        break
      case 'move':
        out.push({ op: 'move', imageIds: Array.isArray(o.imageIds) ? o.imageIds.filter((x): x is string => typeof x === 'string').slice(0, 5000) : [], category: str(o.category, 80) || undefined, kind: kindOf(o.kind) })
        break
      case 'reclassify': {
        const from = kindOf(o.from)
        const to = kindOf(o.to)
        if (from && to) out.push({ op: 'reclassify', from, to })
        break
      }
      case 'min_group':
        if (typeof o.value === 'number') out.push({ op: 'min_group', value: o.value })
        break
    }
  }
  return out
}

/** The Smart Organizer's window functions. Everything here reads pictures; copying happens only in export, to a folder the user chose. */
export function registerOrganizer(wiring: OrganizerWiring): { engine: OrganizerEngine } {
  const curation = new CurationService({
    db: wiring.db,
    semantic: wiring.semantic,
    embedder: wiring.embedder,
    reference: wiring.reference,
    smart: wiring.smart,
    identity: wiring.identity,
    taste: wiring.taste,
    thumbnailsDir: wiring.thumbnailsDir ?? join(wiring.dataDir, 'thumbnails')
  })
  const engine = new OrganizerEngine({
    db: wiring.db(),
    embedder: wiring.embedder,
    roles: async (items) => {
      const roles = await curation.roles(items)
      return new Map(Array.from(roles.entries()).map(([id, r]) => [id, { role: r.role === 'finished' || r.role === 'technical' || r.role === 'experimental' || r.role === 'unclear' ? r.role : 'unclear', reasons: r.reasons }]))
    },
    progress: (p) => wiring.broadcast('organizer:progress', p),
    changed: (planId) => wiring.broadcast('organizer:changed', { planId })
  })

  ipcMain.handle('organizer:plans', () => engine.plans())
  ipcMain.handle('organizer:count', (_e, scope: unknown) => engine.countScope(cleanScope(scope)))
  ipcMain.handle('organizer:create', (_e, name: unknown, scope: unknown, settings: unknown) => {
    const s = (settings && typeof settings === 'object' ? settings : {}) as Partial<OrganizeSettings>
    const plan = engine.createPlan(str(name, 80), cleanScope(scope), { structure: s.structure, duplicates: s.duplicates })
    engine.start(plan.id)
    return engine.plan(plan.id)
  })
  ipcMain.handle('organizer:plan', (_e, id: unknown) => engine.plan(str(id, 60)))
  ipcMain.handle('organizer:start', (_e, id: unknown) => {
    engine.start(str(id, 60))
    return engine.plan(str(id, 60))
  })
  ipcMain.handle('organizer:pause', (_e, id: unknown) => engine.pause(str(id, 60)))
  ipcMain.handle('organizer:cancel', (_e, id: unknown) => engine.cancel(str(id, 60)))
  ipcMain.handle('organizer:delete', (_e, id: unknown) => engine.deletePlan(str(id, 60)))
  ipcMain.handle('organizer:overview', (_e, id: unknown) => engine.overview(str(id, 60)))
  // Pictures to look at in the viewer (a group, or the members of a set of copies), without changing anything.
  ipcMain.handle('organizer:group-images', (_e, id: unknown, kind: unknown, name: unknown) => {
    const k = kindOf(kind)
    if (!k) return []
    return wiring.db().getImagesByIds(engine.groupImageIds(str(id, 60), k, str(name, 200)))
  })
  ipcMain.handle('organizer:images', (_e, ids: unknown) => wiring.db().getImagesByIds(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string').slice(0, 400) : []))
  ipcMain.handle('organizer:duplicates', (_e, id: unknown, offset: unknown) => engine.duplicateGroups(str(id, 60), 40, typeof offset === 'number' ? offset : 0))
  ipcMain.handle('organizer:refine', (_e, id: unknown, ops: unknown) => engine.refine(str(id, 60), cleanOps(ops)))
  ipcMain.handle('organizer:choose-destination', async () => {
    // Only the end-to-end test environment may name the folder without the native dialog.
    if (process.env.NOEMA_E2E === '1' && process.env.NOEMA_E2E_DESTINATION) return process.env.NOEMA_E2E_DESTINATION
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { title: 'Choose where to copy the organized pictures', properties: ['openDirectory' as const, 'createDirectory' as const, 'dontAddToRecent' as const] }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0]
  })
  ipcMain.handle('organizer:preview', (_e, id: unknown, destination: unknown, offset: unknown, mode: unknown) => engine.preview(str(id, 60), str(destination, 1000), 200, typeof offset === 'number' ? Math.max(0, offset) : 0, mode === 'move' ? 'move' : 'copy'))
  ipcMain.handle('organizer:export', async (_e, id: unknown, destination: unknown, verify: unknown, mode: unknown) => {
    await engine.startExport(str(id, 60), str(destination, 1000), { verify: verify === 'hash' ? 'hash' : 'size', mode: mode === 'move' ? 'move' : 'copy' })
    return engine.plan(str(id, 60))
  })
  ipcMain.handle('organizer:resume-export', (_e, id: unknown) => {
    engine.resumeExport(str(id, 60))
    return engine.plan(str(id, 60))
  })
  ipcMain.handle('organizer:pause-export', (_e, id: unknown) => engine.pauseExport(str(id, 60)))
  ipcMain.handle('organizer:cancel-export', (_e, id: unknown) => engine.cancelExport(str(id, 60)))
  ipcMain.handle('organizer:report', (_e, id: unknown) => engine.report2(str(id, 60)))
  ipcMain.handle('organizer:open-destination', (_e, id: unknown) => {
    const plan = engine.plan(str(id, 60))
    return plan?.destination ? shell.openPath(plan.destination) : ''
  })
  return { engine }
}
