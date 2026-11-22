import { useCallback, useEffect, useRef, useState } from 'react'
import { AtlasProvider, useAtlas } from './lib/useAtlas'
import { ImageDragProvider, DragTray } from './lib/useImageDrag'
import { Sidebar, Topbar } from './components/Chrome'
import { HelpModal, ToastHost } from './components/ui'
import { FileOrganizer } from './components/FileOrganizer'
import { AtlasMark, Icon } from './components/Icon'
import { parseRoute, routeHash, type Route } from './lib/routing'
import { LibraryPage } from './pages/Library'
import { ArchivePage } from './pages/Archive'
import { FamiliesPage } from './pages/Families'
import { SmartCollectionsPage } from './pages/SmartCollections'
import { TastePage } from './pages/Taste'
import { TasteHubPage } from './pages/TasteHub'
import { AiSetupDialog, OPEN_AI_SETUP_EVENT, useModelStatus } from './components/AiSetup'
import { ReviewPage } from './pages/Review'
import { MoodboardPage, MoodboardsPage } from './pages/Moodboards'
import { SourcesPage } from './pages/Sources'
import { OrganizerPage } from './pages/Organizer'
import { Companion, OPEN_COMPANION_EVENT } from './components/Companion'
import { StudioHost } from './components/Studio'
import { ModelLibraryHost } from './components/ModelLibrary'
import { ViewerHost } from './components/StudioViewer'

export default function App(): React.JSX.Element {
  return (
    <AtlasProvider>
      <ImageDragProvider>
        <Shell />
      </ImageDragProvider>
    </AtlasProvider>
  )
}

function Shell(): React.JSX.Element {
  const atlas = useAtlas()
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  const [helpOpen, setHelpOpen] = useState(false)
  const [organizerOpen, setOrganizerOpen] = useState(false)
  const [aiDialogOpen, setAiDialogOpen] = useState(false)
  const modelStatus = useModelStatus()
  const aiPromptShown = useRef(false)

  // Atlas asks once, after the user has started using it, whether to set up the optional AI model.
  // Nothing is downloaded until they say yes.
  useEffect(() => {
    if (aiPromptShown.current || !modelStatus || modelStatus.choice !== 'unset' || modelStatus.installed) return
    if (atlas.stats.roots === 0) return
    let asked = false
    try {
      asked = localStorage.getItem('atlas.aiPromptShown') === '1'
    } catch {
      // Storage may be unavailable; asking again is harmless.
    }
    aiPromptShown.current = true
    if (asked) return
    try {
      localStorage.setItem('atlas.aiPromptShown', '1')
    } catch {
      // Ignore.
    }
    setAiDialogOpen(true)
  }, [modelStatus, atlas.stats.roots])

  useEffect(() => {
    const open = (): void => setAiDialogOpen(true)
    window.addEventListener(OPEN_AI_SETUP_EVENT, open)
    return () => window.removeEventListener(OPEN_AI_SETUP_EVENT, open)
  }, [])
  const scrollRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!window.location.hash) {
      window.location.hash = routeHash({ name: 'collection' })
    }
    const onHash = (): void => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback(
    (next: Route) => {
      const hash = routeHash(next)
      if (window.location.hash !== hash) window.location.hash = hash
      else setRoute(next)
    },
    []
  )

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'instant' })
    document.documentElement.dataset.room = route.name
  }, [route])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      // The Companion can be called from anywhere, including over the full-screen picture viewer and the Studio.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        window.dispatchEvent(new Event(OPEN_COMPANION_EVENT))
        return
      }
      if (document.querySelector('[role="dialog"]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (route.name !== 'archive') navigate({ name: 'archive' })
        window.setTimeout(() => window.dispatchEvent(new Event('atlas:focus-archive')), 120)
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        event.preventDefault()
        window.dispatchEvent(new Event(OPEN_COMPANION_EVENT))
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void atlas.chooseFolders()
        return
      }
      if (!typing && event.key === '?' && !document.querySelector('[role="dialog"]')) {
        event.preventDefault()
        setHelpOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [atlas, navigate, route.name])

  useEffect(() => {
    const roomNames: Record<string, string> = {
      collection: 'Collection',
      recent: 'Recently added',
      favorites: 'Favorites',
      review: 'Review Room',
      archive: 'Archive',
      families: 'Families',
      smart: 'Smart Collections',
      taste: 'Taste',
      'taste-classic': 'Taste (classic)',
      moodboards: 'Moodboards',
      moodboard: 'Moodboard',
      sources: 'Sources',
      organizer: 'Smart Organizer'
    }
    document.title = `NOEMA Atlas — ${roomNames[route.name] ?? 'Library'}`
  }, [route.name])

  if (atlas.loading && !atlas.bootstrap) {
    return <BootScreen />
  }

  if (atlas.error && !atlas.bootstrap) {
    return (
      <div className="fatal">
        <AtlasMark size={42} />
        <div className="eyebrow">ATLAS COULD NOT OPEN</div>
        <h1>The library is out of reach.</h1>
        <p>{atlas.error}</p>
        <button type="button" className="button button--gold" onClick={() => void atlas.refresh()}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        images={atlas.stats.images}
        favorites={atlas.stats.favorites}
        unreviewed={atlas.stats.unreviewed}
        moodboards={atlas.moodboards}
        roots={atlas.roots}
        totalBytes={atlas.stats.totalBytes}
        scan={atlas.scan}
        onNavigate={navigate}
        onAddFolder={() => void atlas.chooseFolders()}
        onCancelScan={() => void atlas.cancelScan()}
      />
      <div className="workspace">
        <Topbar
          route={route}
          scan={atlas.scan}
          onHelp={() => setHelpOpen(true)}
          onOpenSources={() => navigate({ name: 'sources' })}
        />
        <main className="main-scroll" ref={scrollRef}>
          <div className="main-inner">
            {route.name === 'collection' ? (
              <LibraryPage
                mode="collection"
                onNavigateReview={() => navigate({ name: 'review' })}
                onNavigateSources={() => navigate({ name: 'sources' })}
                onFileImages={() => setOrganizerOpen(true)}
              />
            ) : route.name === 'recent' ? (
              <LibraryPage
                mode="recent"
                onNavigateReview={() => navigate({ name: 'review' })}
                onNavigateSources={() => navigate({ name: 'sources' })}
                onFileImages={() => setOrganizerOpen(true)}
              />
            ) : route.name === 'favorites' ? (
              <LibraryPage
                mode="favorites"
                onNavigateReview={() => navigate({ name: 'review' })}
                onNavigateSources={() => navigate({ name: 'sources' })}
                onFileImages={() => setOrganizerOpen(true)}
              />
            ) : route.name === 'archive' ? (
              <ArchivePage onFileImages={() => setOrganizerOpen(true)} />
            ) : route.name === 'taste' ? (
              <TasteHubPage onClassic={() => navigate({ name: 'taste-classic' })} />
            ) : route.name === 'taste-classic' ? (
              <TastePage />
            ) : route.name === 'families' ? (
              <FamiliesPage />
            ) : route.name === 'smart' ? (
              <SmartCollectionsPage />
            ) : route.name === 'review' ? (
              <ReviewPage
                onNavigateCollection={() => navigate({ name: 'collection' })}
                onNavigateFavorites={() => navigate({ name: 'favorites' })}
              />
            ) : route.name === 'moodboards' ? (
              <MoodboardsPage onNavigate={navigate} />
            ) : route.name === 'moodboard' && route.boardId ? (
              <MoodboardPage boardId={route.boardId} onNavigate={navigate} />
            ) : route.name === 'organizer' ? (
              <OrganizerPage initialPlanId={route.planId} />
            ) : (
              <SourcesPage />
            )}
          </div>
          <footer className="app-footer">
            <span className="app-footer__mark"><AtlasMark size={17} /></span>
            <span>NOEMA Atlas · a private room for looking</span>
            <span className="app-footer__spacer" />
            <span>Local SQLite · WebP previews · originals never rewritten</span>
          </footer>
        </main>
      </div>

      <ToastHost />
      <Companion />
      <StudioHost />
      <ModelLibraryHost />
      <ViewerHost />
      <DragTray />
      <FileOrganizer open={organizerOpen} onClose={() => setOrganizerOpen(false)} />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <AiSetupDialog open={aiDialogOpen} onClose={() => setAiDialogOpen(false)} />
    </div>
  )
}

function BootScreen(): React.JSX.Element {
  return (
    <div className="boot-screen">
      <div className="boot-screen__mark">
        <AtlasMark size={62} />
      </div>
      <div className="boot-screen__word">
        <strong>NOEMA</strong>
        <span>ATLAS</span>
      </div>
      <div className="boot-screen__line"><span /></div>
      <div className="boot-screen__note">
        <Icon name="lock" size={13} /> Opening the local catalogue
      </div>
    </div>
  )
}
