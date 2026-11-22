import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Journey, JourneySuggestion, JourneyWork } from '@shared/types'
import { Icon } from '../Icon'
import { ConfirmModal, Spinner } from '../ui'
import { useAtlas } from '../../lib/useAtlas'
import { Credit, WorkLink, useLoaded } from './shared'
import { friendlyError } from '../../lib/format'

type Step = { kind: 'cover' } | { kind: 'chapter'; chapter: number } | { kind: 'work'; chapter: number; work: number } | { kind: 'end' }

function stepsOf(journey: Journey): Step[] {
  const steps: Step[] = [{ kind: 'cover' }]
  journey.chapters.forEach((chapter, c) => {
    steps.push({ kind: 'chapter', chapter: c })
    chapter.works.forEach((_, w) => steps.push({ kind: 'work', chapter: c, work: w }))
  })
  steps.push({ kind: 'end' })
  return steps
}

const ROLE_TEXT: Record<JourneyWork['role'], string> = {
  familiar: 'Close to what you know',
  neighbour: 'A neighbouring tradition',
  quality: 'The same quality, elsewhere',
  stretch: 'A stretch beyond your taste',
  tour: 'On the tour'
}

/** The exhibition: a full-screen walk through a journey, one work at a time. */
function JourneyViewer({ initial, onClose, onOpen }: { initial: Journey; onClose: () => void; onOpen: (journey: Journey) => void }): React.JSX.Element {
  const { moodboards } = useAtlas()
  const [journey, setJourney] = useState(initial)
  const steps = useMemo(() => stepsOf(journey), [journey])
  const [index, setIndex] = useState(Math.min(journey.progress, steps.length - 1))
  const [saved, setSaved] = useState<Record<string, string>>({})
  const [board, setBoard] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const step = steps[index]!
  const work = step.kind === 'work' ? journey.chapters[step.chapter]!.works[step.work]! : null

  useEffect(() => {
    void window.noema.journeyProgress({ journeyId: journey.id, progress: index, finished: step.kind === 'end' }).catch(() => undefined)
  }, [index, journey.id, step.kind])

  const go = useCallback((delta: number): void => setIndex((i) => Math.max(0, Math.min(steps.length - 1, i + delta))), [steps.length])

  const react = useCallback(async (feedback: 'like' | 'dislike' | 'clear'): Promise<void> => {
    if (!work) return
    try {
      setJourney(await window.noema.journeyFeedback({ journeyId: journey.id, workId: work.work.id, feedback }))
    } catch (error) {
      setNote(friendlyError(error))
    }
  }, [journey.id, work])

  const save = useCallback(
    async (target: JourneyWork, options: { favorite?: boolean; moodboardId?: string } = {}): Promise<void> => {
      setBusy(true)
      setNote(null)
      try {
        await window.noema.saveDiscovery({ workId: target.work.id, favorite: options.favorite, moodboardId: options.moodboardId, journeyId: journey.id })
        setSaved((s) => ({ ...s, [target.work.id]: options.favorite ? 'Saved as a favorite' : options.moodboardId ? 'Saved to the moodboard' : 'Saved to your library' }))
      } catch (error) {
        setNote(friendlyError(error))
      } finally {
        setBusy(false)
      }
    },
    [journey.id]
  )

  const moreLikeThis = useCallback(async (): Promise<void> => {
    if (!work) return
    setBusy(true)
    try {
      onOpen(await window.noema.createJourney({ kind: 'work', label: work.work.title, ref: work.work.id }))
    } catch (error) {
      setNote(friendlyError(error))
      setBusy(false)
    }
  }, [onOpen, work])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (document.querySelector('[role="alertdialog"]')) return
      if (event.key === 'ArrowRight' || event.key === 'PageDown') (event.preventDefault(), go(1))
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') (event.preventDefault(), go(-1))
      else if (event.key === 'Escape') (event.preventDefault(), onClose())
      else if (work && event.key.toLowerCase() === 'l') void react(journey.feedback[work.work.id] === 'like' ? 'clear' : 'like')
      else if (work && event.key.toLowerCase() === 'n') void react(journey.feedback[work.work.id] === 'dislike' ? 'clear' : 'dislike')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [go, journey.feedback, onClose, react, work])

  const liked = journey.chapters.flatMap((c) => c.works).filter((w) => journey.feedback[w.work.id] === 'like')
  const passed = Object.values(journey.feedback).filter((f) => f === 'dislike').length

  return createPortal(
    <div className="exhibition" role="dialog" aria-modal="true" aria-label={`Journey: ${journey.title}`}>
      <header className="exhibition__top">
        <button type="button" className="lightbox__close" onClick={onClose}><Icon name="arrowLeft" size={17} /> <span>Leave the exhibition</span> <kbd>Esc</kbd></button>
        <div className="exhibition__dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
          {steps.map((s, i) => <i key={i} className={`${i === index ? 'is-now' : i < index ? 'is-done' : ''} ${s.kind === 'chapter' ? 'is-chapter' : ''}`} />)}
        </div>
        <span className="exhibition__title">{journey.title}</span>
      </header>

      <div className="exhibition__stage" key={index}>
        {step.kind === 'cover' ? (
          <div className="exhibition__page">
            <div className="eyebrow">AN ARTISTIC DISCOVERY JOURNEY</div>
            <h1>{journey.title}</h1>
            <p className="lead">{journey.subtitle}</p>
            <ul className="basis">{journey.basis.map((b) => <li key={b}>{b}</li>)}</ul>
            <button type="button" className="button button--gold" onClick={() => go(1)}>Enter <kbd>→</kbd></button>
          </div>
        ) : step.kind === 'chapter' ? (
          <div className="exhibition__page">
            <div className="eyebrow">CHAPTER {step.chapter + 1} OF {journey.chapters.length}{journey.chapters[step.chapter]!.stretch ? ' · A DELIBERATE STRETCH' : ''}</div>
            <h1>{journey.chapters[step.chapter]!.title}</h1>
            <p className="lead">{journey.chapters[step.chapter]!.intro}</p>
            <button type="button" className="button button--gold" onClick={() => go(1)}>Continue <kbd>→</kbd></button>
          </div>
        ) : step.kind === 'work' && work ? (
          <div className="exhibition__work">
            <div className="exhibition__image"><img src={work.work.imageUrl} alt={`${work.work.title}${work.work.artist ? `, ${work.work.artist}` : ''}`} /></div>
            <aside className="exhibition__caption">
              <div className="eyebrow">{ROLE_TEXT[work.role].toUpperCase()}</div>
              <h2>{work.work.title}</h2>
              <p className="maker">{work.work.artist || 'Unknown maker'}{work.work.artistInfo ? ` · ${work.work.artistInfo}` : ''}</p>
              <p className="details">{[work.work.date, work.work.culture, work.work.medium].filter(Boolean).join(' · ')}</p>
              <Credit work={work.work} /> <WorkLink work={work.work} />
              <h4>Why it is here</h4>
              <ul className="why">{work.why.map((w) => <li key={w}>{w}</li>)}</ul>
              <div className="exhibition__actions">
                <button type="button" className={`button ${journey.feedback[work.work.id] === 'like' ? 'button--gold' : 'button--ghost'}`} onClick={() => void react(journey.feedback[work.work.id] === 'like' ? 'clear' : 'like')} aria-pressed={journey.feedback[work.work.id] === 'like'}><Icon name="heart" size={15} /> I like this <kbd>L</kbd></button>
                <button type="button" className={`button ${journey.feedback[work.work.id] === 'dislike' ? 'button--gold' : 'button--ghost'}`} onClick={() => void react(journey.feedback[work.work.id] === 'dislike' ? 'clear' : 'dislike')} aria-pressed={journey.feedback[work.work.id] === 'dislike'}><Icon name="close" size={15} /> Not for me <kbd>N</kbd></button>
              </div>
              <div className="exhibition__save">
                <button type="button" className="button button--ghost" disabled={busy} onClick={() => void save(work)}><Icon name="restore" size={15} /> Save to my library</button>
                <button type="button" className="button button--ghost" disabled={busy} onClick={() => void save(work, { favorite: true })}><Icon name="heart" size={15} /> Save as favorite</button>
                {moodboards.length > 0 ? (
                  <select value={board} onChange={(e) => { setBoard(e.target.value); if (e.target.value) void save(work, { moodboardId: e.target.value }); setBoard('') }} aria-label="Save to a moodboard" disabled={busy}>
                    <option value="">Save to a moodboard…</option>
                    {moodboards.map((b) => <option value={b.id} key={b.id}>{b.name}</option>)}
                  </select>
                ) : null}
                <button type="button" className="button button--ghost" disabled={busy} onClick={() => void moreLikeThis()}><Icon name="sparkle" size={15} /> More like this</button>
              </div>
              {saved[work.work.id] ? <p className="saved">{saved[work.work.id]}. Find it in the “Atlas Discoveries” source.</p> : null}
              {note ? <p className="ai-error">{note}</p> : null}
            </aside>
          </div>
        ) : (
          <div className="exhibition__page">
            <div className="eyebrow">THE END OF THE JOURNEY</div>
            <h1>What stayed with you?</h1>
            <p className="lead">You liked {liked.length} work{liked.length === 1 ? '' : 's'} and passed on {passed}. Atlas has taken this into account, and your next journeys will start from it.</p>
            {liked.length > 0 ? (
              <div className="dthumbs">{liked.map((w) => <img key={w.work.id} src={w.work.imageUrl} alt={w.work.title} className="endthumb" />)}</div>
            ) : null}
            <div className="exhibition__save">
              {liked.length > 0 ? <button type="button" className="button button--gold" disabled={busy} onClick={async () => { for (const w of liked) await save(w) }}>Save the {liked.length} I liked to my library</button> : null}
              {liked.length > 0 && moodboards.length > 0 ? (
                <select aria-label="Save the liked works to a moodboard" onChange={async (e) => { const id = e.target.value; if (id) for (const w of liked) await save(w, { moodboardId: id }) }} defaultValue="">
                  <option value="">Put them on a moodboard…</option>
                  {moodboards.map((b) => <option value={b.id} key={b.id}>{b.name}</option>)}
                </select>
              ) : null}
              <button type="button" className="button button--ghost" onClick={onClose}>Back to the journeys</button>
            </div>
            {Object.keys(saved).length > 0 ? <p className="saved">{Object.keys(saved).length} saved to your library.</p> : null}
          </div>
        )}
      </div>

      <footer className="exhibition__nav">
        <button type="button" className="button button--ghost" onClick={() => go(-1)} disabled={index === 0}><kbd>←</kbd> Back</button>
        <span>{journey.chapters.length > 0 && step.kind !== 'cover' && step.kind !== 'end' ? `Chapter ${('chapter' in step ? step.chapter : 0) + 1}: ${journey.chapters[('chapter' in step ? step.chapter : 0)]!.title}` : ''}</span>
        <button type="button" className="button button--gold" onClick={() => go(1)} disabled={index === steps.length - 1}>Next <kbd>→</kbd></button>
      </footer>
    </div>,
    document.body
  )
}

export function JourneysTab({ start }: { start: { kind: JourneySuggestion['seed']['kind']; ref?: number | string; label: string } | null }): React.JSX.Element {
  const { data, error, loading, reload } = useLoaded<{ journeys: Journey[]; suggestions: JourneySuggestion[] }>(() => window.noema.listJourneys(), [])
  const [open, setOpen] = useState<Journey | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const [remove, setRemove] = useState<Journey | null>(null)

  const create = useCallback(
    async (seed: JourneySuggestion['seed']): Promise<void> => {
      setBusy(seed.label)
      setFail(null)
      try {
        setOpen(await window.noema.createJourney(seed))
        void reload()
      } catch (createError) {
        setFail(friendlyError(createError))
      } finally {
        setBusy(null)
      }
    },
    [reload]
  )

  // A journey requested from another tab (identity, map) starts as soon as this tab opens.
  useEffect(() => {
    if (start) void create({ kind: start.kind, label: start.label, ref: start.ref })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start])

  if (loading && !data) return <div className="taste-loading"><Spinner size={22} /> Preparing your journeys…</div>
  if (error) return <div className="inline-error"><Icon name="info" size={16} /> {error}</div>

  return (
    <div className="journeys">
      <section className="panel-intro">
        <div className="eyebrow">ARTISTIC DISCOVERY JOURNEYS</div>
        <h2>A personal exhibition, built from what you respond to</h2>
        <p>
          Each journey starts from something you already enjoy, travels through neighbouring traditions and the same quality in other worlds,
          and then deliberately steps beyond what you have confirmed, so your taste is stretched rather than only repeated. Everything shown
          is public domain with the museum's own details, and every explanation is either measured from the images or taken from the museum record.
        </p>
      </section>
      {fail ? <div className="inline-error"><Icon name="info" size={16} /> {fail}</div> : null}

      <h3 className="section-title">Offered to you</h3>
      <div className="suggestions">
        {data?.suggestions.map((s) => (
          <article className="suggestion" key={`${s.seed.kind}:${s.seed.ref ?? ''}`}>
            <div className="eyebrow">{s.seed.kind === 'tour' ? 'A TOUR' : s.seed.kind === 'emerging' ? 'A NEW DIRECTION' : s.seed.kind === 'identity' ? 'FROM YOUR FAVORITES' : s.seed.kind === 'unexplored' ? 'BEYOND YOUR TASTE' : 'FROM YOUR DISCOVERIES'}</div>
            <h4>{s.title}</h4>
            <p>{s.reason}</p>
            <small>{s.evidence}</small>
            <button type="button" className="button button--gold" disabled={busy !== null} onClick={() => void create(s.seed)}>
              {busy === s.seed.label ? 'Preparing…' : 'Begin the journey'}
            </button>
          </article>
        ))}
        {data && data.suggestions.length === 0 ? <p className="hint">You have made all the journeys on offer. Explore a little more, or favorite more images, and new ones appear.</p> : null}
      </div>

      {data && data.journeys.length > 0 ? (
        <>
          <h3 className="section-title">Your journeys</h3>
          <div className="suggestions">
            {data.journeys.map((j) => (
              <article className="suggestion suggestion--done" key={j.id}>
                <div className="eyebrow">{j.finished ? 'COMPLETED' : 'IN PROGRESS'} · {new Date(j.createdAt).toLocaleDateString()}</div>
                <h4>{j.title}</h4>
                <p>{j.subtitle}. You liked {Object.values(j.feedback).filter((f) => f === 'like').length} and passed on {Object.values(j.feedback).filter((f) => f === 'dislike').length}.</p>
                <div className="dthumbs">{j.chapters.flatMap((c) => c.works).slice(0, 5).map((w) => <img key={w.work.id} src={w.work.imageUrl} alt="" className="endthumb" />)}</div>
                <div className="profile-actions">
                  <button type="button" className="button button--ghost" onClick={() => setOpen(j)}>{j.finished ? 'Walk it again' : 'Continue'}</button>
                  <button type="button" className="button button--ghost" onClick={() => setRemove(j)}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}

      {open ? <JourneyViewer key={open.id} initial={open} onClose={() => { setOpen(null); void reload() }} onOpen={(j) => { setOpen(j); void reload() }} /> : null}
      <ConfirmModal open={remove !== null} title="Remove this journey?" description="The journey disappears from your list. Works you saved stay in your library, and your reactions still count towards your taste." confirmLabel="Remove" tone="danger" onClose={() => setRemove(null)} onConfirm={async () => { if (remove) await window.noema.deleteJourney(remove.id); await reload() }} />
    </div>
  )
}
