import { useState, type DragEvent } from 'react'
import type { ImageItem } from '@shared/types'
import { Icon } from './Icon'
import { Stars } from './ui'
import { useImageDrag } from '../lib/useImageDrag'
import { formatBytes, dimensions } from '../lib/format'

export function ImageCard({
  item,
  index,
  boardId,
  onOpen,
  onUpdate,
  onRemove,
  onDropImage,
  selection
}: {
  item: ImageItem
  index: number
  boardId?: string
  onOpen: (index: number) => void
  onUpdate: (item: ImageItem) => void
  onRemove?: (item: ImageItem) => void
  onDropImage?: (draggedId: string, targetIndex: number) => void
  /** When set, the grid is in selection mode: clicking the image selects it instead of opening it. */
  selection?: { selected: boolean; onToggle: (shift: boolean) => void }
}): React.JSX.Element {
  const { start, end } = useImageDrag()
  const [dragOver, setDragOver] = useState(false)
  const [heartPulse, setHeartPulse] = useState(false)
  const ratio = item.width > 0 && item.height > 0 ? item.width / item.height : 0.8

  const toggleFavorite = async (event: React.MouseEvent): Promise<void> => {
    event.stopPropagation()
    const updated = await window.noema.updateImage({ id: item.id, favorite: !item.favorite })
    setHeartPulse(true)
    window.setTimeout(() => setHeartPulse(false), 420)
    onUpdate(updated)
  }

  const handleDragStart = (event: DragEvent<HTMLElement>): void => {
    start(event, item, boardId ? { boardId, index } : undefined)
  }

  return (
    <article
      className={`image-card ${dragOver ? 'is-drop-target' : ''} ${item.favorite ? 'is-favorite' : ''} ${selection?.selected ? 'is-selected' : ''}`}
      style={{ '--tint': item.color ?? '#24231d' } as React.CSSProperties}
      data-image-id={item.id}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={end}
      onDragOver={(event) => {
        if (!onDropImage) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        if (!onDropImage) return
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        const id = event.dataTransfer.getData('application/x-noema-image')
        if (id) onDropImage(id, index)
      }}
    >
      <div className="image-card__media" style={{ aspectRatio: `${ratio}` }}>
        <button
          type="button"
          className="image-card__open"
          onClick={(event) => (selection ? selection.onToggle(event.shiftKey) : onOpen(index))}
          aria-label={selection ? `${selection.selected ? 'Deselect' : 'Select'} ${item.filename}` : `Open ${item.filename}`}
          aria-pressed={selection ? selection.selected : undefined}
        >
          {item.thumbStatus === 'ready' ? (
            <img
              className="image-card__img"
              src={item.thumbUrl}
              alt={item.filename}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : (
            <span className="image-card__unavailable">
              <Icon name="image" size={25} strokeWidth={1.1} />
              <span>Preview unavailable</span>
            </span>
          )}
        </button>

        {selection ? (
          <button
            type="button"
            className={`image-card__select ${selection.selected ? 'is-on' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              selection.onToggle(event.shiftKey)
            }}
            aria-label={`${selection.selected ? 'Deselect' : 'Select'} ${item.filename}`}
            aria-pressed={selection.selected}
          >
            {selection.selected ? <Icon name="check" size={14} strokeWidth={2} /> : null}
          </button>
        ) : null}
        <span className="image-card__shade" aria-hidden="true" />
        <span className="image-card__hint">
          <Icon name="eye" size={13} /> View
        </span>

        <button
          type="button"
          className={`heart-button ${item.favorite ? 'is-on' : ''} ${heartPulse ? 'is-pulsing' : ''}`}
          onClick={(event) => void toggleFavorite(event)}
          aria-label={item.favorite ? `Remove ${item.filename} from favourites` : `Favourite ${item.filename}`}
          aria-pressed={item.favorite}
        >
          <Icon name="heart" size={16} />
        </button>

        {onRemove ? (
          <button
            type="button"
            className="image-card__remove"
            aria-label={`Remove ${item.filename} from this moodboard`}
            onClick={(event) => {
              event.stopPropagation()
              onRemove(item)
            }}
          >
            <Icon name="close" size={13} />
          </button>
        ) : null}

        <div className="image-card__caption">
          <div className="image-card__name" title={item.filename}>
            {item.filename}
          </div>
          <div className="image-card__meta">
            <span>{dimensions(item.width, item.height)}</span>
            <span className="dot-separator">·</span>
            <span>{formatBytes(item.bytes)}</span>
            {item.rating > 0 ? (
              <>
                <span className="dot-separator">·</span>
                <Stars value={item.rating} size={10} />
              </>
            ) : null}
          </div>
        </div>

        {item.missing ? <span className="image-card__missing">Original missing</span> : null}
      </div>
      <div className="image-card__under">
        <span className="image-card__index">{String(index + 1).padStart(2, '0')}</span>
        <span className="image-card__folder" title={item.folder}>
          {item.folder.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ')}
        </span>
        {item.tags.length > 0 ? (
          <span className="image-card__tag">{item.tags[0]}</span>
        ) : null}
        {item.rating > 0 ? (
          <span className="image-card__rating" title={`${item.rating} out of 5`}>
            <Icon name="star" size={9} />
            {item.rating}
          </span>
        ) : null}
      </div>
    </article>
  )
}

export function ImageGrid({
  items,
  loading,
  loadingMore,
  hasMore,
  density,
  onOpen,
  onUpdate,
  onRemove,
  boardId,
  onDropImage,
  onLoadMore,
  sentinelRef,
  empty,
  selection
}: {
  items: ImageItem[]
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  density: number
  onOpen: (index: number) => void
  onUpdate: (item: ImageItem) => void
  onRemove?: (item: ImageItem) => void
  boardId?: string
  onDropImage?: (draggedId: string, targetIndex: number) => void
  onLoadMore: () => void
  sentinelRef: React.RefObject<HTMLDivElement | null>
  empty?: React.ReactNode
  /** Selection mode: which images are selected, and how a click (with or without Shift) changes that. */
  selection?: { selected: Set<string>; onToggle: (index: number, shift: boolean) => void }
}): React.JSX.Element {
  if (loading && items.length === 0) {
    return (
      <div className="masonry masonry--skeleton" style={densityStyle(density)} aria-label="Loading images">
        {Array.from({ length: 10 }).map((_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton-card__wash" style={{ aspectRatio: index % 3 === 0 ? '4 / 5' : '1 / 1' }} />
            <div className="skeleton-card__line" />
            <div className="skeleton-card__line skeleton-card__line--short" />
          </div>
        ))}
      </div>
    )
  }

  if (!loading && items.length === 0) return <>{empty}</>

  return (
    <>
      <div className="masonry" style={densityStyle(density)}>
        {items.map((item, index) => (
          <ImageCard
            key={item.id}
            item={item}
            index={index}
            boardId={boardId}
            onOpen={onOpen}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onDropImage={onDropImage}
            selection={selection ? { selected: selection.selected.has(item.id), onToggle: (shift) => selection.onToggle(index, shift) } : undefined}
          />
        ))}
      </div>
      <div ref={sentinelRef} className="feed-sentinel" aria-live="polite">
        {loadingMore ? (
          <span className="feed-loader">
            <span className="spinner" />
            Gathering more images
          </span>
        ) : hasMore ? (
          <button type="button" className="button button--quiet" onClick={onLoadMore}>
            Load more
          </button>
        ) : items.length > 0 ? (
          <span className="feed-end">The end of this room · {items.length} images</span>
        ) : null}
      </div>
    </>
  )
}

function densityStyle(density: number): React.CSSProperties {
  const widths = [390, 300, 228]
  return { columnWidth: `${widths[Math.max(0, Math.min(2, density))]}px` } as React.CSSProperties
}
