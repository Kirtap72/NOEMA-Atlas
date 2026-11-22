import { useEffect, useMemo, useRef, useState } from 'react'
import type { TasteDimension } from '@shared/types'

const SIZE = { width: 720, height: 590 }
const CENTER = { x: 360, y: 295 }
const INNER = 62
const OUTER = 205
const SLOT = 30 // degrees per petal: six axes, two poles each

/** Colour of each axis: one hue per quality, both poles of an axis share it. */
const AXIS_COLOUR: Record<string, string> = {
  reality: '#e7c67b',
  form: '#7fc0b8',
  mood: '#df8f7e',
  light: '#9db8e8',
  colour: '#b9d680',
  composition: '#c9a0e6'
}
const AXIS_ORDER = ['reality', 'form', 'mood', 'light', 'colour', 'composition']

/** 0 to 1 radius for a lean; 0.5 (the dashed ring) means "same as the images you passed over". */
export function petalValue(lean: number): number {
  return 0.5 + 0.5 * Math.tanh(lean / 0.5)
}

function polar(radius: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180
  return { x: CENTER.x + radius * Math.cos(radians), y: CENTER.y + radius * Math.sin(radians) }
}

function sectorPath(start: number, end: number, outer: number): string {
  const a = polar(INNER, start)
  const b = polar(outer, start)
  const c = polar(outer, end)
  const d = polar(INNER, end)
  return `M ${a.x} ${a.y} L ${b.x} ${b.y} A ${outer} ${outer} 0 0 1 ${c.x} ${c.y} L ${d.x} ${d.y} A ${INNER} ${INNER} 0 0 0 ${a.x} ${a.y} Z`
}

/** Eases numbers toward new targets so the petals grow and shrink instead of jumping. */
function useAnimatedValues(targets: number[], duration = 650): number[] {
  const [values, setValues] = useState(targets)
  const from = useRef(targets)
  const current = useRef(targets)
  useEffect(() => {
    const start = performance.now()
    const begin = current.current.slice()
    from.current = begin
    let frame = 0
    const tick = (now: number): void => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - t) ** 3
      const next = targets.map((target, i) => (begin[i] ?? target) + (target - (begin[i] ?? target)) * eased)
      current.current = next
      setValues(next)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.join('|'), duration])
  return values
}

interface Placed {
  dimension: TasteDimension
  slot: number
  colour: string
}

export function TasteCompass({
  dimensions,
  choices,
  stageLabel,
  selectedId,
  onSelect,
  onHover
}: {
  dimensions: TasteDimension[]
  choices: number
  stageLabel: string
  selectedId: string | null
  onSelect: (id: string) => void
  onHover: (id: string | null) => void
}): React.JSX.Element {
  const placed: Placed[] = useMemo(
    () =>
      dimensions
        .map((dimension) => {
          const axisIndex = Math.max(0, AXIS_ORDER.indexOf(dimension.axis))
          return {
            dimension,
            slot: axisIndex + (dimension.pole === 'a' ? 0 : AXIS_ORDER.length),
            colour: AXIS_COLOUR[dimension.axis] ?? '#e7c67b'
          }
        })
        .sort((x, y) => x.slot - y.slot),
    [dimensions]
  )
  const values = useAnimatedValues(placed.map((entry) => petalValue(entry.dimension.lean)))
  const neutral = INNER + (OUTER - INNER) * 0.5

  return (
    <svg
      className="taste-compass"
      viewBox={`0 0 ${SIZE.width} ${SIZE.height}`}
      role="group"
      aria-label="Taste Compass: how strongly your choices lean towards each aesthetic quality"
    >
      {/* Rings: the inner edge, the neutral line, and the outer limit. */}
      <circle cx={CENTER.x} cy={CENTER.y} r={OUTER} className="taste-compass__ring" />
      <circle cx={CENTER.x} cy={CENTER.y} r={INNER} className="taste-compass__ring" />
      <circle cx={CENTER.x} cy={CENTER.y} r={neutral} className="taste-compass__neutral" />

      {placed.map((entry, index) => {
        const { dimension, slot, colour } = entry
        const start = -90 + slot * SLOT + 1.6 - SLOT / 2
        const end = start + SLOT - 3.2
        const radius = INNER + (OUTER - INNER) * (values[index] ?? 0.5)
        const mid = (start + end) / 2
        const label = polar(OUTER + 18, mid)
        const cos = Math.cos((mid * Math.PI) / 180)
        const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle'
        const selected = selectedId === dimension.id
        const strong = dimension.certain
        return (
          <g
            key={dimension.id}
            className={`taste-petal ${selected ? 'is-selected' : ''} ${strong ? 'is-certain' : 'is-uncertain'}`}
            tabIndex={0}
            role="button"
            aria-pressed={selected}
            aria-label={`${dimension.label}: ${strong ? 'your choices lean ' + (dimension.lean >= 0 ? 'towards' : 'away from') + ' this' : 'not enough evidence yet'}`}
            onClick={() => onSelect(dimension.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(dimension.id)
              }
            }}
            onMouseEnter={() => onHover(dimension.id)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(dimension.id)}
            onBlur={() => onHover(null)}
          >
            {/* A faint full-length track so every petal can be targeted, even a short one. */}
            <path d={sectorPath(start, end, OUTER)} className="taste-petal__track" />
            <path
              d={sectorPath(start, end, radius)}
              className="taste-petal__shape"
              style={{ fill: colour, stroke: colour }}
            />
            <text x={label.x} y={label.y} textAnchor={anchor} dominantBaseline="middle" className="taste-petal__label">
              {dimension.label.split(' & ').map((part, i, parts) => (
                <tspan key={part} x={label.x} dy={i === 0 ? (parts.length > 1 ? '-0.55em' : '0') : '1.15em'}>
                  {i < parts.length - 1 ? `${part} &` : part}
                </tspan>
              ))}
            </text>
          </g>
        )
      })}

      <text x={CENTER.x} y={CENTER.y - 6} textAnchor="middle" className="taste-compass__count">
        {choices}
      </text>
      <text x={CENTER.x} y={CENTER.y + 16} textAnchor="middle" className="taste-compass__caption">
        {choices === 1 ? 'choice' : 'choices'}
      </text>
      <text x={CENTER.x} y={CENTER.y + 31} textAnchor="middle" className="taste-compass__stage">
        {stageLabel}
      </text>
    </svg>
  )
}
