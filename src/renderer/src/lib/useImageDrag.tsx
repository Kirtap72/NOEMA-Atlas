import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode
} from 'react'
import type { ImageItem } from '@shared/types'
import { useAtlas } from './useAtlas'
import { friendlyError } from './format'

export interface DraggedImage {
  image: ImageItem
  originBoardId?: string
  originIndex?: number
}

interface DragContextValue {
  dragged: DraggedImage | null
  start: (event: DragEvent<HTMLElement>, image: ImageItem, origin?: { boardId: string; index: number }) => void
  end: () => void
}

const DragContext = createContext<DragContextValue | null>(null)

export function ImageDragProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [dragged, setDragged] = useState<DraggedImage | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const end = useCallback(() => {
    if (clearTimer.current) clearTimeout(clearTimer.current)
    clearTimer.current = setTimeout(() => setDragged(null), 40)
  }, [])

  const start = useCallback(
    (event: DragEvent<HTMLElement>, image: ImageItem, origin?: { boardId: string; index: number }) => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
      event.dataTransfer.effectAllowed = 'copyMove'
      event.dataTransfer.setData('application/x-noema-image', image.id)
      event.dataTransfer.setData('text/plain', image.filename)
      setDragged({ image, originBoardId: origin?.boardId, originIndex: origin?.index })
    },
    []
  )

  useEffect(() => {
    const handleEnd = (): void => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
      clearTimer.current = setTimeout(() => setDragged(null), 60)
    }
    window.addEventListener('dragend', handleEnd)
    window.addEventListener('drop', handleEnd)
    return () => {
      window.removeEventListener('dragend', handleEnd)
      window.removeEventListener('drop', handleEnd)
      if (clearTimer.current) clearTimeout(clearTimer.current)
    }
  }, [])

  return <DragContext.Provider value={{ dragged, start, end }}>{children}</DragContext.Provider>
}

export function useImageDrag(): DragContextValue {
  const context = useContext(DragContext)
  if (!context) throw new Error('useImageDrag must be used inside ImageDragProvider')
  return context
}

export function readDraggedId(event: DragEvent<HTMLElement>): string | null {
  const id = event.dataTransfer.getData('application/x-noema-image')
  return id || null
}

export function DragTray(): React.JSX.Element | null {
  const { dragged, end } = useImageDrag()
  const { moodboards, toast, refresh, createMoodboard } = useAtlas()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)

  if (!dragged) return null

  const addToBoard = async (boardId: string, boardName: string): Promise<void> => {
    setSaving(true)
    try {
      await window.noema.addToMoodboard({ moodboardId: boardId, imageIds: [dragged.image.id] })
      toast(`Placed in “${boardName}”.`, 'success')
      await refresh()
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setSaving(false)
      end()
    }
  }

  const createDroppedBoard = async (event: React.DragEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    if (saving) return
    setSaving(true)
    try {
      const board = await createMoodboard('Untitled board')
      if (board) {
        await window.noema.addToMoodboard({ moodboardId: board.id, imageIds: [dragged.image.id] })
        toast(`Created “Untitled board” with this image. Rename it from Moodboards.`, 'success')
        await refresh()
      }
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setSaving(false)
      end()
    }
  }

  const createAndAdd = async (): Promise<void> => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const board = await createMoodboard(name.trim())
      if (board) {
        await window.noema.addToMoodboard({ moodboardId: board.id, imageIds: [dragged.image.id] })
        toast(`Placed in “${board.name}”.`, 'success')
        await refresh()
      }
      setCreating(false)
      setName('')
      end()
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="drag-tray" role="region" aria-label="Add image to a moodboard">
      <div className="drag-tray__intro">
        <span className="drag-tray__eyebrow">CARRY TO</span>
        <strong className="drag-tray__title">A moodboard</strong>
        <span className="drag-tray__file" title={dragged.image.filename}>
          {dragged.image.filename}
        </span>
      </div>
      <div className="drag-tray__boards">
        {moodboards.map((board) => (
          <button
            key={board.id}
            type="button"
            className={`drag-tray__board ${hovered === board.id ? 'is-over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setHovered(board.id)
            }}
            onDragLeave={() => setHovered(null)}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setHovered(null)
              if (!saving) void addToBoard(board.id, board.name)
            }}
          >
            <span className="drag-tray__board-cover">
              {board.coverIds[0] ? (
                <img src={`noema://thumb/${board.coverIds[0]}.webp`} alt="" draggable={false} />
              ) : (
                <span className="drag-tray__empty-mark">✳</span>
              )}
            </span>
            <span className="drag-tray__board-name">{board.name}</span>
          </button>
        ))}
        {creating ? (
          <form
            className="drag-tray__create"
            onSubmit={(event) => {
              event.preventDefault()
              void createAndAdd()
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New board name"
              maxLength={80}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setCreating(false)
              }}
            />
            <button type="submit" disabled={!name.trim() || saving}>
              Add
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="drag-tray__new"
            onClick={() => setCreating(true)}
            onDragOver={(event) => {
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={(event) => void createDroppedBoard(event)}
            title="Drop here to start a new moodboard with this image"
          >
            <span>＋</span>
            New board
          </button>
        )}      </div>
      <button type="button" className="drag-tray__close" onClick={end} aria-label="Stop dragging">
        ×
      </button>
    </div>
  )
}
