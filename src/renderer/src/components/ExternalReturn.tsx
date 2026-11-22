import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageItem } from '@shared/types'
import type { ExternalCandidate, ExternalEditSession } from '@shared/studio'
import { Icon } from './Icon'
import { openViewer } from './StudioViewer'
import { Spinner } from './ui'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'
import { OPEN_EXTERNAL_RESULT_EVENT, removeSession, upsertSession, useExternalSessions } from '../lib/externalStore'

// Editing in another program as a seamless part of Atlas: when a save comes back (it has been read, saved and is in the
// library) this window shows the original and the edited picture side by side with locked zoom and pan, and offers the
// next steps. A small chip keeps a waiting session visible when the Studio window is closed.

const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const ago = (at: number): string => {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}
const sizeText = (bytes: number): string => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`)

function useImageItem(id: string | null): ImageItem | null {
  const [item, setItem] = useState<ImageItem | null>(null)
  useEffect(() => {
    let live = true
    setItem(null)
    if (id) void window.noema.getImage(id).then((i) => live && setItem(i)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [id])
  return item
}

// ---- before and after, with locked zoom and pan -------------------------------------------------------------------------

function SyncCompare({ before, after, beforeLabel, afterLabel }: { before: ImageItem; after: ImageItem; beforeLabel: string; afterLabel: string }): React.JSX.Element {
  const [mode, setMode] = useState<'side' | 'wipe'>('side')
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const [wipe, setWipe] = useState(50)
  const wrap = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  const zoomAt = useCallback((factor: number, at?: { x: number; y: number }): void => {
    const pane = wrap.current?.querySelector('.sc__pane') as HTMLElement | null
    if (!pane) return
    const rect = pane.getBoundingClientRect()
    const cx = at ? at.x - rect.left - rect.width / 2 : 0
    const cy = at ? at.y - rect.top - rect.height / 2 : 0
    setView((v) => {
      const next = Math.max(1, Math.min(24, v.zoom * factor))
      const k = next / v.zoom
      return next === 1 ? { zoom: 1, x: 0, y: 0 } : { zoom: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }, [])

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, { x: event.clientX, y: event.clientY })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [zoomAt])

  const actualSize = (): void => {
    const pane = wrap.current?.querySelector('.sc__pane') as HTMLElement | null
    if (!pane) return
    const fitted = Math.min(pane.clientWidth, pane.clientHeight * (after.width / Math.max(1, after.height)))
    setView({ zoom: Math.max(1, Math.min(24, after.width / Math.max(1, fitted))), x: 0, y: 0 })
  }

  const layer = (item: ImageItem, label: string, testid: string): React.JSX.Element => (
    <div className="sc__layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
      <img src={item.fullUrl} alt={label} draggable={false} data-testid={testid} />
    </div>
  )
  const sameShape = Math.abs(before.width / Math.max(1, before.height) - after.width / Math.max(1, after.height)) < 0.02

  return (
    <div className="sc" data-testid="sync-compare">
      <div className="sc__bar">
        <div className="studio-seg" role="radiogroup" aria-label="Way to compare">
          <button type="button" role="radio" aria-checked={mode === 'side'} className={mode === 'side' ? 'is-on' : ''} onClick={() => setMode('side')} data-testid="sc-side">Side by side</button>
          <button type="button" role="radio" aria-checked={mode === 'wipe'} className={mode === 'wipe' ? 'is-on' : ''} onClick={() => setMode('wipe')} data-testid="sc-wipe">Slider</button>
        </div>
        <span className="sc__hint">Scroll to zoom, drag to move: both pictures move together.{sameShape ? '' : ' The edit has a different shape (cropped or resized), so the two are not aligned.'}</span>
        <span className="sc__spacer" />
        <div className="sc__zoom" role="group" aria-label="Zoom">
          <button type="button" className="button button--ghost" onClick={() => zoomAt(1 / 1.4)} aria-label="Zoom out">−</button>
          <button type="button" className="button button--ghost" onClick={() => setView({ zoom: 1, x: 0, y: 0 })} data-testid="sc-fit" title="Fit both pictures">{Math.round(view.zoom * 100)}%</button>
          <button type="button" className="button button--ghost" onClick={() => zoomAt(1.4)} aria-label="Zoom in" data-testid="sc-zoom-in">+</button>
          <button type="button" className="button button--ghost" onClick={actualSize} title="Show the edit at its real pixel size">1:1</button>
        </div>
      </div>
      <div
        ref={wrap}
        className={`sc__stage sc__stage--${mode}`}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('input')) return
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
        }}
        onPointerMove={(e) => drag.current && setView((v) => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x), y: drag.current!.vy + (e.clientY - drag.current!.y) }))}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => setView({ zoom: 1, x: 0, y: 0 })}
      >
        {mode === 'side' ? (
          <>
            <div className="sc__pane" data-testid="sc-pane-before">{layer(before, beforeLabel, 'sc-before')}<span className="sc__tag">{beforeLabel}</span></div>
            <div className="sc__pane" data-testid="sc-pane-after">{layer(after, afterLabel, 'sc-after')}<span className="sc__tag sc__tag--after">{afterLabel}</span></div>
          </>
        ) : (
          <div className="sc__pane sc__pane--wipe" data-testid="sc-pane-wipe">
            {layer(before, beforeLabel, 'sc-before')}
            <div className="sc__clip" style={{ clipPath: `inset(0 0 0 ${wipe}%)` }}>{layer(after, afterLabel, 'sc-after')}</div>
            <span className="sc__divider" style={{ left: `${wipe}%` }} />
            <span className="sc__tag">{beforeLabel}</span>
            <span className="sc__tag sc__tag--after">{afterLabel}</span>
            <input className="sc__wipe" type="range" min={0} max={100} value={wipe} onChange={(e) => setWipe(Number(e.target.value))} aria-label="Before and after" data-testid="sc-wipe-slider" />
          </div>
        )}
      </div>
    </div>
  )
}

// ---- saved somewhere else ----------------------------------------------------------------------------------------------

/** Finds a result the program saved in another folder, or lets the user choose the file. */
function FindSavedFile({ session }: { session: ExternalEditSession }): React.JSX.Element {
  const { toast, refresh } = useAtlas()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<ExternalCandidate[] | null>(null)
  const [busy, setBusy] = useState('')
  const load = (): void => {
    setList(null)
    void window.noema.studioExternalCandidates(session.id).then(setList).catch(() => setList([]))
  }
  const finish = async (promise: Promise<ExternalEditSession | null>): Promise<void> => {
    try {
      const done = await promise
      if (done) {
        upsertSession(done)
        await refresh()
        setOpen(false)
      }
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setBusy('')
    }
  }
  if (!open) {
    return <button type="button" className="studio-link" onClick={() => { setOpen(true); load() }} data-testid="ext-find">Saved it somewhere else? Find my saved file…</button>
  }
  return (
    <div className="ext-find" data-testid="ext-find-panel">
      <strong>Pictures changed since you opened it</strong>
      {list === null ? <Spinner size={13} label="Looking in your usual folders" /> : list.length === 0 ? <p className="studio-hint">Nothing recent found in Desktop, Downloads, Documents, Pictures or next to the original. Choose the file yourself.</p> : (
        <ul className="ext-find__list">
          {list.map((c) => (
            <li key={c.path}>
              <div>
                <b>{c.name}</b>{c.likely ? <em> · looks like yours</em> : null}
                <small>{c.folder} · {ago(c.modifiedAt)} · {sizeText(c.size)}</small>
              </div>
              <button type="button" className="button button--ghost" disabled={Boolean(busy)} onClick={() => { setBusy(c.path); void finish(window.noema.studioExternalImportFile(session.id, c.path)) }} data-testid="ext-find-import">{busy === c.path ? 'Importing…' : 'Import'}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="ext-find__row">
        <button type="button" className="button button--ghost" disabled={Boolean(busy)} onClick={() => { setBusy('choose'); void finish(window.noema.studioExternalChoose(session.id)) }} data-testid="ext-choose"><Icon name="folder" size={13} /> Choose a file…</button>
        <button type="button" className="studio-link" onClick={load}>Look again</button>
        <button type="button" className="studio-link" onClick={() => setOpen(false)}>Close</button>
      </div>
      <small className="studio-note">The file is copied, never moved or changed. Photoshop (PSD), PNG, JPEG, WebP, TIFF, BMP and GIF are read.</small>
    </div>
  )
}

// ---- the panel for a session (in the Studio's Edit tab and in the status chip) ---------------------------------------

export function ExternalSessionPanel({ session }: { session: ExternalEditSession }): React.JSX.Element {
  const { toast, refresh } = useAtlas()
  const latest = session.versions[session.versions.length - 1]
  const thumb = useImageItem(latest?.imageId ?? null)
  const importNow = (): void => {
    void window.noema.studioExternalImport(session.id).then((s) => { upsertSession(s); void refresh() }).catch((e) => toast(friendlyError(e), 'error'))
  }
  const waiting = session.status === 'open' || session.status === 'importing'
  return (
    <div className={`studio-session ext-panel is-${session.status}`} data-testid="external-session" data-status={session.status}>
      <p className="ext-panel__line" role="status" aria-live="polite">
        {waiting ? <><Spinner size={13} label="Waiting" /> <span data-testid="ext-status">{session.message}</span></> : session.status === 'imported' ? <><Icon name="check" size={13} /> {session.message}</> : <><Icon name="info" size={13} /> {session.message}</>}
      </p>
      {latest ? (
        <div className="ext-panel__done">
          {thumb ? <img src={thumb.thumbUrl} alt="The edited version" draggable={false} /> : null}
          <div className="ext-panel__actions">
            <button type="button" className="button button--gold" onClick={() => openViewer({ imageId: latest.imageId })} data-testid="ext-view">View edited version</button>
            <button type="button" className="button button--ghost" onClick={() => openViewer({ imageId: latest.imageId, compare: true, partnerId: session.sourceImageId })} data-testid="ext-compare">Compare before/after</button>
            <button type="button" className="button button--ghost" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_EXTERNAL_RESULT_EVENT, { detail: { sessionId: session.id } }))} data-testid="ext-show">Show side by side</button>
          </div>
          <small className="studio-note">{session.versions.length === 1 ? 'One version' : `${session.versions.length} versions`} came back from {session.editorName}. Your original is untouched.</small>
        </div>
      ) : null}
      <div className="ext-panel__row">
        <button type="button" className="button button--ghost" onClick={importNow} disabled={session.status === 'importing'} data-testid="ext-import-now">Import it now</button>
        <button type="button" className="studio-link" onClick={() => void window.noema.studioExternalEnd(session.id).then(() => removeSession(session.id))} data-testid="ext-stop">Stop watching</button>
      </div>
      <FindSavedFile session={session} />
      {waiting && !latest ? <small className="studio-note">Atlas keeps watching even if you close this window.</small> : null}
    </div>
  )
}

// ---- the result window -----------------------------------------------------------------------------------------------------

function ResultDialog({ session, index, onIndex, onClose }: { session: ExternalEditSession; index: number; onIndex: (i: number) => void; onClose: () => void }): React.JSX.Element {
  const { moodboards, refresh, toast } = useAtlas()
  const version = session.versions[Math.min(index, session.versions.length - 1)]!
  const before = useImageItem(session.sourceImageId)
  const after = useImageItem(version.imageId)
  const [boardMenu, setBoardMenu] = useState(false)
  const [more, setMore] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !document.querySelector('.sv')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const go = (detail: Record<string, unknown>): void => {
    onClose()
    window.dispatchEvent(new CustomEvent('atlas:open-studio', { detail }))
  }
  const addToBoard = async (boardId: string, name: string): Promise<void> => {
    setBoardMenu(false)
    try {
      await window.noema.addToMoodboard({ moodboardId: boardId, imageIds: [version.imageId] })
      await refresh()
      toast(`Added to “${name}”. It is already in your library.`, 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }
  const editAgain = async (): Promise<void> => {
    try {
      const next = await window.noema.studioExternalStart(version.imageId, session.editorId)
      upsertSession(next)
      onClose()
      toast(`Opened this version in ${session.editorName}. Save there and the next version comes back here.`, 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  return createPortal(
    <div className="studio-backdrop ext-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="studio ext-result" role="dialog" aria-modal="true" aria-label={`Your ${session.editorName} edit`} data-testid="external-result">
        <header className="studio__head">
          <div>
            <div className="eyebrow">EDITED IN {session.editorName.toUpperCase()}</div>
            <h2 data-testid="ext-result-title"><Icon name="check" size={18} /> Your edit is back in Atlas</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close" data-testid="ext-close"><Icon name="close" size={17} /></button>
        </header>
        <div className="studio__body ext-result__body">
          <p className="ext-result__sum" role="status" data-testid="ext-result-message">
            {session.message} It is saved in your library{version.flattened ? ' as a flattened picture (the layers stay in your Photoshop file)' : ''}, linked to the original, which is untouched. {version.width}×{version.height}, saved {time(version.at)}.
          </p>
          {session.versions.length > 1 ? (
            <div className="ext-result__versions" role="tablist" aria-label="Saves in this session">
              {session.versions.map((v, i) => (
                <button key={v.recordId} type="button" role="tab" aria-selected={i === index} className={i === index ? 'is-on' : ''} onClick={() => onIndex(i)} data-testid="ext-version-tab">Save {i + 1} · {time(v.at)}</button>
              ))}
            </div>
          ) : null}
          {before && after ? <SyncCompare before={before} after={after} beforeLabel="Original" afterLabel={`Edited in ${session.editorName}`} /> : <div className="ext-result__loading"><Spinner label="Opening both pictures" /></div>}
          <div className="ext-result__actions">
            <button type="button" className="button button--gold" onClick={() => openViewer({ imageId: version.imageId })} data-testid="ext-view-edited">View edited version</button>
            <button type="button" className="button button--ghost" onClick={() => openViewer({ imageId: version.imageId, compare: true, partnerId: session.sourceImageId })} data-testid="ext-compare-large">Compare before/after</button>
            <button type="button" className="button button--ghost" onClick={() => void window.noema.revealImage(version.imageId)} data-testid="ext-reveal" title="Show the saved copy in its folder">Show the file</button>
            <span className="ext-result__sep" />
            <button type="button" className="button button--ghost" onClick={() => go({ mode: 'edit', imageId: version.imageId })} data-testid="ext-edit">Edit…</button>
            <button type="button" className="button button--ghost" onClick={() => go({ mode: 'retouch', imageId: version.imageId })} data-testid="ext-retouch">Retouch…</button>
            <button type="button" className="button button--ghost" onClick={() => openViewer({ imageId: version.imageId, panel: 'upscale' })} data-testid="ext-enlarge">Enlarge…</button>
            <div className="ext-result__menu">
              <button type="button" className={`button button--ghost${boardMenu ? ' is-on' : ''}`} onClick={() => setBoardMenu((v) => !v)} aria-expanded={boardMenu} data-testid="ext-board">Add to moodboard</button>
              {boardMenu ? (
                <div className="ext-result__menu-list" role="menu">
                  {moodboards.length === 0 ? <small>No moodboards yet.</small> : moodboards.map((b) => <button key={b.id} type="button" role="menuitem" onClick={() => void addToBoard(b.id, b.name)}>{b.name}</button>)}
                </div>
              ) : null}
            </div>
            <button type="button" className="button button--ghost" onClick={() => void editAgain()} data-testid="ext-edit-again">Edit again in {session.editorName}</button>
          </div>
          <div className="ext-result__foot">
            <small className="studio-note">Atlas is still watching: save again in {session.editorName} and each new save appears here as the next version.</small>
            <button type="button" className="studio-link" onClick={() => setMore((v) => !v)}>{more ? 'Hide' : 'Saved a different file, or somewhere else?'}</button>
            <button type="button" className="studio-link" onClick={() => { void window.noema.studioExternalEnd(session.id).then(() => removeSession(session.id)); onClose() }}>Stop watching</button>
          </div>
          {more ? <FindSavedFile session={session} /> : null}
        </div>
      </section>
    </div>,
    document.body
  )
}

// ---- lives in the app shell --------------------------------------------------------------------------------------------------

export function ExternalHost(): React.JSX.Element | null {
  const sessions = useExternalSessions()
  const [shown, setShown] = useState<{ sessionId: string; index: number } | null>(null)
  const [chipOpen, setChipOpen] = useState(false)
  // Every version that comes back is announced once, by showing it: the window opens by itself for a save that arrived while Atlas was
  // running (or in the last two minutes, in case this window only just learned of the session), whatever else is open.
  const announced = useRef<Set<string>>(new Set())
  const startedAt = useRef(Date.now())
  useEffect(() => {
    for (const s of sessions) {
      s.versions.forEach((v, i) => {
        const key = `${s.id}:${v.recordId}`
        if (announced.current.has(key)) return
        announced.current.add(key)
        if (v.at >= startedAt.current - 120_000) setShown({ sessionId: s.id, index: i })
      })
    }
  }, [sessions])
  useEffect(() => {
    const show = (event: Event): void => {
      const d = (event as CustomEvent<{ sessionId: string; index?: number }>).detail
      const s = sessions.find((x) => x.id === d.sessionId)
      if (s && s.versions.length > 0) setShown({ sessionId: s.id, index: d.index ?? s.versions.length - 1 })
    }
    window.addEventListener(OPEN_EXTERNAL_RESULT_EVENT, show)
    return () => window.removeEventListener(OPEN_EXTERNAL_RESULT_EVENT, show)
  }, [sessions])

  const active = shown ? sessions.find((s) => s.id === shown.sessionId) : null
  const chips = sessions.filter((s) => s.status !== 'error' || s.versions.length === 0)
  return (
    <>
      {chips.length > 0 ? (
        <div className="ext-chip" data-testid="external-chip">
          {chipOpen ? (
            <div className="ext-chip__pop">
              {chips.map((s) => (
                <div key={s.id}>
                  <strong>{s.editorName}</strong>
                  <ExternalSessionPanel session={s} />
                </div>
              ))}
            </div>
          ) : null}
          <button type="button" className="ext-chip__button" onClick={() => setChipOpen((v) => !v)} aria-expanded={chipOpen} data-testid="external-chip-button">
            <Icon name="external" size={13} />
            {chips[0]!.versions.length > 0 ? `${chips[0]!.versions.length} version${chips[0]!.versions.length === 1 ? '' : 's'} back from ${chips[0]!.editorName}` : `Waiting for you to save in ${chips[0]!.editorName}`}
            {chips.length > 1 ? ` (+${chips.length - 1})` : ''}
          </button>
        </div>
      ) : null}
      {active && active.versions.length > 0 ? <ResultDialog session={active} index={shown!.index} onIndex={(i) => setShown({ sessionId: active.id, index: i })} onClose={() => setShown(null)} /> : null}
    </>
  )
}
