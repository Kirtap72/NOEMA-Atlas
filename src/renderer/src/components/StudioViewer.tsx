import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageItem } from '@shared/types'
import type { Capability } from '@shared/ai'
import { openStudio } from './Studio'
import { DETAIL_SUBJECTS, MAX_UPSCALE_EDGE, MAX_UPSCALE_PIXELS, type DetailSubject, type GenerationRecord, type StudioProgress, type StudioSettings } from '@shared/studio'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'
import { clearViewing, setViewing } from '../lib/viewing'

export const OPEN_VIEWER_EVENT = 'atlas:open-viewer'
export interface OpenViewerDetail {
  imageId: string
  /** Open the enlarge panel straight away. */
  panel?: 'upscale'
  /** Longer side to fill in. */
  target?: number
  /** Open in side-by-side compare, against `partnerId` when given, otherwise the picture this one was made from. */
  compare?: boolean
  partnerId?: string
}
export function openViewer(detail: OpenViewerDetail): void {
  window.dispatchEvent(new CustomEvent<OpenViewerDetail>(OPEN_VIEWER_EVENT, { detail }))
}

/** Lives in the app shell: opens the large viewer whenever a picture asks for it. */
export function ViewerHost(): React.JSX.Element | null {
  const [open, setOpen] = useState<{ detail: OpenViewerDetail; nonce: number } | null>(null)
  useEffect(() => {
    const show = (event: Event): void => setOpen((current) => ({ detail: (event as CustomEvent<OpenViewerDetail>).detail, nonce: (current?.nonce ?? 0) + 1 }))
    window.addEventListener(OPEN_VIEWER_EVENT, show)
    return () => window.removeEventListener(OPEN_VIEWER_EVENT, show)
  }, [])
  if (!open) return null
  return <StudioViewer key={open.nonce} detail={open.detail} onClose={() => setOpen(null)} />
}

// ---- the shared view -------------------------------------------------------------------------------------------------

/** Where the viewer looks: a centre in the picture (0 to 1 on each side) and how far in. `fit` means "whole picture". */
interface View {
  cx: number
  cy: number
  zoom: number
  fit: boolean
}
interface Size {
  w: number
  h: number
}
const MAX_ZOOM = 16
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const VERB: Record<string, string> = { generation: 'Made', edit: 'Edited', external: 'Edited elsewhere', upscale: 'Enlarged' }

/**
 * One picture in a pane. Zoom and centre come from the shared view, so two panes always look at the same place.
 * `scale` is how many screen pixels one picture pixel covers.
 */
function Pane({
  item,
  label,
  natural,
  onNatural,
  scale,
  view,
  onZoomAt,
  onPan,
  onToggle,
  pane,
  paneRef
}: {
  item: ImageItem
  label: string
  natural: Size | undefined
  onNatural: (size: Size) => void
  scale: number
  view: View
  onZoomAt: (factor: number, at: { mx: number; my: number; spanW: number; spanH: number; pw: number; ph: number }) => void
  onPan: (cx: number, cy: number) => void
  onToggle: (at: { mx: number; my: number; spanW: number; spanH: number; pw: number; ph: number }) => void
  pane: Size
  paneRef: (el: HTMLDivElement | null) => void
}): React.JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null)
  const w = natural?.w ?? item.width
  const h = natural?.h ?? item.height
  const tx = pane.w / 2 - view.cx * w * scale
  const ty = pane.h / 2 - view.cy * h * scale

  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = el.getBoundingClientRect()
      const factor = Math.exp(-event.deltaY * 0.0018)
      onZoomAt(factor, { mx: event.clientX - rect.left, my: event.clientY - rect.top, spanW: w * scale, spanH: h * scale, pw: rect.width, ph: rect.height })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  return (
    <div
      className="sv-pane"
      ref={(el) => {
        box.current = el
        paneRef(el)
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        onPan(clamp(d.cx - (e.clientX - d.x) / (w * scale), 0, 1), clamp(d.cy - (e.clientY - d.y) / (h * scale), 0, 1))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onDoubleClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onToggle({ mx: e.clientX - rect.left, my: e.clientY - rect.top, spanW: w * scale, spanH: h * scale, pw: rect.width, ph: rect.height })
      }}
      data-testid="sv-pane"
    >
      <img
        src={item.fullUrl}
        alt={item.filename}
        draggable={false}
        onLoad={(e) => onNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        style={{
          width: w,
          height: h,
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          imageRendering: scale > 2 ? 'pixelated' : 'auto',
          visibility: natural ? 'visible' : 'hidden'
        }}
      />
      {!natural ? <div className="sv-loading"><Spinner size={22} label="Opening the picture" /></div> : null}
      <span className="sv-label">{label}</span>
    </div>
  )
}

// ---- the viewer -------------------------------------------------------------------------------------------------------

function StudioViewer({ detail, onClose }: { detail: OpenViewerDetail; onClose: () => void }): React.JSX.Element {
  const { toast, refresh, moodboards } = useAtlas()
  const [boardMenu, setBoardMenu] = useState(false)
  const [items, setItems] = useState<ImageItem[]>([])
  const [records, setRecords] = useState<Record<string, GenerationRecord>>({})
  const [index, setIndex] = useState(0)
  const [partner, setPartner] = useState<ImageItem | null>(null)
  const [compare, setCompare] = useState(false)
  const [framing, setFraming] = useState<'area' | 'pixels'>('area')
  const [view, setView] = useState<View>({ cx: 0.5, cy: 0.5, zoom: 1, fit: true })
  const [natural, setNatural] = useState<Record<string, Size>>({})
  const [sizes, setSizes] = useState<[Size, Size]>([{ w: 800, h: 600 }, { w: 800, h: 600 }])
  const paneEls = useRef<[HTMLDivElement | null, HTMLDivElement | null]>([null, null])
  const [panel, setPanel] = useState(detail.panel === 'upscale')

  const current = items[index]
  const currentRecord = current ? records[current.id] : undefined
  // The Companion can be opened from here and knows which picture this is.
  useEffect(() => {
    if (!current) return
    setViewing({ imageId: current.id, filename: current.filename })
    return () => clearViewing(current.id)
  }, [current?.id, current?.filename])

  // The picture, and everything that belongs with it: its series (variations, edits, enlargements) and its source.
  const load = useCallback(
    async (focusId: string): Promise<void> => {
      const base = await window.noema.getImage(focusId)
      if (!base) return
      const info = await window.noema.studioProvenance(focusId).catch(() => null)
      const recs: Record<string, GenerationRecord> = {}
      let list: ImageItem[] = [base]
      if (info) {
        const ids = info.series.map((r) => r.imageId).filter((id): id is string => Boolean(id))
        const fetched = await Promise.all(ids.map((id) => window.noema.getImage(id).catch(() => null)))
        list = fetched.filter((i): i is ImageItem => Boolean(i))
        for (const r of info.series) if (r.imageId) recs[r.imageId] = r
        if (!list.some((i) => i.id === focusId)) list = [...list, base]
      }
      setRecords(recs)
      setItems(list)
      setIndex(Math.max(0, list.findIndex((i) => i.id === focusId)))
    },
    []
  )
  useEffect(() => {
    void load(detail.imageId)
  }, [detail.imageId, load])

  // The natural partner to compare with: the picture this one was made from.
  const defaultPartner = useCallback(
    async (item: ImageItem, list: ImageItem[], recs: Record<string, GenerationRecord>): Promise<ImageItem | null> => {
      const sourceId = recs[item.id]?.sourceImageIds[0]
      if (sourceId) {
        const found = list.find((i) => i.id === sourceId) ?? (await window.noema.getImage(sourceId).catch(() => null))
        if (found) return found
      }
      return list.find((i) => i.id !== item.id) ?? null
    },
    []
  )

  const measure = useCallback(() => {
    // Layout sizes, not painted ones: the viewer fades in with a small scale, which must not change the fit.
    const a = paneEls.current[0]
    const b = paneEls.current[1]
    setSizes((old) => [a ? { w: a.clientWidth, h: a.clientHeight } : old[0], b ? { w: b.clientWidth, h: b.clientHeight } : old[1]])
  }, [])
  useEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    for (const el of paneEls.current) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [compare, measure, items.length])

  const natOf = (item: ImageItem | null | undefined): Size => (item ? (natural[item.id] ?? { w: item.width || 1, h: item.height || 1 }) : { w: 1, h: 1 })
  const first = current ? natOf(current) : { w: 1, h: 1 }
  const second = partner ? natOf(partner) : first
  // In "same area" framing the larger picture is the reference, and the other is shown covering the same part of the scene.
  const ref = !compare || framing === 'pixels' ? first : first.w >= second.w ? first : second
  const fitZoom = Math.min(sizes[0].w / ref.w, sizes[0].h / ref.h) || 1
  const zoom = view.fit ? fitZoom : view.zoom
  const scaleFor = (size: Size): number => (compare && framing === 'area' ? (zoom * ref.w) / size.w : zoom)
  const percent = Math.round(zoom * 100)

  type At = { mx: number; my: number; spanW: number; spanH: number; pw: number; ph: number }
  const zoomAt = (factor: number, at: At): void =>
    setView((old) => {
      const base = old.fit ? fitZoom : old.zoom
      const next = clamp(base * factor, 0.02, MAX_ZOOM)
      const k = next / base
      // Keep the point under the pointer where it is while zooming.
      return { fit: false, zoom: next, cx: clamp(old.cx + ((at.mx - at.pw / 2) / at.spanW) * (1 - 1 / k), 0, 1), cy: clamp(old.cy + ((at.my - at.ph / 2) / at.spanH) * (1 - 1 / k), 0, 1) }
    })
  const panTo = (cx: number, cy: number): void => setView((old) => ({ ...old, zoom: old.fit ? fitZoom : old.zoom, fit: false, cx, cy }))
  const toggleAt = (at: At): void =>
    setView((old) => {
      if (!old.fit) return { cx: 0.5, cy: 0.5, zoom: 1, fit: true }
      // From "fit" straight to 100% on the spot that was double-clicked.
      return { fit: false, zoom: 1, cx: clamp(old.cx + (at.mx - at.pw / 2) / at.spanW, 0, 1), cy: clamp(old.cy + (at.my - at.ph / 2) / at.spanH, 0, 1) }
    })

  const fit = (): void => setView({ cx: 0.5, cy: 0.5, zoom: 1, fit: true })
  const actual = (): void => setView((v) => ({ ...v, zoom: 1, fit: false }))
  const go = useCallback(
    (step: number): void => {
      setIndex((i) => clamp(i + step, 0, Math.max(0, items.length - 1)))
      fit()
    },
    [items.length]
  )

  const startCompare = useCallback(
    async (on: boolean): Promise<void> => {
      if (!on) {
        setCompare(false)
        return
      }
      if (!current) return
      const found = partner && partner.id !== current.id ? partner : await defaultPartner(current, items, records)
      if (!found) {
        toast('There is nothing to compare with yet. Make a variation or enlarge this picture first.', 'info')
        return
      }
      setPartner(found)
      setCompare(true)
      fit()
    },
    [current, defaultPartner, items, partner, records, toast]
  )

  // Asked to open in compare mode (for example from an edit that came back from another program).
  const wantsCompare = useRef(Boolean(detail.compare))
  useEffect(() => {
    if (!wantsCompare.current || !current) return
    wantsCompare.current = false
    void (async () => {
      const chosen = detail.partnerId && detail.partnerId !== current.id ? await window.noema.getImage(detail.partnerId).catch(() => null) : null
      if (chosen) {
        setPartner(chosen)
        setCompare(true)
        fit()
      } else {
        await startCompare(true)
      }
    })()
  }, [current, detail.partnerId, startCompare])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) {
        if (event.key === 'Escape') target.blur()
        return
      }
      const handled = ['Escape', 'ArrowLeft', 'ArrowRight', 'f', 'F', '1', '0', '+', '=', '-', 'c', 'C']
      if (!handled.includes(event.key)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') go(-1)
      else if (event.key === 'ArrowRight') go(1)
      else if (event.key === 'f' || event.key === 'F' || event.key === '0') fit()
      else if (event.key === '1') actual()
      else if (event.key === 'c' || event.key === 'C') void startCompare(!compare)
      else setView((v) => ({ ...v, fit: false, zoom: clamp((v.fit ? fitZoom : v.zoom) * (event.key === '-' ? 1 / 1.25 : 1.25), 0.02, MAX_ZOOM) }))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [compare, fitZoom, go, onClose, startCompare])

  const addToBoard = async (boardId: string, name: string): Promise<void> => {
    if (!current) return
    setBoardMenu(false)
    try {
      await window.noema.addToMoodboard({ moodboardId: boardId, imageIds: [current.id] })
      await refresh()
      toast(`Added to “${name}”. It is already in your library.`, 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  const labelFor = (item: ImageItem): string => {
    const record = records[item.id]
    const n = natOf(item)
    const name = record ? `${VERB[record.kind] ?? 'Version'}${record.kind === 'upscale' && record.model ? ` · ${record.model}` : ''}` : 'Original'
    return `${name} · ${n.w}×${n.h}`
  }

  const upscaled = useCallback(
    async (imageId: string): Promise<void> => {
      await refresh()
      const record = await window.noema.studioProvenance(imageId)
      await load(imageId)
      const source = record?.record.sourceImageIds[0]
      const original = source ? await window.noema.getImage(source).catch(() => null) : null
      if (original) {
        setPartner(original)
        setCompare(true)
        fit()
      }
      setPanel(false)
    },
    [load, refresh]
  )

  return createPortal(
    <div className="sv" role="dialog" aria-modal="true" aria-label="Picture viewer" data-testid="studio-viewer">
      <header className="sv__top">
        <button type="button" className="sv__close" onClick={onClose} aria-label="Close the viewer">
          <Icon name="arrowLeft" size={17} /> <span>Back</span> <kbd>Esc</kbd>
        </button>
        <div className="sv__title">
          <strong>{current ? (currentRecord?.title || current.filename) : 'Opening…'}</strong>
          <small data-testid="sv-info">
            {current ? `${labelFor(current)}${items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}` : ''}
          </small>
        </div>
        <div className="sv__tools">
          <span className="sv__zoom" data-testid="sv-zoom">{percent}%</span>
          <button type="button" className={view.fit ? 'is-on' : ''} onClick={fit} title="Fit the whole picture (F)" data-testid="sv-fit">Fit</button>
          <button type="button" className={!view.fit && Math.abs(zoom - 1) < 0.005 ? 'is-on' : ''} onClick={actual} title="Actual pixels, 100% (1)" data-testid="sv-actual">100%</button>
          <button type="button" className={compare ? 'is-on' : ''} onClick={() => void startCompare(!compare)} title="Compare side by side (C)" data-testid="sv-compare">Compare</button>
          <button type="button" className={panel ? 'is-on' : ''} onClick={() => setPanel((p) => !p)} title="Make a larger copy" data-testid="sv-upscale">
            <Icon name="resize" size={14} /> Upscale
          </button>
          <button type="button" onClick={() => { if (current) { openStudio({ mode: 'edit', imageId: current.id }); onClose() } }} title="Change this picture in a new version" data-testid="sv-edit">
            <Icon name="edit" size={14} /> Edit
          </button>
          <button type="button" onClick={() => { if (current) { openStudio({ mode: 'retouch', imageId: current.id }); onClose() } }} title="Paint over something to remove it, or to soften part of the picture" data-testid="sv-retouch">
            <Icon name="sparkle" size={14} /> Retouch
          </button>
          <div className="sv__board">
            <button type="button" className={boardMenu ? 'is-on' : ''} onClick={() => setBoardMenu((v) => !v)} title="Add this picture to a moodboard" data-testid="sv-board">
              <Icon name="boards" size={14} /> Moodboard
            </button>
            {boardMenu ? (
              <div className="sv__board-menu" role="menu" data-testid="sv-board-menu">
                {moodboards.length === 0 ? <small>No moodboards yet.</small> : moodboards.map((b) => (
                  <button key={b.id} type="button" role="menuitem" onClick={() => void addToBoard(b.id, b.name)}>{b.name}</button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="sv__stage">
        <button type="button" className="sv__nav sv__nav--prev" onClick={() => go(-1)} disabled={index <= 0} aria-label="Previous variation">
          <Icon name="chevronLeft" size={22} />
        </button>
        <div className={`sv__panes${compare ? ' is-compare' : ''}`}>
          {current ? (
            <Pane
              item={current}
              label={labelFor(current)}
              natural={natural[current.id]}
              onNatural={(s) => setNatural((n) => (n[current.id]?.w === s.w ? n : { ...n, [current.id]: s }))}
              scale={scaleFor(first)}
              view={view}
              onZoomAt={zoomAt}
              onPan={panTo}
              onToggle={toggleAt}
              pane={sizes[0]}
              paneRef={(el) => {
                paneEls.current[0] = el
              }}
            />
          ) : null}
          {compare && partner ? (
            <Pane
              item={partner}
              label={labelFor(partner)}
              natural={natural[partner.id]}
              onNatural={(s) => setNatural((n) => (n[partner.id]?.w === s.w ? n : { ...n, [partner.id]: s }))}
              scale={scaleFor(second)}
              view={view}
              onZoomAt={zoomAt}
              onPan={panTo}
              onToggle={toggleAt}
              pane={sizes[1]}
              paneRef={(el) => {
                paneEls.current[1] = el
              }}
            />
          ) : null}
        </div>
        <button type="button" className="sv__nav sv__nav--next" onClick={() => go(1)} disabled={index >= items.length - 1} aria-label="Next variation">
          <Icon name="chevronRight" size={22} />
        </button>

        {panel && current ? <UpscalePanel onOpenSettings={() => { openStudio({ mode: 'create' }); onClose() }} initialTarget={detail.target} image={current} natural={natOf(current)} onDone={(id) => void upscaled(id)} onClose={() => setPanel(false)} /> : null}
      </div>

      <footer className="sv__bottom">
        {compare ? (
          <div className="sv__compare-bar" data-testid="sv-compare-bar">
            <span>Compare with</span>
            <select
              value={partner?.id ?? ''}
              onChange={(e) => {
                const next = items.find((i) => i.id === e.target.value)
                if (next) {
                  setPartner(next)
                  fit()
                }
              }}
              aria-label="Compare with"
            >
              {items.filter((i) => i.id !== current?.id).map((i) => (
                <option key={i.id} value={i.id}>{labelFor(i)}</option>
              ))}
              {partner && !items.some((i) => i.id === partner.id) ? <option value={partner.id}>{labelFor(partner)}</option> : null}
            </select>
            <div className="sv__seg" role="group" aria-label="How to line them up">
              <button type="button" className={framing === 'area' ? 'is-on' : ''} onClick={() => { setFraming('area'); fit() }} title="Both show the same part of the scene, so the larger one has more pixels to show" data-testid="sv-area">Same area</button>
              <button type="button" className={framing === 'pixels' ? 'is-on' : ''} onClick={() => { setFraming('pixels'); fit() }} title="Both at the same pixel size, so the larger one shows more of the scene" data-testid="sv-pixels">Actual pixels</button>
            </div>
            <small>Zoom and drag move both pictures together.</small>
          </div>
        ) : null}
        {items.length > 1 ? (
          <div className="sv__strip" aria-label="Variations">
            {items.map((item, i) => (
              <button key={item.id} type="button" className={i === index ? 'is-on' : ''} onClick={() => { setIndex(i); fit() }} title={records[item.id]?.title ?? item.filename} data-testid="sv-thumb">
                <img src={item.thumbUrl} alt="" draggable={false} />
                {records[item.id] ? <em>{VERB[records[item.id]!.kind] ?? ''}</em> : null}
              </button>
            ))}
          </div>
        ) : null}
      </footer>
    </div>,
    document.body
  )
}

// ---- upscale ----------------------------------------------------------------------------------------------------------

function UpscalePanel({ image, natural, onDone, onClose, initialTarget, onOpenSettings }: { image: ImageItem; natural: Size; onDone: (imageId: string) => void; onClose: () => void; initialTarget?: number; onOpenSettings: () => void }): React.JSX.Element {
  const { toast } = useAtlas()
  const [settings, setSettings] = useState<StudioSettings | null>(null)
  const [choice, setChoice] = useState('')
  const [edge, setEdge] = useState(initialTarget ? String(initialTarget) : '')
  const [busy, setBusy] = useState(false)
  const [subject, setSubject] = useState<DetailSubject | ''>('')
  const [progress, setProgress] = useState<StudioProgress | null>(null)
  const jobRef = useRef('')

  useEffect(() => {
    void window.noema.studioSettings().then(setSettings).catch(() => setSettings(null))
  }, [])
  useEffect(() => window.noema.onStudioProgress((p) => p.jobId === jobRef.current && setProgress(p)), [])

  const [caps, setCaps] = useState<Capability | null>(null)
  useEffect(() => {
    void window.noema.aiCapabilities().then((all) => setCaps(all.find((c) => c.id === 'upscale') ?? null)).catch(() => setCaps(null))
  }, [])
  const presets = useMemo(() => (settings?.comfy.workflows ?? []).filter((w) => w.kind === 'upscale'), [settings])
  // The ways that really add detail, most specific first: the user's own presets, then Atlas's own detail upscaling.
  const ways = useMemo(() => (caps?.options ?? []).filter((o) => o.kind !== 'offline'), [caps])
  const ready = presets.filter((w) => w.runnable)
  const atlasDetail = ways.find((o) => o.id === 'atlas:detail') ?? null
  const [chosenAuto, setChosenAuto] = useState(false)
  useEffect(() => {
    if (chosenAuto || !settings || !caps) return
    setChosenAuto(true)
    setChoice(ready[0]?.id ?? (atlasDetail ? 'atlas:detail' : ''))
  }, [chosenAuto, settings, caps, ready, atlasDetail])

  const longEdge = Math.max(natural.w, natural.h)
  const target = Math.round(Number(edge) || 0)
  const outW = target ? Math.round((natural.w * target) / longEdge) : 0
  const outH = target ? Math.round((natural.h * target) / longEdge) : 0
  const tooBig = target > MAX_UPSCALE_EDGE || outW * outH > MAX_UPSCALE_PIXELS
  const chips = [2, 3, 4].map((f) => ({ f, edge: Math.round(longEdge * f) })).filter((c) => c.edge <= MAX_UPSCALE_EDGE)
  const chosen = ready.find((w) => w.id === choice) ?? null
  const atlasChosen = choice === 'atlas:detail' && Boolean(atlasDetail)

  const run = async (): Promise<void> => {
    setBusy(true)
    setProgress(null)
    const jobId = `up-${Date.now().toString(36)}`
    jobRef.current = jobId
    try {
      const result = await window.noema.studioUpscale({ jobId, imageId: image.id, workflowId: atlasChosen ? 'atlas:detail' : (chosen?.id ?? null), targetLongEdge: target, subject: atlasChosen && subject ? subject : undefined })
      if (!result.ok) {
        toast(result.message, 'error')
        return
      }
      toast(result.message, 'success')
      if (result.records[0]?.imageId) onDone(result.records[0].imageId)
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="sv-up" data-testid="upscale-panel" aria-label="Make a larger copy">
      <header>
        <h3>Make a larger copy</h3>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close this panel" disabled={busy}><Icon name="close" size={15} /></button>
      </header>
      <p className="sv-up__hint">Saved as a new version linked to this picture. The original is never changed.</p>
      {caps && !caps.ready ? (
        <p className="sv-up__missing" data-testid="upscale-missing">
          {caps.missing} <button type="button" className="studio-link" onClick={onOpenSettings}>Open the Studio settings</button>
        </p>
      ) : null}
      <label className="sv-up__field">
        <span>How</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy} aria-label="Preset">
          {ready.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
          {atlasDetail ? <option value="atlas:detail">Atlas detail upscale</option> : null}
          <option value="">Plain enlarge (no new detail)</option>
        </select>
      </label>
      <p className="sv-up__hint" data-testid="upscale-how">
        {atlasChosen
          ? `Atlas’s own detail upscaling: Real-ESRGAN enlarges, then a gentle detail pass keeps the structure. Detail passes run up to ${2048}px on the longer side; larger sizes are enlarged only.`
          : chosen
          ? `A ComfyUI preset adds detail. It runs as tuned, apart from its scale step, which is set from the size below. Large pictures can take many minutes; Atlas starts ComfyUI if it is not running.`
          : ready.length === 0 && !atlasDetail && presets.length > 0
            ? 'No ComfyUI preset is ready yet, so this is a plain enlargement. Smooth resampling, no new detail.'
            : presets.length === 0
              ? 'Plain enlargement by smooth resampling, with no new detail. Choose your ComfyUI folder in the Studio settings to use detail-adding presets such as Clarity.'
              : 'Plain enlargement by smooth resampling, with no new detail.'}
      </p>
      {atlasChosen ? (
        <label className="sv-up__field" data-testid="upscale-subject">
          <span>What is in it</span>
          <select value={subject} onChange={(e) => setSubject(e.target.value as DetailSubject | '')} disabled={busy} aria-label="What the picture shows">
            <option value="">Let Atlas decide from the picture's history</option>
            {(Object.keys(DETAIL_SUBJECTS) as DetailSubject[]).map((id) => <option key={id} value={id}>{DETAIL_SUBJECTS[id].label} · {DETAIL_SUBJECTS[id].note}</option>)}
          </select>
        </label>
      ) : null}
      <div className="sv-up__field">
        <span>Size · longer side</span>
        <div className="sv-up__chips">
          {chips.map((c) => (
            <button key={c.f} type="button" className={Number(edge) === c.edge ? 'is-on' : ''} onClick={() => setEdge(String(c.edge))} disabled={busy} data-factor={c.f}>
              {c.f}× <small>{c.edge}px</small>
            </button>
          ))}
        </div>
        <input type="number" min={256} max={MAX_UPSCALE_EDGE} value={edge} onChange={(e) => setEdge(e.target.value)} placeholder="or type pixels" disabled={busy} aria-label="Longer side in pixels" />
      </div>
      <p className={`sv-up__result${tooBig ? ' is-bad' : ''}`} data-testid="upscale-result-size">
        {target ? (tooBig ? 'That is larger than this computer can hold in one picture.' : `${natural.w}×${natural.h} → ${outW}×${outH} (${((outW * outH) / 1e6).toFixed(1)} megapixels)`) : `Now ${natural.w}×${natural.h}. Choose a size.`}
      </p>
      {busy ? (
        <div className="sv-up__progress" role="status" aria-live="polite">
          <div className="studio-progress__bar is-indeterminate"><span /></div>
          <p>{progress?.message ?? 'Getting ready…'}</p>
          <button type="button" className="button button--ghost" onClick={() => void window.noema.studioStop(jobRef.current)}><Icon name="stop" size={13} /> Stop</button>
        </div>
      ) : (
        <button type="button" className="button button--gold" onClick={() => void run()} disabled={!target || target < 256 || tooBig} data-testid="upscale-go">
          <Icon name="resize" size={15} /> Make the larger copy
        </button>
      )}
    </aside>
  )
}
