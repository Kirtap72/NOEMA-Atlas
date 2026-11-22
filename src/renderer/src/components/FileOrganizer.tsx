import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ImageItem,
  OrganizeMode,
  OrganizeProgress,
  OrganizeResult,
  OrganizeSelection
} from '@shared/types'
import { useAtlas } from '../lib/useAtlas'
import { useDebouncedValue, useImageFeed, useInfiniteScroll } from '../lib/useImageFeed'
import { Icon } from '../components/Icon'
import { ConfirmModal, Spinner } from '../components/ui'
import { formatNumber, friendlyError } from '../lib/format'

type SelectionTab = 'keep' | 'pass' | 'five' | 'four' | 'three' | 'all' | 'manual'

interface TabDefinition {
  id: SelectionTab
  label: string
  description: string
  icon: 'heart' | 'close' | 'star' | 'archive' | 'collection'
}

const TABS: TabDefinition[] = [
  {
    id: 'keep',
    label: 'Keep',
    description: 'Everything you have kept or favourited.',
    icon: 'heart'
  },
  {
    id: 'pass',
    label: 'Pass',
    description: 'Images you deliberately passed over.',
    icon: 'close'
  },
  {
    id: 'five',
    label: '5 stars',
    description: 'Only your five-star images.',
    icon: 'star'
  },
  {
    id: 'four',
    label: '4 stars & up',
    description: 'Four-star images and five-star images.',
    icon: 'star'
  },
  {
    id: 'three',
    label: '3 stars & up',
    description: 'Everything rated three stars or higher.',
    icon: 'star'
  },
  {
    id: 'all',
    label: 'All images',
    description: 'Every available image in the library.',
    icon: 'collection'
  },
  {
    id: 'manual',
    label: 'Manual selection',
    description: 'Choose the exact images yourself.',
    icon: 'archive'
  }
]

export function FileOrganizer({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const { toast, refresh } = useAtlas()
  const [tab, setTab] = useState<SelectionTab>('keep')
  const [counts, setCounts] = useState<Record<SelectionTab, number>>({
    keep: 0,
    pass: 0,
    five: 0,
    four: 0,
    three: 0,
    all: 0,
    manual: 0
  })
  const [manualIds, setManualIds] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [destination, setDestination] = useState<string | null>(null)
  const [mode, setMode] = useState<OrganizeMode>('copy')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<OrganizeProgress | null>(null)
  const [result, setResult] = useState<OrganizeResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmMove, setConfirmMove] = useState(false)
  const [choosingFolder, setChoosingFolder] = useState(false)
  const debouncedSearch = useDebouncedValue(search, 160)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const query = useMemo(() => {
    const base = {
      scope: 'archive' as const,
      search: tab === 'manual' ? debouncedSearch : '',
      sort: 'name' as const,
      limit: 60
    }
    if (tab === 'keep') return { ...base, decision: 'keep' as const }
    if (tab === 'pass') return { ...base, decision: 'pass' as const }
    if (tab === 'five') return { ...base, exactRating: 5 }
    if (tab === 'four') return { ...base, minRating: 4 }
    if (tab === 'three') return { ...base, minRating: 3 }
    return base
  }, [debouncedSearch, tab])

  const feed = useImageFeed(query, open && !result)
  useInfiniteScroll(sentinelRef, () => void feed.loadMore(), open && feed.hasMore && !feed.loading)

  const refreshCounts = useCallback(async () => {
    try {
      const [keep, pass, five, four, three, all] = await Promise.all([
        window.noema.listImages({ scope: 'archive', decision: 'keep', limit: 1 }),
        window.noema.listImages({ scope: 'archive', decision: 'pass', limit: 1 }),
        window.noema.listImages({ scope: 'archive', exactRating: 5, limit: 1 }),
        window.noema.listImages({ scope: 'archive', minRating: 4, limit: 1 }),
        window.noema.listImages({ scope: 'archive', minRating: 3, limit: 1 }),
        window.noema.listImages({ scope: 'archive', limit: 1 })
      ])
      setCounts((current) => ({
        ...current,
        keep: keep.total,
        pass: pass.total,
        five: five.total,
        four: four.total,
        three: three.total,
        all: all.total,
        manual: current.manual
      }))
    } catch (countError) {
      setError(friendlyError(countError))
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setTab('keep')
    setSearch('')
    setManualIds(new Set())
    setMode('copy')
    setDestination(null)
    setResult(null)
    setProgress(null)
    setError(null)
    void refreshCounts()
  }, [open, refreshCounts])

  useEffect(() => {
    if (!open) return
    return window.noema.onOrganizeProgress((next) => {
      setProgress(next)
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy && !confirmMove) {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [busy, confirmMove, onClose, open])

  const total =
    tab === 'manual'
      ? manualIds.size
      : counts[tab] || feed.total

  const selection: OrganizeSelection | null = useMemo(() => {
    if (total <= 0) return null
    if (tab === 'manual') return { kind: 'manual', ids: Array.from(manualIds) }
    if (tab === 'keep') return { kind: 'keep' }
    if (tab === 'pass') return { kind: 'pass' }
    if (tab === 'five') return { kind: 'stars', minRating: 5 }
    if (tab === 'four') return { kind: 'stars', minRating: 4 }
    if (tab === 'three') return { kind: 'stars', minRating: 3 }
    return { kind: 'all' }
  }, [manualIds, tab, total])

  const chooseFolder = async (): Promise<void> => {
    setChoosingFolder(true)
    try {
      const selected = await window.noema.chooseOrganizeDestination()
      if (selected) setDestination(selected)
    } catch (chooseError) {
      toast(friendlyError(chooseError), 'error')
    } finally {
      setChoosingFolder(false)
    }
  }

  const execute = async (): Promise<void> => {
    if (!selection || !destination) return
    setBusy(true)
    setResult(null)
    setError(null)
    setProgress({
      processed: 0,
      total,
      currentFile: null,
      mode,
      copied: 0,
      moved: 0,
      renamed: 0,
      skipped: 0,
      failed: 0
    })
    try {
      const outcome = await window.noema.organize({ selection, destination, mode })
      setResult(outcome)
      setManualIds(new Set())
      await refreshCounts()
      await refresh()
      if (outcome.failed > 0) {
        toast(`${outcome.failed} image${outcome.failed === 1 ? '' : 's'} could not be filed.`, 'error')
      } else if (mode === 'move') {
        toast(`Moved ${formatNumber(outcome.moved)} images. Library updated.`, 'success')
      } else {
        toast(`Copied ${formatNumber(outcome.copied)} images. Originals untouched.`, 'success')
      }
    } catch (organizeError) {
      setError(friendlyError(organizeError))
    } finally {
      setBusy(false)
      setConfirmMove(false)
    }
  }

  const toggleManual = (id: string): void => {
    setManualIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setCounts((value) => ({ ...value, manual: next.size }))
      return next
    })
  }

  const selectAllLoaded = (): void => {
    setManualIds((current) => {
      const next = new Set(current)
      for (const item of feed.items) next.add(item.id)
      setCounts((value) => ({ ...value, manual: next.size }))
      return next
    })
  }

  if (!open) return null

  const activeTab = TABS.find((entry) => entry.id === tab)!
  const progressPercent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.processed / progress.total) * 100)) : 0

  return createPortal(
    <div className="organizer-scrim">
      <div className="organizer" role="dialog" aria-modal="true" aria-labelledby="organizer-title">
        <header className="organizer__head">
          <div>
            <div className="eyebrow">THE FILE ROOM · COPY OR MOVE</div>
            <h1 id="organizer-title" className="organizer__title">
              File images
            </h1>
            <p className="organizer__subtitle">
              Choose a set, choose a folder. Copy is the default. Move updates the library in place, so
              ratings, tags and moodboards stay with each image.
            </p>
          </div>
          <button
            type="button"
            className="icon-button organizer__close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close filing"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        {result ? (
          <FileResult
            result={result}
            onDone={onClose}
            onAgain={() => {
              setResult(null)
              setProgress(null)
              setError(null)
            }}
          />
        ) : (
          <>
            <div className="organizer__body">
              <aside className="organizer__rail" aria-label="Image selection">
                <div className="organizer__rail-label">WHAT TO FILE</div>
                {TABS.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`organizer-tab ${tab === entry.id ? 'is-active' : ''}`}
                    onClick={() => {
                      setTab(entry.id)
                      setSearch('')
                    }}
                  >
                    <span className="organizer-tab__icon">
                      <Icon name={entry.icon} size={15} />
                    </span>
                    <span className="organizer-tab__copy">
                      <strong>{entry.label}</strong>
                      <small>{entry.description}</small>
                    </span>
                    <span className="organizer-tab__count">
                      {entry.id === 'manual' ? formatNumber(manualIds.size) : formatNumber(counts[entry.id])}
                    </span>
                  </button>
                ))}
                <div className="organizer__rail-note">
                  <Icon name="shield" size={14} />
                  <p>Filing only copies or moves files you explicitly choose. Nothing is ever deleted by cleaning up.</p>
                </div>
              </aside>

              <section className="organizer__main">
                <div className="organizer__selection-head">
                  <div>
                    <div className="eyebrow">{activeTab.label}</div>
                    <h2>
                      {total > 0 ? `${formatNumber(total)} ${total === 1 ? 'image' : 'images'}` : 'Nothing here yet'}
                    </h2>
                    <p>
                      {tab === 'manual'
                        ? 'Click images to build an exact selection.'
                        : activeTab.description + ' Every matching image will be included.'}
                    </p>
                  </div>
                  {tab === 'manual' ? (
                    <div className="organizer__manual-controls">
                      <button type="button" className="link-button" onClick={selectAllLoaded} disabled={feed.items.length === 0}>
                        Select shown
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => {
                          setManualIds(new Set())
                          setCounts((value) => ({ ...value, manual: 0 }))
                        }}
                        disabled={manualIds.size === 0}
                      >
                        Clear
                      </button>
                    </div>
                  ) : null}
                </div>

                {tab === 'manual' ? (
                  <div className="organizer__search">
                    <Icon name="search" size={16} />
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by filename, folder or tag…"
                      spellCheck={false}
                    />
                    {search ? (
                      <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
                        <Icon name="close" size={13} />
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className="organizer__preview">
                  {feed.loading && feed.items.length === 0 ? (
                    <div className="organizer__loading">
                      <Spinner size={20} /> Gathering images…
                    </div>
                  ) : feed.items.length === 0 ? (
                    <div className="organizer__empty">
                      <Icon name="folder" size={25} strokeWidth={1.1} />
                      <span>{tab === 'manual' ? 'No images match this search.' : 'No images in this selection yet.'}</span>
                    </div>
                  ) : (
                    feed.items.map((item) => (
                      <OrganizerTile
                        key={item.id}
                        item={item}
                        manual={tab === 'manual'}
                        selected={tab === 'manual' ? manualIds.has(item.id) : true}
                        onToggle={() => toggleManual(item.id)}
                      />
                    ))
                  )}
                </div>
                <div ref={sentinelRef} className="organizer__more">
                  {feed.loadingMore ? (
                    <span><Spinner size={14} /> Loading more…</span>
                  ) : feed.hasMore ? (
                    <button type="button" className="button button--quiet" onClick={() => void feed.loadMore()}>
                      Load more
                    </button>
                  ) : feed.items.length > 0 ? (
                    <span>Showing the selection preview</span>
                  ) : null}
                </div>
              </section>
            </div>

            <footer className="organizer__dock">
              <div className="organizer__destination">
                <div className="organizer__dock-label">DESTINATION</div>
                <div className="organizer__destination-row">
                  <span className="organizer__folder-icon">
                    <Icon name="folder" size={18} />
                  </span>
                  <div className="organizer__destination-copy">
                    <strong>{destination ? destination.split(/[\\/]/).filter(Boolean).pop() : 'No folder chosen'}</strong>
                    <span title={destination ?? undefined}>{destination ?? 'Choose a folder on any drive.'}</span>
                  </div>
                  <button type="button" className="button button--ghost" onClick={() => void chooseFolder()} disabled={busy || choosingFolder}>
                    {choosingFolder ? 'Choosing…' : destination ? 'Change' : 'Choose folder'}
                  </button>
                </div>
              </div>

              <div className="organizer__mode">
                <div className="organizer__dock-label">METHOD</div>
                <div className="organizer__mode-toggle" role="group" aria-label="Copy or move">
                  <button
                    type="button"
                    className={mode === 'copy' ? 'is-active' : ''}
                    onClick={() => setMode('copy')}
                    disabled={busy}
                  >
                    <Icon name="copy" size={14} /> Copy
                    <small>Default</small>
                  </button>
                  <button
                    type="button"
                    className={mode === 'move' ? 'is-active is-move' : ''}
                    onClick={() => setMode('move')}
                    disabled={busy}
                  >
                    <Icon name="move" size={14} /> Move
                    <small>Updates library</small>
                  </button>
                </div>
              </div>

              <div className="organizer__action">
                {error ? <div className="organizer__error">{error}</div> : null}
                {busy ? (
                  <div className="organizer__progress">
                    <div className="organizer__progress-top">
                      <span>{progress?.currentFile ?? 'Preparing…'}</span>
                      <span>{progressPercent}%</span>
                    </div>
                    <div className="organizer__progress-bar">
                      <span style={{ width: `${Math.max(2, progressPercent)}%` }} />
                    </div>
                    <div className="organizer__progress-meta">
                      {formatNumber(progress?.processed ?? 0)} / {formatNumber(progress?.total ?? total)}
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`button button--gold organizer__submit ${mode === 'move' ? 'is-move' : ''}`}
                    disabled={!selection || !destination || total === 0}
                    onClick={() => {
                      if (mode === 'move') setConfirmMove(true)
                      else void execute()
                    }}
                  >
                    <Icon name={mode === 'move' ? 'move' : 'copy'} size={15} />
                    {mode === 'move'
                      ? `Move ${formatNumber(total)} image${total === 1 ? '' : 's'}…`
                      : `Copy ${formatNumber(total)} image${total === 1 ? '' : 's'}`}
                  </button>
                )}
                <p className="organizer__fineprint">
                  {mode === 'copy'
                    ? 'Copies are exports. The library stays pointed at your originals.'
                    : 'Move copies, verifies and updates the catalogue before removing the source. Conflicts are renamed.'}
                </p>
              </div>
            </footer>
          </>
        )}
      </div>

      <ConfirmModal
        open={confirmMove}
        title={`Move ${formatNumber(total)} image${total === 1 ? '' : 's'}?`}
        description={
          <div>
            <p>
              They will be copied to <strong>{destination}</strong>, verified, and recorded at their new
              location. Ratings, tags and moodboard placements are preserved.
            </p>
            <p className="modal__emphasis">
              Only after the copy and catalogue update succeed will the original source files be removed.
              Existing files are never overwritten; name conflicts get a numbered suffix.
            </p>
          </div>
        }
        confirmLabel="Yes, move them"
        tone="danger"
        onClose={() => setConfirmMove(false)}
        onConfirm={() => {
          setConfirmMove(false)
          void execute()
        }}
      />
    </div>,
    document.body
  )
}

function OrganizerTile({
  item,
  manual,
  selected,
  onToggle
}: {
  item: ImageItem
  manual: boolean
  selected: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`organizer-tile ${selected ? 'is-selected' : ''} ${manual ? 'is-manual' : 'is-preset'}`}
      data-image-id={item.id}
      onClick={manual ? onToggle : undefined}
      tabIndex={manual ? 0 : -1}
      aria-pressed={manual ? selected : undefined}
      title={`${item.filename}${item.rating ? ` · ${item.rating} stars` : ''}`}
    >
      <img src={item.thumbUrl} alt={item.filename} loading="lazy" draggable={false} />
      <span className="organizer-tile__shade" />
      <span className="organizer-tile__check">
        {selected ? <Icon name="check" size={13} /> : null}
      </span>
      <span className="organizer-tile__name">{item.filename}</span>
      {item.rating > 0 ? (
        <span className="organizer-tile__rating">
          <Icon name="star" size={9} /> {item.rating}
        </span>
      ) : null}
      {item.decision === 'pass' ? <span className="organizer-tile__decision">Passed</span> : null}
    </button>
  )
}

function FileResult({
  result,
  onDone,
  onAgain
}: {
  result: OrganizeResult
  onDone: () => void
  onAgain: () => void
}): React.JSX.Element {
  const completed = result.mode === 'move' ? result.moved : result.copied
  const failures = result.items.filter((item) => item.status === 'failed')
  const warnings = result.items.filter((item) => item.status === 'moved' && item.error)
  const renamed = result.items.filter((item) => item.renamed)
  return (
    <div className="organizer-result">
      <div className={`organizer-result__mark ${result.failed > 0 ? 'has-errors' : ''}`}>
        <Icon name={result.mode === 'move' ? 'move' : 'copy'} size={28} strokeWidth={1.1} />
      </div>
      <div className="eyebrow">{result.mode === 'move' ? 'MOVE COMPLETE' : 'COPY COMPLETE'}</div>
      <h2 className="organizer-result__title">
        {completed > 0
          ? `${formatNumber(completed)} ${completed === 1 ? 'image' : 'images'} ${result.mode === 'move' ? 'moved' : 'copied'}.`
          : 'Nothing was filed.'}
      </h2>
      <p className="organizer-result__copy">
        {result.mode === 'move'
          ? 'The library now points to the new location. Your ratings, tags and moodboard placements came with it.'
          : 'The copies are complete. Your originals and the library are unchanged.'}
      </p>
      <div className="organizer-result__stats">
        <div><strong>{formatNumber(completed)}</strong><span>{result.mode}</span></div>
        <div><strong>{formatNumber(result.renamed)}</strong><span>renamed</span></div>
        <div><strong>{formatNumber(result.skipped)}</strong><span>skipped</span></div>
        <div><strong>{formatNumber(result.failed)}</strong><span>failed</span></div>
      </div>
      <div className="organizer-result__path">
        <Icon name="folder" size={14} />
        <span>{result.destination}</span>
      </div>
      {renamed.length > 0 ? (
        <div className="organizer-result__list">
          <div className="organizer-result__list-title">Renamed to avoid overwriting</div>
          {renamed.slice(0, 8).map((item) => (
            <div key={item.id}>
              <span>{item.filename}</span>
              <Icon name="arrowRight" size={12} />
              <strong>{item.finalName}</strong>
            </div>
          ))}
          {renamed.length > 8 ? <div className="organizer-result__more">and {renamed.length - 8} more</div> : null}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="organizer-result__list organizer-result__list--error">
          <div className="organizer-result__list-title">Completed with notes</div>
          {warnings.slice(0, 8).map((item) => (
            <div key={item.id}>
              <span>{item.filename}</span>
              <strong>{item.error}</strong>
            </div>
          ))}
        </div>
      ) : null}
      {failures.length > 0 ? (
        <div className="organizer-result__list organizer-result__list--error">
          <div className="organizer-result__list-title">Could not be filed</div>
          {failures.slice(0, 8).map((item) => (
            <div key={item.id}>
              <span>{item.filename}</span>
              <strong>{item.error ?? 'Unknown error'}</strong>
            </div>
          ))}
          {failures.length > 8 ? <div className="organizer-result__more">and {failures.length - 8} more</div> : null}
        </div>
      ) : null}
      <div className="organizer-result__actions">
        <button type="button" className="button button--ghost" onClick={onAgain}>
          File more images
        </button>
        <button type="button" className="button button--gold" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  )
}
