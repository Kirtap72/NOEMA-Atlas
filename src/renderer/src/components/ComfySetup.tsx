import { useEffect, useState } from 'react'
import type { ComfyWorkflowSummary, StudioSettings } from '@shared/studio'
import { Icon } from './Icon'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'

const KIND_LABEL: Record<ComfyWorkflowSummary['kind'], string> = {
  generate: 'makes pictures',
  edit: 'edits a picture',
  upscale: 'enlarges a picture',
  video: 'video',
  audio: 'sound',
  other: 'unknown'
}

const KIND_OF_INSTALL = { portable: 'portable version', source: 'source install', desktop: 'Desktop app' } as const

/** How Atlas starts this ComfyUI and where its workflows are: the Python, the port, the start options and extra workflow folders. */
function LaunchSettings({ settings, comfy, busy, act }: { settings: StudioSettings; comfy: StudioSettings['comfy']; busy: boolean; act: (label: string, work: () => Promise<StudioSettings>) => Promise<void> }): React.JSX.Element | null {
  const launch = comfy.launch
  const [port, setPort] = useState(settings.comfyPort ? String(settings.comfyPort) : '')
  const [args, setArgs] = useState(settings.comfyArgs.join(' '))
  useEffect(() => setPort(settings.comfyPort ? String(settings.comfyPort) : ''), [settings.comfyPort])
  useEffect(() => setArgs(settings.comfyArgs.join(' ')), [settings.comfyArgs])
  if (!launch) return null
  const save = (): Promise<void> => act('launch', () => window.noema.studioUpdateSettings({ comfyPort: port.trim() ? Number(port) : null, comfyArgs: args.split(/\s+/).filter(Boolean) }))
  return (
    <details className="comfy-setup__launch" data-testid="comfy-launch" open={launch.profiles.length > 0 || settings.comfyPort !== null || settings.comfyWorkflowFolders.length > 0}>
      <summary>How Atlas starts it, and where your workflows are</summary>
      <div className="comfy-launch__grid">
        {launch.kind === 'python' ? (
          <div className="studio-field">
            <span>Python</span>
            <code data-testid="comfy-python">{launch.python ?? 'Not found'}</code>
            <small>{launch.pythonChosen ? 'Chosen by you.' : 'Found next to the installation.'}</small>
            <div className="comfy-setup__buttons">
              <button type="button" className="button button--ghost" onClick={() => void act('python', () => window.noema.studioComfyPick('python'))} disabled={busy}>Choose a different Python…</button>
              {launch.pythonChosen ? <button type="button" className="button button--quiet" onClick={() => void act('python', () => window.noema.studioUpdateSettings({ comfyPython: null }))} disabled={busy}>Use the one found</button> : null}
            </div>
          </div>
        ) : null}
        <label className="studio-field">
          <span>Port</span>
          <input value={port} onChange={(e) => setPort(e.target.value)} placeholder={String(launch.effectivePort)} inputMode="numeric" data-testid="comfy-port" aria-label="ComfyUI port" />
          <small>{settings.comfyPort ? 'Atlas connects only to this port, and starts ComfyUI on it.' : `Empty: the usual port (${launch.effectivePort}), or the next free one.`}</small>
        </label>
        <label className="studio-field">
          <span>Start options</span>
          <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="for example --fp16-unet --reserve-vram 1" spellCheck={false} data-testid="comfy-args" aria-label="ComfyUI start options" />
          <small>Added when Atlas starts ComfyUI. Address and port are set by Atlas.</small>
        </label>
      </div>
      <div className="comfy-setup__buttons">
        <button type="button" className="button button--ghost" onClick={() => void save()} disabled={busy} data-testid="comfy-launch-save">Save these</button>
      </div>
      {launch.profiles.length > 0 ? (
        <div className="comfy-setup__found" data-testid="comfy-profiles">
          <small>Start scripts found beside this ComfyUI (Atlas only reads them)</small>
          {launch.profiles.map((p) => (
            <button key={p.file} type="button" className="button button--ghost" disabled={busy} onClick={() => void act('profile', () => window.noema.studioUpdateSettings({ comfyUseProfile: p.file }))}>
              Use the port and options from {p.name} <span>{p.port ? `port ${p.port}` : 'no port'}{p.args.length ? ` · ${p.args.join(' ')}` : ''}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="comfy-launch__folders" data-testid="comfy-workflow-folders">
        <strong>Workflow folders outside ComfyUI</strong>
        {settings.comfyWorkflowFolders.length === 0 ? <small>None. Atlas reads the workflows in ComfyUI’s own folder.</small> : null}
        <ul>
          {settings.comfyWorkflowFolders.map((f) => (
            <li key={f}>
              <code>{f}</code>
              <button type="button" className="button button--quiet" disabled={busy} onClick={() => void act('folders', () => window.noema.studioUpdateSettings({ comfyWorkflowFolders: settings.comfyWorkflowFolders.filter((x) => x !== f) }))}>Remove</button>
            </li>
          ))}
        </ul>
        {comfy.suggestedWorkflowFolders.map((f) => (
          <button key={f} type="button" className="button button--ghost" disabled={busy} onClick={() => void act('folders', () => window.noema.studioUpdateSettings({ comfyWorkflowFolders: [...settings.comfyWorkflowFolders, f] }))}>Add {f}</button>
        ))}
        <button type="button" className="button button--ghost" disabled={busy} onClick={() => void act('folders', () => window.noema.studioComfyPick('workflows'))}>Add a workflow folder…</button>
      </div>
    </details>
  )
}

/**
 * Setting ComfyUI up once: choose the folder, and Atlas does the rest. It shows what it found, what is missing in
 * plain words, and whether ComfyUI is running. It never changes the user's ComfyUI folders or workflows.
 */
export function ComfySetup({ settings, onChange }: { settings: StudioSettings; onChange: (s: StudioSettings) => void }): React.JSX.Element {
  const { toast } = useAtlas()
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const comfy = settings.comfy

  useEffect(() => window.noema.onComfyProgress(setProgress), [])
  // While ComfyUI is starting, look again every few seconds, so the status keeps up.
  useEffect(() => {
    if (comfy.state !== 'starting') return
    const timer = window.setInterval(() => void window.noema.studioSettings().then(onChange).catch(() => undefined), 2500)
    return () => window.clearInterval(timer)
  }, [comfy.state, onChange])

  const act = async (label: string, work: () => Promise<StudioSettings>): Promise<void> => {
    setBusy(label)
    setProgress('')
    try {
      onChange(await work())
    } catch (error) {
      toast(friendlyError(error), 'error')
      void window.noema.studioSettings().then(onChange).catch(() => undefined)
    } finally {
      setBusy(null)
      setProgress('')
    }
  }

  const choose = (): Promise<void> => act('choose', () => window.noema.studioComfyChooseFolder())
  const use = (folder: string): Promise<void> => act('choose', () => window.noema.studioUpdateSettings({ comfyFolder: folder }))
  const setWorkflow = (key: 'comfyWorkflowId' | 'comfyEditWorkflowId' | 'comfyUpscaleWorkflowId', value: string): Promise<void> =>
    act('workflow', () => window.noema.studioUpdateSettings({ [key]: value || null }))

  const ready = (kinds: Array<ComfyWorkflowSummary['kind']>): ComfyWorkflowSummary[] => comfy.workflows.filter((w) => w.runnable && kinds.includes(w.kind))
  const badge = comfy.state === 'running' ? 'ok' : comfy.state === 'problem' ? 'bad' : comfy.state === 'starting' ? 'wait' : 'idle'

  return (
    <section className="comfy-setup" data-testid="comfy-setup" aria-label="ComfyUI">
      <div className="comfy-setup__head">
        <h3>ComfyUI</h3>
        <span className={`comfy-badge comfy-badge--${badge}`} data-testid="comfy-status" role="status">{comfy.headline}</span>
      </div>

      {comfy.state === 'not-set-up' || comfy.state === 'problem' && !comfy.install ? (
        <div className="comfy-setup__intro">
          <p>{comfy.detail}</p>
          <p className="comfy-setup__small">Atlas only reads this folder. It finds your models and workflows, starts ComfyUI when you make a picture, and never changes your installation.</p>
          <button type="button" className="button button--gold" onClick={() => void choose()} disabled={busy !== null} data-testid="comfy-choose">
            <Icon name="folder" size={15} /> Choose my ComfyUI folder
          </button>
          {comfy.suggestions.length > 0 ? (
            <div className="comfy-setup__found" data-testid="comfy-suggestions">
              <small>Found on this computer</small>
              {comfy.suggestions.map((s) => (
                <button key={s.folder} type="button" className="button button--ghost" onClick={() => void use(s.folder)} disabled={busy !== null}>
                  Use {s.name} ({KIND_OF_INSTALL[s.kind]}) <span>{s.folder}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {comfy.install ? (
            <div className="comfy-setup__install" data-testid="comfy-install">
              <strong>{comfy.install.name}{comfy.install.version ? ` ${comfy.install.version}` : ''}</strong>
              <span>{KIND_OF_INSTALL[comfy.install.kind]} · {comfy.install.folder}</span>
            </div>
          ) : null}
          <p className="comfy-setup__detail" data-testid="comfy-detail">{busy === 'start' && progress ? progress : comfy.detail}</p>
          <div className="comfy-setup__buttons">
            {comfy.state !== 'running' ? (
              <button type="button" className="button button--gold" onClick={() => void act('start', () => window.noema.studioComfyStart())} disabled={busy !== null || comfy.state === 'starting' || !comfy.install} data-testid="comfy-start">
                <Icon name="refresh" size={14} /> {busy === 'start' || comfy.state === 'starting' ? 'Starting…' : 'Start ComfyUI now'}
              </button>
            ) : null}
            {comfy.startedByAtlas ? (
              <button type="button" className="button button--ghost" onClick={() => void act('stop', () => window.noema.studioComfyStop())} disabled={busy !== null} data-testid="comfy-stop">
                <Icon name="stop" size={14} /> Close ComfyUI
              </button>
            ) : null}
            <button type="button" className="button button--ghost" onClick={() => void act('rescan', () => window.noema.studioComfyRescan())} disabled={busy !== null}>
              <Icon name="refresh" size={14} /> Look again
            </button>
            <button type="button" className="button button--ghost" onClick={() => void choose()} disabled={busy !== null}>Change folder</button>
            <button type="button" className="button button--quiet" onClick={() => void act('forget', () => window.noema.studioUpdateSettings({ comfyFolder: null }))} disabled={busy !== null}>Forget it</button>
          </div>
          <label className="studio-agree comfy-setup__auto">
            <input type="checkbox" checked={settings.comfyAutoStart} onChange={(e) => void act('auto', () => window.noema.studioUpdateSettings({ comfyAutoStart: e.target.checked }))} />
            <span>Start ComfyUI by itself when I make a picture</span>
          </label>

          {comfy.launch ? <LaunchSettings settings={settings} comfy={comfy} busy={busy !== null} act={act} /> : null}

          {comfy.models ? <p className="comfy-setup__models"data-testid="comfy-models">{comfy.models.summary}</p> : null}

          {comfy.needs.length > 0 ? (
            <div className="comfy-setup__needs" data-testid="comfy-needs">
              <strong>What is needed</strong>
              <ul>{comfy.needs.map((line) => <li key={line}>{line}</li>)}</ul>
            </div>
          ) : (
            <p className="comfy-setup__ready"><Icon name="check" size={13} /> Ready: you can make pictures with ComfyUI from the Studio.</p>
          )}

          {comfy.workflows.length > 0 ? (
            <div className="comfy-setup__workflows">
              <div className="comfy-setup__choices">
                <label className="studio-field">
                  <span>Make pictures with</span>
                  <select value={settings.comfyWorkflowId ?? ''} onChange={(e) => void setWorkflow('comfyWorkflowId', e.target.value)} aria-label="Workflow for making pictures">
                    <option value="">Atlas’s standard graph (uses a checkpoint)</option>
                    {ready(['generate']).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
                <label className="studio-field">
                  <span>Edit pictures with</span>
                  <select value={settings.comfyEditWorkflowId ?? ''} onChange={(e) => void setWorkflow('comfyEditWorkflowId', e.target.value)} aria-label="Workflow for editing pictures">
                    <option value="">Atlas’s standard graph (uses a checkpoint)</option>
                    {ready(['edit']).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
                <label className="studio-field">
                  <span>Enlarge pictures with</span>
                  <select value={settings.comfyUpscaleWorkflowId ?? ''} onChange={(e) => void setWorkflow('comfyUpscaleWorkflowId', e.target.value)} aria-label="Workflow for enlarging pictures">
                    <option value="">Not set</option>
                    {ready(['upscale']).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
              </div>
              <details className="comfy-setup__list">
                <summary>Your workflows ({comfy.workflows.length})</summary>
                <ul data-testid="comfy-workflows">
                  {comfy.workflows.map((w) => (
                    <li key={w.id} className={w.runnable ? 'is-ready' : 'is-missing'}>
                      <span className="comfy-setup__wname">{w.name}</span>
                      <span className="comfy-chip">{KIND_LABEL[w.kind]}</span>
                      <span className={`comfy-chip ${w.runnable ? 'comfy-chip--ok' : 'comfy-chip--bad'}`}>{w.runnable ? 'ready' : 'not ready'}</span>
                      {w.why ? <small>{w.why}</small> : null}
                    </li>
                  ))}
                </ul>
                {comfy.hiddenWorkflows > 0 ? <small>{comfy.hiddenWorkflows} workflow{comfy.hiddenWorkflows === 1 ? '' : 's'} for video or sound are not listed.</small> : null}
              </details>
            </div>
          ) : null}
        </>
      )}
      <p className="comfy-setup__small">Your workflows and settings are only read. Nothing is written to your ComfyUI folders.</p>
    </section>
  )
}
