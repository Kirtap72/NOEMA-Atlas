import { useCallback, useEffect, useId, useState } from 'react'
import type { IndexStatus, ModelStatus } from '@shared/types'
import { Modal, ConfirmModal } from './ui'
import { Icon } from './Icon'
import { useIndexStatus } from '../lib/useIndexStatus'
import { formatBytes, formatNumber, friendlyError } from '../lib/format'

export const OPEN_AI_SETUP_EVENT = 'atlas:open-ai-setup'

export function openAiSetup(): void {
  window.dispatchEvent(new Event(OPEN_AI_SETUP_EVENT))
}

/** Live state of the local image model: whether it is installed, the user's choice, and any download. */
export function useModelStatus(): ModelStatus | null {
  const [status, setStatus] = useState<ModelStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.noema.getModelStatus().then((next) => {
      if (alive) setStatus(next)
    })
    const off = window.noema.onModelStatus((next) => setStatus(next))
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '…'
}

function formatEta(status: ModelStatus): string {
  const left = status.totalBytes - status.receivedBytes
  if (status.bytesPerSecond < 1000 || left <= 0) return ''
  const seconds = Math.round(left / status.bytesPerSecond)
  if (seconds < 60) return `${seconds} s left`
  return `${Math.ceil(seconds / 60)} min left`
}

function DownloadProgress({ status }: { status: ModelStatus }): React.JSX.Element {
  const percent = status.totalBytes > 0 ? Math.min(100, (status.receivedBytes / status.totalBytes) * 100) : 0
  return (
    <div className="ai-progress" role="group" aria-label="Download progress">
      <div
        className="ai-progress__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span style={{ width: `${Math.max(1, percent)}%` }} />
      </div>
      <div className="ai-progress__meta">
        <span>
          {status.state === 'verifying' ? 'Checking the file…' : `${formatBytes(status.receivedBytes)} of ${formatBytes(status.totalBytes)}`}
        </span>
        <span>
          {status.state === 'downloading' ? `${formatSpeed(status.bytesPerSecond)} ${formatEta(status)}` : ''}
        </span>
      </div>
    </div>
  )
}

/**
 * The consent and download flow. Nothing is downloaded until the user presses the button, and Atlas works
 * completely without the model.
 */
export function AiSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element | null {
  const status = useModelStatus()
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setLocalError(null)
    try {
      await action()
    } catch (error) {
      setLocalError(friendlyError(error))
    } finally {
      setBusy(false)
    }
  }, [])

  if (!status) return null
  const downloading = status.state === 'downloading' || status.state === 'verifying'
  const sizeLabel = formatBytes(status.totalBytes)

  let body: React.JSX.Element
  if (downloading) {
    body = (
      <>
        <h2 id={titleId} className="modal__title">Downloading the image model</h2>
        <div className="modal__copy">
          <p>
            Atlas is fetching the model once. You can keep working meanwhile, and you can stop at any time. A partly
            finished download is kept and resumed next time.
          </p>
          <DownloadProgress status={status} />
        </div>
        <div className="modal__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            Keep working
          </button>
          <button type="button" className="button button--ghost" onClick={() => void run(() => window.noema.cancelModelInstall())}>
            Stop download
          </button>
        </div>
      </>
    )
  } else if (status.installed && status.choice === 'enabled') {
    body = (
      <>
        <h2 id={titleId} className="modal__title">Atlas can see your images now</h2>
        <div className="modal__copy">
          <p>
            The image model is installed and switched on. Atlas learns your images in the background; you can search by
            description, find similar images and browse families as soon as it has started.
          </p>
        </div>
        <div className="modal__actions">
          <button type="button" className="button button--gold" onClick={onClose}>Done</button>
        </div>
      </>
    )
  } else if (status.installed) {
    body = (
      <>
        <h2 id={titleId} className="modal__title">Switch visual search back on?</h2>
        <div className="modal__copy">
          <p>The image model is already on this computer. Turning it on lets Atlas learn new images again.</p>
        </div>
        <div className="modal__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>Not now</button>
          <button
            type="button"
            className="button button--gold"
            disabled={busy}
            onClick={() => void run(async () => { await window.noema.enableAi(); onClose() })}
          >
            Turn on
          </button>
        </div>
      </>
    )
  } else {
    const failed = status.state === 'error'
    const paused = status.state === 'cancelled'
    body = (
      <>
        <div className="modal__kicker">{failed ? 'THE DOWNLOAD DID NOT FINISH' : 'OPTIONAL · LOCAL AI'}</div>
        <h2 id={titleId} className="modal__title">
          {failed ? 'Something went wrong' : paused ? 'Download stopped' : 'Let Atlas learn your images?'}
        </h2>
        <div className="modal__copy">
          {failed ? (
            <p className="ai-error">{status.error}</p>
          ) : paused ? (
            <p>The download was stopped. You can continue where it left off, or use Atlas without AI.</p>
          ) : (
            <>
              <p>
                Atlas can use a small AI model to understand what your images look like. That lets you search by
                description (in English or Swedish), find similar images and see them grouped into families, without
                tagging anything by hand.
              </p>
              <ul className="ai-facts">
                <li><Icon name="drive" size={15} /> One-time download of about {sizeLabel} from Hugging Face. Nothing else is downloaded.</li>
                <li><Icon name="lock" size={15} /> The model runs on this computer. Your images are never uploaded or shared.</li>
                <li><Icon name="shield" size={15} /> Your original files are only read, never changed.</li>
                <li><Icon name="eye" size={15} /> Atlas works fully without it, and you can switch it off or remove it later.</li>
              </ul>
            </>
          )}
          {localError ? <p className="ai-error">{localError}</p> : null}
        </div>
        <div className="modal__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={busy}
            onClick={() => void run(async () => { await window.noema.declineAi(); onClose() })}
          >
            Use Atlas without AI
          </button>
          {!failed && !paused ? (
            <button type="button" className="button button--ghost" onClick={onClose}>Decide later</button>
          ) : null}
          <button
            type="button"
            className="button button--gold"
            disabled={busy}
            onClick={() => void run(() => window.noema.installModel())}
          >
            {failed ? 'Try again' : paused ? 'Resume download' : `Download ${sizeLabel} and turn on`}
          </button>
        </div>
      </>
    )
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="modal-panel--ai">
      {body}
    </Modal>
  )
}

function indexLine(index: IndexStatus | null): string {
  if (!index || !index.enabled) return ''
  if (index.state === 'loading') return 'Starting the image model…'
  if (index.state === 'error') return index.message ?? 'Indexing stopped.'
  if (index.total === 0) return 'Waiting for images.'
  const where = index.provider === 'directml' ? 'on the graphics card' : index.provider === 'cpu' ? 'on the processor' : ''
  if (index.indexed < index.total) {
    return `${index.state === 'paused' ? 'Paused' : 'Learning'}: ${formatNumber(index.indexed)} of ${formatNumber(index.total)} images ${where}`.trim()
  }
  return `All ${formatNumber(index.total)} images are learned${where ? ` (${where})` : ''}.`
}

/** The "Image intelligence" panel on the Sources page. */
export function AiPanel(): React.JSX.Element | null {
  const model = useModelStatus()
  const index = useIndexStatus()
  const [dialog, setDialog] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const open = (): void => setDialog(true)
    window.addEventListener(OPEN_AI_SETUP_EVENT, open)
    return () => window.removeEventListener(OPEN_AI_SETUP_EVENT, open)
  }, [])

  if (!model) return null
  const downloading = model.state === 'downloading' || model.state === 'verifying'
  const on = model.installed && model.choice === 'enabled'

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await action()
    } catch (actionError) {
      setError(friendlyError(actionError))
    }
  }

  return (
    <section className="ai-panel" aria-label="Image intelligence">
      <div className="ai-panel__copy">
        <div className="eyebrow">IMAGE INTELLIGENCE · OPTIONAL · LOCAL</div>
        <h2>{on ? 'Atlas is learning your images' : 'Search by what images look like'}</h2>
        <p>
          {on
            ? 'The model runs on this computer. Turn it off or remove it whenever you like; everything else in Atlas keeps working.'
            : model.choice === 'declined'
              ? 'AI features are off. Atlas works as a plain, fast image library.'
              : 'A one-time download enables search by description, similar images and families. Atlas works without it.'}
        </p>
        {downloading ? <DownloadProgress status={model} /> : null}
        {on ? <p className="ai-panel__line">{indexLine(index)}</p> : null}
        {model.state === 'error' && model.error ? <p className="ai-error">{model.error}</p> : null}
        {error ? <p className="ai-error">{error}</p> : null}
      </div>
      <div className="ai-panel__actions">
        {downloading ? (
          <button type="button" className="button button--ghost" onClick={() => void act(() => window.noema.cancelModelInstall())}>
            Stop download
          </button>
        ) : on ? (
          <>
            {index && index.state === 'paused' ? (
              <button type="button" className="button button--ghost" onClick={() => void act(() => window.noema.resumeIndexing())}>
                Resume learning
              </button>
            ) : index && (index.state === 'running' || index.state === 'loading') ? (
              <button type="button" className="button button--ghost" onClick={() => void act(() => window.noema.pauseIndexing())}>
                Pause learning
              </button>
            ) : null}
            <button type="button" className="button button--ghost" onClick={() => void act(() => window.noema.declineAi())}>
              Turn off
            </button>
            <button type="button" className="button button--ghost" onClick={() => setConfirmRemove(true)}>
              Remove model
            </button>
          </>
        ) : model.installed ? (
          <>
            <button type="button" className="button button--gold" onClick={() => void act(() => window.noema.enableAi())}>
              Turn on
            </button>
            <button type="button" className="button button--ghost" onClick={() => setConfirmRemove(true)}>
              Remove model
            </button>
          </>
        ) : (
          <button type="button" className="button button--gold" onClick={() => setDialog(true)}>
            <Icon name="sparkle" size={16} /> Set up…
          </button>
        )}
      </div>
      <AiSetupDialog open={dialog} onClose={() => setDialog(false)} />
      <ConfirmModal
        open={confirmRemove}
        title="Remove the image model?"
        description={`This deletes the downloaded model (${formatBytes(model.totalBytes)}) from this computer and turns AI features off. Your images and everything Atlas has learned about them stay. You can download the model again at any time.`}
        confirmLabel="Remove model"
        tone="danger"
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => act(() => window.noema.removeModel())}
      />
    </section>
  )
}
