import * as crypto from 'crypto'
import * as path from 'path'
import {
  type AuthConfig,
  loadAuthConfig,
  saveAuthConfig,
} from './auth'
import {
  backgroundCaptureSecretDelete,
  backgroundCaptureSecretLoad,
  backgroundCaptureSecretStore,
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
import { updateHealth, writeAuditEvent, writeLog } from './logging'

const BACKGROUND_CAPTURE_SECRET_PREFIX = 'backgroundCaptureSecret'

function backgroundCaptureKeychainAccount(config: AuthConfig): string {
  return config.backgroundKeychainAccount || BACKGROUND_CAPTURE_SECRET_PREFIX
}

function currentKeychainRequester(): string {
  return path.resolve(process.execPath)
}

function normalizedRequester(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? path.resolve(trimmed) : null
}

function backgroundCaptureRequesterMigrationNeeded(config: AuthConfig): boolean {
  const current = normalizedRequester(currentKeychainRequester())
  if (!current) return false

  const stored = normalizedRequester(config.backgroundKeychainRequester)
  if (!stored) return process.platform === 'darwin'
  return stored !== current
}

async function createBackgroundCaptureConfig(
  config: AuthConfig,
  helperSessionId: string,
  options: {
    reason?: string
    reconfigured?: boolean
  } = {},
): Promise<boolean> {
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
  saveAuthConfig(config)

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
  if (!options.forceReconfigure && hasStoredConfig) {
    if (backgroundCaptureRequesterMigrationNeeded(config)) {
      writeLog('info', 'capture', 'background_capture_requester_migration_required', {
        account: previousAccount,
        previousRequester: config.backgroundKeychainRequester || null,
        currentRequester: currentKeychainRequester(),
        reason: options.reason ?? 'requester_changed',
      })
      writeAuditEvent('capture', 'background_capture_requester_migration_required', {
        account: previousAccount,
        previousRequester: config.backgroundKeychainRequester || null,
        currentRequester: currentKeychainRequester(),
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
    await backgroundCaptureSecretDelete(previousAccount)
  }
  return configured
}

export async function ensureBackgroundCaptureSession(): Promise<string | null> {
  const existing = getCaptureSessionId()
  if (existing) return existing

  const config = loadAuthConfig()
  if (!config?.backgroundWrappedVaultKey || !config.backgroundWrapSalt) {
    updateHealth('capture', {
      configured: false,
      running: false,
      lastSkippedAt: new Date().toISOString(),
      lastSkippedReason: 'background_capture_not_configured',
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

export async function startBackgroundCapture(): Promise<boolean> {
  const sessionId = await ensureBackgroundCaptureSession()
  if (!sessionId) return false

  updateHealth('capture', {
    configured: true,
    running: true,
    startingAt: new Date().toISOString(),
  })
  updateHealth('daemon', {
    captureRunning: true,
    captureStartingAt: new Date().toISOString(),
  })
  writeAuditEvent('capture', 'background_capture_starting')
  await startWatchers('vault')
  updateHealth('capture', {
    configured: true,
    running: true,
    startedAt: new Date().toISOString(),
  })
  updateHealth('daemon', {
    captureRunning: true,
    captureStartedAt: new Date().toISOString(),
  })
  writeAuditEvent('capture', 'background_capture_started')
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
