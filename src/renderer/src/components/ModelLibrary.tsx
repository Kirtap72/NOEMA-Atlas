import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AiJob } from '@shared/ai'
import { CATEGORIES, FIT_LABEL, TIER_LABEL, type CategoryId, type EntryView, type InstallPlan, type LibraryOverview } from '@shared/modelLibrary'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'

export const OPEN_MODEL_LIBRARY_EVENT = 'atlas:open-model-library'
export function openModelLibrary(detail: { search?: string; category?: CategoryId; entry?: string } = {}): void {
  window.dispatchEvent(new CustomEvent(OPEN_MODEL_LIBRARY_EVENT, { detail }))
}

const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB` : bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : '—')
const VERIFY_LABEL = { verified: 'Tested and verified', documented: 'Documented, not tested', experimental: 'Experimental' } as const
const WAY_LABEL: Record<EntryView['way'], string> = { atlas: 'Atlas installs it', ollama: 'Through your Ollama', manual: 'Official steps', 'atlas-model': 'Part of Atlas', unavailable: 'Not available yet' }

/** Lives in the app shell and opens the AI Model Library whenever something asks for it. */
export function ModelLibraryHost(): React.JSX.Element | null {
  const [open, setOpen] = useState<{ search?: string; category?: CategoryId; entry?: string; nonce: number } | null>(null)
  useEffect(() => {
    const show = (event: Event): void => setOpen((cur) => ({ ...((event as CustomEvent).detail ?? {}), nonce: (cur?.nonce ?? 0) + 1 }))
    window.addEventListener(OPEN_MODEL_LIBRARY_EVENT, show)
    // The Companion (in the main process) can open the real library too, instead of describing it in text.
    const offMain = window.noema.onOpenModelLibrary((request) => openModelLibrary({ entry: request.entry, search: request.search, category: request.category as CategoryId | undefined }))
    return () => {
      window.removeEventListener(OPEN_MODEL_LIBRARY_EVENT, show)
      offMain()
    }
  }, [])
  return open ? <ModelLibraryDialog key={open.nonce} initial={open} onClose={() => setOpen(null)} /> : null
}

function ModelLibraryDialog({ initial, onClose }: { initial: { search?: string; category?: CategoryId; entry?: string }; onClose: () => void }): React.JSX.Element {
  const { toast } = useAtlas()
  const [overview, setOverview] = useState<LibraryOverview | null>(null)
  const [simulate, setSimulate] = useState<string | null>(null)
  const [search, setSearch] = useState(initial.search ?? '')
  const [category, setCategory] = useState<CategoryId | 'all'>(initial.category ?? 'all')
  const [onlyFit, setOnlyFit] = useState(false)
  const [selected, setSelected] = useState<string | null>(initial.entry ?? null)
  const [job, setJob] = useState<AiJob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (sim: string | null): Promise<void> => {
      try {
        setOverview(await window.noema.modelsOverview(sim))
      } catch (e) {
        setError(friendlyError(e))
      }
    },
    []
  )
  useEffect(() => void load(simulate), [load, simulate])
  useEffect(() => window.noema.onAiProgress((j) => setJob(j)), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const entries = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (overview?.entries ?? []).filter((v) => {
      if (category !== 'all' && !v.entry.categories.includes(category)) return false
      if (onlyFit && (v.fit.level === 'too-big' || v.fit.level === 'incompatible')) return false
      if (!q) return true
      const e = v.entry
      return [e.name, e.summary, e.version, e.source.name, ...e.capabilities.map((c) => c.label), ...e.categories.map((c) => CATEGORIES[c].label)].join(' ').toLowerCase().includes(q)
    })
  }, [overview, search, category, onlyFit])
  const chosen = overview?.entries.find((v) => v.entry.id === selected) ?? null

  const act = async (work: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      toast(done)
      await load(simulate)
    } catch (e) {
      setError(friendlyError(e))
      await load(simulate)
    } finally {
      setBusy(false)
      setJob(null)
    }
  }

  const hw = overview?.hardware
  return createPortal(
    <div className="studio-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="studio modelib" role="dialog" aria-modal="true" aria-label="AI Model Library" data-testid="model-library">
        <header className="studio__head">
          <div>
            <div className="eyebrow">AI MODEL LIBRARY</div>
            <h2>Models for this computer</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close the library">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="modelib__body">
          {!overview ? (
            <Spinner label="Reading this computer" />
          ) : (
            <>
              <section className="modelib__hw" data-testid="model-hardware">
                <div>
                  <strong>{hw!.primary ? hw!.primary.name : 'No graphics card found'}</strong>
                  <span className="modelib__muted">
                    {' '}
                    · {TIER_LABEL[hw!.tier]} · {hw!.modelMemoryGB ? `${hw!.modelMemoryGB.toFixed(0)} GB for models` : 'no model memory'} · {hw!.arch}
                    {hw!.emulated ? ' (Atlas runs emulated)' : ''} · {hw!.ramGB.toFixed(0)} GB memory
                  </span>
                  {hw!.simulated ? <span className="modelib__badge modelib__badge--sim">Preview of another computer</span> : null}
                </div>
                <div className="modelib__muted">{hw!.memoryNote}</div>
                {hw!.runtime.notes.map((n) => (
                  <div key={n} className="modelib__note">{n}</div>
                ))}
                <label className="modelib__sim">
                  Preview recommendations for
                  <select value={simulate ?? ''} onChange={(e) => setSimulate(e.target.value || null)} data-testid="model-simulate">
                    <option value="">This computer</option>
                    {overview.simulations.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                </label>
                {hw!.simulated ? <div className="modelib__muted">This is only a preview. Nothing below has been tested on that computer, and installs still act on this one.</div> : null}
              </section>

              <section className="modelib__conn" data-testid="model-connection" aria-label="Which ComfyUI is connected">
                <strong>ComfyUI:</strong>{' '}
                {overview.comfy.kind === 'managed' ? <span>Atlas’s own ComfyUI{overview.comfy.connected ? ' · connected, models below marked “Ready to use” can be used now' : ' · set up but not running'}. Atlas installs and removes models in it only after you agree.</span>
                  : overview.comfy.kind === 'local' ? <span>Your own ComfyUI{overview.comfy.folder ? ` (${overview.comfy.folder})` : ''} · connected for reading only. Atlas never writes into it.</span>
                  : overview.comfy.kind === 'remote' ? <span>A ComfyUI on your network · connected for reading only.</span>
                  : <span>none connected. Set one up in the Studio settings, or connect your own, to use the models below.</span>}
                {overview.comfy.note ? <span className="modelib__muted"> {overview.comfy.note}</span> : null}
              </section>

              <div className="modelib__bar">
                <input type="search" placeholder="Search models, abilities, licences…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search the library" data-testid="model-search" />
                <label className="modelib__check"><input type="checkbox" checked={onlyFit} onChange={(e) => setOnlyFit(e.target.checked)} /> Only what fits</label>
                <button type="button" className="button button--ghost" disabled={busy} onClick={() => void act(async () => setOverview(await window.noema.modelsRescan(simulate)), 'Checked again.')}>Check my ComfyUI</button>
              </div>
              <div className="chip-row" role="tablist">
                <button type="button" className={`chip${category === 'all' ? ' is-active' : ''}`} onClick={() => setCategory('all')}>All</button>
                {(Object.keys(CATEGORIES) as CategoryId[]).map((c) => (
                  <button key={c} type="button" className={`chip${category === c ? ' is-active' : ''}`} onClick={() => setCategory(c)} title={CATEGORIES[c].blurb}>{CATEGORIES[c].label}</button>
                ))}
              </div>
              {overview.problems.length > 0 ? <div className="modelib__note">Some of your own definitions were not used: {overview.problems.join(' ')}</div> : null}
              {error ? <div className="modelib__error" role="alert">{error}</div> : null}

              <div className="modelib__cols">
                <ul className="modelib__list" data-testid="model-list">
                  {entries.length === 0 ? <li className="modelib__muted">Nothing matches. Try another word or category.</li> : null}
                  {entries.map((v) => (
                    <li key={v.entry.id}>
                      <button type="button" className={`modelib__card${selected === v.entry.id ? ' is-on' : ''}`} onClick={() => setSelected(v.entry.id)} data-testid={`model-${v.entry.id}`}>
                        <span className="modelib__title">{v.entry.name}</span>
                        <span className="modelib__muted">{v.entry.summary}</span>
                        <span className="modelib__badges">
                          <span className={`modelib__badge modelib__badge--${v.fit.level}`}>{FIT_LABEL[v.fit.level]}</span>
                          <span className={`modelib__badge modelib__badge--${v.entry.verification.status}`}>{VERIFY_LABEL[v.entry.verification.status]}</span>
                          <span className={`modelib__badge${v.state.kind === 'installed' || v.state.kind === 'found-in-comfyui' ? ' modelib__badge--have' : ''}`} data-testid={`model-state-${v.entry.id}`}>{v.state.kind === 'installed' ? 'Installed by Atlas' : v.state.kind === 'found-in-comfyui' ? 'In your ComfyUI · read-only' : v.state.kind === 'partial' ? 'Partly downloaded' : size(v.plan?.downloadBytes || v.entry.files.reduce((n, f) => n + f.bytes, 0) || v.entry.install.approxBytes || 0)}</span>
                          {(v.state.kind === 'installed' || v.state.kind === 'found-in-comfyui') && v.entry.runtime === 'comfyui' ? <span className={`modelib__badge ${overview.comfy.connected ? 'modelib__badge--ready' : 'modelib__badge--idle'}`}>{overview.comfy.connected ? 'Ready to use' : 'Installed · not connected'}</span> : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="modelib__detail">
                  {chosen ? (
                    <Detail view={chosen} simulate={simulate} busy={busy} job={job} onAct={act} onClearSelection={() => setSelected(null)} />
                  ) : (
                    <p className="modelib__muted">Choose a model to see what it does, where it comes from, its licence, what it needs, and how it is installed. Nothing is downloaded until you ask.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body
  )
}

function Detail({ view, simulate, busy, job, onAct, onClearSelection }: { view: EntryView; simulate: string | null; busy: boolean; job: AiJob | null; onAct: (work: () => Promise<unknown>, done: string) => Promise<void>; onClearSelection: () => void }): React.JSX.Element {
  const e = view.entry
  const [consent, setConsent] = useState(false)
  const [plan, setPlan] = useState<InstallPlan | null>(view.plan)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [report, setReport] = useState<string[] | null>(null)
  useEffect(() => {
    setConsent(false)
    setConfirmRemove(false)
    setReport(null)
    setPlan(view.plan)
  }, [e.id, view.plan])
  void onClearSelection
  const installed = view.state.kind === 'installed'
  const canInstall = (view.way === 'atlas' || view.way === 'ollama') && !installed
  const fit = view.fit
  const reqs = e.requirements
  return (
    <article data-testid="model-detail">
      <h3>{e.name} <span className="modelib__muted">v{e.version}</span></h3>
      <p>{e.details}</p>
      <div className="modelib__badges">
        <span className={`modelib__badge modelib__badge--${fit.level}`}>{FIT_LABEL[fit.level]}</span>
        <span className={`modelib__badge modelib__badge--${e.verification.status}`}>{VERIFY_LABEL[e.verification.status]}</span>
        <span className="modelib__badge">{installed || view.state.kind === 'found-in-comfyui' ? 'Already there' : WAY_LABEL[view.way]}</span>
      </div>
      {fit.reasons.length ? <ul className="modelib__reasons">{fit.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
      {fit.variantLabel ? <p className="modelib__muted">Build chosen for this computer: {fit.variantLabel}</p> : null}
      {fit.testedNote ? <p className="modelib__muted">Tested on this kind of card: {fit.testedNote}</p> : null}

      {e.capabilities.length ? (
        <>
          <h4>What it does</h4>
          <ul className="modelib__caps">{e.capabilities.map((c) => <li key={c.id}><span className={`modelib__dot modelib__dot--${c.level}`} />{c.label} <span className="modelib__muted">({c.level === 'good' ? 'works well' : c.level === 'partial' ? 'partly' : 'weak'})</span></li>)}</ul>
        </>
      ) : null}

      <h4>Verification</h4>
      {e.verification.checks.length ? <ul>{e.verification.checks.map((c, i) => <li key={i}><strong>{c.hardware}</strong> · {c.date} · {c.result} <span className="modelib__muted">({c.how})</span></li>)}</ul> : <p className="modelib__muted">No test results are recorded for this model.</p>}
      {e.verification.note ? <p className="modelib__muted">{e.verification.note}</p> : null}

      <h4>Needs</h4>
      <p className="modelib__muted">
        Memory: at least {reqs.minMemoryGB} GB{reqs.recommendedMemoryGB ? `, ${reqs.recommendedMemoryGB} GB recommended` : ''}
        {reqs.archs ? ` · ${reqs.archs.join(', ')}` : ''}
        {reqs.os ? ` · ${reqs.os.join(', ')}` : ''}
        {reqs.gpuFamilies ? ` · ${reqs.gpuFamilies.join(', ')} graphics` : ''}
        {e.dependsOn.length ? ` · also installs: ${e.dependsOn.join(', ')}` : ''}
      </p>

      <h4>Source and licence</h4>
      <p>
        <a href={e.source.url} target="_blank" rel="noreferrer">{e.source.name}</a> · <a href={e.licence.url} target="_blank" rel="noreferrer">{e.licence.name}</a>
        <br />
        <span className="modelib__muted">{e.licence.summary} {e.licence.commercialUse === 'no' ? 'Commercial use is not allowed.' : e.licence.commercialUse === 'conditions' ? 'Commercial use has conditions.' : 'Commercial use is allowed.'}</span>
      </p>

      {e.workflows.length ? (
        <>
          <h4>Workflows it works with</h4>
          <ul>{e.workflows.map((w) => <li key={w.id}>{w.name} <span className="modelib__muted">— {w.task}</span></li>)}</ul>
        </>
      ) : null}

      <h4>State</h4>
      <p>
        {installed ? `Installed by Atlas${view.state.where ? ` — ${view.state.where}` : ''}.` : view.state.kind === 'found-in-comfyui' ? `Found in your ComfyUI${view.state.where ? ` — ${view.state.where}` : ''}. Atlas did not install it and will not remove it.` : view.state.kind === 'partial' ? 'Partly downloaded; installing again continues where it stopped.' : view.state.kind === 'unknown' ? 'Atlas cannot tell yet.' : 'Not installed.'}
        {view.state.note ? ` ${view.state.note}` : ''}
      </p>
      {view.wayNote && !installed && view.state.kind !== 'found-in-comfyui' ? <p className="modelib__note">{view.wayNote}</p> : null}
      {installed || view.state.kind === 'found-in-comfyui' ? <p className="modelib__ok" data-testid="model-ready-note">Nothing to install: this model is already there and ready to use.</p> : null}
      {view.missingDependencies.length ? <p className="modelib__muted">Also needed: {view.missingDependencies.join(', ')}.</p> : null}

      {view.way === 'manual' && view.instructions.length && !installed && view.state.kind !== 'found-in-comfyui' ? (
        <>
          <h4>Official steps</h4>
          <ol className="modelib__steps">{view.instructions.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <p className="modelib__muted">Atlas runs none of this for you. When you are done, press “Check my ComfyUI”.</p>
        </>
      ) : null}

      {canInstall && plan ? (
        <section className="modelib__plan" data-testid="model-plan">
          <h4>What installing does</h4>
          <ul>
            {plan.files.map((f) => <li key={`${f.entryId}-${f.key}`}>{f.name} <span className="modelib__muted">· {size(f.bytes)} · {f.needed ? `into ${f.folder}` : 'already there'}</span></li>)}
          </ul>
          {e.runtime === 'ollama' ? <p>Your own Ollama downloads it (about {size(e.install.approxBytes ?? 0)}).</p> : <p>Download {size(plan.downloadBytes)}{plan.freeBytes !== null ? ` · ${size(plan.freeBytes)} free` : ''}{plan.destination ? ` · to ${plan.destination}` : ''}. Every file is checked against its checksum.</p>}
          {plan.licences.map((l) => <p key={l.entryId} className="modelib__muted">Licence: <a href={l.url} target="_blank" rel="noreferrer">{l.name}</a>{l.acceptance ? ` — ${l.acceptance}` : ''}</p>)}
          {plan.warnings.map((w) => <p key={w} className="modelib__note">{w}</p>)}
          <label className="modelib__check"><input type="checkbox" checked={consent} onChange={(ev) => setConsent(ev.target.checked)} data-testid="model-consent" /> I agree to download this and accept its licence.</label>
          <div className="modelib__actions">
            <button type="button" className="button button--gold" disabled={!consent || busy} onClick={() => void onAct(() => window.noema.modelsInstall(e.id, { variant: fit.variant, consent }), `${e.name} is installed.`)} data-testid="model-install">Install</button>
            {busy ? <button type="button" className="button button--ghost" onClick={() => void window.noema.modelsStop()}>Stop</button> : null}
          </div>
          {job && busy ? <progress value={job.fraction ?? undefined} max={1} aria-label="Download progress" /> : null}
          {job && busy ? <p className="modelib__muted">{job.message}{job.speed ? ` · ${(job.speed / 1e6).toFixed(1)} MB/s` : ''}</p> : null}
        </section>
      ) : null}

      {canInstall && !plan ? (
        <button type="button" className="button button--ghost" onClick={() => void window.noema.modelsPlan(e.id, fit.variant, simulate).then(setPlan)}>Show what installing does</button>
      ) : null}

      {installed && e.runtime === 'comfyui' ? (
        <div className="modelib__actions">
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => void window.noema.modelsVerify(e.id, true).then((r) => setReport(r.length ? r : ['Every file is present and matches its checksum.']))}>Check files</button>
          {confirmRemove ? (
            <>
              <button type="button" className="button button--danger" disabled={busy} onClick={() => void onAct(() => window.noema.modelsRemove(e.id), `${e.name} is removed.`)}>Remove the files Atlas installed</button>
              <button type="button" className="button button--quiet" onClick={() => setConfirmRemove(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove…</button>
          )}
        </div>
      ) : null}
      {report ? <ul className="modelib__reasons">{report.map((r) => <li key={r}>{r}</li>)}</ul> : null}
    </article>
  )
}
