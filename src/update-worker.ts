import { ensureDirs } from './store'
import { applyUpdate, checkForUpdate, updateBlockReason } from './update'
import {
  acquireUpdateLock,
  loadAppConfig,
  releaseUpdateLock,
  writeUpdateState,
} from './update-config'
import { safeError, writeLog } from './logging'

type WorkerMode = 'auto' | 'manual'

function asMode(value: string | undefined): WorkerMode {
  return value === 'manual' ? 'manual' : 'auto'
}

async function main(): Promise<void> {
  ensureDirs()
  const mode = asMode(process.argv[2])

  if (!acquireUpdateLock()) process.exit(0)

  writeUpdateState({
    running: true,
    lastResult: 'checking',
    message: mode === 'auto' ? 'checking for automatic updates' : 'checking for updates',
  })

  try {
    if (mode === 'auto' && !loadAppConfig().autoUpdateEnabled) {
      writeUpdateState({
        running: false,
        lastResult: 'idle',
        message: 'automatic updates are disabled',
      })
      return
    }

    const status = checkForUpdate()
    const commonState = status.supported
      ? {
          installMode: status.mode,
          updateStrategy: status.strategy,
          supported: true,
          currentVersion: status.current,
          branch: status.branch,
          remote: status.remote,
          ahead: status.ahead,
          behind: status.behind,
          clean: status.clean,
        }
      : {
          installMode: status.mode,
          updateStrategy: status.strategy,
          supported: false,
          currentVersion: null,
          branch: null,
          remote: null,
          ahead: null,
          behind: null,
          clean: null,
        }

    writeUpdateState({
      running: true,
      lastCheckedAt: new Date().toISOString(),
      ...commonState,
    })

    const reason = updateBlockReason(status)
    if (reason) {
      const isCurrent = reason === 'already up to date'
      writeLog('info', 'update', 'skipped', { mode, reason })
      writeUpdateState({
        running: false,
        lastResult: status.supported ? (isCurrent ? 'up-to-date' : 'blocked') : 'unsupported',
        message: reason,
        ...commonState,
      })
      return
    }
    if (!status.supported) throw new Error('update status became unavailable')

    writeLog('info', 'update', 'apply_start', { mode })
    writeUpdateState({
      running: true,
      lastResult: 'updating',
      message: mode === 'auto' ? 'applying automatic update' : 'applying update',
      ...commonState,
    })

    const result = await applyUpdate()
    writeLog('info', 'update', 'apply_success', { mode, version: result.version })
    writeUpdateState({
      running: false,
      lastCheckedAt: new Date().toISOString(),
      lastAppliedAt: new Date().toISOString(),
      lastResult: result.updated ? 'updated' : 'up-to-date',
      message: result.updated ? 'update applied successfully' : 'already up to date',
      installMode: status.mode,
      updateStrategy: status.strategy,
      supported: true,
      currentVersion: result.version,
      branch: status.branch,
      remote: status.remote,
      ahead: 0,
      behind: 0,
      clean: true,
    })
  } catch (error) {
    writeLog('error', 'update', 'apply_failed', { mode, error: safeError(error) })
    writeUpdateState({
      running: false,
      lastResult: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    releaseUpdateLock()
  }
}

main().catch(error => {
  writeLog('error', 'update', 'worker_fatal', { error: safeError(error) })
  writeUpdateState({
    running: false,
    lastResult: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
  releaseUpdateLock()
  process.exit(1)
})
