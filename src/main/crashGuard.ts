import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, crashReporter } from 'electron'

/**
 * Keeps one unexpected error from ending the whole application, and leaves evidence when something still goes wrong.
 *
 *  - JavaScript errors nobody caught are written to `logs/main.log` and the application carries on.
 *  - A window whose page process dies is reloaded once instead of leaving an empty frame.
 *  - A native crash cannot be caught by any program; Windows ends the process. So the application writes a marker while it
 *    runs and removes it on a normal exit: the next start knows the last session ended unexpectedly and says so in the log,
 *    and crash dumps are kept locally (never uploaded) in `crash-dumps`.
 */
let logFile: string | null = null

export function logLine(kind: string, message: string): void {
  if (!logFile) return
  try {
    if (existsSync(logFile) && statSync(logFile).size > 1_000_000) renameSync(logFile, `${logFile}.old`)
    appendFileSync(logFile, `${new Date().toISOString()} ${kind} ${message.replace(/\r?\n/g, ' | ')}\n`)
  } catch {
    /* logging must never be the thing that fails */
  }
}

export interface PreviousSession {
  endedUnexpectedly: boolean
  startedAt: string | null
}

export function installCrashGuard(userData: string): PreviousSession {
  const logs = join(userData, 'logs')
  try {
    mkdirSync(logs, { recursive: true })
  } catch {
    /* without a folder there is simply no log */
  }
  logFile = join(logs, 'main.log')
  try {
    const dumps = join(userData, 'crash-dumps')
    mkdirSync(dumps, { recursive: true })
    app.setPath('crashDumps', dumps)
    crashReporter.start({ uploadToServer: false, compress: true, productName: 'NOEMA Atlas', submitURL: '' })
  } catch (error) {
    logLine('warn', `crash dumps are not available: ${error instanceof Error ? error.message : String(error)}`)
  }

  const marker = join(userData, 'session.json')
  let previous: PreviousSession = { endedUnexpectedly: false, startedAt: null }
  try {
    if (existsSync(marker)) {
      const last = JSON.parse(readFileSync(marker, 'utf8')) as { startedAt?: string; clean?: boolean }
      previous = { endedUnexpectedly: last.clean === false, startedAt: last.startedAt ?? null }
    }
  } catch {
    /* an unreadable marker means nothing is known */
  }
  const startedAt = new Date().toISOString()
  const writeMarker = (clean: boolean): void => {
    try {
      writeFileSync(marker, JSON.stringify({ startedAt, clean, version: app.getVersion() }))
    } catch {
      /* ignore */
    }
  }
  writeMarker(false)
  app.on('before-quit', () => writeMarker(true))
  if (previous.endedUnexpectedly) logLine('warn', `the previous session (started ${previous.startedAt ?? 'unknown'}) ended unexpectedly`)
  logLine('info', `started ${app.getVersion()} on ${process.platform} ${process.arch}`)

  process.on('uncaughtException', (error) => logLine('error', `uncaught exception: ${error?.stack ?? String(error)}`))
  process.on('unhandledRejection', (reason) => logLine('error', `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`))
  app.on('child-process-gone', (_event, details) => logLine('error', `${details.type} process gone: ${details.reason} (exit ${details.exitCode})`))
  let reloads = 0
  app.on('render-process-gone', (_event, contents, details) => {
    logLine('error', `page process gone: ${details.reason} (exit ${details.exitCode})`)
    if (details.reason === 'clean-exit' || reloads >= 3) return
    reloads += 1
    const win = BrowserWindow.fromWebContents(contents)
    if (win && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 500)
  })
  return previous
}
