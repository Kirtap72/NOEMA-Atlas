import { useCallback, useEffect, useState } from 'react'
import type { AssistantProviderId, AssistantSettings, AssistantTestResult, LocalServer } from '@shared/assistant'
import { Icon } from './Icon'
import { friendlyError } from '../lib/format'

const CHOICES: Array<{ id: AssistantProviderId; title: string; copy: string; tag: string }> = [
  { id: 'basics', title: 'Atlas basics', copy: 'Built in. Understands everyday requests and works fully offline.', tag: 'Offline' },
  { id: 'local', title: 'A model on this computer', copy: 'Ollama, LM Studio or any local server. Nothing leaves this computer.', tag: 'Private' },
  { id: 'anthropic', title: 'Claude (Anthropic)', copy: 'Richer conversation, using your own API key.', tag: 'Cloud' },
  { id: 'openai', title: 'OpenAI', copy: 'Richer conversation, using your own API key.', tag: 'Cloud' },
  { id: 'custom', title: 'Another server', copy: 'Any service that speaks the OpenAI chat format (OpenRouter, a company server ...).', tag: 'Cloud' }
]

/** Where Atlas thinks: simple choices, and plain words about what is shared. */
export function CompanionSettings({ onDone, onChanged, onVerified }: { onDone: () => void; onChanged: (settings: AssistantSettings) => void; onVerified: (result: AssistantTestResult) => void }): React.JSX.Element {
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [shareNames, setShareNames] = useState(false)
  const [agree, setAgree] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [local, setLocal] = useState<LocalServer[] | null>(null)
  const [status, setStatus] = useState<{ ok: boolean; text: string; warn?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const next = await window.noema.assistantSettings()
    setSettings(next)
    setModel(next.model)
    setBaseUrl(next.baseUrl)
    setAgree(next.consent.granted)
    setShareNames(next.consent.shareNames)
    setApiKey('')
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const pick = async (provider: AssistantProviderId): Promise<void> => {
    const next = await window.noema.assistantUpdateSettings({ provider })
    setSettings(next)
    setModel(next.model)
    setBaseUrl(next.baseUrl)
    setAgree(next.consent.granted)
    setShareNames(next.consent.shareNames)
    setApiKey('')
    setModels([])
    setStatus(null)
    onChanged(next)
    if (provider === 'local') void detect()
  }

  const detect = async (): Promise<void> => {
    try {
      setLocal(await window.noema.assistantDetectLocal())
    } catch {
      setLocal([])
    }
  }

  const save = async (): Promise<AssistantSettings | null> => {
    if (!settings) return null
    setBusy(true)
    try {
      const next = await window.noema.assistantUpdateSettings({
        model,
        baseUrl,
        apiKey: apiKey !== '' ? apiKey : undefined,
        consent: willLeave ? { granted: agree, shareNames: agree && shareNames } : undefined
      })
      setSettings(next)
      setApiKey('')
      onChanged(next)
      return next
    } catch (error) {
      setStatus({ ok: false, text: friendlyError(error) })
      return null
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    const saved = await save()
    if (!saved) return
    setBusy(true)
    setStatus({ ok: true, warn: true, text: 'Connecting, then asking the model to answer…' })
    try {
      const result = await window.noema.assistantTest()
      setStatus({ ok: result.ok, warn: result.connected && !result.verified, text: result.message })
      setModels(result.models)
      if (result.model) setModel(result.model)
      if (result.ok && result.verified) {
        // Only a real answer from the chosen model returns to the conversation.
        const fresh = await window.noema.assistantSettings()
        setSettings(fresh)
        onChanged(fresh)
        onVerified(result)
      }
    } finally {
      setBusy(false)
    }
  }

  const forgetKey = async (): Promise<void> => {
    const next = await window.noema.assistantUpdateSettings({ apiKey: '' })
    setSettings(next)
    onChanged(next)
    setStatus({ ok: true, text: 'The stored key was removed.' })
  }

  if (!settings) return <div className="companion-settings"><p className="hint">Loading…</p></div>
  const provider = settings.provider
  const cloud = provider !== 'basics' && !settings.staysLocal
  const needsKey = provider === 'anthropic' || provider === 'openai' || provider === 'custom'
  const needsUrl = provider === 'local' || provider === 'custom'
  const urlIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(baseUrl)
  const willLeave = provider === 'anthropic' || provider === 'openai' || (provider === 'custom' && !urlIsLocal) || (provider === 'local' && baseUrl !== '' && !urlIsLocal)
  const changeAddress = (address: string): void => {
    setBaseUrl(address)
    setAgree(false)
    setShareNames(false)
    setApiKey('')
  }
  const hasKeyHere = settings.hasKey && baseUrl === settings.baseUrl

  return (
    <div className="companion-settings">
      <div className="companion-settings__head">
        <h3>Where should Atlas think?</h3>
        <button type="button" className="button button--ghost" onClick={onDone}>Back to the conversation</button>
      </div>
      <div className="provider-cards" role="radiogroup" aria-label="Where Atlas thinks">
        {CHOICES.map((choice) => (
          <button key={choice.id} type="button" role="radio" aria-checked={provider === choice.id} className={`provider-card ${provider === choice.id ? 'is-on' : ''}`} onClick={() => void pick(choice.id)}>
            <span className="provider-card__title">{choice.title}<em>{choice.tag}</em></span>
            <span className="provider-card__copy">{choice.copy}</span>
          </button>
        ))}
      </div>

      {provider === 'basics' ? (
        <p className="hint companion-settings__note">
          Atlas basics needs nothing. It finds images, reads what your favorites share, suggests what fits a moodboard and offers directions. Connect a language model for open conversation.
        </p>
      ) : (
        <div className="companion-settings__form">
          {needsUrl ? (
            <label>
              <span>Server address</span>
              <input value={baseUrl} onChange={(e) => changeAddress(e.target.value)} placeholder={provider === 'local' ? 'http://127.0.0.1:11434/v1' : 'https://…/v1'} spellCheck={false} />
            </label>
          ) : null}
          {provider === 'local' ? (
            <div className="companion-settings__found">
              {local === null ? (
                <button type="button" className="button button--quiet" onClick={() => void detect()}>Look for a model on this computer</button>
              ) : local.length === 0 ? (
                <span className="hint">No Ollama or LM Studio server found. Start one, or type its address.</span>
              ) : (
                local.map((server) => (
                  <button key={server.id} type="button" className="button button--quiet" onClick={() => { changeAddress(server.baseUrl); setModels(server.models); if (server.models[0] && !model) setModel(server.models[0]) }}>
                    Use {server.name} ({server.models.length} model{server.models.length === 1 ? '' : 's'})
                  </button>
                ))
              )}
            </div>
          ) : null}
          {needsKey ? (
            <label>
              <span>API key {hasKeyHere ? <em className="ok">stored securely</em> : null}</span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasKeyHere ? '•••••••• (leave empty to keep)' : provider === 'custom' ? 'Optional for some servers' : 'Paste your key'}
                spellCheck={false}
              />
              <small>
                {settings.canStoreKey
                  ? 'Encrypted with your Windows account and kept on this computer. It is never shown again and never sent anywhere except to this provider.'
                  : 'This computer cannot store secrets safely, so the key is kept only until Atlas closes.'}
              </small>
            </label>
          ) : null}
          <label>
            <span>Model</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} list="companion-models" placeholder="Choose after testing the connection" spellCheck={false} />
            <datalist id="companion-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>

          {willLeave ? (
            <div className="consent">
              <h4><Icon name="shield" size={15} /> What leaves this computer</h4>
              <ul>
                <li><b>Sent:</b> what you type, and short text descriptions of your library: tags, colours, everyday descriptions of images (like “misty forest, painterly”), family and moodboard names, taste qualities.</li>
                <li><b>Never sent:</b> your image files or thumbnails, and file paths.</li>
                <li><b>Only if you allow it below:</b> filenames and folder names.</li>
              </ul>
              <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I understand, and I allow Atlas to send this to {provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : 'this server'}.</label>
              <label className="check"><input type="checkbox" checked={shareNames} disabled={!agree} onChange={(e) => setShareNames(e.target.checked)} /> Also share filenames and folder names (helps me refer to files, less private).</label>
            </div>
          ) : (
            <p className="hint companion-settings__note"><Icon name="lock" size={13} /> This server is on your computer: nothing is sent over the internet.</p>
          )}

          <div className="companion-settings__actions">
            <button type="button" className="button button--gold" disabled={busy || (willLeave && !agree)} onClick={() => void test()}>
              {busy ? 'Working…' : 'Save and test the connection'}
            </button>
            {settings.hasKey ? <button type="button" className="button button--quiet" onClick={() => void forgetKey()}>Forget the stored key</button> : null}
          </div>
          {status ? <p className={`companion-settings__status ${status.warn ? 'is-warn' : status.ok ? 'is-ok' : 'is-bad'}`} role="status">{status.text}</p> : null}
        </div>
      )}
      {cloud && !settings.consent.granted ? <p className="hint">Until you allow it, Atlas will not contact this provider.</p> : null}
    </div>
  )
}
