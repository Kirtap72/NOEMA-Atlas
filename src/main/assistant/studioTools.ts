import { randomUUID } from 'node:crypto'
import type { ImageItem } from '../../shared/types'
import { ASPECTS, EDIT_LEVELS, REFERENCE_ASPECTS, DETAIL_SUBJECTS, type AspectChoice, type DetailSubject, type EditLevel, type EditReferences, type EditRegion, type PlanStep, type ReferenceAspect, type RefRole, type RegionName } from '../../shared/studio'
import { regionFromText } from '../../shared/regionWords'
import { developConcept } from '../studio/concept'
import type { Tool, ToolSession } from './tools'

/** Helpers that tools.ts already has, handed over so this file does not depend on it at run time. */
export interface ToolHelpers {
  text(value: unknown, max?: number): string
  obj(properties: Record<string, unknown>, required?: string[]): Record<string, unknown>
  idsFromRefs(args: Record<string, unknown>, session: ToolSession, key?: string): { ids: string[]; unknown: string[] }
  resolveBoard(ctx: ToolSession['ctx'], wanted: string): { id: string; name: string } | { error: string }
}

const ASPECT_KEYS = Object.keys(ASPECTS) as AspectChoice[]


const LEVELS = Object.keys(EDIT_LEVELS) as EditLevel[]
const ASPECT_NAMES = Object.keys(REFERENCE_ASPECTS) as ReferenceAspect[]
const SUBJECTS = Object.keys(DETAIL_SUBJECTS) as DetailSubject[]
const DEFAULT_RETOUCH: Record<string, number> = { remove: 0.4, heal: 0.6, blur: 0.5, sharpen: 0.45, tone: 0.4 }
const REGIONS: RegionName[] = ['sky', 'top', 'bottom', 'left', 'right', 'center', 'background', 'foreground']

/** Reads the part of the picture a tool call names: a word such as "sky", or a rectangle in fractions. */
function regionFrom(value: unknown, rect: unknown, invert: unknown): EditRegion | undefined {
  const region: EditRegion = {}
  if (typeof value === 'string' && value.trim()) {
    const named = (REGIONS as string[]).includes(value.trim().toLowerCase()) ? (value.trim().toLowerCase() as RegionName) : regionFromText(value)
    if (named) region.named = named
  }
  if (rect && typeof rect === 'object') {
    const r = rect as Record<string, unknown>
    const f = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0)
    if (f(r.w) > 0.01 && f(r.h) > 0.01) region.shape = { kind: r.kind === 'ellipse' ? 'ellipse' : 'rect', x: f(r.x), y: f(r.y), w: f(r.w), h: f(r.h) }
  }
  if (!region.named && !region.shape) return undefined
  if (invert === true) region.invert = true
  return region
}

function levelFrom(value: unknown): EditLevel | undefined {
  return typeof value === 'string' && (LEVELS as string[]).includes(value) ? (value as EditLevel) : undefined
}

function aspectsFrom(value: unknown): ReferenceAspect[] {
  const list = Array.isArray(value) ? value : []
  const out = list.filter((a): a is ReferenceAspect => typeof a === 'string' && (ASPECT_NAMES as string[]).includes(a))
  return out.length ? Array.from(new Set(out)) : ['atmosphere']
}

/** References for an edit: single pictures by reference, and/or every picture of a moodboard (up to eight). */
function referencesFrom(args: Record<string, unknown>, session: ToolSession, h: ToolHelpers, ownId: string, prefix = ''): { value?: EditReferences; error?: string } {
  const ids = h.idsFromRefs(args, session, `${prefix}reference_refs`).ids.filter((id) => id !== ownId)
  const boardName = h.text(args[`${prefix}reference_board`])
  if (boardName) {
    const board = h.resolveBoard(session.ctx, boardName)
    if ('error' in board) return { error: board.error }
    const detail = session.ctx.db.getMoodboard(board.id)
    for (const image of (detail?.images ?? []).filter((i) => !i.missing && i.id !== ownId).slice(0, 8)) if (!ids.includes(image.id)) ids.push(image.id)
  }
  if (ids.length === 0) return {}
  return { value: { imageIds: ids.slice(0, 12), aspects: aspectsFrom(args[`${prefix}reference_aspects`]), amount: typeof args[`${prefix}reference_amount`] === 'number' ? Math.max(0.2, Math.min(1, args[`${prefix}reference_amount`] as number)) : 0.75 } }
}

const EDIT_PROPERTIES = {
  level: { type: 'string', enum: LEVELS, description: 'subtle = photographic polish; creative = change the look but keep important elements (default); radical = bold artistic reinterpretation.' },
  region: { type: 'string', enum: REGIONS, description: 'Change ONLY this part and keep everything else pixel-exact, for example "sky".' },
  region_rect: { type: 'object', description: 'Alternative to region: a rectangle in fractions of the picture {x, y, w, h}, optional kind "ellipse".' },
  invert_region: { type: 'boolean', description: 'Change everything EXCEPT the region.' },
  reference_refs: { type: 'array', items: { type: 'string' }, description: 'Pictures (by reference) whose light, colour or atmosphere to borrow.' },
  reference_board: { type: 'string', description: 'A moodboard whose look to borrow.' },
  reference_aspects: { type: 'array', items: { type: 'string', enum: ASPECT_NAMES }, description: 'What to borrow: lighting, colour, atmosphere. Composition and material cannot be taken from a reference.' },
  prompt: { type: 'string', description: 'Optional: a vivid English description of the RESULT for the image model (what it should look like), without verbs such as "replace".' }
}

/** The Creative Studio's part of the assistant: proposing new artwork and changes to moodboards. Both only propose. */
export function studioTools(h: ToolHelpers): Tool[] {
  const roleKeys: Array<[string, RefRole]> = [
    ['atmosphere_refs', 'atmosphere'],
    ['composition_refs', 'composition'],
    ['colour_refs', 'colour'],
    ['material_refs', 'material'],
    ['subject_refs', 'subject']
  ]
  return [
    {
      progress: 'Checking what the Studio can do…',
      spec: {
        name: 'studio_capabilities',
        description: 'What Atlas can create, edit and upscale right now on this computer, and what is missing and how to add it. Call this before suggesting a way to make, edit or enlarge pictures, so you only offer what exists.',
        parameters: h.obj({})
      },
      async run(_args, session) {
        const caps = (await session.ctx.capabilities?.()) ?? []
        return {
          model: {
            capabilities: caps.map((c) => ({ what: c.label, ai_ready: c.ready, ways: c.options.map((o) => `${o.label} (${o.kind})`), missing: c.missing, setup_offer: c.offer })),
            note: 'Setup is in the Creative Studio settings. Nothing is installed without the user agreeing there.'
          },
          blocks: []
        }
      }
    },
    {
      progress: 'Preparing an edit…',
      spec: {
        name: 'propose_edit',
        description: 'Propose editing ONE picture (by reference) from a description, for example "softer light, keep the architecture". Supports three levels, editing only a named part (inpainting), and borrowing the look of reference pictures or a moodboard. Nothing is changed: accepting opens the Studio\'s Edit tab filled in, where the user chooses the method, sees a preview and saves a new version. Use propose_edit_plan instead when the user wants Atlas to carry out several steps or show alternatives right here.',
        parameters: h.obj({ ref: { type: 'string' }, instruction: { type: 'string' }, strength: { type: 'number', description: '0 to 1, how much may change.' }, reason: { type: 'string' }, ...EDIT_PROPERTIES }, ['ref', 'instruction'])
      },
      async run(args, session) {
        const id = h.idsFromRefs({ refs: [args.ref] }, session).ids[0]
        const instruction = h.text(args.instruction, 800)
        if (!id || !instruction) return { model: { error: 'I need a picture I have shown (by reference) and a description of the change.' }, blocks: [] }
        const item = session.ctx.db.getImagesByIds([id])[0]
        if (!item) return { model: { error: 'That picture is no longer in the library.' }, blocks: [] }
        const level = levelFrom(args.level)
        const strength = typeof args.strength === 'number' && Number.isFinite(args.strength) ? Math.max(0.1, Math.min(1, args.strength)) : level ? EDIT_LEVELS[level].strength : 0.6
        const refs = referencesFrom(args, session, h, id)
        if (refs.error) return { model: { error: refs.error }, blocks: [] }
        const region = regionFrom(args.region, args.region_rect, args.invert_region)
        return {
          model: { status: 'Proposal shown. Nothing is edited until the user previews and keeps a result in the Studio.', level: level ?? 'creative', region: region?.named ?? (region?.shape ? 'shape' : 'whole picture'), references: refs.value?.imageIds.length ?? 0 },
          blocks: [{ type: 'proposal', id: randomUUID(), title: 'Edit this picture', reason: h.text(args.reason, 300) || instruction, proposal: { kind: 'edit', imageId: id, imageIds: [id], instruction, strength, level, region, references: refs.value }, status: 'pending' }]
        }
      }
    },
    {
      progress: 'Planning the steps…',
      spec: {
        name: 'propose_edit_plan',
        description:
          'Propose a multi-step creative process that Atlas CARRIES OUT after one approval and shows right here in the conversation, for example: three different artistic interpretations; replace the sky, then refine details; improve fine details and upscale to 4K. Each step is an edit (instruction, level, optional region, optional reference look, optional variations), a detail refinement (same size) or an upscale. Steps run in order on the previous result (from "previous", the default) or on the starting picture (from "source", useful for alternatives). Only local tools are used, nothing is uploaded or paid, originals are untouched and every result is saved as a linked version. Call studio_capabilities first so you only plan what exists. Maximum 8 steps.',
        parameters: h.obj(
          {
            ref: { type: 'string', description: 'The starting picture.' },
            title: { type: 'string' },
            reason: { type: 'string' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  op: { type: 'string', enum: ['edit', 'detail', 'upscale', 'remove', 'heal', 'blur', 'sharpen', 'tone'], description: 'Retouching on a part Atlas can find reliably: remove (rebuild from surroundings), heal (repair a flaw), blur (soften), sharpen (restore detail), tone (lighten or darken). They need region or region_rect, and optional strength (0 to 1), edge_aware (blur) and tone (lighten or darken).' },
                  strength: { type: 'number' },
                  edge_aware: { type: 'boolean' },
                  tone: { type: 'string', enum: ['lighten', 'darken'] },
                  label: { type: 'string', description: 'A short plain sentence the user reads.' },
                  instruction: { type: 'string' },
                  from: { type: 'string', enum: ['source', 'previous'] },
                  variations: { type: 'integer', description: 'Edits: alternatives to make from the same start (1 to 4). The first carries on to the next step.' },
                  subject: { type: 'string', enum: SUBJECTS, description: 'Detail/upscale: what the picture mostly shows.' },
                  target_long_edge: { type: 'integer', description: 'Upscale: the longer side in pixels (4K is 3840).' },
                  preset: { type: 'string', description: 'Upscale: the name of one of the user\'s presets (from studio_capabilities); leave out for Atlas\'s own detail upscaling.' },
                  ...EDIT_PROPERTIES
                },
                required: ['op', 'label']
              }
            }
          },
          ['ref', 'steps']
        )
      },
      async run(args, session) {
        const id = h.idsFromRefs({ refs: [args.ref] }, session).ids[0]
        const item = id ? session.ctx.db.getImagesByIds([id])[0] : undefined
        if (!id || !item) return { model: { error: 'I need a picture I have shown (by reference) as the starting point.' }, blocks: [] }
        const raw = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>).slice(0, 8) : []
        if (raw.length === 0) return { model: { error: 'The plan needs at least one step.' }, blocks: [] }
        const caps = (await session.ctx.capabilities?.()) ?? []
        const upscaleOptions = caps.find((c) => c.id === 'upscale')?.options ?? []
        const steps: PlanStep[] = []
        for (const [i, r] of raw.entries()) {
          const RETOUCH_OPS = ['remove', 'heal', 'blur', 'sharpen', 'tone']
          const op = r.op === 'edit' || r.op === 'detail' || r.op === 'upscale' || (typeof r.op === 'string' && RETOUCH_OPS.includes(r.op)) ? (r.op as PlanStep['op']) : null
          if (!op) return { model: { error: `Step ${i + 1}: op must be edit, detail, upscale, remove, heal, blur, sharpen or tone.` }, blocks: [] }
          const step: PlanStep = { op, label: h.text(r.label, 160) || (op === 'edit' ? 'Edit' : op === 'detail' ? 'Refine the fine details' : op === 'remove' ? 'Remove the marked part' : op === 'heal' ? 'Heal the marked part' : op === 'blur' ? 'Soften the marked part' : op === 'sharpen' ? 'Sharpen the marked part' : op === 'tone' ? 'Lighten or darken the marked part' : 'Enlarge') }
          if (r.from === 'source' || r.from === 'previous') step.from = r.from
          if (op === 'edit') {
            step.instruction = h.text(r.instruction, 800)
            const refs = referencesFrom(r, session, h, id)
            if (refs.error) return { model: { error: `Step ${i + 1}: ${refs.error}` }, blocks: [] }
            if (!step.instruction && !refs.value) return { model: { error: `Step ${i + 1}: an edit needs an instruction or a reference look.` }, blocks: [] }
            step.prompt = h.text(r.prompt, 800) || undefined
            step.level = levelFrom(r.level) ?? 'creative'
            step.region = regionFrom(r.region, r.region_rect, r.invert_region)
            step.references = refs.value
            step.count = typeof r.variations === 'number' ? Math.max(1, Math.min(4, Math.round(r.variations))) : 1
          } else if (op === 'remove' || op === 'heal' || op === 'blur' || op === 'sharpen' || op === 'tone') {
            step.region = regionFrom(r.region, r.region_rect, r.invert_region)
            if (!step.region) return { model: { error: `Step ${i + 1}: ${op} needs a part Atlas can find reliably (region: sky, top, bottom, left, right, center, background or foreground, or region_rect). For an object, flaw or a face, hair or hand, use propose_retouch without a region so the user paints over it.` }, blocks: [] }
            step.strength = typeof r.strength === 'number' && Number.isFinite(r.strength) ? Math.max(0, Math.min(1, r.strength)) : DEFAULT_RETOUCH[op]
            if (op === 'blur') step.edgeAware = r.edge_aware === true
            if (op === 'tone') step.tone = r.tone === 'darken' ? 'darken' : 'lighten'
          } else {
            if (typeof r.subject === 'string' && (SUBJECTS as string[]).includes(r.subject)) step.subject = r.subject as DetailSubject
            if (op === 'upscale') {
              const long = Math.max(item.width, item.height)
              step.targetLongEdge = typeof r.target_long_edge === 'number' && Number.isFinite(r.target_long_edge) ? Math.max(256, Math.min(16384, Math.round(r.target_long_edge))) : long * 2
              const wanted = h.text(r.preset, 120).toLowerCase()
              if (wanted) {
                const hit = upscaleOptions.find((o) => o.id && o.id !== 'atlas:detail' && o.label.toLowerCase().includes(wanted))
                if (!hit) return { model: { error: `Step ${i + 1}: there is no upscaling preset called “${wanted}”. Known ways: ${upscaleOptions.map((o) => o.label).join('; ') || 'none'}.` }, blocks: [] }
                step.workflowId = hit.id
              }
            }
          }
          steps.push(step)
        }
        const edit = caps.find((c) => c.id === 'edit')
        const up = caps.find((c) => c.id === 'upscale')
        const usesAi = steps.some((x) => x.op === 'edit')
        const notes: string[] = []
        if (usesAi) notes.push(edit?.ready ? `Edits run with ${edit.how}.` : 'No AI editor is set up, so edits use Atlas Blend: it can change mood, light and colour (also in one part, or from a reference look) but cannot paint new content.')
        if (steps.some((x) => x.op === 'detail' || x.op === 'upscale')) notes.push(up?.ready ? 'Detail and enlargement run with Atlas\'s own detail upscaling unless a preset is named.' : 'No detail-adding upscaler is set up, so enlargement would be plain; it will say so.')
        notes.push('Everything stays on this computer. Nothing is uploaded or paid for. Originals are never changed; every result is a new linked version.')
        const lines = steps.map((x, i) => `${i + 1}. ${x.label}${x.op === 'remove' || x.op === 'heal' || x.op === 'blur' || x.op === 'sharpen' || x.op === 'tone' ? ` (${x.region?.named ?? 'chosen area'}${x.op === 'tone' ? `, ${x.tone === 'darken' ? 'darken' : 'lighten'}` : ''}${x.op === 'blur' || x.op === 'sharpen' || x.op === 'tone' ? `${x.edgeAware ? ', edge-aware' : ''}, ${Math.round((x.strength ?? 0.5) * 100)}%` : ''})` : x.op === 'edit' ? ` (${EDIT_LEVELS[x.level ?? 'creative'].label.toLowerCase()}${x.region ? `, ${x.region.named ?? 'chosen area'} only` : ''}${x.references ? `, look from ${x.references.imageIds.length} picture${x.references.imageIds.length === 1 ? '' : 's'}` : ''}${x.count && x.count > 1 ? `, ${x.count} alternatives` : ''})` : x.op === 'upscale' ? ` (to ${x.targetLongEdge}px)` : ''}`)
        const how = `${lines.join('\n')}\n${notes.join(' ')}`
        return {
          model: { status: 'Plan shown. NOTHING has run: Atlas carries it out only when the user accepts, then shows the results in the conversation.', steps: lines, notes },
          blocks: [{ type: 'proposal', id: randomUUID(), title: h.text(args.title, 120) || `${steps.length} step${steps.length === 1 ? '' : 's'} on this picture`, reason: h.text(args.reason, 300), proposal: { kind: 'edit-plan', imageId: id, imageIds: [id], title: h.text(args.title, 120), steps, how }, status: 'pending' }]
        }
      }
    },
    {
      progress: 'Preparing a retouch…',
      spec: {
        name: 'propose_retouch',
        description:
          'Propose a RETOUCH of one picture with one of five tools: remove (take out an object, person, stray detail or AI artifact; rebuilt from its surroundings, optionally with ComfyUI inpainting), heal (repair a blemish, seam, damaged texture or local artifact so it blends in), blur (soften harsh or oversharpened edges, artificial skin texture, a busy background; edge_aware keeps outlines), sharpen (restore detail without halos or noise), tone (dodge = lighten or burn = darken with a soft brush, keeping colours true). The area must be identified reliably: pass region (sky, top, bottom, left, right, center, background, foreground) or region_rect only when the user\'s words really name that part; otherwise leave both out and the Retouch tab opens with the picture ready so the user paints over the spot (say so). Nothing is changed: the user sees a preview and keeps it as a new version. For several steps use propose_edit_plan with op remove/blur.',
        parameters: h.obj(
          {
            ref: { type: 'string' },
            tool: { type: 'string', enum: ['remove', 'heal', 'blur', 'sharpen', 'tone'] },
            tone: { type: 'string', enum: ['lighten', 'darken'], description: 'tone: lighten (dodge) or darken (burn).' },
            region: EDIT_PROPERTIES.region,
            region_rect: EDIT_PROPERTIES.region_rect,
            invert_region: EDIT_PROPERTIES.invert_region,
            strength: { type: 'number', description: 'Blur: how much to soften, 0 to 1 (default 0.5). Remove: how far past the marked edge to reach.' },
            edge_aware: { type: 'boolean', description: 'Blur: keep strong edges and smooth only what lies between them (better for skin-like surfaces and AI texture).' },
            hint: { type: 'string', description: 'Remove: what should be there instead, if the surroundings do not say it (for example "grass").' },
            reason: { type: 'string' }
          },
          ['ref', 'tool']
        )
      },
      async run(args, session) {
        const id = h.idsFromRefs({ refs: [args.ref] }, session).ids[0]
        const item = id ? session.ctx.db.getImagesByIds([id])[0] : undefined
        if (!id || !item) return { model: { error: 'I need a picture I have shown (by reference).' }, blocks: [] }
        const TOOLS = ['remove', 'heal', 'blur', 'sharpen', 'tone'] as const
        const tool = TOOLS.find((t) => t === args.tool) ?? null
        if (!tool) return { model: { error: 'tool must be remove, heal, blur, sharpen or tone.' }, blocks: [] }
        const region = regionFrom(args.region, args.region_rect, args.invert_region)
        const strength = typeof args.strength === 'number' && Number.isFinite(args.strength) ? Math.max(0, Math.min(1, args.strength)) : DEFAULT_RETOUCH[tool]!
        const edgeAware = tool === 'blur' && args.edge_aware === true
        const tone = tool === 'tone' ? (args.tone === 'darken' ? 'darken' : 'lighten') : undefined
        const hint = h.text(args.hint, 200) || undefined
        const what = tool === 'blur' ? 'Soften' : tool === 'heal' ? 'Heal' : tool === 'sharpen' ? 'Sharpen' : tool === 'tone' ? (tone === 'darken' ? 'Darken' : 'Brighten') : 'Remove'
        const where = region ? (region.named ? `the ${region.named}` : 'the chosen area') : 'the part you paint'
        return {
          model: { status: region ? 'Proposal shown with the area already marked. Nothing is changed until the user previews and keeps a result.' : 'Proposal shown. The user must paint the exact spot in the Retouch tab; Atlas cannot find it reliably from words. Nothing is changed until they keep a result.', area: region ? (region.named ?? 'shape') : 'to be painted by the user' },
          blocks: [{ type: 'proposal', id: randomUUID(), title: `${what} ${where}`, reason: h.text(args.reason, 300) || (region ? '' : 'Paint over the spot in the Retouch tab; I cannot point to it reliably from words alone (faces, hands, hair and objects need your brush).'), proposal: { kind: 'retouch', imageId: id, imageIds: [id], tool, region, strength, edgeAware, tone, hint }, status: 'pending' }]
        }
      }
    },
    {
      progress: 'Looking at the versions…',
      spec: {
        name: 'show_versions',
        description: 'The version history of a picture: every edit, upscale and external change made from the same starting point, oldest first, with what each did. Use it to go back ("return to the second version"), compare, or branch. Versions are never removed, so going back means continuing from an earlier one. The pictures are shown to the user and given references.',
        parameters: h.obj({ ref: { type: 'string' } }, ['ref'])
      },
      async run(args, session) {
        const id = h.idsFromRefs({ refs: [args.ref] }, session).ids[0]
        if (!id) return { model: { error: 'I need a picture I have shown (by reference).' }, blocks: [] }
        const studio = session.ctx.studio
        if (!studio) return { model: { error: 'The version history is not available right now.' }, blocks: [] }
        const { records } = studio.versions(id)
        if (records.length === 0) return { model: { versions: [], note: 'No edits have been made from this picture yet.' }, blocks: [] }
        const shown = records.filter((r) => r.imageId)
        return {
          model: {
            versions: shown.map((r, i) => ({ n: i + 1, ref: session.refs.refFor(r.imageId!), kind: r.kind, what: (r.prompt || r.note || r.title).slice(0, 200), size: `${r.width}x${r.height}`, parent_ref: shown.find((x) => x.id === r.parentId)?.imageId ? session.refs.refFor(shown.find((x) => x.id === r.parentId)!.imageId!) : null, current: r.imageId === id })),
            note: 'Nothing is ever replaced. To go back, continue editing from an earlier version by its reference.'
          },
          blocks: [{ type: 'images', label: 'Versions, oldest first', ids: shown.map((r) => r.imageId!), basis: 'library' }]
        }
      }
    },
    {
      progress: 'Preparing to open an editor…',
      spec: {
        name: 'propose_external_edit',
        description: 'Propose opening a COPY of a picture in another program (for example Photoshop). When the user saves there, Atlas imports the result as a new version linked to the original. Nothing is changed by this call; the user accepts first.',
        parameters: h.obj({ ref: { type: 'string' }, editor: { type: 'string', description: 'A program name such as "Photoshop"; leave out for the default image program.' } }, ['ref'])
      },
      async run(args, session) {
        const id = h.idsFromRefs({ refs: [args.ref] }, session).ids[0]
        const item = id ? session.ctx.db.getImagesByIds([id])[0] : undefined
        if (!id || !item) return { model: { error: 'I need a picture I have shown (by reference).' }, blocks: [] }
        const editors = session.ctx.studio?.editors() ?? []
        const wanted = h.text(args.editor, 60).toLowerCase()
        const editor = wanted ? editors.find((e) => e.name.toLowerCase().includes(wanted)) : editors[0]
        if (wanted && !editor) return { model: { error: `${h.text(args.editor, 60)} is not set up in the Studio. Known programs: ${editors.map((e) => e.name).join(', ') || 'none (the default image program can be used)'}.` }, blocks: [] }
        const name = editor?.name ?? 'your default image program'
        return {
          model: { status: 'Proposal shown. Nothing opens until the user accepts. Atlas imports the saved result automatically as a new linked version.' },
          blocks: [{ type: 'proposal', id: randomUUID(), title: `Open a copy in ${name}`, reason: 'The original stays untouched. When you save in the program, the result comes back here as a new version.', proposal: { kind: 'external-edit', imageId: id, imageIds: [id], editorId: editor?.id ?? null, editorName: name }, status: 'pending' }]
        }
      }
    },
    {
      progress: 'Preparing an enlargement…',
      spec: {
        name: 'propose_upscale',
        description: 'Propose making a larger copy of ONE picture (by reference), giving the longer side in pixels (or a factor of 2 to 4). Nothing is made: accepting opens the viewer\'s Upscale panel, where the user chooses the preset and presses the button.',
        parameters: h.obj({ ref: { type: 'string' }, target_long_edge: { type: 'integer' }, factor: { type: 'number' }, reason: { type: 'string' } }, ['ref'])
      },
      async run(args, session) {
        const id = h.idsFromRefs({ refs: [args.ref] }, session).ids[0]
        const item = id ? session.ctx.db.getImagesByIds([id])[0] : undefined
        if (!id || !item) return { model: { error: 'I need a picture I have shown (by reference).' }, blocks: [] }
        const long = Math.max(item.width, item.height)
        const factor = typeof args.factor === 'number' && Number.isFinite(args.factor) ? Math.max(1.5, Math.min(8, args.factor)) : 2
        const wanted = typeof args.target_long_edge === 'number' && Number.isFinite(args.target_long_edge) ? Math.round(args.target_long_edge) : Math.round(long * factor)
        const target = Math.max(256, Math.min(16384, wanted))
        return {
          model: { status: 'Proposal shown. Nothing is made until the user presses the button in the viewer.', from: `${item.width}x${item.height}`, target_long_edge: target },
          blocks: [{ type: 'proposal', id: randomUUID(), title: `Enlarge to ${target}px on the longer side`, reason: h.text(args.reason, 300) || `From ${item.width}×${item.height}.`, proposal: { kind: 'upscale', imageId: id, imageIds: [id], targetLongEdge: target, way: '' }, status: 'pending' }]
        }
      }
    },
    {
      progress: 'Developing an artwork concept…',
      spec: {
        name: 'propose_artwork',
        description:
          'Propose creating a NEW artwork from a moodboard. Say which pictures give the atmosphere, composition, colours, materials or subject (by reference), and give the user\'s idea. Optionally write the generation prompt yourself (English, vivid, no file names). Nothing is made: the user reviews the prompt, the method and any cost in the Creative Studio first.',
        parameters: h.obj(
          {
            board: { type: 'string' },
            intent: { type: 'string', description: 'What the user wants, in a sentence.' },
            prompt: { type: 'string', description: 'Optional generation prompt.' },
            negative: { type: 'string' },
            aspect: { type: 'string', enum: ASPECT_KEYS },
            atmosphere_refs: { type: 'array', items: { type: 'string' } },
            composition_refs: { type: 'array', items: { type: 'string' } },
            colour_refs: { type: 'array', items: { type: 'string' } },
            material_refs: { type: 'array', items: { type: 'string' }, description: 'Pictures whose surfaces and textures to borrow (fabric, stone, metal). With a local FLUX.2 model these are shown to the model as close-ups; partial strength, so say so.' },
            subject_refs: { type: 'array', items: { type: 'string' } }
          },
          ['board', 'intent']
        )
      },
      async run(args, session) {
        const board = h.resolveBoard(session.ctx, h.text(args.board))
        if ('error' in board) return { model: board, blocks: [] }
        const detail = session.ctx.db.getMoodboard(board.id)
        const images = (detail?.images ?? []).filter((i) => !i.missing)
        if (images.length === 0) return { model: { error: 'That moodboard has no pictures to create from.' }, blocks: [] }
        const onBoard = new Set(images.map((i) => i.id))
        const roles: Record<string, RefRole[]> = {}
        for (const [key, role] of roleKeys) {
          for (const id of h.idsFromRefs(args, session, key).ids) {
            if (!onBoard.has(id)) continue
            roles[id] = [...(roles[id] ?? []), role]
          }
        }
        const aspect = ASPECT_KEYS.includes(args.aspect as AspectChoice) ? (args.aspect as AspectChoice) : undefined
        const concept = developConcept({ moodboardId: board.id, intent: h.text(args.intent, 600), roles, aspect }, images, {}, board.name)
        const prompt = h.text(args.prompt, 1500) || concept.prompt
        const negative = h.text(args.negative, 600) || concept.negative
        return {
          model: { status: 'Concept shown to the user. Nothing is generated until they review it in the Creative Studio and approve.', title: concept.title, aspect: concept.aspect },
          blocks: [
            {
              type: 'proposal',
              id: randomUUID(),
              title: `Create “${concept.title}” from “${board.name}”`,
              reason: concept.summary,
              proposal: { kind: 'artwork', boardId: board.id, boardName: board.name, imageIds: Object.keys(roles).slice(0, 12), title: concept.title, prompt, negative, aspect: concept.aspect, roles },
              status: 'pending'
            }
          ]
        }
      }
    },
    {
      progress: 'Preparing changes to the moodboard…',
      spec: {
        name: 'propose_board_changes',
        description:
          'Propose changes to an EXISTING moodboard: remove pictures that are on it (remove_refs), add pictures (add_refs, e.g. as replacements), and optionally rearrange (arrange: "tidy" for neat rows, "hero" for one large picture, "keep" for no layout change). The user sees before and after and decides; every change can be undone.',
        parameters: h.obj(
          {
            board: { type: 'string' },
            remove_refs: { type: 'array', items: { type: 'string' } },
            add_refs: { type: 'array', items: { type: 'string' } },
            arrange: { type: 'string', enum: ['tidy', 'hero', 'keep'] },
            reason: { type: 'string' }
          },
          ['board']
        )
      },
      async run(args, session) {
        const board = h.resolveBoard(session.ctx, h.text(args.board))
        if ('error' in board) return { model: board, blocks: [] }
        const detail = session.ctx.db.getMoodboard(board.id)
        const onBoard = new Set((detail?.images ?? []).map((i) => i.id))
        const remove = h.idsFromRefs(args, session, 'remove_refs').ids.filter((id) => onBoard.has(id))
        const add = h.idsFromRefs(args, session, 'add_refs').ids.filter((id) => !onBoard.has(id) || remove.includes(id))
        const arrange = args.arrange === 'tidy' || args.arrange === 'hero' ? args.arrange : 'keep'
        if (remove.length === 0 && add.length === 0 && arrange === 'keep') return { model: { error: 'No change given: name pictures on the board to remove, pictures to add, or a layout.' }, blocks: [] }
        const parts: string[] = []
        if (remove.length) parts.push(`remove ${remove.length}`)
        if (add.length) parts.push(`add ${add.length}`)
        if (arrange !== 'keep') parts.push(arrange === 'hero' ? 'give one picture the lead' : 'tidy the layout')
        return {
          model: { status: 'Proposal shown with before and after. The board is NOT changed until the user accepts, and it can be undone.' },
          blocks: [
            {
              type: 'proposal',
              id: randomUUID(),
              title: `Change “${board.name}”: ${parts.join(', ')}`,
              reason: h.text(args.reason, 300),
              proposal: { kind: 'board-change', boardId: board.id, boardName: board.name, imageIds: add, removeIds: remove, arrange },
              status: 'pending'
            }
          ]
        }
      }
    }
  ]
}

export type { ImageItem }
