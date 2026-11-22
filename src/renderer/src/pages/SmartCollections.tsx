import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageItem } from '@shared/types'
import {
  COLOUR_OPTIONS,
  SHAPE_OPTIONS,
  TONE_OPTIONS,
  VIVIDNESS_OPTIONS,
  criteriaAreEmpty,
  detectAesthetics,
  emptyCriteria,
  strictnessWord,
  type ColourId,
  type SmartCollection,
  type SmartCriteria,
  type SmartPreview
} from '@shared/smart'
import { useIndexStatus } from '../lib/useIndexStatus'
import { useInfiniteScroll } from '../lib/useImageFeed'
import { ImageGrid } from '../components/ImageCard'
import { Lightbox } from '../components/Lightbox'
import { EmptyState, ConfirmModal } from '../components/ui'
import { Icon } from '../components/Icon'
import { openAiSetup } from '../components/AiSetup'
import { MoodboardDialog, SelectionBar, sourceTitle, type BoardSource } from '../components/MoodboardDialog'
import { friendlyError, formatNumber } from '../lib/format'
import { ASK_COMPANION_EVENT } from '../components/Companion'
import { useAtlas } from '../lib/useAtlas'

const EXAMPLES = ['teal-toned surreal portraits', 'melancholic landscapes', 'warm cinematic interiors', 'quiet minimal architecture']

function useSmartList(): { list: SmartCollection[] | null; error: string | null; reload: () => Promise<void> } {
  const [list, setList] = useState<SmartCollection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      setList(await window.noema.listSmartCollections())
      setError(null)
    } catch (loadError) {
      setError(friendlyError(loadError))
    }
  }, [])
  useEffect(() => {
    void reload()
    return window.noema.onSmartCollectionsChanged(() => void reload())
  }, [reload])
  return { list, error, reload }
}

type Editing = { mode: 'new'; seed: string } | { mode: 'saved'; id: string }

export function SmartCollectionsPage(): React.JSX.Element {
  const { list, error, reload } = useSmartList()
  const [editing, setEditing] = useState<Editing | null>(null)
  const indexStatus = useIndexStatus()
  const saved = editing?.mode === 'saved' ? list?.find((collection) => collection.id === editing.id) ?? null : null

  if (editing) {
    // Right after saving, the list may not have caught up yet; wait for it rather than leaving the collection.
    if (editing.mode === 'saved' && !saved) {
      return (
        <div className="page page--smart">
          <p className="hint">{list ? 'This collection is no longer there.' : 'Opening…'}</p>
          {list ? <button type="button" className="button button--ghost" onClick={() => setEditing(null)}>All smart collections</button> : null}
        </div>
      )
    }
    return (
      <SmartEditor
        key={editing.mode === 'saved' ? editing.id : `new:${editing.seed}`}
        collection={saved}
        seed={editing.mode === 'new' ? editing.seed : ''}
        onBack={() => {
          setEditing(null)
          void reload()
        }}
        onSaved={(collection) => setEditing({ mode: 'saved', id: collection.id })}
      />
    )
  }

  const modelOff = indexStatus && (!indexStatus.modelInstalled || !indexStatus.enabled)
  const collections = list ?? []

  return (
    <div className="page page--smart">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">SMART COLLECTIONS · DESCRIBE IT, ATLAS FINDS IT</div>
          <h1 className="page-title">
            Smart Collections
            <span className="page-title__count">{formatNumber(collections.length)}</span>
          </h1>
          <p className="page-subtitle">
            Describe a look in your own words, such as “melancholic landscapes”. Atlas finds the matching images with the
            local image model and by measuring colour, and keeps the collection up to date as your library grows. They sit
            beside Families and never move or change your files.
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="button button--gold" onClick={() => setEditing({ mode: 'new', seed: '' })} data-action="new-smart">
            <Icon name="plus" size={16} /> New smart collection
          </button>
        </div>
      </header>

      {error ? (
        <div className="inline-error">
          <Icon name="info" size={16} /> {error}
        </div>
      ) : null}

      {collections.length === 0 ? (
        <EmptyState
          icon="sparkle"
          title="No smart collections yet."
          copy={
            modelOff
              ? 'Descriptions of mood and subject need the optional image model, which runs on this computer. Colour, tone and shape work without it.'
              : 'Describe a look and Atlas will gather the images that fit. Try one of these:'
          }
        >
          {modelOff ? (
            <button type="button" className="button button--gold" onClick={openAiSetup}>
              <Icon name="sparkle" size={16} /> Set up visual search
            </button>
          ) : null}
          <div className="smart-examples">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="smart-example" onClick={() => setEditing({ mode: 'new', seed: example })}>
                {example}
              </button>
            ))}
          </div>
        </EmptyState>
      ) : (
        <div className="family-grid smart-grid">
          {collections.map((collection) => (
            <button key={collection.id} type="button" className="family-card smart-card" onClick={() => setEditing({ mode: 'saved', id: collection.id })}>
              <span className="family-card__mosaic">
                {collection.covers.slice(0, 3).map((cover, position) => (
                  <img key={cover.id} src={cover.thumbUrl} alt="" loading="lazy" draggable={false} data-slot={position} />
                ))}
              </span>
              <span className="family-card__meta">
                <span className="family-card__name" title={collection.name}>{collection.name}</span>
                <span className="family-card__count">
                  {formatNumber(collection.size)} image{collection.size === 1 ? '' : 's'}
                </span>
                {collection.newCount > 0 ? <span className="family-card__tag family-card__tag--own">{formatNumber(collection.newCount)} new</span> : null}
                <span className="smart-card__criteria">{describeCriteria(collection.criteria)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A short line that says what a collection looks for. */
export function describeCriteria(criteria: SmartCriteria): string {
  const parts: string[] = []
  if (criteria.text) parts.push(criteria.text)
  for (const colour of criteria.colours) parts.push(COLOUR_OPTIONS.find((option) => option.id === colour)?.label.toLowerCase() ?? colour)
  if (criteria.tone !== 'any') parts.push(criteria.tone)
  if (criteria.vividness !== 'any') parts.push(criteria.vividness === 'mono' ? 'black and white' : criteria.vividness)
  if (parts.length === 0 && criteria.likes.length > 0) parts.push(`like ${criteria.likes.length} pinned image${criteria.likes.length === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

const PAGE = 90

/** Runs the preview for the current criteria after a short pause, and loads further pages on demand. */
function useSmartPreview(criteria: SmartCriteria, active: boolean): {
  items: Array<ImageItem & { match: number }>
  preview: SmartPreview | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  loadMore: () => Promise<void>
  replaceItem: (item: ImageItem) => void
} {
  const [items, setItems] = useState<Array<ImageItem & { match: number }>>([])
  const [preview, setPreview] = useState<SmartPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const criteriaRef = useRef(criteria)
  criteriaRef.current = criteria
  const key = JSON.stringify(criteria)

  useEffect(() => {
    if (!active) return
    const request = ++sequence.current
    setLoading(true)
    const timer = window.setTimeout(() => {
      window.noema
        .previewSmartCollection(criteriaRef.current, PAGE, 0)
        .then((result) => {
          if (request !== sequence.current) return
          setPreview(result)
          setItems(result.items)
          setError(null)
          setLoading(false)
        })
        .catch((previewError: unknown) => {
          if (request !== sequence.current) return
          setError(friendlyError(previewError))
          setLoading(false)
        })
    }, 280)
    return () => window.clearTimeout(timer)
  }, [key, active])

  const loadMore = useCallback(async () => {
    if (!preview || items.length >= preview.total || loadingMore) return
    const request = sequence.current
    setLoadingMore(true)
    try {
      const page = await window.noema.previewSmartCollection(criteriaRef.current, PAGE, items.length)
      if (request === sequence.current) setItems((current) => [...current, ...page.items])
    } catch (moreError) {
      setError(friendlyError(moreError))
    } finally {
      setLoadingMore(false)
    }
  }, [preview, items.length, loadingMore])

  const replaceItem = useCallback((item: ImageItem) => {
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, ...item } : entry)))
  }, [])

  return { items, preview, loading, loadingMore, error, loadMore, replaceItem }
}

function sameCriteria(a: SmartCriteria, b: SmartCriteria): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function SmartEditor({
  collection,
  seed,
  onBack,
  onSaved
}: {
  collection: SmartCollection | null
  seed: string
  onBack: () => void
  onSaved: (collection: SmartCollection) => void
}): React.JSX.Element {
  const { toast } = useAtlas()
  const initial = useMemo<SmartCriteria>(() => {
    if (collection) return collection.criteria
    const start = emptyCriteria()
    if (seed) {
      const found = detectAesthetics(seed)
      return { ...start, text: seed, colours: found.colours, tone: found.tone, vividness: found.vividness }
    }
    return start
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [criteria, setCriteria] = useState<SmartCriteria>(initial)
  const [name, setName] = useState(collection?.name ?? '')
  const [nameEdited, setNameEdited] = useState(Boolean(collection))
  const [chipsTouched, setChipsTouched] = useState(Boolean(collection))
  const [refineOpen, setRefineOpen] = useState(Boolean(collection && (collection.criteria.avoid || collection.criteria.likes.length || collection.criteria.dislikes.length)))
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<BoardSource | null>(null)
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const anchor = useRef<number | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const indexStatus = useIndexStatus()

  const empty = criteriaAreEmpty(criteria)
  const feed = useSmartPreview(criteria, !empty)
  const total = empty ? 0 : feed.preview?.total ?? 0

  // The marked-as-seen moment: opening a saved collection clears its "new" count.
  useEffect(() => {
    if (collection) void window.noema.markSmartCollectionViewed(collection.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection?.id])

  useInfiniteScroll(sentinelRef, () => void feed.loadMore(), Boolean(feed.preview) && feed.items.length < (feed.preview?.total ?? 0) && !feed.loadingMore)

  const patch = (change: Partial<SmartCriteria>): void => setCriteria((current) => ({ ...current, ...change }))

  const changeText = (text: string): void => {
    setCriteria((current) => {
      const next = { ...current, text }
      if (!chipsTouched) {
        const found = detectAesthetics(text)
        next.colours = found.colours
        next.tone = found.tone
        next.vividness = found.vividness
      }
      return next
    })
  }

  const toggleColour = (id: ColourId): void => {
    setChipsTouched(true)
    setCriteria((current) => ({
      ...current,
      colours: current.colours.includes(id) ? current.colours.filter((c) => c !== id) : [...current.colours, id].slice(-3)
    }))
  }

  const dirty = collection ? !sameCriteria(criteria, collection.criteria) || name.trim() !== collection.name : true
  const effectiveName = name.trim() || criteria.text.replace(/^./, (c) => c.toUpperCase()) || 'Untitled collection'

  const save = async (): Promise<void> => {
    if (empty) return
    setSaving(true)
    try {
      const result = collection
        ? await window.noema.updateSmartCollection(collection.id, { name: effectiveName, criteria })
        : await window.noema.createSmartCollection({ name: effectiveName, criteria })
      toast(collection ? `Saved “${result.name}”.` : `Saved “${result.name}” with ${formatNumber(result.size)} image${result.size === 1 ? '' : 's'}. New matching images will join it automatically.`, 'success')
      onSaved(result)
    } catch (saveError) {
      toast(friendlyError(saveError), 'error')
    } finally {
      setSaving(false)
    }
  }

  const leaveSelection = useCallback((): void => {
    setSelecting(false)
    setPicked(new Set())
    setDialog(null)
    anchor.current = null
  }, [])

  const toggle = (position: number, shift: boolean): void => {
    const item = feed.items[position]
    if (!item) return
    const start = anchor.current
    setPicked((current) => {
      const next = new Set(current)
      if (shift && start !== null) {
        for (let i = Math.min(start, position); i <= Math.max(start, position); i += 1) {
          const entry = feed.items[i]
          if (entry) next.add(entry.id)
        }
      } else if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
    anchor.current = position
  }

  useEffect(() => {
    if (!selecting) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !dialog && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) leaveSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting, dialog, leaveSelection])

  const chosen = Array.from(picked)
  const refineWithPicked = (kind: 'likes' | 'dislikes'): void => {
    const other = kind === 'likes' ? 'dislikes' : 'likes'
    setCriteria((current) => ({
      ...current,
      [kind]: Array.from(new Set([...current[kind], ...chosen])).slice(0, 300),
      [other]: current[other].filter((id) => !chosen.includes(id))
    }))
    setRefineOpen(true)
    toast(
      kind === 'likes'
        ? `Pinned ${chosen.length} image${chosen.length === 1 ? '' : 's'}: they stay in, and Atlas looks for more like them.`
        : `Ruled out ${chosen.length} image${chosen.length === 1 ? '' : 's'}: they stay out, and similar images rank lower.`,
      'success'
    )
    leaveSelection()
  }

  const modelOff = indexStatus && (!indexStatus.modelInstalled || !indexStatus.enabled)
  const title = collection ? collection.name : 'New smart collection'

  // The companion can see what is open here, including settings that are not saved yet.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void window.noema.setCompanionView({ kind: 'smart', id: collection?.id ?? null, name: name.trim() || collection?.name || criteria.text || 'An unsaved smart collection', criteria })
    }, 250)
    return () => window.clearTimeout(timer)
  }, [collection?.id, collection?.name, name, criteria])
  useEffect(() => () => void window.noema.setCompanionView({ kind: null }), [])

  return (
    <div className="page page--smart">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">{collection ? 'SMART COLLECTION' : 'NEW SMART COLLECTION · DESCRIBE THE LOOK'}</div>
          {renaming && collection ? (
            <form
              className="family-rename"
              onSubmit={(event) => {
                event.preventDefault()
                setRenaming(false)
                setNameEdited(true)
              }}
            >
              <input autoFocus aria-label="Collection name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
              <button type="submit" className="button button--gold">Done</button>
            </form>
          ) : (
            <h1 className="page-title family-title">
              <span className="family-title__name">{name || title}</span>
              {collection ? (
                <button type="button" className="icon-button family-title__edit" onClick={() => setRenaming(true)} aria-label="Rename this collection" title="Rename this collection">
                  <Icon name="edit" size={16} />
                </button>
              ) : null}
              <span className="page-title__count">{empty ? '—' : formatNumber(total)}</span>
            </h1>
          )}
          <p className="page-subtitle">
            {collection
              ? 'Saved descriptions keep themselves up to date: images added to your library that match are included automatically. Your files are never moved.'
              : 'Type what you are looking for, adjust the controls and watch the matches change. Nothing is saved until you press Save.'}
          </p>
        </div>
        <div className="page-head__actions">
          {collection ? (
            <button type="button" className="button button--ghost" onClick={() => setConfirmDelete(true)}>
              <Icon name="trash" size={16} /> Delete collection
            </button>
          ) : null}
          {!empty ? (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => window.dispatchEvent(new CustomEvent(ASK_COMPANION_EVENT, { detail: 'Curate the 10 best images from this collection for a moodboard.' }))}
              title="Ask Atlas to choose the strongest images for you, with reasons, and review them before anything is made"
              data-action="curate"
            >
              <Icon name="sparkle" size={16} /> Curate with Atlas
            </button>
          ) : null}
          <button type="button" className="button button--ghost" onClick={onBack}>
            <Icon name="arrowLeft" size={16} /> All smart collections
          </button>
        </div>
      </header>

      <div className="smart-layout">
        <section className="smart-controls" aria-label="Describe the collection">
          <label className="smart-field">
            <span>Describe the look</span>
            <textarea
              rows={2}
              maxLength={240}
              placeholder="e.g. teal-toned surreal portraits"
              value={criteria.text}
              onChange={(event) => changeText(event.target.value)}
              aria-label="Describe the look"
              autoFocus={!collection && !seed}
            />
          </label>
          {!criteria.text && !collection ? (
            <div className="smart-examples smart-examples--inline">
              {EXAMPLES.slice(0, 3).map((example) => (
                <button key={example} type="button" className="smart-example" onClick={() => changeText(example)}>{example}</button>
              ))}
            </div>
          ) : null}

          <div className="smart-field">
            <span>Colours measured in the pixels{!chipsTouched && criteria.colours.length > 0 ? ' · found in your words' : ''}</span>
            <div className="smart-chips" role="group" aria-label="Colours">
              {COLOUR_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`smart-chip ${criteria.colours.includes(option.id) ? 'is-on' : ''}`}
                  aria-pressed={criteria.colours.includes(option.id)}
                  onClick={() => toggleColour(option.id)}
                >
                  <i style={{ background: option.swatch }} />
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="smart-row">
            <label className="smart-field">
              <span>Light</span>
              <select value={criteria.tone} onChange={(event) => { setChipsTouched(true); patch({ tone: event.target.value as SmartCriteria['tone'] }) }} aria-label="Light">
                {TONE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="smart-field">
              <span>Colour strength</span>
              <select value={criteria.vividness} onChange={(event) => { setChipsTouched(true); patch({ vividness: event.target.value as SmartCriteria['vividness'] }) }} aria-label="Colour strength">
                {VIVIDNESS_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <label className="smart-field">
              <span>Shape</span>
              <select value={criteria.shape} onChange={(event) => patch({ shape: event.target.value as SmartCriteria['shape'] })} aria-label="Shape">
                {SHAPE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
          </div>

          <label className="smart-field smart-strict">
            <span>
              How strict <strong>{strictnessWord(criteria.strictness)}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={criteria.strictness}
              onChange={(event) => patch({ strictness: Number(event.target.value) })}
              aria-label="Matching strictness"
            />
            <span className="smart-strict__ends"><small>More images</small><small>Closer matches</small></span>
          </label>

          <button type="button" className="button button--quiet smart-refine-toggle" onClick={() => setRefineOpen((open) => !open)} aria-expanded={refineOpen}>
            <Icon name="chevronDown" size={14} /> Refine further
          </button>
          {refineOpen ? (
            <div className="smart-refine">
              <label className="smart-field">
                <span>Not like this (optional)</span>
                <input value={criteria.avoid} maxLength={160} placeholder="e.g. night scenes, text" onChange={(event) => patch({ avoid: event.target.value })} aria-label="Not like this" />
              </label>
              <p className="hint">
                Pin or rule out single images: choose <strong>Select images</strong> in the results, pick some, then use “More like these” or “Not these”.
              </p>
              <div className="smart-pins">
                <span>{criteria.likes.length} pinned</span>
                {criteria.likes.length > 0 ? <button type="button" className="button button--quiet" onClick={() => patch({ likes: [] })}>Clear pins</button> : null}
                <span>{criteria.dislikes.length} ruled out</span>
                {criteria.dislikes.length > 0 ? <button type="button" className="button button--quiet" onClick={() => patch({ dislikes: [] })}>Clear</button> : null}
              </div>
            </div>
          ) : null}

          <div className="smart-save">
            <label className="smart-field">
              <span>Name</span>
              <input
                value={name}
                maxLength={80}
                placeholder={criteria.text ? criteria.text.replace(/^./, (c) => c.toUpperCase()) : 'Untitled collection'}
                onChange={(event) => {
                  setName(event.target.value)
                  setNameEdited(true)
                }}
                aria-label="Collection name"
              />
            </label>
            <button type="button" className="button button--gold" disabled={empty || saving || !dirty || (modelOff === true && criteria.text !== '' && Boolean(feed.preview?.problem))} onClick={() => void save()} data-action="save-smart">
              <Icon name="check" size={16} /> {collection ? (dirty ? 'Save changes' : 'Saved') : 'Save collection'}
            </button>
            {nameEdited && !name.trim() && !collection ? <span className="hint">The description will be used as the name.</span> : null}
          </div>
        </section>

        <section className="smart-results" aria-label="Preview">
          <div className="smart-summary" role="status">
            {empty ? (
              <span>Describe a look or choose a colour to see matching images.</span>
            ) : feed.preview?.problem ? (
              <>
                <span>{feed.preview.problem}</span>
                <button type="button" className="button button--gold" onClick={openAiSetup}><Icon name="sparkle" size={16} /> Set up visual search</button>
              </>
            ) : (
              <>
                <strong data-testid="smart-count">{feed.loading && !feed.preview ? 'Looking…' : `${formatNumber(total)} image${total === 1 ? '' : 's'} match`}</strong>
                <span>{feed.preview?.explanation ?? ''}</span>
              </>
            )}
          </div>

          {!empty && !feed.preview?.problem ? (
            <div className="smart-actions">
              <button type="button" className={`button ${selecting ? 'button--gold' : 'button--ghost'}`} onClick={() => (selecting ? leaveSelection() : setSelecting(true))} aria-pressed={selecting} disabled={total === 0}>
                <Icon name="check" size={16} /> {selecting ? 'Done selecting' : 'Select images'}
              </button>
              {!selecting ? (
                <button type="button" className="button button--ghost" disabled={total === 0} onClick={() => setDialog('all')} data-action="all-board">
                  <Icon name="boards" size={16} /> {sourceTitle('all', total)}
                </button>
              ) : null}
            </div>
          ) : null}

          {selecting ? (
            <SelectionBar
              picked={picked.size}
              total={total}
              onSelectAll={() => void window.noema.previewSmartCollectionIds(criteria).then((ids) => setPicked(new Set(ids)))}
              onClear={() => setPicked(new Set())}
              onSelectedBoard={() => setDialog('selected')}
              onAllBoard={() => setDialog('all')}
            >
              <button type="button" className="button button--quiet" disabled={picked.size === 0} onClick={() => refineWithPicked('likes')} data-action="pin">
                More like these ({picked.size})
              </button>
              <button type="button" className="button button--quiet" disabled={picked.size === 0} onClick={() => refineWithPicked('dislikes')} data-action="rule-out">
                Not these ({picked.size})
              </button>
            </SelectionBar>
          ) : null}

          {feed.error ? (
            <div className="inline-error">
              <Icon name="info" size={16} /> {feed.error}
            </div>
          ) : null}

          {!empty && !feed.preview?.problem ? (
            <ImageGrid
              items={feed.items}
              loading={feed.loading && feed.items.length === 0}
              loadingMore={feed.loadingMore}
              hasMore={feed.preview ? feed.items.length < feed.preview.total : false}
              density={Number(localStorage.getItem('atlas.density') ?? 1)}
              onOpen={setOpenIndex}
              onUpdate={feed.replaceItem}
              onLoadMore={() => void feed.loadMore()}
              sentinelRef={sentinelRef}
              selection={selecting ? { selected: picked, onToggle: toggle } : undefined}
              empty={
                <EmptyState icon="sparkle" title="Nothing matches yet." copy="Try a lower strictness, remove a colour, or describe the look differently." />
              }
            />
          ) : null}
        </section>
      </div>

      {dialog ? (
        <MoodboardDialog
          source={dialog}
          loadIds={dialog === 'selected' ? () => Promise.resolve(chosen) : () => window.noema.previewSmartCollectionIds(criteria)}
          defaultName={effectiveName}
          onClose={() => setDialog(null)}
          onDone={() => leaveSelection()}
        />
      ) : null}

      {openIndex !== null && feed.items[openIndex] ? (
        <Lightbox items={feed.items} initialIndex={openIndex} onClose={() => setOpenIndex(null)} onUpdate={feed.replaceItem} />
      ) : null}

      {confirmDelete && collection ? (
        <ConfirmModal
          open
          title={`Delete “${collection.name}”?`}
          description="Only the saved description is removed. Your images and moodboards are not touched."
          confirmLabel="Delete collection"
          tone="danger"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await window.noema.deleteSmartCollection(collection.id)
            onBack()
          }}
        />
      ) : null}
    </div>
  )
}
