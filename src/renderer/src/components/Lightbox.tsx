import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ImageItem } from '@shared/types'
import { Icon } from './Icon'
import { Stars } from './ui'
import { openStudio } from './Studio'
import { openViewer } from './StudioViewer'
import { Provenance } from './Provenance'
import { useAtlas } from '../lib/useAtlas'
import { clearViewing, COMPANION_TOGGLE_EVENT, setViewing } from '../lib/viewing'
import { formatBytes, formatDate, formatDateTime, dimensions, friendlyError } from '../lib/format'

export function Lightbox({
  items,
  initialIndex,
  onClose,
  onUpdate,
  boardId,
  boardName,
  onRemoveFromBoard,
  onFindSimilar
}: {
  items: ImageItem[]
  initialIndex: number
  onClose: () => void
  onUpdate: (item: ImageItem) => void
  boardId?: string
  boardName?: string
  onRemoveFromBoard?: (item: ImageItem) => Promise<void> | void
  onFindSimilar?: (item: ImageItem) => void
}): React.JSX.Element {
  const { moodboards, refresh, toast } = useAtlas()
  const [list, setList] = useState(items)
  const [index, setIndex] = useState(() => Math.max(0, Math.min(items.length - 1, initialIndex)))
  const [loadedImageId, setLoadedImageId] = useState<string | null>(null)
  const [failedImageId, setFailedImageId] = useState<string | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [tagBusy, setTagBusy] = useState(false)
  const [memberships, setMemberships] = useState<string[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const current = list[index] ?? items[0]
  const loaded = Boolean(current && loadedImageId === current.id)
  const imageError = Boolean(current && failedImageId === current.id)

  const applyItem = useCallback(
    (updated: ImageItem) => {
      setList((existing) => existing.map((entry) => (entry.id === updated.id ? updated : entry)))
      onUpdate(updated)
    },
    [onUpdate]
  )

  const go = useCallback(
    (delta: number) => {
      setIndex((currentIndex) => {
        const next = Math.max(0, Math.min(list.length - 1, currentIndex + delta))
        return next
      })
    },
    [list.length]
  )

  const toggleFavorite = useCallback(async () => {
    if (!current) return
    try {
      const updated = await window.noema.updateImage({ id: current.id, favorite: !current.favorite })
      applyItem(updated)
      if (updated.favorite) toast('Kept in Favorites.', 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }, [applyItem, current, toast])

  const rate = useCallback(
    async (rating: number) => {
      if (!current) return
      try {
        const updated = await window.noema.updateImage({ id: current.id, rating })
        applyItem(updated)
      } catch (error) {
        toast(friendlyError(error), 'error')
      }
    },
    [applyItem, current, toast]
  )

  const saveTags = useCallback(
    async (tags: string[]) => {
      if (!current) return
      setTagBusy(true)
      try {
        const updated = await window.noema.updateImage({ id: current.id, tags })
        applyItem(updated)
      } catch (error) {
        toast(friendlyError(error), 'error')
      } finally {
        setTagBusy(false)
      }
    },
    [applyItem, current, toast]
  )

  const addTag = async (): Promise<void> => {
    const value = tagDraft.trim()
    if (!value || !current) return
    if (current.tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setTagDraft('')
      return
    }
    setTagDraft('')
    await saveTags([...current.tags, value])
  }

  const addToBoard = async (id: string, name: string): Promise<void> => {
    if (!current || memberships.includes(id)) return
    try {
      await window.noema.addToMoodboard({ moodboardId: id, imageIds: [current.id] })
      setMemberships((existing) => [...existing, id])
      toast(`Placed in “${name}”.`, 'success')
      await refresh()
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  useEffect(() => {
    setTagDraft('')
    setMemberships([])
    if (!current) return
    let active = true
    void window.noema
      .moodboardsForImage(current.id)
      .then((ids) => {
        if (active) setMemberships(ids)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [current?.id])

  useEffect(() => {
    if (!current) return
    const next = list[index + 1]
    if (!next) return
    const timer = setTimeout(() => {
      const preload = new Image()
      preload.src = next.fullUrl
    }, 280)
    return () => clearTimeout(timer)
  }, [current, index, list])

  // The Companion can be opened from here and knows which picture this is.
  useEffect(() => {
    if (!current) return
    setViewing({ imageId: current.id, filename: current.filename })
    return () => clearViewing(current.id)
  }, [current?.id, current?.filename])

  useEffect(() => {
    containerRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      // The Creative Studio or the large viewer opened from here is in front: the keys belong to it.
      if (document.querySelector('.studio-backdrop, .sv')) return
      const target = event.target as HTMLElement | null
      // The Companion is open beside the picture: its keys (typing, Esc to close it) are its own.
      if (target?.closest?.('.companion, .companion-launcher')) return
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (isTyping || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        go(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        go(1)
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        void toggleFavorite()
      } else if (/^[1-5]$/.test(event.key)) {
        event.preventDefault()
        void rate(Number(event.key))
      } else if (event.key.toLowerCase() === 'e') {
        event.preventDefault()
        if (current) void window.noema.revealImage(current.id)
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault()
        tagInputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [current, go, onClose, rate, toggleFavorite])

  if (!current) return <></>

  const canPrev = index > 0
  const canNext = index < list.length - 1

  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${current.filename} — image viewer`}
      ref={containerRef}
      tabIndex={-1}
      style={{ '--ambient': current.color ?? '#1a1914' } as React.CSSProperties}
    >
      <header className="lightbox__top">
        <button type="button" className="lightbox__close" onClick={onClose}>
          <Icon name="arrowLeft" size={17} />
          <span>Back to the room</span>
          <kbd>Esc</kbd>
        </button>
        <div className="lightbox__counter">
          <span>{String(index + 1).padStart(2, '0')}</span>
          <span className="lightbox__counter-rule" />
          <span>{String(list.length).padStart(2, '0')}</span>
        </div>
        <div className="lightbox__actions">
          {onFindSimilar ? (
            <button
              type="button"
              className="lightbox__reveal"
              onClick={() => onFindSimilar(current)}
              title="Find images that look like this one"
            >
              <Icon name="sparkle" size={15} />
              Find similar
            </button>
          ) : null}
          <button
            type="button"
            className="lightbox__reveal"
            onClick={() => window.dispatchEvent(new Event(COMPANION_TOGGLE_EVENT))}
            title="Talk to Atlas about this picture without leaving the viewer (Ctrl+J)"
            data-testid="lightbox-ask"
          >
            <Icon name="sparkle" size={15} />
            Ask Atlas
          </button>
          <button
            type="button"
            className="lightbox__reveal"
            onClick={() => openStudio({ mode: 'edit', imageId: current.id })}
            title="Change this picture in a new version. The original is kept."
            data-testid="lightbox-edit"
          >
            <Icon name="edit" size={15} />
            Edit…
          </button>
          <button
            type="button"
            className="lightbox__reveal"
            onClick={() => openStudio({ mode: 'retouch', imageId: current.id })}
            title="Remove, heal, blur, sharpen, dodge or burn by painting over a part. The original is kept."
            data-testid="lightbox-retouch"
          >
            <Icon name="sparkle" size={15} />
            Retouch…
          </button>
          <button
            type="button"
            className="lightbox__reveal"
            onClick={() => openViewer({ imageId: current.id, panel: 'upscale' })}
            title="Make a larger copy and compare it with this one"
            data-testid="lightbox-upscale"
          >
            <Icon name="resize" size={15} />
            Enlarge…
          </button>
          <button
            type="button"
            className="lightbox__reveal"
            onClick={() => void window.noema.revealImage(current.id)}
            title="Open the original file location"
          >
            <Icon name="external" size={15} />
            Show original
          </button>
        </div>
      </header>

      <div className="lightbox__body">
        <div className="lightbox__stage">
          <button
            type="button"
            className="lightbox__nav lightbox__nav--prev"
            disabled={!canPrev}
            onClick={() => go(-1)}
            aria-label="Previous image"
          >
            <Icon name="chevronLeft" size={22} />
          </button>

          <div className="lightbox__mat">
            {!loaded && !imageError ? <div className="lightbox__loading" /> : null}
            <img
              key={`thumb-${current.id}`}
              src={current.thumbUrl}
              alt=""
              className={`lightbox__thumb ${loaded ? 'is-hidden' : ''}`}
              draggable={false}
            />
            {!imageError ? (
              <img
                key={current.id}
                src={current.fullUrl}
                alt={current.filename}
                className={`lightbox__image ${loaded ? 'is-loaded' : ''}`}
                draggable={false}
                decoding="async"
                onLoad={() => setLoadedImageId(current.id)}
                onError={() => {
                  setFailedImageId(current.id)
                  setLoadedImageId(current.id)
                }}
              />
            ) : (
              <div className="lightbox__unavailable">
                <Icon name="image" size={32} strokeWidth={1} />
                <strong>This original cannot be shown here.</strong>
                <span>It is still safely indexed. Open its location to view it with another app.</span>
              </div>
            )}
          </div>

          <button
            type="button"
            className="lightbox__nav lightbox__nav--next"
            disabled={!canNext}
            onClick={() => go(1)}
            aria-label="Next image"
          >
            <Icon name="chevronRight" size={22} />
          </button>

          <div className="lightbox__stage-foot">
            <span>
              <Icon name="camera" size={13} /> {dimensions(current.width, current.height)}
            </span>
            <span>{formatBytes(current.bytes)}</span>
            <span className="lightbox__stage-spacer" />
            <span className="lightbox__keys">
              <kbd>←</kbd>
              <kbd>→</kbd> browse
            </span>
          </div>
        </div>

        <aside className="inspector">
          <div className="inspector__scroll">
            <div className="inspector__kicker">
              <span>IMAGE {String(index + 1).padStart(3, '0')}</span>
              {current.missing ? <span className="inspector__missing">ORIGINAL MISSING</span> : null}
            </div>
            <h2 className="inspector__title">{current.filename.replace(/\.[^.]+$/, '')}</h2>
            <button
              type="button"
              className="inspector__path"
              title={`${current.path}\nClick to copy path`}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(current.path)
                  toast('Path copied.', 'success')
                } catch {
                  toast('Could not copy the path.', 'error')
                }
              }}
            >
              <Icon name="folder" size={13} />
              <span>{current.folder}</span>
            </button>

            <div className="inspector__affection">
              <button
                type="button"
                className={`keep-button ${current.favorite ? 'is-on' : ''}`}
                onClick={() => void toggleFavorite()}
                aria-pressed={current.favorite}
              >
                <Icon name="heart" size={18} />
                <span>{current.favorite ? 'Kept' : 'Keep this'}</span>
                <kbd>F</kbd>
              </button>
              <div className="inspector__rating">
                <span className="field__label">Your rating</span>
                <Stars value={current.rating} onChange={(rating) => void rate(rating)} size={20} />
              </div>
            </div>

            <Provenance imageId={current.id} onOpen={(id) => { const at = list.findIndex((x) => x.id === id); if (at >= 0) setIndex(at) }} />

            <div className="inspector__section">
              <div className="inspector__section-title">Details</div>
              <dl className="metadata">
                <div>
                  <dt>Format</dt>
                  <dd>{(current.ext || 'image').toUpperCase()}</dd>
                </div>
                <div>
                  <dt>Dimensions</dt>
                  <dd>{dimensions(current.width, current.height)}</dd>
                </div>
                <div>
                  <dt>File size</dt>
                  <dd>{formatBytes(current.bytes)}</dd>
                </div>
                <div>
                  <dt>File date</dt>
                  <dd>{formatDate(current.mtime)}</dd>
                </div>
                <div>
                  <dt>Added</dt>
                  <dd>{formatDateTime(current.addedAt)}</dd>
                </div>
                <div>
                  <dt>Reviewed</dt>
                  <dd>{current.reviewedAt ? formatDate(current.reviewedAt) : 'Not yet'}</dd>
                </div>
              </dl>
            </div>

            <div className="inspector__section">
              <div className="inspector__section-title">
                Tags
                {tagBusy ? <span className="inspector__saving">saving…</span> : null}
              </div>
              <div className="tag-list">
                {current.tags.map((tag) => (
                  <span className="tag-chip" key={tag}>
                    {tag}
                    <button
                      type="button"
                      onClick={() => void saveTags(current.tags.filter((entry) => entry !== tag))}
                      aria-label={`Remove tag ${tag}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  ref={tagInputRef}
                  className="tag-input"
                  value={tagDraft}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ',') {
                      event.preventDefault()
                      void addTag()
                    } else if (event.key === 'Backspace' && !tagDraft && current.tags.length > 0) {
                      void saveTags(current.tags.slice(0, -1))
                    }
                  }}
                  onBlur={() => void addTag()}
                  placeholder={current.tags.length ? 'Add tag' : 'Add a tag…'}
                  maxLength={32}
                  aria-label="Add a tag"
                />
              </div>
            </div>

            <div className="inspector__section">
              <div className="inspector__section-title">
                Moodboards
                <span className="inspector__section-hint">Click to add</span>
              </div>
              {moodboards.length === 0 ? (
                <p className="inspector__hint">Create a moodboard, then drag images onto it from any room.</p>
              ) : (
                <div className="board-picker">
                  {moodboards.map((board) => {
                    const included = memberships.includes(board.id)
                    return (
                      <button
                        type="button"
                        key={board.id}
                        className={`board-picker__item ${included ? 'is-included' : ''}`}
                        onClick={() => void addToBoard(board.id, board.name)}
                        disabled={included}
                      >
                        <span className="board-picker__thumb">
                          {board.coverIds[0] ? (
                            <img src={`noema://thumb/${board.coverIds[0]}.webp`} alt="" draggable={false} />
                          ) : (
                            <Icon name="boards" size={12} />
                          )}
                        </span>
                        <span className="board-picker__name">{board.name}</span>
                        <Icon name={included ? 'check' : 'plus'} size={13} />
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {boardId && onRemoveFromBoard ? (
              <button
                type="button"
                className="inspector__remove"
                onClick={async () => {
                  await onRemoveFromBoard(current)
                  toast(`Removed from “${boardName ?? 'moodboard'}”. The image remains elsewhere.`, 'info')
                  onClose()
                }}
              >
                <Icon name="close" size={14} /> Remove from this moodboard
              </button>
            ) : null}

            <div className="inspector__refusal">
              <Icon name="shield" size={14} />
              <div>
                <strong>Original untouched here</strong>
                <span>This viewer only reads the file. Use the File Room for deliberate copies or confirmed moves.</span>
              </div>
            </div>

            {current.reviewedAt ? (
              <button
                type="button"
                className="inspector__unreview"
                onClick={async () => {
                  const updated = await window.noema.updateImage({ id: current.id, reviewed: false })
                  applyItem(updated)
                  toast('Returned to the review queue.', 'info')
                }}
              >
                <Icon name="refresh" size={13} /> Mark as unreviewed
              </button>
            ) : null}
          </div>

          <div className="inspector__foot">
            <button type="button" className="button button--quiet" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="button button--gold"
              onClick={() => void window.noema.revealImage(current.id)}
            >
              <Icon name="external" size={14} /> Show in Explorer
            </button>
          </div>
        </aside>
      </div>
    </div>,
    document.body
  )
}
