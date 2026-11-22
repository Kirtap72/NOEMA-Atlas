import { useCallback, useEffect, useState } from 'react'
import type { Journey, ReferenceInfo } from '@shared/types'
import { Icon } from '../components/Icon'
import { EmptyState, Modal } from '../components/ui'
import { ExploreTab } from '../components/discovery/ExploreTab'
import { IdentityTab } from '../components/discovery/IdentityTab'
import { CompareTab } from '../components/discovery/CompareTab'
import { JourneysTab } from '../components/discovery/JourneysTab'
import { HistoryTab } from '../components/discovery/HistoryTab'
import { useLoaded } from '../components/discovery/shared'

type Tab = 'explore' | 'identity' | 'compare' | 'journeys' | 'history'

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'explore', label: 'Explore', hint: 'Compare works, discover what you enjoy' },
  { id: 'identity', label: 'My identity', hint: 'What your favorites have in common' },
  { id: 'compare', label: 'Compare', hint: 'Where the two profiles meet' },
  { id: 'journeys', label: 'Journeys', hint: 'Personal exhibitions' },
  { id: 'history', label: 'History', hint: 'How your taste has changed' }
]

function Credits({ info, open, onClose }: { info: ReferenceInfo; open: boolean; onClose: () => void }): React.JSX.Element {
  return (
    <Modal open={open} onClose={onClose} className="modal-panel--ai" labelledBy="credits-title">
      <div className="modal__kicker">ABOUT THE COLLECTION</div>
      <h2 id="credits-title" className="modal__title">{info.name}</h2>
      <div className="modal__copy">
        <p>
          {info.works} artworks that every Atlas user sees, whatever is on their own computer, kept on this computer so discovery works offline.
          Each work is published by its museum as public domain or CC0, and its details and museum page are shown next to it.
        </p>
        <ul className="ai-facts">
          {info.museums.map((m) => (
            <li key={m.code}><Icon name="archive" size={15} /> <span>{m.name}: {m.works} works. <a href={m.policy} target="_blank" rel="noreferrer">Open-access policy</a></span></li>
          ))}
          <li><Icon name="shield" size={15} /> <span>License: <a href={info.license.url} target="_blank" rel="noreferrer">{info.license.name}</a>. Atlas is not affiliated with these museums.</span></li>
        </ul>
        <p className="hint">Images are small web copies for browsing. A museum's own page is authoritative for each work.</p>
      </div>
      <div className="modal__actions"><button type="button" className="button button--gold" onClick={onClose}>Close</button></div>
    </Modal>
  )
}

/** The Taste room: two independent profiles (my identity, my discovered taste), their comparison, journeys and history. */
export function TasteHubPage({ onClassic }: { onClassic: () => void }): React.JSX.Element {
  const info = useLoaded<ReferenceInfo>(() => window.noema.getReferenceInfo(), [])
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = localStorage.getItem('atlas.tasteTab') as Tab | null
      return saved && TABS.some((t) => t.id === saved) ? saved : 'explore'
    } catch {
      return 'explore'
    }
  })
  const [start, setStart] = useState<{ kind: Journey['seed']['kind']; ref?: number | string; label: string } | null>(null)
  const [credits, setCredits] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem('atlas.tasteTab', tab)
    } catch {
      // A convenience only.
    }
  }, [tab])

  const beginJourney = useCallback((kind: Journey['seed']['kind'], ref: number | string, label: string) => {
    setStart({ kind, ref, label })
    setTab('journeys')
  }, [])

  if (info.data && !info.data.available) {
    return (
      <div className="page page--taste">
        <header className="page-head"><div className="page-head__copy"><div className="eyebrow">TASTE</div><h1 className="page-title">Taste</h1></div></header>
        <EmptyState icon="archive" title="The Atlas Reference Collection is missing." copy="This copy of Atlas does not include its reference collection of public-domain artworks, so discovery is unavailable. Reinstalling Atlas restores it." />
        <p><button type="button" className="link-button" onClick={onClassic}>Compare images from your own library instead</button></p>
      </div>
    )
  }

  return (
    <div className="page page--taste page--discovery">
      <header className="page-head">
        <div className="page-head__copy">
          <div className="eyebrow">TASTE · THE ARTISTIC DISCOVERY ENGINE</div>
          <h1 className="page-title">Taste</h1>
          <p className="page-subtitle">
            Two independent profiles, side by side: what your favorites reveal, and what you discover by exploring art from many traditions.
            Atlas only follows your own choices, and it never judges your images.
          </p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="button button--ghost" onClick={() => setCredits(true)}><Icon name="info" size={16} /> About the collection</button>
        </div>
      </header>

      <nav className="taste-tabs" role="tablist" aria-label="Taste">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`taste-tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => { setStart(null); setTab(t.id) }} title={t.hint}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="taste-tabpanel" role="tabpanel">
        {tab === 'explore' ? <ExploreTab onJourney={() => setTab('journeys')} /> : null}
        {tab === 'identity' ? <IdentityTab onJourney={(kind, ref, label) => beginJourney(kind, ref, label)} /> : null}
        {tab === 'compare' ? <CompareTab onJourney={(kind, ref, label) => beginJourney(kind, ref, label)} /> : null}
        {tab === 'journeys' ? <JourneysTab start={start} /> : null}
        {tab === 'history' ? <HistoryTab /> : null}
      </div>

      <footer className="taste-foot">
        <button type="button" className="link-button" onClick={onClassic}>Compare images from my own library (classic Taste Compass)</button>
      </footer>
      {info.data ? <Credits info={info.data} open={credits} onClose={() => setCredits(false)} /> : null}
    </div>
  )
}
