import type { SVGProps } from 'react'

export type IconName =
  | 'collection'
  | 'heart'
  | 'review'
  | 'archive'
  | 'boards'
  | 'sources'
  | 'plus'
  | 'search'
  | 'close'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'chevronDown'
  | 'chevronLeft'
  | 'chevronRight'
  | 'grid'
  | 'rows'
  | 'sparkle'
  | 'arrowLeft'
  | 'arrowRight'
  | 'external'
  | 'trash'
  | 'edit'
  | 'check'
  | 'info'
  | 'shield'
  | 'lock'
  | 'image'
  | 'star'
  | 'sort'
  | 'camera'
  | 'drive'
  | 'clock'
  | 'tag'
  | 'folder'
  | 'eye'
  | 'help'
  | 'more'
  | 'drag'
  | 'refresh'
  | 'stop'
  | 'copy'
  | 'move'
  | 'organize'
  | 'resize'
  | 'fit'
  | 'aspect'

const paths: Record<IconName, React.ReactNode> = {
  collection: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </>
  ),
  heart: <path d="M20.3 6.7a5 5 0 0 0-7.1 0L12 7.9l-1.2-1.2a5 5 0 1 0-7.1 7.1L12 22l8.3-8.2a5 5 0 0 0 0-7.1Z" />,
  review: (
    <>
      <path d="M2.8 12s3.4-6.2 9.2-6.2S21.2 12 21.2 12s-3.4 6.2-9.2 6.2S2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  archive: (
    <>
      <path d="M3 7.5h18v12.2H3z" />
      <path d="M2 3.5h20v4H2zM9.5 11.5h5" />
    </>
  ),
  boards: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="1.6" />
      <path d="M3 9.5h18M8.2 9.5V19" />
    </>
  ),
  sources: (
    <>
      <path d="M3 6.8a1.8 1.8 0 0 1 1.8-1.8h5l2 2.4h7.4A1.8 1.8 0 0 1 21 9.2v8.9a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.1Z" />
      <path d="M3.5 10.5h17" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.7" />
      <path d="m15.7 15.7 4.6 4.6" />
    </>
  ),
  close: <path d="m5.5 5.5 13 13m0-13-13 13" />,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="0.8" />,
  restore: (
    <>
      <path d="M8 8V5h11v11h-3" />
      <rect x="5" y="8" width="11" height="11" rx="0.8" />
    </>
  ),
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronLeft: <path d="m14.5 6-6 6 6 6" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  grid: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="0.7" />
      <rect x="14" y="4" width="6" height="6" rx="0.7" />
      <rect x="4" y="14" width="6" height="6" rx="0.7" />
      <rect x="14" y="14" width="6" height="6" rx="0.7" />
    </>
  ),
  rows: <path d="M4 6.5h16M4 12h16M4 17.5h16" />,
  sparkle: (
    <>
      <path d="M12 2.5c.4 5.4 2.1 7.1 7.5 7.5-5.4.4-7.1 2.1-7.5 7.5-.4-5.4-2.1-7.1-7.5-7.5 5.4-.4 7.1-2.1 7.5-7.5Z" />
      <path d="M18.5 16.5c.2 2.1.9 2.8 3 3-2.1.2-2.8.9-3 3-.2-2.1-.9-2.8-3-3 2.1-.2 2.8-.9 3-3Z" />
    </>
  ),
  arrowLeft: <path d="M20 12H4m6-6-6 6 6 6" />,
  arrowRight: <path d="M4 12h16m-6-6 6 6-6 6" />,
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4.5h6V7m-8.5 0 1 13h9l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  edit: (
    <>
      <path d="M14.7 4.8 19.2 9.3 8.5 20H4v-4.5Z" />
      <path d="m13 6.5 4.5 4.5" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6v.2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 20 6v6c0 4.8-3.4 8-8 9.5C7.4 20 4 16.8 4 12V6Z" />
      <path d="m8.5 12 2.3 2.3 4.7-4.8" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10.5" rx="1.8" />
      <path d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1.6" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m3.5 17 5.4-5 4 3.5 3.2-2.8 4.4 4.3" />
    </>
  ),
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9L3.5 9.7l5.9-.8Z" />,
  sort: <path d="M8 5v14m0 0-3-3m3 3 3-3M16 19V5m0 0-3 3m3-3 3 3" />,
  camera: (
    <>
      <path d="M4 7.5h3l1.5-2h7l1.5 2h3v12H4Z" />
      <circle cx="12" cy="13.2" r="3.4" />
    </>
  ),
  drive: (
    <>
      <rect x="3" y="5" width="18" height="6" rx="1.4" />
      <rect x="3" y="13" width="18" height="6" rx="1.4" />
      <path d="M7 8h.1M7 16h.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  tag: (
    <>
      <path d="M11.8 3.5H21v9.2l-8.8 8.8-9.2-9.2Z" />
      <circle cx="17.4" cy="7.3" r="1.3" />
    </>
  ),
  folder: (
    <>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2.5h8A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12s3.4-6.2 9.2-6.2S21.2 12 21.2 12s-3.4 6.2-9.2 6.2S2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2A2.5 2.5 0 0 1 14.5 10c0 1.8-2.5 1.8-2.5 3.7M12 17.2v.2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  drag: (
    <>
      <circle cx="8" cy="7" r="1" />
      <circle cx="16" cy="7" r="1" />
      <circle cx="8" cy="12" r="1" />
      <circle cx="16" cy="12" r="1" />
      <circle cx="8" cy="17" r="1" />
      <circle cx="16" cy="17" r="1" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0-1.5 5.5" />
      <path d="M20 4.5V11h-6.5" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1.2" />,
  copy: (
    <>
      <rect x="8" y="8" width="11" height="12" rx="1.5" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v10A1.5 1.5 0 0 0 5.5 17H8" />
    </>
  ),
  move: (
    <>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h5l2 2.5h8A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z" />
      <path d="M9.5 13h7m-2.5-2.5L16.5 13 14 15.5" />
    </>
  ),
  organize: (
    <>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h5l2 2.5h8A1.5 1.5 0 0 1 21 10v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z" />
      <path d="M12 10.5v6M9.5 14l2.5 2.5 2.5-2.5" />
    </>
  ),
  resize: (
    <>
      <path d="M9 20H4v-5M20 9V4h-5M4 20l6-6M20 4l-6 6" />
    </>
  ),
  fit: (
    <>
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
      <path d="M4 4l5 5M20 4l-5 5M4 20l5-5M20 20l-5-5" opacity="0.5" />
    </>
  ),
  aspect: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M8 15.5 10.7 10h1.8l2.7 5.5M9.2 13.4h4.8M16.8 8.2h-.1" />
    </>
  )
}

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.5,
  ...rest
}: { name: IconName; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  )
}

export function AtlasMark({ size = 34 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true" className="atlas-mark">
      <circle cx="24" cy="24" r="22.5" stroke="currentColor" strokeOpacity="0.24" />
      <path
        d="M13 37V22.3c0-6.4 4.8-10.3 11-10.3s11 3.9 11 10.3V37"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <circle cx="24" cy="25.8" r="6.2" fill="currentColor" />
      <path d="M9.5 37h29" stroke="currentColor" strokeOpacity="0.6" />
      <path d="M24 3.2v3.6M24 41.2v3.6M3.2 24h3.6M41.2 24h3.6" stroke="currentColor" strokeOpacity="0.45" />
    </svg>
  )
}
