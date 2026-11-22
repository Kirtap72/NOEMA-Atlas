// Runs against the REAL computer, the real network and the user's real ComfyUI (read-only). Skipped unless NOEMA_REAL_HW=1.
//   $env:NOEMA_REAL_HW=1; npx vitest run tests/modelLibraryReal.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { AiPackages } from '../src/main/studio/aiPackages'
import { ModelLibrary } from '../src/main/modelLibrary/library'
import { OllamaClient } from '../src/main/modelLibrary/ollama'
import { scanModels } from '../src/main/studio/comfyModels'
import { detectProfile } from '../src/main/modelLibrary/hardware'

const real = process.env.NOEMA_REAL_HW === '1'
const COMFY = process.env.NOEMA_REAL_COMFY ?? ''

describe.skipIf(!real)('on this computer', () => {
  it('reads the real hardware', async () => {
    const p = await detectProfile()
    console.log(JSON.stringify({ gpu: p.primary, arch: p.arch, appArch: p.appArch, ramGB: p.ramGB, modelMemoryGB: p.modelMemoryGB, tier: p.tier, runtime: p.runtime, note: p.memoryNote, precisions: p.precisions }, null, 1))
    expect(p.simulated).toBeNull()
    expect(p.arch).toBe('x64')
    expect(p.primary?.vendor).toBe('nvidia')
  })

  it('shows the real state of the user\'s ComfyUI without touching it, and installs, checks and removes a real model in a scratch folder', async () => {
    const work = join(tmpdir(), `noema-real-lib-${Date.now()}`)
    mkdirSync(work, { recursive: true })
    const inventory = existsSync(COMFY) ? scanModels({ dataFolder: COMFY }) : null
    const before = inventory ? JSON.stringify(inventory) : ''
    // Only the stand-in for ComfyUI itself is served from this computer; the model below is downloaded from its real source.
    const archive = Buffer.from('scratch archive')
    const server = createServer((_q, r) => r.end(archive))
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const stub = `http://127.0.0.1:${(server.address() as { port: number }).port}/runtime.7z`
    const ai = new AiPackages({
      dataDir: join(work, 'data'),
      useRuntime: () => undefined,
      verifyRuntime: async () => null,
      hardware: async () => ({ gpu: { name: 'real', vendor: 'nvidia', vramGB: 8, driver: '0' }, platform: 'win32', supported: true, note: null }),
      extract: async (_a, dest, onFiles) => {
        mkdirSync(join(dest, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true })
        writeFileSync(join(dest, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), '# scratch')
        onFiles(1)
      },
      latestRelease: async () => ({ tag: 'scratch', url: stub, sha256: createHash('sha256').update(archive).digest('hex'), bytes: archive.length })
    })
    // Look at the user's ComfyUI first (read-only): a library connected to it shows what is there.
    let view: { inventory: typeof inventory; kind: 'managed' | 'local' | 'remote' | 'none' } = { inventory, kind: inventory ? 'local' : 'none' }
    const lib = new ModelLibrary({ ai, userCatalogDir: join(work, 'user-catalogue'), comfy: () => ({ inventory: view.inventory, kind: view.kind, folder: COMFY, dataFolder: COMFY, version: null, note: null }), ollama: new OllamaClient((u, i) => fetch(u, i as RequestInit)) })
    const o1 = await lib.overview()
    console.log('hardware:', o1.hardware.primary?.name, '|', o1.hardware.tier, '|', o1.hardware.modelMemoryGB, 'GB')
    for (const v of o1.entries) console.log(`${v.entry.id.padEnd(28)} fit=${v.fit.level.padEnd(12)} state=${v.state.kind.padEnd(17)} way=${v.way} variant=${v.fit.variant ?? '-'}`)
    expect(o1.hardware.simulated).toBeNull()
    if (inventory) {
      const after = JSON.stringify(scanModels({ dataFolder: COMFY }))
      expect(after).toBe(before)
    }

    // A real download, verified against the checksum in the catalogue, into a scratch managed folder.
    view = { inventory: null, kind: 'managed' }
    const root = join(work, 'ai')
    await ai.installRuntime(root, true)
    const entry = o1.entries.find((v) => v.entry.id === 'realesrgan-x4plus')!
    const plan = await lib.plan(entry.entry.id)
    console.log('plan:', plan.files.map((f) => `${f.name} ${f.bytes}`), plan.destination)
    const started = Date.now()
    const done = await lib.install(entry.entry.id, { consent: true })
    console.log('installed in', Math.round((Date.now() - started) / 1000), 's')
    expect(done.entries.find((v) => v.entry.id === entry.entry.id)!.state.kind).toBe('installed')
    const file = plan.files[0]!
    const path = join(root, 'models', file.folder, file.name)
    expect(statSync(path).size).toBe(file.bytes)
    expect(await lib.verify(entry.entry.id, true)).toEqual([])
    const gone = await lib.remove(entry.entry.id)
    expect(gone.removed).toEqual([file.name])
    expect(existsSync(path)).toBe(false)
    server.close()
    void readFileSync
  }, 600_000)
})
