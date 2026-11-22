import type { HistorySnapshot, HistoryState } from '@shared/types'
import { Icon } from '../Icon'
import { Spinner } from '../ui'
import { Thumb, useLoaded, workLine } from './shared'

const DIMS = [
  ['surreal', 'Surreal & dreamlike'],
  ['natural', 'Natural & real'],
  ['abstract', 'Abstract & geometric'],
  ['figurative', 'Figurative & concrete'],
  ['poetic', 'Romantic & poetic'],
  ['dramatic', 'Stark & dramatic'],
  ['dark', 'Dark & moody'],
  ['bright', 'Bright & luminous'],
  ['vivid', 'Vivid & saturated'],
  ['muted', 'Muted & quiet'],
  ['minimal', 'Minimal & calm'],
  ['rich', 'Rich & intricate']
] as const

function Spark({ snapshots, id, profile }: { snapshots: HistorySnapshot[]; id: string; profile: 'identity' | 'discovered' }): React.JSX.Element {
  const pts = snapshots
    .map((s, i) => ({ i, d: s[profile].dimensions.find((x) => x.id === id) }))
    .filter((p): p is { i: number; d: { id: string; mean: number; certain: boolean } } => Boolean(p.d))
  const W = 180
  const H = 34
  const x = (i: number): number => 6 + (snapshots.length < 2 ? 0.5 : i / (snapshots.length - 1)) * (W - 12)
  const y = (v: number): number => H / 2 - (Math.max(-2, Math.min(2, v)) / 2) * (H / 2 - 4)
  if (pts.length === 0) return <svg className={`spark spark--${profile}`} viewBox={`0 0 ${W} ${H}`} aria-hidden="true"><line x1="0" x2={W} y1={H / 2} y2={H / 2} className="spark__zero" /></svg>
  return (
    <svg className={`spark spark--${profile}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${profile} history of ${id}`}>
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="spark__zero" />
      <polyline points={pts.map((p) => `${x(p.i)},${y(p.d.mean)}`).join(' ')} className="spark__line" />
      {pts.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.d.mean)} r={p.d.certain ? 3.2 : 2} className={p.d.certain ? 'spark__dot is-certain' : 'spark__dot'} />)}
    </svg>
  )
}

export function HistoryTab(): React.JSX.Element {
  const { data, error, loading } = useLoaded<HistoryState>(() => window.noema.getHistory(), [])
  if (loading && !data) return <div className="taste-loading"><Spinner size={22} /> Reading your history…</div>
  if (error) return <div className="inline-error"><Icon name="info" size={16} /> {error}</div>
  if (!data) return <></>
  const snaps = data.snapshots
  return (
    <div className="history">
      <section className="panel-intro">
        <div className="eyebrow">TASTE EVOLVES</div>
        <h2>How your interests have changed</h2>
        <p>{data.note}</p>
      </section>

      {snaps.length < 2 ? (
        <p className="hint">{snaps.length === 0 ? 'No snapshots yet.' : 'One snapshot so far; the history needs at least two to show change.'}</p>
      ) : (
        <>
          {data.changes.length > 0 ? (
            <section className="overall">
              <h3>What has moved</h3>
              <ul className="facts">
                {data.changes.map((c) => (
                  <li key={`${c.profile}${c.id}`}>
                    <b>{c.label}</b> in your {c.profile === 'identity' ? 'favorites' : 'discoveries'} moved from {c.from.toFixed(2)} to {c.to.toFixed(2)} (standard deviations from typical art).
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="hint">No quality has moved clearly between the first and the latest snapshot.</p>
          )}
          <section className="sparks" aria-label="Qualities over time">
            <div className="sparks__head"><span /><span><i className="dimbar-key dimbar-key--identity" /> favorites</span><span><i className="dimbar-key dimbar-key--discovered" /> discoveries</span></div>
            {DIMS.map(([id, label]) => (
              <div className="sparks__row" key={id}>
                <span>{label}</span>
                <Spark snapshots={snaps} id={id} profile="identity" />
                <Spark snapshots={snaps} id={id} profile="discovered" />
              </div>
            ))}
            <p className="hint">Lines run oldest to newest; large dots are reliable readings. The middle line is typical art in the collection.</p>
          </section>
        </>
      )}

      <section className="timeline" aria-label="Snapshots">
        {snaps.slice().reverse().map((s) => (
          <article className="timeline__item" key={s.id}>
            <div className="eyebrow">{new Date(s.at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}{s.reconstructed ? ' · RECONSTRUCTED' : ''}</div>
            <p>
              {s.identity.favorites} favorites in {s.identity.modes || 0} group{s.identity.modes === 1 ? '' : 's'}
              {!s.reconstructed ? `; ${s.discovered.answers} exploration answers in ${s.discovered.modes || 0} direction${s.discovered.modes === 1 ? '' : 's'}` : ''}.
            </p>
            {s.discoveries.length > 0 ? (
              <div className="timeline__found">
                <small>Works you chose, liked or saved since the previous snapshot:</small>
                <div className="dthumbs">{s.discoveries.map((w) => <Thumb key={w.id} item={w} size="sm" title={workLine(w)} />)}</div>
              </div>
            ) : null}
          </article>
        ))}
      </section>
    </div>
  )
}
