import { useCallback, useEffect, useState } from 'react'
import type { ImageItem, ProfileDimension, ReferenceWork } from '@shared/types'
import { friendlyError } from '../../lib/format'

/** Loads something once (and again on demand), keeping the error as text. */
export function useLoaded<T>(load: () => Promise<T>, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => Promise<void>; set: (value: T) => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const run = useCallback(async () => {
    setLoading(true)
    try {
      setData(await load())
      setError(null)
    } catch (loadError) {
      setError(friendlyError(loadError))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useEffect(() => {
    void run()
  }, [run])
  return { data, error, loading, reload: run, set: setData }
}

export const isReference = (item: ImageItem | ReferenceWork): item is ReferenceWork => 'museum' in item

export function thumbOf(item: ImageItem | ReferenceWork): string {
  return isReference(item) ? item.imageUrl : item.thumbUrl
}

/** "Artist, Title, date" as a museum label would give it. */
export function workLine(work: ReferenceWork): string {
  const maker = work.artist || 'Unknown maker'
  return `${maker}, ${work.title}${work.date ? `, ${work.date}` : ''}`
}

export function WorkLink({ work, children }: { work: ReferenceWork; children?: React.ReactNode }): React.JSX.Element {
  return (
    <a href={work.objectUrl} target="_blank" rel="noreferrer" className="work-link" title={`Open this work on the ${work.museumName} website`}>
      {children ?? 'View at the museum'}
    </a>
  )
}

export function Credit({ work }: { work: ReferenceWork }): React.JSX.Element {
  return (
    <span className="work-credit">
      {work.museumName}
      {work.credit ? ` · ${work.credit}` : ''} · {work.license}
    </span>
  )
}

export function Thumb({ item, onClick, size = 'md', title }: { item: ImageItem | ReferenceWork; onClick?: () => void; size?: 'sm' | 'md' | 'lg'; title?: string }): React.JSX.Element {
  const label = title ?? (isReference(item) ? workLine(item) : item.filename)
  const color = isReference(item) ? '#23231d' : (item.color ?? '#23231d')
  const body = <img src={thumbOf(item)} alt="" loading="lazy" draggable={false} />
  return onClick ? (
    <button type="button" className={`dthumb dthumb--${size}`} onClick={onClick} title={label} style={{ '--tint': color } as React.CSSProperties}>
      {body}
    </button>
  ) : (
    <span className={`dthumb dthumb--${size}`} title={label} style={{ '--tint': color } as React.CSSProperties}>
      {body}
    </span>
  )
}

export function strengthWord(value: number): string {
  const a = Math.abs(value)
  return a < 0.5 ? 'slightly' : a < 1 ? 'clearly' : 'strongly'
}

/** A quality chip: label, direction and strength, with the number of images behind it. */
export function QualityChip({ dim }: { dim: ProfileDimension }): React.JSX.Element {
  return (
    <span className="quality-chip" title={`${dim.mean >= 0 ? '+' : ''}${dim.mean.toFixed(2)} standard deviations vs. typical art (99% range ${dim.low.toFixed(2)} to ${dim.high.toFixed(2)}), from ${dim.n} images`}>
      <b>{dim.mean >= 0 ? '' : 'less '}{dim.label}</b>
      <i>{strengthWord(dim.mean)} · {dim.n} images</i>
    </span>
  )
}

/** A bar from -2 to +2 standard deviations with its 99% interval, for one quality. */
export function DimBar({ dim, tone }: { dim: ProfileDimension | null; tone: 'identity' | 'discovered' }): React.JSX.Element {
  const clamp = (v: number): number => Math.max(-2, Math.min(2, v))
  const pos = (v: number): number => ((clamp(v) + 2) / 4) * 100
  if (!dim || dim.n === 0) return <span className={`dimbar dimbar--${tone} is-empty`} aria-label="no data" />
  const left = Math.min(pos(0), pos(dim.mean))
  const width = Math.abs(pos(dim.mean) - pos(0))
  return (
    <span className={`dimbar dimbar--${tone} ${dim.certain ? 'is-certain' : 'is-faint'}`} role="img" aria-label={`${dim.label}: ${dim.mean.toFixed(2)}${dim.certain ? ', reliable' : ', not reliable yet'}`}>
      <i className="dimbar__zero" />
      <i className="dimbar__fill" style={{ left: `${left}%`, width: `${Math.max(1, width)}%` }} />
      <i className="dimbar__ci" style={{ left: `${pos(dim.low)}%`, width: `${Math.max(1, pos(dim.high) - pos(dim.low))}%` }} />
    </span>
  )
}
