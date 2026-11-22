import { useState } from 'react'
import type { IdentityState, ImageItem, ProfileMode, ReferenceWork } from '@shared/types'
import { Icon } from '../Icon'
import { EmptyState, Spinner } from '../ui'
import { Lightbox } from '../Lightbox'
import { openAiSetup } from '../AiSetup'
import { Credit, DimBar, QualityChip, Thumb, WorkLink, isReference, useLoaded, workLine } from './shared'

/**
 * My Artistic Identity: what the images the user explicitly marked as favorites have in common, measured against the
 * reference collection. Several separate preferences are shown separately. Nothing here says what the user dislikes.
 */
export function IdentityTab({ onJourney }: { onJourney: (kind: 'identity', ref: number, label: string) => void }): React.JSX.Element {
  const { data, error, loading } = useLoaded<IdentityState>(() => window.noema.getIdentity(), [])
  const [viewer, setViewer] = useState<{ items: ImageItem[]; index: number } | null>(null)

  if (loading && !data) return <div className="taste-loading"><Spinner size={22} /> Reading your favorites…</div>
  if (error) return <div className="inline-error"><Icon name="info" size={16} /> {error}</div>
  if (!data) return <></>
  if (!data.available) {
    return (
      <EmptyState icon="heart" title="Your artistic identity starts with your favorites." copy={data.reason ?? 'Mark images you love as favorites.'}>
        {data.reason?.includes('model') ? (
          <button type="button" className="button button--gold" onClick={openAiSetup}><Icon name="sparkle" size={16} /> Set up the image model</button>
        ) : (
          <span className="hint">{data.favorites} favorite{data.favorites === 1 ? '' : 's'} so far{data.pending > 0 ? `, ${data.pending} still being learned` : ''}.</span>
        )}
      </EmptyState>
    )
  }

  // Each axis has two mirrored poles; list only the one the favorites lean towards.
  const reliable = data.dimensions.filter((d) => d.certain && d.mean > 0).sort((a, b) => b.mean - a.mean)

  return (
    <div className="identity">
      <section className="panel-intro">
        <div className="eyebrow">MY ARTISTIC IDENTITY</div>
        <h2>What your {data.learned} favorites have in common</h2>
        <p>
          Atlas looks only at the images you marked as favorites, and compares them with the Atlas Reference Collection of art from many
          traditions, so the result does not depend on what else is in your library. How common a style is in your library says nothing
          about whether you like it, and a style missing from your favorites is not read as dislike.
        </p>
        {data.tentative ? (
          <p className="tentative">
            <Icon name="info" size={14} /> A tentative picture: {data.learned} favorites is a small base. Qualities are only called out when at least 5 images and a strict
            statistical test support them, so expect few claims until you have more favorites.
          </p>
        ) : null}
        {data.pending > 0 ? <p className="hint">{data.pending} more favorite{data.pending === 1 ? ' is' : 's are'} still being learned and will be added.</p> : null}
      </section>

      {reliable.length > 0 ? (
        <section className="overall">
          <h3>Across all your favorites</h3>
          <div className="chips">{reliable.slice(0, 6).map((d) => <QualityChip key={d.id} dim={d} />)}</div>
        </section>
      ) : null}

      <div className="mode-grid">
        {data.modes.map((mode) => (
          <ModeCard key={mode.id} mode={mode} onOpenImages={(items, index) => setViewer({ items, index })} onJourney={() => onJourney('identity', mode.id, mode.label)} />
        ))}
      </div>

      {data.modes.length > 1 ? (
        <p className="hint">
          Atlas found {data.modes.length} separate groups among your favorites. They are shown apart on purpose: loving several different things is not an average of them.
        </p>
      ) : (
        <p className="hint">Your favorites form one group so far. If they contain separate tastes, they will appear as separate groups as you add more.</p>
      )}

      {viewer ? <Lightbox items={viewer.items} initialIndex={viewer.index} onClose={() => setViewer(null)} onUpdate={() => undefined} /> : null}
    </div>
  )
}

function ModeCard({ mode, onOpenImages, onJourney }: { mode: ProfileMode; onOpenImages: (items: ImageItem[], index: number) => void; onJourney: () => void }): React.JSX.Element {
  const images = mode.examples.filter((e): e is ImageItem => !isReference(e))
  return (
    <article className="mode-card mode-card--wide">
      <header>
        <div>
          <h3>{mode.label}</h3>
          <span>{mode.size} favorites ({Math.round(mode.share * 100)}% of them){mode.tentative ? ' · tentative' : ''}</span>
        </div>
        <button type="button" className="button button--gold" onClick={onJourney}>
          <Icon name="sparkle" size={15} /> Begin a journey from here
        </button>
      </header>
      <div className="dthumbs dthumbs--lg">
        {images.map((item, index) => <Thumb key={item.id} item={item} size="lg" onClick={() => onOpenImages(images, index)} />)}
      </div>
      {mode.characteristics.length > 0 ? (
        <div className="chips">{mode.characteristics.slice(0, 4).map((d) => <QualityChip key={d.id} dim={d} />)}</div>
      ) : (
        <p className="hint">No single quality stands out reliably for this group{mode.size < 5 ? ` (it has only ${mode.size} images; at least 5 are needed)` : ''}.</p>
      )}
      <div className="dimstack">
        {mode.characteristics.slice(0, 3).map((d) => (
          <div key={d.id} className="dimstack__row"><span>{d.label}</span><DimBar dim={d} tone="identity" /></div>
        ))}
      </div>
      <div className="kindred">
        <h4>Close in appearance to works in the reference collection</h4>
        <div className="kindred__strip">
          {mode.kindred.slice(0, 5).map((w: ReferenceWork) => (
            <figure key={w.id}>
              <Thumb item={w} size="md" />
              <figcaption>
                <strong>{workLine(w)}</strong>
                <Credit work={w} />
                <WorkLink work={w} />
              </figcaption>
            </figure>
          ))}
        </div>
        {mode.kindredShelves.length > 0 ? (
          <p className="hint">
            Most of the closest works come from: {mode.kindredShelves.map((s) => s.label).join('; ')}. This is a visual resemblance, not a claim about influence or style.
          </p>
        ) : null}
      </div>
    </article>
  )
}
