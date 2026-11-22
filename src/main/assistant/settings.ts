import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AssistantProviderId, AssistantSettings, AssistantSettingsUpdate } from '../../shared/assistant'
import { PRESETS, isLoopback } from './providers'

/** Encryption supplied by the operating system (Electron's safeStorage). Injected so it can be replaced in tests. */
export interface SecretBox {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

interface Stored {
  provider: AssistantProviderId
  /** Model and address are remembered per provider so switching back does not lose them. */
  models: Partial<Record<AssistantProviderId, string>>
  urls: Partial<Record<AssistantProviderId, string>>
  consent: { granted: boolean; at: number | null; provider: AssistantProviderId | null; shareNames: boolean }
  /** Identity (provider|model|address) of the setup that has answered a real request, and the one already greeted. */
  verified: string | null
  greeted: string | null
}

const DEFAULTS: Stored = {
  provider: 'basics',
  models: {},
  urls: {},
  consent: { granted: false, at: null, provider: null, shareNames: false },
  verified: null,
  greeted: null
}

const PROVIDERS: AssistantProviderId[] = ['basics', 'local', 'anthropic', 'openai', 'custom']

/**
 * The assistant's settings, kept in a small file in the Atlas data folder. API keys are stored separately, encrypted
 * with the operating system's own key store; they are never written in plain text and never sent to the interface.
 */
export class AssistantSettingsStore {
  private data: Stored = structuredClone(DEFAULTS)
  private keys: Record<string, string> = {}
  private sessionKeys = new Map<string, string>()

  constructor(
    private dir: string,
    private box: SecretBox
  ) {
    mkdirSync(dir, { recursive: true })
    this.data = this.load()
    this.keys = this.loadKeys()
  }

  private get settingsPath(): string {
    return join(this.dir, 'settings.json')
  }
  private get keysPath(): string {
    return join(this.dir, 'keys.json')
  }

  private load(): Stored {
    try {
      if (!existsSync(this.settingsPath)) return structuredClone(DEFAULTS)
      const raw = JSON.parse(readFileSync(this.settingsPath, 'utf8')) as Partial<Stored>
      return {
        provider: PROVIDERS.includes(raw.provider as AssistantProviderId) ? (raw.provider as AssistantProviderId) : 'basics',
        models: raw.models && typeof raw.models === 'object' ? raw.models : {},
        urls: raw.urls && typeof raw.urls === 'object' ? raw.urls : {},
        consent: { ...DEFAULTS.consent, ...(raw.consent ?? {}) },
        verified: typeof raw.verified === 'string' ? raw.verified : null,
        greeted: typeof raw.greeted === 'string' ? raw.greeted : null
      }
    } catch {
      return structuredClone(DEFAULTS)
    }
  }

  private loadKeys(): Record<string, string> {
    try {
      if (!existsSync(this.keysPath)) return {}
      const raw = JSON.parse(readFileSync(this.keysPath, 'utf8')) as Record<string, string>
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  private writeAtomic(path: string, text: string): void {
    const temp = `${path}.tmp`
    writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  }

  private save(): void {
    this.writeAtomic(this.settingsPath, JSON.stringify(this.data, null, 2))
  }

  /** The address the selected provider talks to. */
  baseUrl(provider: AssistantProviderId = this.data.provider): string {
    if (provider === 'anthropic') return PRESETS.anthropic.baseUrl
    if (provider === 'openai') return PRESETS.openai.baseUrl
    if (provider === 'local') return this.data.urls.local ?? 'http://127.0.0.1:11434/v1'
    if (provider === 'custom') return this.data.urls.custom ?? ''
    return ''
  }

  model(provider: AssistantProviderId = this.data.provider): string {
    return this.data.models[provider] ?? (provider === 'anthropic' ? PRESETS.anthropic.model : '')
  }

  /** The stored key for a provider, for the main process only. */
  apiKey(provider: AssistantProviderId = this.data.provider): string | null {
    const session = this.sessionKeys.get(provider)
    if (session) return session
    const sealed = this.keys[provider]
    if (!sealed) return null
    try {
      return this.box.decrypt(Buffer.from(sealed, 'base64'))
    } catch {
      return null
    }
  }

  /** True when the selected provider sends data outside this computer. */
  leavesComputer(provider: AssistantProviderId = this.data.provider): boolean {
    if (provider === 'basics') return false
    if (provider === 'anthropic' || provider === 'openai') return true
    return !isLoopback(this.baseUrl(provider))
  }

  consentGiven(provider: AssistantProviderId = this.data.provider): boolean {
    if (!this.leavesComputer(provider)) return true
    return this.data.consent.granted && this.data.consent.provider === provider
  }

  /** Whether filenames and folder names may be included in what is sent (only after consent). */
  mayShareNames(): boolean {
    if (!this.leavesComputer()) return true
    return this.data.consent.granted && this.data.consent.provider === this.data.provider && this.data.consent.shareNames
  }

  get provider(): AssistantProviderId {
    return this.data.provider
  }

  /** Names the current setup. A change to provider, model or address makes an earlier verification void. */
  identity(): string {
    return `${this.data.provider}|${this.model()}|${this.baseUrl()}`
  }

  isVerified(): boolean {
    return this.data.provider !== 'basics' && this.data.verified === this.identity()
  }

  markVerified(): void {
    this.data.verified = this.identity()
    this.save()
  }

  /** True once per verified setup: the greeting is not repeated when settings are opened again. */
  takeGreeting(): boolean {
    const id = this.identity()
    if (this.data.greeted === id) return false
    this.data.greeted = id
    this.save()
    return true
  }

  providerLabel(provider: AssistantProviderId = this.data.provider): string {
    if (provider === 'basics') return 'Atlas basics'
    if (provider === 'anthropic') return 'Claude'
    if (provider === 'openai') return 'OpenAI'
    const url = this.baseUrl(provider)
    if (/:11434\b/.test(url)) return 'Ollama'
    if (/:1234\b/.test(url)) return 'LM Studio'
    return provider === 'local' ? 'Local model' : 'Custom server'
  }

  view(): AssistantSettings {
    const provider = this.data.provider
    return {
      provider,
      model: this.model(provider),
      baseUrl: this.baseUrl(provider),
      hasKey: this.apiKey(provider) !== null,
      canStoreKey: this.box.available(),
      consent: { ...this.data.consent },
      staysLocal: !this.leavesComputer(provider),
      verified: this.isVerified(),
      providerLabel: this.providerLabel(provider)
    }
  }

  update(change: AssistantSettingsUpdate): AssistantSettings {
    const before = this.data.provider
    if (change.provider && PROVIDERS.includes(change.provider)) this.data.provider = change.provider
    const provider = this.data.provider
    const previousAddress = this.baseUrl(provider)
    if (typeof change.model === 'string') this.data.models[provider] = change.model.trim().slice(0, 120)
    if (typeof change.baseUrl === 'string' && (provider === 'local' || provider === 'custom')) {
      const url = change.baseUrl.trim().slice(0, 300)
      if (url === '' || /^https?:\/\//i.test(url)) this.data.urls[provider] = url
    }
    const addressChanged = previousAddress !== this.baseUrl(provider)
    if (addressChanged) this.data.consent = { ...DEFAULTS.consent }
    if (typeof change.apiKey === 'string' || addressChanged) {
      const key = change.apiKey?.trim() ?? ''
      if (key === '') {
        delete this.keys[provider]
        this.sessionKeys.delete(provider)
      } else if (this.box.available()) {
        this.keys[provider] = this.box.encrypt(key).toString('base64')
        this.sessionKeys.delete(provider)
      } else {
        // No safe place to keep it: hold it in memory for this session only.
        delete this.keys[provider]
        this.sessionKeys.set(provider, key)
      }
      this.data.verified = null
      this.writeAtomic(this.keysPath, JSON.stringify(this.keys))
    }
    if (change.consent) {
      this.data.consent = {
        granted: Boolean(change.consent.granted),
        at: change.consent.granted ? Date.now() : null,
        provider: change.consent.granted ? provider : null,
        shareNames: Boolean(change.consent.granted && change.consent.shareNames)
      }
    }
    // Consent belongs to one provider: switching to another cloud provider asks again.
    if (before !== this.data.provider && this.data.consent.provider !== this.data.provider) {
      this.data.consent = { granted: false, at: null, provider: null, shareNames: false }
    }
    this.save()
    return this.view()
  }
}
