import * as fs from 'fs'
import * as path from 'path'
import { ensureDirs } from './store'
import { hasAuthenticatedUiSession, startUIServer } from './ui/server'
import { isSetupDone, loadAuthConfig } from './auth'
import { PID_FILE, STATE_DIR } from './config'
import { installCrashHandlers, updateHealth, writeLog } from './logging'
import { findDaemonPids, isDaemonRunning } from './runtime'
import { startAutoUpdateLoop } from './auto-update'
import { startBackgroundCapture, stopBackgroundCapture } from './background-capture'
import { ALL_SOURCES } from './config'
import { bootstrapCaptureSummary } from './bootstrap-capture'
import { importBootstrapCaptureIntoVault, startWatchers, stopWatchers } from './watcher'
import { scanAndBackupSkills } from './skills-backup'
import { isWindowsSystemContext } from './windows-context'

function allowWindowsSystemContextForTest(): boolean {
  return process.env.DATAMOAT_ALLOW_WINDOWS_SYSTEM_CONTEXT === '1'
    || process.env.DATAMOAT_ELECTRON_SMOKE === '1'
}

async function main() {
  if (isWindowsSystemContext() && !allowWindowsSystemContextForTest()) {
    console.error('DataMoat daemon refused to start from the Windows SYSTEM/session-0 profile.')
    process.exit(1)
  }

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
    stoppedAt: null,
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
  updateHealth('daemon', { running: true, pid: process.pid, port, url, stoppedAt: null })
  writeLog('info', 'daemon', 'ui_ready', { port })
  let captureStarted = false
  if (isSetupDone()) {
    try {
      // Daemon startup must keep the unlock API stable. Parser reparse can be
      // heavy on real vaults, so it must not run before the user can unlock.
      captureStarted = await startBackgroundCapture({ parserReparse: 'skip' })
    } catch (error) {
      writeLog('warn', 'daemon', 'background_capture_start_failed_nonfatal', { error })
      updateHealth('capture', {
        running: false,
        lastErrorAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  } else {
    updateHealth('capture', {
      running: false,
      configured: false,
      lastSkippedAt: new Date().toISOString(),
      lastSkippedReason: 'setup_incomplete',
      lastErrorAt: null,
      lastError: null,
    })
  }
  await startBootstrapCaptureBeforeSetup(captureStarted)
  await retryBootstrapImportAfterStartup(captureStarted)
  if (captureStarted) await scanAndBackupSkills('daemon_start')
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

async function startBootstrapCaptureBeforeSetup(captureStarted: boolean): Promise<void> {
  if (captureStarted || isSetupDone()) return
  const bootstrap = bootstrapCaptureSummary()
  if (!bootstrap.enabled) return

  writeLog('info', 'daemon', 'bootstrap_capture_watchers_start', bootstrap)
  updateHealth('daemon', {
    bootstrapCapture: true,
    bootstrapCaptureRequestedBy: bootstrap.requestedBy,
    bootstrapCaptureStartedAt: bootstrap.createdAt,
    bootstrapWatcherRunning: true,
  })
  updateHealth('capture', {
    configured: false,
    running: false,
    bootstrapCapture: true,
  })
  await startWatchers('bootstrap')
  writeLog('info', 'daemon', 'bootstrap_capture_watchers_ready', bootstrap)
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
  writeLog('info', 'parser-reparse', 'bootstrap_retry_reparse_deferred')
  await startWatchers('vault')
  await scanAndBackupSkills('bootstrap_retry')
}
