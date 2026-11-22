import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageItem } from '@shared/types'
import { EDIT_LEVELS, REFERENCE_ASPECTS, type EditLevel, type EditReferences, type EditRegion, type GenerationRecord, type ReferenceAspect, type RegionName } from '@shared/studio'
import { REGION_LABELS, regionFromInstruction } from '@shared/regionWords'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { friendlyError } from '../lib/format'

// The parts of the Edit tab that go beyond a sentence and a slider: how far to go, which part of the picture, what to
// borrow from other pictures, and the history of versions. Each is optional; the simple path is still just a sentence.

export function LevelPicker({ level, onLevel }: { level: EditLevel; onLevel: (level: EditLevel) => void }): React.JSX.Element {
  return (
    <div className="studio-levels" role="radiogroup" aria-label="How far the edit may go" data-testid="edit-levels">
      {(Object.keys(EDIT_LEVELS) as EditLevel[]).map((id) => (
        <button key={id} type="button" role="radio" aria-checked={level === id} className={level === id ? 'is-on' : ''} onClick={() => onLevel(id)} data-level={id}>
          <strong>{EDIT_LEVELS[id].label}</strong>
          <small>{EDIT_LEVELS[id].note}</small>
        </button>
      ))}
    </div>
  )
}

const NAMED: RegionName[] = ['sky', 'background', 'foreground', 'top', 'bottom', 'left', 'right', 'center']

/** Choosing the part of the picture that may change: by name, or by painting over it. Everything else is kept exactly. */
export function RegionPanel({ image, instruction, value, onChange }: { image: ImageItem | null; instruction: string; value: EditRegion | null; onChange: (region: EditRegion | null) => void }): React.JSX.Element {
  const [open, setOpen] = useState(Boolean(value))
  const [painting, setPainting] = useState(false)
  const [overlay, setOverlay] = useState<{ url: string; coverage: number; how: string } | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const suggestion = regionFromInstruction(instruction)

  const preview = useCallback(
    async (region: EditRegion | null) => {
      if (!image || !region) {
        setOverlay(null)
        return
      }
      setChecking(true)
      setError('')
      try {
        const r = await window.noema.studioRegionPreview(image.id, region)
        setOverlay({ url: r.overlayUrl, coverage: r.coverage, how: r.how })
      } catch (e) {
        setOverlay(null)
        setError(friendlyError(e))
      } finally {
        setChecking(false)
      }
    },
    [image]
  )

  const choose = (region: EditRegion | null): void => {
    onChange(region)
    void preview(region)
  }

  return (
    <fieldset className="studio-region" data-testid="edit-region">
      <legend>Which part?</legend>
      <div className="studio-seg" role="radiogroup" aria-label="Which part of the picture">
        <button type="button" role="radio" aria-checked={!open} className={!open ? 'is-on' : ''} onClick={() => { setOpen(false); setPainting(false); onChange(null); setOverlay(null); setError('') }} data-testid="region-whole">The whole picture</button>
        <button type="button" role="radio" aria-checked={open} className={open ? 'is-on' : ''} onClick={() => setOpen(true)} data-testid="region-part">Only part of it</button>
      </div>
      {open ? (
        <div className="studio-region__body">
          <p className="studio-hint">Only the chosen part changes. Everything else stays exactly as the original, pixel for pixel.</p>
          <div className="studio-chips" role="group" aria-label="Name a part">
            {NAMED.map((name) => (
              <button key={name} type="button" className={`studio-chip${value?.named === name && !value.maskPng ? ' is-on' : ''}`} onClick={() => { setPainting(false); choose({ named: name, invert: value?.invert, feather: value?.feather }) }} data-region={name}>
                {REGION_LABELS[name]}
              </button>
            ))}
            <button type="button" className={`studio-chip${painting || value?.maskPng ? ' is-on' : ''}`} onClick={() => setPainting(true)} data-testid="region-paint">
              <Icon name="edit" size={12} /> Paint it myself
            </button>
          </div>
          {suggestion && !value ? (
            <button type="button" className="studio-link" onClick={() => choose({ named: suggestion })} data-testid="region-suggest">
              Your sentence mentions the {REGION_LABELS[suggestion].toLowerCase()}. Select only that?
            </button>
          ) : null}
          {painting && image ? (
            <Painter
              image={image}
              invert={value?.invert}
              feather={value?.feather}
              onChange={(maskPng) => choose(maskPng ? { maskPng, invert: value?.invert, feather: value?.feather } : null)}
            />
          ) : null}
          {value ? (
            <div className="studio-region__tune">
              <label className="studio-check">
                <input type="checkbox" checked={Boolean(value.invert)} onChange={(e) => choose({ ...value, invert: e.target.checked })} /> Change everything except this
              </label>
              <label className="studio-range">
                <span>Soft edge: {value.feather ?? 'automatic'}{value.feather !== undefined ? ' px' : ''}</span>
                <input type="range" min={0} max={60} step={2} value={value.feather ?? 8} onChange={(e) => onChange({ ...value, feather: Number(e.target.value) })} onMouseUp={() => void preview(value)} aria-label="Soft edge" />
              </label>
            </div>
          ) : null}
          {checking ? <Spinner label="Finding that part" /> : null}
          {error ? <p className="studio-error" role="alert" data-testid="region-error">{error}</p> : null}
          {overlay && !painting ? (
            <figure className="studio-region__overlay" data-testid="region-overlay">
              <img src={overlay.url} alt="The selected part is shown in red" />
              <figcaption>Selected: {overlay.how} · {Math.round(overlay.coverage * 100)}% of the picture</figcaption>
            </figure>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  )
}

/** A canvas over the picture. Strokes are kept in a second, plain black-and-white canvas that becomes the mask. */
function Painter({ image, invert, feather, onChange }: { image: ImageItem; invert?: boolean; feather?: number; onChange: (maskPng: string | null) => void }): React.JSX.Element {
  const view = useRef<HTMLCanvasElement | null>(null)
  const mask = useRef<HTMLCanvasElement | null>(null)
  const down = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState(Math.max(14, Math.round(Math.max(image.width, image.height) / 18)))
  const [erase, setErase] = useState(false)
  const [painted, setPainted] = useState(false)
  const aspect = image.width / Math.max(1, image.height)
  void invert
  void feather

  useEffect(() => {
    const m = document.createElement('canvas')
    const long = 640
    m.width = aspect >= 1 ? long : Math.round(long * aspect)
    m.height = aspect >= 1 ? Math.round(long / aspect) : long
    const c = m.getContext('2d')!
    c.fillStyle = '#000'
    c.fillRect(0, 0, m.width, m.height)
    mask.current = m
  }, [aspect])

  const point = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = view.current!.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }

  const stroke = (to: { x: number; y: number }): void => {
    const v = view.current!
    const m = mask.current!
    const from = last.current ?? to
    const brush = size / Math.max(image.width, image.height)
    const draw = (canvas: HTMLCanvasElement, colour: string, erasing: boolean): void => {
      const c = canvas.getContext('2d')!
      c.save()
      if (erasing && canvas === v) c.globalCompositeOperation = 'destination-out'
      c.strokeStyle = colour
      c.fillStyle = colour
      c.lineCap = 'round'
      c.lineJoin = 'round'
      c.lineWidth = brush * Math.max(canvas.width, canvas.height)
      c.beginPath()
      c.moveTo(from.x * canvas.width, from.y * canvas.height)
      c.lineTo(to.x * canvas.width, to.y * canvas.height)
      c.stroke()
      c.beginPath()
      c.arc(to.x * canvas.width, to.y * canvas.height, (brush * Math.max(canvas.width, canvas.height)) / 2, 0, Math.PI * 2)
      c.fill()
      c.restore()
    }
    draw(v, 'rgba(235, 70, 90, 0.55)', erase)
    draw(m, erase ? '#000' : '#fff', erase)
    last.current = to
  }

  const finish = (): void => {
    if (!down.current) return
    down.current = false
    last.current = null
    const data = mask.current!.toDataURL('image/png')
    // An empty canvas is no selection.
    const probe = mask.current!.getContext('2d')!.getImageData(0, 0, mask.current!.width, mask.current!.height).data
    let any = false
    for (let i = 0; i < probe.length; i += 16) if (probe[i]! > 127) { any = true; break }
    setPainted(any)
    onChange(any ? data : null)
  }

  const clear = (): void => {
    const v = view.current!
    v.getContext('2d')!.clearRect(0, 0, v.width, v.height)
    const m = mask.current!
    const c = m.getContext('2d')!
    c.fillStyle = '#000'
    c.fillRect(0, 0, m.width, m.height)
    setPainted(false)
    onChange(null)
  }

  return (
    <div className="studio-painter" data-testid="painter">
      <div className="studio-painter__stage" style={{ aspectRatio: `${image.width} / ${image.height}` }}>
        <img src={image.fullUrl} alt="" draggable={false} />
        <canvas
          ref={view}
          width={Math.round(720 * Math.min(1, aspect))}
          height={Math.round(720 / Math.max(1, aspect))}
          data-testid="painter-canvas"
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); down.current = true; stroke(point(e)) }}
          onPointerMove={(e) => down.current && stroke(point(e))}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
      </div>
      <div className="studio-painter__bar">
        <div className="studio-seg" role="radiogroup" aria-label="Tool">
          <button type="button" role="radio" aria-checked={!erase} className={!erase ? 'is-on' : ''} onClick={() => setErase(false)}>Paint</button>
          <button type="button" role="radio" aria-checked={erase} className={erase ? 'is-on' : ''} onClick={() => setErase(true)}>Erase</button>
        </div>
        <label className="studio-range studio-painter__size">
          <span>Brush</span>
          <input type="range" min={6} max={Math.max(60, Math.round(Math.max(image.width, image.height) / 4))} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Brush size" />
        </label>
        <button type="button" className="button button--ghost" onClick={clear} disabled={!painted}>Clear</button>
      </div>
      <p className="studio-hint">Paint over the part that should change. {painted ? 'Done painting? The selection is checked below.' : ''}</p>
    </div>
  )
}

/** Borrowing the light, colour or atmosphere of other pictures, or of a whole moodboard. */
export function ReferencePanel({ imageId, moodboards, value, onChange }: { imageId: string; moodboards: Array<{ id: string; name: string; imageCount: number }>; value: EditReferences | null; onChange: (refs: EditReferences | null) => void }): React.JSX.Element {
  const [open, setOpen] = useState(Boolean(value))
  const [items, setItems] = useState<ImageItem[]>([])
  const [search, setSearch] = useState('')
  const [library, setLibrary] = useState<ImageItem[]>([])
  const refs = value ?? { imageIds: [], aspects: ['atmosphere'] as ReferenceAspect[], amount: 0.75 }
  const set = (patch: Partial<EditReferences>): void => {
    const next = { ...refs, ...patch }
    onChange(next.imageIds.length ? next : { ...next, imageIds: [] })
  }

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      void window.noema.listImages({ scope: 'collection', search: search.trim() || undefined, sort: 'recent', limit: 18 }).then((page) => setLibrary(page.items.filter((i) => i.id !== imageId))).catch(() => setLibrary([]))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [open, search, imageId])
  useEffect(() => {
    const ids = refs.imageIds
    void Promise.all(ids.slice(0, 12).map((id) => window.noema.getImage(id).catch(() => null))).then((list) => setItems(list.filter((i): i is ImageItem => Boolean(i))))
  }, [refs.imageIds.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const addBoard = async (boardId: string): Promise<void> => {
    if (!boardId) return
    const detail = await window.noema.getMoodboard(boardId)
    const ids = (detail?.images ?? []).filter((i) => !i.missing && i.id !== imageId).slice(0, 8).map((i) => i.id)
    set({ imageIds: Array.from(new Set([...refs.imageIds, ...ids])).slice(0, 12) })
  }
  const toggle = (id: string): void => set({ imageIds: refs.imageIds.includes(id) ? refs.imageIds.filter((x) => x !== id) : [...refs.imageIds, id].slice(0, 12) })
  const toggleAspect = (a: ReferenceAspect): void => set({ aspects: refs.aspects.includes(a) ? refs.aspects.filter((x) => x !== a) : [...refs.aspects, a] })

  return (
    <fieldset className="studio-refs" data-testid="edit-references">
      <legend>Borrow a look</legend>
      <label className="studio-check">
        <input type="checkbox" checked={open} onChange={(e) => { setOpen(e.target.checked); if (!e.target.checked) onChange(null) }} data-testid="refs-toggle" /> Use other pictures as a reference
      </label>
      {open ? (
        <div className="studio-refs__body">
          <p className="studio-hint">The reference's light and colour are applied to this picture before the model works, so the result really follows it. This picture's own composition is kept.</p>
          <div className="studio-chips" role="group" aria-label="What to take from the reference">
            {(Object.keys(REFERENCE_ASPECTS) as ReferenceAspect[]).map((a) => (
              <button key={a} type="button" className={`studio-chip${refs.aspects.includes(a) ? ' is-on' : ''}`} onClick={() => toggleAspect(a)} data-aspect={a}>{REFERENCE_ASPECTS[a]}</button>
            ))}
          </div>
          <label className="studio-field">
            <span>Add a whole moodboard</span>
            <select value="" onChange={(e) => void addBoard(e.target.value)} aria-label="Add a moodboard as reference" data-testid="refs-board">
              <option value="">Choose a moodboard…</option>
              {moodboards.map((b) => <option key={b.id} value={b.id}>{b.name} ({b.imageCount})</option>)}
            </select>
          </label>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Or search for single pictures" aria-label="Search for reference pictures" />
          <div className="studio-picker__grid studio-picker__grid--small" role="list">
            {library.map((item) => (
              <button key={item.id} type="button" role="listitem" className={refs.imageIds.includes(item.id) ? 'is-on' : ''} onClick={() => toggle(item.id)} title={item.filename} aria-pressed={refs.imageIds.includes(item.id)}>
                <img src={item.thumbUrl} alt={item.filename} draggable={false} />
              </button>
            ))}
          </div>
          {items.length > 0 ? (
            <div className="studio-refs__chosen" data-testid="refs-chosen">
              <small>{items.length} reference picture{items.length === 1 ? '' : 's'}</small>
              {items.map((item) => <button key={item.id} type="button" onClick={() => toggle(item.id)} title="Remove" aria-label={`Remove ${item.filename}`}><img src={item.thumbUrl} alt="" draggable={false} /></button>)}
            </div>
          ) : null}
          <label className="studio-check">
            <input type="checkbox" checked={refs.conditioning === 'images'} onChange={(e) => set({ conditioning: e.target.checked ? 'images' : 'look' })} data-testid="refs-as-images" /> Give the model the reference pictures themselves
          </label>
          {refs.conditioning === 'images' ? <p className="studio-hint">Local FLUX.2 receives up to three of them as pictures, each prepared for what you chose to take. A paid cloud method would upload them; you approve that before anything is sent.</p> : null}
          <label className="studio-range">
            <span>How much to take: {Math.round((refs.amount ?? 0.75) * 100)}%</span>
            <input type="range" min={0.2} max={1} step={0.05} value={refs.amount ?? 0.75} onChange={(e) => set({ amount: Number(e.target.value) })} aria-label="How much of the reference" />
          </label>
        </div>
      ) : null}
    </fieldset>
  )
}

/** Every version made from this picture, oldest first. Opening one continues from it, so any step can be returned to and branched. */
export function VersionStrip({ imageId, onOpen, refreshKey }: { imageId: string; onOpen: (imageId: string) => void; refreshKey: number }): React.JSX.Element | null {
  const [records, setRecords] = useState<GenerationRecord[] | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, ImageItem>>({})
  const [root, setRoot] = useState<ImageItem | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      const v = await window.noema.studioVersions(imageId).catch(() => null)
      if (!live || !v) return
      setRecords(v.records)
      const loaded = await Promise.all(v.records.map((r) => (r.imageId ? window.noema.getImage(r.imageId).catch(() => null) : null)))
      if (!live) return
      setThumbs(Object.fromEntries(loaded.filter((i): i is ImageItem => Boolean(i)).map((i) => [i.id, i])))
      if (v.seriesId.startsWith('photo-')) setRoot(await window.noema.getImage(v.seriesId.slice(6)).catch(() => null))
    })()
    return () => {
      live = false
    }
  }, [imageId, refreshKey])
  if (!records || records.length === 0) return null
  const depth = (r: GenerationRecord): number => {
    let d = 0
    let p = records.find((x) => x.id === r.parentId)
    while (p && d < 20) {
      d += 1
      p = records.find((x) => x.id === p!.parentId)
    }
    return d
  }
  return (
    <div className="studio-versions" data-testid="version-strip">
      <h4>Versions</h4>
      <ol>
        {root ? (
          <li className={root.id === imageId ? 'is-current' : ''}>
            <button type="button" onClick={() => onOpen(root.id)} title="The original" data-testid="version-original">
              <img src={root.thumbUrl} alt="The original" draggable={false} />
              <small>Original</small>
            </button>
          </li>
        ) : null}
        {records.map((r) => {
          const item = r.imageId ? thumbs[r.imageId] : null
          if (!item) return null
          return (
            <li key={r.id} className={r.imageId === imageId ? 'is-current' : ''} style={{ marginLeft: Math.min(3, depth(r)) * 4 }}>
              <button type="button" onClick={() => onOpen(item.id)} title={r.note || r.prompt || r.title} data-testid="version-item">
                <img src={item.thumbUrl} alt={r.title} draggable={false} />
                <small>{r.kind === 'upscale' ? `${r.width}px` : r.kind === 'external' ? 'External' : r.kind === 'edit' ? 'Edit' : 'Made'}</small>
              </button>
            </li>
          )
        })}
      </ol>
      <p className="studio-hint">Choose any version to carry on from it. Nothing is ever replaced, so you can always go back and branch.</p>
    </div>
  )
}
