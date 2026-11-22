import { randomUUID } from 'node:crypto'
import { categoriesForTask, recommend } from '../modelLibrary/fit'
import { modelLibrary, openLibraryUi } from '../modelLibrary/access'
import { CATEGORIES, FIT_LABEL, TIER_LABEL, type EntryView } from '../../shared/modelLibrary'
import type { ToolHelpers } from './studioTools'
import type { Tool } from './tools'

const sizeText = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes > 0 ? `${Math.round(bytes / 1e6)} MB` : 'unknown size')

function compact(v: EntryView): Record<string, unknown> {
  return {
    id: v.entry.id,
    name: v.entry.name,
    version: v.entry.version,
    does: v.entry.summary,
    categories: v.entry.categories.map((c) => CATEGORIES[c].label),
    fits_this_computer: FIT_LABEL[v.fit.level],
    why: v.fit.reasons.slice(0, 3),
    verification: v.entry.verification.status === 'verified' ? 'tested and verified by Atlas' : v.entry.verification.status === 'documented' ? 'documented, not tested by Atlas' : 'experimental',
    tested_on_this_kind_of_card: v.fit.testedHere,
    state: v.state.kind === 'installed' ? 'installed' : v.state.kind === 'found-in-comfyui' ? 'present in the user\'s ComfyUI' : v.state.kind === 'partial' ? 'partly downloaded' : v.state.kind === 'unknown' ? 'unknown' : 'not installed',
    install: v.way === 'atlas' ? 'Atlas can install it after the user agrees' : v.way === 'ollama' ? 'through the user\'s Ollama after they agree' : v.way === 'manual' ? 'official steps only (Atlas cannot install it here)' : v.way === 'atlas-model' ? 'part of Atlas' : 'not available here yet',
    download: v.plan ? sizeText(v.plan.downloadBytes) : null,
    licence: `${v.entry.licence.name}${v.entry.licence.commercialUse === 'no' ? ' (not for commercial use)' : v.entry.licence.commercialUse === 'conditions' ? ' (commercial use has conditions)' : ''}`
  }
}

/** The Companion's view of the AI Model Library: it can read what exists, recommend, and open the library; it never installs. */
export function modelTools(h: ToolHelpers): Tool[] {
  const unavailable = { model: { error: 'The AI Model Library is not ready yet.' }, blocks: [] }
  return [
    {
      progress: 'Looking at this computer and the model library…',
      spec: {
        name: 'models_overview',
        description: 'The AI Model Library: this computer\'s graphics card and memory (how much a model can really use, dedicated or shared), whether Atlas\'s own AI, a ComfyUI of the user\'s or a remote one is connected, and every catalogued model with how well it suits this computer, whether Atlas itself tested it, and whether it is installed. Call this before recommending a model so you only suggest what exists and fits.',
        parameters: h.obj({ category: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Only models of this kind.' }, search: { type: 'string', description: 'Words to look for in names and abilities.' } })
      },
      async run(args) {
        const library = modelLibrary()
        if (!library) return unavailable
        const o = await library.overview()
        const q = h.text(args.search, 80).toLowerCase()
        const category = typeof args.category === 'string' ? args.category : ''
        const list = o.entries.filter((v) => (!category || (v.entry.categories as string[]).includes(category)) && (!q || `${v.entry.name} ${v.entry.summary}`.toLowerCase().includes(q)))
        return {
          model: {
            computer: { graphics: o.hardware.primary?.name ?? 'none found', tier: TIER_LABEL[o.hardware.tier], memory_for_models_gb: o.hardware.modelMemoryGB, memory_note: o.hardware.memoryNote, architecture: o.hardware.arch, runtime_notes: o.hardware.runtime.notes },
            comfyui: o.mode === 'managed' ? 'Atlas\'s own' : o.mode === 'connect' ? 'the user\'s own (Atlas only reads it)' : 'not set up',
            ollama: o.ollama.running ? `running with ${o.ollama.models.length} models` : 'not running',
            models: list.map(compact),
            note: 'Nothing is downloaded unless the user agrees in the AI Model Library. Only claim a model works when verification says it was tested.'
          },
          blocks: []
        }
      }
    },
    {
      progress: 'Choosing models for this computer…',
      spec: {
        name: 'recommend_models',
        description: 'Recommend catalogued models for a task on THIS computer, ranked by fit and by whether Atlas tested them. Say what each can and cannot do and be honest about verification status. Task in plain words, for example "photorealistic portraits", "surreal paintings", "use my moodboard as a reference", "upscale with detail", "describe my pictures locally".',
        parameters: h.obj(
          {
            task: { type: 'string' },
            commercial: { type: 'boolean', description: 'The results will be used commercially: leaves out non-commercial licences.' },
            max_download_gb: { type: 'number' },
            local_only: { type: 'boolean' }
          },
          ['task']
        )
      },
      async run(args) {
        const library = modelLibrary()
        if (!library) return unavailable
        const overview = await library.overview()
        const task = h.text(args.task, 300)
        const installed = new Set(overview.entries.filter((v) => v.state.kind === 'installed' || v.state.kind === 'found-in-comfyui').map((v) => v.entry.id))
        const recs = recommend(library.catalog().entries, overview.hardware, { categories: categoriesForTask(task), preferences: { commercial: args.commercial === true, maxDownloadGB: typeof args.max_download_gb === 'number' ? args.max_download_gb : undefined, localOnly: args.local_only === true } }, installed).slice(0, 5)
        const views = new Map(overview.entries.map((v) => [v.entry.id, v]))
        return {
          model: {
            task,
            recommendations: recs.map((r) => ({ ...compact(views.get(r.entry.id)!), why_recommended: r.why })),
            none: recs.length === 0 ? 'Nothing in the library fits that on this computer. Say so, and offer the closest alternative or a cloud method the user has set up.' : undefined
          },
          blocks: []
        }
      }
    },
    {
      progress: 'Reading the model\'s details…',
      spec: {
        name: 'model_details',
        description: 'Everything the library knows about one model: abilities and their strength, official source, licence, version, files and sizes, requirements, test results, how to install it here.',
        parameters: h.obj({ id: { type: 'string' } }, ['id'])
      },
      async run(args) {
        const library = modelLibrary()
        if (!library) return unavailable
        const v = (await library.overview()).entries.find((e) => e.entry.id === h.text(args.id, 80))
        if (!v) return { model: { error: 'That model is not in the library. Call models_overview to see the ids.' }, blocks: [] }
        const e = v.entry
        return {
          model: { ...compact(v), details: e.details, abilities: e.capabilities.map((c) => `${c.label} (${c.level})`), source: e.source, licence: e.licence, requirements: e.requirements, tests: e.verification.checks, verification_note: e.verification.note ?? null, steps: v.way === 'manual' ? v.instructions : undefined, depends_on: e.dependsOn },
          blocks: []
        }
      }
    },
    {
      progress: 'Opening the AI Model Library…',
      spec: {
        name: 'open_model_library',
        description: 'Open the real, interactive AI Model Library window for the user (search, categories, fit for this computer, details, installing). Use this whenever the user asks to see, open, browse or look through the library or the models, and when they ask what models are available: open it and answer in ONE short sentence. Do NOT list the models, and do not write tables of them, in the chat. Opening only shows the catalogue; nothing is downloaded.',
        parameters: h.obj({ category: { type: 'string', enum: Object.keys(CATEGORIES), description: 'Open on this kind of model.' }, search: { type: 'string', description: 'Open with this search.' }, id: { type: 'string', description: 'Open on this one model.' } })
      },
      async run(args) {
        const library = modelLibrary()
        if (!library) return unavailable
        const id = h.text(args.id, 80)
        const known = id ? (await library.overview()).entries.some((e) => e.entry.id === id) : false
        const opened = openLibraryUi({ entry: known ? id : undefined, search: h.text(args.search, 80) || undefined, category: typeof args.category === 'string' && args.category in CATEGORIES ? args.category : undefined })
        return { model: opened ? { status: 'The AI Model Library is open in the window now. Tell the user in one short sentence; do not repeat its contents.' } : { error: 'The library window could not be opened from here. Tell the user to use “AI Models” in the left-hand menu.' }, blocks: [] }
      }
    },
    {
      progress: 'Preparing a suggestion…',
      spec: {
        name: 'propose_model_install',
        description: 'Suggest a model from the library. Accepting opens the AI Model Library on that model, where the user sees the exact download, licence and free space and decides. Nothing is downloaded by accepting.',
        parameters: h.obj({ id: { type: 'string' }, reason: { type: 'string' } }, ['id', 'reason'])
      },
      async run(args) {
        const library = modelLibrary()
        if (!library) return unavailable
        const v = (await library.overview()).entries.find((e) => e.entry.id === h.text(args.id, 80))
        if (!v) return { model: { error: 'That model is not in the library.' }, blocks: [] }
        return {
          model: { status: 'Proposal shown. Nothing is installed until the user agrees in the library.' },
          blocks: [{ type: 'proposal', id: randomUUID(), title: `Look at ${v.entry.name}`, reason: h.text(args.reason, 300), proposal: { kind: 'open-models', imageIds: [], entryId: v.entry.id, entryName: v.entry.name, search: '' }, status: 'pending' }]
        }
      }
    }
  ]
}
