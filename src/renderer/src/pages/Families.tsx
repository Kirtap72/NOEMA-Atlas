import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FamilyList, ImageFamily } from '@shared/types'
import { useImageFeed, useInfiniteScroll } from '../lib/useImageFeed'
import { useIndexStatus } from '../lib/useIndexStatus'
import { ImageGrid } from '../components/ImageCard'
import { Lightbox } from '../components/Lightbox'
import { EmptyState } from '../components/ui'
import { Icon } from '../components/Icon'
import { MoodboardDialog, SelectionBar, sourceTitle, type BoardSource } from '../components/MoodboardDialog'
import { openAiSetup } from '../components/AiSetup'
import { friendlyError, formatNumber } from '../lib/format'
import { useAtlas } from '../lib/useAtlas'

function useFamilies(): { list: FamilyList | null; error: string | null; rebuild: () => Promise<void>; rename: (id: number, name: string) => Promise<void> } {
  const [list, setList] = useState<FamilyList | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setList(await window.noema.listFamilies())
      setError(null)
    } catch (loadError) {
      setError(friendlyError(loadError))
    }
  }, [])

  useEffect(() => {
    void load()
    return window.noema.onFamiliesChanged(() => void load())
  }, [load])

  const rebuild = useCallback(async () => {
    try {
      setList(await window.noema.rebuildFamilies())
    } catch (rebuildError) {
      setError(friendlyError(rebuildError))
    }
  }, [])

  const rename = useCallback(async (id: number, name: string) => {
    setList(await window.noema.renameFamily(id, name))
  }, [])

  return { list, error, rebuild, rename }
}

/** The name shown for a family: the user's name, the automatic one, or a plain number while it has no name yet. */
function displayName(family: ImageFamily, index: number): string {
  return family.name ?? `Family ${String(index).padStart(2, '0')}`
}

const CONFIDENCE_TEXT: Record<'clear' | 'loose' | 'mixed', string> = {
  clear: 'Clear common thread',
  loose: 'Loose common thread',
  mixed: 'Mixed: no single thread'
}

function cohesionWord(cohesion: number): string {
  if (cohesion >= 0.88) return 'Very close'
  if (cohesion >= 0.82) return 'Close'
  return 'Loose'
}

export function FamiliesPage(): React.JSX.Element {
  const { list, error, rebuild, rename } = useFamilies()
  const indexStatus = useIndexStatus()
  const [openId, setOpenId] = useState<number | null>(null)
  const openFamily = list?.families.find((family) => family.id === openId) ?? null

  useEffect(() => {
    if (openId !== null && list && !list.families.some((family) => family.id === openId)) setOpenId(null)
  }, [list, openId])

  if (openFamily) {
    return <FamilyDetail family={openFamily} index={list!.families.indexOf(openFamily) + 1} onBack={() => setOpenId(null)} onRename={(name) => rename(openFamily.id, name)} />
  }

  const families = list?.families ?? []
  const clustered = families.reduce((sum, family) => sum + family.size, 0)
  const waiting = indexStatus && indexStatus.total > 0 && indexStatus.indexed < indexStatus.total
  const stale = list && list.embedded > 0 && list.clustered !== list.embedded

  return (
    <div className="page page--families">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">FAMILIES · IMAGES THAT BELONG TOGETHER</div>
          <h1 className="page-title">
            Families
            <span className="page-title__count">{formatNumber(families.length)}</span>
          </h1>
          <p className="page-subtitle">
            Atlas groups images that look alike and names each family after what its images share: the subject, the
            mood or the style. Rename any family you like; your name is kept when Atlas regroups. Your files are never moved.
          </p>
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={!list || list.building || list.embedded === 0}
            onClick={() => void rebuild()}
          >
            <Icon name="refresh" size={16} /> {list?.building ? 'Grouping…' : 'Regroup'}
          </button>
        </div>
      </header>

      {families.length > 0 ? (
        <div className="page-summary">
          <span>{formatNumber(clustered)} images in families</span>
          <span className="dot-separator">·</span>
          <span>{formatNumber(Math.max(0, (list?.embedded ?? 0) - clustered))} on their own</span>
          {waiting ? (
            <>
              <span className="dot-separator">·</span>
              <span>
                still learning {formatNumber(indexStatus.indexed)} / {formatNumber(indexStatus.total)}
              </span>
            </>
          ) : stale ? (
            <>
              <span className="dot-separator">·</span>
              <span>new images since the last grouping</span>
            </>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="inline-error">
          <Icon name="info" size={16} /> {error}
        </div>
      ) : null}

      {families.length === 0 ? (
        <EmptyState
          icon="boards"
          title={
            indexStatus && (!indexStatus.modelInstalled || !indexStatus.enabled)
              ? 'Families are part of the optional AI features.'
              : waiting || list?.building
                ? 'Atlas is still getting to know your images.'
                : 'No families yet.'
          }
          copy={
            indexStatus && (!indexStatus.modelInstalled || !indexStatus.enabled)
              ? 'Families need the optional image model. It runs on this computer, and Atlas works fully without it.'
              : waiting
                ? `Learned ${formatNumber(indexStatus.indexed)} of ${formatNumber(indexStatus.total)} images. Families appear when that is done.`
                : 'Add a folder, or press Regroup once your images have been learned.'
          }
        >
          {indexStatus && (!indexStatus.modelInstalled || !indexStatus.enabled) ? (
            <button type="button" className="button button--gold" onClick={openAiSetup}>
              <Icon name="sparkle" size={16} /> Set up visual search
            </button>
          ) : null}
        </EmptyState>
      ) : (
        <div className="family-grid">
          {families.map((family, index) => (
            <FamilyCard key={family.id} family={family} index={index + 1} onOpen={() => setOpenId(family.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function FamilyCard({
  family,
  index,
  onOpen
}: {
  family: ImageFamily
  index: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button type="button" className="family-card" onClick={onOpen}>
      <span className="family-card__mosaic">
        {family.covers.slice(0, 3).map((cover, position) => (
          <img key={cover.id} src={cover.thumbUrl} alt="" loading="lazy" draggable={false} data-slot={position} />
        ))}
      </span>
      <span className="family-card__meta">
        <span className="family-card__name" title={displayName(family, index)}>{displayName(family, index)}</span>
        <span className="family-card__count">{formatNumber(family.size)} images</span>
        {family.customName ? (
          <span className="family-card__tag family-card__tag--own">Named by you</span>
        ) : family.nameConfidence === 'mixed' ? (
          <span className="family-card__tag">Mixed</span>
        ) : family.keywords.length > 0 ? (
          <span className="family-card__tag">{family.keywords.slice(0, 2).join(' · ')}</span>
        ) : null}
        <span className="family-card__cohesion" title={`Similarity to the family centre: ${Math.round(family.cohesion * 100)}%`}>
          <i style={{ width: `${Math.round(Math.max(0, Math.min(1, (family.cohesion - 0.6) / 0.35)) * 100)}%` }} />
          <small>{cohesionWord(family.cohesion)}</small>
        </span>
      </span>
    </button>
  )
}

function FamilyDetail({
  family,
  index,
  onBack,
  onRename
}: {
  family: ImageFamily
  index: number
  onBack: () => void
  onRename: (name: string) => Promise<void>
}): React.JSX.Element {
  const { toast } = useAtlas()
  const [selected, setSelected] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<BoardSource | null>(null)
  const anchor = useRef<number | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const query = useMemo(() => ({ scope: 'archive' as const, familyId: family.id, limit: 90 }), [family.id])
  const feed = useImageFeed(query)
  useInfiniteScroll(sentinelRef, () => void feed.loadMore(), feed.hasMore && !feed.loading)
  const title = displayName(family, index)
  useEffect(() => {
    void window.noema.setCompanionView({ kind: 'family', id: String(family.id), name: title })
    return () => void window.noema.setCompanionView({ kind: null })
  }, [family.id, title])

  const startRename = (): void => {
    setDraft(title)
    setEditing(true)
  }
  const saveRename = async (value: string): Promise<void> => {
    setEditing(false)
    try {
      await onRename(value)
    } catch (renameError) {
      toast(friendlyError(renameError), 'error')
    }
  }

  const leaveSelection = useCallback((): void => {
    setSelecting(false)
    setPicked(new Set())
    setDialog(null)
    anchor.current = null
  }, [])

  useEffect(() => {
    if (!selecting) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !dialog && !(event.target instanceof HTMLInputElement)) leaveSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting, dialog, leaveSelection])

  const toggle = (position: number, shift: boolean): void => {
    const item = feed.items[position]
    if (!item) return
    const start = anchor.current
    setPicked((current) => {
      const next = new Set(current)
      if (shift && start !== null) {
        const from = Math.min(start, position)
        const to = Math.max(start, position)
        for (let i = from; i <= to; i += 1) {
          const entry = feed.items[i]
          if (entry) next.add(entry.id)
        }
      } else if (next.has(item.id)) {
        next.delete(item.id)
      } else {
        next.add(item.id)
      }
      return next
    })
    anchor.current = position
  }

  const selectAll = async (): Promise<void> => {
    try {
      setPicked(new Set(await window.noema.familyImageIds(family.id)))
    } catch (selectError) {
      toast(friendlyError(selectError), 'error')
    }
  }

  const chosen = Array.from(picked)
  const loadAll = (): Promise<string[]> => window.noema.familyImageIds(family.id)

  return (
    <div className="page page--families">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">FAMILY {String(index).padStart(2, '0')} · MOST TYPICAL FIRST</div>
          {editing ? (
            <form
              className="family-rename"
              onSubmit={(event) => {
                event.preventDefault()
                void saveRename(draft)
              }}
            >
              <input
                autoFocus
                aria-label="Family name"
                maxLength={80}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setEditing(false)
                }}
              />
              <button type="submit" className="button button--gold">Save</button>
              <button type="button" className="button button--ghost" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          ) : (
            <h1 className="page-title family-title">
              <span className="family-title__name">{title}</span>
              <button type="button" className="icon-button family-title__edit" onClick={startRename} aria-label="Rename this family" title="Rename this family">
                <Icon name="edit" size={16} />
              </button>
              <span className="page-title__count">{formatNumber(family.size)}</span>
            </h1>
          )}
          <p className="page-subtitle">
            {family.customName
              ? `You named this family. Atlas would call it “${family.autoName ?? 'unnamed'}”.`
              : family.nameNote ?? 'Images that sit close together in how they look.'}{' '}
            The first images are the most typical of the group.
          </p>
          <div className="family-facts">
            {family.nameConfidence ? <span className={`family-chip family-chip--${family.nameConfidence}`}>{CONFIDENCE_TEXT[family.nameConfidence]}</span> : null}
            {family.keywords.map((keyword) => <span key={keyword} className="family-chip">{keyword}</span>)}
            {family.customName ? (
              <button type="button" className="button button--quiet" onClick={() => void saveRename('')}>Use Atlas&rsquo;s name</button>
            ) : null}
          </div>
        </div>
        <div className="page-head__actions">
          <button type="button" className={`button ${selecting ? 'button--gold' : 'button--ghost'}`} onClick={() => (selecting ? leaveSelection() : setSelecting(true))} aria-pressed={selecting}>
            <Icon name="check" size={16} /> {selecting ? 'Done selecting' : 'Select images'}
          </button>
          {!selecting ? (
            <button type="button" className="button button--ghost" onClick={() => setDialog('all')} title="Make a moodboard with every image in this family">
              <Icon name="boards" size={16} /> {sourceTitle('all', family.size)}
            </button>
          ) : null}
          <button type="button" className="button button--ghost" onClick={onBack}>
            <Icon name="arrowLeft" size={16} /> All families
          </button>
        </div>
      </header>

      {selecting ? (
        <SelectionBar
          picked={picked.size}
          total={family.size}
          onSelectAll={() => void selectAll()}
          onClear={() => setPicked(new Set())}
          onSelectedBoard={() => setDialog('selected')}
          onAllBoard={() => setDialog('all')}
        />
      ) : null}

      {dialog ? (
        <MoodboardDialog
          source={dialog}
          loadIds={dialog === 'selected' ? () => Promise.resolve(chosen) : loadAll}
          defaultName={title}
          onClose={() => setDialog(null)}
          onDone={() => leaveSelection()}
        />
      ) : null}

      {feed.error ? (
        <div className="inline-error">
          <Icon name="info" size={16} /> {feed.error}
        </div>
      ) : null}

      <ImageGrid
        items={feed.items}
        loading={feed.loading}
        loadingMore={feed.loadingMore}
        hasMore={feed.hasMore}
        density={Number(localStorage.getItem('atlas.density') ?? 1)}
        onOpen={setSelected}
        onUpdate={feed.replaceItem}
        onLoadMore={() => void feed.loadMore()}
        sentinelRef={sentinelRef}
        selection={selecting ? { selected: picked, onToggle: toggle } : undefined}
      />

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
