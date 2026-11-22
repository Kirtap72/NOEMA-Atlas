/**
 * The user's own ComfyUI workflows: finding them, saying what each one does and what it needs, turning the editor's
 * format into the one ComfyUI runs, and filling in a prompt, a picture and a seed. The user's files are only read.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { hasModel, type ModelCategory, type ModelInventory } from './comfyModels'

export type WorkflowKind = 'generate' | 'edit' | 'upscale' | 'video' | 'audio' | 'other'
export type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export interface WorkflowInfo {
  id: string
  name: string
  file: string
  format: 'api' | 'ui'
  kind: WorkflowKind
  /** Model files it needs, with where ComfyUI keeps them. */
  needs: Array<{ name: string; folder: string; url: string | null }>
  /** The ones that are not installed. */
  missing: Array<{ name: string; folder: string; url: string | null }>
  /** Whether Atlas can run it now (its models are there and Atlas understands its format). */
  runnable: boolean
  /** In plain words, why not (or a useful note). */
  why: string | null
}

const SAMPLER = /^(KSampler|KSamplerAdvanced|SamplerCustom|SamplerCustomAdvanced)$/
const EMPTY_LATENT = /^Empty.*Latent/i
const SKIPPED_UI_TYPES = new Set(['Note', 'MarkdownNote', 'PrimitiveNode', 'Reroute'])

interface UiNode {
  id: number
  type: string
  mode?: number
  widgets_values?: unknown
  inputs?: Array<{ name: string; type?: string; link?: number | null; widget?: { name: string } }>
  outputs?: Array<{ name?: string; type?: string; links?: number[] | null }>
  properties?: { models?: Array<{ name?: string; url?: string; directory?: string }> }
}
export interface UiWorkflow {
  nodes: UiNode[]
  links: Array<[number, number, number, number, number, string]>
  definitions?: { subgraphs?: Array<{ nodes?: UiNode[] }> }
}

const FOLDER_CATEGORY: Record<string, ModelCategory> = {
  checkpoints: 'checkpoints',
  diffusion_models: 'diffusion',
  unet: 'diffusion',
  vae: 'vae',
  text_encoders: 'textEncoders',
  clip: 'textEncoders',
  loras: 'loras',
  controlnet: 'controlnet',
  upscale_models: 'upscale'
}

const LOADERS: Record<string, { folder: string; inputs: string[] }> = {
  CheckpointLoaderSimple: { folder: 'checkpoints', inputs: ['ckpt_name'] },
  CheckpointLoader: { folder: 'checkpoints', inputs: ['ckpt_name'] },
  ImageOnlyCheckpointLoader: { folder: 'checkpoints', inputs: ['ckpt_name'] },
  UNETLoader: { folder: 'diffusion_models', inputs: ['unet_name'] },
  VAELoader: { folder: 'vae', inputs: ['vae_name'] },
  CLIPLoader: { folder: 'text_encoders', inputs: ['clip_name'] },
  DualCLIPLoader: { folder: 'text_encoders', inputs: ['clip_name1', 'clip_name2'] },
  TripleCLIPLoader: { folder: 'text_encoders', inputs: ['clip_name1', 'clip_name2', 'clip_name3'] },
  LoraLoader: { folder: 'loras', inputs: ['lora_name'] },
  LoraLoaderModelOnly: { folder: 'loras', inputs: ['lora_name'] },
  ControlNetLoader: { folder: 'controlnet', inputs: ['control_net_name'] },
  UpscaleModelLoader: { folder: 'upscale_models', inputs: ['model_name'] }
}

export function isApiFormat(data: unknown): data is ApiWorkflow {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const values = Object.values(data as Record<string, unknown>)
  return values.length > 0 && values.every((v) => v && typeof v === 'object' && typeof (v as { class_type?: unknown }).class_type === 'string')
}

export function isUiFormat(data: unknown): data is UiWorkflow {
  return Boolean(data && typeof data === 'object' && Array.isArray((data as { nodes?: unknown }).nodes))
}

function uiTypes(ui: UiWorkflow): { types: Set<string>; subgraph: boolean } {
  const types = new Set<string>()
  let subgraph = false
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i
  for (const node of ui.nodes) {
    if (uuid.test(node.type)) subgraph = true
    else types.add(node.type)
  }
  for (const sub of ui.definitions?.subgraphs ?? []) for (const node of sub.nodes ?? []) types.add(node.type)
  return { types, subgraph }
}

function needsOf(data: unknown): Array<{ name: string; folder: string; url: string | null }> {
  const out = new Map<string, { name: string; folder: string; url: string | null }>()
  const add = (name: unknown, folder: string, url: string | null = null): void => {
    if (typeof name !== 'string' || !name.trim() || /^(none|null)$/i.test(name.trim())) return
    if (!/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i.test(name)) return
    const key = name.toLowerCase()
    const existing = out.get(key)
    if (!existing || (!existing.url && url)) out.set(key, { name, folder, url })
  }
  if (isApiFormat(data)) {
    for (const node of Object.values(data)) {
      const loader = LOADERS[node.class_type]
      if (loader) for (const input of loader.inputs) add(node.inputs[input], loader.folder)
    }
  } else if (isUiFormat(data)) {
    const nodes = [...data.nodes, ...(data.definitions?.subgraphs ?? []).flatMap((s) => s.nodes ?? [])]
    for (const node of nodes) {
      if (node.mode === 2 || node.mode === 4) continue
      for (const model of node.properties?.models ?? []) add(model.name, model.directory ?? 'checkpoints', model.url ?? null)
      const loader = LOADERS[node.type]
      const widgets = Array.isArray(node.widgets_values) ? node.widgets_values : []
      if (loader) loader.inputs.forEach((_, i) => add(widgets[i], loader.folder))
    }
  }
  return Array.from(out.values())
}

function kindOf(name: string, types: Set<string>): WorkflowKind {
  const has = (pattern: RegExp): boolean => Array.from(types).some((t) => pattern.test(t))
  if (has(/VideoCombine|SaveVideo|CreateVideo|SaveAnimated|SaveWEBM|SaveWEBP/i) && !has(/^SaveImage$/)) return 'video'
  if (has(/^(SaveAudio|PreviewAudio|SaveAudioMP3|SaveAudioOpus)/)) return 'audio'
  const sampler = has(SAMPLER)
  const emptyLatent = has(EMPTY_LATENT)
  if (has(/UpscaleModelLoader|ImageUpscaleWithModel|UltimateSDUpscale|SUPIR|SeedVR/i) && (!sampler || !emptyLatent)) return 'upscale'
  if (/upscal/i.test(name) && !emptyLatent) return 'upscale'
  if (has(/^LoadImage/) && sampler && !emptyLatent) return 'edit'
  if (/edit|img2img|image[_ -]to|inpaint|outpaint/i.test(name) && has(/^LoadImage/)) return 'edit'
  if (sampler || has(/^(KSampler|SamplerCustom)/)) return 'generate'
  return 'other'
}

export function inspectWorkflow(file: string, data: unknown, inventory: ModelInventory | null): WorkflowInfo {
  const name = basename(file).replace(/\.json$/i, '').replace(/[_]+/g, ' ').trim()
  const id = createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 12)
  const api = isApiFormat(data)
  const ui = !api && isUiFormat(data)
  const typeInfo = api
    ? { types: new Set(Object.values(data).map((n) => n.class_type)), subgraph: false }
    : ui
      ? uiTypes(data as UiWorkflow)
      : { types: new Set<string>(), subgraph: false }
  const kind = api || ui ? kindOf(name, typeInfo.types) : 'other'
  const needs = api || ui ? needsOf(data) : []
  const missing = inventory ? needs.filter((n) => !hasModel(inventory, n.name, FOLDER_CATEGORY[n.folder] ? [FOLDER_CATEGORY[n.folder]!] : undefined)) : []
  let why: string | null = null
  let runnable = api || ui
  if (!api && !ui) {
    runnable = false
    why = 'This file is not a ComfyUI workflow.'
  } else if (kind === 'video' || kind === 'audio') {
    runnable = false
    why = kind === 'video' ? 'This workflow makes video. Atlas makes pictures.' : 'This workflow makes sound. Atlas makes pictures.'
  } else if (kind === 'other') {
    runnable = false
    why = 'Atlas could not tell what this workflow makes.'
  } else if (typeInfo.subgraph) {
    runnable = false
    why = 'This workflow uses ComfyUI’s newer grouped nodes, which Atlas cannot open directly. In ComfyUI, choose Export (API) and pick the exported file as your workflow.'
  } else if (missing.length > 0) {
    runnable = false
    why = `Needs ${missing.slice(0, 3).map((m) => `“${m.name}”`).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''} in ComfyUI’s ${missing[0]!.folder} folder. Open the workflow in ComfyUI to download ${missing.length === 1 ? 'it' : 'them'}.`
  }
  return { id, name, file, format: api ? 'api' : 'ui', kind, needs, missing, runnable, why }
}

/** All workflow files in the usual places, read-only. Skips anything that is not JSON, and very large files. */
/** A readable name: the file's path inside the folder, but a generic file name (workflow_api.json) takes its folder's name. */
export function workflowTitle(base: string, file: string): string {
  const parts = relative(base, file).replace(/\.json$/i, '').split(/[\\/]+/)
  if (/^workflow([_-]?(api|ui))?$/i.test(parts[parts.length - 1]!)) parts.pop()
  const named = parts.length > 0 ? parts : [basename(dirname(file))]
  return named.join(' ').replace(/_+/g, ' ').trim()
}

export function scanWorkflows(folders: string[], inventory: ModelInventory | null, options: { hideNonWorkflows?: boolean } = {}): WorkflowInfo[] {
  const found = new Map<string, WorkflowInfo>()
  const walk = (base: string, folder: string, depth: number): void => {
    if (depth > 2 || found.size > 400) return
    let entries
    try {
      entries = readdirSync(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(folder, entry.name)
      if (entry.isDirectory()) walk(base, full, depth + 1)
      else if (/\.json$/i.test(entry.name)) {
        try {
          if (statSync(full).size > 8 * 1024 * 1024) continue
          const info = inspectWorkflow(full, JSON.parse(readFileSync(full, 'utf8')) as unknown, inventory)
          // Other JSON in a project folder (manifests, settings) is not a workflow: leave it out of the list.
          if (options.hideNonWorkflows && info.kind === 'other' && info.why === 'This file is not a ComfyUI workflow.') continue
          info.name = workflowTitle(base, full)
          found.set(full.toLowerCase(), info)
        } catch {
          // Not valid JSON: ignore.
        }
      }
    }
  }
  for (const folder of folders) if (existsSync(folder)) walk(folder, folder, 0)
  // A project often keeps the editor's copy (workflow_ui.json) beside the runnable one (workflow_api.json): list one.
  const all = Array.from(found.values())
  for (const info of all) {
    if (info.format !== 'ui' || !/^workflow[_-]?ui\.json$/i.test(basename(info.file))) continue
    const dir = dirname(info.file).toLowerCase()
    if (all.some((o) => o !== info && o.format === 'api' && dirname(o.file).toLowerCase() === dir)) found.delete(info.file.toLowerCase())
  }
  const rank: Record<WorkflowKind, number> = { generate: 0, edit: 1, upscale: 2, other: 3, video: 4, audio: 5 }
  return Array.from(found.values()).sort((a, b) => Number(b.runnable) - Number(a.runnable) || rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name))
}

// ---- turning the editor's format into the one ComfyUI runs ---------------------------------------------------------

export type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> }; input_order?: { required?: string[]; optional?: string[] }; output_node?: boolean }>

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])
const CONTROL_VALUES = new Set(['fixed', 'increment', 'decrement', 'randomize'])

function isWidgetSpec(spec: unknown[] | undefined): boolean {
  if (!spec) return false
  const type = spec[0]
  const options = (spec[1] ?? {}) as { forceInput?: boolean }
  if (options.forceInput) return false
  return Array.isArray(type) || (typeof type === 'string' && WIDGET_TYPES.has(type))
}

/**
 * The editor saves a graph with positions, link tables and widget values in order; ComfyUI runs a map of nodes with
 * named inputs. The node definitions of the running ComfyUI (object_info) say which value belongs to which input.
 */
export function convertUiToApi(ui: UiWorkflow, info: ObjectInfo): { prompt: ApiWorkflow } | { problem: string } {
  const nodes = new Map(ui.nodes.map((n) => [n.id, n]))
  const links = new Map(ui.links.map((l) => [l[0], { origin: l[1], slot: l[2] }]))
  if ((ui.definitions?.subgraphs ?? []).length > 0 && ui.nodes.some((n) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(n.type))) {
    return { problem: 'This workflow uses ComfyUI’s newer grouped nodes. Export it from ComfyUI with Export (API) and use that file.' }
  }

  type Source = { node: string; slot: number } | { literal: unknown } | null
  const resolve = (linkId: number | null | undefined, depth = 0): Source => {
    if (linkId === null || linkId === undefined || depth > 24) return null
    const link = links.get(linkId)
    if (!link) return null
    const origin = nodes.get(link.origin)
    if (!origin) return null
    if (origin.type === 'PrimitiveNode') return { literal: Array.isArray(origin.widgets_values) ? origin.widgets_values[0] : null }
    if (origin.type === 'Reroute' || origin.mode === 4) {
      // A passed-through node: follow the input of the same kind.
      const wantedType = origin.outputs?.[link.slot]?.type
      const through = (origin.inputs ?? []).find((i) => i.link !== null && i.link !== undefined && (origin.type === 'Reroute' || i.type === wantedType))
      return through ? resolve(through.link, depth + 1) : null
    }
    return { node: String(origin.id), slot: link.slot }
  }

  const prompt: ApiWorkflow = {}
  let outputs = 0
  for (const node of ui.nodes) {
    if (SKIPPED_UI_TYPES.has(node.type) || node.mode === 2 || node.mode === 4) continue
    const definition = info[node.type]
    if (!definition) return { problem: `This workflow needs the ComfyUI node “${node.type}”, which is not installed.` }
    const required = definition.input?.required ?? {}
    const optional = definition.input?.optional ?? {}
    const order = [...(definition.input_order?.required ?? Object.keys(required)), ...(definition.input_order?.optional ?? Object.keys(optional))]
    const specs: Record<string, unknown[]> = { ...required, ...optional }
    const widgets = Array.isArray(node.widgets_values) ? (node.widgets_values as unknown[]) : []
    let index = 0
    const inputs: Record<string, unknown> = {}
    for (const name of order) {
      const spec = specs[name]
      const entry = (node.inputs ?? []).find((i) => i.name === name)
      const linked = entry?.link !== null && entry?.link !== undefined ? resolve(entry.link) : null
      if (isWidgetSpec(spec)) {
        const value = widgets[index++]
        const options = (spec?.[1] ?? {}) as { control_after_generate?: boolean }
        if (options.control_after_generate || ((name === 'seed' || name === 'noise_seed') && typeof widgets[index] === 'string' && CONTROL_VALUES.has(widgets[index] as string))) index += 1
        if (linked && 'node' in linked) inputs[name] = [linked.node, linked.slot]
        else if (linked && 'literal' in linked) inputs[name] = linked.literal
        else if (value !== undefined) inputs[name] = value
      } else if (linked && 'node' in linked) inputs[name] = [linked.node, linked.slot]
      else if (linked && 'literal' in linked) inputs[name] = linked.literal
    }
    prompt[String(node.id)] = { class_type: node.type, inputs }
    if (definition.output_node) outputs += 1
  }
  if (outputs === 0) return { problem: 'This workflow has no step that saves or shows a picture.' }
  return { prompt }
}

// ---- filling in a prompt, a picture and a seed ----------------------------------------------------------------------

export interface BindValues {
  prompt?: string
  negative?: string
  seed?: number
  width?: number
  height?: number
  /** Name of a picture already uploaded to ComfyUI. */
  image?: string
  /** How much a start picture may change, 0 to 1. */
  denoise?: number
}

const isLink = (value: unknown): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number'

/** Finds the text node feeding a "positive" or "negative" input of a sampler, a few steps upstream at most. */
function findTextNode(workflow: ApiWorkflow, start: unknown, hops = 6): { id: string; input: string } | null {
  const seen = new Set<string>()
  const queue: Array<[unknown, number]> = [[start, 0]]
  while (queue.length > 0) {
    const [ref, depth] = queue.shift()!
    if (!isLink(ref) || depth > hops || seen.has(ref[0])) continue
    seen.add(ref[0])
    const node = workflow[ref[0]]
    if (!node) continue
    for (const input of ['text', 'prompt']) {
      if (typeof node.inputs[input] === 'string' && /Encode|Prompt|Text/i.test(node.class_type)) return { id: ref[0], input }
    }
    for (const value of Object.values(node.inputs)) queue.push([value, depth + 1])
  }
  return null
}

export function bindWorkflow(workflow: ApiWorkflow, values: BindValues): { workflow: ApiWorkflow; bound: { prompt: boolean; image: boolean; seed: boolean; size: boolean } } {
  const out = structuredClone(workflow)
  const bound = { prompt: false, image: false, seed: false, size: false }
  const samplers = Object.entries(out).filter(([, node]) => SAMPLER.test(node.class_type))
  const positiveStarts: unknown[] = []
  const negativeStarts: unknown[] = []
  for (const [, node] of samplers) {
    if ('positive' in node.inputs) positiveStarts.push(node.inputs.positive)
    if ('negative' in node.inputs) negativeStarts.push(node.inputs.negative)
    if (isLink(node.inputs.guider)) {
      const guider = out[node.inputs.guider[0]]
      if (guider) {
        if ('positive' in guider.inputs) positiveStarts.push(guider.inputs.positive)
        else if ('conditioning' in guider.inputs) positiveStarts.push(guider.inputs.conditioning)
        if ('negative' in guider.inputs) negativeStarts.push(guider.inputs.negative)
      }
    }
  }
  if (values.prompt !== undefined) {
    for (const start of positiveStarts) {
      const target = findTextNode(out, start)
      if (target) {
        out[target.id]!.inputs[target.input] = values.prompt
        bound.prompt = true
        break
      }
    }
  }
  if (values.negative) {
    for (const start of negativeStarts) {
      const target = findTextNode(out, start)
      if (target && !(positiveStarts.length > 0 && findTextNode(out, positiveStarts[0])?.id === target.id)) {
        out[target.id]!.inputs[target.input] = values.negative
        break
      }
    }
  }
  for (const node of Object.values(out)) {
    if (values.seed !== undefined) {
      for (const key of ['seed', 'noise_seed']) {
        if (typeof node.inputs[key] === 'number') {
          node.inputs[key] = values.seed
          bound.seed = true
        }
      }
    }
    if (values.width && values.height && EMPTY_LATENT.test(node.class_type) && typeof node.inputs.width === 'number' && typeof node.inputs.height === 'number') {
      node.inputs.width = values.width
      node.inputs.height = values.height
      bound.size = true
    }
  }
  if (values.image) {
    const load = Object.values(out).find((node) => /^LoadImage$/.test(node.class_type) && typeof node.inputs.image === 'string')
    if (load) {
      load.inputs.image = values.image
      bound.image = true
    }
  }
  if (values.denoise !== undefined && values.image) {
    for (const [, node] of samplers) if (typeof node.inputs.denoise === 'number') node.inputs.denoise = Math.max(0.05, Math.min(1, values.denoise))
  }
  return { workflow: out, bound }
}

/** Ids of the nodes that save pictures, so a run can return the finished picture and not every preview on the way. */
export function saveNodeIds(workflow: ApiWorkflow): string[] {
  const saves = Object.entries(workflow).filter(([, node]) => node.class_type === 'SaveImage' || /^SaveImage/.test(node.class_type))
  // Some graphs also save a comparison or the plain baseline before the real work; those come last.
  const side = (node: { inputs: Record<string, unknown> }): number => (/baseline|compar|before|debug|reference/i.test(typeof node.inputs.filename_prefix === 'string' ? node.inputs.filename_prefix : '') ? 1 : 0)
  return saves.sort((a, b) => side(a[1]) - side(b[1])).map(([id]) => id)
}

/**
 * Many upscaling graphs enlarge with a model (for example 4x) and then scale the result by a fixed factor before the
 * detail pass. This sets that factor so the finished picture lands near the size the user asked for. Everything else in
 * the graph, the tuned settings of a preset included, is left exactly as it is. Returns null when the graph has no such
 * step, and then the result is resampled to the target afterwards.
 */
export function retargetUpscale(workflow: ApiWorkflow, sourceLongEdge: number, targetLongEdge: number): { workflow: ApiWorkflow; scaleBy: number; nodeId: string } | null {
  const out = structuredClone(workflow)
  const modelUse = Object.entries(out).find(([, node]) => node.class_type === 'ImageUpscaleWithModel')
  if (!modelUse || sourceLongEdge <= 0) return null
  const loaderRef = modelUse[1].inputs.upscale_model
  const loader = isLink(loaderRef) ? out[loaderRef[0]] : undefined
  const named = typeof loader?.inputs.model_name === 'string' ? /(\d)x/i.exec(loader.inputs.model_name) : null
  const modelScale = named ? Number(named[1]) : 4
  const scaler = Object.entries(out).find(([, node]) => node.class_type === 'ImageScaleBy' && isLink(node.inputs.image) && node.inputs.image[0] === modelUse[0])
  if (!scaler) return null
  const scaleBy = Math.max(0.05, Math.min(1, Math.round((targetLongEdge / (sourceLongEdge * modelScale)) * 1000) / 1000))
  scaler[1].inputs.scale_by = scaleBy
  return { workflow: out, scaleBy, nodeId: scaler[0] }
}
