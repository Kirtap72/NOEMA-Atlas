import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type {
  Bootstrap,
  FolderAddResult,
  ImageItem,
  LibraryStats,
  Moodboard,
  RootFolder,
  ScanState
} from '@shared/types'
import { friendlyError } from './format'

export interface ToastMessage {
  id: number
  message: string
  tone: 'info' | 'success' | 'error'
  /** A button on the message, for the obvious next step. */
  action?: { label: string; run: () => void }
}

interface AtlasContextValue {
  bootstrap: Bootstrap | null
  stats: LibraryStats
  roots: RootFolder[]
  moodboards: Moodboard[]
  scan: ScanState | null
  loading: boolean
  error: string | null
  toasts: ToastMessage[]
  refresh: () => Promise<void>
  chooseFolders: () => Promise<FolderAddResult | null>
  /** Adds folders by path and tells the user what happened. */
  addFolders: (paths: string[]) => Promise<FolderAddResult | null>
  rescanRoot: (rootId: string) => Promise<void>
  cancelScan: () => Promise<void>
  removeRoot: (rootId: string) => Promise<void>
  createMoodboard: (name: string) => Promise<Moodboard | null>
  renameMoodboard: (id: string, name: string) => Promise<Moodboard | null>
  deleteMoodboard: (id: string) => Promise<void>
  updateImage: (input: Parameters<typeof window.noema.updateImage>[0]) => Promise<ImageItem | null>
  toast: (message: string, tone?: ToastMessage['tone'], durationMs?: number, action?: ToastMessage['action']) => void
  dismissToast: (id: number) => void
}

const EMPTY_STATS: LibraryStats = {
  images: 0,
  favorites: 0,
  unreviewed: 0,
  missing: 0,
  roots: 0,
  moodboards: 0,
  totalBytes: 0
}

const AtlasContext = createContext<AtlasContextValue | null>(null)

export function AtlasProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scan, setScan] = useState<ScanState | null>(null)
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const bootstrapRef = useRef<Bootstrap | null>(null)
  const toastCounter = useRef(0)
  const toastTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback((message: string, tone: ToastMessage['tone'] = 'info', durationMs?: number, action?: ToastMessage['action']) => {
    const id = ++toastCounter.current
    setToasts((current) => [...current.slice(-4), { id, message, tone, ...(action ? { action } : {}) }])
    const timer = setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id))
      toastTimers.current.delete(id)
    }, durationMs ?? (tone === 'error' ? 9000 : 4800))
    toastTimers.current.set(id, timer)
  }, [])

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id)
    if (timer) clearTimeout(timer)
    toastTimers.current.delete(id)
    setToasts((current) => current.filter((entry) => entry.id !== id))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await window.noema.bootstrap()
      setBootstrap(next)
      bootstrapRef.current = next
      setScan(next.scan)
      setError(null)
    } catch (refreshError) {
      setError(friendlyError(refreshError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Folders the user just added: when their scan ends, say what was found. */
  const awaiting = useRef<Map<string, { rootName: string; why: 'added' | 'existing' | 'covered' }>>(new Map())

  const summarize = useCallback(
    (state: ScanState) => {
      const note = awaiting.current.get(state.rootId)
      if (!note) return
      if (!['done', 'error', 'cancelled'].includes(state.phase)) return
      awaiting.current.delete(state.rootId)
      const name = `“${note.rootName}”`
      const images = (n: number): string => `${n} image${n === 1 ? '' : 's'}`
      if (state.phase === 'error') {
        toast(`Atlas could not read ${name}: ${state.message ?? 'the scan failed'}.`, 'error')
      } else if (state.phase === 'cancelled') {
        toast(`The scan of ${name} was stopped. What was found so far is kept; choose Check again on Sources to continue.`, 'info')
      } else if (state.discovered === 0) {
        toast(
          `${name} is added, but Atlas found no images in it yet. It reads PNG, JPEG, WebP, GIF, BMP, TIFF and AVIF files, including those in subfolders. Add pictures to the folder and use Check again on Sources.`,
          'info',
          11000
        )
      } else if (state.added > 0) {
        toast(
          `Imported ${images(state.added)} from ${name}.${state.errors > 0 ? ` ${state.errors} file${state.errors === 1 ? '' : 's'} could not be read.` : ''}`,
          state.errors > 0 ? 'info' : 'success',
          14000,
          { label: 'View newly added pictures', run: () => { window.location.hash = '#/recent' } }
        )
      } else if (state.errors > 0 && state.skipped === 0 && state.updated === 0) {
        toast(`Atlas found ${images(state.discovered)} files in ${name}, but none could be read. ${state.message ?? ''}`.trim(), 'error')
      } else if (note.why !== 'existing') {
        toast(`${name} is up to date: ${images(state.skipped + state.updated)} already in Atlas.`, 'info')
      }
    },
    [toast]
  )

  useEffect(() => {
    const unsubscribeScan = window.noema.onScan((event) => {
      setScan(event.state)
      summarize(event.state)
      if (event.state.phase === 'done' || event.state.phase === 'error') {
        setTimeout(() => void refresh(), 220)
      }
    })
    const unsubscribeLibrary = window.noema.onLibraryChanged(() => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => void refresh(), 140)
    })
    return () => {
      unsubscribeScan()
      unsubscribeLibrary()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      for (const timer of toastTimers.current.values()) clearTimeout(timer)
    }
  }, [refresh, summarize])

  /** Says plainly what became of every folder the user offered: added, already there, inside another source, or refused and why. */
  const announce = useCallback(
    (result: FolderAddResult): void => {
      for (const entry of result.scanning ?? []) awaiting.current.set(entry.rootId, { rootName: entry.rootName, why: entry.why })
      const nameOf = (path: string): string => result.roots.find((root) => root.path.toLowerCase() === path.toLowerCase())?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path
      if (result.canceled) {
        toast('No folder was chosen, so nothing was added.', 'info')
        return
      }
      if (result.added.length === 1) toast(`Added “${nameOf(result.added[0]!)}” as a source. Looking through it for images now.`, 'success')
      else if (result.added.length > 1) toast(`Added ${result.added.length} folders as sources. Looking through them for images now.`, 'success')
      for (const entry of result.covered ?? []) {
        toast(
          `“${nameOf(entry.path)}” is inside your source “${entry.rootName}”, so it is already part of Atlas and does not need to be added again. Checking “${entry.rootName}” for new images now.`,
          'info',
          9000
        )
      }
      if (result.existing.length > 0 && result.added.length === 0 && (result.covered ?? []).length === 0 && result.rejected.length === 0) {
        toast(`“${nameOf(result.existing[0]!)}” is already a source. Checking it for new images.`, 'info')
      }
      for (const rejection of result.rejected.slice(0, 3)) {
        toast(`“${rejection.path.split(/[\\/]/).filter(Boolean).pop() ?? rejection.path}” was not added. ${rejection.reason}`, 'error', 12000)
      }
    },
    [toast]
  )

  const chooseFolders = useCallback(async (): Promise<FolderAddResult | null> => {
    try {
      const result = await window.noema.chooseFolders()
      announce(result)
      await refresh()
      return result
    } catch (folderError) {
      toast(`The folder could not be added. ${friendlyError(folderError)}`, 'error', 12000)
      return null
    }
  }, [refresh, toast, announce])

  const addFolders = useCallback(
    async (paths: string[]): Promise<FolderAddResult | null> => {
      try {
        const result = await window.noema.addFolders(paths)
        announce(result)
        await refresh()
        return result
      } catch (folderError) {
        toast(`The folder could not be added. ${friendlyError(folderError)}`, 'error', 12000)
        return null
      }
    },
    [refresh, toast, announce]
  )

  const rescanRoot = useCallback(
    async (rootId: string) => {
      try {
        await window.noema.rescanRoot(rootId)
        toast('Checking that source for new images.', 'info')
        const root = bootstrapRef.current?.roots.find((entry) => entry.id === rootId)
        if (root) awaiting.current.set(rootId, { rootName: root.name, why: 'existing' })
        await refresh()
      } catch (rescanError) {
        toast(friendlyError(rescanError), 'error')
      }
    },
    [refresh, toast]
  )

  const cancelScan = useCallback(async () => {
    try {
      await window.noema.cancelScan()
    } catch (cancelError) {
      toast(friendlyError(cancelError), 'error')
    }
  }, [toast])

  const removeRoot = useCallback(
    async (rootId: string) => {
      try {
        await window.noema.removeRoot(rootId)
        toast('Source removed. Your original folder was not changed.', 'success')
        await refresh()
      } catch (removeError) {
        toast(friendlyError(removeError), 'error')
      }
    },
    [refresh, toast]
  )

  const createMoodboard = useCallback(
    async (name: string): Promise<Moodboard | null> => {
      try {
        const board = await window.noema.createMoodboard(name)
        await refresh()
        return board
      } catch (createError) {
        toast(friendlyError(createError), 'error')
        return null
      }
    },
    [refresh, toast]
  )

  const renameMoodboard = useCallback(
    async (id: string, name: string): Promise<Moodboard | null> => {
      try {
        const board = await window.noema.renameMoodboard(id, name)
        await refresh()
        return board
      } catch (renameError) {
        toast(friendlyError(renameError), 'error')
        return null
      }
    },
    [refresh, toast]
  )

  const deleteMoodboard = useCallback(
    async (id: string) => {
      try {
        await window.noema.deleteMoodboard(id)
        toast('Moodboard deleted. The images remain untouched.', 'success')
        await refresh()
      } catch (deleteError) {
        toast(friendlyError(deleteError), 'error')
      }
    },
    [refresh, toast]
  )

  const updateImage = useCallback(
    async (input: Parameters<typeof window.noema.updateImage>[0]): Promise<ImageItem | null> => {
      try {
        return await window.noema.updateImage(input)
      } catch (updateError) {
        toast(friendlyError(updateError), 'error')
        return null
      }
    },
    [toast]
  )

  const value: AtlasContextValue = {
    bootstrap,
    stats: bootstrap?.stats ?? EMPTY_STATS,
    roots: bootstrap?.roots ?? [],
    moodboards: bootstrap?.moodboards ?? [],
    scan,
    loading,
    error,
    toasts,
    refresh,
    chooseFolders,
    addFolders,
    rescanRoot,
    cancelScan,
    removeRoot,
    createMoodboard,
    renameMoodboard,
    deleteMoodboard,
    updateImage,
    toast,
    dismissToast
  }

  return <AtlasContext.Provider value={value}>{children}</AtlasContext.Provider>
}

export function useAtlas(): AtlasContextValue {
  const context = useContext(AtlasContext)
  if (!context) throw new Error('useAtlas must be used inside AtlasProvider')
  return context
}
