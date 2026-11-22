// Demonstrates the native crash behind the Smart Organizer failures (sharp 0.35.5): several FAILING sharp operations at the
// same time end the whole process with exit code 0xC0000409 (-1073740791), on plain Node and on Electron's Node alike.
//
//   node scripts/repro-sharp-crash.mjs [--runs 12] [--electron]
//
// It starts fresh processes that open 300 unusable files at once (missing, empty, random bytes, folders), and prints how many
// died. With the application's guard (src/main/safeSharp.ts) the same work is turned into ordinary errors and nothing dies.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const runs = Number(args.includes('--runs') ? args[args.indexOf('--runs') + 1] : 12)
const electron = args.includes('--electron')
const dir = mkdtempSync(join(tmpdir(), 'noema-sharp-crash-'))
for (let i = 0; i < 100; i += 1) writeFileSync(join(dir, `random-${i}.png`), Buffer.from(Array.from({ length: 300 + i }, (_v, k) => (k * 37 + i * 11) % 251)))
for (let i = 0; i < 100; i += 1) writeFileSync(join(dir, `empty-${i}.jpg`), Buffer.alloc(0))
for (let i = 0; i < 50; i += 1) mkdirSync(join(dir, `folder-${i}.png`))
const worker = join(dir, 'worker.mjs')
writeFileSync(
  worker,
  `import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const sharp = createRequire(${JSON.stringify(resolve('package.json').replace(/\\/g, '/'))})('sharp')
const dir = process.argv[2]
const files = [...readdirSync(dir).filter((f) => f !== 'worker.mjs').map((f) => join(dir, f)), ...Array.from({ length: 100 }, (_v, i) => join(dir, 'gone-' + i + '.png'))]
await Promise.all(files.map(async (f) => { try { await sharp(f, { failOn: 'none' }).metadata() } catch {} }))
`
)
const exe = electron ? resolve('node_modules/electron/dist/electron.exe') : process.execPath
const env = { ...process.env, ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
let died = 0
for (let i = 1; i <= runs; i += 1) {
  const r = spawnSync(exe, [worker, dir], { env, encoding: 'utf8' })
  if (r.status !== 0) {
    died += 1
    console.log(`run ${i}: DIED with exit code ${r.status} (0x${(r.status >>> 0).toString(16)})`)
  } else console.log(`run ${i}: ok`)
}
console.log(`\n${died} of ${runs} processes died while opening unusable files with raw sharp`)
try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* temp folder */
}
