// Which picture the user has open in a viewer right now (the full-screen viewer, the Studio's large viewer, the Retouch workspace),
// so the Companion can be opened from there and know what "this picture" means. Only the picture's id and name are shared inside
// the application; its pixels never leave this computer through this.

export interface Viewing {
  imageId: string
  filename: string
}

let current: Viewing | null = null
const listeners = new Set<() => void>()

/** The name of the event that opens (or closes) the Companion from anywhere. */
export const COMPANION_TOGGLE_EVENT = 'atlas:open-companion'

export function getViewing(): Viewing | null {
  return current
}

export function setViewing(next: Viewing | null): void {
  if (current?.imageId === next?.imageId && current?.filename === next?.filename) return
  current = next
  for (const listener of listeners) listener()
}

/** Clears the picture only if it is still the one this viewer set (another viewer may have opened in front since). */
export function clearViewing(imageId: string): void {
  if (current?.imageId === imageId) setViewing(null)
}

export function onViewing(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
