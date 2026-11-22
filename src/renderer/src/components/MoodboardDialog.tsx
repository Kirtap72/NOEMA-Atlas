import { useEffect, useId, useState } from 'react'
import type { Moodboard } from '@shared/types'
import { Modal } from './ui'
import { Icon } from './Icon'
import { friendlyError, formatNumber } from '../lib/format'
import { useAtlas } from '../lib/useAtlas'

/** Splits a long list of ids into the pieces the main process accepts in one call. */
export async function addInChunks(boardId: string, ids: string[]): Promise<void> {
  for (let start = 0; start < ids.length; start += 500) {
    await window.noema.addToMoodboard({ moodboardId: boardId, imageIds: ids.slice(start, start + 500) })
  }
}

export function imagesWord(count: number): string {
  return `${formatNumber(count)} image${count === 1 ? '' : 's'}`
}

/** What a moodboard action will use: only the images the user picked, or everything in the group. */
export type BoardSource = 'selected' | 'all'

export function sourceTitle(source: BoardSource, count: number): string {
  return source === 'selected' ? `Create moodboard from ${imagesWord(count).replace(/ image/, ' selected image')}` : `Create moodboard from all ${imagesWord(count)}`
}

/**
 * Confirms a moodboard action before anything is changed. It always states exactly how many images will be used and
 * where they come from, so "6 selected images" and "all 30 images" can never be mistaken for each other.
 */
export function MoodboardDialog({
  source,
  loadIds,
  defaultName,
  onClose,
  onDone
}: {
  source: BoardSource
  /** The ids to use. For "selected" this is the picked set; for "all" it is every image in the group. */
  loadIds: () => Promise<string[]>
  defaultName: string
  onClose: () => void
  onDone?: (result: { boardId: string; name: string; count: number }) => void
}): React.JSX.Element {
  const { toast } = useAtlas()
  const titleId = useId()
  const [ids, setIds] = useState<string[] | null>(null)
  const [boards, setBoards] = useState<Moodboard[] | null>(null)
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [name, setName] = useState(defaultName)
  const [boardId, setBoardId] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void loadIds()
      .then((list) => live && setIds(list))
      .catch((error: unknown) => live && setProblem(friendlyError(error)))
    void window.noema
      .listMoodboards()
      .then((list) => live && setBoards(list))
      .catch(() => live && setBoards([]))
    return () => {
      live = false
    }
    // The ids are read once when the dialog opens; the dialog is remounted for the next action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const count = ids?.length ?? 0
  const chosenBoard = boards?.find((board) => board.id === boardId) ?? null
  const ready = ids !== null && count > 0 && (mode === 'new' ? name.trim() !== '' : chosenBoard !== null)

  const confirm = async (): Promise<void> => {
    if (!ids || !ready) return
    setBusy(true)
    setProblem(null)
    try {
      let target: { id: string; name: string }
      if (mode === 'new') target = await window.noema.createMoodboard(name.trim())
      else target = chosenBoard!
      await addInChunks(target.id, ids)
      toast(
        mode === 'new'
          ? `Made the moodboard “${target.name}” with ${imagesWord(ids.length)}.`
          : `Added ${imagesWord(ids.length)} to “${target.name}”.`,
        'success'
      )
      onDone?.({ boardId: target.id, name: target.name, count: ids.length })
      onClose()
    } catch (error) {
      setProblem(friendlyError(error))
      setBusy(false)
    }
  }

  const heading = ids === null ? 'Create moodboard' : sourceTitle(source, count)

  return (
    <Modal open onClose={onClose} className="moodboard-dialog" labelledBy={titleId}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void confirm()
        }}
      >
        <div className="eyebrow">MOODBOARD</div>
        <h2 id={titleId} className="moodboard-dialog__title">{heading}</h2>
        <p className="moodboard-dialog__count" data-source={source}>
          {ids === null ? (
            'Counting the images…'
          ) : count === 0 ? (
            'There are no images to add.'
          ) : source === 'selected' ? (
            <>
              <strong>{imagesWord(count)}</strong> you selected will be used. The other images of this group are left out.
            </>
          ) : (
            <>
              <strong>{imagesWord(count)}</strong>, every image in this group, will be used.
            </>
          )}
        </p>

        <div className="moodboard-dialog__modes" role="radiogroup" aria-label="Where the images go">
          <label className={mode === 'new' ? 'is-on' : ''}>
            <input type="radio" name="board-mode" checked={mode === 'new'} onChange={() => setMode('new')} />
            <span>A new moodboard</span>
          </label>
          <label className={mode === 'existing' ? 'is-on' : ''}>
            <input type="radio" name="board-mode" checked={mode === 'existing'} onChange={() => setMode('existing')} />
            <span>An existing moodboard</span>
          </label>
        </div>

        {mode === 'new' ? (
          <label className="moodboard-dialog__field">
            <span>Name</span>
            <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-label="New moodboard name" />
          </label>
        ) : (
          <div className="moodboard-dialog__boards" role="listbox" aria-label="Existing moodboards">
            {boards === null ? <span className="hint">Loading…</span> : boards.length === 0 ? <span className="hint">No moodboards yet. Choose “A new moodboard”.</span> : null}
            {boards?.map((board) => (
              <button
                key={board.id}
                type="button"
                role="option"
                aria-selected={board.id === boardId}
                className={board.id === boardId ? 'is-on' : ''}
                onClick={() => setBoardId(board.id)}
              >
                <span>{board.name}</span>
                <small>{formatNumber(board.imageCount)} now</small>
              </button>
            ))}
          </div>
        )}

        {problem ? (
          <div className="inline-error">
            <Icon name="info" size={16} /> {problem}
          </div>
        ) : null}

        <p className="moodboard-dialog__safe">Your original files are never moved or changed; a moodboard only refers to them.</p>
        <div className="moodboard-dialog__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="button button--gold" disabled={!ready || busy}>
            <Icon name="boards" size={16} />{' '}
            {mode === 'new'
              ? `Create moodboard with ${imagesWord(count)}`
              : chosenBoard
                ? `Add ${imagesWord(count)} to “${chosenBoard.name}”`
                : 'Choose a moodboard'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * The bar shown while selecting images. Two clearly different actions: one for exactly the picked images, one for
 * everything in the group. Both open the confirmation dialog, which shows the exact count.
 */
export function SelectionBar({
  picked,
  total,
  onSelectAll,
  onClear,
  onSelectedBoard,
  onAllBoard,
  children
}: {
  children?: React.ReactNode
  picked: number
  total: number
  onSelectAll: () => void
  onClear: () => void
  onSelectedBoard: () => void
  onAllBoard: () => void
}): React.JSX.Element {
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected images">
      <strong>{formatNumber(picked)} selected</strong>
      <button type="button" className="button button--quiet" onClick={onSelectAll}>Select all {formatNumber(total)}</button>
      <button type="button" className="button button--quiet" disabled={picked === 0} onClick={onClear}>Clear</button>
      <span className="selection-bar__hint">Shift-click selects a range.</span>
      {children}
      <div className="selection-bar__actions">
        <button type="button" className="button button--gold" disabled={picked === 0} onClick={onSelectedBoard} data-action="selected-board">
          <Icon name="boards" size={16} /> {picked === 0 ? 'Select images to make a moodboard' : sourceTitle('selected', picked)}
        </button>
        <button type="button" className="button button--ghost" onClick={onAllBoard} data-action="all-board">
          <Icon name="boards" size={16} /> {sourceTitle('all', total)}
        </button>
      </div>
    </div>
  )
}
