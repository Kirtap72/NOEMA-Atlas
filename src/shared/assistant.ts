import type { AspectChoice, EditLevel, EditReferences, EditRegion, PlanStep, RefRole, RetouchTool } from './studio'
import type { CuratedProposalData } from './curation'
import type { ImageItem, ReferenceWork } from './types'

/** Where Atlas does its thinking. 'basics' is built in and always works offline. */
export type AssistantProviderId = 'basics' | 'local' | 'anthropic' | 'openai' | 'custom'

export interface AssistantSettings {
  provider: AssistantProviderId
  /** Model name for the language model providers. */
  model: string
  /** Server address for 'local' and 'custom'; the cloud presets have their own. */
  baseUrl: string
  /** True when an API key is stored for the selected provider (the key itself never leaves the main process). */
  hasKey: boolean
  /** Whether keys can be stored encrypted on this computer. */
  canStoreKey: boolean
  /** Cloud use needs an explicit yes. Local models on this computer do not. */
  consent: { granted: boolean; at: number | null; provider: AssistantProviderId | null; shareNames: boolean }
  /** True when the selected provider keeps everything on this computer. */
  staysLocal: boolean
  /** True only when the selected provider AND model have actually answered a real request (and nothing relevant changed since). */
  verified: boolean
  /** Friendly provider name for the interface: Claude, OpenAI, Ollama, LM Studio, a local or custom server. */
  providerLabel: string
}

export interface AssistantSettingsUpdate {
  provider?: AssistantProviderId
  model?: string
  baseUrl?: string
  /** A new API key to store, or '' to forget the stored one. */
  apiKey?: string
  /** The user's answer to the consent question. */
  consent?: { granted: boolean; shareNames: boolean }
}

export interface AssistantTestResult {
  /** The model answered a real request. This, not `connected`, is what "ready" means. */
  ok: boolean
  /** The server could be reached (and the key accepted), whether or not the chosen model has answered. */
  connected: boolean
  verified: boolean
  message: string
  models: string[]
  /** The model used for verification. */
  model: string
  providerLabel: string
  /** A short welcome written by the model itself, only on the first verification of this provider and model. */
  greeting: string | null
}

export interface LocalServer {
  id: 'ollama' | 'lmstudio'
  name: string
  baseUrl: string
  models: string[]
}

/** How well a statement is supported: from the user's own images, or an idea of the assistant's. */
/** `seen` = the model looked at the pictures themselves and says what it sees; `library` = from notes, tags and numbers about the library; `idea` = the model's own suggestion. */
export type Basis = 'library' | 'idea' | 'plain' | 'seen'

export type AssistantProposal =
  /** A curated selection, shown for review: the user approves, rejects or replaces single images before anything is made. */
  | CuratedProposalData
  | { kind: 'new-moodboard'; name: string; imageIds: string[] }
  | { kind: 'add-to-moodboard'; boardId: string; boardName: string; imageIds: string[] }
  /** Removes, replaces or rearranges pictures on an existing board. Applied only on Accept, and can be undone. */
  | { kind: 'board-change'; boardId: string; boardName: string; imageIds: string[]; removeIds: string[]; arrange: 'tidy' | 'hero' | 'keep' }
  /** A concept for a new artwork. Accepting opens the Creative Studio with it, where prompt, method and cost are reviewed. */
  /** Edit one picture from a description. Accepting opens the Studio's Edit tab with it, where method and any cost are reviewed. */
  | { kind: 'edit'; imageId: string; imageIds: string[]; instruction: string; strength: number; level?: EditLevel; region?: EditRegion; references?: EditReferences }
  /** A multi-step creative process. On Accept Atlas runs every step with local tools and shows the results here; nothing is uploaded or paid for. */
  | { kind: 'retouch'; imageId: string; imageIds: string[]; tool: RetouchTool; region?: EditRegion; strength: number; edgeAware?: boolean; tone?: 'lighten' | 'darken'; hint?: string }
  /** Send pictures to a language model that is not on this computer so it can look at them. Sent only on Accept, only these, only once. */
  | { kind: 'look'; imageId: string; imageIds: string[]; question: string; detail: 'normal' | 'close'; focus?: VisionFocusRequest; compare?: boolean; providerLabel: string; model: string }
  /** Open the Organizer page at its export step. Nothing is copied until the user chooses a destination there and starts it. */
  | { kind: 'organize-export'; imageIds: string[]; planId: string; planName: string; pictures: number }
  | { kind: 'edit-plan'; imageId: string; imageIds: string[]; title: string; steps: PlanStep[]; how: string; resultIds?: string[]; jobId?: string }
  /** Open a copy of a picture in another program; its saved result comes back as a new linked version. */
  | { kind: 'external-edit'; imageId: string; imageIds: string[]; editorId: string | null; editorName: string }
  /** Open the AI Model Library on one model. Nothing is downloaded by accepting; the library asks for consent itself. */
  | { kind: 'open-models'; imageIds: string[]; entryId: string; entryName: string; search: string }
  /** Make a larger copy of one picture. Accepting opens the viewer's Upscale panel with the size filled in. */
  | { kind: 'upscale'; imageId: string; imageIds: string[]; targetLongEdge: number; way: string }
  | { kind: 'artwork'; boardId: string; boardName: string; imageIds: string[]; title: string; prompt: string; negative: string; aspect: AspectChoice; roles: Record<string, RefRole[]> }

/** Which part of the pictures to look at closely: a cell of a 3 by 3 grid, or a rectangle in fractions of the picture. */
export interface VisionFocusRequest {
  grid?: 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'
  rect?: { x: number; y: number; w: number; h: number }
}

export type AssistantBlock =
  | { type: 'text'; basis: Basis; text: string }
  /** The model looked at these pictures directly. Shown above its answer so what it saw is never confused with what the library notes say. */
  | { type: 'looked'; ids: string[]; refs: string[]; items?: ImageItem[]; provider: string; model: string; local: boolean; detail: 'normal' | 'close'; focus?: string; compare?: boolean }
  | { type: 'images'; label: string; ids: string[]; items?: ImageItem[]; basis: Basis; /** The short references the model uses for these pictures, so a follow-up ("the second one") can name them. */ refs?: string[] }
  | { type: 'works'; label: string; works: ReferenceWork[] }
  | {
      type: 'proposal'
      id: string
      title: string
      reason: string
      proposal: AssistantProposal
      status: 'pending' | 'running' | 'applied' | 'dismissed'
      result?: string
      /** For plans: the versions made so far, shown under the plan. */
      resultItems?: ImageItem[]
      items?: ImageItem[]
      /** For board changes: the pictures that would leave the board. */
      removeItems?: ImageItem[]
    }
  | { type: 'note'; text: string }

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  at: number
  blocks: AssistantBlock[]
  /** Which provider answered, for a small label under the message. */
  via?: AssistantProviderId
}

export interface AssistantChat {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: AssistantMessage[]
}

export interface AssistantChatSummary {
  id: string
  title: string
  updatedAt: number
}

export interface AssistantReply {
  chat: AssistantChat
  /** Set when the answer needs the user to decide something first (for example, to allow cloud use). */
  needs?: 'consent' | 'setup' | null
}

export interface AssistantProgress {
  chatId: string
  text: string
}
