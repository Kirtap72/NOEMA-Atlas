import { useMemo, useState } from 'react'
import type { CompareDimension, CompareRegion, CompareState, ImageItem, RegionStatus } from '@shared/types'
import { Icon } from '../Icon'
import { Spinner } from '../ui'
import { Lightbox } from '../Lightbox'
import { Credit, DimBar, Thumb, WorkLink, useLoaded, workLine } from './shared'

const W = 1000
const H = 620
const PAD = 36
const px = (x: number): number => PAD + x * (W - 2 * PAD)
const py = (y: number): number => PAD + y * (H - 2 * PAD)

const STATUS: Record<RegionStatus, { label: string; colour: string; text: string }> = {
  shared: { label: 'Shared', colour: '#e7c67b', text: 'Both your favorites and your exploration point here.' },
  identity: { label: 'In your favorites', colour: '#d9a65a', text: 'Your favorites reach this area; exploration has not touched it yet.' },
  discovered: { label: 'Discovered', colour: '#6fc6b8', text: 'You liked works here while exploring; none of your favorites are here yet.' },
  promising: { label: 'Promising, unseen', colour: '#b497e6', text: 'You have not seen this area. Atlas predicts it may suit you: a guess to be tested.' },
  passed: { label: 'You passed on this', colour: '#8f8f86', text: 'You passed on works here while exploring. That is evidence about these works, not about the whole area.' },
  unexplored: { label: 'Unexplored', colour: '#5d5d55', text: 'No evidence either way.' }
}

const RELATION_TEXT: Record<CompareDimension['relation'], string> = {
  shared: 'Agree',
  identity: 'Favorites only',
  discovered: 'Discoveries only',
  divergent: 'Differ',
  unclear: 'Unclear'
}

function ArtMap({ state, selected, onSelect }: { state: CompareState; selected: number | null; onSelect: (id: number) => void }): React.JSX.Element {
  const [show, setShow] = useState({ favorites: true, liked: true, passed: true, collection: true })
  const regions = state.regions
  return (
    <div className="artmap">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="A map of the Atlas Reference Collection with your favorites and discoveries">
        <rect x="0" y="0" width={W} height={H} className="artmap__bg" />
        {show.collection
          ? state.map.map((p) => <circle key={p.id} cx={px(p.x)} cy={py(p.y)} r="2.2" className="artmap__work" style={{ fill: `hsl(${(p.region * 47) % 360} 28% 62%)` }} />)
          : null}
        {regions.map((r) => {
          const s = STATUS[r.status]
          const radius = 24 + Math.sqrt(r.count) * 3.2
          return (
            <g key={r.id} className={`artmap__region ${selected === r.id ? 'is-selected' : ''}`} tabIndex={0} role="button" aria-label={`${r.label}: ${s.label}`} onClick={() => onSelect(r.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(r.id))}>
              <circle cx={px(r.centre.x)} cy={py(r.centre.y)} r={radius} className="artmap__halo" style={{ stroke: s.colour, fill: s.colour, strokeDasharray: r.status === 'promising' || r.status === 'unexplored' ? '4 5' : undefined }} />
            </g>
          )
        })}
        {show.passed ? state.points.filter((p) => p.kind === 'passed').map((p) => <path key={`x${p.id}`} d={`M ${px(p.x) - 3} ${py(p.y) - 3} l 6 6 M ${px(p.x) + 3} ${py(p.y) - 3} l -6 6`} className="artmap__passed" />) : null}
        {show.liked ? state.points.filter((p) => p.kind === 'liked').map((p) => <circle key={`l${p.id}`} cx={px(p.x)} cy={py(p.y)} r="4.6" className="artmap__liked" />) : null}
        {show.favorites ? state.points.filter((p) => p.kind === 'favorite').map((p) => <circle key={`f${p.id}`} cx={px(p.x)} cy={py(p.y)} r="5.4" className="artmap__favorite" />) : null}
        {regions.filter((r) => r.count >= 45 || selected === r.id || ['shared', 'identity', 'discovered', 'promising'].includes(r.status)).map((r) => (
          <text key={`t${r.id}`} x={px(r.centre.x)} y={py(r.centre.y) - 26 - Math.sqrt(r.count) * 3.2 + 22} textAnchor="middle" className={`artmap__label ${selected === r.id ? 'is-selected' : ''}`}>
            {r.label.split(' · ')[0]!.replace(/^(.{26}).*$/, '$1…')}
          </text>
        ))}
      </svg>
      <div className="artmap__legend">
        <label><input type="checkbox" checked={show.favorites} onChange={(e) => setShow({ ...show, favorites: e.target.checked })} /><i className="lg lg--fav" /> your favorites</label>
        <label><input type="checkbox" checked={show.liked} onChange={(e) => setShow({ ...show, liked: e.target.checked })} /><i className="lg lg--liked" /> works you liked</label>
        <label><input type="checkbox" checked={show.passed} onChange={(e) => setShow({ ...show, passed: e.target.checked })} /><i className="lg lg--passed" /> works you passed on</label>
        <label><input type="checkbox" checked={show.collection} onChange={(e) => setShow({ ...show, collection: e.target.checked })} /><i className="lg lg--work" /> the collection</label>
      </div>
      <div className="artmap__status">
        {(['shared', 'identity', 'discovered', 'promising', 'passed', 'unexplored'] as RegionStatus[]).map((k) => (
          <span key={k}><i style={{ background: STATUS[k].colour }} /> {STATUS[k].label}</span>
        ))}
      </div>
    </div>
  )
}

function RegionPanel({ region, onJourney }: { region: CompareRegion; onJourney: (region: CompareRegion) => void }): React.JSX.Element {
  const s = STATUS[region.status]
  return (
    <aside className="region-panel" aria-live="polite">
      <div className="eyebrow">{s.label.toUpperCase()}</div>
      <h3>{region.label}</h3>
      <p>{s.text}</p>
      <ul className="facts">
        <li>{region.count} works in this part of the collection</li>
        <li>{region.favorites} of your favorites sit here</li>
        <li>You liked {region.liked} and passed on {region.passed} of the {region.seen} you saw here</li>
        {region.appeal !== null ? <li>Predicted appeal: around the {Math.round(region.appeal)}th percentile of the collection (a prediction, not a measurement)</li> : <li>No prediction yet: more answers are needed</li>}
      </ul>
      <div className="dthumbs">{region.examples.map((w) => <Thumb key={w.id} item={w} size="md" title={workLine(w)} />)}</div>
      <p className="hint">Typical works here: {region.examples.slice(0, 2).map((w) => `${w.artist || 'Unknown maker'} (${w.date || 'undated'})`).join('; ')}.</p>
      <button type="button" className="button button--gold" onClick={() => onJourney(region)}>
        <Icon name="sparkle" size={15} /> Begin a journey here
      </button>
    </aside>
  )
}

function DimensionRow({ dim, open, onToggle, onOpen }: { dim: CompareDimension; open: boolean; onToggle: () => void; onOpen: (items: ImageItem[]) => void }): React.JSX.Element {
  return (
    <div className={`cdim ${open ? 'is-open' : ''}`}>
      <button type="button" className="cdim__row" onClick={onToggle} aria-expanded={open}>
        <span className="cdim__label"><b>{dim.oppositeLabel} ↔ {dim.label}</b><small>{dim.axisLabel}: bars lean right towards “{dim.label}”, left towards “{dim.oppositeLabel}”</small></span>
        <DimBar dim={dim.identity} tone="identity" />
        <DimBar dim={dim.discovered} tone="discovered" />
        <span className={`cdim__badge cdim__badge--${dim.relation}`}>{RELATION_TEXT[dim.relation]}</span>
      </button>
      {open ? (
        <div className="cdim__detail">
          <p>{dim.statement}</p>
          <div className="cdim__examples">
            {dim.identityExamples.length > 0 ? (
              <div><h4>From your favorites</h4><div className="dthumbs">{dim.identityExamples.map((i, idx) => <Thumb key={i.id} item={i} size="md" onClick={() => onOpen(dim.identityExamples.slice(idx))} />)}</div></div>
            ) : null}
            {dim.discoveredExamples.length > 0 ? (
              <div><h4>From works you liked</h4><div className="dthumbs">{dim.discoveredExamples.map((w) => <figure key={w.id}><Thumb item={w} size="md" /><figcaption><Credit work={w} /> <WorkLink work={w} /></figcaption></figure>)}</div></div>
            ) : null}
            {dim.identityExamples.length === 0 && dim.discoveredExamples.length === 0 ? <p className="hint">No examples are shown for qualities without reliable evidence.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function CompareTab({ onJourney }: { onJourney: (kind: 'unexplored' | 'emerging', ref: number, label: string) => void }): React.JSX.Element {
  const { data, error, loading } = useLoaded<CompareState>(() => window.noema.getCompare(), [])
  const [selected, setSelected] = useState<number | null>(null)
  const [openDim, setOpenDim] = useState<string | null>(null)
  const [viewer, setViewer] = useState<ImageItem[] | null>(null)
  const region = useMemo(() => data?.regions.find((r) => r.id === selected) ?? null, [data, selected])

  if (loading && !data) return <div className="taste-loading"><Spinner size={22} /> Comparing your two profiles…</div>
  if (error) return <div className="inline-error"><Icon name="info" size={16} /> {error}</div>
  if (!data) return <></>

  return (
    <div className="compare">
      <section className="panel-intro">
        <div className="eyebrow">TWO INDEPENDENT PROFILES</div>
        <h2>Where your favorites and your discoveries meet</h2>
        <ul className="headline">
          {data.headline.map((h) => <li key={h}>{h}</li>)}
        </ul>
        <p className="hint">
          Evidence now: {data.identity.learned} favorites learned, {data.discovery.informative} exploration answers. Statements are only made where the numbers support them, and every one is qualified by how little or much evidence there is.
        </p>
      </section>

      <div className="compare__main">
        <ArtMap state={data} selected={selected} onSelect={(id) => setSelected((s) => (s === id ? null : id))} />
        {region ? (
          <RegionPanel region={region} onJourney={(r) => onJourney(r.status === 'discovered' || r.status === 'shared' ? 'emerging' : 'unexplored', r.id, r.label)} />
        ) : (
          <aside className="region-panel is-hint"><p>Select an area of the map to see what you have and have not touched there, with example works.</p></aside>
        )}
      </div>

      <section className="cdims" aria-label="Qualities compared">
        <div className="cdims__head">
          <h3>Qualities, side by side</h3>
          <div className="cdims__key"><span><i className="dimbar-key dimbar-key--identity" /> my favorites</span><span><i className="dimbar-key dimbar-key--discovered" /> my discoveries</span><span>bars show standard deviations from typical art (−2 to +2) with the 99% range</span></div>
        </div>
        {data.dimensions.map((d) => (
          <DimensionRow key={d.id} dim={d} open={openDim === d.id} onToggle={() => setOpenDim((c) => (c === d.id ? null : d.id))} onOpen={(items) => setViewer(items)} />
        ))}
      </section>

      {viewer ? <Lightbox items={viewer} initialIndex={0} onClose={() => setViewer(null)} onUpdate={() => undefined} /> : null}
    </div>
  )
}
