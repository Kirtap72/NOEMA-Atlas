import { useEffect, useMemo, useRef, useState } from 'react'
import type { AssistantBlock } from '@shared/assistant'
import type { CuratedLeftOut, CuratedPick, CuratedProposalData, CurationRole } from '@shared/curation'
import type { ImageItem, Moodboard } from '@shared/types'
import { Icon } from './Icon'

type ProposalBlock = Extract<AssistantBlock, { type: 'proposal' }>

const ROLE_LABEL: Record<CurationRole, string> = {
  finished: 'Finished work',
  experimental: 'Experimental',
  technical: 'Working image',
  unclear: 'Check this one'
}

const LEFT_OUT_TITLE: Record<CuratedLeftOut['why'], string> = {
  technical: 'Looks like a technical working image',
  duplicate: 'Repeats a stronger image',
  weak: 'Fits less well',
  passed: 'You passed on these'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

interface Entry {
  imageId: string
  role: CurationRole
  reasons: string[]
  match: number | null
  uncertain: boolean
}

/**
 * The review panel for a curated selection. The user sees every proposed image with the reasons it was chosen and can
 * keep it, reject it or replace it with the next best choice, add one that was left out, and only then create the
 * moodboard. Nothing happens before that.
 */
export function CuratedReview({
  block,
  busy,
  onOpenImages,
  onSelection,
  onAnswer
}: {
  block: ProposalBlock
  busy: boolean
  onOpenImages: (items: ImageItem[], index: number) => void
  onSelection: (ids: string[]) => void
  onAnswer: (accept: boolean, options?: { selection: string[]; name: string; boardId: string | null }) => void
}): React.JSX.Element {
  const proposal = block.proposal as CuratedProposalData
  const items = useMemo(() => new Map((block.items ?? []).map((item) => [item.id, item])), [block.items])
  const entries = useMemo(() => {
    const map = new Map<string, Entry>()
    for (const pick of [...proposal.picks, ...proposal.alternatives] as CuratedPick[]) map.set(pick.imageId, pick)
    for (const left of proposal.leftOut) {
      if (!map.has(left.imageId)) map.set(left.imageId, { imageId: left.imageId, role: left.role, reasons: [left.detail], match: null, uncertain: left.role !== 'technical' ? false : true })
    }
    return map
  }, [proposal])

  const [selection, setSelection] = useState<string[]>(() => (proposal.selection ?? proposal.imageIds).filter((id) => entries.has(id)))
  const [rejected, setRejected] = useState<string[]>(() => proposal.imageIds.filter((id) => !(proposal.selection ?? proposal.imageIds).includes(id)))
  const [name, setName] = useState(proposal.name)
  const [target, setTarget] = useState<string>('new')
  const [boards, setBoards] = useState<Moodboard[] | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const pending = block.status === 'pending'

  useEffect(() => {
    if (!pending) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => onSelection(selection), 400)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
    // onSelection is stable enough for a debounce; the selection is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  const loadBoards = (): void => {
    if (boards === null) void window.noema.listMoodboards().then(setBoards).catch(() => setBoards([]))
  }

  const unusedAlternatives = proposal.alternatives.filter((a) => !selection.includes(a.imageId) && !rejected.includes(a.imageId))
  const replace = (id: string): void => {
    const next = unusedAlternatives[0]
    if (!next) {
      setNote('There are no more alternatives that fit as well. You can still add one from “Left out”, or remove this image.')
      return
    }
    setNote(null)
    setSelection((current) => current.map((entry) => (entry === id ? next.imageId : entry)))
    setRejected((current) => [...current, id])
  }
  const remove = (id: string): void => {
    setNote(null)
    setSelection((current) => current.filter((entry) => entry !== id))
    setRejected((current) => [...current, id])
  }
  const restore = (id: string): void => {
    setRejected((current) => current.filter((entry) => entry !== id))
    setSelection((current) => (current.includes(id) ? current : [...current, id]))
  }
  const add = (id: string): void => {
    setNote(null)
    setSelection((current) => (current.includes(id) ? current : [...current, id]))
    setRejected((current) => current.filter((entry) => entry !== id))
  }

  const open = (ids: string[], id: string): void => {
    const list = ids.map((i) => items.get(i)).filter((i): i is ImageItem => Boolean(i))
    const at = list.findIndex((i) => i.id === id)
    if (at >= 0) onOpenImages(list, at)
  }

  const leftGroups = (['technical', 'duplicate', 'weak', 'passed'] as const)
    .map((why) => ({ why, list: proposal.leftOut.filter((l) => l.why === why && !selection.includes(l.imageId)) }))
    .filter((group) => group.list.length > 0)

  if (!pending) {
    const finalIds = proposal.selection ?? proposal.imageIds
    return (
      <div className={`proposal proposal--${block.status} curate`}>
        <div className="proposal__eyebrow">A curated selection</div>
        <strong>{block.title}</strong>
        <div className="proposal__thumbs">
          {finalIds.slice(0, 12).map((id) => (items.get(id)?.thumbStatus === 'ready' ? <img key={id} src={items.get(id)!.thumbUrl} alt="" draggable={false} /> : null))}
          {finalIds.length > 12 ? <span>+{finalIds.length - 12}</span> : null}
        </div>
        <p className="proposal__result"><Icon name={block.status === 'applied' ? 'check' : 'close'} size={13} /> {block.result}</p>
      </div>
    )
  }

  return (
    <div className="proposal proposal--pending curate" data-testid="curated-review">
      <div className="proposal__eyebrow">Review before anything is made</div>
      <strong>{block.title}</strong>
      <p className="curate__summary" data-testid="curate-summary">
        {plural(selection.length, 'image')} proposed{proposal.requested > selection.length ? ` of ${proposal.requested} asked for` : ''} · from {proposal.source} · {plural(proposal.considered, 'candidate')} looked at
      </p>
      {proposal.shortfall ? <p className="curate__shortfall" data-testid="curate-shortfall">{proposal.shortfall}</p> : null}
      <p className="curate__basis">{proposal.tasteBasis}</p>

      <ol className="curate__list">
        {selection.map((id, index) => {
          const entry = entries.get(id)
          const image = items.get(id)
          if (!entry) return null
          return (
            <li key={id} className="curate__row" data-role={entry.role} data-testid="curate-row" data-image-id={id}>
              <button type="button" className="curate__thumb" onClick={() => open(selection, id)} aria-label={`Open image ${index + 1}`}>
                {image?.thumbStatus === 'ready' ? <img src={image.thumbUrl} alt="" draggable={false} /> : <Icon name="image" size={18} />}
              </button>
              <div className="curate__body">
                <div className="curate__chips">
                  <span className={`curate__chip curate__chip--${entry.role}`}>{ROLE_LABEL[entry.role]}</span>
                  {entry.match !== null ? <span className="curate__chip">match {Math.round(entry.match)}</span> : null}
                </div>
                <ul className="curate__reasons">
                  {entry.reasons.slice(0, 3).map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
                <div className="curate__actions">
                  <button type="button" className="button button--quiet" onClick={() => replace(id)} disabled={busy}>Replace</button>
                  <button type="button" className="button button--quiet" onClick={() => remove(id)} disabled={busy}>Reject</button>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      {selection.length === 0 ? <p className="curate__empty">Nothing is selected. Restore or add an image below, or choose Not now.</p> : null}
      {note ? <p className="curate__note" role="status">{note}</p> : null}

      {rejected.length > 0 ? (
        <div className="curate__tray" data-testid="curate-rejected">
          <small>Rejected ({rejected.length})</small>
          <div>
            {rejected.slice(-12).map((id) => (
              <button key={id} type="button" className="curate__mini" onClick={() => restore(id)} title="Restore this image" aria-label="Restore this image">
                {items.get(id)?.thumbStatus === 'ready' ? <img src={items.get(id)!.thumbUrl} alt="" draggable={false} /> : null}
                <span>Restore</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {unusedAlternatives.length > 0 ? (
        <div className="curate__more">
          <button type="button" className="link-button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen}>
            {moreOpen ? 'Hide' : 'More good choices'} ({unusedAlternatives.length})
          </button>
          {moreOpen ? (
            <ul className="curate__alts">
              {unusedAlternatives.map((alt) => (
                <li key={alt.imageId} className="curate__alt">
                  <button type="button" className="curate__thumb curate__thumb--small" onClick={() => open(unusedAlternatives.map((a) => a.imageId), alt.imageId)} aria-label="Open this image">
                    {items.get(alt.imageId)?.thumbStatus === 'ready' ? <img src={items.get(alt.imageId)!.thumbUrl} alt="" draggable={false} /> : null}
                  </button>
                  <div>
                    <span className={`curate__chip curate__chip--${alt.role}`}>{ROLE_LABEL[alt.role]}</span>
                    <span className="curate__why">{alt.reasons[0]}</span>
                  </div>
                  <button type="button" className="button button--quiet" onClick={() => add(alt.imageId)}>Add</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {leftGroups.length > 0 ? (
        <div className="curate__left">
          <button type="button" className="link-button" onClick={() => setLeftOpen((o) => !o)} aria-expanded={leftOpen}>
            {leftOpen ? 'Hide' : 'Left out'} ({leftGroups.reduce((n, g) => n + g.list.length, 0)})
          </button>
          {leftOpen
            ? leftGroups.map((group) => (
                <div key={group.why} className="curate__group" data-why={group.why}>
                  <small>{LEFT_OUT_TITLE[group.why]} ({group.list.length})</small>
                  <ul className="curate__alts">
                    {group.list.slice(0, 8).map((left) => (
                      <li key={left.imageId} className="curate__alt">
                        <button type="button" className="curate__thumb curate__thumb--small" onClick={() => open(group.list.map((l) => l.imageId), left.imageId)} aria-label="Open this image">
                          {items.get(left.imageId)?.thumbStatus === 'ready' ? <img src={items.get(left.imageId)!.thumbUrl} alt="" draggable={false} /> : null}
                        </button>
                        <span className="curate__why">{left.detail}</span>
                        <button type="button" className="button button--quiet" onClick={() => add(left.imageId)}>Add anyway</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            : null}
        </div>
      ) : null}

      <div className="curate__footer">
        <label className="curate__field">
          <span>Moodboard</span>
          <select value={target} onFocus={loadBoards} onChange={(event) => setTarget(event.target.value)} aria-label="Where the images go">
            <option value="new">A new moodboard</option>
            {(boards ?? []).map((board) => <option key={board.id} value={board.id}>Add to “{board.name}”</option>)}
          </select>
        </label>
        {target === 'new' ? (
          <label className="curate__field">
            <span>Name</span>
            <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} aria-label="Moodboard name" />
          </label>
        ) : null}
        <div className="proposal__actions">
          <button
            type="button"
            className="button button--gold"
            disabled={busy || selection.length === 0 || (target === 'new' && name.trim() === '')}
            onClick={() => onAnswer(true, { selection, name: name.trim(), boardId: target === 'new' ? null : target })}
            data-action="create-curated"
          >
            {target === 'new' ? `Create moodboard with ${plural(selection.length, 'image')}` : `Add ${plural(selection.length, 'image')}`}
          </button>
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => onAnswer(false)}>Not now</button>
          <small>Nothing is created until you press the button. Your original files are never changed.</small>
        </div>
      </div>
    </div>
  )
}
