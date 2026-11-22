import { randomUUID } from 'node:crypto'
import { DUPLICATE_LABELS, ORGANIZE_KINDS, STRUCTURE_LABELS, type OrganizeKind, type OrganizeOverview, type OrganizePlanInfo, type OrganizeScope } from '../../shared/organizer'
import type { RefineOp } from '../organizer/engine'
import type { Tool, ToolSession } from './tools'
import type { ToolHelpers } from './studioTools'

const STRUCTURES = Object.keys(STRUCTURE_LABELS)
const DUPLICATES = Object.keys(DUPLICATE_LABELS)

const latest = (plans: OrganizePlanInfo[], id: string): OrganizePlanInfo | null => {
  if (id) return plans.find((p) => p.id === id) ?? null
  return [...plans].filter((p) => p.status !== 'cancelled').sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
}

/** A compact account of a plan for the model: what exists, how it is grouped, what is not certain. */
function summarize(o: OrganizeOverview): Record<string, unknown> {
  return {
    plan_id: o.plan.id,
    name: o.plan.name,
    status: o.plan.status,
    pictures: o.plan.total,
    read_by_image_model: o.plan.understood,
    structure: o.plan.settings.structure,
    duplicates_policy: o.plan.settings.duplicates,
    excluded_kinds: o.plan.settings.excludeKinds,
    kinds: o.kinds.map((k) => ({
      kind: k.kind,
      label: k.label,
      count: k.count,
      excluded: k.excluded,
      folders: k.categories.slice(0, 14).map((c) => ({ name: c.name, key: c.key, count: c.count, confidence: c.confidence, note: c.note }))
    })),
    copies_and_versions: { groups: o.duplicates.groups, extra_files: o.duplicates.extras, exact: o.duplicates.exact, near: o.duplicates.near, versions: o.duplicates.versions },
    without_model_reading: o.withoutModel,
    folder_tree_top: o.tree.slice(0, 24)
  }
}

export function organizerTools(h: ToolHelpers): Tool[] {
  const { text, obj } = h

  const scopeFrom = (args: Record<string, unknown>, session: ToolSession): { scope: OrganizeScope; label: string } | { error: string } => {
    const wanted = text(args.source, 300)
    if (!wanted || /^(all|everything|whole library|the whole library|hela biblioteket)$/i.test(wanted)) return { scope: { all: true }, label: 'the whole library' }
    const roots = session.ctx.db.listRoots()
    const low = wanted.toLowerCase()
    const hits = roots.filter((r) => r.name.toLowerCase() === low || r.path.toLowerCase() === low || r.path.toLowerCase().includes(low) || r.name.toLowerCase().includes(low))
    if (hits.length > 0) return { scope: { rootIds: hits.map((r) => r.id) }, label: hits.length === 1 ? `“${hits[0]!.name}”` : `${hits.length} sources` }
    return { error: `No source matches “${wanted}”. The sources are: ${roots.map((r) => r.name).join(', ') || 'none yet'}.` }
  }

  return [
    {
      spec: {
        name: 'organize_start',
        description:
          'Begin analysing pictures so they can be organized into folders (by kind: finished artwork, photographs, technical screenshots, experiments, uncertain; by subject and style; with copies and versions found). Nothing is copied or moved: this only reads and plans. Analysis runs in the background and can be paused and resumed.',
        parameters: obj({
          name: { type: 'string', description: 'A short name for this organization.' },
          source: { type: 'string', description: 'Which source (a folder or drive added to Atlas) to organize, by name or part of its path. Omit or "all" for the whole library.' },
          structure: { type: 'string', enum: STRUCTURES, description: 'How the folders are laid out. kind-subject (default): Kind / Subject. subject; year-subject; kind; flat.' },
          duplicates: { type: 'string', enum: DUPLICATES, description: 'separate (default): copies go to their own folder, best one stays; best-only: copy only the best version; keep-all.' },
          categories: { type: 'array', items: { type: 'object' }, description: 'The user’s own categories as [{name, description}], e.g. {name:"Cats", description:"cats and kittens"}.' }
        })
      },
      progress: 'Starting the analysis…',
      async run(args, session) {
        const engine = session.ctx.organizer
        if (!engine) return { model: { error: 'The organizer is not available right now.' }, blocks: [] }
        const scoped = scopeFrom(args, session)
        if ('error' in scoped) return { model: { error: scoped.error }, blocks: [] }
        const count = engine.countScope(scoped.scope)
        if (count === 0) return { model: { error: 'There are no pictures in that selection.' }, blocks: [] }
        const settings: Record<string, unknown> = {}
        if (typeof args.structure === 'string' && STRUCTURES.includes(args.structure)) settings.structure = args.structure
        if (typeof args.duplicates === 'string' && DUPLICATES.includes(args.duplicates)) settings.duplicates = args.duplicates
        if (Array.isArray(args.categories)) {
          settings.custom = args.categories
            .map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>) : {}))
            .map((c) => ({ name: text(c.name, 80), description: text(c.description, 300) }))
            .filter((c) => c.name && c.description)
            .slice(0, 20)
        }
        const plan = engine.createPlan(text(args.name, 80) || `Organize ${scoped.label}`, scoped.scope, settings)
        engine.start(plan.id)
        return {
          model: { status: 'Analysis started in the background. Nothing is copied or moved. The user can follow progress on the Organizer page. Call organize_overview to see the result once it is ready.', plan_id: plan.id, pictures: count, source: scoped.label },
          blocks: [{ type: 'note', text: `Analysing ${count.toLocaleString()} pictures from ${scoped.label}. Nothing is copied or moved.` }]
        }
      }
    },
    {
      spec: {
        name: 'organize_overview',
        description: 'Show how the pictures of an organization are grouped so far: kinds, proposed folders with counts, copies and versions, and the folder tree. Use before suggesting changes and after refining.',
        parameters: obj({ plan_id: { type: 'string', description: 'Omit for the most recent organization.' } })
      },
      progress: 'Reading the organization…',
      async run(args, session) {
        const engine = session.ctx.organizer
        if (!engine) return { model: { error: 'The organizer is not available right now.' }, blocks: [] }
        const plan = latest(engine.plans(), text(args.plan_id, 60))
        if (!plan) return { model: { error: 'There is no organization yet. Use organize_start first.' }, blocks: [] }
        if (plan.status === 'analyzing' || plan.status === 'draft') {
          return { model: { status: 'STILL_ANALYSING', progress: plan.progress, note: 'Tell the user it is not finished; do not guess the grouping.' }, blocks: [] }
        }
        return { model: summarize(engine.overview(plan.id)), blocks: [] }
      }
    },
    {
      spec: {
        name: 'organize_refine',
        description:
          'Change the proposed organization at the user’s request. Operations: structure {value}, duplicates {value}, rename {from, to, kind?} (from = the folder key or name), merge {from:[names], into, kind?}, exclude/include {kind}, custom {name, description} (new category), remove_custom {name}, reclassify {from, to} (treat every picture Atlas called one kind as another, e.g. from uncertain to artwork), min_group {value}. Changes only the plan; no file is touched.',
        parameters: obj(
          {
            plan_id: { type: 'string', description: 'Omit for the most recent organization.' },
            operations: { type: 'array', items: { type: 'object' }, description: 'List of {op, ...} objects.' }
          },
          ['operations']
        )
      },
      progress: 'Changing the plan…',
      async run(args, session) {
        const engine = session.ctx.organizer
        if (!engine) return { model: { error: 'The organizer is not available right now.' }, blocks: [] }
        const plan = latest(engine.plans(), text(args.plan_id, 60))
        if (!plan) return { model: { error: 'There is no organization yet.' }, blocks: [] }
        if (plan.status === 'analyzing' || plan.status === 'draft') return { model: { status: 'STILL_ANALYSING' }, blocks: [] }
        const ops: RefineOp[] = []
        for (const raw of (Array.isArray(args.operations) ? args.operations : []).slice(0, 20)) {
          const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
          const kind = ORGANIZE_KINDS.find((k) => k === o.kind) as OrganizeKind | undefined
          switch (o.op) {
            case 'structure':
              if (STRUCTURES.includes(String(o.value))) ops.push({ op: 'structure', value: o.value as never })
              break
            case 'duplicates':
              if (DUPLICATES.includes(String(o.value))) ops.push({ op: 'duplicates', value: o.value as never })
              break
            case 'rename':
              ops.push({ op: 'rename', from: text(o.from, 120), to: text(o.to, 80), kind })
              break
            case 'merge':
              ops.push({ op: 'merge', from: Array.isArray(o.from) ? o.from.map((x) => text(x, 120)).filter(Boolean).slice(0, 30) : [], into: text(o.into, 80), kind })
              break
            case 'exclude':
            case 'include':
              if (kind) ops.push({ op: o.op, kind })
              break
            case 'custom':
              ops.push({ op: 'custom', name: text(o.name, 80), description: text(o.description, 300) })
              break
            case 'remove_custom':
              ops.push({ op: 'remove_custom', name: text(o.name, 80) })
              break
            case 'reclassify': {
              const from = ORGANIZE_KINDS.find((k) => k === o.from)
              const to = ORGANIZE_KINDS.find((k) => k === o.to)
              if (from && to) ops.push({ op: 'reclassify', from, to })
              break
            }
            case 'min_group':
              if (typeof o.value === 'number') ops.push({ op: 'min_group', value: o.value })
              break
          }
        }
        if (ops.length === 0) return { model: { error: 'No valid operation was given.' }, blocks: [] }
        const result = engine.refine(plan.id, ops)
        return { model: { applied: result.messages, now: summarize(result.overview) }, blocks: [] }
      }
    },
    {
      spec: {
        name: 'organize_export',
        description:
          'Offer to copy the approved organization to a folder. This only shows the user a request; they choose the destination folder and see every operation, the space needed and any conflicts on the Organizer page before anything is copied. Originals are never moved or deleted.',
        parameters: obj({ plan_id: { type: 'string', description: 'Omit for the most recent organization.' } })
      },
      progress: 'Preparing the export…',
      async run(args, session) {
        const engine = session.ctx.organizer
        if (!engine) return { model: { error: 'The organizer is not available right now.' }, blocks: [] }
        const plan = latest(engine.plans(), text(args.plan_id, 60))
        if (!plan) return { model: { error: 'There is no organization yet.' }, blocks: [] }
        if (plan.status !== 'ready' && plan.status !== 'done' && plan.status !== 'export-paused') {
          return { model: { status: 'NOT_READY', plan_status: plan.status, note: 'The analysis is not finished, so there is nothing to export yet.' }, blocks: [] }
        }
        return {
          model: { status: 'WAITING_FOR_THE_USER: a request was shown. Nothing is copied until the user chooses a destination and starts the copy on the Organizer page.' },
          blocks: [
            {
              type: 'proposal',
              id: randomUUID(),
              title: `Copy “${plan.name}” into folders`,
              reason: `${plan.total.toLocaleString()} pictures. You choose the destination, then see every file that would be copied, the space it needs and any name conflicts. Copies only: the originals stay where they are.`,
              proposal: { kind: 'organize-export', imageIds: [], planId: plan.id, planName: plan.name, pictures: plan.total },
              status: 'pending'
            }
          ]
        }
      }
    }
  ]
}
