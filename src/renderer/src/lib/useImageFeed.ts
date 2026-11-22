import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageItem, ImageQuery } from '@shared/types'
import { friendlyError } from './format'

interface ImageFeed {
  items: ImageItem[]
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => Promise<void>
  refresh: (replace?: boolean) => Promise<void>
  replaceItem: (item: ImageItem) => void
  removeItem: (id: string) => void
}

const PAGE_SIZE = 90

export function useImageFeed(query: ImageQuery, enabled = true): ImageFeed {
  const queryKey = JSON.stringify(query)
  const queryRef = useRef(query)
  queryRef.current = query
  const [items, setItems] = useState<ImageItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(enabled)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const itemsRef = useRef<ImageItem[]>([])
  const totalRef = useRef(0)
  const loadingRef = useRef(false)
  const sequence = useRef(0)
  const loadedKey = useRef('')
  itemsRef.current = items
  totalRef.current = total

  const fetchPage = useCallback(async (offset: number, replace: boolean): Promise<void> => {
    const request = ++sequence.current
    if (replace) {
      setLoading(true)
      loadingRef.current = true
    } else {
      if (loadingRef.current || itemsRef.current.length >= totalRef.current) return
      setLoadingMore(true)
      loadingRef.current = true
    }
    setError(null)
    try {
      const page = await window.noema.listImages({
        ...queryRef.current,
        offset,
        limit: PAGE_SIZE
      })
      if (request !== sequence.current) return
      setTotal(page.total)
      totalRef.current = page.total
      if (replace) {
        setItems(page.items)
        itemsRef.current = page.items
      } else {
        setItems((current) => {
          const seen = new Set(current.map((item) => item.id))
          const merged = [...current, ...page.items.filter((item) => !seen.has(item.id))]
          itemsRef.current = merged
          return merged
        })
      }
    } catch (feedError) {
      if (request === sequence.current) setError(friendlyError(feedError))
    } finally {
      if (request === sequence.current) {
        setLoading(false)
        setLoadingMore(false)
        loadingRef.current = false
      }
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    if (loadedKey.current === queryKey) return
    loadedKey.current = queryKey
    setItems([])
    itemsRef.current = []
    setTotal(0)
    totalRef.current = 0
    void fetchPage(0, true)
  }, [enabled, fetchPage, queryKey])

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current) return
    if (itemsRef.current.length >= totalRef.current) return
    await fetchPage(itemsRef.current.length, false)
  }, [fetchPage])

  const refresh = useCallback(
    async (replace = true): Promise<void> => {
      await fetchPage(0, replace)
    },
    [fetchPage]
  )

  const replaceItem = useCallback((item: ImageItem) => {
    setItems((current) => {
      const next = current.map((entry) => (entry.id === item.id ? item : entry))
      itemsRef.current = next
      return next
    })
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems((current) => {
      const next = current.filter((entry) => entry.id !== id)
      itemsRef.current = next
      return next
    })
    setTotal((current) => Math.max(0, current - 1))
    totalRef.current = Math.max(0, totalRef.current - 1)
  }, [])

  return {
    items,
    total,
    loading,
    loadingMore,
    error,
    hasMore: items.length < total,
    loadMore,
    refresh,
    replaceItem,
    removeItem
  }
}

export function useDebouncedValue<T>(value: T, delay = 180): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export function useInfiniteScroll(
  sentinelRef: React.RefObject<HTMLElement | null>,
  onIntersect: () => void,
  enabled: boolean
): void {
  const callback = useRef(onIntersect)
  callback.current = onIntersect
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !enabled) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current()
      },
      { rootMargin: '800px 0px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, sentinelRef])
}
