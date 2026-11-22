import { useCallback, useEffect, useState } from 'react'
import type { AiJob, AiMode, AiPackageInfo, AiStatus, CapabilityId } from '@shared/ai'
import type { StudioSettings } from '@shared/studio'
import { Icon } from './Icon'
import { openModelLibrary } from './ModelLibrary'
import { Spinner } from './ui'
import { ComfySetup } from './ComfySetup'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'

const gb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`)
const speed = (bps: number | null): string => (bps ? `${(bps / 1e6).toFixed(1)} MB/s` : '')

/** The three ways to provide AI, in plain words, and the optional packages Atlas can install for itself. */
export function StudioAiSetup({ settings, onChange }: { settings: StudioSettings; onChange: (s: StudioSettings) => void }): React.JSX.Element {
  const { toast } = useAtlas()
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [job, setJob] = useState<AiJob | null>(null)
  const [choice, setChoice] = useState<AiMode | null>(null)
  const [root, setRoot] = useState('')
  const [consent, setConsent] = useState(false)
  const [picked, setPicked] = useState<Set<CapabilityId>>(new Set())
  const [packConsent, setPackConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const refresh = useCallback(async (): Promise<AiStatus | null> => {
    try {
      const next = await window.noema.aiStatus()
      setStatus(next)
      setJob(next.job)
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void refresh().then((s) => {
      if (!s) return
      setChoice((current) => current ?? (s.mode !== 'none' ? s.mode : settings.comfy.install ? 'connect' : null))
      setRoot((r) => r || s.root || s.suggestedRoot || '')
    })
  }, [refresh, settings.comfy.install])
  useEffect(() => window.noema.onAiProgress((j) => setJob(j)), [])

  const reloadSettings = async (): Promise<void> => {
    onChange(await window.noema.studioSettings())
    await refresh()
  }

  const choose = async (mode: AiMode): Promise<void> => {
    setChoice(mode)
    if (mode === 'none' || mode === 'connect') {
      // "Without ComfyUI" is a real choice, remembered, so Atlas stops offering setup everywhere.
      setStatus(await window.noema.aiSetMode('none'))
    }
  }

  const pickRoot = async (): Promise<void> => {
    const folder = await window.noema.aiChooseRoot()
    if (folder) setRoot(folder)
  }

  const run = async (work: () => Promise<AiStatus>, done: string): Promise<void> => {
    setBusy(true)
    try {
      const next = await work()
      setStatus(next)
      setJob(next.job)
      toast(done, 'success')
      await reloadSettings()
    } catch (error) {
      toast(friendlyError(error), 'error')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const working = busy || Boolean(job && !['done', 'failed', 'stopped'].includes(job.stage))
  const hw = status?.hardware
  const runtimeReady = status?.runtime.state === 'ready'

  const togglePack = (id: CapabilityId): void =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const packs = status?.packages ?? []
  // What would really be downloaded: the chosen packages plus what they need.
  const expanded = new Set<CapabilityId>()
  const add = (id: CapabilityId): void => {
    for (const n of packs.find((p) => p.id === id)?.needs ?? []) add(n)
    expanded.add(id)
  }
  picked.forEach(add)
  const wanted = packs.filter((p) => expanded.has(p.id) && p.state !== 'installed')
  const wantedBytes = wanted.reduce((s, p) => s + p.downloadBytes, 0)
  const licenses = Array.from(new Map(wanted.flatMap((p) => p.licenses).map((l) => [l.name, l])).values())

  return (
    <section className="ai-setup" data-testid="ai-setup" aria-label="Set up AI for the Studio">
      <header>
        <div className="eyebrow">OPTIONAL AI</div>
        <h3>How should Atlas make pictures?</h3>
        <p>Atlas always works without any of this: it can search, organise, compare and grade your pictures. AI adds creating, editing and creative upscaling. Pick whichever suits you; you can change your mind.</p>
        <button type="button" className="button button--ghost" onClick={() => openModelLibrary()} data-testid="open-model-library">Browse the AI Model Library…</button>
      </header>

      <div className="ai-choices" role="radiogroup" aria-label="Where AI comes from">
        <button type="button" role="radio" aria-checked={choice === 'connect'} className={choice === 'connect' ? 'is-on' : ''} onClick={() => void choose('connect')} data-choice="connect">
          <strong>Use my ComfyUI</strong>
          <span>You already have ComfyUI. Choose its folder once; Atlas starts and uses it and never changes it.</span>
        </button>
        <button type="button" role="radio" aria-checked={choice === 'managed'} className={choice === 'managed' ? 'is-on' : ''} onClick={() => void choose('managed')} data-choice="managed">
          <strong>Let Atlas install its own</strong>
          <span>Atlas installs and looks after a separate ComfyUI on a drive you choose. No Python, no folders, no downloads by hand.</span>
        </button>
        <button type="button" role="radio" aria-checked={choice === 'none'} className={choice === 'none' ? 'is-on' : ''} onClick={() => void choose('none')} data-choice="none">
          <strong>No ComfyUI</strong>
          <span>Use Atlas without it. Optional cloud image services can be added below, always asking first.</span>
        </button>
      </div>

      {choice === 'connect' ? <ComfySetup settings={settings} onChange={onChange} /> : null}

      {choice === 'none' ? (
        <p className="ai-note" data-testid="ai-none">
          Atlas Blend (colour, composition and mood) and plain enlarging work without anything installed. To add paid cloud pictures, enter an OpenAI key and a monthly limit below. Nothing is sent without your approval each time.
        </p>
      ) : null}

      {choice === 'managed' && status ? (
        <div className="ai-managed" data-testid="ai-managed">
          <div className="ai-hw" data-testid="ai-hardware">
            <Icon name="drive" size={15} />
            <span>
              {hw?.gpu ? `${hw.gpu.name}${hw.gpu.vramGB ? ` · ${hw.gpu.vramGB} GB graphics memory` : ''}` : 'No graphics card found'}
              {hw?.note ? <small> {hw.note}</small> : null}
            </span>
          </div>

          {status.runtime.state === 'not-installed' || status.runtime.state === 'broken' || (status.runtime.state === 'installing') ? (
            <div className="ai-card" data-testid="ai-runtime-card">
              <h4>1 · ComfyUI, the picture engine</h4>
              <p>
                Atlas downloads the official ComfyUI for Windows ({gb(status.runtime.downloadBytes)}), checks it against its published checksum, unpacks it (about {gb(status.runtime.diskBytes)} on disk) and starts it once to make sure it works.
                It includes its own Python, so nothing else needs installing. ComfyUI is free software (GPL 3.0) and runs as a separate program.
              </p>
              <label className="studio-field">
                <span>Where to keep it</span>
                <div className="ai-root">
                  <input value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} aria-label="Folder for Atlas's AI" data-testid="ai-root" />
                  <button type="button" className="button button--ghost" onClick={() => void pickRoot()} disabled={working}>
                    <Icon name="folder" size={14} /> Choose…
                  </button>
                </div>
                <small>
                  Atlas writes only inside this folder, which should be empty or new.{status.freeBytes !== null ? ` ${gb(status.freeBytes)} free on that drive.` : ''} Models can be many gigabytes, so a drive other than C: is a good choice.
                </small>
              </label>
              {status.problem ? <p className="ai-problem" role="alert">{status.problem}</p> : null}
              <label className="studio-agree">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={working} data-testid="ai-consent" />
                <span>I agree that Atlas downloads ComfyUI ({gb(status.runtime.downloadBytes)}) from github.com and installs it in the folder above.</span>
              </label>
              {working && job?.kind === 'runtime' ? <JobBar job={job} onStop={() => void window.noema.aiStop()} /> : (
                <button type="button" className="button button--gold" disabled={!consent || !root.trim() || !hw?.supported} onClick={() => void run(() => window.noema.aiInstallRuntime({ root: root.trim(), consent }), 'ComfyUI is installed and works.')} data-testid="ai-install-runtime">
                  <Icon name="plus" size={15} /> {job?.stage === 'stopped' || status.problem ? 'Continue the installation' : 'Install ComfyUI'}
                </button>
              )}
            </div>
          ) : (
            <div className="ai-card ai-card--ok" data-testid="ai-runtime-ready">
              <h4><Icon name="check" size={14} /> ComfyUI is installed</h4>
              <p>
                Version {status.runtime.version} in <code>{status.runtime.folder}</code>. Atlas starts it when it is needed and stops it again.
                {status.runtime.updateTo ? ` A newer version, ${status.runtime.updateTo}, is available.` : ''}
              </p>
              <div className="ai-row">
                {status.runtime.updateTo ? (
                  <button type="button" className="button button--gold" disabled={working} onClick={() => void run(() => window.noema.aiUpdate(true), 'ComfyUI is updated. The previous version is kept until you remove it.')} data-testid="ai-update">Update ComfyUI</button>
                ) : (
                  <button type="button" className="button button--ghost" disabled={working} onClick={() => void run(() => window.noema.aiCheckUpdate(), 'Checked for updates.')}>Check for updates</button>
                )}
                <button type="button" className="button button--ghost" disabled={working} onClick={() => setConfirmRemove(true)}>Remove Atlas’s AI…</button>
              </div>
              {working && (job?.kind === 'update' || job?.kind === 'runtime') ? <JobBar job={job} onStop={() => void window.noema.aiStop()} /> : null}
            </div>
          )}

          {runtimeReady ? (
            <div className="ai-card" data-testid="ai-packages">
              <h4>2 · Capabilities to add</h4>
              <p>Each is a small set of AI models, installed into Atlas’s own folder. Choose what you want; what a package needs is added with it.</p>
              <div className="ai-packs">
                {packs.map((p) => (
                  <PackageCard key={p.id} pack={p} checked={picked.has(p.id) || (p.state === 'installed')} locked={p.state === 'installed' || working} onToggle={() => togglePack(p.id)} />
                ))}
              </div>
              {wanted.length > 0 ? (
                <>
                  <p className="ai-sum" data-testid="ai-sum">
                    Will download {gb(wantedBytes)} for {wanted.map((p) => p.name).join(', ')}. {status.freeBytes !== null ? `${gb(status.freeBytes)} free.` : ''}
                  </p>
                  <label className="studio-agree">
                    <input type="checkbox" checked={packConsent} onChange={(e) => setPackConsent(e.target.checked)} disabled={working} data-testid="ai-pack-consent" />
                    <span>
                      I agree to the download and to these licences: {licenses.map((l) => l.name).join(', ')}. The models come from huggingface.co and github.com.
                    </span>
                  </label>
                </>
              ) : null}
              {working && job?.kind === 'packages' ? <JobBar job={job} onStop={() => void window.noema.aiStop()} /> : (
                <button type="button" className="button button--gold" disabled={wanted.length === 0 || !packConsent} onClick={() => void run(() => window.noema.aiInstallPackages({ ids: [...picked], consent: packConsent }), 'Installed and verified.')} data-testid="ai-install-packages">
                  <Icon name="plus" size={15} /> {wanted.some((p) => p.state === 'partial') ? 'Continue the download' : 'Install the chosen capabilities'}
                </button>
              )}
              {job?.stage === 'stopped' ? <p className="ai-note">{job.message}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {confirmRemove ? (
        <div className="ai-card ai-card--warn" role="alertdialog" aria-label="Remove Atlas's AI" data-testid="ai-remove-confirm">
          <h4>Remove Atlas’s AI?</h4>
          <p>Atlas disconnects its ComfyUI and removes installed models whose contents still match. Runtime folders move to “retained” inside your Atlas AI folder. You can recover custom nodes and workflows there, then delete those folders to reclaim the space.</p>
          <div className="ai-row">
            <button type="button" className="button button--ghost" onClick={() => setConfirmRemove(false)}>Keep it</button>
            <button type="button" className="button button--gold" onClick={() => { setConfirmRemove(false); void run(() => window.noema.aiUninstall(), 'Removed.') }}>Remove</button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function PackageCard({ pack, checked, locked, onToggle }: { pack: AiPackageInfo; checked: boolean; locked: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <article className={`ai-pack${pack.state === 'installed' ? ' is-installed' : ''}`} data-package={pack.id}>
      <label>
        <input type="checkbox" checked={checked} disabled={locked} onChange={onToggle} aria-label={`Install ${pack.name}`} />
        <div>
          <strong>{pack.name}</strong>
          <span>{pack.summary}</span>
        </div>
        <em data-state={pack.state}>{pack.state === 'installed' ? 'Installed' : pack.state === 'partial' ? 'Partly downloaded' : gb(pack.downloadBytes)}</em>
      </label>
      <details>
        <summary>What it is, what it needs</summary>
        <p>{pack.details}</p>
        <ul>
          <li>Download {gb(pack.diskBytes)}; uses {gb(pack.diskBytes)} on disk.</li>
          <li>Comfortable with {pack.vramGB} GB of graphics memory or more.</li>
          {pack.needs.length ? <li>Also installs: {pack.needs.join(', ')}.</li> : null}
          <li>Files: {pack.files.map((f) => `${f.name} (${gb(f.bytes)})`).join(', ')}.</li>
          {pack.licenses.map((l) => (
            <li key={l.name}>
              Licence: <a href={l.url} target="_blank" rel="noreferrer">{l.name}</a>. {l.summary}
            </li>
          ))}
        </ul>
      </details>
    </article>
  )
}

function JobBar({ job, onStop }: { job: AiJob; onStop: () => void }): React.JSX.Element {
  const pct = job.fraction === null ? null : Math.round(job.fraction * 100)
  return (
    <div className="ai-job" role="status" aria-live="polite" data-testid="ai-job" data-stage={job.stage}>
      <div className={`studio-progress__bar${pct === null ? ' is-indeterminate' : ''}`}>
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <p>
        <Spinner size={13} label="Working" /> {job.message}
        {job.totalBytes ? ` ${gb(job.doneBytes)} of ${gb(job.totalBytes)}` : ''}
        {job.speed ? ` · ${speed(job.speed)}` : ''}
        {job.steps > 1 ? ` · file ${job.step} of ${job.steps}` : ''}
      </p>
      <small>You can stop at any time. Starting again continues where it stopped, and every file is checked before it is used.</small>
      <button type="button" className="button button--ghost" onClick={onStop} data-testid="ai-stop">
        <Icon name="stop" size={13} /> Stop
      </button>
    </div>
  )
}
