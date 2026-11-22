/**
 * A small, safe Markdown reader for the Atlas companion. It understands what language models actually write in a
 * chat: headings, lists, quotes, rules, fenced blocks, bold, italics and code, and it recognises image-generation
 * prompts (labelled lines, prompt blocks and lines with Midjourney-style flags) so each can be copied on its own.
 * Nothing here produces HTML: the window renders the parts as ordinary elements.
 */

export type ChatPart =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string; lang: string }
  /** An image-generation prompt. `text` is only the prompt, ready to paste. */
  | { kind: 'prompt'; text: string; label: string }
  | { kind: 'rule' }
  /** A table: the header cells and the rows of cells (each cell may carry bold, italics and code). */
  | { kind: 'table'; header: string[]; rows: string[][] }

export type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }

const FLAGS = /(^|\s)--(ar|stylize|v|s|style|chaos|no|q|seed|niji|iw)\b/

const LABELLED_PROMPT =
  /^\s*(?:(?:[-*•]|\d+[.)])\s+)?(?:\*\*|__)?\s*(?:(?:image|ai|art|midjourney|dall[-· ]?e|stable diffusion)\s+)?prompt(?:\s*(?:#|no\.?|nr\.?)?\s*\d+)?\s*(?:\*\*|__)?\s*[:：–—-]\s*(?:\*\*|__)?\s*(\S.*)$/i

/** Removes the list marker, wrapping quotes, backticks and emphasis from a prompt, leaving only its words. */
export function cleanPrompt(raw: string): string {
  let text = raw.trim()
  text = text.replace(/^\s*(?:(?:[-*•]|\d+[.)])\s+)/, '')
  for (let i = 0; i < 3; i += 1) {
    const before = text
    text = text.replace(/^(\*\*|__)(.*)\1$/s, '$2').trim()
    text = text.replace(/^`([^`]*)`$/s, '$1').trim()
    text = text.replace(/^[“"«](.*)[”"»]$/s, '$1').trim()
    text = text.replace(/^'(.*)'$/s, '$1').trim()
    if (text === before) break
  }
  return text
}

/** The prompt in a line, or null when the line is not one. */
export function promptInLine(line: string): { text: string; label: string } | null {
  const labelled = LABELLED_PROMPT.exec(line)
  if (labelled) {
    const text = cleanPrompt(labelled[1]!)
    return text ? { text, label: labelLabel(line) } : null
  }
  const flag = FLAGS.exec(line)
  // A real prompt has a description before its flags; "use --ar 16:9" is only advice about flags.
  if (flag && line.slice(0, flag.index).trim().split(/\s+/).filter(Boolean).length >= 4) {
    const text = cleanPrompt(line)
    return text ? { text, label: 'Prompt' } : null
  }
  return null
}

function labelLabel(line: string): string {
  const match = /prompt(?:\s*(?:#|no\.?|nr\.?)?\s*(\d+))?/i.exec(line)
  return match?.[1] ? `Prompt ${match[1]}` : 'Prompt'
}

const mentionsPrompt = (line: string): boolean => /prompt/i.test(line)

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** The cells of one table row, without the outer pipes. */
function tableCells(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

export function parseChat(source: string): ChatPart[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const parts: ChatPart[] = []
  let list: { ordered: boolean; start: number; items: string[] } | null = null
  let quote: string[] = []
  /** The last heading or line said "prompt": a block or quote that follows is a prompt. */
  let promptAhead: string | null = null

  const flushList = (): void => {
    if (list) parts.push({ kind: 'list', ...list })
    list = null
  }
  const flushQuote = (): void => {
    if (quote.length === 0) return
    const text = quote.join('\n').trim()
    if (text) {
      if (promptAhead) parts.push({ kind: 'prompt', text: cleanPrompt(text), label: promptAhead })
      else parts.push({ kind: 'quote', text })
    }
    promptAhead = null
    quote = []
  }
  const flush = (): void => {
    flushList()
    flushQuote()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!

    const fence = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      index += 1
      while (index < lines.length && !new RegExp(`^\\s*${fence[1]!.slice(0, 3)}`).test(lines[index]!)) {
        body.push(lines[index]!)
        index += 1
      }
      const text = body.join('\n').replace(/\s+$/, '')
      const lang = (fence[2] ?? '').toLowerCase()
      if (text.trim() !== '') {
        const isPrompt = lang === 'prompt' || promptAhead !== null || FLAGS.test(text)
        if (isPrompt) parts.push({ kind: 'prompt', text: text.trim(), label: promptAhead ?? 'Prompt' })
        else parts.push({ kind: 'code', text, lang })
      }
      promptAhead = null
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    // A table: a row of cells, then a separator row of dashes, then more rows. Shown as a real table, never as raw pipes.
    if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1]!)) {
      flush()
      const header = tableCells(line)
      const rows: string[][] = []
      let next = index + 2
      while (next < lines.length && lines[next]!.includes('|') && lines[next]!.trim() !== '') {
        rows.push(tableCells(lines[next]!))
        next += 1
      }
      parts.push({ kind: 'table', header, rows })
      index = next - 1
      promptAhead = null
      continue
    }

    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (quoted) {
      flushList()
      quote.push(quoted[1]!)
      continue
    }
    flushQuote()

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushList()
      parts.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, text: heading[2]! })
      promptAhead = mentionsPrompt(heading[2]!) ? 'Prompt' : null
      continue
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushList()
      parts.push({ kind: 'rule' })
      promptAhead = null
      continue
    }

    const prompt = promptInLine(line)
    if (prompt) {
      flushList()
      parts.push({ kind: 'prompt', text: prompt.text, label: prompt.label })
      promptAhead = null
      continue
    }

    const bullet = /^\s*([-*•])\s+(.*)$/.exec(line)
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, start: numbered ? Number(numbered[1]) : 1, items: [] }
      list.items.push((bullet ?? numbered)![2]!)
      continue
    }

    flushList()
    parts.push({ kind: 'paragraph', text: line.trim() })
    // "Here is the prompt:" announces that the next block or quote is the prompt itself.
    promptAhead = mentionsPrompt(line) && /[:：]\s*(\*\*|__)?\s*$/.test(line.trim()) ? labelLabel(line) : null
  }
  flush()
  return parts
}

/** Bold, italic and code inside a line. Unmatched markers stay as they were typed. */
export function parseInline(text: string): InlinePart[] {
  const out: InlinePart[] = []
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<![\w_])_[^_\s][^_\n]*_(?![\w_])|\[[^\]\n]+\]\([^)\s]+\))/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const token = match[0]
    const start = match.index ?? 0
    if (start > last) out.push({ kind: 'text', text: text.slice(last, start) })
    if (token.startsWith('**') || token.startsWith('__')) out.push({ kind: 'bold', text: token.slice(2, -2) })
    else if (token.startsWith('`')) out.push({ kind: 'code', text: token.slice(1, -1) })
    else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!
      // Links are shown as text with their address, never as something to click: the panel must not navigate away.
      out.push({ kind: 'text', text: link[1] === link[2] ? link[1]! : `${link[1]} (${link[2]})` })
    } else out.push({ kind: 'italic', text: token.slice(1, -1) })
    last = start + token.length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** Every prompt in a piece of text, in order. */
export function promptsIn(source: string): string[] {
  return parseChat(source).flatMap((part) => (part.kind === 'prompt' ? [part.text] : []))
}
