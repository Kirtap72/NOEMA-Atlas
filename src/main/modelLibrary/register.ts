// Connects the AI Model Library to the window: what the catalogue shows, plans, installs, removal and checks. Every install is the user's
// own action with a consent flag; nothing here downloads on its own.
import { ipcMain } from 'electron'
import { join } from 'node:path'
import type { AiPackages } from '../studio/aiPackages'
import type { Studio } from '../studio/studio'
import { ModelLibrary } from './library'
import { OllamaClient } from './ollama'
import { setLibraryOpener, setModelLibrary } from './access'

export interface ModelLibraryWiring {
  dataDir: string
  ai: AiPackages
  studio: Studio
  broadcast: (channel: string, payload?: unknown) => void
  atlasModelInstalled?: () => boolean
}

export function registerModelLibrary(wiring: ModelLibraryWiring): ModelLibrary {
  const library = new ModelLibrary({
    ai: wiring.ai,
    userCatalogDir: join(wiring.dataDir, 'model-library'),
    comfy: () => wiring.studio.modelLibraryView(),
    remoteNames: () => wiring.studio.remoteModelNames(),
    ollama: new OllamaClient((url, init) => fetch(url, init as RequestInit)),
    atlasModelInstalled: wiring.atlasModelInstalled,
    broadcast: wiring.broadcast
  })
  setModelLibrary(library)
  setLibraryOpener((request) => wiring.broadcast('models:open', request))
  const sim = (v: unknown): string | null => (typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v) ? v : null)
  const id = (v: unknown): string => {
    if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(v)) throw new Error('That model is not in the library.')
    return v
  }
  ipcMain.handle('models:overview', (_e, simulate: unknown) => library.overview(sim(simulate)))
  ipcMain.handle('models:plan', (_e, entry: unknown, variant: unknown, simulate: unknown) => library.plan(id(entry), typeof variant === 'string' ? variant : null, sim(simulate)))
  ipcMain.handle('models:install', async (_e, entry: unknown, options: { variant?: unknown; consent?: unknown }) => {
    const overview = await library.install(id(entry), { variant: typeof options?.variant === 'string' ? options.variant : null, consent: options?.consent === true })
    wiring.studio.modelsChanged()
    return overview
  })
  ipcMain.handle('models:stop', () => library.stop())
  ipcMain.handle('models:remove', async (_e, entry: unknown) => {
    const result = await library.remove(id(entry))
    wiring.studio.modelsChanged()
    return result
  })
  ipcMain.handle('models:verify', (_e, entry: unknown, deep: unknown) => library.verify(id(entry), deep === true))
  // The user put files into their own ComfyUI by hand, or changed it: read it again.
  ipcMain.handle('models:rescan', async (_e, simulate: unknown) => {
    wiring.studio.modelsChanged()
    library.reload()
    await library.refreshProfile()
    return library.overview(sim(simulate))
  })
  return library
}
