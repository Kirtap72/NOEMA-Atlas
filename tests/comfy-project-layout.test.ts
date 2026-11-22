import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { identifyInstall, parseStartScript } from '../src/main/studio/comfyInstall'
import { ComfyLauncher, ComfyStartError, projectEnvironment } from '../src/main/studio/comfyLauncher'
import { ComfyManager } from '../src/main/studio/comfyManager'
import { saveNodeIds, scanWorkflows, workflowTitle } from '../src/main/studio/comfyWorkflows'
import { checkLaunchArgs } from '../src/main/studio/studio'

// The layout of a real project: ComfyUI and a virtual environment side by side under runtime\, a start script at the
// project root that uses port 8189, and workflow presets in a folder that is not part of ComfyUI.
const START_SCRIPT = `$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$pythonPath = Join-Path $projectRoot 'runtime/venv/Scripts/python.exe'
$comfyPath = Join-Path $projectRoot 'runtime/ComfyUI'
$process = Start-Process -FilePath $pythonPath -ArgumentList 'main.py','--listen','127.0.0.1','--port','8189','--fp16-unet','--fp32-vae','--use-pytorch-cross-attention','--reserve-vram','1','--disable-auto-launch' -WorkingDirectory $comfyPath -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden -PassThru
`

let root = ''
beforeEach(async () => {
  root = join(tmpdir(), `noema-project-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(root, { recursive: true })
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function touch(path: string, text = ''): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, text)
}

const apiGraph = (prefix: string): string =>
  JSON.stringify({
    '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
    '2': { class_type: 'KSampler', inputs: { seed: 5, denoise: 0.2, positive: ['3', 0], negative: ['3', 0], model: ['4', 0], latent_image: ['1', 0] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: 'a' } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'm.safetensors' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['2', 0] } }
  })

async function project(): Promise<string> {
  await touch(join(root, 'runtime', 'ComfyUI', 'main.py'))
  await touch(join(root, 'runtime', 'ComfyUI', 'comfyui_version.py'), '__version__ = "0.45.0"\n')
  await fs.mkdir(join(root, 'runtime', 'ComfyUI', 'comfy'), { recursive: true })
  await fs.mkdir(join(root, 'runtime', 'ComfyUI', 'models', 'checkpoints'), { recursive: true })
  await touch(join(root, 'runtime', 'venv', 'Scripts', 'python.exe'))
  await touch(join(root, 'start_comfy.ps1'), START_SCRIPT)
  await touch(join(root, 'start_comfy_other.ps1'), START_SCRIPT.replace("'--fp16-unet'", "'--fast-disk'"))
  await touch(join(root, 'presets', 'clarity', 'cabin_realistic', 'workflow_api.json'), apiGraph('final'))
  await touch(join(root, 'presets', 'clarity', 'cabin_realistic', 'workflow_ui.json'), JSON.stringify({ nodes: [{ id: 1, type: 'KSampler', inputs: [], widgets_values: [] }], links: [] }))
  await touch(join(root, 'presets', 'clarity', 'cabin_realistic', 'manifest.json'), '{"files":{}}')
  await touch(join(root, 'presets', 'clarity', 'fairy', 'workflow_api.json'), apiGraph('final'))
  return join(root, 'runtime', 'ComfyUI')
}

describe('a project that keeps ComfyUI and its Python side by side', () => {
  it('finds the virtual environment outside the ComfyUI folder, the start script and the workflow folder', async () => {
    const folder = await project()
    const result = identifyInstall(folder)
    if (!('install' in result)) throw new Error(result.problem)
    const install = result.install
    expect(install.kind).toBe('source')
    expect(install.version).toBe('0.45.0')
    expect(install.launch).toMatchObject({ kind: 'python', python: join(root, 'runtime', 'venv', 'Scripts', 'python.exe') })
    // The plainest start script comes first, with its port and options but not the address Atlas sets itself.
    expect(install.profiles[0]).toMatchObject({ port: 8189, args: ['--fp16-unet', '--fp32-vae', '--use-pytorch-cross-attention', '--reserve-vram', '1'] })
    expect(install.profiles.map((p) => p.name)).toContain('start comfy other')
    expect(install.workflowFolderSuggestions).toEqual([join(root, 'presets', 'clarity')])
  })

  it('uses a Python the user chose, and reads without writing anything', async () => {
    const folder = await project()
    const custom = join(root, 'elsewhere', 'python.exe')
    await touch(custom)
    const before = await listing(root)
    const result = identifyInstall(folder, { python: custom })
    if (!('install' in result)) throw new Error(result.problem)
    expect(result.install.launch).toMatchObject({ kind: 'python', python: custom })
    expect(await listing(root)).toEqual(before)
  })

  it('names a preset by its folder and lists the runnable file once', async () => {
    await project()
    const folder = join(root, 'presets', 'clarity')
    expect(workflowTitle(folder, join(folder, 'cabin_realistic', 'workflow_api.json'))).toBe('cabin realistic')
    expect(workflowTitle(folder, join(folder, 'loose', 'My Graph.json'))).toBe('loose My Graph')
    const found = scanWorkflows([folder], null, { hideNonWorkflows: true })
    expect(found.map((w) => w.name).sort()).toEqual(['cabin realistic', 'fairy'])
    expect(found.every((w) => w.format === 'api')).toBe(true)
  })

  it('puts the real result before a baseline or comparison picture', () => {
    const graph = JSON.parse(apiGraph('x_learned_baseline')) as Record<string, { class_type: string; inputs: Record<string, unknown> }>
    graph['10'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'x_clarity', images: ['2', 0] } }
    expect(saveNodeIds(graph)).toEqual(['10', '9'])
  })

  it('reads workflows from folders outside the installation, and keeps the user’s Python', async () => {
    const folder = await project()
    const manager = new ComfyManager({ fetchImpl: async () => { throw new Error('offline') } })
    manager.load(folder, { workflowFolders: [join(root, 'presets', 'clarity')] })
    expect(manager.current?.kind).toBe('source')
    expect(manager.allWorkflows().map((w) => w.name).sort()).toEqual(['cabin realistic', 'fairy'])
    const status = await manager.status({ folder, url: null, autoStart: true, port: 8189, args: ['--fp16-unet'], workflowFolders: [join(root, 'presets', 'clarity')] }, null)
    expect(status.launch).toMatchObject({ kind: 'python', port: 8189, effectivePort: 8189, args: ['--fp16-unet'], pythonChosen: false })
    expect(status.launch?.profiles[0]?.port).toBe(8189)
    expect(status.workflowFolders).toEqual([join(root, 'presets', 'clarity')])
    expect(status.suggestedWorkflowFolders).toEqual([])
  })
})

async function listing(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(`${p}:${(await fs.stat(p)).size}`)
    }
  }
  await walk(dir)
  return out.sort()
}

describe('reading a start script', () => {
  it('takes the port and options from PowerShell and batch scripts without running them', () => {
    expect(parseStartScript(START_SCRIPT, 'C:\\p\\start_comfy.ps1')).toMatchObject({ name: 'start comfy', port: 8189, args: ['--fp16-unet', '--fp32-vae', '--use-pytorch-cross-attention', '--reserve-vram', '1'] })
    expect(parseStartScript('@echo off\r\n.\\venv\\Scripts\\python.exe main.py --listen 0.0.0.0 --port 8000 --lowvram\r\n', 'C:\\p\\run.bat')).toMatchObject({ port: 8000, args: ['--lowvram'] })
    expect(parseStartScript('echo hello', 'C:\\p\\run.bat')).toBeNull()
  })
})

describe('start options', () => {
  it('keeps Atlas in charge of the address and refuses anything shell-like', () => {
    expect(checkLaunchArgs(['--fp16-unet', '--reserve-vram', '1'])).toEqual(['--fp16-unet', '--reserve-vram', '1'])
    expect(() => checkLaunchArgs(['--listen', '0.0.0.0'])).toThrow(/sets “--listen” itself/)
    expect(() => checkLaunchArgs(['--port=9999'])).toThrow(/sets “--port”/)
    expect(() => checkLaunchArgs(['--x&calc'])).toThrow(/characters Atlas does not allow/)
  })

  it('sets the environment a project Python is started in, only for folders that exist', async () => {
    await project()
    await fs.mkdir(join(root, 'runtime', 'cache'), { recursive: true })
    const env = projectEnvironment(join(root, 'runtime', 'venv', 'Scripts', 'python.exe'))
    expect(env).toMatchObject({ PYTHONNOUSERSITE: '1', HF_HOME: join(root, 'runtime', 'cache', 'huggingface') })
    expect(projectEnvironment('C:\\Python\\python.exe')).toEqual({})
  })
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  exitCode: number | null = null
  pid = 4242
  kill(): boolean {
    this.killed = true
    this.exitCode = 1
    return true
  }
}
const system = (): Response => ({ ok: true, json: async () => ({ system: { os: 'nt' }, devices: [] }) }) as unknown as Response

describe('starting on a fixed port', () => {
  async function install(): Promise<import('../src/main/studio/comfyInstall').ComfyInstall> {
    const result = identifyInstall(await project())
    if (!('install' in result)) throw new Error(result.problem)
    return result.install
  }

  it('connects to what answers on that port and ignores a different ComfyUI on the usual one', async () => {
    const inst = await install()
    let spawned = 0
    const launcher = new ComfyLauncher({
      fetchImpl: async (url) => {
        if (url.startsWith('http://127.0.0.1:8188')) return system() // someone else’s ComfyUI
        throw new Error('refused')
      },
      spawn: () => {
        spawned += 1
        const child = new FakeChild()
        setTimeout(() => child.emit('exit', 1), 3)
        return child as unknown as ChildProcess
      },
      isPortFree: async () => true,
      sleep: () => new Promise((r) => setTimeout(r, 1))
    })
    // Port 8189 is chosen: the ComfyUI on 8188 is not this one, so Atlas tries to start its own and does not borrow it.
    await expect(launcher.ensureRunning(inst, { launch: { port: 8189 } })).rejects.toBeInstanceOf(ComfyStartError)
    expect(spawned).toBe(1)
    const hit = new ComfyLauncher({ fetchImpl: async (url) => (url.startsWith('http://127.0.0.1:8189') ? system() : Promise.reject(new Error('refused'))) })
    expect(await hit.ensureRunning(inst, { launch: { port: 8189 } })).toEqual({ url: 'http://127.0.0.1:8189', managed: false })
  })

  it('starts with the chosen Python, port and options, in the project’s environment', async () => {
    const inst = await install()
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined; cwd: unknown }> = []
    let ready = false
    const launcher = new ComfyLauncher({
      fetchImpl: async (url) => (ready && url.startsWith('http://127.0.0.1:8189') ? system() : Promise.reject(new Error('refused'))),
      spawn: (command, args, options) => {
        calls.push({ command, args, env: options.env, cwd: options.cwd })
        return new FakeChild() as unknown as ChildProcess
      },
      isPortFree: async () => true,
      sleep: async () => {
        ready = true
        await new Promise((r) => setTimeout(r, 1))
      },
      kill: (c) => (c as unknown as FakeChild).kill()
    })
    const connection = await launcher.ensureRunning(inst, { launch: { port: 8189, args: ['--fp16-unet', '--reserve-vram', '1'], extraArgs: ['--output-directory', 'D:\\scratch'] } })
    expect(connection).toEqual({ url: 'http://127.0.0.1:8189', managed: true })
    expect(calls[0]!.command).toBe(join(root, 'runtime', 'venv', 'Scripts', 'python.exe'))
    expect(calls[0]!.cwd).toBe(join(root, 'runtime', 'ComfyUI'))
    expect(calls[0]!.args).toEqual([join(root, 'runtime', 'ComfyUI', 'main.py'), '--listen', '127.0.0.1', '--port', '8189', '--disable-auto-launch', '--fp16-unet', '--reserve-vram', '1', '--output-directory', 'D:\\scratch'])
    expect(calls[0]!.env?.PYTHONNOUSERSITE).toBe('1')
    expect(launcher.stop()).toBe(true)
  })

  it('does not start on a fixed port that another program is using, and says so', async () => {
    const inst = await install()
    let spawned = 0
    const launcher = new ComfyLauncher({
      fetchImpl: async () => Promise.reject(new Error('refused')),
      spawn: () => {
        spawned += 1
        return new FakeChild() as unknown as ChildProcess
      },
      isPortFree: async () => false
    })
    await expect(launcher.ensureRunning(inst, { launch: { port: 8189 } })).rejects.toThrow(/Port 8189 is used by another program that is not ComfyUI/)
    expect(spawned).toBe(0)
  })
})
