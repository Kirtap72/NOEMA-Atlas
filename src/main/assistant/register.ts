import { join } from 'node:path'
import { ipcMain, safeStorage } from 'electron'
import type { AtlasDatabase } from '../db'
import type { Embedder } from '../embedder'
import type { IdentityEngine } from '../identity'
import type { JourneyEngine } from '../journeys'
import type { ReferenceCollection } from '../reference'
import type { SemanticSearch } from '../semantic'
import type { TasteEngine } from '../tasteEngine'
import { loadVocabulary } from '../families'
import type { AssistantSettingsUpdate } from '../../shared/assistant'
import { AssistantEngine } from './engine'
import { detectLocalServers, type FetchLike } from './providers'
import { AssistantSettingsStore, type SecretBox } from './settings'
import type { AssistantContext, StudioAssistantApi } from './tools'
import { BoardEditor } from '../studio/boardEdit'
import { CurationService } from '../curationService'
import type { SmartCollections } from '../smartCollections'
import { normalizeCriteria } from '../../shared/smart'
import type { CompanionView } from '../../shared/curation'

export interface AssistantWiring {
  dataDir: string
  db: () => AtlasDatabase
  semantic: () => SemanticSearch | null
  reference: () => ReferenceCollection | null
  identity: () => IdentityEngine | null
  taste: () => TasteEngine | null
  journeys: () => JourneyEngine | null
  /** True when the image model is installed and switched on. */
  aiOn: () => boolean
  embedder: () => Promise<Embedder>
  embeddedCount: () => number
  broadcast: (channel: string, payload?: unknown) => void
  notifyChanged: () => void
  smart?: () => SmartCollections | null
  thumbnailsDir?: string
  /** What the Creative Studio can create, edit and upscale right now. */
  capabilities?: () => Promise<import('../../shared/ai').Capability[]>
  /** The Creative Studio, for multi-step editing plans and version history. */
  studio?: () => import('../studio/studio').Studio | null
  /** The Smart Organizer's engine. */
  organizer?: () => import('../organizer/engine').OrganizerEngine | null
}

/** The operating system's key store, through Electron. Keys are never written in plain text. */
const osSecretBox: SecretBox = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  },
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data)
}

const netFetch: FetchLike = (url, init) => fetch(url, init as RequestInit)

export function registerAssistant(wiring: AssistantWiring): AssistantEngine {
  const dir = join(wiring.dataDir, 'assistant')
  const settings = new AssistantSettingsStore(dir, osSecretBox)

  const curation = new CurationService({
    db: wiring.db,
    semantic: wiring.semantic,
    embedder: wiring.embedder,
    reference: wiring.reference,
    smart: () => wiring.smart?.() ?? null,
    identity: wiring.identity,
    taste: wiring.taste,
    thumbnailsDir: wiring.thumbnailsDir ?? join(wiring.dataDir, 'thumbnails')
  })

  const ctx: AssistantContext = {
    get smart() {
      return wiring.smart?.() ?? null
    },
    curation,
    view: () => curation.view,
    get db() {
      return wiring.db()
    },
    get semantic() {
      return wiring.semantic()
    },
    searchable: () => wiring.aiOn() && wiring.embeddedCount() > 0,
    get reference() {
      return wiring.reference()
    },
    identity: async () => (wiring.identity() ? wiring.identity()!.state() : null),
    taste: async () => (wiring.taste() ? wiring.taste()!.state() : null),
    journeySuggestions: async () => (wiring.journeys() ? wiring.journeys()!.suggestions() : []),
    getEmbedder: () => wiring.embedder(),
    mayShareNames: () => settings.mayShareNames(),
    vision: {
      mode: () => {
        const v = settings.view()
        return { provider: v.provider, staysLocal: v.staysLocal, label: v.providerLabel, model: v.model }
      }
    },
    capabilities: wiring.capabilities,
    get organizer() {
      return wiring.organizer?.() ?? null
    },
    get studio(): StudioAssistantApi | undefined {
      const studio = wiring.studio?.() ?? null
      if (!studio) return undefined
      return {
        run: (imageId, steps, hooks) => studio.runPlan(imageId, steps, { jobId: hooks.jobId, onStep: hooks.onStep }),
        stop: (jobId) => studio.stop(jobId),
        versions: (imageId) => studio.versions(imageId),
        startExternal: async (imageId, editorId) => {
          const session = await studio.startExternalEdit(imageId, editorId)
          return { editorName: session.editorName }
        },
        editors: () => studio.editorList()
      }
    },
    get boards() {
      return new BoardEditor(wiring.db(), wiring.notifyChanged)
    },
    describeVisually: async (vectors) => {
      const vocab = await loadVocabulary(await wiring.embedder())
      return vectors.map((vector) => {
        if (vector.length !== vocab.dim) return {}
        const best: Record<string, { score: number; label: string }> = {}
        vocab.terms.forEach((term, t) => {
          if (term.generic) return
          let dot = 0
          for (let d = 0; d < vocab.dim; d += 1) dot += vector[d]! * vocab.vectors[t * vocab.dim + d]!
          const cur = best[term.kind]
          if (!cur || dot > cur.score) best[term.kind] = { score: dot, label: term.kind === 'subject' ? term.label : (term.adjective ?? term.label) }
        })
        return { subject: best.subject?.label, mood: best.atmosphere?.label, style: best.style?.label, colour: best.colour?.label }
      })
    }
  }

  const engine = new AssistantEngine({
    dir,
    settings,
    ctx,
    fetchImpl: netFetch,
    onProgress: (progress) => wiring.broadcast('assistant:progress', progress),
    onLibraryChanged: () => wiring.notifyChanged(),
    onChatChanged: (chatId) => wiring.broadcast('assistant:chat-changed', { chatId })
  })

  const text = (value: unknown, max = 4000): string => (typeof value === 'string' ? value.slice(0, max) : '')

  ipcMain.handle('assistant:settings', () => engine.settingsView())
  ipcMain.handle('assistant:update-settings', (_event, change: AssistantSettingsUpdate) => {
    if (!change || typeof change !== 'object') throw new Error('Nothing to change.')
    return settings.update({
      provider: change.provider,
      model: typeof change.model === 'string' ? change.model : undefined,
      baseUrl: typeof change.baseUrl === 'string' ? change.baseUrl : undefined,
      apiKey: typeof change.apiKey === 'string' ? change.apiKey : undefined,
      consent: change.consent && typeof change.consent === 'object' ? { granted: Boolean(change.consent.granted), shareNames: Boolean(change.consent.shareNames) } : undefined
    })
  })
  ipcMain.handle('assistant:test', () => engine.testConnection())
  ipcMain.handle('assistant:detect-local', () => detectLocalServers(netFetch))
  ipcMain.handle('assistant:chats', () => engine.listChats())
  ipcMain.handle('assistant:chat', (_event, id: unknown) => (typeof id === 'string' ? engine.getChat(id) : null))
  ipcMain.handle('assistant:new-chat', () => engine.newChat())
  ipcMain.handle('assistant:delete-chat', (_event, id: unknown) => {
    if (typeof id === 'string') engine.deleteChat(id)
  })
  ipcMain.handle('assistant:send', (_event, chatId: unknown, message: unknown, context: unknown) => {
    const viewing = context && typeof context === 'object' ? (context as { viewingImageId?: unknown }).viewingImageId : null
    return engine.send(typeof chatId === 'string' ? chatId : null, text(message), { viewingImageId: typeof viewing === 'string' ? viewing.slice(0, 80) : null })
  })
  ipcMain.handle('assistant:stop', (_event, chatId: unknown) => {
    if (typeof chatId === 'string') engine.stop(chatId)
  })
  ipcMain.handle('assistant:proposal', (_event, chatId: unknown, proposalId: unknown, accept: unknown, options: unknown) => {
    if (typeof chatId !== 'string' || typeof proposalId !== 'string') throw new Error('Choose a proposal.')
    const o = (options && typeof options === 'object' ? options : {}) as { selection?: unknown; name?: unknown; boardId?: unknown }
    return engine.respondToProposal(chatId, proposalId, accept === true, {
      selection: Array.isArray(o.selection) ? o.selection.filter((id): id is string => typeof id === 'string').slice(0, 200) : undefined,
      name: typeof o.name === 'string' ? o.name.slice(0, 80) : undefined,
      boardId: typeof o.boardId === 'string' ? o.boardId.slice(0, 80) : null
    })
  })
  ipcMain.handle('assistant:review-curation', (_event, chatId: unknown, proposalId: unknown, selection: unknown) => {
    if (typeof chatId !== 'string' || typeof proposalId !== 'string' || !Array.isArray(selection)) return
    engine.reviewCuration(chatId, proposalId, selection.filter((id): id is string => typeof id === 'string').slice(0, 200))
  })
  // Test hook, only in the end-to-end test environment: what the curation evidence says about every image.
  if (process.env.NOEMA_E2E === '1') {
    ipcMain.handle('assistant:debug-roles', async () => {
      const items = wiring.db().queryImages({ scope: 'archive', limit: 500 }).items
      const roles = await curation.roles(items)
      return items.map((i) => ({ name: i.filename, ...(roles.get(i.id) ?? {}) }))
    })
  }
  ipcMain.handle('assistant:view', (_event, view: unknown) => {
    const v = (view && typeof view === 'object' ? view : {}) as Partial<CompanionView>
    const kind = v.kind === 'smart' || v.kind === 'family' || v.kind === 'moodboard' ? v.kind : null
    curation.view =
      kind === null
        ? { kind: null }
        : {
            kind,
            id: typeof v.id === 'string' || typeof v.id === 'number' ? String(v.id).slice(0, 80) : null,
            name: typeof v.name === 'string' ? v.name.slice(0, 120) : undefined,
            criteria: kind === 'smart' ? normalizeCriteria(v.criteria) : undefined
          }
  })
  return engine
}
