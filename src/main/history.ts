import type { AtlasDatabase } from './db'
import type { DiscoveryEngine } from './discovery'
import type { IdentityEngine } from './identity'
import type { ReferenceCollection } from './reference'
import { TASTE_DIMENSIONS } from './tasteDimensions'
import type { HistorySnapshot, HistoryState, ProfileDimension, ReferenceWork } from '../shared/types'

interface Payload {
  identity: { favorites: number; dimensions: Array<{ id: string; mean: number; certain: boolean }>; modes: number }
  discovered: { answers: number; dimensions: Array<{ id: string; mean: number; certain: boolean }>; modes: number }
}

const MONTH = 30 * 24 * 3600 * 1000
const compact = (dims: ProfileDimension[]): Array<{ id: string; mean: number; certain: boolean }> =>
  dims.map((d) => ({ id: d.id, mean: Math.round(d.mean * 1000) / 1000, certain: d.certain }))

/**
 * Keeps a record of how taste changes. A snapshot stores each profile as it was at that moment, so history survives
 * later edits (un-favoriting, starting over). On a library that already has dated favorites, earlier snapshots are
 * rebuilt from those dates and clearly labelled as reconstructed.
 */
export class HistoryEngine {
  constructor(
    private db: AtlasDatabase,
    private reference: ReferenceCollection,
    private identity: IdentityEngine,
    private discovery: DiscoveryEngine
  ) {}

  private last(): { at: number; payload: Payload; reconstructed: boolean } | null {
    const rows = this.db.listSnapshots().filter((r) => r.reconstructed === 0)
    const row = rows[rows.length - 1]
    return row ? { at: row.at, payload: JSON.parse(row.payload) as Payload, reconstructed: false } : null
  }

  /** Takes a snapshot when enough has changed since the last one. Cheap to call often. */
  async snapshotIfDue(force = false): Promise<boolean> {
    const discovery = await this.discovery.state()
    const identityData = await this.identity.compute()
    const identity = identityData.state
    const favorites = identity.learned
    const last = this.last()
    const answers = discovery.informative
    const due =
      force ||
      (!last && (answers >= 3 || favorites >= 3)) ||
      (last && (answers - last.payload.discovered.answers >= 8 || favorites - last.payload.identity.favorites >= 3 || (Date.now() - last.at > 7 * 24 * 3600 * 1000 && (answers !== last.payload.discovered.answers || favorites !== last.payload.identity.favorites))))
    if (!due) return false
    const payload: Payload = {
      identity: { favorites, dimensions: compact(identity.dimensions), modes: identity.modes.length },
      discovered: { answers, dimensions: compact(discovery.dimensions), modes: discovery.modes.length }
    }
    this.db.addSnapshot(Date.now(), JSON.stringify(payload), false)
    return true
  }

  /** Rebuilds earlier snapshots from the dates favorites were marked (month by month). Idempotent. */
  async reconstruct(): Promise<void> {
    const favorites = this.db.listFavorites().filter((f) => f.favoriteAt)
    if (favorites.length < 6) return
    const times = favorites.map((f) => f.favoriteAt!).sort((a, b) => a - b)
    const first = times[0]!
    const lastAt = times[times.length - 1]!
    if (lastAt - first < 2 * MONTH) return
    this.db.clearReconstructedSnapshots()
    const steps = Math.min(6, Math.floor((lastAt - first) / MONTH))
    for (let i = 1; i <= steps; i += 1) {
      const at = first + ((lastAt - first) * i) / (steps + 1)
      const data = await this.identity.compute(at)
      if (!data.state.available) continue
      const payload: Payload = {
        identity: { favorites: data.state.learned, dimensions: compact(data.state.dimensions), modes: data.state.modes.length },
        discovered: { answers: 0, dimensions: [], modes: 0 }
      }
      this.db.addSnapshot(at, JSON.stringify(payload), true)
    }
  }

  private discoveriesBetween(from: number, to: number): ReferenceWork[] {
    const out: ReferenceWork[] = []
    const seen = new Set<string>()
    for (const e of this.db.listDiscoveryEvents()) {
      if (e.at <= from || e.at > to) continue
      const refs: Array<string | null> = e.kind === 'prefer' ? [e.winner_ref] : e.kind === 'both' ? [e.a_ref, e.b_ref] : e.kind === 'like' || e.kind === 'save' ? [e.a_ref] : []
      for (const ref of refs) {
        const work = ref ? this.reference.work(ref) : null
        if (work && !seen.has(work.id)) {
          seen.add(work.id)
          out.push(work)
        }
      }
    }
    return out.slice(0, 8)
  }

  async state(): Promise<HistoryState> {
    await this.reconstruct()
    await this.snapshotIfDue()
    const rows = this.db.listSnapshots()
    const snapshots: HistorySnapshot[] = rows.map((row, i) => {
      const payload = JSON.parse(row.payload) as Payload
      const previous = rows[i - 1]?.at ?? 0
      return {
        id: row.id,
        at: row.at,
        identity: payload.identity,
        discovered: payload.discovered,
        discoveries: row.reconstructed === 1 ? [] : this.discoveriesBetween(previous, row.at),
        reconstructed: row.reconstructed === 1
      }
    })
    const changes: HistoryState['changes'] = []
    for (const profile of ['identity', 'discovered'] as const) {
      const withData = snapshots.filter((s) => s[profile].dimensions.length > 0)
      if (withData.length < 2) continue
      const a = withData[0]![profile]
      const b = withData[withData.length - 1]![profile]
      for (const spec of TASTE_DIMENSIONS) {
        const from = a.dimensions.find((d) => d.id === spec.id)
        const to = b.dimensions.find((d) => d.id === spec.id)
        if (!from || !to) continue
        if (Math.abs(to.mean - from.mean) >= 0.4 && (to.certain || from.certain)) changes.push({ id: spec.id, label: spec.label, profile, from: from.mean, to: to.mean })
      }
    }
    return {
      snapshots,
      changes: changes.sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from)).slice(0, 8),
      note:
        snapshots.length < 2
          ? 'History builds as you favorite images and explore. Atlas saves a snapshot whenever enough has changed.'
          : 'Each snapshot is the profile as it was then. Entries marked reconstructed are rebuilt from the dates you favorited images, so they show only favorites you still have. The discoveries listed are works you chose, liked or saved in that interval; they coincide with changes but are not proven to have caused them.'
    }
  }
}
