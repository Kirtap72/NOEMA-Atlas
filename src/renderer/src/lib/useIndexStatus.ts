import { useEffect, useState } from 'react'
import type { IndexStatus } from '@shared/types'

/** Live status of the local image index (visual search). `null` until the first reply. */
export function useIndexStatus(): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.noema.getIndexStatus().then((next) => {
      if (alive) setStatus(next)
    })
    const off = window.noema.onIndexStatus((next) => setStatus(next))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}
