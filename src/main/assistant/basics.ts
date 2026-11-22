import type { AssistantBlock, Basis } from '../../shared/assistant'
import { countFromText, levelFromText, regionFromInstruction } from '../studio/editLanguage'
import { subjectFromText } from '../studio/atlasWorkflows'
import type { Tool, ToolResult, ToolSession } from './tools'
import { readIntent } from './intent'

/**
 * "Atlas basics": the assistant without any language model. It understands a handful of everyday requests with simple
 * rules and answers them with the same tools the language-model assistant uses, so Atlas stays useful and fully
 * offline when nothing is configured. It is honest about being simple.
 */
export interface BasicsInput {
  text: string
  /** Images shown most recently in this conversation, for requests that refer to "these". */
  lastImageIds: string[]
}

export interface BasicsOutput {
  blocks: AssistantBlock[]
}

const say = (text: string, basis: Basis = 'plain'): AssistantBlock => ({ type: 'text', basis, text })

export const HELP_TEXT =
  'I can look through your library, read what your favorites share, suggest what would fit a moodboard, and suggest where to look next. Try:\n' +
  '• find my most atmospheric landscape images\n' +
  '• what do my favorites have in common?\n' +
  '• which artists might I enjoy?\n' +
  '• find images that would complement my "Name" moodboard\n' +
  '• suggest creative directions\n' +
  '• write prompts from these images\n' +
  'For longer conversations, connect a language model in my settings. It is optional.'

function cleanQuery(text: string): string {
  return text
    .replace(/[?!.]+$/g, '')
    .replace(/^\s*(please\s+)?(can you\s+|could you\s+)?(find|show|search for|search|look for|get|hitta|visa|sök)\s+(me\s+)?/i, '')
    .replace(/\b(my|all|some|the|mina|alla)\s+/gi, ' ')
    .replace(/\b(most|best)\s+/gi, ' ')
    .replace(/\b(images?|pictures?|photos?|bilder|bild)\s+(of|with|about|that|som|på)\s+/i, '')
    .replace(/\b(images?|pictures?|photos?|bilder)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function call(tools: Tool[], name: string, args: Record<string, unknown>, session: ToolSession): Promise<ToolResult> {
  const tool = tools.find((t) => t.spec.name === name)
  if (!tool) return { model: { error: 'missing tool' }, blocks: [] }
  return tool.run(args, session)
}

function boardNameIn(text: string, session: ToolSession): string {
  const quoted = text.match(/["“”']([^"“”']{1,60})["“”']/)
  if (quoted) return quoted[1]!.trim()
  const lower = text.toLowerCase()
  for (const board of session.ctx.db.listMoodboards()) if (lower.includes(board.name.toLowerCase())) return board.name
  return ''
}

type Described = { ref: string; looks_like?: string[]; tags?: string[]; dominant_colour?: string }

function promptFrom(entry: Described, index: number): string {
  const [subject, mood, style, colour] = entry.looks_like ?? []
  const parts = [subject ?? entry.tags?.[0] ?? 'a quiet scene']
  if (mood) parts.push(`${mood} atmosphere`)
  if (style) parts.push(style)
  if (colour) parts.push(`${colour} palette`)
  parts.push(index % 2 === 0 ? 'soft natural light, wide composition' : 'dramatic light, close framing')
  return `${parts.join(', ')} --ar ${index % 2 === 0 ? '3:2' : '4:5'} --stylize 250`
}

type Run = (name: string, args?: Record<string, unknown>) => Promise<ToolResult>

/**
 * Answers "what is my taste / what do my favorites share" from the Artistic Identity engine (favorites measured against
 * the reference collection) and the Taste Compass (choices in comparisons). No image search. Observations come from the
 * user's own choices; where evidence is thin it says so.
 */
async function answerTaste(run: Run, blocks: AssistantBlock[], favoritesFocus = false): Promise<void> {
  const identity = await run('favorites_profile')
  const taste = await run('taste_summary')
  const model = identity.model as {
    available: boolean
    reason?: string
    tentative?: boolean
    favorites?: number
    overall_reliable_qualities?: string[]
    groups?: Array<{ group: string; favorites_in_group: number; reliable_qualities: string[]; tentative: boolean }>
  }
  const compass = taste.model as { available?: boolean; comparisons?: number; leanings?: Array<{ quality: string; comparisons: number }> }
  const lines: string[] = []
  if (model.available) {
    lines.push(
      `You have ${model.favorites} favorites. ${model.tentative ? 'That is a small base, so treat this as tentative. ' : ''}` +
        (model.overall_reliable_qualities?.length
          ? `Across all of them, these qualities stand out reliably: ${model.overall_reliable_qualities.join(', ')}.`
          : 'No single quality stands out reliably across all of them yet.')
    )
  }
  if (compass.available && compass.leanings?.length) {
    lines.push(`In the Taste comparisons (${compass.comparisons} choices) you lean towards: ${compass.leanings.slice(0, 6).map((l) => l.quality).join(', ')}.`)
  }
  if (lines.length === 0) {
    const why = model.reason ?? (compass.available === false ? (taste.model as { reason?: string }).reason : undefined)
    blocks.push(
      say(
        `I cannot describe your taste yet. ${why ?? ''} It grows from what you do: mark at least three favorites, or answer some pairs in the Taste room, and ask again.`.replace(/\s+/g, ' ')
      )
    )
    return
  }
  blocks.unshift(say(lines.join('\n'), 'library'))
  for (const group of model.groups ?? []) {
    blocks.push(
      say(
        `Group “${group.group}” (${group.favorites_in_group} favorites${group.tentative ? ', tentative' : ''}): ${group.reliable_qualities.length ? group.reliable_qualities.join(', ') : 'no quality stands out reliably yet'}.`,
        'library'
      )
    )
  }
  if ((model.groups?.length ?? 0) > 1) blocks.push(say('Several groups are shown separately on purpose: loving different things is not an average of them.'))
  if (!favoritesFocus) blocks.push(say('This describes your choices, not a verdict. I can also look for images in one of these directions if you ask.'))
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  en: 1, ett: 1, två: 2, tre: 3, fyra: 4, fem: 5, sex: 6, sju: 7, åtta: 8, nio: 9, tio: 10, tolv: 12, femton: 15, tjugo: 20, trettio: 30
}

/** "ten", "10" or "tio" in a request, or null. */
interface RetouchClause { tool: 'remove' | 'heal' | 'blur' | 'sharpen' | 'tone'; verb: string; region?: string; what: string; strength: number; edgeAware: boolean; tone?: 'lighten' | 'darken' }

const RETOUCH_VERBS: Array<{ tool: RetouchClause['tool']; verb: string; re: RegExp }> = [
  { tool: 'remove', verb: 'Remove', re: /\b(remove|erase|delete|get rid of|take (?:it |this |that )?(?:out|away)|clean up|retouch out|ta bort|radera)\b/i },
  { tool: 'heal', verb: 'Heal', re: /\b(heal|repair|blemish(?:es)?|patch up|fix the (?:texture|seam|scratch|damage\w*)|reparera)\b/i },
  { tool: 'blur', verb: 'Soften', re: /\b(blur|soften|smooth(?:en)?|defocus|de-?sharpen|suddig\w*|mjuka?\w*)\b/i },
  { tool: 'sharpen', verb: 'Sharpen', re: /\b(sharpen|crisp(?:er|en)?|restore (?:the )?detail|skärp\w*)\b/i },
  { tool: 'tone', verb: 'Lighten', re: /\b(brighten|lighten|darken|dodge|burn|ljusare|mörkare)\b/i }
]
const PART_WORDS = /\b(face|faces|hand|hands|hair|eyes?|skin|cheek|nose|mouth|person|people|figure|man|woman|child|hat|dress|building|architecture|tree|trees|car|text|logo|object|artifact|artefact|detail|details|edge|edges|texture|flaw|stain|spot|mark|window|door|wall|water|flower|flowers|animal|dog|cat|horse|bird)\b/i

/** Reads a request such as "brighten the face slightly and darken the background" as separate retouching clauses. */
export function parseRetouch(raw: string): RetouchClause[] {
  const out: RetouchClause[] = []
  const parts = raw.split(/\s*(?:,|;|\band then\b|\bthen\b|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean)
  let carry: string | null = null
  for (const part of parts) {
    // "but preserve the eyes" says what to keep; it is not a step.
    if (/^(?:but |while |and )?(?:keep|preserve|leave|retain|don'?t touch|without)\b/i.test(part)) continue
    const hit = RETOUCH_VERBS.find((v) => v.re.test(part))
    const text = hit ? part : carry ? `${carry} ${part}` : part
    const verb = hit ?? (carry ? RETOUCH_VERBS.find((v) => v.re.test(carry!)) : undefined)
    if (!verb) continue
    carry = hit ? part : carry
    const t = text.toLowerCase()
    const named = regionFromInstruction(part.replace(/\b(?:but|while)\b.*$/i, ''))
    const thing = PART_WORDS.exec(part)?.[0]
    // A named part (sky, background...) is reliable; "the face", "the hair", an object or a flaw is not.
    // "the person on the left" is a person, not the left side of the picture: when the words name a thing, the user marks it.
    const region = thing ? undefined : named ?? undefined
    const tone = /\b(darken|burn|mörkare)\b/i.test(t) ? 'darken' : 'lighten'
    const strength = /\b(slightly|gently|a (?:little|touch|bit)|subtly|lightly|lätt|något)\b/i.test(t) ? 0.25 : /\b(strongly|heavily|very|a lot|completely|kraftigt)\b/i.test(t) ? 0.85 : verb.tool === 'blur' ? 0.5 : verb.tool === 'sharpen' ? 0.45 : verb.tool === 'tone' ? 0.4 : verb.tool === 'heal' ? 0.6 : 0.4
    out.push({
      tool: verb.tool,
      verb: verb.tool === 'tone' ? (tone === 'darken' ? 'Darken' : 'Brighten') : verb.verb,
      region,
      what: thing ? `the ${thing.toLowerCase()}` : '',
      strength,
      // "keep the edges natural" is a clause of its own, so the hints are read from the whole sentence.
      edgeAware: verb.tool === 'blur' && /\b(skin|texture|artifacts?|artificial|plastic|noise|natural|photographic|hair|(?:keep|preserve|protect) (?:the |its |their )?(?:edges|outlines|lines))\b/i.test(raw),
      tone: verb.tool === 'tone' ? tone : undefined
    })
  }
  return out
}

export function countIn(text: string): number | null {
  const digits = text.match(/\b(\d{1,2})\b/)
  if (digits) return Math.max(1, Math.min(30, Number(digits[1])))
  for (const [word, n] of Object.entries(NUMBER_WORDS)) if (new RegExp(`(^|[^a-zåäö])${word}([^a-zåäö]|$)`).test(text)) return n
  return null
}

export async function respondBasics(input: BasicsInput, tools: Tool[], session: ToolSession): Promise<BasicsOutput> {
  const raw = input.text.trim()
  const q = raw.toLowerCase()
  const blocks: AssistantBlock[] = []
  const run = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const result = await call(tools, name, args, session)
    blocks.push(...result.blocks)
    return result
  }

  // Looking at pictures needs a language model that can see; the built-in basics read descriptions only.
  if (/\b(look (?:closely|carefully)|take a (?:close )?look|analy[sz]e|inspect|examine|critique|studera|analysera)\b/.test(q) && /\b(image|images|picture|pictures|artwork|artworks|photo|photos|detail|details|composition|lighting|version|versions|bild|bilder|konstverk)\b/.test(q) && !/\b(library|taste|favorites?)\b/.test(q)) {
    blocks.push(say('I cannot look at pictures in my built-in basic mode: I only read descriptions, tags and colours of your library. To have the pictures themselves looked at, connect a language model that can see in my settings: a cloud model (I will ask you before any picture is sent) or a vision model running on this computer in Ollama or LM Studio. Until then I can search, group and describe from the library notes, and I will say so each time.', 'plain'))
    return { blocks }
  }

  // The AI Model Library: opened as the real window, never described as a list in the chat.
  if (/\b(model library|library of (?:ai )?models|ai models?|modellbibliotek\w*|ai-modeller)\b/.test(q) || (/\b(open|show|browse|visa|öppna)\b/.test(q) && /\b(models?|modeller)\b/.test(q))) {
    const opened = await run('open_model_library', {})
    const failed = (opened.model as { error?: string }).error
    blocks.push(say(failed ? failed : 'I opened the AI Model Library for you. You can search it, see what fits this computer, and decide what to install; nothing is downloaded until you agree there.', 'plain'))
    return { blocks }
  }

  // Organizing into folders: analysis only reads; copying always needs the user's own choices on the Organizer page.
  if (/\b(organi[sz]e|sort out|sortera|folder structure|mappstruktur)\b/.test(q) && /\b(pictures|images|photos|library|folders?|mapp\w*|bilder|biblioteket|sources?|drive)\b/.test(q)) {
    const roots = session.ctx.db.listRoots()
    const named = roots.find((r) => q.includes(r.name.toLowerCase()))
    const started = await run('organize_start', named ? { source: named.name } : { source: 'all' })
    const failed = (started.model as { error?: string }).error
    blocks.push(say(failed ? failed : 'I started reading the pictures to propose folders. Follow it on the Smart Organizer page; when it is ready you can rename, merge or leave out groups, choose what to do with copies and versions, and then pick a destination. Nothing is copied or moved until you approve it there.', 'plain'))
    return { blocks }
  }

  if (/^(hi|hello|hey|hej|hallå|good (morning|evening))\b/.test(q) || q === '' || /\bwhat can you do\b|\bhelp\b|\bhjälp\b/.test(q)) {
    blocks.push(say(`Hello! ${HELP_TEXT}`))
    return { blocks }
  }

  // Choosing the best few images from a collection: the curation workflow, with a review panel before anything is made.
  const namedSmart = (session.ctx.smart?.list() ?? []).find((c) => q.includes(c.name.toLowerCase()))
  const pickVerb = /\b(best|select|pick|choose|top|välj|bästa)\b/.test(q)
  const curateAsk = /\b(curate|curation|kuratera)\b/.test(q) || (pickVerb && (Boolean(namedSmart) || /\b(smart collections?|collections?|samling(?:en)?|these|this|current|dessa|den här|det här)\b/.test(q)))
  if (curateAsk && !/\bfavou?rites?\b.*\b(common|share|taste)\b/.test(q)) {
    const count = countIn(q) ?? 10
    const smart = session.ctx.smart?.list() ?? []
    const named = namedSmart
    const view = session.ctx.view?.() ?? { kind: null }
    const args: Record<string, unknown> = { count }
    if (named) Object.assign(args, { source: 'smart_collection', name: named.name })
    else if (view.kind) Object.assign(args, { source: 'current' })
    else if (smart.length === 1) Object.assign(args, { source: 'smart_collection', name: smart[0]!.name })
    else if (/\bfavou?rites?\b|\bfavoriter\b/.test(q)) Object.assign(args, { source: 'favorites' })
    else {
      blocks.push(say(smart.length ? `Which collection should I choose from? Open one in Smart Collections, or name it: ${smart.slice(0, 5).map((c) => `“${c.name}”`).join(', ')}.` : 'Open a smart collection (or a family) first, or tell me what the images should look like, and I will choose from the best matches.'))
      return { blocks }
    }
    const result = await run('curate_images', args)
    const model = result.model as { error?: string; proposed?: number; requested?: number; shortfall?: string | null; from?: string; considered?: number; taste_basis?: string; left_out?: Record<string, number> }
    if (model.error) {
      blocks.unshift(say(model.error))
      return { blocks }
    }
    const left = model.left_out ?? {}
    const notes: string[] = []
    if (left.technical) notes.push(`${left.technical} look${left.technical === 1 ? 's' : ''} like technical working images (software screenshots, test renders) and ${left.technical === 1 ? 'is' : 'are'} kept out unless you ask for them`)
    if (left.duplicate) notes.push(`${left.duplicate} repeat${left.duplicate === 1 ? 's' : ''} a stronger image`)
    if (left.passed) notes.push(`${left.passed} you passed on`)
    blocks.unshift(
      say(
        (model.proposed ? `From ${model.from} I looked at ${model.considered} images and propose ${model.proposed}${model.requested && model.proposed < model.requested ? ` (you asked for ${model.requested})` : ''}. ` : `From ${model.from} I looked at ${model.considered} images. `) +
          (model.shortfall ? `${model.shortfall} ` : '') +
          (notes.length ? `Left out: ${notes.join('; ')}. ` : '') +
          (model.taste_basis ?? '') +
          (model.proposed ? ' Review them below: you can keep, reject or replace each image before anything is created.' : ''),
        'library'
      )
    )
    return { blocks }
  }

  // New artwork from a moodboard: develop a concept, then hand it to the Creative Studio on the user's click.
  if (/\b(create|make|generate|paint|compose|skapa|gör|måla)\b.{0,70}?\b(artworks?|pictures?|paintings?|images?|landscapes?|scenes?|pieces?|konstverk|målning|bild)\b.{0,90}?\b(moodboard|mood board|board)\b/i.test(raw) && !/\bmoodboard\b.{0,12}\b(of|with|about)\b/i.test(raw)) {
    const named = boardNameIn(raw, session)
    const result = await run('propose_artwork', { board: named, intent: raw })
    const model = result.model as { error?: string; title?: string }
    if (model.error) {
      blocks.unshift(say(model.error))
    } else {
      blocks.unshift(
        say(
          `I read the moodboard and drafted a concept, “${model.title}”. Open it in the Creative Studio to choose which pictures give the atmosphere, composition and colours, review the prompt, and pick how to make it. Nothing is made, uploaded or paid for until you approve it there.`,
          'library'
        )
      )
    }
    return { blocks }
  }

  // Tidying and removing near-duplicates on a moodboard.
  if (/\b(moodboard|board)\b/.test(q) && /\b(tidy|arrange|rearrange|neat|organise|organize|städa|ordna)\b/.test(q)) {
    const named = boardNameIn(raw, session)
    const result = await run('propose_board_changes', { board: named, arrange: /\b(hero|lead|large|big|stor)\b/.test(q) ? 'hero' : 'tidy', reason: 'A calmer layout that keeps every picture in proportion.' })
    if ((result.model as { error?: string }).error) blocks.unshift(say(String((result.model as { error?: string }).error)))
    else blocks.unshift(say('Here is the layout change. You see it before it happens, and you can undo it afterwards.', 'library'))
    return { blocks }
  }
  if (/\b(moodboard|board)\b/.test(q) && /\b(remove|redundant|duplicates?|too similar|declutter|prune|ta bort|dubbletter|liknande)\b/.test(q)) {
    const named = boardNameIn(raw, session)
    const boards = session.ctx.db.listMoodboards()
    const chosen = (named ? boards.find((b) => b.name.toLowerCase() === named.toLowerCase()) : null) ?? [...boards].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const detail = chosen ? session.ctx.db.getMoodboard(chosen.id) : null
    const snap = session.ctx.semantic?.snapshot()
    if (!chosen || !detail || !snap || snap.ids.length === 0 || !session.ctx.searchable()) {
      blocks.push(say('To find pictures that are too alike, I need the image model switched on and the board’s pictures learned. Until then I can still tidy the layout if you ask.'))
      return { blocks }
    }
    const row = new Map(snap.ids.map((id, i) => [id, i]))
    const dot = (a: number, b: number): number => {
      let sum = 0
      for (let d = 0; d < snap.dim; d += 1) sum += snap.matrix[a * snap.dim + d]! * snap.matrix[b * snap.dim + d]!
      return sum
    }
    const kept: number[] = []
    const redundant: string[] = []
    for (const image of detail.images) {
      const r = row.get(image.id)
      if (r === undefined) continue
      if (kept.some((k) => dot(k, r) > 0.94)) redundant.push(image.id)
      else kept.push(r)
    }
    if (redundant.length === 0) {
      blocks.push(say(`I compared the pictures on “${chosen.name}” and none of them look so alike that one is redundant.`, 'library'))
      return { blocks }
    }
    const result = await run('propose_board_changes', { board: chosen.name, remove_refs: redundant.map((id) => session.refs.refFor(id)), arrange: 'tidy', reason: 'These look almost the same as another picture that stays on the board.' })
    blocks.unshift(say(`${redundant.length} picture${redundant.length === 1 ? ' looks' : 's look'} almost identical to another one on “${chosen.name}”. Here is what I would remove. You decide, and it can be undone.`, 'library'))
    void result
    return { blocks }
  }

  // What can the Studio do here? Answers from what is really installed, and offers setup instead of promising.
  if (/\b(can you|could you|are you able to|what can you|do you have|is there)\b.{0,40}\b(create|generate|make|edit|retouch|upscale|enlarge|paint|draw)\b.{0,40}\b(images?|pictures?|art(work)?|them|it|this)?/i.test(raw) && /\b(set ?up|installed|available|can you|what can|do you have|ai|comfy)/i.test(raw) && !/\b(moodboard|board)\b/i.test(raw) && /\?\s*$|\bwhat can\b/i.test(raw)) {
    const caps = (await session.ctx.capabilities?.()) ?? []
    if (caps.length > 0) {
      const lines = caps.map((c) => `• ${c.label}: ${c.ready ? `yes, with ${c.how}` : 'not with AI yet'}${c.options.length > 1 ? ` (also: ${c.options.filter((o) => o.label !== c.how).map((o) => o.label).join(', ')})` : ''}${c.ready || !c.offer ? '' : '. ' + (c.missing ?? '')}`)
      const missing = caps.some((c) => !c.ready)
      blocks.push(say(`Here is what the Creative Studio can do on this computer right now:\n${lines.join('\n')}${missing ? '\n\nTo add what is missing, open the Studio (the Create artwork button on a moodboard) and choose Settings, then “How should Atlas make pictures?”. I install nothing myself; you agree to each download there.' : ''}`, 'library'))
      return { blocks }
    }
  }

  // Edit or enlarge the picture just shown: Atlas proposes, and does it only after the user's own click.
  if (input.lastImageIds.length > 0 && !/\b(moodboard|board)\b/i.test(raw)) {
    const ordinal = /\b(?:the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th)\b(?:\s+(?:one|variation|version|picture|image|result|interpretation))?/i.exec(raw)
    const index = ordinal ? ({ first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3 } as Record<string, number>)[ordinal[1]!.toLowerCase()] ?? 0 : 0
    const target = session.refs.refFor(input.lastImageIds[Math.min(index, input.lastImageIds.length - 1)]!)
    const big = /\b(upscal\w*|enlarg\w*|uppskala\w*|förstor\w*|higher resolution|bigger|större)\b/i.test(raw)
    const detail = /\b(fine details?|details?|refine|finer|sharpen|sharper|improve)\b/i.test(raw)
    if (big) {
      const size = /\b(\d{3,5})\s*(px|pixels)?\b/.exec(raw)
      const k = /\b([248])\s*[x×]\b|\b(\d)\s*k\b/i.exec(raw)
      const factor = k?.[1] ? Number(k[1]) : undefined
      const kEdge: Record<number, number> = { 2: 2048, 4: 3840, 8: 7680 }
      const wanted = size ? Number(size[1]) : k?.[2] ? kEdge[Number(k[2])] ?? Number(k[2]) * 1024 : undefined
      if (detail) {
        // "Improve its fine details and upscale it to 4K": a plan Atlas carries out after one approval.
        await run('propose_edit_plan', { ref: target, title: 'Refine the details, then enlarge', steps: [{ op: 'detail', label: 'Refine the fine details', subject: subjectGuess(raw) }, { op: 'upscale', label: 'Enlarge', ...(wanted && wanted >= 256 ? { target_long_edge: wanted } : {}), subject: subjectGuess(raw) }] })
        blocks.unshift(say('Here is a two-step plan for that picture: refine its fine details, then enlarge it. It runs here on this computer after you approve it, and both results are saved as linked versions. Your original is not touched.', 'library'))
        return { blocks }
      }
      await run('propose_upscale', { ref: target, ...(wanted && wanted >= 256 ? { target_long_edge: wanted } : { factor: factor ?? 2 }) })
      blocks.unshift(say('I can open the Upscale panel for the picture I just showed with that size filled in. You choose the preset there and press the button; nothing is made until you do.', 'library'))
      return { blocks }
    }
    // Retouching: remove, heal, blur, sharpen, dodge or burn. Each clause of the request is read on its own. A part is named only
    // when the words really name one (the sky, the background, the left side); a face, hand, hair, object or blemish has to be
    // marked by the user, and the reply says so instead of guessing.
    const clauses = parseRetouch(raw)
    if (clauses.length > 0) {
      const located = clauses.filter((c) => c.region)
      const toMark = clauses.filter((c) => !c.region)
      const label = (c: RetouchClause): string => `${c.verb} ${c.region ? `the ${c.region}` : c.what || 'the marked part'}`
      const lines: string[] = []
      if (located.length > 0) {
        const steps = located.map((c) => ({ op: c.tool, label: label(c), region: c.region!, strength: c.strength, ...(c.tool === 'blur' && c.edgeAware ? { edge_aware: true } : {}), ...(c.tool === 'tone' ? { tone: c.tone } : {}) }))
        if (located.length === 1 && toMark.length === 0) {
          const c = located[0]!
          await run('propose_retouch', { ref: target, tool: c.tool, region: c.region, strength: c.strength, ...(c.edgeAware ? { edge_aware: true } : {}), ...(c.tool === 'tone' ? { tone: c.tone } : {}) })
          lines.push(`I can open the ${c.tool === 'tone' ? (c.tone === 'darken' ? 'Burn' : 'Dodge') : c.tool[0]!.toUpperCase() + c.tool.slice(1)} tool with the ${c.region} already marked. You see the result live, can compare it with the original, and keep it as a new version. Your original is not touched.${c.edgeAware ? ' I chose the edge-aware blur, which keeps strong edges and smooths what lies between them.' : ''}`)
        } else {
          await run('propose_edit_plan', { ref: target, title: located.length === 1 ? label(located[0]!) : `${located.length} retouching steps`, steps })
          lines.push(`Here ${located.length === 1 ? 'is a step' : `are ${located.length} steps`} I can carry out for the parts I can find reliably (${located.map((c) => `the ${c.region}`).join(', ')}). It runs here on this computer after you approve, nothing is uploaded or paid for, and each result is saved as a linked version.`)
        }
      }
      for (const c of toMark) {
        await run('propose_retouch', { ref: target, tool: c.tool, strength: c.strength, ...(c.edgeAware ? { edge_aware: true } : {}), ...(c.tool === 'tone' ? { tone: c.tone } : {}) })
        lines.push(`${c.what ? `I cannot point to ${c.what} reliably from words alone, so ` : 'I need to know which part, so '}I will open ${c.tool === 'tone' ? (c.tone === 'darken' ? 'Burn' : 'Dodge') : c.tool[0]!.toUpperCase() + c.tool.slice(1)} for you to paint it. You see the result live and keep it as a new version.`)
      }
      blocks.unshift(say(lines.join('\n\n'), 'library'))
      return { blocks }
    }
    const region = regionFromInstruction(raw)
    const count = countFromText(raw)
    const level = levelFromText(raw)
    const replace = /\b(replace|swap|byt ut|ersätt)\b/i.test(raw) && Boolean(region)
    const change = replace || (/\b(more|less|mer|mindre|darker|brighter|lighter|warmer|cooler|softer|sharper|moodier|mysterious|mystisk\w*|dramatic|vintage|black and white|surreal|misty|dreamy|ljusare|mörkare|varmare|kallare)\b/i.test(raw) && /\b(edit|change|make|turn|give|retouch|redigera|ändra|gör|ge)\b/i.test(raw)) || (Boolean(count) && /\b(try|show|give|make|create)\b/i.test(raw))
    if (change) {
      if ((count && count > 1) || region) {
        const steps = [{ op: 'edit', label: `${replace ? 'Replace' : 'Change'} ${region ? `the ${region}` : 'the picture'}${count && count > 1 ? `: ${count} alternatives` : ''}`, instruction: raw, level: level ?? (count && count > 1 ? 'radical' : 'creative'), ...(region ? { region } : {}), ...(count && count > 1 ? { variations: count } : {}) }]
        await run('propose_edit_plan', { ref: target, title: count && count > 1 ? `${count} interpretations` : 'A selective edit', steps })
        blocks.unshift(say(`Here is the plan${count && count > 1 ? ` for ${count} alternatives` : ''}${region ? `, changing only the ${region}` : ''}. Atlas carries it out here on this computer after you approve, keeps each result as a linked version next to the original, and shows them to you.`, 'library'))
        return { blocks }
      }
      await run('propose_edit', { ref: target, instruction: raw, ...(level ? { level } : {}) })
      blocks.unshift(say('I can open the Studio’s Edit tab with that picture and your description ready. You pick how it is done (AI on this computer, a cloud service, or plain mood grading), see a preview, and save it as a new version. Your original stays as it is.', 'library'))
      return { blocks }
    }
  }

  // Prompts from images.
  if (/\b(prompts?|midjourney)\b/.test(q)) {
    let refs: string[] = input.lastImageIds.slice(0, 5).map((id) => session.refs.refFor(id))
    if (refs.length === 0) {
      const fav = await call(tools, 'search_images', { query: 'beautiful image', favorites_only: true, limit: 5 }, session)
      refs = ((fav.model as { images?: Array<{ ref: string }> }).images ?? []).map((i) => i.ref)
      blocks.push(...fav.blocks)
    }
    if (refs.length === 0) {
      blocks.push(say('Show me some images first (for example "find foggy forests"), then ask for prompts and I will build them from what is in those images.'))
      return { blocks }
    }
    const result = await call(tools, 'describe_images', { refs }, session)
    const images = (result.model as { images: Described[] }).images
    const lines = images.map((entry, i) => `${i + 1}. ${promptFrom(entry, i)}`)
    blocks.push(
      say(
        `Here are ${lines.length} prompts built from what the image model sees in these images (subject, mood, style, palette). They are starting points, so adjust the wording to taste:\n\n${lines.join('\n')}`,
        'idea'
      )
    )
    blocks.push(say('Without a language model I can only fill in a template. Connect one in my settings for prompts written in full sentences.', 'plain'))
    return { blocks }
  }

  // Artists and discovery.
  if (/\b(artists?|painters?|who might|reference|konstnär|konstnärer)\b/.test(q) || (/\bdiscover\b/.test(q) && !/direction/.test(q))) {
    const board = boardNameIn(raw, session)
    const result = await run('reference_matches', board ? { from: 'moodboard', name: board } : { from: 'favorites', limit: 6 })
    const works = ((result.model as { works?: Array<{ title: string; artist: string; date: string; museum: string }> }).works ?? [])
    if (works.length === 0) {
      blocks.push(say(String((result.model as { error?: string }).error ?? 'I need some favorites (or a moodboard) and the image model to compare with the reference collection.')))
    } else {
      blocks.push(
        say(
          `These works in the Atlas Reference Collection look closest to ${board ? `“${board}”` : 'your favorites'}. This is visual resemblance, not a claim that they influenced one another, and the collection is thin on abstraction and contemporary art:\n` +
            works.map((w) => `• ${w.artist}: ${w.title} (${w.date}), ${w.museum}`).join('\n'),
          'library'
        )
      )
    }
    return { blocks }
  }

  // Favorites and what they share.
  if (/\bfavou?rites?\b|\bfavoriter\b/.test(q) && /(common|share|similar|taste|identity|pattern|gemensamt|smak)/.test(q)) {
    await answerTaste(run, blocks, true)
    return { blocks }
  }

  // Moodboard help.
  if (/\bmoodboards?\b|\bboard\b/.test(q) && /(complement|improve|fit|match|add|more|expand|gaps?|missing|förbättra|komplettera)/.test(q)) {
    const name = boardNameIn(raw, session)
    const result = await run('suggest_for_moodboard', { board: name, limit: 8 })
    const model = result.model as { board?: string; error?: string; images?: Array<{ ref: string }> }
    if (model.error || !model.images?.length) {
      blocks.push(say(model.error ?? 'I did not find anything that fits yet.'))
      return { blocks }
    }
    blocks.unshift(say(`These images are the closest in overall look to “${model.board}” and are not on it yet. I picked them by how they look, so they will fit its feel, not necessarily add contrast.`, 'library'))
    const proposal = await call(tools, 'propose_add_to_moodboard', { board: model.board, refs: model.images.map((i) => i.ref), reason: 'They look closest to what is already on the board.' }, session)
    blocks.push(...proposal.blocks)
    return { blocks }
  }

  // New moodboard from a description.
  const make = raw.match(/\b(make|create|build|start|skapa)\b.*\bmoodboard\b.*?\b(of|from|with|about|for|för|med)\s+(.+)$/i)
  if (make) {
    const topic = cleanQuery(make[3]!)
    const result = await run('search_images', { query: topic, limit: 16 })
    const images = (result.model as { images?: Array<{ ref: string }> }).images ?? []
    if (images.length === 0) {
      blocks.push(say(`I found nothing for “${topic}”.`))
      return { blocks }
    }
    const name = topic.charAt(0).toUpperCase() + topic.slice(1)
    blocks.unshift(say(`I found ${images.length} images for “${topic}”. Here is a moodboard proposal. Nothing is created until you accept it.`, 'library'))
    blocks.push(...(await call(tools, 'propose_moodboard', { name, refs: images.map((i) => i.ref), reason: `The ${images.length} best matches for “${topic}”.` }, session)).blocks)
    return { blocks }
  }

  // Questions about the person's own taste, preferences or style, in English and Swedish. These are never image searches.
  const reading = readIntent(raw)
  const wantsIdeas = /(director|directions|ideas|inspiration|riktningar|idéer|suggest|foreslå|föreslå)/.test(q)
  if (reading.intent === 'taste' && !wantsIdeas) {
    await answerTaste(run, blocks)
    return { blocks }
  }
  if (reading.intent === 'ambiguous' && !wantsIdeas) {
    blocks.push(
      say(
        /[åäö]|\b(jag|min|mitt|mina|vad|hur|visa|hitta)\b/.test(q)
          ? 'Vill du att jag beskriver din smak utifrån dina favoriter och dina val, eller ska jag söka efter bilder? Svara till exempel "beskriv min smak" eller "hitta bilder på …".'
          : 'Do you want me to describe your taste, based on your favorites and your choices, or should I search for images? You can say "describe my taste" or "find images of …".'
      )
    )
    return { blocks }
  }

  // Directions and style development.
  if (/(director|directions|ideas|inspiration|style|riktningar|idéer)/.test(q) && /(suggest|new|creative|develop|help|give|find|foreslå|föreslå|utveckla)/.test(q)) {
    const profile = await run('favorites_profile')
    const journeys = await call(tools, 'journey_ideas', {}, session)
    const model = profile.model as { available?: boolean; groups?: Array<{ group: string; reliable_qualities: string[] }> }
    const list = (journeys.model as { journeys?: Array<{ title: string; why: string }> }).journeys ?? []
    if (model.available && model.groups?.length) {
      blocks.unshift(
        say(
          'In your favorites I can see: ' + model.groups.slice(0, 3).map((g) => `“${g.group}”${g.reliable_qualities.length ? ` (${g.reliable_qualities.slice(0, 2).join(', ')})` : ''}`).join('; ') + '.',
          'library'
        )
      )
    }
    const ideas: string[] = list.slice(0, 5).map((j) => `${j.title}: ${j.why}`)
    if (model.groups && model.groups.length > 1) ideas.push(`Cross two of your groups: take “${model.groups[0]!.group}” and let “${model.groups[1]!.group}” change its light, colour or scale.`)
    if (ideas.length === 0) ideas.push('Make a few comparisons in Taste and mark some favorites, and I can suggest directions that are based on your choices.')
    blocks.push(say('Directions you could explore (these are suggestions, not facts about your taste):\n' + ideas.map((x, i) => `${i + 1}. ${x}`).join('\n'), 'idea'))
    blocks.push(say('For a back-and-forth about developing a style, connect a language model in my settings.'))
    return { blocks }
  }

  // Everything else that looks like a request to find images.
  const query = cleanQuery(raw)
  if (query.length >= 2) {
    const result = await run('search_images', { query, limit: 12 })
    const model = result.model as { count: number; matched_by?: string }
    blocks.unshift(
      say(
        model.count > 0
          ? `Here ${model.count === 1 ? 'is' : 'are'} ${model.count} image${model.count === 1 ? '' : 's'} for “${query}”, matched by ${model.matched_by}.`
          : `I found nothing for “${query}”.${model.matched_by?.includes('tags') ? ' Visual search is off, so I can only match filenames and tags. Setting up the image model lets me search by what images look like.' : ''}`,
        'library'
      )
    )
    return { blocks }
  }
  blocks.push(say(HELP_TEXT))
  return { blocks }
}

/** The kind of subject the user's words point to, for the detail pass. */
function subjectGuess(text: string): string {
  return subjectFromText(text)
}
