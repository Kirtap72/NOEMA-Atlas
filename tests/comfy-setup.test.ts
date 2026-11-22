import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { identifyInstall, suggestInstalls } from '../src/main/studio/comfyInstall'
import { parseExtraPaths, scanModels } from '../src/main/studio/comfyModels'
import { bindWorkflow, convertUiToApi, inspectWorkflow, scanWorkflows, saveNodeIds, type ApiWorkflow, type ObjectInfo, type UiWorkflow } from '../src/main/studio/comfyWorkflows'
import { ComfyLauncher, ComfyStartError, explainStartFailure } from '../src/main/studio/comfyLauncher'
import { ComfyManager } from '../src/main/studio/comfyManager'

let root = ''
beforeEach(async () => {
  root = join(tmpdir(), `noema-comfy-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function touch(path: string, text = ''): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, text)
}

async function portable(name = 'ComfyUI_windows_portable'): Promise<string> {
  const base = join(root, name)
  await touch(join(base, 'python_embeded', 'python.exe'))
  await touch(join(base, 'ComfyUI', 'main.py'))
  await touch(join(base, 'ComfyUI', 'comfyui_version.py'), '__version__ = "0.3.60"\n')
  await touch(join(base, 'run_nvidia_gpu.bat'))
  return base
}

describe('recognising an installation', () => {
  it('knows the portable download and how to start it', async () => {
    const base = await portable()
    const result = identifyInstall(base)
    if (!('install' in result)) throw new Error(result.problem)
    expect(result.install.kind).toBe('portable')
    expect(result.install.version).toBe('0.3.60')
    expect(result.install.launch).toMatchObject({ kind: 'python', usesEmbeddedPython: true })
    expect(result.install.dataFolder).toBe(join(base, 'ComfyUI'))
  })

  it('also accepts the folder just above it, and the ComfyUI folder inside', async () => {
    const base = await portable()
    expect('install' in identifyInstall(root)).toBe(true)
    // The inner folder alone has no python_embeded next to it, so it is a source install without its own Python.
    const inner = identifyInstall(join(base, 'ComfyUI'))
    expect('problem' in inner || inner.install.kind === 'source').toBe(true)
  })

  it('knows a source install with its virtual environment', async () => {
    const base = join(root, 'ComfyUI')
    await touch(join(base, 'main.py'))
    await touch(join(base, 'comfy', '__init__.py'))
    await touch(join(base, '.venv', 'Scripts', 'python.exe'))
    const result = identifyInstall(base)
    if (!('install' in result)) throw new Error(result.problem)
    expect(result.install.kind).toBe('source')
    expect(result.install.launch).toMatchObject({ kind: 'python', usesEmbeddedPython: false })
    expect((result.install.launch as { python: string }).python).toContain('.venv')
  })

  it('knows the Desktop app, with its models beside it or in the base path from its own settings', async () => {
    const own = join(root, 'Desk1')
    await touch(join(own, 'ComfyUI.exe'))
    await touch(join(own, 'resources', 'ComfyUI', 'main.py'))
    await fs.mkdir(join(own, 'models'), { recursive: true })
    const a = identifyInstall(own)
    if (!('install' in a)) throw new Error(a.problem)
    expect(a.install.kind).toBe('desktop')
    expect(a.install.dataFolder).toBe(own)
    expect(a.install.launch).toMatchObject({ kind: 'exe' })

    const programs = join(root, 'Programs', 'ComfyUI')
    await touch(join(programs, 'ComfyUI.exe'))
    await touch(join(programs, 'resources', 'ComfyUI', 'main.py'))
    const dataDir = join(root, 'Documents', 'ComfyUI')
    await fs.mkdir(join(dataDir, 'models'), { recursive: true })
    const appData = join(root, 'AppData')
    await touch(join(appData, 'ComfyUI', 'config.json'), JSON.stringify({ basePath: dataDir }))
    const b = identifyInstall(programs, { appData })
    if (!('install' in b)) throw new Error(b.problem)
    expect(b.install.dataFolder).toBe(dataDir)
  })

  it('explains in plain words when a folder is not ComfyUI, and does not write anything', async () => {
    const nothing = join(root, 'Pictures')
    await fs.mkdir(nothing, { recursive: true })
    expect((identifyInstall(nothing) as { problem: string }).problem).toContain('does not look like a ComfyUI installation')
    const data = join(root, 'data')
    await fs.mkdir(join(data, 'models'), { recursive: true })
    await fs.mkdir(join(data, 'custom_nodes'), { recursive: true })
    expect((identifyInstall(data) as { problem: string }).problem).toContain('data folder')
    expect((identifyInstall(join(root, 'missing')) as { problem: string }).problem).toContain('cannot be opened')
    expect(await fs.readdir(nothing)).toEqual([])
  })

  it('suggests installations found in the usual places', async () => {
    await portable('ComfyUI_windows_portable')
    const found = suggestInstalls({ home: root, extra: [root] })
    expect(found.some((f) => f.kind === 'portable')).toBe(true)
  })
})

describe('finding models', () => {
  it('lists models by kind, including those in extra folders from extra_model_paths.yaml', async () => {
    const base = await portable()
    const data = join(base, 'ComfyUI')
    await touch(join(data, 'models', 'checkpoints', 'sd_xl_base_1.0.safetensors'))
    await touch(join(data, 'models', 'checkpoints', 'old', 'v1-5-pruned.ckpt'))
    await touch(join(data, 'models', 'diffusion_models', 'flux1-dev.safetensors'))
    await touch(join(data, 'models', 'vae', 'ae.safetensors'))
    await touch(join(data, 'models', 'loras', 'style.safetensors'))
    await touch(join(data, 'models', 'upscale_models', '4x-UltraSharp.pth'))
    await touch(join(data, 'models', 'checkpoints', 'notes.txt'))
    const shared = join(root, 'shared-models')
    await touch(join(shared, 'checkpoints', 'dreamshaper_8.safetensors'))
    await touch(join(data, 'extra_model_paths.yaml'), `other:\n  base_path: ${shared.replace(/\\/g, '/')}\n  checkpoints: checkpoints/\n`)
    const inventory = scanModels({ dataFolder: data, extraConfigs: [join(data, 'extra_model_paths.yaml')] })
    expect(inventory.byCategory.checkpoints).toEqual(['dreamshaper_8.safetensors', 'old/v1-5-pruned.ckpt', 'sd_xl_base_1.0.safetensors'])
    expect(inventory.byCategory.diffusion).toEqual(['flux1-dev.safetensors'])
    expect(inventory.byCategory.upscale).toEqual(['4x-UltraSharp.pth'])
    expect(inventory.total).toBe(7)
    expect(inventory.families).toEqual(expect.arrayContaining(['SDXL', 'Flux', 'Stable Diffusion 1.5']))
  })

  it('reads the extra paths file, including Windows paths in a block', () => {
    const text = 'comfyui_desktop:\n  is_default: "true"\n  base_path: C:\\Users\\me\\ComfyUI\n  checkpoints: |\n    C:\\models\\a\n    D:\\models\\b\n  loras: models/loras/\n'
    const [section] = parseExtraPaths(text, 'C:\\cfg')
    expect(section!.base).toBe('C:\\Users\\me\\ComfyUI')
    expect(section!.paths.checkpoints).toEqual(['C:\\models\\a', 'D:\\models\\b'])
    expect(section!.paths.loras![0]).toContain('loras')
  })
})

const SD_INFO: ObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors']] } }, output_node: false },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
  EmptyLatentImage: { input: { required: { width: ['INT', {}], height: ['INT', {}], batch_size: ['INT', {}] } } },
  KSampler: {
    input: {
      required: {
        model: ['MODEL'],
        seed: ['INT', { control_after_generate: true }],
        steps: ['INT', {}],
        cfg: ['FLOAT', {}],
        sampler_name: [['euler', 'dpmpp_2m']],
        scheduler: [['normal', 'karras']],
        positive: ['CONDITIONING'],
        negative: ['CONDITIONING'],
        latent_image: ['LATENT'],
        denoise: ['FLOAT', {}]
      }
    }
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', {}] } }, output_node: true },
  LoadImage: { input: { required: { image: [['a.png']] } } },
  Reroute: {}
}

/** The editor's saved format for a plain text-to-picture graph, with a reroute and a control_after_generate value. */
function uiGraph(): UiWorkflow {
  return {
    nodes: [
      { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['a.safetensors'], inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: [9] }, { name: 'VAE', type: 'VAE', links: [8] }], properties: { models: [{ name: 'a.safetensors', url: 'https://example.org/a.safetensors', directory: 'checkpoints' }] } },
      { id: 20, type: 'Reroute', inputs: [{ name: '', type: 'CLIP', link: 9 }], outputs: [{ name: '', type: 'CLIP', links: [2, 3] }] },
      { id: 2, type: 'CLIPTextEncode', widgets_values: ['a quiet harbour at dawn'], inputs: [{ name: 'clip', type: 'CLIP', link: 2 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }] },
      { id: 3, type: 'CLIPTextEncode', widgets_values: ['blurry, low quality'], inputs: [{ name: 'clip', type: 'CLIP', link: 3 }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }] },
      { id: 4, type: 'EmptyLatentImage', widgets_values: [512, 512, 1], inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT', links: [6] }] },
      { id: 5, type: 'KSampler', widgets_values: [123, 'randomize', 20, 7, 'euler', 'normal', 1], inputs: [{ name: 'model', type: 'MODEL', link: 1 }, { name: 'positive', type: 'CONDITIONING', link: 4 }, { name: 'negative', type: 'CONDITIONING', link: 5 }, { name: 'latent_image', type: 'LATENT', link: 6 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [7] }] },
      { id: 6, type: 'VAEDecode', inputs: [{ name: 'samples', type: 'LATENT', link: 7 }, { name: 'vae', type: 'VAE', link: 8 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [10] }] },
      { id: 7, type: 'SaveImage', widgets_values: ['atlas'], inputs: [{ name: 'images', type: 'IMAGE', link: 10 }], outputs: [] },
      { id: 8, type: 'Note', widgets_values: ['remember to love this'] }
    ],
    links: [
      [1, 1, 0, 5, 0, 'MODEL'],
      [2, 20, 0, 2, 0, 'CLIP'],
      [3, 20, 0, 3, 0, 'CLIP'],
      [4, 2, 0, 5, 1, 'CONDITIONING'],
      [5, 3, 0, 5, 2, 'CONDITIONING'],
      [6, 4, 0, 5, 3, 'LATENT'],
      [7, 5, 0, 6, 0, 'LATENT'],
      [8, 1, 2, 6, 1, 'VAE'],
      [9, 1, 1, 20, 0, 'CLIP'],
      [10, 6, 0, 7, 0, 'IMAGE']
    ]
  }
}

describe('workflows', () => {
  it('tells apart what a workflow makes, and what it needs, without changing the file', async () => {
    const folder = join(root, 'workflows')
    const text = JSON.stringify(uiGraph())
    await touch(join(folder, 'sd_simple.json'), text)
    await touch(join(folder, 'api_graph.json'), JSON.stringify({ '1': { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x.pth' } }, '2': { class_type: 'LoadImage', inputs: { image: 'x.png' } }, '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['1', 0], image: ['2', 0] } }, '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } } }))
    await touch(join(folder, 'video.json'), JSON.stringify({ nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'SaveVideo' }], links: [] }))
    await touch(join(folder, 'subgraph.json'), JSON.stringify({ nodes: [{ id: 1, type: '1b6a5d2c-0000-4000-8000-000000000001' }], links: [], definitions: { subgraphs: [{ nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'EmptyLatentImage' }] }] } }))
    await touch(join(folder, 'notes.json'), '{"hello": 1}')
    await touch(join(folder, 'broken.json'), 'not json')
    const base = await portable()
    await touch(join(base, 'ComfyUI', 'models', 'upscale_models', '4x.pth'))
    const inventory = scanModels({ dataFolder: join(base, 'ComfyUI') })
    const list = scanWorkflows([folder], inventory)
    const by = (name: string) => list.find((w) => w.name === name)!
    expect(by('sd simple')).toMatchObject({ format: 'ui', kind: 'generate', runnable: false })
    expect(by('sd simple').missing[0]).toMatchObject({ name: 'a.safetensors', folder: 'checkpoints', url: 'https://example.org/a.safetensors' })
    expect(by('sd simple').why).toContain('Needs “a.safetensors” in ComfyUI’s checkpoints folder')
    expect(by('api graph')).toMatchObject({ format: 'api', kind: 'upscale', runnable: true })
    expect(by('video').runnable).toBe(false)
    expect(by('video').why).toContain('video')
    expect(by('subgraph').why).toContain('Export (API)')
    expect(by('notes').runnable).toBe(false)
    expect(list.some((w) => w.name === 'broken')).toBe(false)
    expect(await fs.readFile(join(folder, 'sd_simple.json'), 'utf8')).toBe(text)
    // Once the model is installed, the workflow can run.
    await touch(join(base, 'ComfyUI', 'models', 'checkpoints', 'a.safetensors'))
    const again = scanWorkflows([folder], scanModels({ dataFolder: join(base, 'ComfyUI') }))
    expect(again.find((w) => w.name === 'sd simple')).toMatchObject({ runnable: true, missing: [] })
  })

  it('turns the editor format into a runnable graph: links, reroutes, seed control values and notes', () => {
    const result = convertUiToApi(uiGraph(), SD_INFO)
    if ('problem' in result) throw new Error(result.problem)
    const api = result.prompt
    expect(Object.keys(api).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
    expect(api['5']!.inputs).toMatchObject({ seed: 123, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 })
    expect(api['5']!.inputs.model).toEqual(['1', 0])
    expect(api['5']!.inputs.positive).toEqual(['2', 0])
    expect(api['5']!.inputs.latent_image).toEqual(['4', 0])
    // The reroute is followed back to the checkpoint's CLIP output.
    expect(api['2']!.inputs.clip).toEqual(['1', 1])
    expect(api['6']!.inputs.vae).toEqual(['1', 2])
    expect(api['2']!.inputs.text).toBe('a quiet harbour at dawn')
    expect(api['4']!.inputs).toMatchObject({ width: 512, height: 512, batch_size: 1 })
    expect(saveNodeIds(api)).toEqual(['7'])
  })

  it('says what is missing when a node is not installed, or nothing would be saved', () => {
    const missing = convertUiToApi({ nodes: [{ id: 1, type: 'FancyNode', widgets_values: [] }], links: [] }, SD_INFO)
    expect((missing as { problem: string }).problem).toContain('“FancyNode”')
    const noOutput = convertUiToApi({ nodes: [{ id: 1, type: 'EmptyLatentImage', widgets_values: [64, 64, 1] }], links: [] }, SD_INFO)
    expect((noOutput as { problem: string }).problem).toContain('saves or shows a picture')
  })

  it('fills in the description, seed, size and picture where they belong', () => {
    const api = (convertUiToApi(uiGraph(), SD_INFO) as { prompt: ApiWorkflow }).prompt
    const { workflow, bound } = bindWorkflow(api, { prompt: 'misty harbour, oil painting', negative: 'text, watermark', seed: 42, width: 1024, height: 768 })
    expect(bound).toMatchObject({ prompt: true, seed: true, size: true })
    expect(workflow['2']!.inputs.text).toBe('misty harbour, oil painting')
    expect(workflow['3']!.inputs.text).toBe('text, watermark')
    expect(workflow['5']!.inputs.seed).toBe(42)
    expect(workflow['4']!.inputs).toMatchObject({ width: 1024, height: 768 })
    // The user's graph on disk (here: the converted copy) is not changed by binding.
    expect(api['2']!.inputs.text).toBe('a quiet harbour at dawn')
  })

  it('finds the prompt behind a guider and gives a start picture and denoise to an edit graph', () => {
    const graph: ApiWorkflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'old', clip: ['9', 0] } },
      '3': { class_type: 'FluxGuidance', inputs: { conditioning: ['2', 0], guidance: 3.5 } },
      '4': { class_type: 'BasicGuider', inputs: { model: ['9', 0], conditioning: ['3', 0] } },
      '5': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['4', 0], latent_image: ['1', 0], denoise: 1 } },
      '6': { class_type: 'RandomNoise', inputs: { noise_seed: 5 } },
      '7': { class_type: 'SaveImage', inputs: { images: ['5', 0] } }
    }
    const { workflow, bound } = bindWorkflow(graph, { prompt: 'a calmer sea', image: 'atlas-up.png', denoise: 0.4, seed: 9 })
    expect(bound).toMatchObject({ prompt: true, image: true, seed: true })
    expect(workflow['2']!.inputs.text).toBe('a calmer sea')
    expect(workflow['1']!.inputs.image).toBe('atlas-up.png')
    expect(workflow['5']!.inputs.denoise).toBe(0.4)
    expect(workflow['6']!.inputs.noise_seed).toBe(9)
  })

  it('classifies an upscaling workflow by its nodes', () => {
    const info = inspectWorkflow('G:\\x\\upscale_4x.json', { nodes: [{ id: 1, type: 'UpscaleModelLoader', widgets_values: ['4x.pth'] }, { id: 2, type: 'ImageUpscaleWithModel' }, { id: 3, type: 'LoadImage' }, { id: 4, type: 'SaveImage' }], links: [] }, null)
    expect(info.kind).toBe('upscale')
    expect(info.needs[0]).toMatchObject({ name: '4x.pth', folder: 'upscale_models' })
  })
})

// ---- starting and connecting ----------------------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  killed = false
  pid = 4242
  kill(): boolean {
    this.killed = true
    this.exitCode = 1
    return true
  }
}

function system(): Response {
  return { ok: true, json: async () => ({ system: { os: 'nt' }, devices: [] }) } as unknown as Response
}

describe('starting and connecting', () => {
  const install = (): ReturnType<typeof identifyInstall> => identifyInstall(root)

  async function setup(): Promise<{ install: import('../src/main/studio/comfyInstall').ComfyInstall }> {
    await portable()
    const result = install()
    if (!('install' in result)) throw new Error(result.problem)
    return { install: result.install }
  }

  it('connects to a ComfyUI that is already running and never starts a second one', async () => {
    const { install: inst } = await setup()
    let spawned = 0
    const launcher = new ComfyLauncher({
      fetchImpl: async (url) => {
        if (url.startsWith('http://127.0.0.1:8188')) return system()
        throw new Error('refused')
      },
      spawn: () => {
        spawned += 1
        return new FakeChild() as unknown as ChildProcess
      }
    })
    const connection = await launcher.ensureRunning(inst)
    expect(connection).toEqual({ url: 'http://127.0.0.1:8188', managed: false })
    expect(spawned).toBe(0)
    // And it is never stopped by Atlas.
    expect(launcher.stop()).toBe(false)
  })

  it('does not mistake another program on the port for ComfyUI', async () => {
    const { install: inst } = await setup()
    const launcher = new ComfyLauncher({
      fetchImpl: async () => ({ ok: true, json: async () => ({ hello: 'a web server' }) }) as unknown as Response,
      spawn: () => {
        const child = new FakeChild()
        setTimeout(() => child.emit('exit', 1), 5)
        return child as unknown as ChildProcess
      },
      isPortFree: async () => true,
      sleep: () => new Promise((r) => setTimeout(r, 1))
    })
    await expect(launcher.ensureRunning(inst)).rejects.toBeInstanceOf(ComfyStartError)
  })

  it('starts it from the installation when nothing is running, waits until it answers, and can stop only its own', async () => {
    const { install: inst } = await setup()
    let ready = false
    const calls: Array<{ command: string; args: string[]; cwd?: unknown }> = []
    const child = new FakeChild()
    const messages: string[] = []
    let polls = 0
    const launcher = new ComfyLauncher({
      fetchImpl: async (url) => {
        if (ready && url.startsWith('http://127.0.0.1:8188')) return system()
        throw new Error('refused')
      },
      spawn: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd })
        setTimeout(() => child.stdout.emit('data', Buffer.from('Import times for custom nodes\n')), 1)
        return child as unknown as ChildProcess
      },
      isPortFree: async () => true,
      sleep: async () => {
        polls += 1
        if (polls > 3) ready = true
        await new Promise((r) => setTimeout(r, 1))
      },
      kill: (c) => (c as unknown as FakeChild).kill()
    })
    const connection = await launcher.ensureRunning(inst, { onProgress: (m) => messages.push(m) })
    expect(connection).toEqual({ url: 'http://127.0.0.1:8188', managed: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.command).toContain('python_embeded')
    expect(calls[0]!.args).toEqual(expect.arrayContaining(['-s', '--listen', '127.0.0.1', '--port', '8188', '--disable-auto-launch', '--windows-standalone-build']))
    expect(messages[0]).toContain('Starting ComfyUI')
    // Asking again while it runs reuses it.
    expect(await launcher.ensureRunning(inst)).toEqual({ url: 'http://127.0.0.1:8188', managed: true })
    expect(calls).toHaveLength(1)
    expect(launcher.stop()).toBe(true)
    expect(child.killed).toBe(true)
  })

  it('picks the next free port when the usual one is taken by something else', async () => {
    const { install: inst } = await setup()
    const calls: string[][] = []
    let ready = false
    const launcher = new ComfyLauncher({
      fetchImpl: async (url) => {
        if (ready && url.startsWith('http://127.0.0.1:8189')) return system()
        throw new Error('refused')
      },
      spawn: (_c, args) => {
        calls.push(args)
        return new FakeChild() as unknown as ChildProcess
      },
      isPortFree: async (port) => port !== 8188,
      sleep: async () => {
        ready = true
        await new Promise((r) => setTimeout(r, 1))
      }
    })
    const connection = await launcher.ensureRunning(inst)
    expect(connection.url).toBe('http://127.0.0.1:8189')
    expect(calls[0]).toEqual(expect.arrayContaining(['--port', '8189']))
  })

  it('explains startup failures in simple language', async () => {
    const { install: inst } = await setup()
    const failing = (lines: string[], code: number): ComfyLauncher =>
      new ComfyLauncher({
        fetchImpl: async () => {
          throw new Error('refused')
        },
        spawn: () => {
          const child = new FakeChild()
          setTimeout(() => {
            for (const line of lines) child.stderr.emit('data', Buffer.from(`${line}\n`))
            child.emit('exit', code)
          }, 1)
          return child as unknown as ChildProcess
        },
        isPortFree: async () => true,
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
      })
    await expect(failing(['OSError: [WinError 10048] Only one usage of each socket address'], 1).ensureRunning(inst)).rejects.toThrow(/Another program is already using the address/)
    await expect(failing(['AssertionError: Torch not compiled with CUDA enabled'], 1).ensureRunning(inst)).rejects.toThrow(/could not use the graphics card/)
    await expect(failing(["ModuleNotFoundError: No module named 'torchsde'"], 1).ensureRunning(inst)).rejects.toThrow(/missing a package \(torchsde\)/)
    expect(explainStartFailure(['boom'], 3, 8188)).toContain('stopped while starting (code 3)')
  })

  it('says so when the program cannot be started at all, and when it takes too long', async () => {
    const { install: inst } = await setup()
    const missing = new ComfyLauncher({
      fetchImpl: async () => {
        throw new Error('refused')
      },
      spawn: () => {
        const child = new FakeChild()
        setTimeout(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), 1)
        return child as unknown as ChildProcess
      },
      isPortFree: async () => true,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
    })
    await expect(missing.ensureRunning(inst)).rejects.toThrow(/could not start .*moved or removed/)
    const slow = new ComfyLauncher({
      fetchImpl: async () => {
        throw new Error('refused')
      },
      spawn: () => new FakeChild() as unknown as ChildProcess,
      isPortFree: async () => true,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      startTimeoutMs: 40
    })
    await expect(slow.ensureRunning(inst)).rejects.toThrow(/did not answer within/)
  })
})

describe('what the window tells the user', () => {
  it('says plainly what is missing, and when ComfyUI is already running', async () => {
    const base = await portable()
    const folder = join(base, 'ComfyUI', 'user', 'default', 'workflows')
    await touch(join(folder, 'flux2.json'), JSON.stringify({ nodes: [{ id: 1, type: 'UNETLoader', widgets_values: ['flux2-dev.safetensors'], properties: { models: [{ name: 'flux2-dev.safetensors', url: 'https://example.org/f', directory: 'diffusion_models' }] } }, { id: 2, type: 'KSampler' }, { id: 3, type: 'EmptyLatentImage' }], links: [] }))
    const manager = new ComfyManager({
      fetchImpl: async (url) => {
        if (url.startsWith('http://127.0.0.1:8188')) return system()
        throw new Error('refused')
      }
    })
    const settings = { folder: base, url: null, autoStart: true }
    const idle = new ComfyManager({
      fetchImpl: async () => {
        throw new Error('refused')
      }
    })
    const before = await idle.status({ folder: null, url: null, autoStart: true }, null)
    expect(before.state).toBe('not-set-up')
    expect(before.needs[0]).toContain('Choose your ComfyUI folder once')
    manager.load(base)
    const status = await manager.status(settings, null)
    expect(status.state).toBe('running')
    expect(status.headline).toContain('already running')
    expect(status.startedByAtlas).toBe(false)
    expect(status.canMakePictures).toBe(false)
    expect(status.needs.join(' ')).toContain('checkpoints folder')
    expect(status.needs.join(' ')).toContain('“flux2-dev.safetensors”')
    expect(status.workflows[0]).toMatchObject({ kind: 'generate', runnable: false })
    // Adding a checkpoint is enough.
    await touch(join(base, 'ComfyUI', 'models', 'checkpoints', 'dreamshaper.safetensors'))
    manager.rescan()
    const ready = await manager.status(settings, null)
    expect(ready.canMakePictures).toBe(true)
    expect(ready.needs).toEqual([])
    expect(ready.models!.summary).toContain('1 checkpoint')
  })

  it('refuses a folder that is not ComfyUI without losing the one that was chosen', async () => {
    const base = await portable()
    const manager = new ComfyManager({
      fetchImpl: async () => {
        throw new Error('refused')
      }
    })
    manager.load(base)
    expect(manager.current).not.toBeNull()
    const other = join(root, 'Pictures')
    await fs.mkdir(other, { recursive: true })
    manager.load(other)
    expect(manager.current).toBeNull()
    expect(manager.problemNow).toContain('does not look like a ComfyUI installation')
    const status = await manager.status({ folder: other, url: null, autoStart: true }, null)
    expect(status.state).toBe('problem')
  })
})
