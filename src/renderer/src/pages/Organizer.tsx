import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DUPLICATE_LABELS,
  KIND_NOTES,
  PHASE_LABELS,
  STRUCTURE_LABELS,
  type DuplicateGroupInfo,
  type DuplicatePolicy,
  type ExportReport,
  type OrganizeKind,
  type OrganizeOverview,
  type OrganizePlanInfo,
  type OrganizePreview,
  type OrganizeProgress,
  type StructurePreset,
  groupKey
} from '@shared/organizer'
import type { ImageItem } from '@shared/types'
import { Lightbox } from '../components/Lightbox'
import { ConfirmModal, EmptyState, PromptModal, Spinner } from '../components/ui'
import { OPEN_COMPANION_EVENT } from '../components/Companion'
import { formatBytes, formatNumber, friendlyError, relativeTime } from '../lib/format'
import { useAtlas } from '../lib/useAtlas'

const thumb = (id: string): string => `noema://thumb/${id}.webp`

const STATUS_WORDS: Record<OrganizePlanInfo['status'], string> = {
  draft: 'Starting',
  analyzing: 'Analysing',
  paused: 'Paused',
  ready: 'Ready to review',
  exporting: 'Copying',
  'export-paused': 'Copy paused',
  done: 'Finished',
  failed: 'Stopped by an error',
  cancelled: 'Cancelled'
}

function Thumbs({ ids, size = 44, onOpen, label = 'Look at these pictures' }: { ids: string[]; size?: number; onOpen?: (index: number) => void; label?: string }): React.JSX.Element {
  return (
    <span className="org-thumbs">
      {ids.slice(0, 5).map((id, i) =>
        onOpen ? (
          <button key={id} type="button" className="org-thumb-button" onClick={() => onOpen(i)} title={label} aria-label={label} data-testid="org-thumb">
            <img src={thumb(id)} width={size} height={size} alt="" loading="lazy" />
          </button>
        ) : (
          <img key={id} src={thumb(id)} width={size} height={size} alt="" loading="lazy" />
        )
      )}
    </span>
  )
}

function Bar({ done, total }: { done: number; total: number }): React.JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  return (
    <div className="org-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

export function OrganizerPage({ initialPlanId }: { initialPlanId?: string }): React.JSX.Element {
  const atlas = useAtlas()
  const [plans, setPlans] = useState<OrganizePlanInfo[]>([])
  const [selected, setSelected] = useState<string | null>(initialPlanId ?? null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setPlans(await window.noema.organizerPlans())
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    void load()
    return window.noema.onOrganizerChanged(() => void load())
  }, [load])

  useEffect(() => {
    if (initialPlanId) setSelected(initialPlanId)
  }, [initialPlanId])

  const current = plans.find((p) => p.id === selected) ?? null

  return (
    <div className="page page--organizer" data-testid="organizer-page">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">SMART ORGANIZER · FOLDERS FROM WHAT THE PICTURES ARE</div>
          <h1 className="page-title">Organize a large collection</h1>
          <p className="page-subtitle">
            Atlas reads your pictures, sorts finished artwork from photographs, screenshots and experiments, groups them by subject and style, finds copies and versions, and proposes folders. Nothing is moved or deleted: approved folders are made as copies in a place you choose.
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="button button--ghost" onClick={() => window.dispatchEvent(new Event(OPEN_COMPANION_EVENT))}>
            Ask Atlas
          </button>
          {current ? (
            <button type="button" className="button button--quiet" onClick={() => setSelected(null)} data-testid="org-back">
              All organizations
            </button>
          ) : null}
        </div>
      </header>
      {error ? <p className="org-error">{error}</p> : null}
      {current ? (
        <PlanView key={current.id} plan={current} onChanged={load} onGone={() => { setSelected(null); void load() }} />
      ) : (
        <StartView plans={plans} roots={atlas.roots} onOpen={setSelected} onCreated={(p) => { setSelected(p.id); void load() }} onChanged={load} />
      )}
    </div>
  )
}

// ---- start ------------------------------------------------------------------------------------------------------------

function StartView({
  plans,
  roots,
  onOpen,
  onCreated,
  onChanged
}: {
  plans: OrganizePlanInfo[]
  roots: Array<{ id: string; name: string; path: string; imageCount: number }>
  onOpen: (id: string) => void
  onCreated: (plan: OrganizePlanInfo) => void
  onChanged: () => Promise<void>
}): React.JSX.Element {
  const [all, setAll] = useState(true)
  const [chosen, setChosen] = useState<string[]>([])
  const [name, setName] = useState('')
  const [structure, setStructure] = useState<StructurePreset>('kind-subject')
  const [duplicates, setDuplicates] = useState<DuplicatePolicy>('separate')
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<OrganizePlanInfo | null>(null)

  const scope = useMemo(() => (all ? { all: true } : { rootIds: chosen }), [all, chosen])
  useEffect(() => {
    let live = true
    if (!all && chosen.length === 0) {
      setCount(0)
      return
    }
    void window.noema.organizerCount(scope).then((n) => live && setCount(n)).catch(() => live && setCount(null))
    return () => {
      live = false
    }
  }, [scope, all, chosen.length])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const plan = await window.noema.organizerCreate(name.trim() || (all ? 'Whole library' : 'Selected sources'), scope, { structure, duplicates })
      if (plan) onCreated(plan)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="org-grid">
      <section className="org-card" aria-labelledby="org-new">
        <h2 id="org-new">New organization</h2>
        <label className="org-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Spring cleanup" maxLength={80} data-testid="org-name" />
        </label>
        <fieldset className="org-field">
          <legend>Which pictures</legend>
          <label className="org-check">
            <input type="radio" checked={all} onChange={() => setAll(true)} /> The whole library
          </label>
          <label className="org-check">
            <input type="radio" checked={!all} onChange={() => setAll(false)} /> Only some sources (folders and drives)
          </label>
          {!all ? (
            <div className="org-sources">
              {roots.length === 0 ? <p className="org-muted">No sources yet. Add one in Sources.</p> : null}
              {roots.map((r) => (
                <label key={r.id} className="org-check" title={r.path}>
                  <input type="checkbox" checked={chosen.includes(r.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, r.id] : c.filter((x) => x !== r.id)))} />
                  {r.name} <span className="org-muted">{formatNumber(r.imageCount)}</span>
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>
        <label className="org-field">
          <span>Folder layout</span>
          <select value={structure} onChange={(e) => setStructure(e.target.value as StructurePreset)} data-testid="org-structure">
            {(Object.keys(STRUCTURE_LABELS) as StructurePreset[]).map((k) => (
              <option key={k} value={k}>{STRUCTURE_LABELS[k].label}, e.g. {STRUCTURE_LABELS[k].example}</option>
            ))}
          </select>
        </label>
        <label className="org-field">
          <span>Copies and versions</span>
          <select value={duplicates} onChange={(e) => setDuplicates(e.target.value as DuplicatePolicy)}>
            {(Object.keys(DUPLICATE_LABELS) as DuplicatePolicy[]).map((k) => (
              <option key={k} value={k}>{DUPLICATE_LABELS[k].label}</option>
            ))}
          </select>
        </label>
        <p className="org-muted">
          {count === null ? '' : `${formatNumber(count)} pictures will be read.`} Reading takes a while for large collections; you can pause, close Atlas and continue later. Nothing is copied or moved in this step.
        </p>
        {error ? <p className="org-error">{error}</p> : null}
        <button type="button" className="button button--gold" disabled={busy || !count} onClick={() => void create()} data-testid="org-analyze">
          Analyse
        </button>
      </section>

      <section className="org-card" aria-labelledby="org-old">
        <h2 id="org-old">Your organizations</h2>
        {plans.length === 0 ? (
          <EmptyState icon="archive" title="Nothing yet" copy="Start one on the left, or ask Atlas in the conversation panel to organize a source." />
        ) : (
          <ul className="org-plans">
            {plans.map((p) => (
              <li key={p.id}>
                <button type="button" className="org-plan" onClick={() => onOpen(p.id)}>
                  <strong>{p.name}</strong>
                  <span>{formatNumber(p.total)} pictures · {STATUS_WORDS[p.status]} · {relativeTime(p.updatedAt)}</span>
                </button>
                <button type="button" className="button button--quiet" onClick={() => setConfirmDelete(p)} aria-label={`Remove ${p.name}`}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ConfirmModal
        open={confirmDelete !== null}
        title="Remove this organization?"
        description="Only the plan is forgotten. Your pictures, and any folders already copied, are not touched."
        confirmLabel="Remove plan"
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (confirmDelete) await window.noema.organizerDelete(confirmDelete.id)
          setConfirmDelete(null)
          await onChanged()
        }}
      />
    </div>
  )
}

// ---- one plan ---------------------------------------------------------------------------------------------------------

function PlanView({ plan, onChanged, onGone }: { plan: OrganizePlanInfo; onChanged: () => Promise<void>; onGone: () => void }): React.JSX.Element {
  const [live, setLive] = useState<OrganizeProgress | null>(plan.progress)
  const [overview, setOverview] = useState<OrganizeOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [rename, setRename] = useState<{ key: string; kind: OrganizeKind; name: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [viewer, setViewer] = useState<{ items: ImageItem[]; index: number } | null>(null)
  const [mergeTarget, setMergeTarget] = useState<{ kind: OrganizeKind; keys: string[] } | null>(null)
  const [dups, setDups] = useState<DuplicateGroupInfo[]>([])
  const [confirmCancel, setConfirmCancel] = useState(false)
  const lastLoad = useRef(0)

  const loadOverview = useCallback(async () => {
    try {
      const o = await window.noema.organizerOverview(plan.id)
      setOverview(o)
      setDups(o.duplicates.sample)
      setError(null)
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [plan.id])

  useEffect(() => {
    if (plan.status === 'ready' || plan.status === 'done' || plan.status === 'exporting' || plan.status === 'export-paused') void loadOverview()
  }, [plan.status, plan.updatedAt, loadOverview])

  useEffect(() => {
    return window.noema.onOrganizerProgress((p) => {
      if (p.planId !== plan.id) return
      setLive(p)
      const now = Date.now()
      if (now - lastLoad.current > 1500) {
        lastLoad.current = now
        void onChanged()
      }
    })
  }, [plan.id, onChanged])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await action()
      await onChanged()
    } catch (e) {
      setError(friendlyError(e))
    }
  }

  const refine = async (ops: unknown[]): Promise<void> => {
    try {
      const result = await window.noema.organizerRefine(plan.id, ops)
      setOverview(result.overview)
      setDups(result.overview.duplicates.sample)
      setNotes(result.messages)
      await onChanged()
    } catch (e) {
      setError(friendlyError(e))
    }
  }

  // What is checked decides what is copied or moved. Looking at pictures (the viewer) never changes it.
  // The boxes answer at once; the plan confirms a moment later (and corrects them if it disagrees).
  const [localSel, setLocalSel] = useState<string[] | null>(null)
  const picked = useMemo(() => new Set(localSel ?? overview?.selection.keys ?? []), [overview, localSel])
  const choose = (keys: string[]): void => {
    setLocalSel(keys)
    void refine([{ op: 'select', keys }]).finally(() => setLocalSel(null))
  }
  const toggleGroup = (kind: OrganizeKind, name: string, on: boolean): void => {
    const next = new Set(picked)
    const key = groupKey(kind, name)
    if (on) next.add(key)
    else next.delete(key)
    choose(Array.from(next))
  }
  const checkAll = (): void => choose((overview?.kinds ?? []).flatMap((k) => k.categories.map((c) => groupKey(k.kind, c.name))))
  const openGroup = async (kind: OrganizeKind, name: string, index: number): Promise<void> => {
    try {
      const items = await window.noema.organizerGroupImages(plan.id, kind, name)
      if (items.length) setViewer({ items, index: Math.min(index, items.length - 1) })
    } catch (e) {
      setError(friendlyError(e))
    }
  }
  const openSet = async (ids: string[], index: number): Promise<void> => {
    try {
      const items = await window.noema.organizerImages(ids)
      if (items.length) setViewer({ items, index: Math.min(index, items.length - 1) })
    } catch (e) {
      setError(friendlyError(e))
    }
  }

  const busy = plan.status === 'analyzing' || plan.status === 'draft'
  const progress = live ?? plan.progress

  return (
    <div className="org-plan-view">
      <div className="org-title-row">
        <h2>{plan.name}</h2>
        <span className="org-status" data-testid="org-status" data-status={plan.status}>{STATUS_WORDS[plan.status]}</span>
      </div>
      {error ? <p className="org-error">{error}</p> : null}

      {busy || plan.status === 'paused' ? (
        <section className="org-card">
          <h3>{progress ? PHASE_LABELS[progress.phase] : 'Starting'}</h3>
          <Bar done={progress?.done ?? 0} total={progress?.total ?? plan.total} />
          <p className="org-muted">{progress ? `${formatNumber(progress.done)} of ${formatNumber(progress.total)} · ${progress.message}` : ''}</p>
          <div className="org-actions">
            {busy ? (
              <button type="button" className="button button--ghost" onClick={() => void run(() => window.noema.organizerPause(plan.id))} data-testid="org-pause">Pause</button>
            ) : (
              <button type="button" className="button button--gold" onClick={() => void run(() => window.noema.organizerStart(plan.id))} data-testid="org-resume">Continue</button>
            )}
            <button type="button" className="button button--quiet" onClick={() => setConfirmCancel(true)}>Cancel</button>
          </div>
          <p className="org-muted">Pausing keeps everything read so far. If Atlas is closed, this continues from where it stopped.</p>
        </section>
      ) : null}

      {plan.status === 'failed' || plan.status === 'cancelled' ? (
        <section className="org-card">
          <p>{plan.status === 'failed' ? 'This analysis stopped because of an error.' : 'This analysis was cancelled.'} {progress?.message}</p>
          <div className="org-actions">
            <button type="button" className="button button--gold" onClick={() => void run(() => window.noema.organizerStart(plan.id))}>Try again</button>
            <button type="button" className="button button--quiet" onClick={() => void run(async () => { await window.noema.organizerDelete(plan.id); onGone() })}>Remove</button>
          </div>
        </section>
      ) : null}

      {overview && !busy && plan.status !== 'paused' ? (
        <>
          {overview.withoutModel > 0 ? (
            <p className="org-note">
              {formatNumber(overview.withoutModel)} pictures have not been read by the image model (it is off or not installed), so they are grouped from file facts only: type, size, date and name. Turn the image model on in AI settings for subject and style folders and for telling artwork from photographs.
            </p>
          ) : null}

          <section className="org-card" data-testid="org-settings">
            <h3>Layout</h3>
            <div className="org-row">
              <label className="org-field">
                <span>Folder layout</span>
                <select value={plan.settings.structure} onChange={(e) => void refine([{ op: 'structure', value: e.target.value }])} disabled={plan.status !== 'ready' && plan.status !== 'done'}>
                  {(Object.keys(STRUCTURE_LABELS) as StructurePreset[]).map((k) => (
                    <option key={k} value={k}>{STRUCTURE_LABELS[k].label}, e.g. {STRUCTURE_LABELS[k].example}</option>
                  ))}
                </select>
              </label>
              <label className="org-field">
                <span>Copies and versions</span>
                <select value={plan.settings.duplicates} onChange={(e) => void refine([{ op: 'duplicates', value: e.target.value }])} disabled={plan.status !== 'ready' && plan.status !== 'done'}>
                  {(Object.keys(DUPLICATE_LABELS) as DuplicatePolicy[]).map((k) => (
                    <option key={k} value={k}>{DUPLICATE_LABELS[k].label}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="org-muted">{DUPLICATE_LABELS[plan.settings.duplicates].note}</p>
            {notes.length ? <ul className="org-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
          </section>

          <section aria-labelledby="org-kinds">
            <h3 id="org-kinds">What Atlas found</h3>
            <div className="org-selection" data-testid="org-selection">
              <p>
                {overview.selection.groups === 0
                  ? <><strong>Nothing is selected.</strong> Check the folders you want to copy or move, or press Check all. Nothing is included until you do.</>
                  : <><strong>{formatNumber(overview.selection.groups)} folder{overview.selection.groups === 1 ? '' : 's'} checked</strong> · {formatNumber(overview.selection.pictures)} pictures · {formatBytes(overview.selection.bytes)}. Only these are included; unchecked folders never are.</>}
              </p>
              <div className="org-actions">
                <button type="button" className="button button--quiet" onClick={checkAll} disabled={plan.status !== 'ready' && plan.status !== 'done'} data-testid="org-check-all">Check all</button>
                <button type="button" className="button button--quiet" onClick={() => choose([])} disabled={picked.size === 0} data-testid="org-check-none">Check none</button>
              </div>
            </div>
            <div className="org-kinds">
              {overview.kinds.map((k) => (
                <div key={k.kind} className={`org-card org-kind${k.excluded ? ' is-excluded' : ''}`} data-testid={`org-kind-${k.kind}`}>
                  <div className="org-kind__head">
                    <div>
                      <h4>{k.label} <span className="org-count">{formatNumber(k.count)}</span></h4>
                      <p className="org-muted">{KIND_NOTES[k.kind]}</p>
                    </div>
                    <button type="button" className="button button--quiet" onClick={() => void refine([{ op: k.excluded ? 'include' : 'exclude', kind: k.kind }])} disabled={plan.status !== 'ready' && plan.status !== 'done'}>
                      {k.excluded ? 'Include again' : 'Leave out'}
                    </button>
                  </div>
                  {k.excluded ? <p className="org-muted">Not copied.</p> : null}
                  {k.kind === 'uncertain' && k.count > 0 && !k.excluded ? (
                    <div className="org-actions" data-testid="org-reclassify">
                      <button type="button" className="button button--ghost" onClick={() => void refine([{ op: 'reclassify', from: 'uncertain', to: 'artwork' }])}>Treat all as artwork</button>
                      <button type="button" className="button button--ghost" onClick={() => void refine([{ op: 'reclassify', from: 'uncertain', to: 'photograph' }])}>Treat all as photographs</button>
                    </div>
                  ) : null}
                  <ul className="org-cats">
                    {k.categories.map((c) => (
                      <li key={c.key} className="org-cat">
                        <label className="org-cat__pick" title="Check to include this folder when copying or moving">
                          <input type="checkbox" checked={picked.has(groupKey(k.kind, c.name))} onChange={(e) => toggleGroup(k.kind, c.name, e.target.checked)} aria-label={`Include ${c.name}`} data-testid="org-pick" />
                        </label>
                        <Thumbs ids={c.sampleIds} onOpen={(i) => void openGroup(k.kind, c.name, i)} label={`Look at the pictures of ${c.name}`} />
                        <div className="org-cat__copy">
                          <strong>{c.name}</strong>
                          <span>{formatNumber(c.count)} · {c.note}</span>
                        </div>
                        <button type="button" className="button button--quiet" onClick={() => setRename({ key: c.key, kind: k.kind, name: c.name })}>Rename</button>
                      </li>
                    ))}
                  </ul>
                  {k.categories.filter((c) => picked.has(groupKey(k.kind, c.name))).length >= 2 ? (
                    <button type="button" className="button button--ghost" data-testid="org-merge" onClick={() => setMergeTarget({ kind: k.kind, keys: k.categories.filter((c) => picked.has(groupKey(k.kind, c.name))).map((c) => c.key) })}>
                      Merge the {k.categories.filter((c) => picked.has(groupKey(k.kind, c.name))).length} checked folders
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="org-actions">
              <button type="button" className="button button--ghost" onClick={() => setAdding(true)} disabled={plan.status !== 'ready' && plan.status !== 'done'}>Add my own category</button>
              <button type="button" className="button button--ghost" onClick={() => window.dispatchEvent(new Event(OPEN_COMPANION_EVENT))} data-testid="org-ask">Change it by talking to Atlas</button>
            </div>
          </section>

          <section aria-labelledby="org-dups">
            <h3 id="org-dups">Copies and versions</h3>
            {overview.duplicates.groups === 0 ? (
              <p className="org-muted">No copies or versions were found.</p>
            ) : (
              <>
                <p className="org-muted">
                  {formatNumber(overview.duplicates.groups)} groups · {formatNumber(overview.duplicates.extras)} extra files ({overview.duplicates.exact} identical, {overview.duplicates.near} near-identical, {overview.duplicates.versions} versions). The one marked best is suggested.
                </p>
                <ul className="org-dups">
                  {dups.slice(0, 12).map((g) => (
                    <li key={g.id} className="org-dup">
                      <span className="org-dup__type">{g.type === 'exact' ? 'Identical' : g.type === 'near' ? 'Near-identical' : 'Versions'}</span>
                      <span className="org-thumbs">
                        {g.memberIds.slice(0, 6).map((id, i) => (
                          <button key={id} type="button" className="org-thumb-button" onClick={() => void openSet(g.memberIds, i)} title={id === g.bestId ? 'Suggested best: open to compare' : 'Open to compare'} aria-label="Open these copies to compare" data-testid="org-dup-thumb">
                            <img src={thumb(id)} width={52} height={52} alt="" loading="lazy" className={id === g.bestId ? 'is-best' : ''} />
                          </button>
                        ))}
                      </span>
                      <span className="org-muted">{g.why}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section aria-labelledby="org-tree">
            <h3 id="org-tree">Folders that would be made</h3>
            <ul className="org-tree">
              {overview.tree.slice(0, 60).map((t) => (
                <li key={t.path}><span>{t.path}</span><span className="org-muted">{formatNumber(t.count)}</span></li>
              ))}
            </ul>
          </section>

          <ExportSection plan={plan} onChanged={onChanged} />
        </>
      ) : null}

      {!overview && !busy && plan.status !== 'paused' && plan.status !== 'failed' && plan.status !== 'cancelled' ? <Spinner label="Loading the plan" /> : null}

      <PromptModal
        open={rename !== null}
        title="Rename this folder"
        description="The folder gets this name in the copy. Nothing on disk changes until you copy."
        initialValue={rename?.name ?? ''}
        confirmLabel="Rename"
        onClose={() => setRename(null)}
        onConfirm={async (value) => {
          if (rename && value.trim()) await refine([{ op: 'rename', from: rename.key, to: value.trim(), kind: rename.kind }])
          setRename(null)
        }}
      />
      <PromptModal
        open={mergeTarget !== null}
        title="Merge into one folder"
        description="What should the merged folder be called?"
        initialValue=""
        confirmLabel="Merge"
        onClose={() => setMergeTarget(null)}
        onConfirm={async (value) => {
          if (mergeTarget && value.trim()) {
            await refine([{ op: 'merge', from: mergeTarget.keys, into: value.trim(), kind: mergeTarget.kind }])
          }
          setMergeTarget(null)
        }}
      />
      {viewer ? <Lightbox items={viewer.items} initialIndex={viewer.index} onClose={() => setViewer(null)} onUpdate={() => undefined} /> : null}
      <CustomDialog open={adding} onClose={() => setAdding(false)} onSave={async (n, d) => { await refine([{ op: 'custom', name: n, description: d }]); setAdding(false) }} />
      <ConfirmModal
        open={confirmCancel}
        title="Cancel this analysis?"
        description="What has been read is kept, but the analysis stops. You can start it again later."
        confirmLabel="Cancel analysis"
        onClose={() => setConfirmCancel(false)}
        onConfirm={async () => {
          await window.noema.organizerCancel(plan.id)
          setConfirmCancel(false)
          await onChanged()
        }}
      />
    </div>
  )
}

function CustomDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (name: string, description: string) => Promise<void> }): React.JSX.Element | null {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal org-modal" role="dialog" aria-modal="true" aria-label="Add a category" onClick={(e) => e.stopPropagation()}>
        <h3>Add your own category</h3>
        <label className="org-field">
          <span>Folder name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Cats" />
        </label>
        <label className="org-field">
          <span>What belongs in it</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="cats and kittens" />
        </label>
        <p className="org-muted">Pictures that look most like this description are placed in it. You can check the result and move single pictures by asking Atlas.</p>
        <div className="org-actions">
          <button type="button" className="button button--quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="button button--gold" disabled={!name.trim() || !description.trim()} onClick={() => { void onSave(name.trim(), description.trim()); setName(''); setDescription('') }}>Add</button>
        </div>
      </div>
    </div>
  )
}

// ---- export -----------------------------------------------------------------------------------------------------------

function ExportSection({ plan, onChanged }: { plan: OrganizePlanInfo; onChanged: () => Promise<void> }): React.JSX.Element {
  const [destination, setDestination] = useState<string | null>(plan.destination)
  const [preview, setPreview] = useState<OrganizePreview | null>(null)
  const [report, setReport] = useState<ExportReport | null>(null)
  const [verify, setVerify] = useState<'size' | 'hash'>('size')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [page, setPage] = useState(0)
  const [confirm, setConfirm] = useState(false)
  const [mode, setMode] = useState<'copy' | 'move'>('copy')
  const exporting = plan.status === 'exporting' || plan.status === 'export-paused'

  const loadPreview = useCallback(
    async (dest: string, offset: number) => {
      setBusy(true)
      setError(null)
      try {
        setPreview(await window.noema.organizerPreview(plan.id, dest, offset, mode))
      } catch (e) {
        setPreview(null)
        setError(friendlyError(e))
      } finally {
        setBusy(false)
      }
    },
    [plan.id, mode]
  )

  useEffect(() => {
    if (destination && !exporting && plan.status !== 'done') void loadPreview(destination, page * 200)
  }, [destination, page, plan.updatedAt, exporting, plan.status, loadPreview])

  useEffect(() => {
    if (exporting || plan.status === 'done') void window.noema.organizerReport(plan.id).then(setReport).catch(() => undefined)
  }, [plan.id, plan.status, plan.updatedAt, exporting])

  useEffect(() => {
    if (!exporting) return
    const timer = window.setInterval(() => void window.noema.organizerReport(plan.id).then(setReport).catch(() => undefined), 1000)
    return () => window.clearInterval(timer)
  }, [exporting, plan.id])

  const choose = async (): Promise<void> => {
    const picked = await window.noema.organizerChooseDestination()
    if (picked) {
      setDestination(picked)
      setPage(0)
    }
  }

  const start = async (): Promise<void> => {
    if (!destination) return
    setBusy(true)
    setError(null)
    try {
      await window.noema.organizerExport(plan.id, destination, verify, mode)
      await onChanged()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <section className="org-card org-export" aria-labelledby="org-export" data-testid="org-export">
      <h3 id="org-export">Copy or move to a folder</h3>
      {!exporting && plan.status !== 'done' ? (
        <>
          <div className="org-modes" role="radiogroup" aria-label="Copy or move">
            <label className={mode === 'copy' ? 'is-on' : ''}><input type="radio" name="org-mode" checked={mode === 'copy'} onChange={() => { setMode('copy'); setPage(0) }} data-testid="org-mode-copy" /> <strong>Copy</strong> <span className="org-muted">the originals stay where they are</span></label>
            <label className={mode === 'move' ? 'is-on' : ''}><input type="radio" name="org-mode" checked={mode === 'move'} onChange={() => { setMode('move'); setPage(0) }} data-testid="org-mode-move" /> <strong>Move</strong> <span className="org-muted">relocate them; Atlas keeps their favorites, moodboards and versions</span></label>
          </div>
          <p className="org-muted">{mode === 'copy' ? 'Pictures are copied, never moved or deleted. ' : 'Moved pictures are checked before the old file is removed; nothing is ever overwritten. '}Choose where the new folders go; you see every file and the space needed before anything happens.</p>
          <div className="org-actions">
            <button type="button" className="button button--ghost" onClick={() => void choose()} data-testid="org-choose">
              {destination ? 'Choose another folder' : 'Choose destination folder'}
            </button>
            {destination ? <code className="org-path">{destination}</code> : null}
          </div>
          {error ? <p className="org-error">{error}</p> : null}
          {busy && !preview ? <Spinner label="Checking the plan" /> : null}
          {preview ? (
            <div data-testid="org-preview">
              <ul className="org-facts">
                <li data-testid="org-preview-scope">{preview.selectedGroups === 0 ? <><strong>Nothing is selected</strong>, so nothing would be {mode === 'move' ? 'moved' : 'copied'}. Check the folders above first.</> : <><strong>{formatNumber(preview.selectedGroups)} checked folder{preview.selectedGroups === 1 ? '' : 's'}</strong> · {formatNumber(preview.selectedPictures)} pictures. Unchecked folders are not included.</>}</li>
                <li><strong>{formatNumber(preview.copy)}</strong> files to {preview.mode === 'move' ? 'move' : 'copy'} ({formatBytes(preview.copyBytes)}{preview.mode === 'move' ? ' that must be copied across drives' : ''})</li>
                <li>
                  Free space: {preview.freeBytes === null ? 'could not be read' : formatBytes(preview.freeBytes)}{' '}
                  <span className={preview.enoughSpace ? 'org-ok' : 'org-bad'}>{preview.enoughSpace ? 'enough' : 'not enough'}</span>
                </li>
                {preview.skipped.excluded ? <li>{formatNumber(preview.skipped.excluded)} left out by your choice</li> : null}
                {preview.skipped.duplicates ? <li>{formatNumber(preview.skipped.duplicates)} copies not copied (policy)</li> : null}
                {preview.skipped.same ? <li>{formatNumber(preview.skipped.same)} already there, identical; skipped</li> : null}
                <li>{preview.conflicts.length ? `${formatNumber(preview.conflicts.length)} name conflicts: each gets a new name, nothing is overwritten` : 'No name conflicts'}</li>
              </ul>
              {preview.warnings.map((w) => <p key={w} className="org-note">{w}</p>)}
              {preview.conflicts.length ? (
                <details>
                  <summary>Show conflicts</summary>
                  <ul className="org-ops">
                    {preview.conflicts.slice(0, 50).map((c) => (
                      <li key={c.to}><span>{c.to}</span><span className="org-muted">→ {c.renamedTo} · {c.reason}</span></li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <details>
                <summary>Show every operation ({formatNumber(preview.total)})</summary>
                <ul className="org-ops">
                  {preview.sample.map((o) => (
                    <li key={o.imageId + o.to}>
                      <span title={o.from}>{o.from}</span>
                      <span className="org-muted">→ {o.action === 'copy' ? o.to : `${o.action.replace('skip-', 'skipped: ')} (${o.to})`}{o.note ? ` · ${o.note}` : ''}</span>
                    </li>
                  ))}
                </ul>
                <div className="org-actions">
                  <button type="button" className="button button--quiet" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>Earlier</button>
                  <span className="org-muted">{formatNumber(page * 200 + 1)}–{formatNumber(Math.min(preview.total, page * 200 + 200))}</span>
                  <button type="button" className="button button--quiet" disabled={(page + 1) * 200 >= preview.total} onClick={() => setPage((p) => p + 1)}>Later</button>
                </div>
              </details>
              <label className="org-field org-field--inline">
                <span>Check each copy by</span>
                <select value={verify} onChange={(e) => setVerify(e.target.value as 'size' | 'hash')}>
                  <option value="size">File size (fast)</option>
                  <option value="hash">Full content check (slower, certain)</option>
                </select>
              </label>
              <button type="button" className="button button--gold" disabled={busy || !preview.enoughSpace || preview.copy === 0 || preview.selectedGroups === 0} onClick={() => setConfirm(true)} data-testid={mode === 'move' ? 'org-move' : 'org-copy'}>
                {mode === 'move' ? 'Move' : 'Copy'} {formatNumber(preview.copy)} files
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {exporting && report ? (
        <div data-testid="org-exporting">
          <Bar done={report.verified + report.skipped + report.failed} total={report.total} />
          <p className="org-muted">{formatNumber(report.verified)} of {formatNumber(report.total)} {report.mode === 'move' ? 'moved and checked' : 'copied and checked'}{report.failed ? ` · ${report.failed} failed` : ''} · {formatBytes(report.bytes)}</p>
          <div className="org-actions">
            {plan.status === 'exporting' ? (
              <button type="button" className="button button--ghost" onClick={() => void window.noema.organizerPauseExport(plan.id).then(onChanged)} data-testid="org-pause-export">Pause</button>
            ) : (
              <button type="button" className="button button--gold" onClick={() => void window.noema.organizerResumeExport(plan.id).then(onChanged)} data-testid="org-resume-export">Continue copying</button>
            )}
            <button type="button" className="button button--quiet" onClick={() => void window.noema.organizerCancelExport(plan.id).then(onChanged)}>Stop</button>
          </div>
          <p className="org-muted">Stopping keeps what is already copied. Nothing already there is overwritten when you continue.</p>
        </div>
      ) : null}

      {plan.status === 'done' && report ? (
        <div data-testid="org-report">
          <p><strong>{formatNumber(report.verified)}</strong> files {report.mode === 'move' ? 'moved and checked' : 'copied and checked'} ({formatBytes(report.bytes)}){report.renamed ? `, ${report.renamed} renamed to avoid conflicts` : ''}{report.skipped ? `, ${report.skipped} skipped` : ''}{report.failed ? `, ${report.failed} failed` : ''}.</p>
          <p className="org-muted">Destination: <code>{report.destination}</code>. {report.mode === 'move' ? 'The moved pictures keep their place in the Atlas library.' : 'The originals were not changed.'}</p>
          {report.failures.slice(0, 10).map((f) => <p key={f.to} className="org-error">{f.from}: {f.error}</p>)}
          <button type="button" className="button button--ghost" onClick={() => void window.noema.organizerOpenDestination(plan.id)}>Open the folder</button>
        </div>
      ) : null}

      <ConfirmModal
        open={confirm}
        title={mode === 'move' ? 'Move the files?' : 'Copy the files?'}
        description={preview ? (mode === 'move' ? `${formatNumber(preview.copy)} files will be moved to ${destination}. Each is checked before its old file is removed, and nothing is overwritten. Atlas keeps their favorites, moodboards and versions.` : `${formatNumber(preview.copy)} files (${formatBytes(preview.copyBytes)}) will be copied to ${destination}. Originals stay where they are.`) : ''}
        confirmLabel={mode === 'move' ? 'Move' : 'Copy'}
        onClose={() => setConfirm(false)}
        onConfirm={start}
      />
    </section>
  )
}
