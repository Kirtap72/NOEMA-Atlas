export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exp
  const precision = value >= 100 || exp === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${units[exp]}`
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard' }).format(value)
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en').format(value)
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }).format(new Date(timestamp))
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return 'never'
  const diff = timestamp - Date.now()
  const abs = Math.abs(diff)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000]
  ]
  for (const [unit, ms] of units) {
    if (abs >= ms) return formatter.format(Math.round(diff / ms), unit)
  }
  return 'just now'
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralForm}`
}

export function truncateMiddle(value: string, max = 64): string {
  if (value.length <= max) return value
  const part = Math.floor((max - 1) / 2)
  return `${value.slice(0, part)}…${value.slice(-part)}`
}

export function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

export function basenameOfPath(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? value
}

export function dimensions(width: number, height: number): string {
  if (!width || !height) return 'Unknown size'
  return `${width.toLocaleString()} × ${height.toLocaleString()}`
}
