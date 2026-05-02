import * as fs from 'fs'
import * as path from 'path'
import { ensureDirs } from './store'
import { hasAuthenticatedUiSession, startUIServer } from './ui/server'
import { loadAuthConfig } from './auth'
import { PID_FILE, STATE_DIR } from './config'
import { installCrashHandlers, updateHealth, writeLog } from './logging'
import { findDaemonPids, isDaemonRunning } from './runtime'
import { startAutoUpdateLoop } from './auto-update'
import { startBackgroundCapture, stopBackgroundCapture } from './background-capture'
import { ALL_SOURCES } from './config'
import { bootstrapCaptureSummary } from './bootstrap-capture'
import { importBootstrapCaptureIntoVault, startWatchers, stopWatchers } from './watcher'

async function main() {
  ensureDirs()
  installCrashHandlers('daemon')

  const auth = loadAuthConfig()
  if (auth?.vaultKey) {
    writeLog('warn', 'daemon', 'legacy_vault_key_detected')
    updateHealth('daemon', { legacyVaultKeyDetected: true })
  }

  const otherDaemonPid = findOtherDaemonPid()
  if (otherDaemonPid) {
    writeLog('info', 'daemon', 'already_running', { pid: otherDaemonPid })
    process.exit(0)
  }

  updateHealth('daemon', {
    running: true,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    locked: true,
    captureRunning: false,
  })
  for (const source of ALL_SOURCES) {
    updateHealth(`watcher:${source}`, {
      watching: false,
      restartedAt: new Date().toISOString(),
    })
  }
  updateHealth('auth', {
    retryAfterMs: 0,
  })
  updateHealth('capture', {
    running: false,
  })
  writeLog('info', 'daemon', 'started', { pid: process.pid })

  // Start UI server
  const { port, url } = await startUIServer()
  fs.writeFileSync(PID_FILE, String(process.pid))
  fs.writeFileSync(path.join(STATE_DIR, 'port'), String(port))
  updateHealth('daemon', { running: true, pid: process.pid, port, url })
  writeLog('info', 'daemon', 'ui_ready', { port })
  const captureStarted = await startBackgroundCapture()
  await retryBootstrapImportAfterStartup(captureStarted)
  startAutoUpdateLoop(hasAuthenticatedUiSession)

  // Clean up PID on exit
  const cleanup = () => {
    void stopBackgroundCapture()
    try {
      if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(PID_FILE)
      }
    } catch { /* ignore */ }
    updateHealth('daemon', { running: false, stoppedAt: new Date().toISOString() })
  }
  process.on('SIGTERM', () => { cleanup(); process.exit(0) })
  process.on('SIGINT', () => { cleanup(); process.exit(0) })
  process.on('exit', cleanup)
}

main().catch(err => {
  writeLog('error', 'daemon', 'fatal', { error: err })
  process.exit(1)
})

function findOtherDaemonPid(): number | null {
  const pidFilePid = isDaemonRunning()
  if (pidFilePid && pidFilePid !== process.pid) return pidFilePid
  const other = findDaemonPids().find(pid => pid !== process.pid)
  return other ?? null
}

async function retryBootstrapImportAfterStartup(captureStarted: boolean): Promise<void> {
  if (!captureStarted) return
  const bootstrap = bootstrapCaptureSummary()
  if (!bootstrap.enabled && bootstrap.entries === 0) return

  writeLog('info', 'daemon', 'bootstrap_retry_start', bootstrap)
  await stopWatchers()
  const result = await importBootstrapCaptureIntoVault()
  updateHealth('daemon', {
    bootstrapImportedFiles: result.importedFiles,
    bootstrapImportedMessages: result.importedMessages,
    bootstrapRemainingFiles: result.remainingFiles,
  })
  writeLog('info', 'daemon', 'bootstrap_retry_done', result)
  await startWatchers('vault')
}
