import { useEffect, useState } from 'react'
import type { Moodboard, RootFolder, ScanState } from '@shared/types'
import { Icon, AtlasMark, type IconName } from './Icon'
import { formatBytes, formatNumber, basenameOfPath } from '../lib/format'
import { NAV_ITEMS, routeLabel, type Route, type RouteName } from '../lib/routing'
import { openModelLibrary } from './ModelLibrary'

const NAV_ICONS: Record<RouteName, IconName> = {
  collection: 'collection',
  recent: 'clock',
  favorites: 'heart',
  review: 'review',
  archive: 'archive',
  families: 'grid',
  smart: 'sparkle',
  taste: 'eye',
  'taste-classic': 'eye',
  moodboards: 'boards',
  moodboard: 'boards',
  sources: 'sources',
  organizer: 'grid'
}

function scanIsActive(scan: ScanState | null): boolean {
  return Boolean(scan && ['queued', 'walking', 'processing', 'finalizing'].includes(scan.phase))
}

function scanPercent(scan: ScanState): number {
  if (scan.discovered === 0) return 0
  return Math.min(100, Math.round((scan.processed / scan.discovered) * 100))
}

function scanCaption(scan: ScanState): string {
  switch (scan.phase) {
    case 'queued':
      return 'Waiting to look'
    case 'walking':
      return 'Reading the folder'
    case 'processing':
      return 'Making previews'
    case 'finalizing':
      return 'Settling the index'
    case 'done':
      return 'Scan complete'
    case 'cancelled':
      return 'Scan stopped'
    default:
      return 'Needs attention'
  }
}

export function Sidebar({
  route,
  images,
  favorites,
  unreviewed,
  moodboards,
  roots,
  totalBytes,
  scan,
  onNavigate,
  onAddFolder,
  onCancelScan
}: {
  route: Route
  images: number
  favorites: number
  unreviewed: number
  moodboards: Moodboard[]
  roots: RootFolder[]
  totalBytes: number
  scan: ScanState | null
  onNavigate: (route: Route) => void
  onAddFolder: () => void
  onCancelScan: () => void
}): React.JSX.Element {
  const counts: Partial<Record<RouteName, number>> = {
    collection: images,
    favorites,
    review: unreviewed,
    archive: images,
    moodboards: moodboards.length,
    sources: roots.length
  }
  const active = scanIsActive(scan)

  return (
    <aside className="sidebar">
      <div className="sidebar__brand drag-region">
        <span className="sidebar__mark">
          <AtlasMark size={38} />
        </span>
        <span className="sidebar__wordmark">
          <strong>NOEMA</strong>
          <span>ATLAS</span>
        </span>
      </div>

      <nav className="sidebar__nav" aria-label="Atlas">
        <div className="sidebar__group-label">LIBRARY</div>
        {NAV_ITEMS.slice(0, 8).map((item) => (
          <NavButton
            key={item.route}
            icon={NAV_ICONS[item.route]}
            label={item.label}
            count={counts[item.route]}
            active={route.name === item.route || (item.route === 'taste' && route.name === 'taste-classic')}
            highlight={item.route === 'review' && unreviewed > 0}
            onClick={() => onNavigate({ name: item.route })}
          />
        ))}
        <div className="sidebar__group-label sidebar__group-label--spaced">CURATE</div>
        {NAV_ITEMS.slice(8).map((item) => (
          <NavButton
            key={item.route}
            icon={NAV_ICONS[item.route]}
            label={item.label}
            count={counts[item.route]}
            active={route.name === item.route || (item.route === 'moodboards' && route.name === 'moodboard')}
            onClick={() => onNavigate({ name: item.route })}
          />
        ))}

        <div className="sidebar__group-label sidebar__group-label--spaced">AI</div>
        <NavButton icon="sparkle" label="AI Models" active={false} onClick={() => openModelLibrary()} />

        {moodboards.length > 0 ? (
          <div className="sidebar__boards">
            {moodboards.slice(0, 3).map((board) => (
              <button
                type="button"
                key={board.id}
                className={`sidebar__board ${route.name === 'moodboard' && route.boardId === board.id ? 'is-active' : ''}`}
                onClick={() => onNavigate({ name: 'moodboard', boardId: board.id })}
                title={board.name}
              >
                <span className="sidebar__board-thumb">
                  {board.coverIds[0] ? (
                    <img src={`noema://thumb/${board.coverIds[0]}.webp`} alt="" draggable={false} />
                  ) : (
                    <Icon name="boards" size={13} />
                  )}
                </span>
                <span className="sidebar__board-name">{board.name}</span>
                <span className="sidebar__board-count">{board.imageCount}</span>
              </button>
            ))}
          </div>
        ) : null}
      </nav>

      <div className="sidebar__foot">
        {active && scan ? (
          <div className="scan-card">
            <div className="scan-card__top">
              <span className="scan-card__pulse" />
              <span className="scan-card__label">{scanCaption(scan)}</span>
              <span className="scan-card__percent">
                {scan.phase === 'walking' ? '·' : `${scanPercent(scan)}%`}
              </span>
            </div>
            <div className="scan-card__source">{scan.rootName}</div>
            <div className="scan-card__bar">
              {scan.phase === 'walking' ? (
                <span className="scan-card__bar-indeterminate" />
              ) : (
                <span style={{ width: `${Math.max(4, scanPercent(scan))}%` }} />
              )}
            </div>
            <div className="scan-card__meta">
              <span>
                {formatNumber(scan.processed)} / {formatNumber(scan.discovered)} looked at
              </span>
              <button type="button" onClick={onCancelScan} className="scan-card__stop">
                Stop
              </button>
            </div>
            {scan.currentFile ? (
              <div className="scan-card__file" title={scan.currentFile}>
                {scan.currentFile}
              </div>
            ) : null}
          </div>
        ) : null}

        <button type="button" className="sidebar__add" onClick={onAddFolder}>
          <Icon name="plus" size={17} />
          <span>Add a source folder</span>
        </button>

        <div className="sidebar__ledger">
          <div className="sidebar__ledger-row">
            <span>{formatNumber(images)} images</span>
            <span>{formatBytes(totalBytes)}</span>
          </div>
          <div className="sidebar__ledger-note">
            <Icon name="shield" size={12} />
            Scanning never alters originals
          </div>
        </div>
      </div>
    </aside>
  )
}

function NavButton({
  icon,
  label,
  count,
  active,
  highlight,
  onClick
}: {
  icon: IconName
  label: string
  count?: number
  active: boolean
  highlight?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`nav-button ${active ? 'is-active' : ''} ${highlight ? 'has-signal' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
    >
      <span className="nav-button__icon">
        <Icon name={icon} size={18} strokeWidth={1.45} />
      </span>
      <span className="nav-button__label">{label}</span>
      {typeof count === 'number' && count > 0 ? <span className="nav-button__count">{formatNumber(count)}</span> : null}
    </button>
  )
}

export function Topbar({
  route,
  scan,
  onHelp,
  onOpenSources
}: {
  route: Route
  scan: ScanState | null
  onHelp: () => void
  onOpenSources: () => void
}): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const active = scanIsActive(scan)

  useEffect(() => {
    void window.noema.windowIsMaximized().then(setMaximized)
    return window.noema.onMaximizeChanged(setMaximized)
  }, [])

  return (
    <header className="topbar">
      <div className="topbar__drag drag-region">
        <div className="topbar__crumb">
          <span className="topbar__brandline">NOEMA ATLAS</span>
          <span className="topbar__slash">/</span>
          <span className="topbar__room">{routeLabel(route)}</span>
        </div>
      </div>

      <div className="topbar__right no-drag">
        <div className="topbar__local">
          <span className="local-dot" />
          LOCAL · PRIVATE
        </div>
        {active && scan ? (
          <button type="button" className="scan-pill" onClick={onOpenSources} title={scan.currentFile ?? undefined}>
            <span className="scan-pill__spinner" />
            <span>{scanCaption(scan)}</span>
            <span className="scan-pill__number">{formatNumber(scan.processed)}</span>
          </button>
        ) : null}
        <button type="button" className="icon-button topbar__help" onClick={onHelp} aria-label="Help and shortcuts">
          <Icon name="help" size={18} />
        </button>
        <div className="window-controls">
          <button
            type="button"
            className="window-control"
            aria-label="Minimize"
            onClick={() => window.noema.windowMinimize()}
          >
            <Icon name="minimize" size={15} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={() => window.noema.windowToggleMaximize()}
          >
            <Icon name={maximized ? 'restore' : 'maximize'} size={13} strokeWidth={1.5} />
          </button>
          <button
            type="button"
            className="window-control window-control--close"
            aria-label="Close"
            onClick={() => window.noema.windowClose()}
          >
            <Icon name="close" size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </header>
  )
}

export function SourceTag({ root }: { root: RootFolder }): React.JSX.Element {
  return (
    <span className="source-tag" title={root.path}>
      <Icon name="folder" size={13} />
      {root.name || basenameOfPath(root.path)}
    </span>
  )
}
