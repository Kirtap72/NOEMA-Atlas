import { useEffect, useMemo, useRef, useState } from 'react'
import type { ImageItem, ImageSort, ImportBatch, RootFolder } from '@shared/types'
import { useAtlas } from '../lib/useAtlas'
import { useDebouncedValue, useImageFeed, useInfiniteScroll } from '../lib/useImageFeed'
import { ImageGrid } from '../components/ImageCard'
import { EmptyState, Spinner } from '../components/ui'
import { Icon, AtlasMark } from '../components/Icon'
import { formatBytes, formatNumber, plural } from '../lib/format'
import { Lightbox } from '../components/Lightbox'

type LibraryMode = 'collection' | 'favorites' | 'recent'
type StatusFilter = 'all' | 'keep' | 'pass' | 'unreviewed'

interface LibraryFilter {
  search: string
  minRating: number
  unreviewed: boolean
  rootId: string
  sort: ImageSort
}

export function LibraryPage({
  mode,
  onNavigateReview,
  onNavigateSources,
  onFileImages
}: {
  mode: LibraryMode
  onNavigateReview: () => void
  onNavigateSources: () => void
  onFileImages: () => void
}): React.JSX.Element {
  const { stats, roots, scan, loading: bootLoading, chooseFolders } = useAtlas()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [minRating, setMinRating] = useState(0)
  const [rootId, setRootId] = useState('')
  const [sort, setSort] = useState<ImageSort>(mode === 'recent' ? 'recent' : 'curated')
  // Recently added: the imports Atlas knows of (a source added, a discovery, a rescan), and which one is shown. -1 is "all recent".
  const [imports, setImports] = useState<ImportBatch[]>([])
  const [batch, setBatch] = useState(-1)
  const [density, setDensity] = useState(() => Number(localStorage.getItem('atlas.density') ?? 1))
  const [selected, setSelected] = useState<number | null>(null)
  const debouncedSearch = useDebouncedValue(search, 190)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    localStorage.setItem('atlas.density', String(density))
  }, [density])

  useEffect(() => {
    if (mode !== 'recent') return
    void window.noema.listImports().then(setImports).catch(() => setImports([]))
  }, [mode, stats.images, stats.missing])
  // The same page serves Collection, Favorites and Recently added: each starts with its own sort and no import chosen.
  const lastMode = useRef(mode)
  useEffect(() => {
    if (lastMode.current === mode) return
    lastMode.current = mode
    setSort(mode === 'recent' ? 'recent' : 'curated')
    setBatch(-1)
  }, [mode])
  const chosenBatch = mode === 'recent' && batch >= 0 ? imports[batch] : undefined

  const query = useMemo(
    () => ({
      scope: (mode === 'recent' ? 'collection' : mode) as 'collection' | 'favorites',
      ...(chosenBatch ? { addedFrom: chosenBatch.from, addedTo: chosenBatch.to } : {}),
      search: debouncedSearch,
      rootId: rootId || null,
      minRating,
      decision: statusFilter === 'keep' || statusFilter === 'pass' ? statusFilter : undefined,
      unreviewed: statusFilter === 'unreviewed',
      sort,
      limit: 90
    }),
    [mode, debouncedSearch, rootId, minRating, statusFilter, sort, chosenBatch]
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

  const filterActive = Boolean(
    debouncedSearch || minRating || statusFilter !== 'all' || rootId || sort !== (mode === 'recent' ? 'recent' : 'curated')
  )
  const resetFilters = (): void => {
    setSearch('')
    setMinRating(0)
    setStatusFilter('all')
    setRootId('')
    setSort(mode === 'recent' ? 'recent' : 'curated')
  }

  const title = mode === 'favorites' ? 'Favorites' : mode === 'recent' ? 'Recently added' : 'The Collection'
  const eyebrow = mode === 'favorites' ? 'THE KEEPERS' : mode === 'recent' ? 'NEW IN THE LIBRARY' : 'YOUR LIVING LIBRARY'
  const subtitle =
    mode === 'favorites'
      ? 'The images you would rescue first. A private edit of everything you have looked at closely.'
      : mode === 'recent'
        ? 'In the order Atlas indexed them, newest first, whatever the dates of the files are.'
        : 'A place to look slowly, notice what repeats, and keep only what stays with you.'
  const count = mode === 'favorites' ? stats.favorites : mode === 'recent' ? feed.total : stats.images

  if (!bootLoading && stats.roots === 0 && mode === 'collection') {
    return <Onboarding onAdd={() => void chooseFolders()} onSources={onNavigateSources} />
  }

  if (mode === 'favorites' && !bootLoading && stats.favorites === 0) {
    return (
      <div className="page page--favorites">
        <PageHeader
          eyebrow={eyebrow}
          title={title}
          count={0}
          subtitle={subtitle}
          action={
            <button type="button" className="button button--gold" onClick={onNavigateReview}>
              <Icon name="review" size={17} /> Enter the Review Room
            </button>
          }        />
        <div className="favorites-vignette">
          <div className="favorites-vignette__orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <EmptyState
            icon="heart"
            title="Nothing kept — yet."
            copy="Favourites are your personal edit. Enter the Review Room and press F on the images that refuse to leave you."
            className="empty-state--wide"
          >
            <button type="button" className="button button--gold" onClick={onNavigateReview}>
              Begin reviewing <Icon name="arrowRight" size={16} />
            </button>
            <button type="button" className="button button--ghost" onClick={() => void chooseFolders()}>
              Add more images
            </button>
          </EmptyState>
        </div>
      </div>
    )
  }

  return (
    <div className={`page page--${mode}`}>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        count={count}
        subtitle={subtitle}
        action={
          <>
            {mode === 'collection' && stats.unreviewed > 0 ? (
              <button type="button" className="button button--ghost" onClick={onNavigateReview}>
                <Icon name="review" size={17} />
                Review {formatNumber(stats.unreviewed)}
              </button>
            ) : null}
            <button type="button" className="button button--ghost" onClick={onFileImages}>
              <Icon name="organize" size={16} />
              File images
            </button>
            <button type="button" className="button button--gold" onClick={() => void chooseFolders()}>
              <Icon name="plus" size={16} />
              Add folder
            </button>
          </>
        }
      />

      <div className="page-summary">
        <span>{plural(stats.images, 'image')} indexed</span>
        <span className="dot-separator">·</span>
        <span>{formatBytes(stats.totalBytes)} of originals</span>
        <span className="dot-separator">·</span>
        <span>{plural(stats.roots, 'source folder')}</span>
        {stats.favorites > 0 ? (
          <>
            <span className="dot-separator">·</span>
            <span className="page-summary__kept">
              {Math.round((stats.favorites / Math.max(1, stats.images)) * 100)}% kept
            </span>
          </>
        ) : null}
      </div>

      {mode === 'recent' ? (
        <div className="recent-batches" role="tablist" aria-label="Imports" data-testid="recent-batches">
          <button type="button" role="tab" aria-selected={batch === -1} className={`chip${batch === -1 ? ' is-active' : ''}`} onClick={() => setBatch(-1)} data-testid="recent-all">Everything recent</button>
          {imports.map((b, i) => (
            <button key={b.to} type="button" role="tab" aria-selected={batch === i} className={`chip${batch === i ? ' is-active' : ''}`} onClick={() => setBatch(i)} data-testid={i === 0 ? 'recent-latest' : 'recent-batch'} title={b.roots.join(', ')}>
              {i === 0 ? 'Latest import' : new Date(b.to).toLocaleDateString([], { day: 'numeric', month: 'short' })} · {formatNumber(b.count)} · {new Date(b.to).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}{b.roots.length ? ` · ${b.roots[0]}` : ''}
            </button>
          ))}
        </div>
      ) : null}

      <LibraryToolbar
        search={search}
        onSearch={setSearch}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        minRating={minRating}
        onMinRating={setMinRating}
        rootId={rootId}
        onRootId={setRootId}
        roots={roots}
        sort={sort}
        onSort={setSort}
        density={density}
        onDensity={setDensity}
        filterActive={filterActive}
        onReset={resetFilters}
        total={feed.total}
        mode={mode}
      />

      {feed.error ? (
        <div className="inline-error">
          <Icon name="info" size={16} /> {feed.error}
        </div>
      ) : null}

      {activeScan && stats.images === 0 && mode === 'collection' ? (
        <ScanningWelcome />
      ) : (
        <ImageGrid
          items={feed.items}
          loading={feed.loading}
          loadingMore={feed.loadingMore}
          hasMore={feed.hasMore}
          density={density}
          onOpen={setSelected}
          onUpdate={feed.replaceItem}
          onLoadMore={() => void feed.loadMore()}
          sentinelRef={sentinelRef}
          empty={
            <EmptyState
              icon={filterActive ? 'search' : mode === 'favorites' ? 'heart' : 'sparkle'}
              title={filterActive ? 'Nothing in this corner.' : 'A quiet room.'}
              copy={
                filterActive
                  ? 'No images match these filters. Try a lighter search, or clear the filters to see the whole room.'
                  : activeScan
                    ? 'Atlas is still making previews. Images will appear here as soon as the first pass is complete.'
                    : 'Add a folder with photographs, studies or AI work, and Atlas will begin building the room.'
              }
            >
              {filterActive ? (
                <button type="button" className="button button--ghost" onClick={resetFilters}>
                  Clear filters
                </button>
              ) : activeScan ? (
                <span className="inline-loading">
                  <Spinner size={17} /> {scan?.currentFile ?? 'Reading folders…'}
                </span>
              ) : (
                <button type="button" className="button button--gold" onClick={() => void chooseFolders()}>
                  <Icon name="plus" size={16} /> Choose a folder
                </button>
              )}
            </EmptyState>
          }
        />
      )}

      {selected !== null && feed.items[selected] ? (
        <Lightbox
          items={feed.items}
          initialIndex={selected}
          onClose={() => setSelected(null)}
          onUpdate={feed.replaceItem}
        />
      ) : null}
    </div>
  )
}

function PageHeader({
  eyebrow,
  title,
  count,
  subtitle,
  action
}: {
  eyebrow: string
  title: string
  count: number
  subtitle: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="page-head">
      <div className="page-head__copy">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="page-title">
          {title}
          <span className="page-title__count">{formatNumber(count)}</span>
        </h1>
        <p className="page-subtitle">{subtitle}</p>
      </div>
      {action ? <div className="page-head__actions">{action}</div> : null}
    </header>
  )
}

function LibraryToolbar({
  search,
  onSearch,
  statusFilter,
  onStatusFilter,
  minRating,
  onMinRating,
  rootId,
  onRootId,
  roots,
  sort,
  onSort,
  density,
  onDensity,
  filterActive,
  onReset,
  total,
  mode
}: {
  search: string
  onSearch: (value: string) => void
  statusFilter: StatusFilter
  onStatusFilter: (value: StatusFilter) => void
  minRating: number
  onMinRating: (value: number) => void
  rootId: string
  onRootId: (value: string) => void
  roots: RootFolder[]
  sort: ImageSort
  onSort: (value: ImageSort) => void
  density: number
  onDensity: (value: number) => void
  filterActive: boolean
  onReset: () => void
  total: number
  mode: LibraryMode
}): React.JSX.Element {
  return (
    <div className="library-toolbar">
      <div className="library-toolbar__top">
        <label className="search-field">
          <Icon name="search" size={18} />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={mode === 'favorites' ? 'Search your keepers…' : 'Search this room…'}
            aria-label="Search images"
            spellCheck={false}
          />
          {search ? (
            <button type="button" onClick={() => onSearch('')} aria-label="Clear search" className="search-field__clear">
              <Icon name="close" size={14} />
            </button>
          ) : (
            <kbd className="search-field__hint">Ctrl K</kbd>
          )}
        </label>
        <div className="library-toolbar__count">
          {formatNumber(total)} {total === 1 ? 'image' : 'images'}
          {filterActive ? (
            <button type="button" className="link-button" onClick={onReset}>
              Reset
            </button>
          ) : null}
        </div>
      </div>

      <div className="library-toolbar__bottom">
        <div className="chip-row" role="group" aria-label="Image filters">
          <button
            type="button"
            className={`chip ${statusFilter === 'all' && minRating === 0 ? 'is-active' : ''}`}
            onClick={() => {
              onStatusFilter('all')
              onMinRating(0)
            }}
          >
            Everything
          </button>
          <button
            type="button"
            className={`chip ${statusFilter === 'keep' ? 'is-active' : ''}`}
            onClick={() => onStatusFilter(statusFilter === 'keep' ? 'all' : 'keep')}
          >
            <Icon name="heart" size={12} /> Keep
          </button>
          <button
            type="button"
            className={`chip ${statusFilter === 'pass' ? 'is-active' : ''}`}
            onClick={() => onStatusFilter(statusFilter === 'pass' ? 'all' : 'pass')}
          >
            <Icon name="close" size={12} /> Pass
          </button>
          <button
            type="button"
            className={`chip ${statusFilter === 'unreviewed' ? 'is-active' : ''}`}
            onClick={() => onStatusFilter(statusFilter === 'unreviewed' ? 'all' : 'unreviewed')}
          >
            Unreviewed
          </button>
        </div>

        <div className="library-toolbar__controls">
          <label className="select-field" title="Minimum star rating">
            <Icon name="star" size={14} />
            <select
              value={minRating}
              onChange={(event) => onMinRating(Number(event.target.value))}
              aria-label="Minimum star rating"
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

          <label className="select-field" title="Filter by source">
            <Icon name="folder" size={14} />
            <select value={rootId} onChange={(event) => onRootId(event.target.value)} aria-label="Filter by source folder">
              <option value="">All sources</option>
              {roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.name}
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={12} className="select-field__chevron" />
          </label>

          <label className="select-field" title="Sort images">
            <Icon name="sort" size={14} />
            <select value={sort} onChange={(event) => onSort(event.target.value as ImageSort)} aria-label="Sort images">
              <option value="curated">Curated</option>
              <option value="recent">Recently added</option>
              <option value="captured">Recently seen</option>
              <option value="rating">Highest rated</option>
              <option value="name">A–Z</option>
              <option value="folder">Folder A–Z</option>
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
                onClick={() => onDensity(level)}
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
      </div>
    </div>
  )
}

function ScanningWelcome(): React.JSX.Element {
  const { scan, stats } = useAtlas()
  return (
    <div className="scanning-welcome">
      <div className="scanning-welcome__radar" aria-hidden="true">
        <span className="scanning-welcome__ring scanning-welcome__ring--1" />
        <span className="scanning-welcome__ring scanning-welcome__ring--2" />
        <span className="scanning-welcome__ring scanning-welcome__ring--3" />
        <span className="scanning-welcome__core" />
      </div>
      <div className="eyebrow">THE FIRST PASS</div>
      <h2 className="scanning-welcome__title">Atlas is learning your library.</h2>
      <p className="scanning-welcome__copy">
        Reading filenames, measuring light, and making small previews. Your originals are only being read.
      </p>
      <div className="scanning-welcome__progress">
        <div className="scanning-welcome__bar">
          <span
            style={{
              width: `${scan && scan.discovered > 0 ? Math.max(3, Math.round((scan.processed / scan.discovered) * 100)) : 3}%`
            }}
          />
        </div>
        <div className="scanning-welcome__numbers">
          <span>{scan ? `${formatNumber(scan.processed)} of ${formatNumber(scan.discovered)}` : 'Starting'}</span>
          <span>{plural(stats.images, 'preview')} ready</span>
        </div>
      </div>
      {scan?.currentFile ? <div className="scanning-welcome__file">{scan.currentFile}</div> : null}
      <div className="scanning-welcome__note">
        <Icon name="shield" size={14} /> You can leave this room. The scan continues in the background.
      </div>
    </div>
  )
}

function Onboarding({ onAdd, onSources }: { onAdd: () => void; onSources: () => void }): React.JSX.Element {
  return (
    <div className="onboarding">
      <div className="onboarding__copy">
        <div className="onboarding__mark">
          <span className="eyebrow">NOEMA ATLAS · A PRIVATE VISUAL LIBRARY</span>
        </div>
        <h1 className="onboarding__title">
          A quiet home
          <br />
          for the images
          <br />
          that <em>stay with you.</em>
        </h1>
        <p className="onboarding__lede">
          Point Atlas at a folder of photographs, AI studies or visual references. It makes a fast,
          searchable library from light previews, and never changes an original while it indexes.
        </p>
        <div className="onboarding__actions">
          <button type="button" className="button button--gold button--large" onClick={onAdd}>
            <Icon name="plus" size={18} />
            Choose your first folder
          </button>
          <button type="button" className="button button--ghost button--large" onClick={onSources}>
            How sources work
          </button>
        </div>
        <div className="trust-row">
          <span>
            <Icon name="shield" size={15} /> Read-only
          </span>
          <span>
            <Icon name="lock" size={15} /> Local to this PC
          </span>
          <span>
            <Icon name="image" size={15} /> Previews, not copies
          </span>
        </div>
        <div className="onboarding__note">
          Start small. One folder, a few dozen images. You can add more sources whenever the collection grows.
        </div>
      </div>

      <div className="onboarding__art" aria-hidden="true">
        <div className="onboarding__frame">
          <svg viewBox="0 0 560 700" className="onboarding__svg" role="presentation">
            <defs>
              <linearGradient id="atlas-sky" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2b271d" />
                <stop offset="48%" stopColor="#4b3821" />
                <stop offset="75%" stopColor="#9b6b38" />
                <stop offset="100%" stopColor="#201b13" />
              </linearGradient>
              <radialGradient id="atlas-sun" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#ffe9b7" />
                <stop offset="42%" stopColor="#f2c878" />
                <stop offset="100%" stopColor="#d4963d" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="atlas-floor" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#12120f" stopOpacity="0" />
                <stop offset="100%" stopColor="#0c0c0a" />
              </linearGradient>
              <filter id="atlas-grain">
                <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" stitchTiles="stitch" />
                <feColorMatrix type="saturate" values="0" />
                <feComponentTransfer>
                  <feFuncA type="linear" slope="0.16" />
                </feComponentTransfer>
              </filter>
              <clipPath id="atlas-arch">
                <path d="M128 700V286C128 177 194 112 280 112s152 65 152 174v414Z" />
              </clipPath>
            </defs>
            <rect width="560" height="700" fill="#11110d" />
            <g clipPath="url(#atlas-arch)">
              <rect x="100" y="80" width="360" height="640" fill="url(#atlas-sky)" />
              <circle cx="280" cy="310" r="150" fill="url(#atlas-sun)" />
              <circle cx="280" cy="322" r="47" fill="#f8dda2" opacity="0.9" />
              <path d="M128 520H432V700H128Z" fill="#15120d" opacity="0.72" />
              <path d="M128 520H432M128 572H432M128 630H432" stroke="#e9c87e" strokeOpacity="0.12" />
              <path d="M280 520V700M210 520V700M350 520V700" stroke="#e9c87e" strokeOpacity="0.08" />
              <rect x="100" y="80" width="360" height="640" filter="url(#atlas-grain)" opacity="0.45" />
              <rect x="100" y="80" width="360" height="640" fill="url(#atlas-floor)" />
            </g>
            <path
              d="M128 700V286C128 177 194 112 280 112s152 65 152 174v414"
              fill="none"
              stroke="#e9c87e"
              strokeOpacity="0.38"
              strokeWidth="1.3"
            />
            <path
              d="M96 700V270C96 146 174 72 280 72s184 74 184 198v430"
              fill="none"
              stroke="#f5ecda"
              strokeOpacity="0.11"
            />
            <path d="M64 700V258C64 116 156 38 280 38s216 78 216 220v442" fill="none" stroke="#f5ecda" strokeOpacity="0.06" />
            <path d="M44 36h68M44 36v68M516 36h-68M516 36v68" stroke="#e9c87e" strokeOpacity="0.32" />
            <circle cx="280" cy="36" r="2.5" fill="#e9c87e" />
          </svg>
          <div className="onboarding__frame-label">
            <span>PLATE I</span>
            <span>A ROOM FOR LOOKING</span>
          </div>
        </div>
        <div className="onboarding__stamp">
          <AtlasMark size={28} />
          <span>
            <strong>NOEMA</strong>
            <em>ATLAS</em>
          </span>
        </div>
        <div className="onboarding__orbit" aria-hidden="true">
          <span />
          <span />
        </div>
      </div>
    </div>
  )
}
