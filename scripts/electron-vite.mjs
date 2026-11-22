import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const cli = resolve('node_modules/electron-vite/bin/electron-vite.js')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  windowsHide: false
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
