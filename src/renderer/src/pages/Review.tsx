import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageDecision, ImageItem } from '@shared/types'
import { useAtlas } from '../lib/useAtlas'
import { useImageFeed } from '../lib/useImageFeed'
import { Icon } from '../components/Icon'
import { Spinner, Stars } from '../components/ui'
import { formatBytes, formatDate, formatNumber, dimensions } from '../lib/format'

interface ReviewSnapshot {
  favorite: boolean
  rating: number
  reviewedAt: number | null
  decision: ImageDecision | null
}

interface ReviewHistoryEntry extends ReviewSnapshot {
  id: string
  index: number
  label: string
}

interface HistoryItem {
  id: string
  item: ImageItem
  index: number
  label: string
}

interface CachedReviewSession {
  session: ImageItem[]
  cursor: number
  history: ReviewHistoryEntry[]
  decided: number
}

let reviewSessionCache: CachedReviewSession | null = null

export function ReviewPage({
  onNavigateCollection,
  onNavigateFavorites
}: {
  onNavigateCollection: () => void
  onNavigateFavorites: () => void
}): React.JSX.Element {
  const { stats, scan, chooseFolders, updateImage, toast, refresh } = useAtlas()
  const [session, setSession] = useState<ImageItem[]>(() => reviewSessionCache?.session ?? [])
  const [cursor, setCursor] = useState(() => reviewSessionCache?.cursor ?? 0)
  const [busy, setBusy] = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null)
  const [failedImageId, setFailedImageId] = useState<string | null>(null)
  const [history, setHistory] = useState<ReviewHistoryEntry[]>(() => reviewSessionCache?.history ?? [])
  const [decided, setDecided] = useState(() => reviewSessionCache?.decided ?? 0)
  const preloaded = useRef<string | null>(null)

  const query = useMemo(
    () => ({
      scope: 'review' as const,
      sort: 'captured' as const,
      limit: 500
    }),
    []
  )
  const feed = useImageFeed(query)
  const current = session[cursor]
  const loaded = Boolean(current && loadedImageId === current.id)
  const imageError = Boolean(current && failedImageId === current.id)
  const atEnd = session.length > 0 && cursor >= session.length
  const initializing = session.length === 0 && (feed.loading || feed.items.length > 0)

  useEffect(() => {
    reviewSessionCache = { session, cursor, history, decided }
  }, [session, cursor, history, decided])

  useEffect(() => {
    if (feed.items.length === 0) return
    setSession((previous) => {
      const known = new Set(previous.map((item) => item.id))
      const additions = feed.items.filter((item) => !known.has(item.id))
      return additions.length > 0 ? [...previous, ...additions] : previous
    })
  }, [feed.items])

  useEffect(() => {
    if (!current) return
    const next = session[cursor + 1]
    if (next && preloaded.current !== next.id) {
      preloaded.current = next.id
      const timer = setTimeout(() => {
        const image = new Image()
        image.src = next.fullUrl
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [current, cursor, session])

  const previous = useCallback(() => {
    setCursor((value) => Math.max(0, value - 1))
  }, [])

  const skip = useCallback(() => {
    setCursor((value) => Math.min(session.length, value + 1))
  }, [session.length])

  const decide = useCallback(
    async (kind: 'keep' | 'pass' | 'rate', rating = 0) => {
      if (!current || busy) return
      setBusy(true)
      try {
        const wasReviewed = current.reviewedAt !== null || current.decision !== null
        const snapshot: ReviewSnapshot = {
          favorite: current.favorite,
          rating: current.rating,
          reviewedAt: current.reviewedAt,
          decision: current.decision
        }
        const updated =
          kind === 'pass'
            ? await updateImage({ id: current.id, reviewed: true, decision: 'pass' })
            : kind === 'keep'
              ? await updateImage({ id: current.id, favorite: true, reviewed: true, decision: 'keep' })
              : await updateImage({ id: current.id, rating, reviewed: true })
        if (!updated) return
        setSession((existing) => existing.map((item) => (item.id === updated.id ? updated : item)))
        setHistory((existing) =>
          [
            ...existing,
            {
              id: current.id,
              index: cursor,
              label: kind === 'keep' ? 'Kept' : kind === 'pass' ? 'Passed' : `Rated ${rating}`,
              ...snapshot
            }
          ].slice(-250)
        )
        setDecided((value) => value + 1)
        if (wasReviewed) {
          toast('Earlier decision updated.', 'success')
        } else {
          setCursor((value) => value + 1)
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, current, cursor, toast, updateImage]
  )

  const undoLast = useCallback(async () => {
    if (history.length === 0 || busy) {
      if (history.length === 0) toast('There is no decision to undo in this sitting.', 'info')
      return
    }
    const entry = history[history.length - 1]!
    setBusy(true)
    try {
      const restored = await updateImage({
        id: entry.id,
        favorite: entry.favorite,
        rating: entry.rating,
        reviewed: entry.reviewedAt !== null,
        decision: entry.decision
      })
      if (!restored) return
      const existingIndex = session.findIndex((item) => item.id === entry.id)
      setSession((currentSession) => {
        const index = currentSession.findIndex((item) => item.id === entry.id)
        if (index === -1) return [...currentSession, restored]
        return currentSession.map((item) => (item.id === entry.id ? restored : item))
      })
      setHistory((existing) => existing.slice(0, -1))
      setDecided((value) => Math.max(0, value - 1))
      setCursor(existingIndex >= 0 ? existingIndex : session.length)
      toast(`${entry.label} — undone.`, 'success')
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [busy, history, refresh, session, toast, updateImage])

  const loadNextBatch = useCallback(async () => {
    if (batchLoading) return
    setBatchLoading(true)
    const nextCursor = session.length
    try {
      await feed.refresh()
      setCursor(nextCursor)
    } finally {
      setBatchLoading(false)
    }
  }, [batchLoading, feed, session.length])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void undoLast()
        return
      }
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || event.ctrlKey || event.metaKey) return
      if (event.code === 'Space' && target?.tagName === 'BUTTON') return
      if (event.key === 'ArrowRight' || event.key === ' ') {
        event.preventDefault()
        skip()
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        previous()
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        void decide('keep')
      } else if (event.key.toLowerCase() === 'x') {
        event.preventDefault()
        void decide('pass')
      } else if (/^[1-5]$/.test(event.key)) {
        event.preventDefault()
        void decide('rate', Number(event.key))
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [decide, previous, skip, undoLast])

  const reviewProgress = stats.images > 0 ? Math.round(((stats.images - stats.unreviewed) / stats.images) * 100) : 0
  const activeScan = Boolean(scan && ['queued', 'walking', 'processing', 'finalizing'].includes(scan.phase))
  const wasScanning = useRef(activeScan)
  const recentDecisions = useMemo<HistoryItem[]>(() => {
    const seen = new Set<string>()
    const items: HistoryItem[] = []
    for (let index = history.length - 1; index >= 0 && items.length < 8; index -= 1) {
      const entry = history[index]!
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      const item = session.find((candidate) => candidate.id === entry.id)
      if (!item) continue
      items.push({ id: entry.id, item, index: session.indexOf(item), label: entry.label })
    }
    return items
  }, [history, session])

  useEffect(() => {
    if (wasScanning.current && !activeScan) {
      void feed.refresh()
    }
    wasScanning.current = activeScan
  }, [activeScan, feed.refresh])

  const firstUnreviewedIndex = session.findIndex((item) => item.reviewedAt === null)

  if (initializing) {
    return (
      <div className="page review-page">
        <ReviewHeader progress={reviewProgress} remaining={stats.unreviewed} />
        <div className="review-loading">
          <Spinner size={24} />
          <span>Finding the next image…</span>
        </div>
      </div>
    )
  }

  if (!current) {
    return (
      <div className="page review-page">
        <ReviewHeader progress={reviewProgress} remaining={stats.unreviewed} />
        <div className="review-empty">
          <div className="review-empty__sun" aria-hidden="true">
            <span />
          </div>
          <div className="eyebrow">{atEnd ? 'END OF THIS SITTING' : 'THE QUEUE IS QUIET'}</div>
          <h2 className="review-empty__title">
            {stats.images === 0
              ? 'Nothing to review yet.'
              : atEnd
                ? 'You have looked at the whole batch.'
                : 'You have looked at everything.'}
          </h2>
          <p className="review-empty__copy">
            {stats.images === 0
              ? 'Add a folder of images and Atlas will prepare a quiet review queue. Nothing is scanned until you ask.'
              : atEnd
                ? 'Every image in this batch has been considered. You can step back into the sitting, undo a decision, or continue with the next batch.'
                : activeScan
                  ? 'New images are still being indexed. They will join the Review Room when the scan is complete.'
                  : 'Every image has been considered. Return to the collection to live with your choices, or revisit the archive.'}
          </p>
          {recentDecisions.length > 0 ? (
            <div className="review-complete__history">
              <ReviewHistory items={recentDecisions} onSelect={(index) => setCursor(index)} />
            </div>
          ) : null}
          <div className="review-empty__actions">
            {session.length > 0 ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setCursor(Math.max(0, session.length - 1))}
              >
                <Icon name="arrowLeft" size={15} /> Previous image
              </button>
            ) : null}
            {stats.images === 0 ? (
              <button type="button" className="button button--gold" onClick={() => void chooseFolders()}>
                <Icon name="plus" size={16} /> Choose a folder
              </button>
            ) : firstUnreviewedIndex >= 0 ? (
              <button
                type="button"
                className="button button--gold"
                onClick={() => setCursor(firstUnreviewedIndex)}
              >
                <Icon name="review" size={16} /> Continue reviewing
              </button>
            ) : stats.unreviewed > 0 ? (
              <button type="button" className="button button--gold" onClick={() => void loadNextBatch()} disabled={batchLoading}>
                {batchLoading ? <Spinner size={15} /> : <Icon name="arrowRight" size={16} />}
                {batchLoading ? 'Gathering…' : 'Continue with next batch'}
              </button>
            ) : (
              <button type="button" className="button button--gold" onClick={onNavigateCollection}>
                Walk the collection <Icon name="arrowRight" size={16} />
              </button>
            )}
            {history.length > 0 ? (
              <button type="button" className="button button--quiet" onClick={() => void undoLast()} disabled={busy}>
                <Icon name="refresh" size={14} /> Undo last decision
              </button>
            ) : null}
            <button type="button" className="button button--ghost" onClick={onNavigateFavorites}>
              See favorites
            </button>
          </div>
        </div>
      </div>
    )
  }

  const isEarlierDecision = current.reviewedAt !== null || current.decision !== null

  return (
    <div
      className="review-page"
      style={{ '--ambient': current.color ?? '#1a1914' } as React.CSSProperties}
    >
      <ReviewHeader progress={reviewProgress} remaining={stats.unreviewed} />

      <div className="review-room">
        <section className="review-stage">
          <div className="review-stage__ambient" aria-hidden="true" />
          <div className="review-stage__topline">
            <span>
              IMAGE {String(cursor + 1).padStart(2, '0')} / {String(session.length).padStart(2, '0')}
            </span>
            <span className="review-stage__session">
              {decided > 0 ? `${decided} decision${decided === 1 ? '' : 's'} this sitting` : 'A fresh sitting'}
            </span>
          </div>

          <button
            type="button"
            className="review-nav review-nav--prev"
            onClick={previous}
            disabled={cursor === 0}
            aria-label="Previous image"
          >
            <Icon name="chevronLeft" size={22} />
          </button>

          <div className="review-image">
            {!loaded && !imageError ? <div className="review-image__loading" /> : null}
            {!imageError ? (
              <>
                <img
                  key={`thumb-${current.id}`}
                  src={current.thumbUrl}
                  alt=""
                  className={`review-image__thumb ${loaded ? 'is-hidden' : ''}`}
                  draggable={false}
                />
                <img
                  key={current.id}
                  src={current.fullUrl}
                  alt={current.filename}
                  className={`review-image__full ${loaded ? 'is-loaded' : ''}`}
                  draggable={false}
                  decoding="async"
                  onLoad={() => setLoadedImageId(current.id)}
                  onError={() => {
                    setFailedImageId(current.id)
                    setLoadedImageId(current.id)
                  }}
                />
              </>
            ) : (
              <div className="review-image__unavailable">
                <Icon name="image" size={34} strokeWidth={1} />
                <span>Preview unavailable. The original is still catalogued.</span>
                <button type="button" className="button button--ghost" onClick={() => void window.noema.revealImage(current.id)}>
                  Show original
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className="review-nav review-nav--next"
            onClick={skip}
            aria-label="Next image"
          >
            <Icon name="chevronRight" size={22} />
          </button>

          <div className="review-stage__foot">
            <span>
              <Icon name="camera" size={13} /> {dimensions(current.width, current.height)}
            </span>
            <span>{formatBytes(current.bytes)}</span>
            <span className="review-stage__dot">·</span>
            <span>{formatDate(current.mtime)}</span>
            <span className="review-stage__spacer" />
            <span className="review-stage__keys">
              <kbd>F</kbd> keep <kbd>X</kbd> pass
            </span>
          </div>
        </section>

        <aside className="review-panel">
          <div className="review-panel__eyebrow">
            {isEarlierDecision ? 'EARLIER DECISION' : 'NOW LOOKING AT'}
          </div>
          {isEarlierDecision ? (
            <div className="review-panel__decided">
              {current.decision === 'pass' ? 'Passed' : current.favorite ? 'Kept' : 'Rated'}
              <span>You can change this without losing your place.</span>
            </div>
          ) : null}
          <h1 key={current.id} className="review-panel__title">{current.filename.replace(/\.[^.]+$/, '')}</h1>
          <div className="review-panel__folder" title={current.folder}>
            <Icon name="folder" size={13} /> {current.folder}
          </div>

          <div className="review-panel__meta">
            <span>{(current.ext || 'image').toUpperCase()}</span>
            <span>{dimensions(current.width, current.height)}</span>
            <span>{formatBytes(current.bytes)}</span>
          </div>

          <div className="review-question">
            <div className="review-question__label">How does it feel?</div>
            <Stars
              value={current.rating}
              onChange={(rating) => void decide('rate', rating)}
              size={30}
              className="stars--review"
            />
            <div className="review-question__hint">
              {current.rating > 0 ? `Rated ${current.rating} / 5` : 'Rate from 1 to 5, or simply decide.'}
            </div>
          </div>

          <div className="review-actions">
            <button type="button" className="review-action review-action--pass" onClick={() => void decide('pass')} disabled={busy}>
              <span className="review-action__icon">
                <Icon name="close" size={18} />
              </span>
              <span className="review-action__copy">
                <strong>{current.decision === 'pass' ? 'Passed' : 'Pass'}</strong>
                <small>Still in the Archive</small>
              </span>
              <kbd>X</kbd>
            </button>
            <button type="button" className="review-action review-action--keep" onClick={() => void decide('keep')} disabled={busy}>
              <span className="review-action__icon">
                <Icon name="heart" size={18} />
              </span>
              <span className="review-action__copy">
                <strong>{current.favorite ? 'Kept' : 'Keep'}</strong>
                <small>Add to Favorites</small>
              </span>
              <kbd>F</kbd>
            </button>
          </div>

          <div className="review-panel__secondary">
            <button type="button" className="quiet-action" onClick={skip}>
              Next image <kbd>→</kbd>
            </button>
            <button
              type="button"
              className="quiet-action"
              onClick={() => void undoLast()}
              disabled={history.length === 0 || busy}
              title="Undo the last decision"
            >
              <Icon name="refresh" size={13} /> Undo{history.length > 0 ? ` ${history[history.length - 1]!.label.toLowerCase()}` : ''}
            </button>
          </div>

          {recentDecisions.length > 0 ? (
            <ReviewHistory
              items={recentDecisions}
              currentId={current.id}
              onSelect={(index) => setCursor(index)}
              compact
            />
          ) : null}

          <div className="review-panel__divider" />
          <div className="review-panel__note">
            <Icon name="shield" size={14} />
            <p>
              Passing an image never deletes anything. It leaves the review queue and remains searchable in the
              Archive, with its rating and tags intact. Every decision can be undone while you are in this sitting.
            </p>
          </div>

          <div className="review-panel__tip">
            <span className="review-panel__tip-label">KEYBOARD</span>
            <span><kbd>1</kbd>–<kbd>5</kbd> rate</span>
            <span><kbd>←</kbd><kbd>→</kbd> browse</span>
            <span><kbd>Ctrl</kbd><kbd>Z</kbd> undo</span>
          </div>
        </aside>
      </div>
    </div>
  )
}

function ReviewHistory({
  items,
  currentId,
  onSelect,
  compact = false
}: {
  items: HistoryItem[]
  currentId?: string
  onSelect: (index: number) => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className={`review-history ${compact ? 'review-history--compact' : ''}`}>
      <div className="review-history__head">
        <span>THIS SITTING</span>
        <small>Click to revisit</small>
      </div>
      <div className="review-history__items">
        {items.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`review-history__item ${entry.id === currentId ? 'is-current' : ''}`}
            onClick={() => onSelect(entry.index)}
            title={`${entry.item.filename} — ${entry.label}`}
          >
            <img src={entry.item.thumbUrl} alt="" draggable={false} />
            <span className="review-history__mark">
              {entry.item.decision === 'pass' ? <Icon name="close" size={10} /> : <Icon name="heart" size={10} />}
            </span>
            {entry.item.rating > 0 ? <span className="review-history__rating">{entry.item.rating}</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function ReviewHeader({ progress, remaining }: { progress: number; remaining: number }): React.JSX.Element {
  return (
    <header className="review-header">
      <div>
        <div className="eyebrow">THE REVIEW ROOM · ONE IMAGE AT A TIME</div>
        <div className="review-header__line">
          <h1 className="review-header__title">Follow your eye.</h1>
          <span className="review-header__remaining">
            {remaining > 0 ? `${formatNumber(remaining)} still to look at` : 'Everything considered'}
          </span>
        </div>
      </div>
      <div className="review-progress">
        <div className="review-progress__numbers">
          <span>{progress}% of the collection considered</span>
        </div>
        <div className="review-progress__bar">
          <span style={{ width: `${Math.max(1, progress)}%` }} />
        </div>
      </div>
    </header>
  )
}
