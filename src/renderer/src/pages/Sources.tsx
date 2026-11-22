import { useState } from 'react'
import type { RootFolder } from '@shared/types'
import { useAtlas } from '../lib/useAtlas'
import { Icon } from '../components/Icon'
import { AiPanel } from '../components/AiSetup'
import { DiscoverPanel } from '../components/DiscoverPanel'
import { ConfirmModal, EmptyState } from '../components/ui'
import { formatBytes, formatNumber, relativeTime, plural } from '../lib/format'

export function SourcesPage(): React.JSX.Element {
  const { roots, stats, scan, chooseFolders, addFolders, rescanRoot, cancelScan, removeRoot, bootstrap } = useAtlas()
  const [typedPath, setTypedPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<RootFolder | null>(null)
  const active = Boolean(scan && ['queued', 'walking', 'processing', 'finalizing'].includes(scan.phase))

  return (
    <div className="page page--sources">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">THE SOURCES · ONLY WHAT YOU CHOOSE</div>
          <h1 className="page-title">
            Source folders
            <span className="page-title__count">{formatNumber(roots.length)}</span>
          </h1>
          <p className="page-subtitle">
            Atlas reads only the folders you add. It never scans a drive on its own, and it never changes,
            moves or deletes an original.
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="button button--gold" onClick={() => void chooseFolders()}>
            <Icon name="plus" size={16} /> Add source folder
          </button>
        </div>
      </header>

      <form
        className="add-by-path"
        onSubmit={(event) => {
          event.preventDefault()
          const value = typedPath.trim().replace(/^"(.*)"$/, '$1')
          if (!value) return
          setAdding(true)
          void addFolders([value]).then((result) => {
            if (result && result.rejected.length === 0) setTypedPath('')
            setAdding(false)
          })
        }}
      >
        <label>
          <span>Or type or paste a folder path</span>
          <input
            value={typedPath}
            onChange={(event) => setTypedPath(event.target.value)}
            placeholder="D:\Pictures\New artworks"
            aria-label="Folder path"
            spellCheck={false}
          />
        </label>
        <button type="submit" className="button button--ghost" disabled={adding || typedPath.trim() === ''}>
          <Icon name="plus" size={16} /> Add this folder
        </button>
      </form>

      <div className="source-principles">
        <div className="source-principle">
          <span className="source-principle__icon"><Icon name="shield" size={18} /></span>
          <div>
            <strong>Read-only by design</strong>
            <p>Scanning and curation never write to an original. Only the File Room can copy, or move after explicit confirmation.</p>
          </div>
        </div>
        <div className="source-principle">
          <span className="source-principle__icon"><Icon name="drive" size={18} /></span>
          <div>
            <strong>Never on its own</strong>
            <p>Atlas searches a drive only when you ask, looks at names and sizes, and indexes only the collections you choose. Drive roots themselves are never added.</p>
          </div>
        </div>
        <div className="source-principle">
          <span className="source-principle__icon"><Icon name="image" size={18} /></span>
          <div>
            <strong>Previews, not duplicates</strong>
            <p>Small WebP previews and a local SQLite catalogue live on this PC. Full-size originals stay put.</p>
          </div>
        </div>
      </div>

      <DiscoverPanel />

      <AiPanel />

      {active && scan ? (
        <div className="current-scan">
          <div className="current-scan__radar" aria-hidden="true">
            <span />
          </div>
          <div className="current-scan__copy">
            <div className="eyebrow">SCAN IN PROGRESS · {scan.rootName}</div>
            <h2>{scan.phase === 'walking' ? 'Reading the folder' : scan.phase === 'finalizing' ? 'Settling the index' : 'Making previews'}</h2>
            <div className="current-scan__bar">
              <span
                style={{
                  width: `${scan.discovered > 0 ? Math.max(2, Math.round((scan.processed / scan.discovered) * 100)) : 2}%`
                }}
              />
            </div>
            <div className="current-scan__meta">
              <span>{formatNumber(scan.processed)} of {formatNumber(scan.discovered)} examined</span>
              <span>{plural(scan.added, 'new image')} · {formatNumber(scan.skipped)} unchanged</span>
              {scan.errors > 0 ? <span className="current-scan__errors">{scan.errors} unreadable</span> : null}
            </div>
            {scan.currentFile ? <div className="current-scan__file">{scan.currentFile}</div> : null}
          </div>
          <button type="button" className="button button--ghost" onClick={() => void cancelScan()}>
            Stop scan
          </button>
        </div>
      ) : null}

      {roots.length === 0 ? (
        <div className="sources-empty">
          <div className="sources-empty__art" aria-hidden="true">
            <span className="sources-empty__folder sources-empty__folder--back" />
            <span className="sources-empty__folder sources-empty__folder--front">
              <Icon name="image" size={24} strokeWidth={1.1} />
            </span>
          </div>
          <EmptyState
            icon="sources"
            title="Begin with one folder."
            copy="A project folder, a references collection, an export from your image tools. Atlas will index it quietly and leave every original untouched."
          >
            <button type="button" className="button button--gold" onClick={() => void chooseFolders()}>
              <Icon name="plus" size={16} /> Choose a folder
            </button>
          </EmptyState>
        </div>
      ) : (
        <div className="source-list">
          <div className="source-list__head">
            <span>{plural(roots.length, 'source')}</span>
            <span>{formatNumber(stats.images)} images indexed · {formatBytes(stats.totalBytes)}</span>
          </div>
          {roots.map((root, index) => {
            const isScanning = active && scan?.rootId === root.id
            const isQueued = active && !isScanning && Boolean(root.scanning)
            return (
              <div className="source-row" key={root.id}>
                <div className="source-row__index">{String(index + 1).padStart(2, '0')}</div>
                <div className="source-row__icon">
                  <Icon name={isScanning || isQueued ? 'refresh' : 'folder'} size={19} className={isScanning ? 'is-spinning' : ''} />
                </div>
                <div className="source-row__main">
                  <div className="source-row__name-line">
                    <h2>{root.name}</h2>
                    {isScanning ? <span className="source-badge source-badge--scan">scanning</span> : null}
                    {isQueued ? <span className="source-badge">queued</span> : null}
                    {root.missingCount > 0 ? (
                      <span className="source-badge source-badge--missing">{formatNumber(root.missingCount)} missing</span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="source-row__path"
                    title="Copy this path"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(root.path)
                      } catch {
                        // Clipboard access can fail without changing the value shown.
                      }
                    }}
                  >
                    {root.path}
                  </button>
                </div>
                <div className="source-row__stats">
                  <div>
                    <strong>{formatNumber(root.imageCount)}</strong>
                    <span>images</span>
                  </div>
                  <div>
                    <strong>{root.lastScanAt ? relativeTime(root.lastScanAt) : 'never'}</strong>
                    <span>last scan</span>
                  </div>
                </div>
                <div className="source-row__actions">
                  <button
                    type="button"
                    className="button button--quiet"
                    disabled={isScanning || isQueued}
                    onClick={() => void rescanRoot(root.id)}
                  >
                    <Icon name="refresh" size={14} /> Rescan
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--danger"
                    disabled={isScanning || isQueued}
                    onClick={() => setRemoveTarget(root)}
                    aria-label={`Remove source ${root.name}`}
                    title="Remove this source from Atlas"
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className="data-card">
        <div className="data-card__copy">
          <div className="eyebrow">WHERE YOUR CATALOGUE LIVES</div>
          <h2>Small, local, yours.</h2>
          <p>
            Previews and metadata are kept in your Windows user data folder. A full-size original is read
            from its own location whenever you open it. Backup this folder to keep your ratings and boards.
          </p>
          <code title={bootstrap?.app.libraryDb}>{bootstrap?.app.dataDir ?? ''}</code>
        </div>
        <div className="data-card__aside">
          <button type="button" className="button button--ghost" onClick={() => void window.noema.openDataFolder()}>
            <Icon name="folder" size={15} /> Open data folder
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={async () => {
              const path = bootstrap?.app.libraryDb
              if (!path) return
              try {
                await navigator.clipboard.writeText(path)
              } catch {
                // No visible change when clipboard permission is unavailable.
              }
            }}
          >
            Copy database path
          </button>
        </div>
      </div>

      <ConfirmModal
        open={Boolean(removeTarget)}
        title={`Remove “${removeTarget?.name ?? ''}” from Atlas?`}
        description={
          <div>
            <p>
              Atlas will forget this folder's catalogue: its previews, ratings, tags and moodboard placements
              for those images.
            </p>
            <p className="modal__emphasis">
              The original folder and every file inside it will remain exactly as they are. Nothing is deleted
              from disk.
            </p>
          </div>
        }
        confirmLabel="Remove from Atlas"
        tone="danger"
        onClose={() => setRemoveTarget(null)}
        onConfirm={async () => {
          if (removeTarget) await removeRoot(removeTarget.id)
          setRemoveTarget(null)
        }}
      />
    </div>
  )
}
