import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiscoveryPair, DiscoveryResponse, DiscoveryState, ReferenceWork } from '@shared/types'
import { Icon } from '../Icon'
import { ConfirmModal, Spinner } from '../ui'
import { Credit, QualityChip, Thumb, WorkLink, workLine } from './shared'
import { formatNumber, friendlyError } from '../../lib/format'

const PHASE_TEXT: Record<DiscoveryPair['phase'], string> = {
  orient: 'Mapping the collection',
  refine: 'Sharpening your edges',
  mode: 'Looking closer at what you like',
  stretch: 'Testing something new'
}

const STAGE_TEXT: Record<DiscoveryState['stage'], string> = {
  start: 'Just starting',
  sketch: 'An early sketch',
  growing: 'Taking shape',
  steady: 'Well established'
}

function preload(work: ReferenceWork | undefined): void {
  if (!work) return
  const image = new Image()
  image.src = work.imageUrl
}

/**
 * Explore: choose between two works from the reference collection. The works are shown without captions so the choice
 * is about how they look; after each answer the previous pair is named, so you also learn who and what you liked.
 */
export function ExploreTab({ onJourney }: { onJourney: () => void }): React.JSX.Element {
  const [state, setState] = useState<DiscoveryState | null>(null)
  const [pair, setPair] = useState<DiscoveryPair | null>(null)
  const [last, setLast] = useState<{ pair: DiscoveryPair; response: DiscoveryResponse; winner: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const busyRef = useRef(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [s, p] = await Promise.all([window.noema.getDiscovery(), window.noema.discoveryNextPair()])
        if (!alive) return
        setState(s)
        setPair(p)
        preload(p?.a)
        preload(p?.b)
      } catch (loadError) {
        if (alive) setError(friendlyError(loadError))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const answer = useCallback(
    async (response: DiscoveryResponse, winner: ReferenceWork | null): Promise<void> => {
      if (!pair || busyRef.current) return
      busyRef.current = true
      setBusy(true)
      setPicked(response === 'prefer' ? winner?.id ?? null : response)
      setError(null)
      try {
        const [step] = await Promise.all([
          window.noema.discoveryRespond({ aId: pair.a.id, bId: pair.b.id, response, winnerId: winner?.id ?? null }),
          new Promise((resolve) => setTimeout(resolve, 200))
        ])
        setLast({ pair, response, winner: winner?.id ?? null })
        setState(step.state)
        setPair(step.next)
        preload(step.next?.a)
        preload(step.next?.b)
      } catch (stepError) {
        setError(friendlyError(stepError))
      } finally {
        busyRef.current = false
        setBusy(false)
        setPicked(null)
      }
    },
    [pair]
  )

  const undo = useCallback(async (): Promise<void> => {
    if (busyRef.current || !state || state.informative + state.counts.undecided === 0) return
    busyRef.current = true
    setBusy(true)
    try {
      const step = await window.noema.discoveryUndo()
      setState(step.state)
      setPair(step.next)
      setLast(null)
    } catch (undoError) {
      setError(friendlyError(undoError))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [state])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (document.querySelector('[role="dialog"]')) return
      if (!pair) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        void answer('prefer', pair.a)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        void answer('prefer', pair.b)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        void answer('both', null)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        void answer('neither', null)
      } else if (event.key === ' ' && target?.tagName !== 'BUTTON') {
        event.preventDefault()
        void answer('undecided', null)
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        void undo()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [answer, pair, undo])

  if (error && !state) return <div className="inline-error"><Icon name="info" size={16} /> {error}</div>
  if (!state) return <div className="taste-loading"><Spinner size={22} /> Opening the collection…</div>

  return (
    <div className="explore">
      {error ? <div className="inline-error"><Icon name="info" size={16} /> {error}</div> : null}
      <div className="taste-layout">
        <section className="taste-compare" aria-label="Compare two works">
          <div className="taste-compare__head">
            <div>
              <div className="eyebrow">ROUND {pair ? formatNumber(pair.round) : '—'} · {pair ? PHASE_TEXT[pair.phase].toUpperCase() : ''}</div>
              <h2>Which draws you more?</h2>
            </div>
            <div className="taste-compare__progress">
              <span>{STAGE_TEXT[state.stage]} · {state.informative} answers</span>
              <div className="taste-compare__bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (state.informative / 60) * 100)}%` }} />
              </div>
            </div>
          </div>

          {pair ? (
            <div className={`taste-pair ${busy ? 'is-busy' : ''}`}>
              {([pair.a, pair.b] as const).map((work, index) => (
                <button
                  key={work.id}
                  type="button"
                  className={`taste-choice ${picked === work.id ? 'is-picked' : ''} ${picked && picked !== work.id && !['both', 'neither', 'undecided'].includes(picked) ? 'is-passed' : ''}`}
                  onClick={() => void answer('prefer', work)}
                  disabled={busy}
                  aria-label={`Prefer the ${index === 0 ? 'left' : 'right'} work`}
                >
                  <img src={work.imageUrl} alt="" draggable={false} />
                  <span className="taste-choice__key"><kbd>{index === 0 ? '←' : '→'}</kbd> I prefer this</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="taste-loading"><Spinner size={22} /> Choosing two works…</div>
          )}

          <div className="taste-actions taste-actions--five">
            <button type="button" className="button button--ghost" onClick={() => void answer('both', null)} disabled={busy || !pair}><kbd>↑</kbd> I like both</button>
            <button type="button" className="button button--ghost" onClick={() => void answer('neither', null)} disabled={busy || !pair}><kbd>↓</kbd> Neither</button>
            <button type="button" className="button button--ghost" onClick={() => void answer('undecided', null)} disabled={busy || !pair}><kbd>Space</kbd> Can't decide</button>
            <button type="button" className="button button--ghost" onClick={() => void undo()} disabled={busy || state.informative + state.counts.undecided === 0}><kbd>Ctrl Z</kbd> Undo</button>
          </div>
          <p className="taste-compare__note">
            Works are shown without names so you can react to how they look. All of them are public-domain works from museum collections.
          </p>

          {last ? (
            <div className="reveal" aria-live="polite">
              <div className="eyebrow">THE LAST PAIR</div>
              {[last.pair.a, last.pair.b].map((work) => (
                <div key={work.id} className={`reveal__row ${last.winner === work.id ? 'is-chosen' : ''}`}>
                  <Thumb item={work} size="sm" />
                  <div>
                    <strong>{workLine(work)}</strong>
                    <Credit work={work} /> <WorkLink work={work} />
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="taste-profile" aria-label="What Atlas has learned from exploring">
          <div className="taste-profile__head">
            <div className="eyebrow">MY DISCOVERED TASTE</div>
            <h2>What exploring has shown so far</h2>
          </div>
          <div className="counts" aria-label="Your answers">
            <span><b>{state.counts.prefer}</b> preferred</span>
            <span><b>{state.counts.both}</b> liked both</span>
            <span><b>{state.counts.neither}</b> liked neither</span>
            <span><b>{state.counts.undecided}</b> undecided</span>
          </div>
          <div className="coverage">
            <div className="taste-compare__bar" aria-hidden="true">
              <span style={{ width: `${(state.coverage.regionsSeen / Math.max(1, state.coverage.regionsTotal)) * 100}%` }} />
            </div>
            <small>You have seen {state.coverage.worksSeen} of {state.coverage.worksTotal} works, from {state.coverage.regionsSeen} of {state.coverage.regionsTotal} regions of the collection.</small>
          </div>

          {state.modes.length === 0 ? (
            <p className="hint">Answer a few pairs. Atlas will show the separate directions you respond to here, each with works that show it. It never merges them into one average.</p>
          ) : (
            <div className="mode-list">
              {state.modes.map((mode) => (
                <article className="mode-card" key={mode.id}>
                  <header>
                    <h3>{mode.label}</h3>
                    <span>{mode.size} liked works{mode.tentative ? ' · tentative' : ''}</span>
                  </header>
                  <div className="dthumbs">
                    {mode.examples.slice(0, 5).map((w) => <Thumb key={w.id} item={w} size="sm" />)}
                  </div>
                  {mode.characteristics.length > 0 ? (
                    <div className="chips">{mode.characteristics.slice(0, 3).map((d) => <QualityChip key={d.id} dim={d} />)}</div>
                  ) : (
                    <p className="hint">No quality stands out reliably yet. {mode.size < 5 ? 'It takes at least 5 liked works to say more.' : ''}</p>
                  )}
                </article>
              ))}
            </div>
          )}
          <p className="taste-accuracy">
            {state.accuracy === null
              ? `Atlas measures how well it predicts your answers once you have made 20. You have made ${state.informative}.`
              : <>Atlas predicted <b>{Math.round(state.accuracy * 100)}%</b> of your answers correctly when tested on your own earlier ones (guessing gives about 50%).</>}
          </p>
          <div className="profile-actions">
            <button type="button" className="button button--gold" onClick={onJourney} disabled={!state.canJourney}>
              <Icon name="sparkle" size={16} /> {state.canJourney ? 'See journeys for you' : 'Journeys unlock after 6 answers'}
            </button>
            <button type="button" className="button button--ghost" onClick={() => setConfirmReset(true)} disabled={state.informative + state.counts.undecided === 0}>
              <Icon name="restore" size={16} /> Start over
            </button>
          </div>
        </section>
      </div>

      <ConfirmModal
        open={confirmReset}
        title="Start your discovered taste over?"
        description="This forgets your exploration answers and journey reactions. Your favorites, saved discoveries, journeys and history are not touched."
        confirmLabel="Start over"
        tone="danger"
        onClose={() => setConfirmReset(false)}
        onConfirm={async () => {
          const fresh = await window.noema.discoveryReset()
          setState(fresh)
          setLast(null)
          setPair(await window.noema.discoveryNextPair())
        }}
      />
    </div>
  )
}
