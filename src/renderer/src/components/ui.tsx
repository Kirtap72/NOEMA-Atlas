import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { useAtlas } from '../lib/useAtlas'

export function Stars({
  value,
  onChange,
  size = 15,
  className = '',
  label = 'Rating'
}: {
  value: number
  onChange?: (rating: number) => void
  size?: number
  className?: string
  label?: string
}): React.JSX.Element {
  const [hovered, setHovered] = useState(0)
  return (
    <div
      className={`stars ${onChange ? 'stars--interactive' : ''} ${className}`}
      role={onChange ? 'radiogroup' : 'img'}
      aria-label={`${label}: ${value} out of 5`}
      onMouseLeave={() => setHovered(0)}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const active = star <= (hovered || value)
        return onChange ? (
          <button
            type="button"
            key={star}
            className={`stars__star ${active ? 'is-on' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onChange(star)
            }}
            onMouseEnter={() => setHovered(star)}
            aria-label={`${star} star${star === 1 ? '' : 's'}`}
            aria-checked={value === star}
            role="radio"
          >
            <Icon name="star" size={size} strokeWidth={1.1} />
          </button>
        ) : (
          <span key={star} className={`stars__star ${active ? 'is-on' : ''}`}>
            <Icon name="star" size={size} strokeWidth={1.1} />
          </span>
        )
      })}
    </div>
  )
}

export function ProgressiveImage({
  src,
  placeholder,
  alt,
  className = '',
  onLoaded
}: {
  src: string
  placeholder?: string
  alt: string
  className?: string
  onLoaded?: () => void
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className={`progressive ${className}`}>
      {placeholder ? <img className="progressive__placeholder" src={placeholder} alt="" draggable={false} /> : null}
      <img
        className={`progressive__full ${loaded ? 'is-loaded' : ''}`}
        src={src}
        alt={alt}
        draggable={false}
        decoding="async"
        onLoad={() => {
          setLoaded(true)
          onLoaded?.()
        }}
      />
      {!loaded ? <span className="progressive__shimmer" aria-hidden="true" /> : null}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  children,
  className = '',
  labelledBy
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  labelledBy?: string
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
      if (event.key !== 'Tab') return
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const previous = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', onKeyDown, true)
    window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        'input, textarea, button.primary, button[data-autofocus], button'
      )
      target?.focus()
    }, 30)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previous?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={`modal-panel ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        {children}
      </div>
    </div>,
    document.body
  )
}

export function PromptModal({
  open,
  title,
  description,
  initialValue = '',
  confirmLabel = 'Save',
  placeholder = '',
  onClose,
  onConfirm
}: {
  open: boolean
  title: string
  description?: string
  initialValue?: string
  confirmLabel?: string
  placeholder?: string
  onClose: () => void
  onConfirm: (value: string) => Promise<void> | void
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const titleId = useId()

  useEffect(() => {
    if (open) setValue(initialValue)
  }, [initialValue, open])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!value.trim() || busy) return
    setBusy(true)
    try {
      await onConfirm(value.trim())
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="modal-panel--small">
      <form onSubmit={(event) => void submit(event)}>
        <div className="modal__kicker">NOEMA ATLAS</div>
        <h2 id={titleId} className="modal__title">
          {title}
        </h2>
        {description ? <p className="modal__copy">{description}</p> : null}
        <label className="field">
          <span className="field__label">Name</span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            maxLength={80}
            autoFocus
          />
        </label>
        <div className="modal__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button--gold" disabled={!value.trim() || busy}>
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  tone = 'default',
  onClose,
  onConfirm
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel?: string
  tone?: 'default' | 'danger'
  onClose: () => void
  onConfirm: () => Promise<void> | void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const titleId = useId()
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="modal-panel--small">
      <div className="modal__kicker">{tone === 'danger' ? 'PLEASE NOTE' : 'NOEMA ATLAS'}</div>
      <h2 id={titleId} className="modal__title">
        {title}
      </h2>
      <div className="modal__copy">{description}</div>
      <div className="modal__actions">
        <button type="button" className="button button--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={`button ${tone === 'danger' ? 'button--danger' : 'button--gold'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onConfirm()
              onClose()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const titleId = useId()
  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId} className="help-modal">
      <div className="modal__kicker">A SMALL GUIDE</div>
      <h2 id={titleId} className="modal__title modal__title--serif">
        Looking, keeping, remembering.
      </h2>
      <p className="modal__copy">
        Atlas builds a private visual index from the folders you choose. It creates small previews and a local
        SQLite catalogue. Indexing, reviewing and arranging never change your originals. The File Room can make
        an explicit copy, or move files only after a confirmation.
      </p>
      <div className="help-grid">
        <section className="help-card">
          <span className="help-card__number">01</span>
          <h3>Add a source</h3>
          <p>Choose any folder. Atlas never scans a drive on its own, and it never follows shortcuts out of the folder.</p>
        </section>
        <section className="help-card">
          <span className="help-card__number">02</span>
          <h3>Follow your eye</h3>
          <p>Keep, pass or rate. Undo restores any decision, and previous-image navigation lets you change an earlier choice in place.</p>
        </section>
        <section className="help-card">
          <span className="help-card__number">03</span>
          <h3>Collect fragments</h3>
          <p>Drag images onto an unlimited board. Scroll to zoom, Space-drag or middle-drag to pan, and fit everything back into view.</p>
        </section>
        <section className="help-card">
          <span className="help-card__number">04</span>
          <h3>File with care</h3>
          <p>Copy is the default. Move asks first, never overwrites, and updates the library while keeping ratings and boards.</p>
        </section>
      </div>
      <div className="shortcut-list">
        <div>
          <kbd>F</kbd><span>Favourite the open image</span>
        </div>
        <div>
          <kbd>1</kbd><span>Rate from 1 to 5</span>
        </div>
        <div>
          <kbd>←</kbd><kbd>→</kbd><span>Move between images</span>
        </div>
        <div>
          <kbd>Ctrl</kbd><kbd>Z</kbd><span>Undo review decisions (repeatable)</span>
        </div>
        <div>
          <kbd>X</kbd><span>Pass in the Review Room</span>
        </div>
        <div>
          <kbd>Ctrl</kbd><kbd>K</kbd><span>Search the Archive</span>
        </div>
        <div>
          <kbd>Wheel</kbd><span>Zoom the moodboard at the cursor</span>
        </div>
        <div>
          <kbd>Space</kbd><span>Drag to pan the moodboard</span>
        </div>
        <div>
          <kbd>Esc</kbd><span>Close the current room</span>
        </div>
      </div>
      <div className="modal__actions">
        <button type="button" className="button button--gold" onClick={onClose}>
          Back to the atlas
        </button>
      </div>
    </Modal>
  )
}

export function ToastHost(): React.JSX.Element {
  const { toasts, dismissToast } = useAtlas()
  return createPortal(
    <div className="toast-host" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`}>
          <span className="toast__mark" aria-hidden="true">
            {toast.tone === 'error' ? '!' : toast.tone === 'success' ? '✓' : '✳'}
          </span>
          <span className="toast__message">{toast.message}</span>
          {toast.action ? (
            <button type="button" className="toast__action" onClick={() => { toast.action!.run(); dismissToast(toast.id) }} data-testid="toast-action">
              {toast.action.label}
            </button>
          ) : null}
          <button type="button" className="toast__close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}

export function Spinner({ size = 18, label = 'Loading' }: { size?: number; label?: string }): React.JSX.Element {
  return (
    <span className="spinner" style={{ width: size, height: size }} role="status" aria-label={label}>
      <span />
    </span>
  )
}

export function EmptyState({
  icon = 'sparkle',
  title,
  copy,
  children,
  className = ''
}: {
  icon?: 'sparkle' | 'heart' | 'search' | 'boards' | 'archive' | 'eye' | 'sources'
  title: string
  copy: string
  children?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={`empty-state ${className}`}>
      <div className="empty-state__mark">
        <Icon name={icon} size={26} strokeWidth={1.1} />
      </div>
      <h2 className="empty-state__title">{title}</h2>
      <p className="empty-state__copy">{copy}</p>
      {children ? <div className="empty-state__actions">{children}</div> : null}
    </div>
  )
}
