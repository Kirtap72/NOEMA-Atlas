import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The window talks to the main process through named channels. A wrong name fails quietly (the call returns another feature's answer, or
// nothing). Once the image model's status was read from the AI-packages channel, so the Taste Compass said the model was missing.
const read = (p: string): string => readFileSync(p, 'utf8')
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.ts') ? [join(dir, f)] : []))
const preload = read('src/preload/index.ts')
const main = walk('src/main').map(read).join('\n')

describe('the channels between the window and the main process', () => {
  it('every call the window can make has a handler in the main process', () => {
    const invoked = Array.from(preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)).map((m) => m[1]!)
    expect(invoked.length).toBeGreaterThan(100)
    const missing = invoked.filter((name) => !main.includes(`'${name}'`))
    expect(missing).toEqual([])
  })

  it('every event the window listens to is sent by the main process', () => {
    const listened = Array.from(preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)).map((m) => m[1]!)
    const unsent = listened.filter((name) => !main.includes(`'${name}'`))
    expect(unsent).toEqual([])
  })

  it('the image model status is read and followed on its own channel, not the AI-packages one', () => {
    expect(preload).toMatch(/getModelStatus: \(\) => ipcRenderer\.invoke\('ai:status'\)/)
    expect(preload).toMatch(/ipcRenderer\.on\('ai:status', listener\)/)
    expect(preload).toMatch(/aiStatus: \(\) => ipcRenderer\.invoke\('aipkg:status'\)/)
  })
})
