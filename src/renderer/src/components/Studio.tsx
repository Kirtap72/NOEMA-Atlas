import { isLoopback } from '../../../shared/network'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageItem, MoodboardDetail } from '@shared/types'
import type { Capability, CapabilityId } from '@shared/ai'
import {
  ASPECTS,
  EDIT_LEVELS,
  REF_ROLES,
  type ArtworkConcept,
  type AspectChoice,
  type EditAlternative,
  type EditLevel,
  type EditReferences,
  type EditRegion,
  type ExternalEditSession,
  type GenerationRecord,
  type RefInfluence,
  type ReferencePipelineInfo,
  type RefRole,
  type RetouchTool,
  type StudioEstimate,
  type StudioMethod,
  type StudioProgress,
  type StudioSettings
} from '@shared/studio'
import { Icon } from './Icon'
import { StudioAiSetup } from './StudioAiSetup'
import { LevelPicker, ReferencePanel, RegionPanel, VersionStrip } from './StudioEditTools'
import { RetouchView } from './StudioRetouch'
import { ExternalHost, ExternalSessionPanel } from './ExternalReturn'
import { upsertSession, useExternalSessions } from '../lib/externalStore'
import { openViewer } from './StudioViewer'
import { Spinner } from './ui'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'

export const OPEN_STUDIO_EVENT = 'atlas:open-studio'

export type OpenStudioDetail =
  | { mode: 'create'; boardId?: string; intent?: string; prompt?: string; negative?: string; aspect?: AspectChoice; roles?: Record<string, RefRole[]>; title?: string }
  | { mode: 'edit'; imageId?: string; instruction?: string; strength?: number; level?: EditLevel; region?: EditRegion; references?: EditReferences }
  | { mode: 'retouch'; imageId?: string; tool?: RetouchTool; region?: EditRegion; strength?: number; edgeAware?: boolean; tone?: 'lighten' | 'darken'; hint?: string }

export function openStudio(detail: OpenStudioDetail): void {
  window.dispatchEvent(new CustomEvent<OpenStudioDetail>(OPEN_STUDIO_EVENT, { detail }))
}

const ROLE_LABEL: Record<RefRole, string> = { atmosphere: 'Atmosphere', composition: 'Composition', colour: 'Colours', material: 'Materials', subject: 'Subject' }
const ROLE_HINT: Record<RefRole, string> = {
  atmosphere: 'Mood, light and feeling to carry over',
  composition: 'How the picture is arranged',
  colour: 'Palette to borrow',
  material: 'Surfaces and textures to borrow',
  subject: 'What to show: subjects and forms'
}

/** Lives in the app shell and opens the Creative Studio whenever something asks for it. */
export function StudioHost(): React.JSX.Element | null {
  // The key changes only when something asks to open the studio, never when the app around it re-renders.
  const [open, setOpen] = useState<{ detail: OpenStudioDetail; nonce: number } | null>(null)
  useEffect(() => {
    const show = (event: Event): void => setOpen((current) => ({ detail: (event as CustomEvent<OpenStudioDetail>).detail, nonce: (current?.nonce ?? 0) + 1 }))
    window.addEventListener(OPEN_STUDIO_EVENT, show)
    return () => window.removeEventListener(OPEN_STUDIO_EVENT, show)
  }, [])
  return (
    <>
      <ExternalHost />
      {open ? <StudioDialog key={open.nonce} detail={open.detail} onClose={() => setOpen(null)} /> : null}
    </>
  )
}

function money(value: number): string {
  return value < 0.1 ? `$${value.toFixed(3).replace(/0$/, '')}` : `$${value.toFixed(2)}`
}

// ---- method picker with price and consent ---------------------------------------------------------------------------

function MethodPicker({
  settings,
  methodId,
  onMethod,
  model,
  onModel,
  estimate,
  agreed,
  onAgree,
  edit
}: {
  settings: StudioSettings | null
  methodId: StudioMethod['id']
  onMethod: (id: StudioMethod['id']) => void
  model: string
  onModel: (model: string) => void
  estimate: StudioEstimate | null
  agreed: boolean
  onAgree: (value: boolean) => void
  edit: boolean
}): React.JSX.Element {
  const openSetup = useContext(SetupContext)
  if (!settings) return <Spinner label="Looking for ways to make pictures" />
  const current = settings.methods.find((m) => m.id === methodId)
  return (
    <div className="studio-methods">
      {settings.methods.map((method) => {
        const usable = method.available && (edit ? method.canEdit : method.canGenerate)
        return (
          <button
            key={method.id}
            type="button"
            className={`studio-method${methodId === method.id ? ' is-on' : ''}${usable ? '' : ' is-off'}`}
            onClick={() => usable && onMethod(method.id)}
            aria-pressed={methodId === method.id}
            aria-disabled={!usable}
            data-method={method.id}
          >
            <span className="studio-method__head">
              <strong>{method.name}</strong>
              <em className={`studio-badge studio-badge--${method.kind}`}>{method.kind === 'offline' ? 'Offline' : method.kind === 'local' ? 'On this computer' : method.id === 'comfyui' ? 'Network server' : 'Cloud · paid'}</em>
            </span>
            <span className="studio-method__text">{usable ? method.description : (method.reason ?? 'Not available.')}</span>
            {!usable && method.kind !== 'offline' ? <span className="studio-method__setup" role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); openSetup() }} onKeyDown={(e) => e.key === 'Enter' && openSetup()} data-testid={`method-setup-${method.id}`}>Set this up…</span> : null}
          </button>
        )
      })}
      {current && current.models.length > 1 ? (
        <label className="studio-field">
          <span>Model</span>
          <select value={model || current.model} onChange={(e) => onModel(e.target.value)}>
            {current.models.map((m) => (
              <option key={m} value={m}>{current.modelLabels?.[m] ?? m}</option>
            ))}
          </select>
        </label>
      ) : null}
      {estimate ? (
        <div className={`studio-estimate${estimate.overBudget ? ' is-bad' : ''}`} data-testid="studio-estimate">
          <Icon name={estimate.leavesComputer ? 'external' : 'lock'} size={13} /> <span>{estimate.message}</span>
        </div>
      ) : null}
      {estimate?.leavesComputer ? (
        <label className="studio-agree">
          <input type="checkbox" checked={agreed} onChange={(e) => onAgree(e.target.checked)} />
          <span>
            I agree to send {edit ? 'this picture and instruction' : 'this prompt and any selected input pictures'} to the selected service{estimate.costUsd > 0 ? ` and to pay about ${money(estimate.costUsd)}` : ''}.
          </span>
        </label>
      ) : null}
    </div>
  )
}

// ---- progress -------------------------------------------------------------------------------------------------------

function useJob(): { jobId: string; progress: StudioProgress | null; reset: () => string } {
  const [jobId, setJobId] = useState('')
  const [progress, setProgress] = useState<StudioProgress | null>(null)
  const idRef = useRef('')
  useEffect(() => window.noema.onStudioProgress((p) => p.jobId === idRef.current && setProgress(p)), [])
  const reset = useCallback((): string => {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
    idRef.current = id
    setJobId(id)
    setProgress(null)
    return id
  }, [])
  return { jobId, progress, reset }
}

function ProgressBar({ progress, onStop }: { progress: StudioProgress | null; onStop: () => void }): React.JSX.Element {
  const pct = progress?.fraction === null || progress?.fraction === undefined ? null : Math.round(progress.fraction * 100)
  return (
    <div className="studio-progress" role="status" aria-live="polite">
      <div className={`studio-progress__bar${pct === null ? ' is-indeterminate' : ''}`}>
        <span style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <p>{progress?.message ?? 'Getting ready…'}</p>
      <button type="button" className="button button--ghost" onClick={onStop}>
        <Icon name="stop" size={13} /> Stop
      </button>
    </div>
  )
}

// ---- settings -------------------------------------------------------------------------------------------------------

function StudioSettingsPanel({ settings, onChange }: { settings: StudioSettings; onChange: (s: StudioSettings) => void }): React.JSX.Element {
  const { toast } = useAtlas()
  const [comfyUrl, setComfyUrl] = useState(settings.comfyUrl)
  const [approvedServer, setApprovedServer] = useState(settings.approvedComfyUrl ?? '')
  const [workflow, setWorkflow] = useState(settings.comfyWorkflow ?? '')
  const [key, setKey] = useState('')
  const [budget, setBudget] = useState(String(settings.monthlyBudget))
  const [editors, setEditors] = useState(settings.editors)
  const save = async (): Promise<void> => {
    try {
      const next = await window.noema.studioUpdateSettings({
        comfyUrl,
        approvedComfyUrl: approvedServer.trim() || null,
        comfyWorkflow: workflow.trim() || null,
        monthlyBudget: Number(budget) || 0,
        editors,
        ...(key.trim() ? { cloudKey: key.trim() } : {})
      })
      setKey('')
      onChange(next)
      toast('Studio settings saved.', 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }
  return (
    <div className="studio-settings">
      <StudioAiSetup settings={settings} onChange={onChange} />
      <details className="studio-advanced">
        <summary>Advanced ComfyUI settings</summary>
        <label className="studio-field">
          <span>ComfyUI address (only if you run it somewhere else)</span>
          <input value={comfyUrl} onChange={(e) => { setComfyUrl(e.target.value); setApprovedServer('') }} spellCheck={false} />
          <small>Normally Atlas finds ComfyUI by itself. Enter the address of the server you intend to use.</small>
        </label>
        {comfyUrl.trim() && !isLoopback(comfyUrl.trim()) && (
          <label className="studio-agree"><input type="checkbox" checked={approvedServer === comfyUrl.trim()} onChange={(e) => setApprovedServer(e.target.checked ? comfyUrl.trim() : '')} />
            Allow Studio to send prompts, input images, filenames and masks to {comfyUrl.trim()} for ComfyUI jobs, including Retouch and Upscale.
          </label>
        )}
        <label className="studio-field">
          <span>A workflow file with placeholders (optional)</span>
          <input value={workflow} onChange={(e) => setWorkflow(e.target.value)} placeholder="C:\path\to\workflow_api.json" spellCheck={false} />
          <small>Exported with “Save (API format)”. Use {'{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{image}}'} where Atlas should fill things in. Workflows in your ComfyUI folder are found automatically and need no placeholders.</small>
        </label>
      </details>
      <label className="studio-field">
        <span>OpenAI key for cloud pictures (optional){settings.cloudKeySet ? ' · stored encrypted' : ''}</span>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.cloudKeySet ? 'Key saved. Type a new one to replace it.' : 'sk-…'} autoComplete="off" />
      </label>
      <label className="studio-field">
        <span>Monthly limit for paid pictures (US dollars) · used {money(settings.spentThisMonth)}</span>
        <input type="number" min={0} step={1} value={budget} onChange={(e) => setBudget(e.target.value)} />
        <small>0 keeps paid services switched off.</small>
      </label>
      <div className="studio-field">
        <span>Programs for “Edit in…”</span>
        {editors.map((editor, index) => (
          <div key={editor.id} className="studio-editor-row">
            <input value={editor.name} onChange={(e) => setEditors(editors.map((x, i) => (i === index ? { ...x, name: e.target.value } : x)))} aria-label="Name" />
            <input value={editor.path} onChange={(e) => setEditors(editors.map((x, i) => (i === index ? { ...x, path: e.target.value } : x)))} aria-label="Program file" spellCheck={false} />
            <button type="button" className="icon-button" onClick={() => setEditors(editors.filter((_x, i) => i !== index))} aria-label="Remove program">
              <Icon name="close" size={14} />
            </button>
          </div>
        ))}
        <button type="button" className="button button--ghost" onClick={() => setEditors([...editors, { id: `ed-${Date.now().toString(36)}`, name: 'My editor', path: '' }])}>
          <Icon name="plus" size={14} /> Add a program
        </button>
      </div>
      <div className="studio-settings__actions">
        <button type="button" className="button button--gold" onClick={() => void save()}>Save settings</button>
        <button type="button" className="button button--ghost" onClick={() => void window.noema.studioOpenFolder()}>
          <Icon name="folder" size={14} /> Open the studio folder
        </button>
      </div>
      <small className="studio-note">Finished pictures are kept in {settings.studioFolder}</small>
    </div>
  )
}

// ---- what is available, and how to get more ---------------------------------------------------------------------------

/** Lets any part of the Studio open the AI setup (the settings panel) instead of silently disabling something. */
const SetupContext = createContext<() => void>(() => undefined)

/** Says what Atlas can do for one kind of work right now, or what is missing and how to add it. Never silent. */
function CapabilityBanner({ id }: { id: CapabilityId }): React.JSX.Element | null {
  const openSetup = useContext(SetupContext)
  const [cap, setCap] = useState<Capability | null>(null)
  useEffect(() => {
    void window.noema.aiCapabilities().then((all) => setCap(all.find((c) => c.id === id) ?? null)).catch(() => setCap(null))
  }, [id])
  if (!cap) return null
  return (
    <div className={`studio-capability${cap.ready ? ' is-ready' : ' is-missing'}`} data-testid={`capability-${id}`} data-ready={cap.ready}>
      <Icon name={cap.ready ? 'check' : 'info'} size={14} />
      <div>
        {cap.ready ? (
          <span>
            <strong>{cap.label}:</strong> {cap.how}. {cap.options.length > 1 ? `Also available: ${cap.options.slice(1).map((o) => o.label).join(', ')}.` : ''}
          </span>
        ) : (
          <span>
            <strong>{cap.label}:</strong> {cap.missing}
          </span>
        )}
      </div>
      {!cap.ready && cap.offer ? (
        <button type="button" className="button button--ghost" onClick={openSetup} data-testid={`setup-${id}`}>
          Set up…
        </button>
      ) : null}
    </div>
  )
}

/** Choose the picture to edit: something made in the Studio, or anything in the library. */
function EditPicker({ onPick }: { onPick: (imageId: string) => void }): React.JSX.Element {
  const [made, setMade] = useState<ImageItem[]>([])
  const [library, setLibrary] = useState<ImageItem[] | null>(null)
  const [search, setSearch] = useState('')
  useEffect(() => {
    void (async () => {
      const records = await window.noema.studioGenerations().catch(() => [])
      const ids = Array.from(new Set(records.map((r) => r.imageId).filter((x): x is string => Boolean(x)))).slice(0, 24)
      const items = await Promise.all(ids.map((id) => window.noema.getImage(id).catch(() => null)))
      setMade(items.filter((i): i is ImageItem => Boolean(i && !i.missing)))
    })()
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void window.noema.listImages({ scope: 'collection', search: search.trim() || undefined, sort: 'recent', limit: 30 }).then((page) => setLibrary(page.items)).catch(() => setLibrary([]))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [search])
  const grid = (items: ImageItem[], label: string): React.JSX.Element => (
    <div className="studio-picker__grid" role="list" aria-label={label}>
      {items.map((item) => (
        <button key={item.id} type="button" role="listitem" onClick={() => onPick(item.id)} title={item.filename} data-testid="picker-item">
          <img src={item.thumbUrl} alt={item.filename} draggable={false} />
        </button>
      ))}
    </div>
  )
  return (
    <div className="studio-picker" data-testid="edit-picker">
      <CapabilityBanner id="edit" />
      <h3>Choose a picture</h3>
      <p className="studio-hint">The original is never changed. Your edit is previewed first and saved as a new version next to it.</p>
      {made.length > 0 ? (
        <>
          <h4>Made in the Studio</h4>
          {grid(made, 'Pictures made in the Studio')}
        </>
      ) : null}
      <h4>From your library</h4>
      <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search your pictures" aria-label="Search your pictures" />
      {library === null ? <Spinner label="Looking through your library" /> : library.length === 0 ? <p className="studio-hint">No pictures found.</p> : grid(library, 'Pictures in your library')}
    </div>
  )
}

// ---- the dialog -----------------------------------------------------------------------------------------------------

function StudioDialog({ detail, onClose }: { detail: OpenStudioDetail; onClose: () => void }): React.JSX.Element {
  const { moodboards, refresh, toast } = useAtlas()
  const [settings, setSettings] = useState<StudioSettings | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [mode, setMode] = useState<'create' | 'edit' | 'retouch'>(detail.mode)
  const [editImageId, setEditImageId] = useState<string | null>(detail.mode === 'edit' || detail.mode === 'retouch' ? (detail.imageId ?? null) : null)

  useEffect(() => {
    void window.noema.studioSettings().then(setSettings).catch((e) => toast(friendlyError(e), 'error'))
  }, [toast])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const switchToEdit = (imageId: string): void => {
    setEditImageId(imageId)
    setMode('edit')
  }

  return createPortal(
    <div className="studio-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="studio" role="dialog" aria-modal="true" aria-label="Creative Studio">
        <header className="studio__head">
          <div>
            <div className="eyebrow">CREATIVE STUDIO</div>
            <h2>{mode === 'create' ? 'From moodboard to artwork' : mode === 'retouch' ? 'Remove and blur, keep the original' : 'Edit a picture, keep the original'}</h2>
          </div>
          <div className="studio__tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'create'} className={mode === 'create' ? 'is-on' : ''} onClick={() => setMode('create')}>Create</button>
            <button type="button" role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'is-on' : ''} onClick={() => setMode('edit')} data-testid="tab-edit">Edit</button>
            <button type="button" role="tab" aria-selected={mode === 'retouch'} className={mode === 'retouch' ? 'is-on' : ''} onClick={() => setMode('retouch')} data-testid="tab-retouch">Retouch</button>
          </div>
          <button type="button" className={`icon-button${showSettings ? ' is-on' : ''}`} onClick={() => setShowSettings((v) => !v)} aria-label="Studio settings" title="Studio settings">
            <Icon name="more" size={17} />
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close the studio">
            <Icon name="close" size={17} />
          </button>
        </header>
        <div className="studio__body">
          <SetupContext.Provider value={() => setShowSettings(true)}>
          {showSettings && settings ? <StudioSettingsPanel settings={settings} onChange={setSettings} /> : null}
          {mode === 'create' ? (
            <CreateView detail={detail.mode === 'create' ? detail : { mode: 'create' }} settings={settings} moodboards={moodboards} onEdit={switchToEdit} onChanged={refresh} />
          ) : mode === 'retouch' ? (
            editImageId ? (
              <RetouchView imageId={editImageId} settings={settings} onChanged={refresh} onChoose={() => setEditImageId(null)} onOpenImage={setEditImageId} initial={detail.mode === 'retouch' ? { tool: detail.tool, region: detail.region, strength: detail.strength, edgeAware: detail.edgeAware, tone: detail.tone, hint: detail.hint } : undefined} />
            ) : (
              <EditPicker onPick={setEditImageId} />
            )
          ) : editImageId ? (
            <EditView imageId={editImageId} onRetouch={() => setMode('retouch')} settings={settings} moodboards={moodboards} onChanged={refresh} onChoose={() => setEditImageId(null)} onOpenImage={setEditImageId} initialInstruction={detail.mode === 'edit' ? detail.instruction : undefined} initialStrength={detail.mode === 'edit' ? detail.strength : undefined} initialLevel={detail.mode === 'edit' ? detail.level : undefined} initialRegion={detail.mode === 'edit' ? detail.region : undefined} initialReferences={detail.mode === 'edit' ? detail.references : undefined} />
          ) : (
            <EditPicker onPick={setEditImageId} />
          )}
          </SetupContext.Provider>
        </div>
      </section>
    </div>,
    document.body
  )
}

// ---- create ---------------------------------------------------------------------------------------------------------

function CreateView({
  detail,
  settings,
  moodboards,
  onEdit,
  onChanged
}: {
  detail: Extract<OpenStudioDetail, { mode: 'create' }>
  settings: StudioSettings | null
  moodboards: Array<{ id: string; name: string; imageCount: number }>
  onEdit: (imageId: string) => void
  onChanged: () => void
}): React.JSX.Element {
  const { toast } = useAtlas()
  const [boardId, setBoardId] = useState(detail.boardId ?? moodboards[0]?.id ?? '')
  const [board, setBoard] = useState<MoodboardDetail | null>(null)
  const [roles, setRoles] = useState<Record<string, RefRole[]>>(detail.roles ?? {})
  const [referenceMode, setReferenceMode] = useState<'auto' | 'images' | 'description'>('auto')
  const [influence, setInfluence] = useState<Record<string, RefInfluence>>({})
  const [pipelines, setPipelines] = useState<ReferencePipelineInfo[]>([])
  useEffect(() => {
    void window.noema.studioReferencePipelines().then(setPipelines).catch(() => setPipelines([]))
  }, [])
  const [intent, setIntent] = useState(detail.intent ?? '')
  const [aspect, setAspect] = useState<AspectChoice>(detail.aspect ?? 'landscape')
  const [concept, setConcept] = useState<ArtworkConcept | null>(null)
  const [title, setTitle] = useState(detail.title ?? '')
  const [prompt, setPrompt] = useState(detail.prompt ?? '')
  const [negative, setNegative] = useState(detail.negative ?? 'text, watermark, logo, low quality, blurry')
  const [methodId, setMethodId] = useState<StudioMethod['id']>('blend')
  const [model, setModel] = useState('')
  const [count, setCount] = useState(2)
  const [strength, setStrength] = useState(0.6)
  const [agreed, setAgreed] = useState(false)
  const [estimate, setEstimate] = useState<StudioEstimate | null>(null)
  const [busy, setBusy] = useState<'concept' | 'make' | null>(null)
  const [results, setResults] = useState<Array<{ record: GenerationRecord; item: ImageItem | null }>>([])
  const [parent, setParent] = useState<GenerationRecord | null>(null)
  const { jobId, progress, reset } = useJob()
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!boardId) return
    void window.noema.getMoodboard(boardId).then(setBoard).catch(() => setBoard(null))
  }, [boardId])

  // Picks the best way that is available, once the methods are known.
  useEffect(() => {
    if (!settings) return
    const current = settings.methods.find((m) => m.id === methodId)
    if (!current?.available) setMethodId(settings.methods.find((m) => m.id === 'comfyui' && m.available)?.id ?? 'blend')
  }, [settings, methodId])

  const size = ASPECTS[aspect]
  useEffect(() => {
    void window.noema.studioEstimate(methodId, model || undefined, count, size.width, size.height).then(setEstimate).catch(() => setEstimate(null))
  }, [methodId, model, count, size.width, size.height, settings])

  const toggleRole = (imageId: string, role: RefRole): void =>
    setRoles((current) => {
      const has = current[imageId] ?? []
      const next = has.includes(role) ? has.filter((r) => r !== role) : [...has, role]
      const copy = { ...current }
      if (next.length) copy[imageId] = next
      else delete copy[imageId]
      return copy
    })

  const develop = async (): Promise<void> => {
    if (!boardId) return
    setBusy('concept')
    try {
      const c = await window.noema.studioConcept({ moodboardId: boardId, intent, roles, aspect })
      setConcept(c)
      setPrompt(c.prompt)
      setNegative(c.negative)
      setTitle(c.title)
      setAspect(c.aspect)
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const make = async (over?: { parent?: GenerationRecord | null; prompt?: string; count?: number }): Promise<void> => {
    const usedParent = over?.parent !== undefined ? over.parent : parent
    const usedPrompt = over?.prompt ?? prompt
    // With nothing chosen the whole board speaks, as the interface says: every picture lends its atmosphere and colours, the first its composition.
    const live = (board?.images ?? []).filter((i) => !i.missing)
    const effectiveRoles: Record<string, RefRole[]> =
      Object.keys(roles).length > 0 ? roles : Object.fromEntries(live.slice(0, 6).map((i, n): [string, RefRole[]] => [i.id, n === 0 ? ['composition', 'atmosphere', 'colour'] : ['atmosphere', 'colour']]))
    setBusy('make')
    const id = reset()
    try {
      const result = await window.noema.studioGenerate({
        jobId: id,
        methodId,
        model: model || undefined,
        moodboardId: boardId || null,
        title: title || 'Untitled',
        prompt: usedPrompt,
        negative,
        width: size.width,
        height: size.height,
        count: over?.count ?? count,
        roles: effectiveRoles,
        influence,
        referenceMode,
        parentId: usedParent?.id ?? null,
        seriesId: usedParent?.seriesId ?? null,
        strength,
        approvedCost: estimate?.costUsd ?? 0,
        approvedUpload: agreed
      })
      if (!result.ok) {
        toast(result.message, 'error')
        return
      }
      const items = await Promise.all(result.records.map((r) => (r.imageId ? window.noema.getImage(r.imageId).catch(() => null) : Promise.resolve(null))))
      setResults((current) => [...result.records.map((record, i) => ({ record, item: items[i] ?? null })), ...current])
      setAgreed(false)
      onChanged()
      void window.noema.studioSettings().then(() => undefined)
      toast(result.message, 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setBusy(null)
    }
  }

  const addToBoard = async (record: GenerationRecord): Promise<void> => {
    if (!record.imageId || !boardId) return
    try {
      await window.noema.addToMoodboard({ moodboardId: boardId, imageIds: [record.imageId] })
      onChanged()
      toast('Added to the moodboard.', 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  const needsAgreement = Boolean(estimate?.leavesComputer)
  const canMake = Boolean(prompt.trim()) && busy === null && (!needsAgreement || (agreed && !estimate?.overBudget)) && !(estimate?.overBudget && needsAgreement)

  return (
    <div className="studio-grid">
      <div className="studio-col">
        <h3>1 · Your moodboard</h3>
        <label className="studio-field">
          <span>Moodboard</span>
          <select value={boardId} onChange={(e) => { setBoardId(e.target.value); setRoles({}) }} aria-label="Moodboard">
            {moodboards.map((b) => (
              <option key={b.id} value={b.id}>{b.name} · {b.imageCount}</option>
            ))}
          </select>
        </label>
        <p className="studio-hint">Tell Atlas what each picture is for. A picture can do several things. Without choices, the whole board speaks.</p>
        <div className="studio-refs">
          {(board?.images ?? []).filter((i) => !i.missing).slice(0, 24).map((image) => (
            <figure key={image.id} className="studio-ref">
              <img src={image.thumbUrl} alt="" draggable={false} />
              <figcaption>
                {REF_ROLES.map((role) => (
                  <button key={role} type="button" className={roles[image.id]?.includes(role) ? 'is-on' : ''} onClick={() => toggleRole(image.id, role)} title={ROLE_HINT[role]} aria-pressed={roles[image.id]?.includes(role) ?? false} data-role={role}>
                    {ROLE_LABEL[role]}
                  </button>
                ))}
              </figcaption>
            </figure>
          ))}
          {board && board.images.length === 0 ? <p className="studio-hint">This moodboard is empty.</p> : null}
        </div>
        <div className="studio-refmode" data-testid="reference-mode">
          <div className="studio-aspects" role="radiogroup" aria-label="How the pictures are used">
            {([['auto', 'Automatic'], ['images', 'The pictures themselves'], ['description', 'Only their description']] as const).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={referenceMode === id} className={referenceMode === id ? 'is-on' : ''} onClick={() => setReferenceMode(id)} data-mode={id}>
                {label}
              </button>
            ))}
          </div>
          {referenceMode !== 'description' && Object.values(roles).some((r) => r.length > 0) ? (
            <div className="studio-influence" role="group" aria-label="How strongly each picture counts">
              {(board?.images ?? []).filter((i) => !i.missing && (roles[i.id]?.length ?? 0) > 0).slice(0, 6).map((image) => (
                <label key={image.id}>
                  <img src={image.thumbUrl} alt="" draggable={false} />
                  <select value={influence[image.id] ?? 'balanced'} onChange={(e) => setInfluence((cur) => ({ ...cur, [image.id]: e.target.value as RefInfluence }))} aria-label="Influence of this picture" data-testid="influence-select">
                    <option value="subtle">Loosely</option>
                    <option value="balanced">Balanced</option>
                    <option value="strong">Closely</option>
                  </select>
                </label>
              ))}
            </div>
          ) : null}
          <p className="studio-hint">
            {referenceMode === 'description'
              ? 'Atlas describes what the pictures are for in words and uses no picture data. Works with every method.'
              : referenceMode === 'images'
                ? 'The pictures are handed to the model, each prepared for its purpose: a layout sketch, a study of light and colour, a close-up of a material, or the picture itself. A paid cloud method uploads these pictures, and you approve that before anything is sent.'
                : 'Uses the pictures themselves when your local model can, and their description otherwise. Nothing is ever uploaded in this mode.'}
          </p>
          <details className="studio-capdetails">
            <summary>What each model can do with references</summary>
            <ul data-testid="reference-pipelines">
              {pipelines.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong> {p.available ? '' : `(not available: ${p.reason ?? 'not set up'})`} — {p.summary}
                  <br />
                  <span className="studio-hint">Composition: {p.can.composition}, atmosphere: {p.can.atmosphere}, colour: {p.can.colour}, materials: {p.can.material}, subject: {p.can.subject}, a person's identity: {p.can.identity}. Up to {p.maxReferences} pictures. {p.speed}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
        <label className="studio-field">
          <span>What would you like to create?</span>
          <textarea rows={3} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="A new surreal landscape. The atmosphere of these, the composition of that one, the colours of the amber picture." aria-label="What would you like to create" />
        </label>
        <div className="studio-aspects" role="group" aria-label="Shape">
          {(Object.keys(ASPECTS) as AspectChoice[]).map((a) => (
            <button key={a} type="button" className={aspect === a ? 'is-on' : ''} onClick={() => setAspect(a)} aria-pressed={aspect === a}>
              {ASPECTS[a].label}
            </button>
          ))}
        </div>
        <button type="button" className="button button--gold" onClick={() => void develop()} disabled={!boardId || busy !== null} data-testid="develop-concept">
          <Icon name="sparkle" size={15} /> {busy === 'concept' ? 'Reading the board…' : 'Develop the concept'}
        </button>
        {concept ? (
          <div className="studio-concept" data-testid="concept-notes">
            <p>{concept.summary}</p>
            <ul>
              {concept.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {concept.palette.length ? (
              <div className="studio-palette" aria-label="Palette">
                {concept.palette.map((c) => (
                  <span key={c} style={{ background: c }} title={c} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="studio-col">
        <h3>2 · The prompt</h3>
        <label className="studio-field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" aria-label="Title" />
        </label>
        <label className="studio-field">
          <span>Prompt · review and edit it</span>
          <textarea ref={promptRef} rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Develop the concept, or write your own." aria-label="Prompt" />
        </label>
        <label className="studio-field">
          <span>Avoid</span>
          <input value={negative} onChange={(e) => setNegative(e.target.value)} aria-label="Avoid" />
        </label>
        {concept && concept.variations.length ? (
          <div className="studio-variations">
            <span>Other directions</span>
            {concept.variations.map((v) => (
              <button key={v} type="button" onClick={() => setPrompt(v)} title={v}>
                {v.slice(v.lastIndexOf(', ') + 2)}
              </button>
            ))}
          </div>
        ) : null}
        {parent ? (
          <div className="studio-parent">
            Refining from “{parent.title}” <button type="button" onClick={() => setParent(null)} aria-label="Start fresh instead">✕</button>
            <label className="studio-range">
              <span>How far to move away from it</span>
              <input type="range" min={0.15} max={0.95} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
            </label>
          </div>
        ) : null}

        <h3>3 · How to make it</h3>
        <CapabilityBanner id="create" />
        <MethodPicker settings={settings} methodId={methodId} onMethod={(id) => { setMethodId(id); setModel(''); setAgreed(false) }} model={model} onModel={setModel} estimate={estimate} agreed={agreed} onAgree={setAgreed} edit={false} />
        <label className="studio-range">
          <span>How many pictures: {count}</span>
          <input type="range" min={1} max={4} step={1} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many pictures" />
        </label>
        {busy === 'make' ? (
          <ProgressBar progress={progress} onStop={() => void window.noema.studioStop(jobId)} />
        ) : (
          <button type="button" className="button button--gold studio-make" onClick={() => void make()} disabled={!canMake} data-testid="studio-make">
            <Icon name="image" size={15} /> {parent ? 'Make a refinement' : 'Make the artwork'}
          </button>
        )}
      </div>

      <div className="studio-results" data-testid="studio-results">
        {results.length === 0 ? (
          <p className="studio-hint">Your pictures appear here as soon as they are made, and are saved in your library next to their moodboard.</p>
        ) : (
          results.map(({ record, item }) => (
            <article key={record.id} className="studio-result" data-testid="studio-result">
              {item ? (
                <button type="button" className="studio-result__open" onClick={() => record.imageId && openViewer({ imageId: record.imageId })} title="View large: zoom, pan, compare, enlarge" data-testid="studio-result-open">
                  <img src={item.fullUrl} alt={record.title} />
                </button>
              ) : <div className="studio-result__missing" />}
              <div className="studio-result__bar">
                <strong>{record.title}</strong>
                <small>{record.width}×{record.height} · {record.methodId === 'blend' ? 'Atlas Blend' : record.methodId === 'comfyui' ? 'ComfyUI' : 'OpenAI'}{record.parentId ? ' · refinement' : ''}</small>
                <div className="studio-result__actions">
                  <button type="button" className="button button--ghost" onClick={() => void make({ parent: record, prompt: record.prompt, count: 1 })} disabled={busy !== null || (needsAgreement && !agreed)}>Variation</button>
                  <button type="button" className="button button--ghost" onClick={() => { setParent(record); setPrompt(record.prompt); promptRef.current?.focus() }}>Refine…</button>
                  <button type="button" className="button button--ghost" onClick={() => void addToBoard(record)}>Add to board</button>
                  {record.imageId ? <button type="button" className="button button--ghost" onClick={() => onEdit(record.imageId!)}>Edit…</button> : null}
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  )
}

// ---- edit -----------------------------------------------------------------------------------------------------------

function EditView({ imageId, onRetouch, settings, moodboards, onChanged, onChoose, onOpenImage, initialInstruction, initialStrength, initialLevel, initialRegion, initialReferences }: { imageId: string; onRetouch: () => void; settings: StudioSettings | null; moodboards: Array<{ id: string; name: string; imageCount: number }>; onChanged: () => void; onChoose: () => void; onOpenImage: (imageId: string) => void; initialInstruction?: string; initialStrength?: number; initialLevel?: EditLevel; initialRegion?: EditRegion; initialReferences?: EditReferences }): React.JSX.Element {
  const { toast } = useAtlas()
  const [image, setImage] = useState<ImageItem | null>(null)
  const [loadProblem, setLoadProblem] = useState<string | null>(null)
  const [instruction, setInstruction] = useState(initialInstruction ?? '')
  const [strength, setStrength] = useState(initialStrength ?? (initialLevel ? EDIT_LEVELS[initialLevel].strength : 0.55))
  const [level, setLevel] = useState<EditLevel>(initialLevel ?? 'creative')
  const [region, setRegion] = useState<EditRegion | null>(initialRegion ?? null)
  const [references, setReferences] = useState<EditReferences | null>(initialReferences ?? null)
  const [count, setCount] = useState(1)
  const [versionsKey, setVersionsKey] = useState(0)
  const [methodId, setMethodId] = useState<StudioMethod['id']>('blend')
  const [model, setModel] = useState('')
  const [workflowId, setWorkflowId] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [estimate, setEstimate] = useState<StudioEstimate | null>(null)
  const [busy, setBusy] = useState(false)
  const [alternatives, setAlternatives] = useState<EditAlternative[]>([])
  const [shown, setShown] = useState(0)
  const preview = alternatives[shown] ? { url: alternatives[shown]!.previewUrl, pendingId: alternatives[shown]!.pendingId, summary: alternatives[shown]!.summary } : null
  const setPreview = (value: null): void => { void value; setAlternatives([]); setShown(0) }
  const [saved, setSaved] = useState<ImageItem | null>(null)
  const sessions = useExternalSessions().filter((s) => s.sourceImageId === imageId || s.versions.some((v) => v.imageId === imageId))
  const sessionVersions = sessions.reduce((n, s) => n + s.versions.length, 0)
  // A new version came back from another program: the history strip shows it at once.
  useEffect(() => {
    if (sessionVersions > 0) setVersionsKey((k) => k + 1)
  }, [sessionVersions])
  const { jobId, progress, reset } = useJob()

  useEffect(() => {
    setImage(null)
    setLoadProblem(null)
    void window.noema.getImage(imageId).then((item) => {
      if (!item) setLoadProblem('Atlas cannot find this picture in the library any more. It may have been removed from Atlas.')
      else if (item.missing) setLoadProblem(`The file “${item.filename}” is no longer where Atlas last saw it, so it cannot be edited. Put it back in its folder (or reconnect the drive it was on) and try again.`)
      else setImage(item)
    }).catch(() => setLoadProblem('Atlas could not open this picture. Check that the file still exists and can be read, then try again.'))
    // Another version of the picture: what was previewed or selected belonged to the one before.
    setAlternatives([])
    setShown(0)
    setSaved(null)
    setRegion((r) => (r && r.maskPng ? null : r))
  }, [imageId])
  // Start with the best way that is actually available (a real AI model before plain grading).
  const [autoPicked, setAutoPicked] = useState(false)
  useEffect(() => {
    if (!settings || autoPicked) return
    setAutoPicked(true)
    const comfy = settings.methods.find((m) => m.id === 'comfyui')
    if (comfy?.available && comfy.canEdit) setMethodId('comfyui')
  }, [settings, autoPicked])
  useEffect(() => {
    if (!image) return
    void window.noema.studioEstimate(workflowId ? 'comfyui' : methodId, model || undefined, 1, image.width, image.height).then(setEstimate).catch(() => setEstimate(null))
  }, [methodId, model, image, settings, workflowId])

  const run = async (): Promise<void> => {
    if (!image) return
    setBusy(true)
    setPreview(null)
    setSaved(null)
    const id = reset()
    try {
      const usable = references && references.imageIds.length > 0 ? references : undefined
      const result = await window.noema.studioEdit({ jobId: id, imageId, methodId: workflowId ? 'comfyui' : methodId, model: model || undefined, instruction, strength, level, region: region ?? undefined, references: usable, count, approvedCost: (estimate?.costUsd ?? 0) * count, approvedUpload: agreed, workflowId: workflowId || null })
      if (!result.ok) {
        toast(result.message, 'error')
        return
      }
      setAlternatives(result.alternatives ?? [{ previewUrl: result.previewUrl!, pendingId: result.pendingId!, summary: result.summary ?? '' }])
      setShown(0)
      setAgreed(false)
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const keep = async (): Promise<void> => {
    if (!preview) return
    try {
      const result = await window.noema.studioEditCommit(preview.pendingId)
      if (!result.ok) {
        toast(result.message, 'error')
        return
      }
      const record = result.records[0]!
      setSaved(record.imageId ? await window.noema.getImage(record.imageId).catch(() => null) : null)
      // Keeping one lets go of the other alternatives (they only ever lived in memory); to keep several, run again.
      setAlternatives([])
      setShown(0)
      setVersionsKey((k) => k + 1)
      onChanged()
      toast(result.message, 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  const startExternal = async (editorId: string | null): Promise<void> => {
    try {
      upsertSession(await window.noema.studioExternalStart(imageId, editorId))
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  const needsAgreement = Boolean(estimate?.leavesComputer)
  const ownWorkflows = (settings?.comfy.workflows ?? []).filter((w) => w.runnable && (w.kind === 'edit' || w.kind === 'upscale'))
  const chosenWorkflow = ownWorkflows.find((w) => w.id === workflowId) ?? null
  const canRun = (Boolean(instruction.trim()) || chosenWorkflow?.kind === 'upscale' || Boolean(references?.imageIds.length)) && !busy && (!needsAgreement || (agreed && !estimate?.overBudget))

  return (
    <div className="studio-grid studio-grid--edit">
      <div className="studio-col">
        <CapabilityBanner id="edit" />
        <h3>Original <button type="button" className="studio-link" onClick={onChoose} data-testid="edit-change-picture">Choose another picture</button> <button type="button" className="studio-link" onClick={onRetouch} data-testid="edit-to-retouch">Retouch…</button></h3>
        {loadProblem ? (
          <div className="studio-capability is-missing" role="alert" data-testid="edit-load-problem">
            <Icon name="info" size={14} />
            <div><strong>This picture cannot be edited.</strong> {loadProblem} <button type="button" className="studio-link" onClick={onChoose}>Choose another picture</button></div>
          </div>
        ) : image ? <img className="studio-edit__original" src={image.fullUrl} alt={image.filename} onError={() => setLoadProblem('Atlas cannot read this file right now. It may have been moved, renamed or deleted (put it back, or reconnect its drive), or it may be damaged or in a format Atlas cannot show. Choose another picture, or try “Edit in another program” below.')} /> : <Spinner label="Opening the picture" />}
        <p className="studio-hint">The original file is never changed. Every edit becomes a new version next to it.</p>
        <VersionStrip imageId={imageId} onOpen={onOpenImage} refreshKey={versionsKey} />
        <h3>Edit in another program</h3>
        <p className="studio-hint">Atlas opens a copy. When you save it there, the result comes back here as a new version linked to this picture.</p>
        <div className="studio-external">
          {(settings?.editors ?? []).map((editor) => (
            <button key={editor.id} type="button" className="button button--ghost" onClick={() => void startExternal(editor.id)} data-editor={editor.id}>
              <Icon name="external" size={14} /> Edit in {editor.name}
            </button>
          ))}
          <button type="button" className="button button--ghost" onClick={() => void startExternal(null)} data-editor="default">
            <Icon name="external" size={14} /> Edit in my default program
          </button>
        </div>
        {sessions.map((s2) => <ExternalSessionPanel key={s2.id} session={s2} />)}
      </div>
      <div className="studio-col">
        <h3>Describe the change</h3>
        <label className="studio-field">
          <span>What should change?</span>
          <textarea rows={3} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Make the atmosphere more mysterious, but preserve the architecture and composition." aria-label="What should change" />
        </label>
        <LevelPicker level={level} onLevel={(l) => { setLevel(l); setStrength(EDIT_LEVELS[l].strength) }} />
        <RegionPanel image={image} instruction={instruction} value={region} onChange={setRegion} />
        <ReferencePanel imageId={imageId} moodboards={moodboards} value={references} onChange={setReferences} />
        <label className="studio-range">
          <span>Fine-tune how strongly: {Math.round(strength * 100)}%</span>
          <input type="range" min={0.1} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} aria-label="How strongly" />
        </label>
        <label className="studio-field studio-count">
          <span>Alternatives</span>
          <select value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many alternatives" data-testid="edit-count">
            <option value={1}>One</option>
            <option value={2}>Two, to compare</option>
            <option value={3}>Three, to compare</option>
            <option value={4}>Four, to compare</option>
          </select>
        </label>
        <MethodPicker settings={settings} methodId={methodId} onMethod={(id) => { setMethodId(id); setModel(''); setAgreed(false) }} model={model} onModel={setModel} estimate={estimate} agreed={agreed} onAgree={setAgreed} edit />
        {ownWorkflows.length > 0 ? (
          <label className="studio-field" data-testid="own-workflow">
            <span>Or run one of your own ComfyUI workflows</span>
            <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} aria-label="Your ComfyUI workflow">
              <option value="">No, use the method above</option>
              {ownWorkflows.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.kind === 'upscale' ? 'enlarges' : 'edits'})</option>)}
            </select>
            <small>{chosenWorkflow?.kind === 'upscale' ? 'Your upscaling workflow runs on a copy as it is. Your workflow file and your original are never changed.' : 'The workflow runs on a copy. Your workflow file and your original are never changed.'}</small>
          </label>
        ) : null}
        {busy ? (
          <ProgressBar progress={progress} onStop={() => void window.noema.studioStop(jobId)} />
        ) : (
          <button type="button" className="button button--gold studio-make" onClick={() => void run()} disabled={!canRun} data-testid="edit-preview">
            <Icon name="eye" size={15} /> Show me a preview
          </button>
        )}
      </div>
      <div className="studio-results studio-results--edit">
        {alternatives.length > 1 ? (
          <div className="studio-alts" role="tablist" aria-label="Alternatives" data-testid="edit-alternatives">
            {alternatives.map((a, i) => (
              <button key={a.pendingId} type="button" role="tab" aria-selected={i === shown} className={i === shown ? 'is-on' : ''} onClick={() => setShown(i)}>
                <img src={a.previewUrl} alt={`Alternative ${i + 1}`} draggable={false} />
              </button>
            ))}
          </div>
        ) : null}
        {preview ? (
          <article className="studio-result" data-testid="edit-preview-card">
            <img src={preview.url} alt="Preview of the edit" />
            <div className="studio-result__bar">
              <strong>Preview · not saved yet</strong>
              <small>{preview.summary}</small>
              <div className="studio-result__actions">
                <button type="button" className="button button--gold" onClick={() => void keep()} data-testid="edit-keep">Keep as a new version</button>
                <button type="button" className="button button--ghost" onClick={() => { void window.noema.studioEditDiscard(preview.pendingId); setAlternatives((list) => list.filter((_, i) => i !== shown)); setShown(0) }}>Discard</button>
              </div>
            </div>
          </article>
        ) : saved ? (
          <article className="studio-result" data-testid="edit-saved-card">
            <img src={saved.fullUrl} alt="The saved version" />
            <div className="studio-result__bar">
              <strong>Saved as a new version</strong>
              <small>It is in your library, linked to the original, which is untouched.</small>
              <div className="studio-result__actions">
                <button type="button" className="button button--ghost" onClick={() => saved && onOpenImage(saved.id)} data-testid="edit-continue">Continue editing this version</button>
              </div>
            </div>
          </article>
        ) : (
          <p className="studio-hint">The preview appears here. Nothing is saved until you choose to keep it.</p>
        )}
      </div>
    </div>
  )
}
