import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ImageItem,
  TasteDimension,
  TasteExamples,
  TastePair,
  TasteRecommendations,
  TasteState
} from '@shared/types'
import { Icon } from '../components/Icon'
import { ConfirmModal, EmptyState, Spinner } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { TasteCompass } from '../components/TasteCompass'
import { openAiSetup, useModelStatus } from '../components/AiSetup'
import { friendlyError, formatNumber } from '../lib/format'

const STAGE_LABEL: Record<TasteState['stage'], string> = {
  start: 'just starting',
  sketch: 'early sketch',
  growing: 'taking shape',
  steady: 'well established'
}

function leanWords(lean: number): string {
  const size = Math.abs(lean)
  const strength = size < 0.15 ? 'about the same as' : size < 0.4 ? 'slightly' : size < 0.8 ? 'clearly' : 'strongly'
  if (size < 0.15) return strength
  return `${strength} ${lean > 0 ? 'towards' : 'away from'}`
}

function preload(item: ImageItem | undefined): void {
  if (!item) return
  const image = new Image()
  image.src = item.thumbUrl
}

export function TastePage(): React.JSX.Element {
  const model = useModelStatus()
  const [state, setState] = useState<TasteState | null>(null)
  const [pair, setPair] = useState<TastePair | null>(null)
  const [picked, setPicked] = useState<'a' | 'b' | 'skip' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [examples, setExamples] = useState<TasteExamples | null>(null)
  const [recs, setRecs] = useState<TasteRecommendations | null>(null)
  const [lightbox, setLightbox] = useState<{ items: ImageItem[]; index: number } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const recsAt = useRef(-1)
  const aiOn = Boolean(model && model.installed && model.choice === 'enabled')

  const refreshRecs = useCallback(async (force = false, choices = 0): Promise<void> => {
    if (!force && recsAt.current >= 0 && Math.abs(choices - recsAt.current) < 5) return
    recsAt.current = choices
    try {
      setRecs(await window.noema.tasteRecommend(24))
    } catch (recError) {
      setError(friendlyError(recError))
    }
  }, [])

  // First load.
  useEffect(() => {
    if (!aiOn) return
    let alive = true
    void (async () => {
      try {
        const next = await window.noema.getTasteState()
        if (!alive) return
        setState(next)
        if (next.available) {
          const first = await window.noema.tasteNextPair()
          if (!alive) return
          setPair(first)
          preload(first?.a)
          preload(first?.b)
          if (next.canRecommend) void refreshRecs(true, next.choices)
        }
      } catch (loadError) {
        if (alive) setError(friendlyError(loadError))
      }
    })()
    return () => {
      alive = false
    }
  }, [aiOn, refreshRecs])

  // Examples for the selected dimension.
  useEffect(() => {
    if (!selectedId) {
      setExamples(null)
      return
    }
    let alive = true
    void window.noema.tasteExamples(selectedId).then((result) => {
      if (alive) setExamples(result)
    })
    return () => {
      alive = false
    }
  }, [selectedId, state?.choices])

  const apply = useCallback(
    async (work: () => Promise<{ state: TasteState; next: TastePair | null }>): Promise<void> => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        const [step] = await Promise.all([work(), new Promise((resolve) => setTimeout(resolve, 170))])
        setState(step.state)
        setPair(step.next)
        preload(step.next?.a)
        preload(step.next?.b)
        if (step.state.canRecommend) void refreshRecs(false, step.state.choices)
      } catch (stepError) {
        setError(friendlyError(stepError))
      } finally {
        setPicked(null)
        setBusy(false)
      }
    },
    [busy, refreshRecs]
  )

  const choose = useCallback(
    (side: 'a' | 'b' | 'skip'): void => {
      if (!pair || busy) return
      setPicked(side)
      const winnerId = side === 'skip' ? null : side === 'a' ? pair.a.id : pair.b.id
      void apply(() => window.noema.tasteChoose({ aId: pair.a.id, bId: pair.b.id, winnerId, mode: pair.mode }))
    },
    [apply, busy, pair]
  )

  const undo = useCallback((): void => {
    if (busy || !state || state.choices + state.skipped === 0) return
    void apply(() => window.noema.tasteUndo())
  }, [apply, busy, state])

  // Keyboard: arrows choose, Space skips, Ctrl+Z undoes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (document.querySelector('[role="dialog"]')) return
      if (lightbox) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        choose('a')
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        choose('b')
      } else if (event.key === 'ArrowDown' || (event.key === ' ' && target?.tagName !== 'BUTTON')) {
        event.preventDefault()
        choose('skip')
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        undo()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [choose, undo, lightbox])

  const dimensions = state?.dimensions ?? []
  const shown: TasteDimension | undefined = dimensions.find((d) => d.id === (hoverId ?? selectedId))
  const unlocked = Boolean(state?.canRecommend)
  const remaining = state ? Math.max(0, state.unlocksAt - Math.max(state.choices, state.canRecommend ? state.unlocksAt : 0)) : 0

  // ---- gates --------------------------------------------------------------------------------------

  if (model && !aiOn) {
    return (
      <div className="page page--taste">
        <TasteHeader />
        <EmptyState
          icon="eye"
          title="The Taste Compass needs the optional AI model."
          copy="It learns from the images you choose, using the same local model as visual search. It runs on this computer, and Atlas works fully without it."
        >
          <button type="button" className="button button--gold" onClick={openAiSetup}>
            <Icon name="sparkle" size={16} /> Set up visual search
          </button>
        </EmptyState>
      </div>
    )
  }
  if (!state) {
    return (
      <div className="page page--taste">
        <TasteHeader />
        <div className="taste-loading">
          <Spinner size={22} /> {error ?? 'Loading your taste profile…'}
        </div>
      </div>
    )
  }
  if (!state.available) {
    return (
      <div className="page page--taste">
        <TasteHeader />
        <EmptyState icon="eye" title="Atlas needs to see more of your library first." copy={state.reason ?? 'Atlas is still learning your images.'} />
      </div>
    )
  }

  return (
    <div className="page page--taste">
      <TasteHeader
        action={
          <button type="button" className="button button--ghost" onClick={() => setConfirmReset(true)} disabled={state.choices + state.skipped === 0}>
            <Icon name="restore" size={16} /> Start over
          </button>
        }
      />

      {error ? (
        <div className="inline-error">
          <Icon name="info" size={16} /> {error}
        </div>
      ) : null}

      <div className="taste-layout">
        <section className="taste-compare" aria-label="Compare two images">
          <div className="taste-compare__head">
            <div>
              <div className="eyebrow">ROUND {pair ? formatNumber(pair.round) : '—'}</div>
              <h2>Which do you prefer?</h2>
            </div>
            <div className="taste-compare__progress">
              {unlocked ? (
                <span>Recommendations are on</span>
              ) : (
                <span>
                  {remaining} more choice{remaining === 1 ? '' : 's'} to unlock recommendations
                </span>
              )}
              <div className="taste-compare__bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, (state.choices / state.unlocksAt) * 100)}%` }} />
              </div>
            </div>
          </div>

          {pair ? (
            <div className={`taste-pair ${busy ? 'is-busy' : ''}`}>
              {(['a', 'b'] as const).map((side) => {
                const item = side === 'a' ? pair.a : pair.b
                return (
                  <button
                    key={`${item.id}-${side}`}
                    type="button"
                    className={`taste-choice ${picked === side ? 'is-picked' : ''} ${picked && picked !== side && picked !== 'skip' ? 'is-passed' : ''}`}
                    onClick={() => choose(side)}
                    disabled={busy}
                    aria-label={`Prefer the ${side === 'a' ? 'left' : 'right'} image, ${item.filename}`}
                    style={{ '--tint': item.color ?? '#23231d' } as React.CSSProperties}
                  >
                    <img src={item.thumbUrl} alt="" draggable={false} />
                    <span className="taste-choice__key">
                      <kbd>{side === 'a' ? '←' : '→'}</kbd> I prefer this
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="taste-loading">
              <Spinner size={22} /> Finding two images to compare…
            </div>
          )}

          <div className="taste-actions">
            <button type="button" className="button button--ghost" onClick={() => choose('skip')} disabled={busy || !pair}>
              <kbd>Space</kbd> Can't say
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={undo}
              disabled={busy || state.choices + state.skipped === 0}
            >
              <kbd>Ctrl Z</kbd> Undo
            </button>
          </div>
          <p className="taste-compare__note">
            Trust your first reaction. There are no right answers, and Atlas only learns from what you choose.
            {state.excluded > 0
              ? ` ${formatNumber(state.excluded)} image${state.excluded === 1 ? '' : 's'} that look like screenshots or technical tests are kept out of these comparisons.`
              : ''}
          </p>
        </section>

        <section className="taste-profile" aria-label="Your taste profile">
          <div className="taste-profile__head">
            <div className="eyebrow">SMAKKOMPASSEN · THE TASTE COMPASS</div>
            <h2>What your choices show</h2>
          </div>
          <TasteCompass
            dimensions={dimensions}
            choices={state.choices}
            stageLabel={STAGE_LABEL[state.stage]}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
            onHover={setHoverId}
          />
          <div className="taste-legend">
            <span><i className="taste-legend__solid" /> reliable</span>
            <span><i className="taste-legend__faint" /> not enough evidence yet</span>
            <span><i className="taste-legend__ring" /> same as the images you passed over</span>
          </div>
          <Readout dimension={shown} choices={state.choices + state.inferred.decisions} />
          <Accuracy state={state} />
        </section>
      </div>

      {selectedId && examples ? (
        <ExamplePanel
          dimension={dimensions.find((d) => d.id === selectedId)}
          examples={examples}
          onOpen={(items, index) => setLightbox({ items, index })}
        />
      ) : null}

      <section className="taste-recs" aria-label="Recommended images">
        <div className="taste-recs__head">
          <div>
            <div className="eyebrow">FROM YOUR LIBRARY · NOT YET JUDGED BY YOU</div>
            <h2>Atlas thinks you would like these</h2>
          </div>
          {unlocked ? (
            <button type="button" className="button button--ghost" onClick={() => void refreshRecs(true, state.choices)}>
              <Icon name="refresh" size={16} /> Refresh
            </button>
          ) : null}
        </div>
        {!unlocked ? (
          <p className="taste-recs__empty">
            Choose between {remaining} more pair{remaining === 1 ? '' : 's'} and Atlas can start suggesting images from your library. Existing
            Keep and Pass decisions count too.
          </p>
        ) : recs && recs.items.length > 0 ? (
          <div className="taste-recs__grid">
            {recs.items.map((rec, index) => (
              <button
                type="button"
                key={rec.image.id}
                className="taste-rec"
                onClick={() => setLightbox({ items: recs.items.map((r) => r.image), index })}
                style={{ '--tint': rec.image.color ?? '#23231d' } as React.CSSProperties}
              >
                <img src={rec.image.thumbUrl} alt="" loading="lazy" draggable={false} />
                <span className="taste-rec__meta">
                  <span className="taste-rec__rank">Top {Math.max(1, Math.round(100 - rec.percentile))}% for your taste</span>
                  {rec.because ? (
                    <span className="taste-rec__because">
                      <img src={rec.because.thumbUrl} alt="" /> Looks like an image you chose
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="taste-recs__empty">{recs?.message ?? 'Looking through your library…'}</p>
        )}
      </section>

      <details className="taste-how">
        <summary>How the Taste Compass works, and what it does not claim</summary>
        <div className="taste-how__body">
          <p>
            Each image has a position in a space learned by the local AI model, so images that look alike sit close together.
            Every time you choose, Atlas nudges a preference direction towards the image you picked and away from the other.
            Suggestions are the library images that lie furthest along that direction, with near-duplicates removed.
          </p>
          <p>
            The compass petals measure your choices, not the pictures. For each quality, Atlas asks how much more of it the images you
            chose show than the images you passed over, using short descriptions such as "a dark, moody, low-key image" to score each
            picture. A solid petal means the difference is larger than chance would give; a faint petal means more choices are needed.
          </p>
          <p>
            To keep the compass fair, it only uses comparisons between images Atlas picked without regard to how hard they were
            ({formatNumber(state.compassChoices)} of your {formatNumber(state.choices)} so far). The harder pairs Atlas also asks about
            teach it faster but would blur the picture. The percentage under the compass is tested on your own earlier choices: Atlas learns from most of them and predicts the
            rest, where guessing would score 50%. Nothing here says that one taste is better than another, and nothing leaves this
            computer. Existing Keep and Pass decisions and star ratings count as lighter evidence ({formatNumber(state.inferred.decisions)} Keep/Pass pairs
            and {formatNumber(state.inferred.ratings)} rating pairs are used now); ratings help suggestions but not the compass.
          </p>
        </div>
      </details>

      {lightbox ? (
        <Lightbox
          items={lightbox.items}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
          onUpdate={(updated) =>
            setLightbox((current) => (current ? { ...current, items: current.items.map((i) => (i.id === updated.id ? updated : i)) } : current))
          }
        />
      ) : null}

      <ConfirmModal
        open={confirmReset}
        title="Start your taste profile over?"
        description="This forgets every comparison you have made. Your Keep and Pass decisions, ratings and images are not touched."
        confirmLabel="Start over"
        tone="danger"
        onClose={() => setConfirmReset(false)}
        onConfirm={async () => {
          const fresh = await window.noema.tasteReset()
          setState(fresh)
          setRecs(null)
          recsAt.current = -1
          setSelectedId(null)
          setPair(await window.noema.tasteNextPair())
        }}
      />
    </div>
  )
}

function TasteHeader({ action }: { action?: React.ReactNode }): React.JSX.Element {
  return (
    <header className="page-head">
      <div className="page-head__copy">
        <div className="eyebrow">TASTE · LEARNED FROM YOUR OWN CHOICES</div>
        <h1 className="page-title">Taste</h1>
        <p className="page-subtitle">
          Compare two images, pick the one you prefer, and Atlas gradually learns what you respond to. It never judges your images; it
          only follows your choices.
        </p>
      </div>
      {action ? <div className="page-head__actions">{action}</div> : null}
    </header>
  )
}

function Readout({ dimension, choices }: { dimension: TasteDimension | undefined; choices: number }): React.JSX.Element {
  if (!dimension) {
    return (
      <div className="taste-readout is-hint">
        {choices === 0
          ? 'Make a few comparisons and the compass will start to fill in.'
          : 'Hover or select a petal to see what your choices show about it.'}
      </div>
    )
  }
  const evidence = dimension.certain
  return (
    <div className="taste-readout" aria-live="polite">
      <strong>{dimension.label}</strong>
      <span className="taste-readout__desc">{dimension.description}</span>
      {choices < 6 ? (
        <span>Not enough choices yet. Atlas needs at least 6 before it says anything about a quality.</span>
      ) : (
        <>
          <span>
            Your choices lean <b>{leanWords(dimension.lean)}</b> this
            {evidence ? '' : ', but not reliably yet'}.
          </span>
          <span className="taste-readout__detail">
            {dimension.clear > 0
              ? `In ${dimension.agreed} of ${dimension.clear} comparisons where the two pictures clearly differed in this quality, you chose the one with more of it.`
              : 'No comparison has clearly differed in this quality yet.'}
            {' '}Range: {dimension.low.toFixed(2)} to {dimension.high.toFixed(2)}.
          </span>
        </>
      )}
    </div>
  )
}

function Accuracy({ state }: { state: TasteState }): React.JSX.Element {
  if (state.accuracy === null) {
    return (
      <p className="taste-accuracy">
        Atlas measures how well it predicts your choices once you have made 15. You have made {state.choices}.
      </p>
    )
  }
  const percent = Math.round(state.accuracy * 100)
  return (
    <p className="taste-accuracy">
      Atlas predicted <b>{percent}%</b> of your choices correctly when tested on your own earlier ones (guessing gives 50%).
    </p>
  )
}

function ExamplePanel({
  dimension,
  examples,
  onOpen
}: {
  dimension: TasteDimension | undefined
  examples: TasteExamples
  onOpen: (items: ImageItem[], index: number) => void
}): React.JSX.Element | null {
  const yours = useMemo(() => examples.yours, [examples])
  if (!dimension) return null
  return (
    <section className="taste-examples" aria-label={`Examples of ${dimension.label}`}>
      <div className="eyebrow">{dimension.axisLabel.toUpperCase()} · {dimension.label.toUpperCase()}</div>
      <div className="taste-examples__rows">
        <div>
          <h3>From images you chose</h3>
          {yours.length > 0 ? (
            <div className="taste-examples__strip">
              {yours.map((item, index) => (
                <button type="button" key={item.id} onClick={() => onOpen(yours, index)} style={{ '--tint': item.color ?? '#23231d' } as React.CSSProperties}>
                  <img src={item.thumbUrl} alt="" loading="lazy" draggable={false} />
                </button>
              ))}
            </div>
          ) : (
            <p>None of your choices show this strongly yet.</p>
          )}
        </div>
        <div>
          <h3>What this looks like in your library</h3>
          <div className="taste-examples__strip">
            {examples.library.map((item, index) => (
              <button type="button" key={item.id} onClick={() => onOpen(examples.library, index)} style={{ '--tint': item.color ?? '#23231d' } as React.CSSProperties}>
                <img src={item.thumbUrl} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
