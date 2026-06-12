import { ensureBackgroundCaptureSession } from './background-capture'
import { installCrashHandlers, updateHealth, writeLog } from './logging'
import { runParserReparseIfNeeded } from './parser-reparse'
import { clearCaptureSession, ensureDirs, getCaptureSessionId } from './store'
import { lockVaultSession, stopVaultHelper } from './vault-helper'

function argValue(name: string): string | null {
  const prefix = `${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))
  return raw ? raw.slice(prefix.length) : null
}

async function cleanupCaptureSession(): Promise<void> {
  const sessionId = getCaptureSessionId()
  clearCaptureSession()
  if (!sessionId) return
  await lockVaultSession(sessionId)
}

async function main(): Promise<void> {
  installCrashHandlers('parser-reparse-worker')
  ensureDirs()
  const reason = argValue('--reason') || 'background_worker'
  updateHealth('parser-reparse', {
    workerPid: process.pid,
    workerRunning: true,
    workerStartedAt: new Date().toISOString(),
    workerReason: reason,
  })

  const sessionId = await ensureBackgroundCaptureSession()
  if (!sessionId) {
    updateHealth('parser-reparse', {
      workerRunning: false,
      workerSkippedAt: new Date().toISOString(),
      workerSkippedReason: 'background_capture_session_unavailable',
    })
    return
  }

  try {
    const result = await runParserReparseIfNeeded(reason)
    updateHealth('parser-reparse', {
      workerRunning: false,
      workerCompletedAt: new Date().toISOString(),
      workerResult: result,
    })
  } finally {
    await cleanupCaptureSession()
  }
}

main().then(async () => {
  await stopVaultHelper()
  process.exit(0)
}).catch(error => {
  writeLog('warn', 'parser-reparse', 'worker_failed', { error })
  updateHealth('parser-reparse', {
    workerRunning: false,
    workerFailedAt: new Date().toISOString(),
    workerError: error instanceof Error ? error.message : String(error),
  })
  void stopVaultHelper().finally(() => process.exit(1))
})
