import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AssistantBlock, AssistantChat, AssistantChatSummary, AssistantMessage, AssistantSettings, AssistantTestResult, Basis } from '@shared/assistant'
import type { ImageItem, ReferenceWork } from '@shared/types'
import { RETOUCH_TOOLS } from '@shared/studio'
import { AtlasCharacter, type CharacterMood } from './AtlasCharacter'
import { CompanionSettings } from './CompanionSettings'
import { Lightbox } from './Lightbox'
import { Icon } from './Icon'
import { useAtlas } from '../lib/useAtlas'
import { friendlyError } from '../lib/format'
import { getViewing, onViewing, type Viewing } from '../lib/viewing'
import { parseChat, parseInline } from '../lib/chatMarkdown'
import { copyText } from '../lib/clipboard'
import { openStudio } from './Studio'
import { openViewer } from './StudioViewer'
import { Spinner } from './ui'
import { CuratedReview } from './CuratedReview'

export const OPEN_COMPANION_EVENT = 'atlas:open-companion'
/** Opens the companion and asks it something: `detail` is the question. */
export const ASK_COMPANION_EVENT = 'atlas:companion-ask'

const SUGGESTIONS = [
  'Find my most atmospheric landscape images',
  'What do my favorites have in common?',
  'Which artists might I enjoy discovering?',
  'Suggest creative directions based on my taste'
]

const BASIS_LABEL: Record<Basis, string> = { library: 'From your library notes', idea: 'An idea of mine', plain: '', seen: 'What I see in the pictures' }

function Inline({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.kind === 'bold' ? <strong key={i}>{part.text}</strong> : part.kind === 'italic' ? <em key={i}>{part.text}</em> : part.kind === 'code' ? <code key={i}>{part.text}</code> : <Fragment key={i}>{part.text}</Fragment>
      )}
    </>
  )
}

/** A button that copies exactly the text it is given, and says so. */
function CopyButton({ text, label, doneLabel = 'Copied', className = '', ariaLabel }: { text: string; label: string; doneLabel?: string; className?: string; ariaLabel?: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  const timer = useRef<number | null>(null)
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  return (
    <button
      type="button"
      className={`copy-button ${state === 'done' ? 'is-done' : ''} ${className}`}
      aria-label={ariaLabel ?? label}
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? 'done' : 'failed')
          if (timer.current) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setState('idle'), 1600)
        })
      }}
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} size={13} />
      <span>{state === 'done' ? doneLabel : state === 'failed' ? 'Could not copy' : label}</span>
    </button>
  )
}

/** One image-generation prompt with a clearly visible button that copies only the prompt itself. */
function PromptCard({ text, label }: { text: string; label: string }): React.JSX.Element {
  return (
    <div className="prompt-card" data-testid="prompt-card">
      <div className="prompt-card__head">
        <span className="prompt-card__label">{label}</span>
        <CopyButton text={text} label="Copy prompt" ariaLabel={`Copy ${label.toLowerCase()}`} className="copy-button--prompt" />
      </div>
      <p className="prompt-card__text" data-testid="prompt-text">{text}</p>
    </div>
  )
}

function RichText({ text }: { text: string }): React.JSX.Element {
  const parts = parseChat(text)
  return (
    <>
      {parts.map((part, index) => {
        switch (part.kind) {
          case 'heading':
            return <div key={index} className={`chat-h chat-h--${Math.min(part.level, 4)}`} role="heading" aria-level={Math.min(part.level + 2, 6)}><Inline text={part.text} /></div>
          case 'table':
            return (
              <div key={index} className="chat-table-wrap" data-testid="chat-table">
                <table className="chat-table">
                  <thead><tr>{part.header.map((cell, i) => <th key={i}><Inline text={cell} /></th>)}</tr></thead>
                  <tbody>{part.rows.map((row, r) => <tr key={r}>{part.header.map((_h, c) => <td key={c}><Inline text={row[c] ?? ''} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            )
          case 'list': {
            const Tag = part.ordered ? 'ol' : 'ul'
            return <Tag key={index} start={part.ordered ? part.start : undefined}>{part.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}</Tag>
          }
          case 'quote':
            return <blockquote key={index}><Inline text={part.text} /></blockquote>
          case 'code':
            return (
              <div key={index} className="chat-code">
                <CopyButton text={part.text} label="Copy" ariaLabel="Copy this block" className="copy-button--small" />
                <pre>{part.text}</pre>
              </div>
            )
          case 'prompt':
            return <PromptCard key={index} text={part.text} label={part.label} />
          case 'rule':
            return <hr key={index} />
          default:
            return <p key={index}><Inline text={part.text} /></p>
        }
      })}
    </>
  )
}

/** Everything Atlas said in a message as text, for "Copy response". */
function responseText(message: AssistantMessage): string {
  const pieces: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text' || block.type === 'note') pieces.push(block.text)
    else if (block.type === 'proposal' && block.proposal.kind === 'artwork') pieces.push(`Prompt: ${block.proposal.prompt}`)
    else if (block.type === 'works') pieces.push(`${block.label}:\n${block.works.map((w) => `- ${w.artist || 'Unknown maker'}, ${w.title}${w.date ? `, ${w.date}` : ''}`).join('\n')}`)
  }
  return pieces.join('\n\n').trim()
}

function Images({ block, onOpen }: { block: Extract<AssistantBlock, { type: 'images' }>; onOpen: (items: ImageItem[], index: number) => void }): React.JSX.Element | null {
  const items = block.items ?? []
  if (items.length === 0) return null
  return (
    <div className="chat-images">
      <div className="chat-images__label">{block.label} <span>{items.length}</span></div>
      <div className="chat-images__grid">
        {items.map((item, index) => (
          <button key={item.id} type="button" onClick={() => onOpen(items, index)} aria-label={`Open ${item.filename}`} style={{ background: item.color ?? undefined }}>
            {item.thumbStatus === 'ready' ? <img src={item.thumbUrl} alt={item.filename} loading="lazy" draggable={false} /> : <Icon name="image" size={18} />}
          </button>
        ))}
      </div>
    </div>
  )
}

function Works({ block }: { block: Extract<AssistantBlock, { type: 'works' }> }): React.JSX.Element {
  return (
    <div className="chat-works">
      <div className="chat-images__label">{block.label}</div>
      <div className="chat-works__row">
        {block.works.map((work: ReferenceWork) => (
          <figure key={work.id}>
            <img src={work.imageUrl} alt={work.title} loading="lazy" draggable={false} />
            <figcaption>
              <strong>{work.artist || 'Unknown maker'}</strong>
              <span>{work.title}{work.date ? `, ${work.date}` : ''}</span>
              <small>{work.museumName}</small>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  )
}

function Proposal({
  block,
  onAnswer,
  onStop,
  busy
}: {
  block: Extract<AssistantBlock, { type: 'proposal' }>
  onAnswer: (accept: boolean) => void
  onStop?: () => void
  busy: boolean
}): React.JSX.Element {
  return (
    <div className={`proposal proposal--${block.status}`}>
      <div className="proposal__eyebrow">A suggestion for you to decide</div>
      <strong>{block.title}</strong>
      {block.reason ? <p>{block.reason}</p> : null}
      {block.proposal.kind === 'board-change' ? (
        <div className="proposal__change" data-testid="board-change-preview">
          {block.removeItems?.length ? (
            <div>
              <small>Leaves the board</small>
              <div className="proposal__thumbs proposal__thumbs--out">
                {block.removeItems.slice(0, 8).map((item) => (item.thumbStatus === 'ready' ? <img key={item.id} src={item.thumbUrl} alt="" draggable={false} /> : null))}
              </div>
            </div>
          ) : null}
          {block.items?.length ? (
            <div>
              <small>Joins the board</small>
              <div className="proposal__thumbs">
                {block.items.slice(0, 8).map((item) => (item.thumbStatus === 'ready' ? <img key={item.id} src={item.thumbUrl} alt="" draggable={false} /> : null))}
              </div>
            </div>
          ) : null}
          {block.proposal.arrange !== 'keep' ? <small>{block.proposal.arrange === 'hero' ? 'Then the layout gives one picture the lead.' : 'Then the layout is tidied.'}</small> : null}
        </div>
      ) : block.proposal.kind === 'edit-plan' ? (
        <div className="proposal__plan" data-testid="plan-steps">
          <ol>
            {block.proposal.how.split('\n').slice(0, -1).map((line, i) => <li key={i}>{line.replace(/^\d+\.\s*/, '')}</li>)}
          </ol>
          <small>{block.proposal.how.split('\n').slice(-1)[0]}</small>
          <div className="proposal__thumbs">
            {(block.items ?? []).slice(0, 1).map((item) => (item.thumbStatus === 'ready' ? <img key={item.id} src={item.thumbUrl} alt="The starting picture" draggable={false} /> : null))}
          </div>
        </div>
      ) : block.proposal.kind === 'artwork' ? (
        <div className="proposal__artwork">
          <q>{block.proposal.prompt}</q>
          <CopyButton text={block.proposal.prompt} label="Copy prompt" ariaLabel="Copy this prompt" className="copy-button--prompt" />
          <div className="proposal__thumbs">
            {(block.items ?? []).slice(0, 8).map((item) => (item.thumbStatus === 'ready' ? <img key={item.id} src={item.thumbUrl} alt="" draggable={false} /> : null))}
          </div>
        </div>
      ) : (
        <div className="proposal__thumbs">
          {(block.items ?? []).slice(0, 8).map((item) => (item.thumbStatus === 'ready' ? <img key={item.id} src={item.thumbUrl} alt="" draggable={false} /> : null))}
          {block.proposal.imageIds.length > 8 ? <span>+{block.proposal.imageIds.length - 8}</span> : null}
        </div>
      )}
      {block.status === 'running' ? (
        <div className="proposal__running" data-testid="plan-running" role="status">
          <Spinner size={13} label="Working" /> <span>{block.result}</span>
          {onStop ? <button type="button" className="button button--ghost" onClick={onStop}>Stop</button> : null}
          {block.resultItems?.length ? (
            <div className="proposal__thumbs proposal__thumbs--results">
              {block.resultItems.map((item) => (item.thumbStatus === 'ready' ? <button key={item.id} type="button" onClick={() => openViewer({ imageId: item.id })}><img src={item.thumbUrl} alt={item.filename} draggable={false} /></button> : null))}
            </div>
          ) : null}
        </div>
      ) : block.status === 'pending' ? (
        <div className="proposal__actions">
          <button type="button" className="button button--gold" disabled={busy} onClick={() => onAnswer(true)} data-testid="proposal-accept">{block.proposal.kind === 'look' ? 'Send these pictures' : block.proposal.kind === 'edit-plan' ? 'Do this now' : block.proposal.kind === 'external-edit' ? `Open in ${block.proposal.editorName}` : block.proposal.kind === 'artwork' ? 'Open in the Studio' : block.proposal.kind === 'edit' ? 'Open the Edit tab' : block.proposal.kind === 'retouch' ? `Open ${RETOUCH_TOOLS[block.proposal.tool].label}` : block.proposal.kind === 'upscale' ? 'Open Upscale' : block.proposal.kind === 'open-models' ? 'Open the Model Library' : block.proposal.kind === 'board-change' ? 'Apply the change' : 'Accept'}</button>
          <button type="button" className="button button--ghost" disabled={busy} onClick={() => onAnswer(false)}>Not now</button>
          <small>{block.proposal.kind === 'look' ? `These pictures leave this computer and go to ${block.proposal.providerLabel}${block.proposal.model ? ` (${block.proposal.model})` : ''}. Only these ${block.proposal.imageIds.length}, only now. Your files are not changed, and nothing is sent if you say no.` : block.proposal.kind === 'edit-plan' ? 'Runs on this computer. Nothing is uploaded or paid for, and your originals are never changed.' : block.proposal.kind === 'external-edit' ? 'Opens a copy. Your original is not touched.' : block.proposal.kind === 'open-models' ? 'Nothing is downloaded until you agree in the library.' : block.proposal.kind === 'artwork' || block.proposal.kind === 'edit' || block.proposal.kind === 'retouch' || block.proposal.kind === 'upscale' ? 'Nothing is made until you approve it in the Studio or viewer.' : block.proposal.kind === 'board-change' ? 'Nothing changes until you apply it, and you can undo it.' : 'Nothing changes until you accept.'}</small>
        </div>
      ) : (
        <p className="proposal__result"><Icon name={block.status === 'applied' ? 'check' : 'close'} size={13} /> {block.result}</p>
      )}
    </div>
  )
}

function Message({
  message,
  chatId,
  onOpenImages,
  onProposal,
  busy
}: {
  message: AssistantMessage
  chatId: string
  onOpenImages: (items: ImageItem[], index: number) => void
  onProposal: (proposalId: string, accept: boolean, options?: { selection: string[]; name: string; boardId: string | null }) => void
  busy: boolean
}): React.JSX.Element {
  if (message.role === 'user') {
    return <div className="chat-msg chat-msg--user"><div className="chat-bubble"><RichText text={message.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')} /></div></div>
  }
  return (
    <div className="chat-msg chat-msg--atlas">
      <span className="chat-msg__avatar"><AtlasCharacter size={30} mood="idle" /></span>
      <div className="chat-msg__body">
        {message.blocks.map((block, index) => {
          if (block.type === 'text') {
            // The label is shown once for a run of paragraphs with the same basis.
            const previous = message.blocks[index - 1]
            const repeated = previous?.type === 'text' && previous.basis === block.basis
            return (
              <div key={index} className={`chat-text chat-text--${block.basis}`}>
                {block.basis !== 'plain' && !repeated ? <span className="chat-text__basis">{BASIS_LABEL[block.basis]}</span> : null}
                <RichText text={block.text} />
              </div>
            )
          }
          if (block.type === 'looked') {
            return (
              <div key={index} className="chat-looked" data-testid="looked-block">
                <div className="chat-looked__head">
                  <Icon name="eye" size={13} />
                  <strong>Looked at directly</strong>
                  <span>
                    {block.compare ? 'compared ' : ''}{block.ids.length} picture{block.ids.length === 1 ? '' : 's'}{block.focus ? `, a close look at ${block.focus}` : block.detail === 'close' ? ', in close detail' : ''} · {block.local ? `by ${block.provider} on this computer` : `sent to ${block.provider}${block.model ? ` (${block.model})` : ''} with your approval`}
                  </span>
                </div>
                <div className="chat-looked__thumbs">
                  {(block.items ?? []).map((item, i) => (item.thumbStatus === 'ready' ? <button key={item.id} type="button" onClick={() => openViewer({ imageId: item.id })} title={item.filename}><img src={item.thumbUrl} alt={`${block.compare ? 'Version' : 'Picture'} ${i + 1}`} draggable={false} /><em>{block.compare ? 'Version' : 'Picture'} {i + 1}</em></button> : null))}
                </div>
                <small>The paragraphs below marked “What I see in the pictures” are direct observations; “From your library notes” and “An idea of mine” are not.</small>
              </div>
            )
          }
          if (block.type === 'images') return <Images key={index} block={block} onOpen={onOpenImages} />
          if (block.type === 'works') return <Works key={index} block={block} />
          if (block.type === 'proposal' && block.proposal.kind === 'curated-moodboard') {
            return (
              <CuratedReview
                key={index}
                block={block}
                busy={busy}
                onOpenImages={onOpenImages}
                onSelection={(ids) => void window.noema.assistantReviewCuration(chatId, block.id, ids)}
                onAnswer={(accept, options) => onProposal(block.id, accept, options)}
              />
            )
          }
          if (block.type === 'proposal') return <Proposal key={index} block={block} busy={busy} onAnswer={(accept) => onProposal(block.id, accept)} onStop={() => void window.noema.assistantStop(chatId)} />
          return <p key={index} className="chat-note">{block.text}</p>
        })}
        {responseText(message) ? (
          <div className="chat-msg__actions">
            <CopyButton text={responseText(message)} label="Copy response" ariaLabel="Copy response" className="copy-button--response" />
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Atlas as a companion: a small character in the corner that opens a conversation. */
export function Companion(): React.JSX.Element {
  const { toast } = useAtlas()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'chat' | 'settings' | 'history'>('chat')
  const [chat, setChat] = useState<AssistantChat | null>(null)
  const [chats, setChats] = useState<AssistantChatSummary[]>([])
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [needs, setNeeds] = useState<'consent' | 'setup' | null>(null)
  const [viewer, setViewer] = useState<{ items: ImageItem[]; index: number } | null>(null)
  const [mood, setMood] = useState<CharacterMood>('idle')
  const [hello, setHello] = useState<{ text: string; who: string } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const chatRef = useRef<AssistantChat | null>(null)
  chatRef.current = chat
  // The picture open in a viewer behind the panel, so it can be named in the conversation and "this picture" means it.
  const [viewing, setViewingNow] = useState<Viewing | null>(getViewing())
  useEffect(() => {
    setViewingNow(getViewing())
    return onViewing(() => setViewingNow(getViewing()))
  }, [])

  // While open, the panel takes its own column beside the workspace (on wide windows), so it never covers a control.
  useEffect(() => {
    document.documentElement.dataset.companion = open ? 'open' : 'closed'
    return () => {
      document.documentElement.dataset.companion = 'closed'
    }
  }, [open])

  useEffect(() => {
    const toggle = (): void => setOpen((value) => !value)
    window.addEventListener(OPEN_COMPANION_EVENT, toggle)
    return () => window.removeEventListener(OPEN_COMPANION_EVENT, toggle)
  }, [])

  // Other parts of the window can open the companion with a question ("Curate with Atlas").
  const sendRef = useRef<(text: string) => Promise<void>>(async () => undefined)
  useEffect(() => {
    const ask = (event: Event): void => {
      const text = String((event as CustomEvent<string>).detail ?? '').trim()
      setOpen(true)
      setView('chat')
      if (text) window.setTimeout(() => void sendRef.current(text), 250)
    }
    window.addEventListener(ASK_COMPANION_EVENT, ask)
    return () => window.removeEventListener(ASK_COMPANION_EVENT, ask)
  }, [])

  // A plan that was approved keeps working after the answer came back; its progress and results arrive here.
  useEffect(() => window.noema.onAssistantChatChanged(({ chatId }) => {
    if (chatRef.current && chatRef.current.id === chatId) void window.noema.assistantChat(chatId).then((c) => c && setChat(c))
  }), [])

  useEffect(() => window.noema.onAssistantProgress((p) => {
    if (!chatRef.current || p.chatId === chatRef.current.id || chatRef.current.messages.length === 0) setProgress(p.text)
  }), [])

  const loadChats = useCallback(async () => {
    try {
      const list = await window.noema.assistantChats()
      setChats(list)
      return list
    } catch {
      return []
    }
  }, [])

  // Load the settings and the latest conversation the first time the panel opens.
  const loaded = useRef(false)
  useEffect(() => {
    if (!open || loaded.current) return
    loaded.current = true
    void (async () => {
      try {
        setSettings(await window.noema.assistantSettings())
        const list = await loadChats()
        if (list[0]) setChat(await window.noema.assistantChat(list[0].id))
      } catch (error) {
        toast(friendlyError(error), 'error')
      }
    })()
  }, [open, loadChats, toast])

  useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 120)
  }, [open, view])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [chat?.messages.length, busy])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      // Esc closes the panel when it is the thing being used, even with a viewer open behind it.
      const inside = (event.target as HTMLElement | null)?.closest?.('.companion') != null
      if (event.key === 'Escape' && !viewer && (inside || !document.querySelector('[role="dialog"]'))) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, viewer])

  useEffect(() => {
    if (busy) setMood('thinking')
    else if (mood === 'thinking') {
      setMood('happy')
      const timer = window.setTimeout(() => setMood('idle'), 1800)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [busy, mood])

  /** The chosen model has answered a real request: go back to the conversation and let Atlas say hello, once. */
  const welcome = (result: AssistantTestResult): void => {
    setView('chat')
    if (!result.greeting) return
    setHello({ text: result.greeting, who: `${result.providerLabel} · ${result.model}` })
    setMood('hello')
    window.setTimeout(() => setMood((m) => (m === 'hello' ? 'idle' : m)), 3000)
  }

  const send = async (raw: string): Promise<void> => {
    const message = raw.trim()
    if (!message || busy) return
    setHello(null)
    setInput('')
    setBusy(true)
    setNeeds(null)
    setView('chat')
    // Show the question at once.
    const now = Date.now()
    setChat((current) => ({
      id: current?.id ?? 'pending',
      title: current?.title ?? message,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      messages: [...(current?.messages ?? []), { id: `local-${now}`, role: 'user', at: now, blocks: [{ type: 'text', basis: 'plain', text: message }] }]
    }))
    try {
      const reply = await window.noema.assistantSend(chat && chat.id !== 'pending' ? chat.id : null, message, { viewingImageId: getViewing()?.imageId ?? null })
      setChat(reply.chat)
      setNeeds(reply.needs ?? null)
      void loadChats()
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  sendRef.current = send

  const answerProposal = async (proposalId: string, accept: boolean, options?: { selection: string[]; name: string; boardId: string | null }): Promise<void> => {
    if (!chat) return
    setBusy(true)
    try {
      const updated = await window.noema.assistantProposal(chat.id, proposalId, accept, options)
      setChat(updated)
      if (accept) setMood('happy')
      // An accepted artwork concept opens in the Creative Studio, where prompt, method and price are reviewed.
      const accepted = updated.messages.flatMap((m) => m.blocks).find((b) => b.type === 'proposal' && b.id === proposalId)
      if (accept && accepted && accepted.type === 'proposal' && accepted.proposal.kind === 'edit') {
        window.dispatchEvent(new CustomEvent('atlas:open-studio', { detail: { mode: 'edit', imageId: accepted.proposal.imageId, instruction: accepted.proposal.instruction, strength: accepted.proposal.strength, level: accepted.proposal.level, region: accepted.proposal.region, references: accepted.proposal.references } }))
      }
      if (accept && accepted && accepted.type === 'proposal' && accepted.proposal.kind === 'retouch') {
        const p = accepted.proposal
        window.dispatchEvent(new CustomEvent('atlas:open-studio', { detail: { mode: 'retouch', imageId: p.imageId, tool: p.tool, region: p.region, strength: p.strength, edgeAware: p.edgeAware, tone: p.tone, hint: p.hint } }))
      }
      if (accept && accepted && accepted.type === 'proposal' && accepted.proposal.kind === 'organize-export') {
        window.location.hash = `#/organizer/${encodeURIComponent(accepted.proposal.planId)}`
      }
      if (accept && accepted && accepted.type === 'proposal' && accepted.proposal.kind === 'open-models') {
        window.dispatchEvent(new CustomEvent('atlas:open-model-library', { detail: { entry: accepted.proposal.entryId } }))
      }
      if (accept && accepted && accepted.type === 'proposal' && accepted.proposal.kind === 'upscale') {
        openViewer({ imageId: accepted.proposal.imageId, panel: 'upscale', target: accepted.proposal.targetLongEdge })
      }
      if (accept && accepted && accepted.type === 'proposal' && accepted.proposal.kind === 'artwork') {
        const p = accepted.proposal
        openStudio({ mode: 'create', boardId: p.boardId, prompt: p.prompt, negative: p.negative, aspect: p.aspect, roles: p.roles, title: p.title, intent: '' })
      }
    } catch (error) {
      toast(friendlyError(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  const newChat = (): void => {
    setChat(null)
    setNeeds(null)
    setView('chat')
  }

  const stop = (): void => {
    if (chat) void window.noema.assistantStop(chat.id)
  }

  const where = settings
    ? settings.provider === 'basics'
      ? 'Atlas basics · offline'
      : settings.verified
        ? `${settings.providerLabel} · ${settings.model}`
        : `${settings.providerLabel} · not verified yet`
    : ''
  const empty = !chat || chat.messages.length === 0

  // Rendered at the top of the document, not inside the app shell, so it stays above every full-screen viewer.
  return createPortal(
    <>
      <button
        type="button"
        className={`companion-launcher ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? 'Close the Atlas companion' : 'Talk to Atlas (Ctrl+J)'}
        title="Talk to Atlas (Ctrl+J)"
        aria-expanded={open}
      >
        <AtlasCharacter size={46} mood={open ? (busy ? 'thinking' : mood) : 'idle'} />
      </button>

      {open ? (
        <section className="companion" role="complementary" aria-label="Atlas companion">
          <header className="companion__head">
            <AtlasCharacter size={38} mood={busy ? 'thinking' : mood} label="Atlas" />
            <div className="companion__title">
              <strong>Atlas</strong>
              <span>{where}</span>
            </div>
            <div className="companion__tools">
              <button type="button" className="icon-button" onClick={newChat} aria-label="New conversation" title="New conversation"><Icon name="plus" size={16} /></button>
              <button type="button" className="icon-button" onClick={() => { setView(view === 'history' ? 'chat' : 'history'); void loadChats() }} aria-label="Earlier conversations" title="Earlier conversations"><Icon name="rows" size={16} /></button>
              <button type="button" className="icon-button" onClick={() => setView(view === 'settings' ? 'chat' : 'settings')} aria-label="Where Atlas thinks" title="Where Atlas thinks"><Icon name="sparkle" size={16} /></button>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close" title="Close (Esc)"><Icon name="close" size={16} /></button>
            </div>
          </header>

          {view === 'settings' ? (
            <div className="companion__scroll">
              <CompanionSettings onDone={() => setView('chat')} onChanged={setSettings} onVerified={welcome} />
            </div>
          ) : view === 'history' ? (
            <div className="companion__scroll companion__history">
              <h3>Earlier conversations</h3>
              {chats.length === 0 ? <p className="hint">Nothing yet.</p> : null}
              {chats.map((entry) => (
                <div key={entry.id} className="history-row">
                  <button type="button" onClick={() => void (async () => { setChat(await window.noema.assistantChat(entry.id)); setView('chat') })()}>
                    <span>{entry.title}</span>
                    <small>{new Date(entry.updatedAt).toLocaleDateString()}</small>
                  </button>
                  <button type="button" className="icon-button" aria-label={`Delete ${entry.title}`} onClick={() => void (async () => { await window.noema.assistantDeleteChat(entry.id); if (chat?.id === entry.id) setChat(null); await loadChats() })()}><Icon name="trash" size={14} /></button>
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="companion__scroll" ref={scroller}>
                {hello ? (
                  <button type="button" className="companion__hello" onClick={() => setHello(null)} title="Dismiss">
                    <q>{hello.text}</q>
                    <small>{hello.who} is ready</small>
                  </button>
                ) : null}
                {empty ? (
                  <div className="companion__welcome">
                    <AtlasCharacter size={84} mood="curious" />
                    <h3>Hello. Shall we look at your pictures?</h3>
                    <p>I know your library, your favorites and your moodboards. Ask me anything about them, or try one of these:</p>
                    <div className="companion__chips">
                      {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => void send(s)}>{s}</button>)}
                    </div>
                    {settings?.provider === 'basics' ? (
                      <p className="hint">I am using my built-in basics, which work offline. <button type="button" className="link-button" onClick={() => setView('settings')}>Connect a language model</button> for open conversation.</p>
                    ) : null}
                  </div>
                ) : (
                  chat!.messages.map((message) => (
                    <Message key={message.id} message={message} chatId={chat!.id} busy={busy} onOpenImages={(items, index) => setViewer({ items, index })} onProposal={(id, accept, options) => void answerProposal(id, accept, options)} />
                  ))
                )}
                {busy ? (
                  <div className="chat-msg chat-msg--atlas chat-thinking" role="status" aria-live="polite">
                    <span className="chat-msg__avatar"><AtlasCharacter size={30} mood="thinking" /></span>
                    <div className="chat-msg__body"><span className="chat-dots"><i /><i /><i /></span> {progress || 'Thinking…'} <button type="button" className="link-button" onClick={stop}>Stop</button></div>
                  </div>
                ) : null}
                {needs ? (
                  <div className="chat-needs">
                    <button type="button" className="button button--gold" onClick={() => setView('settings')}>{needs === 'consent' ? 'Review what would be shared' : 'Open the settings'}</button>
                  </div>
                ) : null}
              </div>
              {viewing ? (
                <p className="companion__viewing" data-testid="companion-viewing" title="Atlas knows which picture you have open. Only its name is shared; its pixels are never sent without your consent.">
                  <Icon name="image" size={12} /> Looking at <strong>{viewing.filename}</strong>
                </p>
              ) : null}
              <form className="companion__form" onSubmit={(event) => { event.preventDefault(); void send(input) }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  rows={1}
                  maxLength={4000}
                  placeholder="Ask about your images, taste or moodboards…"
                  aria-label="Message to Atlas"
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void send(input)
                    }
                  }}
                />
                <button type="submit" className="button button--gold companion__send" disabled={busy || input.trim() === ''} aria-label="Send"><Icon name="arrowRight" size={16} /></button>
              </form>
            </>
          )}
        </section>
      ) : null}

      {viewer ? <Lightbox items={viewer.items} initialIndex={viewer.index} onClose={() => setViewer(null)} onUpdate={() => undefined} /> : null}
    </>,
    document.body
  )
}
