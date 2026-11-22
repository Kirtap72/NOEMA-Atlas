import { useEffect, useRef, useState } from 'react'
import type { DiscoveredCollection, DiscoveryProgress, DriveInfo } from '@shared/discovery'
import { Icon } from './Icon'
import { Spinner } from './ui'
import { useAtlas } from '../lib/useAtlas'
import { formatBytes, formatNumber, friendlyError, plural } from '../lib/format'

/**
 * Finds folders of pictures across whole drives, then lets the user look before anything is indexed. Searching is
 * read-only; only collections the user ticks are added to Atlas.
 */
export function DiscoverPanel(): React.JSX.Element {
  const { addFolders, toast } = useAtlas()
  const [open, setOpen] = useState(false)
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [excludedNames, setExcludedNames] = useState<string[]>([])
  const [chosenDrives, setChosenDrives] = useState<string[]>([])
  const [excludePaths, setExcludePaths] = useState<string[]>([])
  const [searchAnyway, setSearchAnyway] = useState<string[]>([])
  const [minImages, setMinImages] = useState(8)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null)
  const [found, setFound] = useState<{ collections: DiscoveredCollection[]; scannedFolders: number; skippedFolders: number; cancelled: boolean } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [previews, setPreviews] = useState<Record<string, string[]>>({})
  const [adding, setAdding] = useState(false)
  const requested = useRef(new Set<string>())

  useEffect(() => {
    if (!open || drives.length > 0) return
    void window.noema.discoverDrives().then((info) => {
      setDrives(info.drives)
      setExcludedNames(info.excluded)
      setChosenDrives(info.drives.filter((d) => !d.isSystem).map((d) => d.path))
    })
  }, [open, drives.length])
  useEffect(() => window.noema.onDiscoverProgress(setProgress), [])

  // Previews are made on demand, in memory, from read-only files.
  useEffect(() => {
    for (const collection of found?.collections.slice(0, 40) ?? []) {
      if (requested.current.has(collection.path)) continue
      requested.current.add(collection.path)
      void window.noema.discoverPreview(collection.samples).then((urls) => setPreviews((p) => ({ ...p, [collection.path]: urls })))
    }
  }, [found])

  const start = async (): Promise<void> => {
    if (chosenDrives.length === 0) {
      toast('Choose at least one drive to search.', 'info')
      return
    }
    setRunning(true)
    setFound(null)
    setPicked(new Set())
    setPreviews({})
    requested.current = new Set()
    try {
      const result = await window.noema.discoverStart({ roots: chosenDrives, excludePaths, includeNames: searchAnyway, minImages })
      setFound(result)
      // Nothing is ticked for the user: adding is always their choice.
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setRunning(false)
    }
  }

  const toggle = (path: string): void =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const add = async (): Promise<void> => {
    setAdding(true)
    try {
      const result = await addFolders([...picked])
      if (result) {
        const taken = new Set([...result.added, ...result.existing, ...(result.covered ?? []).map((c) => c.path)].map((p) => p.toLowerCase()))
        setFound((f) => (f ? { ...f, collections: f.collections.map((c) => (picked.has(c.path) && taken.has(c.path.toLowerCase()) ? { ...c, inAtlas: true } : c)) } : f))
        setPicked(new Set(result.rejected.map((r) => r.path).filter((p) => picked.has(p))))
      }
    } finally {
      setAdding(false)
    }
  }

  const addExclusion = async (): Promise<void> => {
    const path = await window.noema.discoverChooseFolder()
    if (path && !excludePaths.includes(path)) setExcludePaths([...excludePaths, path])
  }

  const total = [...picked].reduce((sum, path) => sum + (found?.collections.find((c) => c.path === path)?.images ?? 0), 0)

  if (!open) {
    return (
      <section className="discover discover--closed">
        <div>
          <strong>Find pictures on this computer</strong>
          <p>Search whole drives for folders of images, skipping system folders, caches, programs and icons. You see what was found before anything is added.</p>
        </div>
        <button type="button" className="button button--ghost" onClick={() => setOpen(true)} data-testid="discover-open">
          <Icon name="search" size={15} /> Look for pictures…
        </button>
      </section>
    )
  }

  return (
    <section className="discover" data-testid="discover">
      <header className="discover__head">
        <div>
          <div className="eyebrow">DISCOVER · READ-ONLY</div>
          <h2>Find pictures on this computer</h2>
        </div>
        <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close discovery" disabled={running}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <p className="discover__note">
        Searching only looks at folder and file names and sizes. Nothing is copied, changed or indexed until you choose collections below, and your
        originals are never written to.
      </p>

      <div className="discover__setup">
        <div>
          <h3>Where to look</h3>
          <div className="discover__drives">
            {drives.map((drive) => (
              <label key={drive.path} className="discover__drive">
                <input
                  type="checkbox"
                  checked={chosenDrives.includes(drive.path)}
                  onChange={(e) => setChosenDrives(e.target.checked ? [...chosenDrives, drive.path] : chosenDrives.filter((p) => p !== drive.path))}
                  data-drive={drive.label}
                />
                <span>
                  {drive.label}
                  {drive.isSystem ? <em> · system drive</em> : null}
                </span>
              </label>
            ))}
          </div>
          <label className="discover__min">
            <span>Only folders with at least</span>
            <input type="number" min={2} max={200} value={minImages} onChange={(e) => setMinImages(Math.max(2, Number(e.target.value) || 8))} aria-label="Minimum pictures per folder" />
            <span>pictures</span>
          </label>
        </div>
        <div>
          <h3>Always left out</h3>
          <p className="discover__chips" aria-label="Folders left out by default">
            {excludedNames.slice(0, 14).map((name) => (
              <button
                key={name}
                type="button"
                className={searchAnyway.includes(name) ? 'is-off' : ''}
                title={searchAnyway.includes(name) ? 'This folder name will be searched. Click to leave it out again.' : 'Left out. Click to search folders with this name anyway.'}
                onClick={() => setSearchAnyway(searchAnyway.includes(name) ? searchAnyway.filter((n) => n !== name) : [...searchAnyway, name])}
              >
                {name}
              </button>
            ))}
            <span>… and {Math.max(0, excludedNames.length - 14)} more, plus any folder that holds a program</span>
          </p>
          <div className="discover__excl">
            {excludePaths.map((p) => (
              <span key={p}>
                {p} <button type="button" onClick={() => setExcludePaths(excludePaths.filter((x) => x !== p))} aria-label={`Search ${p} again`}>✕</button>
              </span>
            ))}
            <button type="button" className="button button--ghost" onClick={() => void addExclusion()}>
              <Icon name="plus" size={13} /> Leave out a folder
            </button>
          </div>
        </div>
      </div>

      {running ? (
        <div className="discover__progress" role="status" aria-live="polite">
          <Spinner size={16} label="Searching" />
          <div>
            <strong>
              {formatNumber(progress?.imagesFound ?? 0)} pictures in {plural(progress?.collectionsFound ?? 0, 'folder')} so far
            </strong>
            <small>
              {formatNumber(progress?.scannedFolders ?? 0)} folders looked at · {formatNumber(progress?.skippedFolders ?? 0)} skipped · {progress?.current ?? ''}
            </small>
          </div>
          <button type="button" className="button button--ghost" onClick={() => void window.noema.discoverStop()}>
            <Icon name="stop" size={13} /> Stop
          </button>
        </div>
      ) : (
        <button type="button" className="button button--gold discover__start" onClick={() => void start()} data-testid="discover-start">
          <Icon name="search" size={15} /> {found ? 'Search again' : 'Search'}
        </button>
      )}

      {found ? (
        <div className="discover__results" data-testid="discover-results">
          <p className="discover__summary">
            {found.cancelled ? 'Stopped early. ' : ''}
            {plural(found.collections.length, 'collection')} found in {formatNumber(found.scannedFolders)} folders ({formatNumber(found.skippedFolders)} skipped). Tick the ones you want in Atlas.
          </p>
          <div className="discover__grid">
            {found.collections.slice(0, 60).map((collection) => (
              <label key={collection.path} className={`discover__card${picked.has(collection.path) ? ' is-on' : ''}${collection.inAtlas ? ' is-in' : ''}`} data-collection={collection.name}>
                <div className="discover__samples">
                  {(previews[collection.path] ?? []).slice(0, 4).map((src, i) => (
                    <img key={i} src={src} alt="" draggable={false} />
                  ))}
                  {(previews[collection.path] ?? []).length === 0 ? <span className="discover__loading" /> : null}
                </div>
                <div className="discover__meta">
                  <input type="checkbox" checked={picked.has(collection.path)} disabled={collection.inAtlas} onChange={() => toggle(collection.path)} aria-label={`Add ${collection.name}`} />
                  <div>
                    <strong>{collection.name}</strong>
                    <small title={collection.path}>{collection.path}</small>
                    <small>
                      {plural(collection.images, 'picture')} · {formatBytes(collection.bytes)}
                      {collection.folders > 1 ? ` · ${collection.folders} folders` : ''}
                    </small>
                  </div>
                  {collection.inAtlas ? <em>In Atlas</em> : null}
                </div>
              </label>
            ))}
          </div>
          {found.collections.length === 0 ? <p className="discover__summary">Nothing that looks like a collection of pictures. Try lowering the minimum or searching another drive.</p> : null}
          {picked.size > 0 ? (
            <div className="discover__bar">
              <span>
                {plural(picked.size, 'collection')} · about {formatNumber(total)} pictures. Atlas will index them with small previews and leave the originals where they are.
              </span>
              <button type="button" className="button button--gold" onClick={() => void add()} disabled={adding} data-testid="discover-add">
                <Icon name="plus" size={15} /> {adding ? 'Adding…' : 'Add to Atlas'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
