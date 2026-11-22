import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceWatcher } from '../src/main/sourceWatcher'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let dir = ''
let watcher: SourceWatcher | null = null

afterEach(() => {
  watcher?.close()
  watcher = null
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  dir = ''
})

describe('noticing new pictures in a watched folder', () => {
  it('checks a source once, after a burst of new pictures has stopped, including in subfolders', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noema-watch-'))
    const calls: string[] = []
    watcher = new SourceWatcher((id) => calls.push(id), { quietMs: 300, minGapMs: 0 })
    watcher.sync([{ id: 'root-1', path: dir }])
    await wait(150)
    mkdirSync(join(dir, 'new folder'))
    for (let i = 0; i < 12; i += 1) writeFileSync(join(dir, 'new folder', `p${i}.png`), 'x')
    await wait(900)
    expect(calls).toEqual(['root-1']) // one check for the whole burst
  })

  it('ignores files that are not pictures, and stops when a source is removed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noema-watch-'))
    const calls: string[] = []
    watcher = new SourceWatcher((id) => calls.push(id), { quietMs: 200, minGapMs: 0 })
    watcher.sync([{ id: 'a', path: dir }])
    await wait(150)
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    writeFileSync(join(dir, 'picture.png.noema-part'), 'half')
    await wait(600)
    expect(calls).toEqual([])
    watcher.sync([])
    writeFileSync(join(dir, 'late.png'), 'x')
    await wait(600)
    expect(calls).toEqual([])
  })

  it('does not fail for a source that is not there', () => {
    watcher = new SourceWatcher(() => undefined)
    expect(() => watcher!.sync([{ id: 'gone', path: join(tmpdir(), 'noema-no-such-folder-123') }])).not.toThrow()
  })
})
