import * as crypto from 'crypto'
import * as path from 'path'
import { spawn, spawnSync } from 'child_process'
import {
  type AuthConfig,
  loadAuthConfig,
  saveAuthConfig,
} from './auth'
import {
  backgroundCaptureSecretDelete,
  backgroundCaptureSecretLoad,
  backgroundCaptureSecretStore,
  macHelperSecretAccessRequesterIdentity,
  macHelperSecretAccessRequesterPath,
} from './keychain'
import {
  clearCaptureSession,
  getCaptureSessionId,
  setCaptureSession,
} from './store'
import {
  lockVaultSession,
  unwrapSecretToCaptureSession,
  wrapSecretForSession,
} from './vault-helper'
import { startWatchers } from './watcher'
import { runParserReparseIfNeeded } from './parser-reparse'
import { updateHealth, writeAuditEvent, writeLog } from './logging'
import { ensureWindowsAutostart, isWindowsSystemContext, resolveWindowsStartupTarget } from './windows-autostart'
import { launcherBinaryForScripts, launcherEnvForBackgroundWorker } from './runtime'

const BACKGROUND_CAPTURE_SECRET_PREFIX = 'backgroundCaptureSecret'
const PARSER_REPARSE_BACKGROUND_DELAY_MS = 15000
let parserReparseScheduled = false

export type StartBackgroundCaptureOptions = {
  parserReparse?: 'await' | 'background' | 'skip'
  initialQueueTimeoutMs?: number
}

function backgroundCaptureKeychainAccount(config: AuthConfig): string {
  return config.backgroundKeychainAccount || BACKGROUND_CAPTURE_SECRET_PREFIX
}

function currentKeychainRequester(): string {
  if (process.platform === 'darwin') {
    const helperPath = macHelperSecretAccessRequesterPath()
    if (helperPath) return helperPath
  }
  return path.resolve(process.execPath)
}

function currentKeychainRequesterIdentity(): string | null {
  if (process.platform !== 'darwin') return null
  const helperIdentity = macHelperSecretAccessRequesterIdentity()
  if (helperIdentity) return helperIdentity

  const executable = currentKeychainRequester()
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', executable], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim() || ''
  const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || ''
  if (!identifier || !teamId || teamId === 'not set') return null
  return `darwin-codesign-v1:${teamId}:${identifier}`
}

function normalizedRequester(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? path.resolve(trimmed) : null
}

function normalizedRequesterIdentity(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed || null
}

function backgroundCaptureRequesterMigrationNeeded(config: AuthConfig): boolean {
  // macOS Keychain access can depend on the signed requester. Windows DPAPI and
  // Linux fallback secrets are user/root scoped, so a normal app-folder upgrade
  // must not stop background capture just because process.execPath changed.
  if (process.platform !== 'darwin') return false

  const current = normalizedRequester(currentKeychainRequester())
  if (!current) return false

  const stored = normalizedRequester(config.backgroundKeychainRequester)
  if (!stored) return process.platform === 'darwin'
  if (stored !== current) return true

  const currentIdentity = currentKeychainRequesterIdentity()
  const storedIdentity = normalizedRequesterIdentity(config.backgroundKeychainRequesterIdentity)
  if (currentIdentity) return storedIdentity !== currentIdentity
  return !!storedIdentity
}

function windowsBackgroundCaptureNeedsInteractiveUser(): { targetUser: string | null; targetSource: string } | null {
  if (process.platform !== 'win32' || !isWindowsSystemContext()) return null

  try {
    const target = resolveWindowsStartupTarget()
    if (target.source === 'interactive-user') {
      return { targetUser: target.userName, targetSource: target.source }
    }
  } catch {
    return { targetUser: null, targetSource: 'unresolved' }
  }

  return null
}

async function createBackgroundCaptureConfig(
  config: AuthConfig,
  helperSessionId: string,
  options: {
    reason?: string
    reconfigured?: boolean
  } = {},
): Promise<boolean> {
  const windowsUserMismatch = windowsBackgroundCaptureNeedsInteractiveUser()
  if (windowsUserMismatch) {
    const message = 'Windows background capture must be configured from the interactive Windows user session'
    updateHealth('capture', {
      configured: false,
      running: false,
      lastSkippedAt: new Date().toISOString(),
      lastSkippedReason: 'windows_interactive_user_required',
      lastErrorAt: new Date().toISOString(),
      lastError: message,
      targetUser: windowsUserMismatch.targetUser,
      targetSource: windowsUserMismatch.targetSource,
    })
    writeLog('warn', 'capture', 'background_capture_windows_interactive_user_required', {
      targetUser: windowsUserMismatch.targetUser,
      targetSource: windowsUserMismatch.targetSource,
      reason: options.reason ?? null,
    })
    writeAuditEvent('capture', 'background_capture_windows_interactive_user_required', {
      targetUser: windowsUserMismatch.targetUser,
      targetSource: windowsUserMismatch.targetSource,
      reason: options.reason ?? null,
    })
    return false
  }

  const account = `${BACKGROUND_CAPTURE_SECRET_PREFIX}:${crypto.randomUUID()}`
  const secret = crypto.randomBytes(32).toString('hex')
  await backgroundCaptureSecretStore(secret, account)

  const wrapped = await wrapSecretForSession(helperSessionId, secret)
  const captureSessionId = await unwrapSecretToCaptureSession(secret, wrapped.salt, wrapped.blob, wrapped.iterations)
  setCaptureSession(captureSessionId)
  config.backgroundWrappedVaultKey = wrapped.blob
  config.backgroundWrapSalt = wrapped.salt
  config.backgroundKeychainAccount = account
  config.backgroundKeychainRequester = currentKeychainRequester()
  const requesterIdentity = currentKeychainRequesterIdentity()
  if (requesterIdentity) config.backgroundKeychainRequesterIdentity = requesterIdentity
  else delete config.backgroundKeychainRequesterIdentity
  saveAuthConfig(config)
  ensureWindowsAutostart()

  updateHealth('capture', {
    configured: true,
    configuredAt: new Date().toISOString(),
    lastErrorAt: null,
    lastError: null,
  })
  writeAuditEvent('capture', 'background_capture_configured', {
    reason: options.reason ?? null,
    reconfigured: options.reconfigured === true,
  })
  return true
}

export async function ensureBackgroundCaptureConfigured(
  helperSessionId: string,
  options: {
    forceReconfigure?: boolean
    reason?: string
  } = {},
): Promise<boolean> {
  const config = loadAuthConfig()
  if (!config) return false

  const hasStoredConfig = !!config.backgroundWrappedVaultKey && !!config.backgroundWrapSalt
  const previousAccount = hasStoredConfig ? backgroundCaptureKeychainAccount(config) : null
  const requesterMigrationNeeded = !options.forceReconfigure && hasStoredConfig
    ? backgroundCaptureRequesterMigrationNeeded(config)
    : false
  if (!options.forceReconfigure && hasStoredConfig) {
    if (requesterMigrationNeeded) {
      writeLog('info', 'capture', 'background_capture_requester_migration_required', {
        account: previousAccount,
        previousRequester: config.backgroundKeychainRequester || null,
        currentRequester: currentKeychainRequester(),
        previousRequesterIdentity: config.backgroundKeychainRequesterIdentity || null,
        currentRequesterIdentity: currentKeychainRequesterIdentity(),
        reason: options.reason ?? 'requester_changed',
      })
      writeAuditEvent('capture', 'background_capture_requester_migration_required', {
        account: previousAccount,
        previousRequester: config.backgroundKeychainRequester || null,
        currentRequester: currentKeychainRequester(),
        previousRequesterIdentity: config.backgroundKeychainRequesterIdentity || null,
        currentRequesterIdentity: currentKeychainRequesterIdentity(),
        reason: options.reason ?? 'requester_changed',
      })
    } else {
      if (!config.backgroundKeychainAccount) {
        config.backgroundKeychainAccount = BACKGROUND_CAPTURE_SECRET_PREFIX
        saveAuthConfig(config)
      }
      const secret = await backgroundCaptureSecretLoad(backgroundCaptureKeychainAccount(config))
      if (secret) {
        updateHealth('capture', {
          configured: true,
          lastErrorAt: null,
          lastError: null,
        })
        return true
      }

      writeLog('warn', 'capture', 'background_capture_secret_missing', {
        account: backgroundCaptureKeychainAccount(config),
        reason: options.reason ?? 'missing_secret',
      })
      writeAuditEvent('capture', 'background_capture_secret_missing', {
        account: backgroundCaptureKeychainAccount(config),
        reason: options.reason ?? 'missing_secret',
      })
    }
  }

  const configured = await createBackgroundCaptureConfig(config, helperSessionId, {
    reason: options.reason,
    reconfigured: options.forceReconfigure === true || hasStoredConfig,
  })
  if (configured && previousAccount && previousAccount !== backgroundCaptureKeychainAccount(config)) {
    if (process.platform === 'darwin' && requesterMigrationNeeded) {
      writeLog('info', 'capture', 'background_capture_previous_secret_left_for_keychain_acl', {
        account: previousAccount,
        reason: options.reason ?? 'requester_changed',
      })
    } else {
      await backgroundCaptureSecretDelete(previousAccount)
    }
  }
  return configured
}

export async function ensureBackgroundCaptureSession(): Promise<string | null> {
  const existing = getCaptureSessionId()
  if (existing) {
    clearCaptureSession()
    writeLog('info', 'capture', 'background_capture_session_refresh_required')
  }

  const config = loadAuthConfig()
  if (!config?.backgroundWrappedVaultKey || !config.backgroundWrapSalt) {
    updateHealth('capture', {
      configured: false,
      running: false,
      lastSkippedAt: new Date().toISOString(),
      lastSkippedReason: 'background_capture_not_configured',
      lastErrorAt: null,
      lastError: null,
    })
    return null
  }

  if (backgroundCaptureRequesterMigrationNeeded(config)) {
    updateHealth('capture', {
      configured: true,
      running: false,
      lastSkippedAt: new Date().toISOString(),
      lastSkippedReason: 'background_capture_keychain_migration_required',
    })
    writeLog('info', 'capture', 'background_capture_keychain_migration_required', {
      account: backgroundCaptureKeychainAccount(config),
      previousRequester: config.backgroundKeychainRequester || null,
      currentRequester: currentKeychainRequester(),
      previousRequesterIdentity: config.backgroundKeychainRequesterIdentity || null,
      currentRequesterIdentity: currentKeychainRequesterIdentity(),
    })
    return null
  }

  const secret = await backgroundCaptureSecretLoad(backgroundCaptureKeychainAccount(config))
  if (!secret) {
    updateHealth('capture', {
      configured: true,
      running: false,
      lastErrorAt: new Date().toISOString(),
      lastError: 'background capture secret unavailable in OS keychain',
    })
    return null
  }

  try {
    const sessionId = await unwrapSecretToCaptureSession(
      secret,
      config.backgroundWrapSalt,
      config.backgroundWrappedVaultKey,
    )
    setCaptureSession(sessionId)
    return sessionId
  } catch (error) {
    writeLog('error', 'capture', 'background_capture_unlock_failed', { error })
    updateHealth('capture', {
      configured: true,
      running: false,
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

function runParserReparseInBackground(reason: string): void {
  if (parserReparseScheduled) return
  parserReparseScheduled = true
  updateHealth('parser-reparse', {
    running: false,
    scheduledAt: new Date().toISOString(),
    scheduledReason: reason,
    scheduledDelayMs: PARSER_REPARSE_BACKGROUND_DELAY_MS,
  })
  setTimeout(() => {
    parserReparseScheduled = false
    const workerScript = path.join(__dirname, 'parser-reparse-worker.js')
    const env = {
      ...launcherEnvForBackgroundWorker('parser-reparse'),
      DATAMOAT_PARSER_REPARSE_MAX_SESSIONS_PER_RUN: process.env.DATAMOAT_PARSER_REPARSE_MAX_SESSIONS_PER_RUN || '40',
      DATAMOAT_PARSER_REPARSE_MAX_REPARSED_PER_RUN: process.env.DATAMOAT_PARSER_REPARSE_MAX_REPARSED_PER_RUN || '12',
      DATAMOAT_PARSER_REPARSE_MAX_RUNTIME_MS: process.env.DATAMOAT_PARSER_REPARSE_MAX_RUNTIME_MS || '12000',
    }
    try {
      const child = spawn(
        launcherBinaryForScripts(),
        [workerScript, `--reason=${reason}`],
        {
          stdio: 'ignore',
          env,
        },
      )
      updateHealth('parser-reparse', {
        running: false,
        workerPid: child.pid ?? null,
        workerStartedAt: new Date().toISOString(),
        workerReason: reason,
        workerError: null,
      })
      child.once('error', error => {
        writeLog('warn', 'parser-reparse', 'background_worker_spawn_failed', { reason, error })
        updateHealth('parser-reparse', {
          running: false,
          workerErrorAt: new Date().toISOString(),
          workerError: error instanceof Error ? error.message : String(error),
        })
      })
      child.once('exit', (code, signal) => {
        updateHealth('parser-reparse', {
          running: false,
          workerExitedAt: new Date().toISOString(),
          workerExitCode: code,
          workerExitSignal: signal,
        })
      })
    } catch (error) {
      writeLog('warn', 'parser-reparse', 'background_worker_start_failed', { reason, error })
      updateHealth('parser-reparse', {
        running: false,
        lastErrorAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      })
    }
  }, PARSER_REPARSE_BACKGROUND_DELAY_MS)
}

export async function startBackgroundCapture(options: StartBackgroundCaptureOptions = {}): Promise<boolean> {
  const sessionId = await ensureBackgroundCaptureSession()
  if (!sessionId) return false
  ensureWindowsAutostart()
  const parserReparseMode = options.parserReparse ?? 'skip'

  updateHealth('capture', {
    configured: true,
    running: true,
    startingAt: new Date().toISOString(),
    lastSkippedAt: null,
    lastSkippedReason: null,
    lastErrorAt: null,
    lastError: null,
  })
  updateHealth('daemon', {
    captureRunning: true,
    captureStartingAt: new Date().toISOString(),
  })
  writeAuditEvent('capture', 'background_capture_starting')
  if (parserReparseMode === 'await') {
    await runParserReparseIfNeeded('background_capture_start')
  } else if (parserReparseMode === 'skip') {
    updateHealth('parser-reparse', {
      running: false,
      lastSkippedAt: new Date().toISOString(),
      lastSkippedReason: 'background_capture_start_skipped',
    })
  }
  await startWatchers('vault', { initialQueueTimeoutMs: options.initialQueueTimeoutMs })
  updateHealth('capture', {
    configured: true,
    running: true,
    startedAt: new Date().toISOString(),
    lastSkippedAt: null,
    lastSkippedReason: null,
    lastErrorAt: null,
    lastError: null,
  })
  updateHealth('daemon', {
    captureRunning: true,
    captureStartedAt: new Date().toISOString(),
  })
  writeAuditEvent('capture', 'background_capture_started')
  if (parserReparseMode === 'background') {
    runParserReparseInBackground('background_capture_start')
  }
  return true
}

export async function stopBackgroundCapture(): Promise<void> {
  const sessionId = getCaptureSessionId()
  clearCaptureSession()
  if (sessionId) {
    await lockVaultSession(sessionId)
  }
  updateHealth('capture', {
    running: false,
    stoppedAt: new Date().toISOString(),
  })
  updateHealth('daemon', {
    captureRunning: false,
    captureStoppedAt: new Date().toISOString(),
  })
}
