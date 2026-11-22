import { useEffect, useState } from 'react'
import type { ExternalEditSession } from '@shared/studio'

// One shared list of the pictures that are open in other programs. The Studio window, the result window and the small
// status chip all read it, so an edit that comes back is seen everywhere, even after the Studio window has been closed.

let sessions: ExternalEditSession[] = []
const listeners = new Set<() => void>()
let started = false

function emit(): void {
  for (const l of listeners) l()
}

export function upsertSession(session: ExternalEditSession): void {
  const index = sessions.findIndex((s) => s.id === session.id)
  sessions = index < 0 ? [...sessions, session] : sessions.map((s) => (s.id === session.id ? session : s))
  emit()
}

export function removeSession(id: string): void {
  sessions = sessions.filter((s) => s.id !== id)
  emit()
}

function start(): void {
  if (started) return
  started = true
  void window.noema.studioExternalSessions().then((list) => list.forEach(upsertSession)).catch(() => undefined)
  window.noema.onStudioExternal(upsertSession)
  window.noema.onStudioExternalEnded(({ id }) => removeSession(id))
}

/** The sessions that are open now, kept up to date. */
export function useExternalSessions(): ExternalEditSession[] {
  const [, setTick] = useState(0)
  useEffect(() => {
    start()
    const l = (): void => setTick((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return sessions
}

export const OPEN_EXTERNAL_RESULT_EVENT = 'atlas:external-result'

/** Shows the result window for a session (the newest version unless one is given). */
export function showExternalResult(sessionId: string, index?: number): void {
  window.dispatchEvent(new CustomEvent(OPEN_EXTERNAL_RESULT_EVENT, { detail: { sessionId, index } }))
}
