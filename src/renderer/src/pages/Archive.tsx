import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImageItem, ImageSort, IndexStatus, RootFolder } from '@shared/types'
import { useAtlas } from '../lib/useAtlas'
import { useIndexStatus } from '../lib/useIndexStatus'
import { openAiSetup } from '../components/AiSetup'
import { useDebouncedValue, useImageFeed, useInfiniteScroll } from '../lib/useImageFeed'
import { Icon } from '../components/Icon'
import { EmptyState } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { formatBytes, formatCount, formatDate, formatNumber, dimensions } from '../lib/format'

export function ArchivePage({ onFileImages }: { onFileImages: () => void }): React.JSX.Element {
  const { roots, stats, chooseFolders, scan } = useAtlas()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | 'keep' | 'pass' | 'unreviewed'>('')
  const [minRating, setMinRating] = useState(0)
  const [rootId, setRootId] = useState('')
  const [sort, setSort] = useState<ImageSort>('captured')
  const [includeMissing, setIncludeMissing] = useState(false)
  const [density, setDensity] = useState(() => Number(localStorage.getItem('atlas.archiveDensity') ?? 1))
  const [selected, setSelected] = useState<number | null>(null)
  const [mode, setMode] = useState<'visual' | 'words'>(() =>
    localStorage.getItem('atlas.searchMode') === 'words' ? 'words' : 'visual'
  )
  const [similarTo, setSimilarTo] = useState<ImageItem | null>(null)
  const indexStatus = useIndexStatus()
  const visualAvailable = Boolean(
    indexStatus && indexStatus.enabled && indexStatus.modelInstalled && indexStatus.indexed > 0
  )
  const visual = mode === 'visual' && visualAvailable
  const visualActive = visual && (similarTo !== null || search.trim().length > 0)
  const debouncedSearch = useDebouncedValue(search, 170)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem('atlas.searchMode', mode)
    } catch {
      // The mode is a convenience only.
    }
  }, [mode])

  useEffect(() => {
    localStorage.setItem('atlas.archiveDensity', String(density))
  }, [density])

  useEffect(() => {
    const focus = (): void => {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    window.addEventListener('atlas:focus-archive', focus)
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        const target = event.target as HTMLElement | null
        if (target?.tagName !== 'INPUT' && target?.tagName !== 'TEXTAREA') {
          event.preventDefault()
          focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('atlas:focus-archive', focus)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const query = useMemo(
    () => ({
      scope: 'archive' as const,
      search: debouncedSearch,
      rootId: rootId || null,
      minRating,
      decision: statusFilter === 'keep' || statusFilter === 'pass' ? statusFilter : undefined,
      unreviewed: statusFilter === 'unreviewed',
      sort,
      includeMissing,
      visual: visual || undefined,
      similarTo: visual && similarTo ? similarTo.id : undefined,
      limit: 120
    }),
    [debouncedSearch, rootId, minRating, statusFilter, sort, includeMissing, visual, similarTo]
  )
  const feed = useImageFeed(query)
  useInfiniteScroll(sentinelRef, () => void feed.loadMore(), feed.hasMore && !feed.loading)
  const activeScan = Boolean(scan && ['queued', 'walking', 'processing', 'finalizing'].includes(scan.phase))
  const wasScanning = useRef(activeScan)

  useEffect(() => {
    if (wasScanning.current && !activeScan) {
      void feed.refresh()
    }
    wasScanning.current = activeScan
  }, [activeScan, feed.refresh])

  const toggleFavorite = async (event: React.MouseEvent, item: ImageItem): Promise<void> => {
    event.stopPropagation()
    const updated = await window.noema.updateImage({ id: item.id, favorite: !item.favorite })
    feed.replaceItem(updated)
  }

  const filterActive = Boolean(search || similarTo || statusFilter || minRating || rootId || includeMissing)
  const clear = (): void => {
    setSearch('')
    setSimilarTo(null)
    setStatusFilter('')
    setMinRating(0)
    setRootId('')
    setIncludeMissing(false)
  }

  return (
    <div className="page page--archive">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">THE ARCHIVE · EVERYTHING INDEXED</div>
          <h1 className="page-title">
            The Archive
            <span className="page-title__count">{formatNumber(stats.images)}</span>
          </h1>
          <p className="page-subtitle">
            Every image you have ever brought into Atlas. Searchable by name, folder and tag — even the ones
            you passed over.
          </p>
        </div>
        <div className="page-head__actions">
          {stats.favorites > 0 ? (
            <div className="archive-kept">
              <span>{formatNumber(stats.favorites)}</span>
              <small>kept</small>
            </div>
          ) : null}
          <button type="button" className="button button--ghost" onClick={onFileImages}>
            <Icon name="organize" size={16} /> File images
          </button>
          <button type="button" className="button button--gold" onClick={() => void chooseFolders()}>
            <Icon name="plus" size={16} /> Add folder
          </button>
        </div>
      </header>

      <div className="archive-search">
        <Icon name={visual ? 'sparkle' : 'search'} size={24} />
        {similarTo ? (
          <span className="archive-search__chip" title={similarTo.filename}>
            <img src={similarTo.thumbUrl} alt="" />
            Like {similarTo.filename}
            <button type="button" onClick={() => setSimilarTo(null)} aria-label="Stop searching by this image">
              <Icon name="close" size={12} />
            </button>
          </span>
        ) : null}
        <input
          ref={searchRef}
          id="archive-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={
            visual
              ? 'Describe what you are looking for: lonely house in fog, ett öga i ett landskap…'
              : 'Search the archive — a filename, a folder, a tag…'
          }
          aria-label="Search the archive"
          spellCheck={false}
        />
        {visualAvailable ? (
          <div className="mode-toggle" role="group" aria-label="Search mode">
            <button type="button" className={visual ? 'is-active' : ''} onClick={() => setMode('visual')} title="Find images by what they look like">
              Looks like
            </button>
            <button type="button" className={!visual ? 'is-active' : ''} onClick={() => setMode('words')} title="Match filenames, folders and tags">
              Names &amp; tags
            </button>
          </div>
        ) : null}
        {search ? (
          <button type="button" onClick={() => setSearch('')} className="archive-search__clear" aria-label="Clear search">
            <Icon name="close" size={16} />
          </button>
        ) : (
          <kbd className="archive-search__hint">Ctrl K</kbd>
        )}
      </div>

      <div className="archive-controls">
        <div className="archive-controls__left">
          <span className="archive-result-count">
            {visualActive ? (
              <>
                <strong>{formatNumber(feed.total)}</strong> {feed.total >= 400 ? 'closest' : 'matching'} images
                {similarTo ? '' : <> to “{debouncedSearch}”</>}
              </>
            ) : debouncedSearch ? (
              <>
                <strong>{formatNumber(feed.total)}</strong> results for “{debouncedSearch}”
              </>
            ) : (
              <>
                <strong>{formatNumber(feed.total)}</strong> images
              </>
            )}
          </span>
          {filterActive ? (
            <button type="button" className="link-button" onClick={clear}>
              Clear filters
            </button>
          ) : null}
          <IndexNote status={indexStatus} />
        </div>
        <div className="archive-controls__right">
          <label className="select-field" title="Decision status">
            <Icon name="eye" size={14} />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as '' | 'keep' | 'pass' | 'unreviewed')}
              aria-label="Filter by decision status"
            >
              <option value="">All statuses</option>
              <option value="keep">Keep</option>
              <option value="pass">Pass</option>
              <option value="unreviewed">Unreviewed</option>
            </select>
            <Icon name="chevronDown" size={12} className="select-field__chevron" />
          </label>
          <label className="select-field" title="Filter by source">
            <Icon name="folder" size={14} />
            <select value={rootId} onChange={(event) => setRootId(event.target.value)} aria-label="Filter by source">
              <option value="">All sources</option>
              {roots.map((root) => (
                <option value={root.id} key={root.id}>
                  {root.name}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={12} className="select-field__chevron" />
          </label>
          <label className="select-field" title="Minimum rating">
            <Icon name="star" size={14} />
            <select
              value={minRating}
              onChange={(event) => setMinRating(Number(event.target.value))}
              aria-label="Minimum rating"
            >
              <option value={0}>Any rating</option>
              <option value={1}>1 star & up</option>
              <option value={2}>2 stars & up</option>
              <option value={3}>3 stars & up</option>
              <option value={4}>4 stars & up</option>
              <option value={5}>5 stars</option>
            </select>
            <Icon name="chevronDown" size={12} className="select-field__chevron" />
          </label>
          <label className="select-field" title="Sort">
            <Icon name="sort" size={14} />
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as ImageSort)}
              aria-label="Sort archive"
              disabled={visualActive}
              title={visualActive ? 'Visual matches are ordered by similarity' : 'Sort'}
            >
              <option value="captured">File date</option>
              <option value="recent">Recently added</option>
              <option value="name">Name A–Z</option>
              <option value="folder">Folder A–Z</option>
              <option value="rating">Highest rated</option>
              <option value="size">Largest file</option>
            </select>
            <Icon name="chevronDown" size={12} className="select-field__chevron" />
          </label>
          <div className="density-control" role="group" aria-label="Thumbnail size">
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
          <label className="switch-field">
            <input
              type="checkbox"
              checked={includeMissing}
              onChange={(event) => setIncludeMissing(event.target.checked)}
            />
            <span className="switch-field__track" />
            <span>Include missing</span>
          </label>
        </div>
      </div>

      {feed.error ? (
        <div className="inline-error">
          <Icon name="info" size={16} /> {feed.error}
        </div>
      ) : null}

      {!feed.loading && feed.items.length === 0 ? (
        <EmptyState
          icon={filterActive ? 'search' : 'archive'}
          title={filterActive ? 'No trace of that.' : 'An archive waiting to be filled.'}
          copy={
            filterActive
              ? 'Nothing matches this combination. Try a shorter phrase, or clear the filters.'
              : 'Choose a folder and Atlas will quietly index every image it can read — without touching the originals.'
          }
        >
          {filterActive ? (
            <button type="button" className="button button--ghost" onClick={clear}>
              Clear filters
            </button>
          ) : (
            <button type="button" className="button button--gold" onClick={() => void chooseFolders()}>
              <Icon name="plus" size={16} /> Choose a folder
            </button>
          )}
        </EmptyState>
      ) : (
        <>
          <div className={`archive-table archive-table--density-${density}`} role="table" aria-label="Image archive">
            <div className="archive-table__head" role="row">
              <span role="columnheader">Image</span>
              <span role="columnheader">Source</span>
              <span role="columnheader">Details</span>
              <span role="columnheader">File date</span>
              <span role="columnheader">Rating</span>
              <span role="columnheader" aria-label="Favorite" />
            </div>
            {feed.loading && feed.items.length === 0
              ? Array.from({ length: 8 }).map((_, index) => <div className="archive-row archive-row--skeleton" key={index} />)
              : feed.items.map((item, index) => (
                  <ArchiveRow
                    key={item.id}
                    item={item}
                    index={index}
                    query={visualActive ? '' : debouncedSearch}
                    onOpen={() => setSelected(index)}
                    onFavorite={(event) => void toggleFavorite(event, item)}
                  />
                ))}
          </div>
          <div ref={sentinelRef} className="feed-sentinel">
            {feed.loadingMore ? (
              <span className="feed-loader">
                <span className="spinner" /> Reading further
              </span>
            ) : feed.hasMore ? (
              <button type="button" className="button button--quiet" onClick={() => void feed.loadMore()}>
                Load more
              </button>
            ) : feed.items.length > 0 ? (
              <span className="feed-end">
                End of the archive · {formatCount(feed.items.length)} of {formatCount(feed.total)} shown
              </span>
            ) : null}
          </div>
        </>
      )}

      {selected !== null && feed.items[selected] ? (
        <Lightbox
          items={feed.items}
          initialIndex={selected}
          onClose={() => setSelected(null)}
          onUpdate={feed.replaceItem}
          onFindSimilar={
            visualAvailable
              ? (item) => {
                  setMode('visual')
                  setSearch('')
                  setSimilarTo(item)
                  setSelected(null)
                }
              : undefined
          }
        />
      ) : null}
    </div>
  )
}

function IndexNote({ status }: { status: IndexStatus | null }): React.JSX.Element | null {
  if (!status) return null
  if (!status.enabled || !status.modelInstalled) {
    return (
      <button type="button" className="link-button" onClick={openAiSetup}>
        {status.modelInstalled ? 'Turn on visual search' : 'Set up visual search'}
      </button>
    )
  }
  if (status.state === 'error') return <span className="index-note index-note--warn">{status.message ?? 'Indexing stopped'}</span>
  if (status.state === 'loading') return <span className="index-note">Starting the image model…</span>
  if (status.total > 0 && status.indexed < status.total) {
    return (
      <span className="index-note">
        {status.state === 'paused' ? 'Paused · ' : 'Learning your images · '}
        {formatNumber(status.indexed)} / {formatNumber(status.total)}
        {status.imagesPerSecond > 0 ? ` · ${Math.round(status.imagesPerSecond)}/s` : ''}
      </span>
    )
  }
  return null
}

function ArchiveRow({
  item,
  index,
  query,
  onOpen,
  onFavorite
}: {
  item: ImageItem
  index: number
  query: string
  onOpen: () => void
  onFavorite: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      className="archive-row"
      role="row"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      style={{ '--tint': item.color ?? '#23231d' } as React.CSSProperties}
    >
      <div className="archive-row__image" role="cell">
        <span className="archive-row__number">{String(index + 1).padStart(3, '0')}</span>
        <span className="archive-row__thumb">
          {item.thumbStatus === 'ready' ? (
            <img src={item.thumbUrl} alt="" loading="lazy" draggable={false} />
          ) : (
            <Icon name="image" size={18} />
          )}
        </span>
        <span className="archive-row__identity">
          <span className="archive-row__name" title={item.filename}>
            <Highlight text={item.filename} query={query} />
          </span>
          <span className="archive-row__tags">
            {item.missing ? <span className="row-badge row-badge--warn">Missing</span> : null}
            {item.tags.slice(0, 3).map((tag) => (
              <span className="row-tag" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        </span>
      </div>
      <div className="archive-row__source" role="cell" title={item.folder}>
        <Highlight text={item.folder.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ')} query={query} />
      </div>
      <div className="archive-row__details" role="cell">
        <span>{(item.ext || 'img').toUpperCase()}</span>
        <span>{dimensions(item.width, item.height)}</span>
        <span>{formatBytes(item.bytes)}</span>
      </div>
      <div className="archive-row__date" role="cell">
        {formatDate(item.mtime)}
      </div>
      <div className="archive-row__rating" role="cell">
        {item.rating > 0 ? (
          <span className="row-rating">
            <Icon name="star" size={12} /> {item.rating}
          </span>
        ) : (
          <span className="row-unrated">—</span>
        )}
        {item.reviewedAt === null ? <span className="row-unseen" title="Not yet reviewed" /> : null}
      </div>
      <div className="archive-row__favorite" role="cell">
        <button
          type="button"
          className={`heart-button heart-button--quiet ${item.favorite ? 'is-on' : ''}`}
          onClick={onFavorite}
          aria-label={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={item.favorite}
        >
          <Icon name="heart" size={15} />
        </button>
      </div>
    </div>
  )
}

export function Highlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .slice(0, 6)
  if (tokens.length === 0) return <>{text}</>
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const regex = new RegExp(`(${escaped})`, 'gi')
  const parts = text.split(regex)
  return (
    <>
      {parts.map((part, index) =>
        tokens.some((token) => token.toLowerCase() === part.toLowerCase()) ? (
          <mark key={index}>{part}</mark>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  )
}
