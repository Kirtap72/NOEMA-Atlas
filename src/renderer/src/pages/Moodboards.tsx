import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type {
  BoardPlacement,
  ImageItem,
  ImageSort,
  Moodboard,
  MoodboardDetail,
  MoodboardImage
} from '@shared/types'
import { useAtlas } from '../lib/useAtlas'
import { useImageDrag } from '../lib/useImageDrag'
import { useDebouncedValue, useImageFeed, useInfiniteScroll } from '../lib/useImageFeed'
import { Icon } from '../components/Icon'
import { ConfirmModal, EmptyState, PromptModal } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { openStudio } from '../components/Studio'
import { formatDate, formatNumber, plural, friendlyError } from '../lib/format'
import type { Route } from '../lib/routing'

const DEFAULT_TILE_WIDTH = 0.24
const BOARD_WORLD_WIDTH = 1500
const BOARD_WORLD_HEIGHT = 1000
const BOARD_WORLD_ASPECT = BOARD_WORLD_WIDTH / BOARD_WORLD_HEIGHT
const MIN_CANVAS_SCALE = 0.02
const MAX_CANVAS_SCALE = 4
const MIN_ITEM_WORLD_WIDTH = 70

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function imageAspectOf(item: ImageItem): number {
  return item.width > 0 && item.height > 0 ? item.width / item.height : BOARD_WORLD_ASPECT
}

export function MoodboardsPage({ onNavigate }: { onNavigate: (route: Route) => void }): React.JSX.Element {
  const { moodboards, createMoodboard, stats } = useAtlas()
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="page page--boards">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">REFERENCE BOARDS · LOOSE THREADS</div>
          <h1 className="page-title">
            Moodboards
            <span className="page-title__count">{formatNumber(moodboards.length)}</span>
          </h1>
          <p className="page-subtitle">
            Gather images into small constellations. Drag from any room onto a board, or open a board and
            arrange its images freely.
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="button button--gold" onClick={() => setCreateOpen(true)}>
            <Icon name="plus" size={16} /> New moodboard
          </button>
        </div>
      </header>

      {moodboards.length === 0 ? (
        <div className="boards-empty">
          <div className="boards-empty__collage" aria-hidden="true">
            <span className="boards-empty__card boards-empty__card--one" />
            <span className="boards-empty__card boards-empty__card--two" />
            <span className="boards-empty__card boards-empty__card--three" />
            <span className="boards-empty__thread" />
          </div>
          <EmptyState
            icon="boards"
            title="A moodboard is a conversation between images."
            copy={
              stats.images > 0
                ? 'Make a board for a palette, a feeling, a project. Then drag images into it from the Collection, the Archive or the Review Room.'
                : 'Add images first, then begin gathering them into small, deliberate constellations.'
            }
          >
            <button type="button" className="button button--gold" onClick={() => setCreateOpen(true)}>
              Create your first board
            </button>
          </EmptyState>
        </div>
      ) : (
        <div className="board-grid">
          {moodboards.map((board) => (
            <MoodboardCard
              key={board.id}
              board={board}
              onOpen={() => onNavigate({ name: 'moodboard', boardId: board.id })}
            />
          ))}
          <button type="button" className="board-card board-card--new" onClick={() => setCreateOpen(true)}>
            <span className="board-card--new__plus">＋</span>
            <span>Begin another board</span>
          </button>
        </div>
      )}

      <PromptModal
        open={createOpen}
        title="Name a new constellation"
        description="A moodboard is only a set of references. No image is copied or changed."
        confirmLabel="Create board"
        placeholder="e.g. Amber interiors, Night studies…"
        onClose={() => setCreateOpen(false)}
        onConfirm={async (name) => {
          const board = await createMoodboard(name)
          if (board) onNavigate({ name: 'moodboard', boardId: board.id })
        }}
      />
    </div>
  )
}

function MoodboardCard({ board, onOpen }: { board: Moodboard; onOpen: () => void }): React.JSX.Element {
  const { toast, refresh } = useAtlas()
  const { dragged, end } = useImageDrag()
  const [dragOver, setDragOver] = useState(false)

  const addDropped = async (event: DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    setDragOver(false)
    const id = event.dataTransfer.getData('application/x-noema-image')
    if (!id) return
    try {
      await window.noema.addToMoodboard({ moodboardId: board.id, imageIds: [id] })
      toast(`Placed in “${board.name}”.`, 'success')
      await refresh()
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      end()
    }
  }

  const covers = board.coverIds

  return (
    <div
      className={`board-card ${dragOver && dragged ? 'is-drop-target' : ''}`}
      onDragOver={(event) => {
        if (!dragged) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => void addDropped(event)}
    >
      <button type="button" className="board-card__open" onClick={onOpen} aria-label={`Open moodboard ${board.name}`}>
        <div className="board-card__cover">
          {covers.length === 0 ? (
            <div className="board-card__blank">
              <span className="board-card__orbit" />
              <Icon name="boards" size={24} strokeWidth={1.1} />
              <span>An empty room for images</span>
            </div>
          ) : (
            <div className={`board-mosaic board-mosaic--${Math.min(4, covers.length)}`}>
              {covers.map((id) => (
                <img key={id} src={`noema://thumb/${id}.webp`} alt="" loading="lazy" draggable={false} />
              ))}
            </div>
          )}
          <div className="board-card__veil" />
          <div className="board-card__title-wrap">
            <span className="board-card__eyebrow">{formatDate(board.updatedAt)}</span>
            <h2 className="board-card__title">{board.name}</h2>
            <span className="board-card__count">{plural(board.imageCount, 'image')}</span>
          </div>
          {dragOver && dragged ? (
            <div className="board-card__drop">
              <Icon name="plus" size={18} /> Add to “{board.name}”
            </div>
          ) : null}
        </div>
      </button>
    </div>
  )
}

export function MoodboardPage({
  boardId,
  onNavigate
}: {
  boardId: string
  onNavigate: (route: Route) => void
}): React.JSX.Element {
  const { moodboards, toast, refresh, renameMoodboard, deleteMoodboard } = useAtlas()
  const [board, setBoard] = useState<MoodboardDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const detail = await window.noema.getMoodboard(boardId)
      setBoard(detail)
    } finally {
      setLoading(false)
    }
  }, [boardId])

  useEffect(() => {
    void load()
  }, [load, moodboards])

  // Changes made by Atlas (or by Tidy) can be undone; this keeps the Undo button honest.
  const [undoInfo, setUndoInfo] = useState<{ id: string; label: string } | null>(null)
  useEffect(() => {
    void window.noema.boardUndoInfo(boardId).then(setUndoInfo).catch(() => setUndoInfo(null))
  }, [boardId, board])
  const tidyBoard = async (): Promise<void> => {
    try {
      await window.noema.boardTidy(boardId)
      await load()
      await refresh()
      toast('Tidied. Use Undo to bring the old layout back.', 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }
  const undoBoard = async (): Promise<void> => {
    try {
      await window.noema.boardUndo(boardId)
      await load()
      await refresh()
      toast('Undone.', 'success')
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  const remove = async (item: ImageItem): Promise<void> => {
    if (!board) return
    try {
      const updated = await window.noema.removeFromMoodboard(board.id, item.id)
      setBoard((current) =>
        current
          ? {
              ...current,
              ...updated,
              images: current.images.filter((entry) => entry.id !== item.id)
            }
          : current
      )
      if (selectedId === item.id) setSelectedId(null)
      toast('Removed from this board. The original is untouched.', 'success')
      await refresh()
    } catch (error) {
      toast(friendlyError(error), 'error')
    }
  }

  const addImage = useCallback(
    async (imageId: string, placement?: BoardPlacement): Promise<void> => {
      if (!board) return
      if (board.images.some((item) => item.id === imageId)) {
        toast('That image is already on this board.', 'info')
        return
      }
      try {
        await window.noema.addToMoodboard({
          moodboardId: board.id,
          imageIds: [imageId],
          placements: placement ? [{ imageId, ...placement }] : undefined
        })
        await load()
        await refresh()
        toast(`Placed in “${board.name}”.`, 'success')
      } catch (error) {
        toast(friendlyError(error), 'error')
      }
    },
    [board, load, refresh, toast]
  )

  const commitLayout = useCallback(
    async (imageId: string, placement: BoardPlacement): Promise<void> => {
      if (!board) return
      try {
        const updated = await window.noema.updateBoardItem({
          moodboardId: board.id,
          imageId,
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
          z: placement.z
        })
        setBoard(updated)
        await refresh()
      } catch (error) {
        toast(friendlyError(error), 'error')
        await load()
      }
    },
    [board, load, refresh, toast]
  )

  const resetProportions = useCallback(
    async (item: MoodboardImage): Promise<void> => {
      if (!board) return
      const aspect = imageAspectOf(item)
      const currentWidth = item.layoutWidth * BOARD_WORLD_WIDTH
      const currentHeight = item.layoutHeight * BOARD_WORLD_HEIGHT
      const centerY = item.y * BOARD_WORLD_HEIGHT + currentHeight / 2
      const nextHeight = currentWidth / aspect
      const nextY = (centerY - nextHeight / 2) / BOARD_WORLD_HEIGHT
      try {
        const updated = await window.noema.updateBoardItem({
          moodboardId: board.id,
          imageId: item.id,
          x: item.x,
          y: nextY,
          width: item.layoutWidth,
          height: nextHeight / BOARD_WORLD_HEIGHT,
          z: item.z
        })
        setBoard(updated)
        await refresh()
        toast('Proportions restored to the original image.', 'success')
      } catch (error) {
        toast(friendlyError(error), 'error')
      }
    },
    [board, refresh, toast]
  )

  if (loading && !board) {
    return (
      <div className="page">
        <div className="board-detail-loading">
          <span className="spinner" />
          <span>Opening the moodboard…</span>
        </div>
      </div>
    )
  }

  if (!board) {
    return (
      <div className="page">
        <EmptyState
          icon="boards"
          title="This moodboard is gone."
          copy="It may have been deleted. Your images are still exactly where they were."
        >
          <button type="button" className="button button--gold" onClick={() => onNavigate({ name: 'moodboards' })}>
            Back to moodboards
          </button>
        </EmptyState>
      </div>
    )
  }

  const selectedIndex = selectedId ? board.images.findIndex((item) => item.id === selectedId) : -1

  return (
    <div className="page page--board-detail">
      <button type="button" className="back-link" onClick={() => onNavigate({ name: 'moodboards' })}>
        <Icon name="arrowLeft" size={15} /> All moodboards
      </button>

      <header className="board-detail-head">
        <div className="board-detail-head__copy">
          <div className="eyebrow">
            MOODBOARD · {plural(board.imageCount, 'image')}
          </div>
          <h1 className="board-detail-title">{board.name}</h1>
          <p className="board-detail-sub">
            Updated {formatDate(board.updatedAt)} · Drag to arrange · Pull a corner to resize · Proportions
            locked · Saved automatically
          </p>
        </div>
        <div className="board-detail-head__actions">
          <button
            type="button"
            className={`button ${libraryOpen ? 'button--gold' : 'button--ghost'}`}
            onClick={() => setLibraryOpen((value) => !value)}
          >
            <Icon name="plus" size={16} /> {libraryOpen ? 'Close library' : 'Add from library'}
          </button>
          <button
            type="button"
            className="button button--gold"
            onClick={() => openStudio({ mode: 'create', boardId: board.id })}
            disabled={board.images.length === 0}
            title="Create something new from this board"
            data-testid="create-artwork"
          >
            <Icon name="sparkle" size={15} /> Create artwork
          </button>
          <button type="button" className="button button--ghost" onClick={() => void tidyBoard()} disabled={board.images.length < 2} title="Arrange the pictures neatly. You can undo it.">
            <Icon name="grid" size={15} /> Tidy
          </button>
          {undoInfo ? (
            <button type="button" className="button button--ghost" onClick={() => void undoBoard()} title={`Undo: ${undoInfo.label}`} data-testid="board-undo">
              <Icon name="refresh" size={15} /> Undo
            </button>
          ) : null}
          <button type="button" className="button button--ghost" onClick={() => setRenameOpen(true)}>
            <Icon name="edit" size={15} /> Rename
          </button>
          <button
            type="button"
            className="icon-button icon-button--danger"
            onClick={() => setDeleteOpen(true)}
            title="Delete moodboard"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </header>

      <div className="board-canvas-shell">
        <div className="board-canvas-toolbar">
          <span>
            <Icon name="drag" size={14} /> Free canvas · {plural(board.images.length, 'image')}
          </span>
          <span className="board-canvas-toolbar__hint">
            {libraryOpen
              ? 'Drag a thumbnail onto the canvas · wheel to zoom'
              : 'Wheel to zoom · Space-drag or middle-drag to pan'}
          </span>
        </div>

        <BoardCanvas
          board={board}
          onOpen={(item) => setSelectedId(item.id)}
          onRemove={(item) => void remove(item)}
          onCommit={(imageId, placement) => void commitLayout(imageId, placement)}
          onDropImage={(imageId, placement) => void addImage(imageId, placement)}
          onOpenLibrary={() => setLibraryOpen(true)}
          onResetProportions={(item) => void resetProportions(item)}
        />

        {libraryOpen ? (
          <BoardLibraryPanel
            board={board}
            onClose={() => setLibraryOpen(false)}
            onAdd={(item) => void addImage(item.id)}
          />
        ) : null}
      </div>

      {selectedIndex >= 0 ? (
        <Lightbox
          items={board.images}
          initialIndex={selectedIndex}
          onClose={() => setSelectedId(null)}
          onUpdate={(updated) => {
            setBoard((current) =>
              current
                ? {
                    ...current,
                    images: current.images.map((item) =>
                      item.id === updated.id ? { ...item, ...updated } : item
                    )
                  }
                : current
            )
          }}
          boardId={board.id}
          boardName={board.name}
          onRemoveFromBoard={async (item) => {
            await remove(item)
            setSelectedId(null)
          }}
        />
      ) : null}

      <PromptModal
        open={renameOpen}
        title="Rename this moodboard"
        initialValue={board.name}
        confirmLabel="Rename"
        onClose={() => setRenameOpen(false)}
        onConfirm={async (name) => {
          const updated = await renameMoodboard(board.id, name)
          if (updated) setBoard((current) => (current ? { ...current, ...updated } : current))
        }}
      />

      <ConfirmModal
        open={deleteOpen}
        title={`Delete “${board.name}”?`}
        description={
          <p>
            This removes the moodboard and its arrangement. The images it contains remain in your Collection
            and Archive, and the original files are never touched.
          </p>
        }
        confirmLabel="Delete moodboard"
        tone="danger"
        onClose={() => setDeleteOpen(false)}
        onConfirm={async () => {
          await deleteMoodboard(board.id)
          onNavigate({ name: 'moodboards' })
        }}
      />
    </div>
  )
}

function BoardCanvas({
  board,
  onOpen,
  onRemove,
  onCommit,
  onDropImage,
  onOpenLibrary,
  onResetProportions
}: {
  board: MoodboardDetail
  onOpen: (item: MoodboardImage) => void
  onRemove: (item: MoodboardImage) => void
  onCommit: (imageId: string, placement: BoardPlacement) => void
  onDropImage: (imageId: string, placement: BoardPlacement) => void
  onOpenLibrary: () => void
  onResetProportions: (item: MoodboardImage) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 0.55 })
  const cameraRef = useRef(camera)
  const [spaceDown, setSpaceDown] = useState(false)
  const spaceRef = useRef(false)
  const [panning, setPanning] = useState(false)
  const panRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    cameraX: number
    cameraY: number
  } | null>(null)
  const didInitialFit = useRef(false)
  const maxZ = board.images.reduce((value, item) => Math.max(value, item.z), 0)
  cameraRef.current = camera

  const fitAll = useCallback((): void => {
    const canvas = canvasRef.current
    if (!canvas) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width <= 0 || height <= 0) return
    let minX = 0
    let minY = 0
    let maxX = BOARD_WORLD_WIDTH
    let maxY = BOARD_WORLD_HEIGHT
    if (board.images.length > 0) {
      minX = Number.POSITIVE_INFINITY
      minY = Number.POSITIVE_INFINITY
      maxX = Number.NEGATIVE_INFINITY
      maxY = Number.NEGATIVE_INFINITY
      for (const item of board.images) {
        minX = Math.min(minX, item.x * BOARD_WORLD_WIDTH)
        minY = Math.min(minY, item.y * BOARD_WORLD_HEIGHT)
        maxX = Math.max(maxX, (item.x + item.layoutWidth) * BOARD_WORLD_WIDTH)
        maxY = Math.max(maxY, (item.y + item.layoutHeight) * BOARD_WORLD_HEIGHT)
      }
    }
    const boundsWidth = Math.max(1, maxX - minX)
    const boundsHeight = Math.max(1, maxY - minY)
    const padding = 70
    const scale = clamp(
      Math.min((width - padding * 2) / boundsWidth, (height - padding * 2) / boundsHeight),
      MIN_CANVAS_SCALE,
      2.2
    )
    setCamera({
      x: (width - boundsWidth * scale) / 2 - minX * scale,
      y: (height - boundsHeight * scale) / 2 - minY * scale,
      scale
    })
  }, [board.images])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      if (!didInitialFit.current && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        didInitialFit.current = true
        fitAll()
      }
    })
    observer.observe(canvas)
    if (!didInitialFit.current && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      didInitialFit.current = true
      fitAll()
    }
    return () => observer.disconnect()
  }, [fitAll])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      const current = cameraRef.current
      const factor = Math.exp(-event.deltaY * 0.0015)
      const nextScale = clamp(current.scale * factor, MIN_CANVAS_SCALE, MAX_CANVAS_SCALE)
      const worldX = (pointerX - current.x) / current.scale
      const worldY = (pointerY - current.y) / current.scale
      setCamera({
        x: pointerX - worldX * nextScale,
        y: pointerY - worldY * nextScale,
        scale: nextScale
      })
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [])

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      return (
        target instanceof HTMLElement &&
        Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
      )
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return
      event.preventDefault()
      spaceRef.current = true
      setSpaceDown(true)
    }
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpaceDown(false)
    }
    const handleBlur = (): void => {
      spaceRef.current = false
      setSpaceDown(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [])

  const startPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 1 && !(event.button === 0 && spaceRef.current)) return
    event.preventDefault()
    event.stopPropagation()
    canvasRef.current?.setPointerCapture(event.pointerId)
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cameraX: cameraRef.current.x,
      cameraY: cameraRef.current.y
    }
    setPanning(true)
  }

  const movePan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) return
    setCamera({
      ...cameraRef.current,
      x: pan.cameraX + (event.clientX - pan.startX),
      y: pan.cameraY + (event.clientY - pan.startY)
    })
  }

  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!panRef.current) return
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId)
    }
    panRef.current = null
    setPanning(false)
  }

  const gridSize = Math.max(12, 150 * camera.scale)
  const gridX = ((camera.x % gridSize) + gridSize) % gridSize
  const gridY = ((camera.y % gridSize) + gridSize) % gridSize

  return (
    <div
      ref={canvasRef}
      className={`board-canvas ${dragOver ? 'is-drag-over' : ''} ${board.images.length === 0 ? 'is-empty' : ''} ${spaceDown ? 'is-space-pan' : ''} ${panning ? 'is-panning' : ''}`}
      style={
        {
          '--grid-size': `${gridSize}px`,
          '--grid-x': `${gridX}px`,
          '--grid-y': `${gridY}px`
        } as React.CSSProperties
      }
      onPointerDown={startPan}
      onPointerMove={movePan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onAuxClick={(event) => event.preventDefault()}
      onDragOver={(event) => {
        const types = Array.from(event.dataTransfer.types)
        if (!types.includes('application/x-noema-image')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDragOver(true)
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget as Node | null
        if (!next || !event.currentTarget.contains(next)) setDragOver(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)
        const imageId = event.dataTransfer.getData('application/x-noema-image')
        if (!imageId || !canvasRef.current) return
        const rect = canvasRef.current.getBoundingClientRect()
        const scale = cameraRef.current.scale
        const worldX = (event.clientX - rect.left - cameraRef.current.x) / scale
        const worldY = (event.clientY - rect.top - cameraRef.current.y) / scale
        const transferredAspect = Number(event.dataTransfer.getData('application/x-noema-image-aspect'))
        const aspect =
          Number.isFinite(transferredAspect) && transferredAspect > 0.01
            ? transferredAspect
            : BOARD_WORLD_ASPECT
        const width = DEFAULT_TILE_WIDTH * BOARD_WORLD_WIDTH
        const height = width / aspect
        const x = (worldX - width / 2) / BOARD_WORLD_WIDTH
        const y = (worldY - height / 2) / BOARD_WORLD_HEIGHT
        onDropImage(imageId, {
          x,
          y,
          width: width / BOARD_WORLD_WIDTH,
          height: height / BOARD_WORLD_HEIGHT,
          z: maxZ + 1
        })
      }}
    >
      <div
        className="board-world"
        style={{
          transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.scale})`
        }}
      >
        {board.images.map((item) => (
          <BoardItem
            key={item.id}
            item={item}
            maxZ={maxZ}
            cameraScale={camera.scale}
            panMode={spaceDown}
            onOpen={onOpen}
            onRemove={onRemove}
            onCommit={onCommit}
            onResetProportions={onResetProportions}
          />
        ))}
      </div>

      {board.images.length === 0 ? (
        <div className="board-canvas__empty">
          <span className="board-canvas__empty-orbit" />
          <Icon name="boards" size={30} strokeWidth={1} />
          <h2>An empty canvas, waiting.</h2>
          <p>Open the library and drag an image onto any point, or add one with a click.</p>
          <button type="button" className="button button--gold" onClick={onOpenLibrary}>
            <Icon name="plus" size={15} /> Open library
          </button>
        </div>
      ) : null}

      <div className="board-canvas__controls" onPointerDown={(event) => event.stopPropagation()}>
        <span className="board-canvas__zoom">{Math.round(camera.scale * 100)}%</span>
        <button type="button" className="button button--quiet" onClick={fitAll}>
          <Icon name="fit" size={14} /> Fit all
        </button>
      </div>

      {dragOver ? (
        <div className="board-canvas__drop">
          <Icon name="plus" size={20} /> Drop to place here
        </div>
      ) : null}
    </div>
  )
}

function BoardItem({
  item,
  maxZ,
  cameraScale,
  panMode,
  onOpen,
  onRemove,
  onCommit,
  onResetProportions
}: {
  item: MoodboardImage
  maxZ: number
  cameraScale: number
  panMode: boolean
  onOpen: (item: MoodboardImage) => void
  onRemove: (item: MoodboardImage) => void
  onCommit: (imageId: string, placement: BoardPlacement) => void
  onResetProportions: (item: MoodboardImage) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<BoardPlacement>({
    x: item.x,
    y: item.y,
    width: item.layoutWidth,
    height: item.layoutHeight,
    z: item.z
  })
  const [active, setActive] = useState(false)
  const itemRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  const interaction = useRef<{
    mode: 'move' | 'resize'
    startX: number
    startY: number
    start: BoardPlacement
    scale: number
    moved: boolean
  } | null>(null)
  const imageAspect = imageAspectOf(item)
  const canReset = item.width > 0 && item.height > 0
  const frameAspect =
    (draft.width * BOARD_WORLD_WIDTH) / Math.max(1, draft.height * BOARD_WORLD_HEIGHT)
  const distorted = canReset && Math.abs(frameAspect / imageAspect - 1) > 0.025

  useEffect(() => {
    if (interaction.current) return
    const next = { x: item.x, y: item.y, width: item.layoutWidth, height: item.layoutHeight, z: item.z }
    setDraft(next)
    draftRef.current = next
  }, [item.x, item.y, item.layoutWidth, item.layoutHeight, item.z])

  const startInteraction = (event: ReactPointerEvent, mode: 'move' | 'resize'): void => {
    if (event.button !== 0 || panMode) return
    if (!itemRef.current) return
    event.preventDefault()
    event.stopPropagation()
    itemRef.current.setPointerCapture(event.pointerId)
    const start = { ...draftRef.current, z: maxZ + 1 }
    interaction.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      start,
      scale: Math.max(0.01, cameraScale),
      moved: false
    }
    setActive(true)
  }

  const handlePointerMove = (event: ReactPointerEvent): void => {
    const state = interaction.current
    if (!state) return
    const dxScreen = event.clientX - state.startX
    const dyScreen = event.clientY - state.startY
    if (Math.abs(dxScreen) > 2 || Math.abs(dyScreen) > 2) state.moved = true
    const dx = dxScreen / (BOARD_WORLD_WIDTH * state.scale)
    const dy = dyScreen / (BOARD_WORLD_HEIGHT * state.scale)
    let next: BoardPlacement
    if (state.mode === 'move') {
      next = {
        ...state.start,
        x: state.start.x + dx,
        y: state.start.y + dy
      }
    } else {
      const startWidth = Math.max(1, state.start.width * BOARD_WORLD_WIDTH)
      const startHeight = Math.max(1, state.start.height * BOARD_WORLD_HEIGHT)
      const widthFactor = (startWidth + dxScreen / state.scale) / startWidth
      const heightFactor = (startHeight + dyScreen / state.scale) / startHeight
      const factor =
        Math.abs(widthFactor - 1) >= Math.abs(heightFactor - 1) ? widthFactor : heightFactor
      const maxWidth = Math.min(20_000, 20 * BOARD_WORLD_HEIGHT * imageAspect)
      const minWidth = Math.max(MIN_ITEM_WORLD_WIDTH, 45 * imageAspect)
      const nextWidth = clamp(startWidth * factor, minWidth, maxWidth)
      const nextHeight = nextWidth / imageAspect
      next = {
        ...state.start,
        width: nextWidth / BOARD_WORLD_WIDTH,
        height: nextHeight / BOARD_WORLD_HEIGHT
      }
    }
    draftRef.current = next
    setDraft(next)
  }

  const finishInteraction = (event: ReactPointerEvent): void => {
    const state = interaction.current
    if (!state) return
    interaction.current = null
    setActive(false)
    if (itemRef.current?.hasPointerCapture(event.pointerId)) {
      itemRef.current.releasePointerCapture(event.pointerId)
    }
    if (!state.moved) {
      if (state.mode === 'move') onOpen(item)
      return
    }
    onCommit(item.id, draftRef.current)
  }

  return (
    <div
      ref={itemRef}
      className={`board-item ${active ? 'is-active' : ''}`}
      data-board-image-id={item.id}
      style={{
        left: `${draft.x * BOARD_WORLD_WIDTH}px`,
        top: `${draft.y * BOARD_WORLD_HEIGHT}px`,
        width: `${draft.width * BOARD_WORLD_WIDTH}px`,
        height: `${draft.height * BOARD_WORLD_HEIGHT}px`,
        zIndex: active ? maxZ + 2 : item.z
      }}
      onPointerDown={(event) => {
        if (panMode || (event.target as HTMLElement).closest('button')) return
        startInteraction(event, 'move')
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={finishInteraction}
      onPointerCancel={finishInteraction}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(item)
        }
      }}
      aria-label={`${item.filename}. Drag to move, use the corner to resize.`}
      title={`${item.filename} — drag to move, corner to resize`}
    >
      <img src={item.thumbUrl} alt={item.filename} draggable={false} />
      <div className="board-item__shade" />
      <div className="board-item__label">{item.filename}</div>
      {distorted ? (
        <button
          type="button"
          className="board-item__reset"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onResetProportions(item)
          }}
          aria-label={`Reset Proportions for ${item.filename}`}
          title="Reset Proportions"
        >
          <Icon name="aspect" size={12} />
        </button>
      ) : null}
      <button
        type="button"
        className="board-item__remove"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onRemove(item)
        }}
        aria-label={`Remove ${item.filename} from this moodboard`}
      >
        <Icon name="close" size={12} />
      </button>
      <button
        type="button"
        className="board-item__resize"
        onPointerDown={(event) => startInteraction(event, 'resize')}
        aria-label={`Resize ${item.filename}`}
        title="Drag to resize · proportions locked"
      >
        <Icon name="resize" size={11} />
      </button>
    </div>
  )
}

function BoardLibraryPanel({
  board,
  onClose,
  onAdd
}: {
  board: MoodboardDetail
  onClose: () => void
  onAdd: (item: ImageItem) => void
}): React.JSX.Element {
  const { roots } = useAtlas()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'keep' | 'pass'>('all')
  const [minRating, setMinRating] = useState(0)
  const [rootId, setRootId] = useState('')
  const [sort, setSort] = useState<ImageSort>('recent')
  const [density, setDensity] = useState(() => Number(localStorage.getItem('atlas.pickerDensity') ?? 1))
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const debouncedSearch = useDebouncedValue(search, 150)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem('atlas.pickerDensity', String(density))
  }, [density])

  const query = useMemo(
    () => ({
      scope: 'archive' as const,
      search: debouncedSearch,
      decision: status === 'keep' || status === 'pass' ? status : undefined,
      minRating,
      rootId: rootId || null,
      sort,
      limit: 60
    }),
    [debouncedSearch, minRating, rootId, sort, status]
  )
  const feed = useImageFeed(query, true)
  useInfiniteScroll(sentinelRef, () => void feed.loadMore(), feed.hasMore && !feed.loading)

  return (
    <aside className="board-library" aria-label="Library images">
      <header className="board-library__head">
        <div>
          <div className="eyebrow">FROM THE LIBRARY</div>
          <h2>Add an image</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close library">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="board-library__search">
        <Icon name="search" size={15} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, folder or tag…"
          aria-label="Search library"
          spellCheck={false}
        />
        {search ? (
          <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
            <Icon name="close" size={13} />
          </button>
        ) : null}
      </div>

      <div className="board-library__status-row">
        <div className="board-library__chips" role="group" aria-label="Decision filter">
          <button
            type="button"
            className={`board-library__chip ${status === 'all' ? 'is-active' : ''}`}
            onClick={() => setStatus('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`board-library__chip ${status === 'keep' ? 'is-active' : ''}`}
            onClick={() => setStatus(status === 'keep' ? 'all' : 'keep')}
          >
            Keep
          </button>
          <button
            type="button"
            className={`board-library__chip ${status === 'pass' ? 'is-active' : ''}`}
            onClick={() => setStatus(status === 'pass' ? 'all' : 'pass')}
          >
            Pass
          </button>
        </div>
        <div className="density-control" role="group" aria-label="Picker thumbnail size">
          {[0, 1, 2].map((level) => (
            <button
              key={level}
              type="button"
              className={`density-control__button ${density === level ? 'is-active' : ''}`}
              onClick={() => setDensity(level)}
              title={['Large thumbnails', 'Medium thumbnails', 'Small thumbnails'][level]}
              aria-label={['Large thumbnails', 'Medium thumbnails', 'Small thumbnails'][level]}
            >
              <span className={`density-glyph density-glyph--${level}`}>
                <i />
                <i />
                <i />
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="board-library__filters">
        <label className="select-field" title="Minimum star rating">
          <Icon name="star" size={13} />
          <select
            value={minRating}
            onChange={(event) => setMinRating(Number(event.target.value))}
            aria-label="Filter picker by rating"
          >
            <option value={0}>Any rating</option>
            <option value={1}>1 star & up</option>
            <option value={2}>2 stars & up</option>
            <option value={3}>3 stars & up</option>
            <option value={4}>4 stars & up</option>
            <option value={5}>5 stars</option>
          </select>
          <Icon name="chevronDown" size={11} className="select-field__chevron" />
        </label>
        <label className="select-field" title="Filter by source folder">
          <Icon name="folder" size={13} />
          <select
            value={rootId}
            onChange={(event) => setRootId(event.target.value)}
            aria-label="Filter picker by source folder"
          >
            <option value="">All sources</option>
            {roots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.name}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={11} className="select-field__chevron" />
        </label>
        <label className="select-field" title="Sort picker images">
          <Icon name="sort" size={13} />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as ImageSort)}
            aria-label="Sort picker images"
          >
            <option value="recent">Recently added</option>
            <option value="captured">Recently seen</option>
            <option value="curated">Curated</option>
            <option value="rating">Highest rated</option>
            <option value="name">Name A–Z</option>
            <option value="folder">Folder A–Z</option>
          </select>
          <Icon name="chevronDown" size={11} className="select-field__chevron" />
        </label>
      </div>

      <p className="board-library__hint">
        Drag a thumbnail onto the canvas to place it exactly. Or tap <strong>＋</strong> to add it.
      </p>

      <div className={`board-library__grid board-library__grid--size-${density}`}>
        {feed.items.map((item) => {
          const included = board.images.some((entry) => entry.id === item.id)
          return (
            <div
              key={item.id}
              className={`board-library__tile ${included ? 'is-included' : ''} ${draggingId === item.id ? 'is-dragging' : ''}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'copy'
                event.dataTransfer.setData('application/x-noema-image', item.id)
                event.dataTransfer.setData(
                  'application/x-noema-image-aspect',
                  String(item.width > 0 && item.height > 0 ? item.width / item.height : BOARD_WORLD_ASPECT)
                )
                event.dataTransfer.setData('text/plain', item.filename)
                setDraggingId(item.id)
              }}
              onDragEnd={() => setDraggingId(null)}
              title={`${item.filename}${included ? ' — already on this board' : ''}`}
              data-image-id={item.id}
            >
              <img src={item.thumbUrl} alt={item.filename} draggable={false} loading="lazy" />
              <span className="board-library__shade" />
              <span className="board-library__name">{item.filename}</span>
              <span className="board-library__meta">
                {item.rating > 0 ? (
                  <span><Icon name="star" size={8} /> {item.rating}</span>
                ) : null}
                {item.decision === 'pass' ? <span className="is-pass">Passed</span> : null}
              </span>
              <button
                type="button"
                className="board-library__add"
                onClick={() => onAdd(item)}
                disabled={included}
                aria-label={included ? `${item.filename} is already on this board` : `Add ${item.filename} to this board`}
              >
                <Icon name={included ? 'check' : 'plus'} size={13} />
              </button>
            </div>
          )
        })}
      </div>

      {feed.loading ? <div className="board-library__status"><span className="spinner" /> Looking…</div> : null}
      {!feed.loading && feed.items.length === 0 ? (
        <div className="board-library__status">No images match these filters.</div>
      ) : null}
      <div ref={sentinelRef} className="board-library__more">
        {feed.hasMore ? (
          <button type="button" className="button button--quiet" onClick={() => void feed.loadMore()}>
            Load more
          </button>
        ) : feed.items.length > 0 ? (
          <span>{formatNumber(feed.total)} images</span>
        ) : null}
      </div>
    </aside>
  )
}
