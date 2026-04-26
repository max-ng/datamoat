import * as child_process from 'child_process'
import * as path from 'path'
import { ensureDirs } from './store'
import {
  ensureDaemonRunning,
  findDaemonPids,
  launcherBinaryForScripts,
  launcherEnvForScripts,
  nodeBinaryForBuildTasks,
  stopDaemonPids,
} from './runtime'
import { acquireUpdateLock, releaseUpdateLock, writeUpdateState } from './update-config'
import { inspectReinstallSource } from './reinstall'
import { safeError, writeLog } from './logging'

async function waitForDaemonReady(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      await ensureDaemonRunning()
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('daemon did not start in time')
}

async function main(): Promise<void> {
  ensureDirs()

  const requestedPath = process.argv[2] || ''
  if (!acquireUpdateLock()) process.exit(0)

  try {
    const source = inspectReinstallSource(requestedPath)
    if (!source.available || !source.root || !source.installScriptPath) {
      writeUpdateState({
        running: false,
        lastResult: 'error',
        message: source.reason || 'source reinstall is not available',
      })
      return
    }

    const sourceType = source.liveCheckout ? 'live git checkout' : 'recorded source snapshot'
    writeLog('info', 'reinstall', 'start', { root: source.root, liveCheckout: source.liveCheckout })
    writeUpdateState({
      running: true,
      lastResult: 'updating',
      message: `reinstalling from ${sourceType}: ${source.root}`,
    })

    await new Promise(resolve => setTimeout(resolve, 600))

    const pids = Array.from(new Set(findDaemonPids()))
    if (pids.length > 0) {
      stopDaemonPids(pids)
      await new Promise(resolve => setTimeout(resolve, 1200))
    }

    const nodeBin = nodeBinaryForBuildTasks()
    const env = {
      ...launcherEnvForScripts(),
      NODE_BIN: nodeBin,
      PATH: `${path.dirname(nodeBin)}:${process.env.PATH || ''}`,
    }

    child_process.execFileSync('bash', ['-n', source.installScriptPath], {
      cwd: source.root,
      env,
      stdio: 'ignore',
    })
    child_process.execFileSync('bash', [source.installScriptPath], {
      cwd: source.root,
      env,
      stdio: 'ignore',
    })

    await waitForDaemonReady()

    writeLog('info', 'reinstall', 'success', { root: source.root, liveCheckout: source.liveCheckout })
    writeUpdateState({
      running: false,
      lastAppliedAt: new Date().toISOString(),
      lastResult: 'updated',
      message: source.liveCheckout
        ? 'reinstalled successfully from live git checkout'
        : 'reinstalled successfully from recorded source snapshot',
    })
  } catch (error) {
    writeLog('error', 'reinstall', 'failed', { error: safeError(error) })
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
  writeLog('error', 'reinstall', 'worker_fatal', { error: safeError(error) })
  writeUpdateState({
    running: false,
    lastResult: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
  releaseUpdateLock()
  process.exit(1)
})
