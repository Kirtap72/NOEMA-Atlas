import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageItem } from '@shared/types'
import { RETOUCH_TOOLS, type EditRegion, type RegionName, type RetouchTool, type StudioEstimate, type StudioProgress, type StudioSettings } from '@shared/studio'
import { REGION_LABELS } from '@shared/regionWords'
import { Icon } from './Icon'
import { VersionStrip } from './StudioEditTools'
import { Spinner } from './ui'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'
import { clearViewing, setViewing } from '../lib/viewing'

// The Retouch workspace: five small tools (Remove, Heal, Blur, Sharpen, Dodge & Burn) that all work the same way. Paint
// over the part, see the result at once, compare it with the original, undo or redo strokes, and keep it as a new
// version. The original is never changed. Strokes are kept as lines, not pixels, so undo is exact and the mask sent to
// the tools has the picture's own resolution (up to 3000 px on the long side).

export interface RetouchInitial {
  tool?: RetouchTool
  region?: EditRegion
  strength?: number
  edgeAware?: boolean
  tone?: 'lighten' | 'darken'
  hint?: string
}

const NAMED: RegionName[] = ['sky', 'background', 'foreground', 'top', 'bottom', 'left', 'right', 'center']
const SCREEN_LONG = 1280
const EXPORT_LONG = 3000
const TOOL_ORDER: RetouchTool[] = ['remove', 'heal', 'blur', 'sharpen', 'tone']
const DEFAULT_STRENGTH: Record<RetouchTool, number> = { remove: 0.4, heal: 0.6, blur: 0.5, sharpen: 0.45, tone: 0.4 }
/** Tools that are quick and local: they follow the brush by themselves. Remove waits for its button (a model can take a while). */
const LIVE: Record<RetouchTool, boolean> = { remove: false, heal: true, blur: true, sharpen: true, tone: true }

type Brush = 'paint' | 'erase' | 'move'
interface Point { x: number; y: number }
interface Stroke { kind: 'paint' | 'erase' | 'clear'; size: number; pts: Point[] }

/** Everything that shaped one finished step. A finished step is never recomputed, so none of this can change it afterwards. */
interface StepSettings { tool: RetouchTool; strength: number; edgeAware: boolean; tone: 'lighten' | 'darken'; softness: number; brushSize: number; method: 'local' | 'comfyui' | 'openai'; hint: string }
/** The result shown for the step being worked on, and what it was made from. */
interface Preview { url: string; pendingId: string; summary: string; edit: number; base: string | undefined; settings: StepSettings; strokes: Stroke[] }
/** A finished step: its own mask (the strokes), its own settings, and its own result held by Atlas. */
interface Step { id: string; label: string; settings: StepSettings; strokes: Stroke[]; pendingId: string; url: string; summary: string }

const MAX_STEPS = 16

function pct(v: number): string {
  const p = v * 100
  return `${p < 10 && Math.abs(p - Math.round(p)) > 0.04 ? p.toFixed(1) : Math.round(p)}%`
}

function stepLabel(s: StepSettings): string {
  switch (s.tool) {
    case 'remove': return 'Remove'
    case 'heal': return `Heal · texture ${pct(s.strength)}`
    case 'blur': return `Blur ${pct(s.strength)}${s.edgeAware ? ' · edges kept' : ''}`
    case 'sharpen': return `Sharpen ${pct(s.strength)}`
    default: return `${s.tone === 'lighten' ? 'Dodge' : 'Burn'} ${pct(s.strength)}`
  }
}

/** Draws strokes onto a canvas: white (or red tint) for paint, black (or cleared tint) for erase. */
function drawStrokes(canvas: HTMLCanvasElement, strokes: Stroke[], long: number, mode: 'mask' | 'tint'): void {
  const c = canvas.getContext('2d')!
  const reset = (): void => {
    c.globalCompositeOperation = 'source-over'
    if (mode === 'mask') { c.fillStyle = '#000'; c.fillRect(0, 0, canvas.width, canvas.height) } else c.clearRect(0, 0, canvas.width, canvas.height)
  }
  reset()
  const scale = Math.max(canvas.width, canvas.height)
  for (const s of strokes) {
    if (s.kind === 'clear') { reset(); continue }
    c.save()
    const erasing = s.kind === 'erase'
    if (mode === 'mask') { c.strokeStyle = erasing ? '#000' : '#fff'; c.fillStyle = c.strokeStyle } else { c.strokeStyle = 'rgba(235, 70, 90, 0.55)'; c.fillStyle = c.strokeStyle; if (erasing) c.globalCompositeOperation = 'destination-out' }
    c.lineCap = 'round'
    c.lineJoin = 'round'
    const diameter = (s.size / long) * scale
    c.lineWidth = diameter
    const first = s.pts[0]
    if (!first) { c.restore(); continue }
    c.beginPath()
    c.arc(first.x * canvas.width, first.y * canvas.height, diameter / 2, 0, Math.PI * 2)
    c.fill()
    c.beginPath()
    c.moveTo(first.x * canvas.width, first.y * canvas.height)
    for (const p of s.pts.slice(1)) c.lineTo(p.x * canvas.width, p.y * canvas.height)
    c.stroke()
    c.restore()
  }
}

export function RetouchView({
  imageId,
  settings,
  onChanged,
  onChoose,
  onOpenImage,
  initial
}: {
  imageId: string
  settings: StudioSettings | null
  onChanged: () => void
  onChoose: () => void
  onOpenImage: (imageId: string) => void
  initial?: RetouchInitial
}): React.JSX.Element {
  const { toast } = useAtlas()
  const [image, setImage] = useState<ImageItem | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [tool, setTool] = useState<RetouchTool>(initial?.tool ?? 'remove')
  const [brushMode, setBrushMode] = useState<Brush>('paint')
  const [brushSize, setBrushSize] = useState(0)
  const [softness, setSoftness] = useState(0.35)
  const [strengths, setStrengths] = useState<Record<RetouchTool, number>>({ ...DEFAULT_STRENGTH, ...(initial?.tool && initial.strength !== undefined ? { [initial.tool]: initial.strength } : {}) })
  const [edgeAware, setEdgeAware] = useState(initial?.edgeAware ?? false)
  const [toneDir, setToneDir] = useState<'lighten' | 'darken'>(initial?.tone ?? 'lighten')
  const [named, setNamed] = useState<RegionName | null>(initial?.region?.named ?? null)
  const [hint, setHint] = useState(initial?.hint ?? '')
  const [seedLocal, setSeedLocal] = useState(true)
  const [method, setMethod] = useState<'local' | 'comfyui' | 'openai'>('local')
  const [agreed, setAgreed] = useState(false)
  const [estimate, setEstimate] = useState<StudioEstimate | null>(null)
  const [painted, setPainted] = useState(false)
  const [strokeCount, setStrokeCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  // Counts every change of the marking (stroke, undo, redo, clear), so nothing is ever mistaken for an earlier state.
  const [edit, setEdit] = useState(0)
  const editRef = useRef(0)
  const bump = (): void => { editRef.current += 1; setEdit(editRef.current) }
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<StudioProgress | null>(null)
  const [result, setResultState] = useState<Preview | null>(null)
  const resultRef = useRef<Preview | null>(null)
  // The finished steps, oldest first, and the ones undone (so Redo can bring them back exactly).
  const [steps, setStepsState] = useState<Step[]>([])
  const stepsRef = useRef<Step[]>([])
  const [undone, setUndoneState] = useState<Step[]>([])
  const undoneRef = useRef<Step[]>([])
  const busyRef = useRef(false)
  const timerPending = useRef(false)
  const setSteps = (next: Step[]): void => { stepsRef.current = next; setStepsState(next) }
  const setUndone = (next: Step[]): void => { undoneRef.current = next; setUndoneState(next) }
  const [split, setSplit] = useState(0)
  const [holdOriginal, setHoldOriginal] = useState(false)
  const [showMask, setShowMask] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [versionsKey, setVersionsKey] = useState(0)
  const [cursor, setCursor] = useState<{ x: number; y: number; r: number } | null>(null)
  const [vp, setVp] = useState({ w: 0, h: 0 })
  const [full, setFull] = useState(false)
  const [controlsOpen, setControlsOpen] = useState(true)
  const root = useRef<HTMLDivElement | null>(null)
  const lastFit = useRef(0)

  const viewport = useRef<HTMLDivElement | null>(null)
  const inner = useRef<HTMLDivElement | null>(null)
  const tint = useRef<HTMLCanvasElement | null>(null)
  const mask = useRef<HTMLCanvasElement | null>(null)
  const strokes = useRef<Stroke[]>([])
  const redo = useRef<Stroke[]>([])
  const current = useRef<Stroke | null>(null)
  const panning = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const spaceDown = useRef(false)
  const jobRef = useRef('')
  const seq = useRef(0)
  const timer = useRef<number | undefined>(undefined)

  const strength = strengths[tool]
  const setStrength = (v: number): void => setStrengths((s) => ({ ...s, [tool]: v }))

  /** Shows a new preview for the step being worked on; the preview it replaces is let go of in Atlas. */
  const putResult = (next: Preview | null, keepPrevious = false): void => {
    const prev = resultRef.current
    resultRef.current = next
    setResultState(next)
    if (prev && !keepPrevious && prev.pendingId !== next?.pendingId) void window.noema.studioRetouchHold([], [prev.pendingId]).catch(() => undefined)
  }
  const dropResult = (): void => putResult(null)
  const releaseEverything = (): void => {
    const ids = [...stepsRef.current, ...undoneRef.current].map((s) => s.pendingId)
    if (resultRef.current) ids.push(resultRef.current.pendingId)
    if (ids.length) void window.noema.studioRetouchHold([], ids).catch(() => undefined)
  }
  const long = image ? Math.max(image.width, image.height) : 1000
  const comfy = settings?.methods.find((m) => m.id === 'comfyui')
  const cloud = settings?.methods.find((m) => m.id === 'openai')
  const comfyOk = Boolean(comfy?.available && comfy.canEdit)
  const cloudOk = Boolean(cloud?.available && cloud.canEdit)

  // ---- the picture -------------------------------------------------------------------------------------------------
  useEffect(() => {
    setImage(null)
    setProblem(null)
    releaseEverything()
    resultRef.current = null
    setResultState(null)
    setSteps([])
    setUndone([])
    setPainted(false)
    strokes.current = []
    redo.current = []
    setStrokeCount(0)
    setRedoCount(0)
    editRef.current += 1
    setEdit(editRef.current)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setSplit(0)
    void window.noema.getImage(imageId).then((item) => {
      if (!item) setProblem('Atlas cannot find this picture in the library any more. It may have been removed from Atlas.')
      else if (item.missing) setProblem(`The file “${item.filename}” is no longer where Atlas last saw it, so it cannot be retouched. Put it back in its folder (or reconnect the drive it was on) and try again.`)
      else {
        setImage(item)
        setBrushSize(Math.max(8, Math.round(Math.max(item.width, item.height) / 28)))
      }
    }).catch(() => setProblem('Atlas could not open this picture. Check that the file still exists and can be read, then try again.'))
  }, [imageId])

  useEffect(() => window.noema.onStudioProgress((p) => p.jobId === jobRef.current && setProgress(p)), [])
  // The Companion knows which picture is open in the workspace.
  useEffect(() => {
    if (!image) return
    setViewing({ imageId: image.id, filename: image.filename })
    return () => clearViewing(image.id)
  }, [image?.id, image?.filename])
  // Leaving the workspace lets go of everything held in memory for it.
  useEffect(() => () => releaseEverything(), [])

  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const measure = (): void => setVp({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [image, problem])
  const fit = image && vp.w > 0 ? Math.min((vp.w - 4) / image.width, (vp.h - 4) / image.height) : 0
  // When the workspace changes size (full screen), the picture keeps its zoom and the same part stays in view: the pan scales with it.
  useEffect(() => {
    if (fit > 0 && lastFit.current > 0 && Math.abs(fit - lastFit.current) > 1e-6) {
      const k = fit / lastFit.current
      setPan((p) => ({ x: p.x * k, y: p.y * k }))
    }
    if (fit > 0) lastFit.current = fit
  }, [fit])
  const stageW = image ? Math.max(1, Math.floor(image.width * fit)) : 0
  const stageH = image ? Math.max(1, Math.floor(image.height * fit)) : 0

  const screenSize = useCallback((): { w: number; h: number } => {
    if (!image) return { w: 16, h: 16 }
    const scale = Math.min(1, SCREEN_LONG / Math.max(image.width, image.height))
    return { w: Math.max(1, Math.round(image.width * scale)), h: Math.max(1, Math.round(image.height * scale)) }
  }, [image])

  useEffect(() => {
    if (!image) return
    const { w, h } = screenSize()
    const m = document.createElement('canvas')
    m.width = w
    m.height = h
    mask.current = m
    drawStrokes(m, [], long, 'mask')
    if (tint.current) { tint.current.width = w; tint.current.height = h; drawStrokes(tint.current, [], long, 'tint') }
  }, [image, screenSize, long])

  useEffect(() => {
    if (!image || !cloudOk || method !== 'openai' || tool !== 'remove') { setEstimate(null); return }
    void window.noema.studioEstimate('openai', undefined, 1, image.width, image.height).then(setEstimate).catch(() => setEstimate(null))
  }, [image, method, cloudOk, tool])

  // ---- what to work on -----------------------------------------------------------------------------------------------
  const exportCache = useRef<{ key: number; url: string } | null>(null)
  const maskForExport = (): string => {
    const key = editRef.current
    if (exportCache.current?.key === key) return exportCache.current.url
    const scale = Math.min(1, EXPORT_LONG / long)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round((image?.width ?? 1) * scale))
    c.height = Math.max(1, Math.round((image?.height ?? 1) * scale))
    drawStrokes(c, strokes.current, long, 'mask')
    const url = c.toDataURL('image/png')
    exportCache.current = { key, url }
    return url
  }

  const regionNow = useCallback((): EditRegion | null => {
    const feather = Math.round(softness * long * (tool === 'tone' || tool === 'sharpen' ? 0.045 : 0.03))
    if (painted) return { maskPng: maskForExport(), feather }
    if (named) return { named, feather }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [painted, named, softness, long, tool, edit, image])

  const run = useCallback(
    async (kind: 'live' | 'press'): Promise<void> => {
      const region = regionNow()
      if (!region || !image) return
      const mine = ++seq.current
      const id = `rt-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
      jobRef.current = id
      busyRef.current = true
      setBusy(true)
      setProgress(null)
      // What this result is made from: the marking and settings as they are right now, on top of the last finished step.
      const stamp = editRef.current
      const base = stepsRef.current[stepsRef.current.length - 1]?.pendingId
      const used: StepSettings = { tool, strength, edgeAware: tool === 'blur' ? edgeAware : false, tone: toneDir, softness, brushSize, method, hint: hint.trim() }
      const marking = strokes.current.map((s) => ({ ...s, pts: [...s.pts] }))
      try {
        const out = await window.noema.studioRetouch({
          jobId: id,
          imageId,
          baseId: base,
          tool,
          region,
          strength,
          edgeAware: tool === 'blur' ? edgeAware : undefined,
          tone: tool === 'tone' ? toneDir : undefined,
          method: tool === 'remove' ? method : undefined,
          hint: tool === 'remove' && hint.trim() ? hint.trim() : undefined,
          seedLocal: tool === 'remove' && method === 'comfyui' ? seedLocal : undefined,
          approvedUpload: tool === 'remove' && method === 'openai' ? agreed : undefined,
          approvedCost: tool === 'remove' && method === 'openai' ? (estimate?.costUsd ?? 0) : undefined,
          previewEdge: Math.min(long, 3600)
        })
        if (mine !== seq.current) return
        if (!out.ok) {
          if (kind === 'press' || out.message !== 'Stopped.') toast(out.message, 'error')
          return
        }
        putResult({ url: out.previewUrl!, pendingId: out.pendingId!, summary: out.summary ?? '', edit: stamp, base, settings: used, strokes: marking })
      } catch (error) {
        if (mine === seq.current) toast(friendlyError(error), 'error')
      } finally {
        if (mine === seq.current) {
          busyRef.current = false
          setBusy(false)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regionNow, image, imageId, tool, strength, edgeAware, toneDir, method, hint, seedLocal, agreed, estimate, long, toast, softness, brushSize]
  )

  // The quick local tools follow the brush and the sliders by themselves.
  useEffect(() => {
    if (!LIVE[tool] || !(painted || named)) return
    window.clearTimeout(timer.current)
    timerPending.current = true
    timer.current = window.setTimeout(() => {
      timerPending.current = false
      void run('live')
    }, 260)
    return () => {
      window.clearTimeout(timer.current)
      timerPending.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, painted, named, strength, edgeAware, toneDir, softness, edit, image, steps])

  const stop = (): void => {
    seq.current += 1
    void window.noema.studioStop(jobRef.current)
    busyRef.current = false
    setBusy(false)
  }

  /** Waits until nothing is being computed or about to be, so a step is finished from a settled result. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 1200 && (busyRef.current || timerPending.current); i += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  }

  // ---- painting ----------------------------------------------------------------------------------------------------
  const fractionOf = (event: { clientX: number; clientY: number }): Point => {
    const rect = inner.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }

  const refreshPainted = (): void => {
    const m = mask.current
    if (!m) return
    const d = m.getContext('2d')!.getImageData(0, 0, m.width, m.height).data
    let any = false
    for (let i = 0; i < d.length; i += 16) if (d[i]! > 127) { any = true; break }
    setPainted(any)
    if (!any && !named) dropResult()
  }

  const rerender = (): void => {
    if (mask.current) drawStrokes(mask.current, strokes.current, long, 'mask')
    if (tint.current) drawStrokes(tint.current, strokes.current, long, 'tint')
    refreshPainted()
  }

  const dab = (to: Point): void => {
    const s = current.current
    const m = mask.current
    const t = tint.current
    if (!s || !m || !t) return
    const from = s.pts[s.pts.length - 1] ?? to
    s.pts.push(to)
    const radius = (s.size / long) * Math.max(m.width, m.height)
    const draw = (canvas: HTMLCanvasElement, colour: string, out: boolean): void => {
      const c = canvas.getContext('2d')!
      c.save()
      if (out) c.globalCompositeOperation = 'destination-out'
      c.strokeStyle = colour
      c.fillStyle = colour
      c.lineCap = 'round'
      c.lineJoin = 'round'
      c.lineWidth = radius
      c.beginPath()
      c.moveTo(from.x * canvas.width, from.y * canvas.height)
      c.lineTo(to.x * canvas.width, to.y * canvas.height)
      c.stroke()
      c.beginPath()
      c.arc(to.x * canvas.width, to.y * canvas.height, radius / 2, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }
    const erasing = s.kind === 'erase'
    draw(m, erasing ? '#000' : '#fff', false)
    draw(t, 'rgba(235, 70, 90, 0.55)', erasing)
  }

  const onDown = (event: React.PointerEvent): void => {
    if (!image) return
    const wantsPan = brushMode === 'move' || spaceDown.current || event.button === 1 || event.button === 2
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    if (wantsPan) {
      panning.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }
      return
    }
    // Remove waits for its button. If a removal is already showing and the user paints again, that is a NEW removal: the finished one is kept
    // as its own step and the new marking starts clean, so it can neither reuse the old marking nor have its eraser reach the old repair.
    if (!LIVE[tool] && brushMode === 'paint' && resultRef.current) finishNow()
    setNamed(null)
    // Painting something new ends any "redo" of finished steps: they would no longer follow from what is on the picture.
    if (undoneRef.current.length) {
      void window.noema.studioRetouchHold([], undoneRef.current.map((s) => s.pendingId)).catch(() => undefined)
      setUndone([])
    }
    current.current = { kind: brushMode === 'erase' ? 'erase' : 'paint', size: brushSize, pts: [] }
    strokes.current.push(current.current)
    redo.current = []
    setRedoCount(0)
    dab(fractionOf(event))
  }
  const onMove = (event: React.PointerEvent): void => {
    if (!image) return
    const rect = inner.current!.getBoundingClientRect()
    setCursor({ x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom, r: (brushSize / long) * (rect.width / zoom) * 0.5 })
    if (panning.current) {
      setPan({ x: panning.current.px + (event.clientX - panning.current.x), y: panning.current.py + (event.clientY - panning.current.y) })
      return
    }
    if (current.current) dab(fractionOf(event))
  }
  const onUp = (): void => {
    panning.current = null
    if (!current.current) return
    current.current = null
    setStrokeCount(strokes.current.length)
    bump()
    refreshPainted()
  }

  /** Goes back one finished step. Its result is still held by Atlas, so Redo brings it back exactly. */
  const undoStep = (): void => {
    const list = stepsRef.current
    const last = list[list.length - 1]
    if (!last) return
    dropResult()
    strokes.current = []
    redo.current = []
    setStrokeCount(0)
    setRedoCount(0)
    setNamed(null)
    setSteps(list.slice(0, -1))
    setUndone([...undoneRef.current, last])
    bump()
    rerender()
  }
  const redoStep = (): void => {
    const next = undoneRef.current[undoneRef.current.length - 1]
    if (!next) return
    dropResult()
    strokes.current = []
    redo.current = []
    setStrokeCount(0)
    setRedoCount(0)
    setNamed(null)
    setUndone(undoneRef.current.slice(0, -1))
    setSteps([...stepsRef.current, next])
    bump()
    rerender()
  }
  // Undo and Redo work on the marking of the step being worked on first, and then on the finished steps, one at a time.
  const undoStroke = (): void => {
    const s = strokes.current.pop()
    if (!s) { undoStep(); return }
    redo.current.push(s)
    setStrokeCount(strokes.current.length)
    setRedoCount(redo.current.length)
    bump()
    setNamed(null)
    dropResult()
    rerender()
  }
  const redoStroke = (): void => {
    const s = redo.current.pop()
    if (!s) { redoStep(); return }
    strokes.current.push(s)
    setStrokeCount(strokes.current.length)
    setRedoCount(redo.current.length)
    bump()
    dropResult()
    rerender()
  }
  const clearAll = (): void => {
    strokes.current.push({ kind: 'clear', size: 0, pts: [] })
    redo.current = []
    setStrokeCount(strokes.current.length)
    setRedoCount(0)
    bump()
    setNamed(null)
    dropResult()
    rerender()
  }
  /** Finishes the step being worked on: its marking, settings and result are locked in, and the next step starts from that picture. */
  /**
   * Finishes the step in progress at once: its marking, settings and result are locked in and the next step starts from that picture with a
   * clean marking. Nothing is awaited, so it can be used the moment the user starts painting something new.
   */
  const finishNow = (): boolean => {
    const r = resultRef.current
    if (!r || busyRef.current) return false
    const base = stepsRef.current[stepsRef.current.length - 1]?.pendingId
    // A preview that no longer matches the marking on screen is never finished: it would not be what the user saw.
    if (r.edit !== editRef.current || r.base !== base) return false
    if (stepsRef.current.length >= MAX_STEPS) { toast(`That is ${MAX_STEPS} steps. Keep the picture as a new version to carry on from it.`, 'error'); return false }
    const step: Step = { id: `step-${Date.now().toString(36)}-${stepsRef.current.length}`, label: stepLabel(r.settings), settings: r.settings, strokes: r.strokes, pendingId: r.pendingId, url: r.url, summary: r.summary }
    void window.noema.studioRetouchHold([step.pendingId], undoneRef.current.map((s) => s.pendingId)).catch(() => toast('That step could not be locked in.', 'error'))
    resultRef.current = null
    setResultState(null)
    setSteps([...stepsRef.current, step])
    setUndone([])
    strokes.current = []
    redo.current = []
    setStrokeCount(0)
    setRedoCount(0)
    setNamed(null)
    bump()
    rerender()
    return true
  }
  const commitActive = async (): Promise<boolean> => {
    await settle()
    const r = resultRef.current
    if (!r) return false
    const base = stepsRef.current[stepsRef.current.length - 1]?.pendingId
    if (r.edit !== editRef.current || r.base !== base) { dropResult(); return false }
    return finishNow()
  }
  /** After a removal: keep it, and begin another with a clean marking. */
  const startNewRemoval = (): void => {
    if (finishNow()) toast('Kept. Paint the next thing to remove: it starts with a clean marking and cannot change this result.', 'success')
    else clearAll()
  }
  const applyStep = async (): Promise<void> => {
    if (await commitActive()) toast('Locked in. The next edit starts from this picture, and nothing you change now can alter it.', 'success')
  }
  /** Back to the original picture. Every step stays available to Redo. */
  const discardSteps = (): void => {
    if (!stepsRef.current.length && !strokes.current.length) return
    dropResult()
    setUndone([...undoneRef.current, ...stepsRef.current.slice().reverse()])
    setSteps([])
    strokes.current = []
    redo.current = []
    setStrokeCount(0)
    setRedoCount(0)
    setNamed(null)
    bump()
    rerender()
  }
  const chooseNamed = (n: RegionName): void => {
    if (named === n) { setNamed(null); dropResult(); return }
    strokes.current.push({ kind: 'clear', size: 0, pts: [] })
    redo.current = []
    setStrokeCount(strokes.current.length)
    setRedoCount(0)
    bump()
    rerender()
    setNamed(n)
  }

  // ---- zoom --------------------------------------------------------------------------------------------------------
  const zoomAt = useCallback((factor: number, at?: { x: number; y: number }): void => {
    const el = viewport.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = at ? at.x - rect.left - rect.width / 2 : 0
    const cy = at ? at.y - rect.top - rect.height / 2 : 0
    setZoom((z) => {
      const next = Math.max(1, Math.min(16, z * factor))
      const k = next / z
      setPan((p) => (next === 1 ? { x: 0, y: 0 } : { x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }))
      return next
    })
  }, [])
  useEffect(() => {
    const el = viewport.current
    if (!el) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, { x: event.clientX, y: event.clientY })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [zoomAt, image])

  const undoRef = useRef(undoStroke)
  const redoRef = useRef(redoStroke)
  undoRef.current = undoStroke
  redoRef.current = redoStroke
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      const t = event.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      const mod = event.ctrlKey || event.metaKey
      if (event.key === ' ') { spaceDown.current = true; event.preventDefault() }
      else if (mod && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); undoRef.current() }
      else if (mod && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) { event.preventDefault(); redoRef.current() }
      else if (event.key === '[') setBrushSize((s) => Math.max(4, Math.round(s * 0.85)))
      else if (event.key === ']') setBrushSize((s) => Math.min(Math.round(long / 2), Math.round(s * 1.18)))
      else if (event.key === '\\') setHoldOriginal(true)
      else if (!mod && event.key.toLowerCase() === 'b') setBrushMode('paint')
      else if (!mod && event.key.toLowerCase() === 'e') setBrushMode('erase')
    }
    const up = (event: KeyboardEvent): void => {
      if (event.key === ' ') spaceDown.current = false
      if (event.key === '\\') setHoldOriginal(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [long])

  // ---- keeping -----------------------------------------------------------------------------------------------------
  /** Saves what is on the picture (the finished steps and the one being worked on) as one new version. */
  const keep = async (): Promise<void> => {
    await settle()
    const r = resultRef.current
    const last = stepsRef.current[stepsRef.current.length - 1]
    const finalId = r?.pendingId ?? last?.pendingId
    if (!finalId) return
    try {
      const saved = await window.noema.studioEditCommit(finalId)
      if (!saved.ok) { toast(saved.message, 'error'); return }
      const record = saved.records[0]
      // What was saved is now a picture of its own; the steps that led to it are no longer needed in memory.
      const leftover = [...stepsRef.current, ...undoneRef.current].map((s) => s.pendingId).filter((id) => id !== finalId)
      if (leftover.length) void window.noema.studioRetouchHold([], leftover).catch(() => undefined)
      resultRef.current = null
      setResultState(null)
      setSteps([])
      setUndone([])
      strokes.current = []
      redo.current = []
      setStrokeCount(0)
      setRedoCount(0)
      bump()
      rerender()
      onChanged()
      setVersionsKey((k) => k + 1)
      setNamed(null)
      toast(`${saved.message} Carry on retouching it, or step back with the history below.`, 'success')
      if (record?.imageId) onOpenImage(record.imageId)
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  const needsAgreement = tool === 'remove' && method === 'openai'
  const hasArea = painted || Boolean(named)
  const canRun = hasArea && !busy && (!needsAgreement || (agreed && !estimate?.overBudget))
  /** Choosing another tool first finishes the step in progress with ITS tool and settings, so the new tool only ever works on new marking. */
  const pickTool = (next: RetouchTool): void => {
    if (next === tool) return
    void (async () => {
      await commitActive()
      setTool(next)
    })()
  }

  const shown = result?.url ?? steps[steps.length - 1]?.url ?? null
  const hasEdits = Boolean(result) || steps.length > 0
  // ---- full screen ---------------------------------------------------------------------------------------------------
  // The workspace itself is restyled, never rebuilt, so the picture, zoom, pan, brush, marking and before/after position stay as they are.
  const toggleFull = (): void => {
    const next = !full
    setFull(next)
    try {
      if (next) void root.current?.requestFullscreen?.().catch(() => undefined)
      else if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    } catch {
      /* the overlay alone is a full-window workspace */
    }
  }
  const toggleFullRef = useRef(toggleFull)
  toggleFullRef.current = toggleFull
  useEffect(() => {
    const onChange = (): void => { if (!document.fullscreenElement) setFull(false) }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      const t = event.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (event.key === 'Escape' && full && !document.fullscreenElement) { event.stopPropagation(); setFull(false) }
      else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'f') toggleFullRef.current()
    }
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [full])

  const resultClip = split > 0 ? `inset(0 0 0 ${split}%)` : undefined
  const meta = RETOUCH_TOOLS[tool]

  return (
    <div className={`rt${full ? ' is-full' : ''}${full && !controlsOpen ? ' is-collapsed' : ''}`} data-testid="retouch" ref={root}>
      <div className="rt__main">
        <div className="rt__tools" role="toolbar" aria-label="Retouch tools">
          <div className="studio-seg" role="radiogroup" aria-label="What to do">
            {TOOL_ORDER.map((id) => (
              <button key={id} type="button" role="radio" aria-checked={tool === id} className={tool === id ? 'is-on' : ''} onClick={() => pickTool(id)} data-testid={`rt-tool-${id}`} title={RETOUCH_TOOLS[id].note}>{RETOUCH_TOOLS[id].label}</button>
            ))}
          </div>
          <div className="studio-seg" role="radiogroup" aria-label="Brush">
            <button type="button" role="radio" aria-checked={brushMode === 'paint'} className={brushMode === 'paint' ? 'is-on' : ''} onClick={() => setBrushMode('paint')} data-testid="rt-brush-paint" title="Brush (B)">Brush</button>
            <button type="button" role="radio" aria-checked={brushMode === 'erase'} className={brushMode === 'erase' ? 'is-on' : ''} onClick={() => setBrushMode('erase')} title="Eraser (E)">Eraser</button>
            <button type="button" role="radio" aria-checked={brushMode === 'move'} className={brushMode === 'move' ? 'is-on' : ''} onClick={() => setBrushMode('move')} title="Move the picture (or hold Space)">Move</button>
          </div>
          <button type="button" className="button button--ghost" onClick={undoStroke} disabled={strokeCount === 0 && steps.length === 0} data-testid="rt-undo" title={strokeCount > 0 ? 'Undo the last stroke (Ctrl+Z)' : steps.length ? `Undo the finished edit “${steps[steps.length - 1]!.label}” (Ctrl+Z). Earlier edits stay.` : 'Nothing to undo'}>Undo</button>
          <button type="button" className="button button--ghost" onClick={redoStroke} disabled={redoCount === 0 && undone.length === 0} data-testid="rt-redo" title={redoCount > 0 ? 'Redo the stroke (Ctrl+Y)' : undone.length ? `Redo the finished edit “${undone[undone.length - 1]!.label}” (Ctrl+Y)` : 'Nothing to redo'}>Redo</button>
          <button type="button" className="button button--ghost" onClick={clearAll} disabled={!hasArea} data-testid="rt-clear" title="Remove the marking of the edit you are working on. Finished edits stay.">Clear</button>
          <span className="rt__spacer" />
          <button type="button" className="button button--ghost" onClick={toggleFull} aria-pressed={full} data-testid="rt-full" title="Work on the picture at the full size of the screen (F). Zoom, brush and the marking stay as they are.">{full ? 'Exit full screen' : 'Full screen'}</button>
          {full ? <button type="button" className="button button--ghost" onClick={() => setControlsOpen((o) => !o)} aria-pressed={!controlsOpen} data-testid="rt-controls">{controlsOpen ? 'Hide controls' : 'Show controls'}</button> : null}
          <div className="rt__zoom" role="group" aria-label="Zoom">
            <button type="button" className="button button--ghost" onClick={() => zoomAt(1 / 1.4)} aria-label="Zoom out">−</button>
            <button type="button" className="button button--ghost" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} data-testid="rt-fit" title="Fit the picture">{Math.round(zoom * 100)}%</button>
            <button type="button" className="button button--ghost" onClick={() => zoomAt(1.4)} aria-label="Zoom in" data-testid="rt-zoom-in">+</button>
          </div>
        </div>

        <div className={`rt__viewport${brushMode === 'move' ? ' is-move' : ''}`} ref={viewport} onContextMenu={(e) => e.preventDefault()} data-testid="rt-viewport">
          {problem ? (
            <div className="studio-capability is-missing rt__problem" role="alert" data-testid="edit-load-problem">
              <Icon name="info" size={14} />
              <div><strong>This picture cannot be retouched.</strong> {problem} <button type="button" className="studio-link" onClick={onChoose}>Choose another picture</button></div>
            </div>
          ) : !image ? (
            <Spinner label="Opening the picture" />
          ) : (
            <div className="rt__zoomer" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
              <div className="rt__inner" ref={inner} style={{ width: stageW, height: stageH }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setCursor(null)} data-testid="rt-stage">
                <img className="rt__img" src={image.fullUrl} alt={image.filename} draggable={false} data-testid="rt-original" onError={() => setProblem('Atlas cannot read this file right now. It may have been moved, renamed or deleted (put it back, or reconnect its drive), or it may be damaged or in a format Atlas cannot show.')} />
                {shown && !holdOriginal ? <img className="rt__img rt__img--result" src={shown} alt="Result" draggable={false} style={resultClip ? { clipPath: resultClip } : undefined} data-testid="rt-result" /> : null}
                <canvas ref={tint} className="rt__tint" style={{ opacity: showMask ? (result ? 0.3 : 1) : 0 }} data-testid="rt-canvas" />
                {shown && split > 0 ? <span className="rt__divider" style={{ left: `${split}%` }} /> : null}
                {cursor && brushMode !== 'move' ? <span className="rt__ring" style={{ left: cursor.x, top: cursor.y, width: cursor.r * 2, height: cursor.r * 2 }} /> : null}
              </div>
            </div>
          )}
          {busy ? (
            <div className="rt__busy" role="status" aria-live="polite" data-testid="rt-busy">
              <Spinner label={progress?.message ?? 'Working…'} />
              {tool === 'remove' ? <button type="button" className="button button--ghost" onClick={stop}><Icon name="stop" size={12} /> Stop</button> : null}
            </div>
          ) : null}
          {!hasArea && image ? <div className="rt__hint" data-testid="rt-hint">Paint over the part to {tool === 'remove' ? 'remove' : tool === 'heal' ? 'repair' : tool === 'blur' ? 'soften' : tool === 'sharpen' ? 'sharpen' : toneDir === 'lighten' ? 'brighten' : 'darken'}. Scroll to zoom; hold Space to move.</div> : null}
        </div>

        <div className="rt__compare" aria-label="Compare with the original">
          <label className="studio-range">
            <span>Original <em>◂</em> compare <em>▸</em> Result</span>
            <input type="range" min={0} max={100} value={100 - split} disabled={!shown} onChange={(e) => setSplit(100 - Number(e.target.value))} data-testid="rt-compare" aria-label="Before and after" />
          </label>
          <button type="button" className="button button--ghost" disabled={!shown} onPointerDown={() => setHoldOriginal(true)} onPointerUp={() => setHoldOriginal(false)} onPointerLeave={() => setHoldOriginal(false)} data-testid="rt-hold" title="Hold to see the original (or press \)">Hold: original</button>
          <label className="studio-agree rt__maskToggle"><input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} /><span>Show the marked area</span></label>
        </div>
      </div>

      <aside className="rt__side">
        <p className="studio-hint rt__toolnote">{meta.note}</p>
        <h3>Brush</h3>
        <label className="studio-range">
          <span>Size · {brushSize}px <small>([ and ])</small></span>
          <input type="range" min={4} max={Math.max(60, Math.round(long / 2))} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} aria-label="Brush size" data-testid="rt-size" />
        </label>
        <label className="studio-range">
          <span>Softness of the edge · {pct(softness)}</span>
          <input type="range" min={0} max={1} step={0.05} value={softness} onChange={(e) => setSoftness(Number(e.target.value))} aria-label="Softness" data-testid="rt-softness" />
        </label>

        <h3>{meta.label}</h3>
        {tool === 'tone' ? (
          <div className="studio-seg" role="radiogroup" aria-label="Lighten or darken">
            <button type="button" role="radio" aria-checked={toneDir === 'lighten'} className={toneDir === 'lighten' ? 'is-on' : ''} onClick={() => setToneDir('lighten')} data-testid="rt-tone-lighten">Dodge · lighten</button>
            <button type="button" role="radio" aria-checked={toneDir === 'darken'} className={toneDir === 'darken' ? 'is-on' : ''} onClick={() => setToneDir('darken')} data-testid="rt-tone-darken">Burn · darken</button>
          </div>
        ) : null}
        <div className="studio-range">
          <span>{tool === 'remove' ? 'Reach beyond the painted edge' : tool === 'heal' ? 'Texture rebuilt (the rest is kept)' : tool === 'tone' ? 'Amount' : 'Strength'} · {pct(strength)}</span>
          <div className="rt__strength">
            <input type="range" min={tool === 'remove' ? 0 : 0.05} max={1} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} aria-label="Strength" data-testid="rt-strength" />
            <label className="rt__num">
              <input type="number" min={tool === 'remove' ? 0 : 0.5} max={100} step={0.5} value={Math.round(strength * 1000) / 10} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setStrength(Math.max(tool === 'remove' ? 0 : 0.005, Math.min(1, v / 100))) }} aria-label="Strength in percent" data-testid="rt-strength-number" />%
            </label>
          </div>
          {tool === 'blur' ? (
            <div className="rt__fine">
              <input type="range" min={0.005} max={0.2} step={0.001} value={Math.min(0.2, Math.max(0.005, strength))} onChange={(e) => setStrength(Number(e.target.value))} aria-label="Fine strength, 0.5 to 20 percent" data-testid="rt-strength-fine" />
              <small>Fine control, 0.5–20 %. A few percent is often enough; above about 10 % the softening is strong.</small>
            </div>
          ) : null}
          {tool === 'remove' ? <small>Higher removes halos and shadows around the mark too.</small> : null}
        </div>

        {tool === 'blur' ? (
          <label className="studio-agree">
            <input type="checkbox" checked={edgeAware} onChange={(e) => setEdgeAware(e.target.checked)} data-testid="rt-edge-aware" />
            <span><strong>Keep edges sharp</strong> (edge-aware). Smooths skin-like surfaces, noise and artificial texture but not outlines. Best for photographs.</span>
          </label>
        ) : null}
        {tool !== 'remove' ? (
          <div className="rt__chips" role="group" aria-label="Or a whole part">
            <small>Or a whole part:</small>
            {NAMED.map((n) => (
              <button key={n} type="button" className={`rt__chip${named === n ? ' is-on' : ''}`} aria-pressed={named === n} onClick={() => chooseNamed(n)} data-region={n}>{REGION_LABELS[n]}</button>
            ))}
          </div>
        ) : null}
        {tool === 'remove' ? (
          <>
            <div className="studio-field">
              <span>How should it be rebuilt?</span>
              <div className="studio-seg" role="radiogroup" aria-label="Method">
                <button type="button" role="radio" aria-checked={method === 'local'} className={method === 'local' ? 'is-on' : ''} onClick={() => setMethod('local')} data-testid="rt-method-local">From the surroundings</button>
                <button type="button" role="radio" aria-checked={method === 'comfyui'} aria-disabled={!comfyOk} disabled={!comfyOk} className={method === 'comfyui' ? 'is-on' : ''} onClick={() => setMethod('comfyui')} data-testid="rt-method-comfyui" title={comfyOk ? 'Repaint with the selected ComfyUI server' : (comfy?.reason ?? 'ComfyUI is not set up')}>AI (ComfyUI)</button>
                <button type="button" role="radio" aria-checked={method === 'openai'} aria-disabled={!cloudOk} disabled={!cloudOk} className={method === 'openai' ? 'is-on' : ''} onClick={() => setMethod('openai')} data-testid="rt-method-openai" title={cloudOk ? 'Cloud service (paid, uploads the picture)' : (cloud?.reason ?? 'Add a key in the Studio settings')}>Cloud</button>
              </div>
              <small>{method === 'local' ? 'Quick, on this computer, no AI model. Best for spots, wires, small objects and blemishes.' : method === 'comfyui' ? 'The selected ComfyUI server receives the marked area and repaints it. Better for larger objects.' : 'Sends the picture and the marked area to the cloud service.'}{!comfyOk ? ' ComfyUI is not set up: open the settings (⋯) to add it.' : ''}</small>
            </div>
            {method === 'comfyui' ? (
              <label className="studio-agree">
                <input type="checkbox" checked={seedLocal} onChange={(e) => setSeedLocal(e.target.checked)} data-testid="rt-seed-local" />
                <span><strong>Start from Atlas’s own rebuild</strong>: the model refines the local result instead of painting from nothing. Keeps the surrounding texture; switch off for a fully new area.</span>
              </label>
            ) : null}
            <label className="studio-field">
              <span>What should be there instead? (optional)</span>
              <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="for example: grass, plain wall, water" data-testid="rt-hint-input" />
            </label>
            {estimate && method === 'openai' ? <div className={`studio-estimate${estimate.overBudget ? ' is-bad' : ''}`}><Icon name="external" size={13} /> <span>{estimate.message}</span></div> : null}
            {method === 'openai' ? <label className="studio-agree"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="rt-agree" /><span>I agree to send this picture and the marked area to the cloud service{estimate && estimate.costUsd > 0 ? ` and to pay about $${estimate.costUsd.toFixed(2)}` : ''}.</span></label> : null}
            {result ? (
              <div className="rt__remove-actions" data-testid="rt-remove-done">
                <button type="button" className="button button--gold" onClick={startNewRemoval} data-testid="rt-new-removal" title="Keep this removal and start the next one with a clean marking">Start a new removal</button>
                <button type="button" className="button button--ghost" disabled={!canRun} onClick={() => void run('press')} data-testid="rt-run" title="Try the same marked area again (change the settings first if you like). It replaces this try; nothing else changes.">Retry this area</button>
                <small>Painting again also starts a new removal. This one is kept under “Finished edits”.</small>
              </div>
            ) : (
              <button type="button" className="button button--gold" disabled={!canRun} onClick={() => void run('press')} data-testid="rt-run">Remove</button>
            )}
          </>
        ) : (
          <p className="studio-hint">Works on this computer with no AI model and follows your brush at once.</p>
        )}

        {steps.length > 0 ? (
          <div className="rt__steps" data-testid="rt-steps">
            <h3>Finished edits</h3>
            <ol>
              {steps.map((s, i) => (
                <li key={s.id} data-testid={`rt-step-${i}`} title={s.summary}>
                  <strong>{i + 1}. {s.label}</strong>
                  <small>{s.settings.tool === 'blur' || s.settings.tool === 'sharpen' || s.settings.tool === 'tone' ? `strength ${pct(s.settings.strength)} · ` : ''}edge softness {pct(s.settings.softness)} · brush {s.settings.brushSize}px · {s.strokes.filter((k) => k.kind !== 'clear').length} strokes</small>
                </li>
              ))}
            </ol>
            <div className="rt__stepbar">
              <button type="button" className="button button--ghost" onClick={undoStep} data-testid="rt-undo-step">Undo last edit</button>
              <button type="button" className="button button--ghost" onClick={discardSteps} data-testid="rt-discard" title="Back to the original. Redo brings the edits back.">Discard all</button>
            </div>
            <small>These are locked in: changing the tool, the brush or any slider only affects the next edit.</small>
          </div>
        ) : null}

        {hasEdits ? (
          <div className="rt__result" data-testid="rt-summary">
            <small>{result ? result.summary : steps[steps.length - 1]?.summary}</small>
            {result ? <button type="button" className="button button--ghost" disabled={busy} onClick={() => void applyStep()} data-testid="rt-apply" title="Lock this edit in, then start the next one with its own tool and settings">Lock in this edit and continue</button> : null}
            <button type="button" className="button button--gold" disabled={busy} onClick={() => void keep()} data-testid="rt-keep">Keep as a new version</button>
            <small>Nothing is saved until you keep it. The original is never changed.</small>
          </div>
        ) : null}

        <h3>History</h3>
        <VersionStrip imageId={imageId} onOpen={onOpenImage} refreshKey={versionsKey} />
        <button type="button" className="studio-link" onClick={onChoose} data-testid="rt-change-picture">Choose another picture</button>
      </aside>
    </div>
  )
}
