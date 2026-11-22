import { describe, expect, it } from 'vitest'
import { ModelLibrary } from '../src/main/modelLibrary/library'
import { OllamaClient } from '../src/main/modelLibrary/ollama'
import { setLibraryOpener, setModelLibrary } from '../src/main/modelLibrary/access'
import { modelTools } from '../src/main/assistant/modelTools'
import { AiPackages } from '../src/main/studio/aiPackages'
import type { Tool, ToolSession } from '../src/main/assistant/tools'

const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '')
const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required })
const tools = modelTools({ text, obj, idsFromRefs: () => ({ ids: [], unknown: [] }), resolveBoard: () => ({ error: 'none' }) })
const tool = (name: string): Tool => tools.find((t) => t.spec.name === name)!
const run = async (name: string, args: Record<string, unknown>): Promise<{ model: Record<string, any>; blocks: any[] }> => (await tool(name).run(args, {} as ToolSession)) as never

function library(simulateNothing = true): ModelLibrary {
  void simulateNothing
  const ai = new AiPackages({ dataDir: 'G:/nonexistent-noema-test', useRuntime: () => undefined, verifyRuntime: async () => null })
  return new ModelLibrary({ ai, userCatalogDir: 'G:/nonexistent-noema-test/model-library', comfy: () => ({ inventory: null, kind: 'none', folder: null, dataFolder: null, version: null, note: null }), ollama: new OllamaClient(async () => { throw new Error('offline') }) })
}

describe('the companion’s model tools', () => {
  it('say so when the library is not ready', async () => {
    setModelLibrary(null)
    expect((await run('models_overview', {})).model.error).toMatch(/not ready/)
  })

  it('describe this computer and every model with an honest verification status', async () => {
    setModelLibrary(library())
    const o = await run('models_overview', {})
    expect(o.model.models.length).toBeGreaterThanOrEqual(11)
    const flux = o.model.models.find((m: any) => m.id === 'flux2-klein-4b')
    expect(flux.verification).toBe('tested and verified by Atlas')
    const real = o.model.models.find((m: any) => m.id === 'realvisxl-v4')
    expect(real.verification).toBe('documented, not tested by Atlas')
    expect(o.model.note).toMatch(/Nothing is downloaded/)
  })

  it('recommend by task, respect licences and never recommend what cannot run', async () => {
    setModelLibrary(library())
    const r = await run('recommend_models', { task: 'surreal paintings from my moodboard references', commercial: true })
    const ids: string[] = r.model.recommendations.map((x: any) => x.id)
    expect(ids).not.toContain('flux2-klein-9b')
    for (const rec of r.model.recommendations) expect(rec.licence).not.toMatch(/not for commercial use/)
    const none = await run('recommend_models', { task: 'make a new picture', max_download_gb: 0.0001 })
    expect(none.model.none ?? none.model.recommendations.length).toBeTruthy()
  })

  it('open the library on a model without installing anything', async () => {
    setModelLibrary(library())
    const p = await run('propose_model_install', { id: 'flux2-klein-4b', reason: 'It can use your reference pictures.' })
    expect(p.blocks[0].proposal).toMatchObject({ kind: 'open-models', entryId: 'flux2-klein-4b', imageIds: [] })
    expect(p.blocks[0].status).toBe('pending')
    expect((await run('propose_model_install', { id: 'nope', reason: 'x' })).model.error).toMatch(/not in the library/)
    const d = await run('model_details', { id: 'flux2-klein-4b' })
    expect(d.model.tests.length).toBeGreaterThan(0)
    expect(d.model.licence.name).toMatch(/Apache/)
  })

  it('open the real library window instead of listing models, and say so honestly when it cannot', async () => {
    setModelLibrary(library())
    const asked: unknown[] = []
    setLibraryOpener((request) => asked.push(request))
    const opened = await run('open_model_library', { category: 'upscaling', search: 'esrgan', id: 'realesrgan-x4plus' })
    expect(asked).toEqual([{ entry: 'realesrgan-x4plus', search: 'esrgan', category: 'upscaling' }])
    expect(opened.model.status).toMatch(/open in the window/)
    expect(opened.blocks).toEqual([])
    await run('open_model_library', { id: 'no-such-model', category: 'nonsense' })
    expect(asked[1]).toEqual({ entry: undefined, search: undefined, category: undefined })
    setLibraryOpener(null)
    expect((await run('open_model_library', {})).model.error).toMatch(/AI Models/)
  })
})
