/* eslint-disable @typescript-eslint/no-explicit-any */
import express, { Request, Response, NextFunction } from 'express'
import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as crypto from 'crypto'
import QRCode from 'qrcode'
import {
  loadSessions,
  readSessionMessages,
  readSessionMessagesPage,
  readRawRecords,
  readAttachment,
  setVaultSession,
  encryptVaultFiles,
  encryptAttachmentFiles,
  encryptStateFiles,
  clearVaultSession,
  getVaultSessionId,
  getCaptureSessionId,
  hasVaultSession,
  migrateStateStorage,
} from '../store'
import { Message, Session, Source } from '../types'
import { UI_PORT_RANGE } from '../config'
import {
  isSetupDone, loadAuthConfig, saveAuthConfig,
  generateTOTPSecret, verifyTOTP, generateMnemonic,
  sha256, generateRecoveryCodes, totpURL,
  hashPassword, verifyPassword,
  normalizeMnemonic, findRecoveryCodeIndex, consumeRecoveryCode, normalizeRecoveryCode,
  AUTH_SCHEMA_VERSION, deleteAuthConfig,
} from '../auth'
import { IS_MAC, secureEnclaveAvailable, secureEnclaveStatus, backgroundCaptureSecretDelete } from '../keychain'
import { updateHealth, writeAuditEvent, writeLog } from '../logging'
import { importBootstrapCaptureIntoVault, startWatchers, stopWatchers } from '../watcher'
import { ensureBackgroundCaptureConfigured, startBackgroundCapture, stopBackgroundCapture } from '../background-capture'
import {
  createVaultSession,
  decryptBytesForSession,
  encryptBytesForSession,
  lockVaultSession,
  unwrapSecretToSession,
  unwrapTouchIdToSession,
  wrapSecretForSession,
  wrapTouchIdForSession,
} from '../vault-helper'
import { triggerDetachedUpdate } from '../auto-update'
import { inspectReinstallSource, recordedReinstallSource, triggerDetachedReinstall } from '../reinstall'
import { checkForUpdate, updateBlockReason } from '../update'
import {
  loadAppConfig,
  loadUpdateState,
  writeUpdateState,
  saveAppConfig,
  isUpdateRunning,
} from '../update-config'
import { bootstrapCaptureSummary, loadBootstrapCaptureState, preflightBootstrapCapture } from '../bootstrap-capture'
import { extractClaudeLine } from '../extractors/claude'
import { extractCodexLine } from '../extractors/codex'
import { extractOpenclawLine } from '../extractors/openclaw'
import { detectInstallContext } from '../install-context'
import { updateReleasesUrl } from '../update-channel'

type SessionFlow =
  | 'touchid'
  | 'touchid_totp'
  | 'password'
  | 'password_totp'
  | 'recovery_code'
  | 'mnemonic'

type PendingSetupState = {
  nonce: string
  secret: string
  mnemonic: string
  qrDataUrl: string
  createdAt: number
  passwordEnabled?: boolean
  touchIdEnabled?: boolean
  password?: string
  totpEnrolled?: boolean
  recoveryPlain?: string[]
  recoveryHashed?: string[]
}

type AuthMethod = 'password' | 'totp' | 'recovery_code' | 'mnemonic' | 'touchid'
type AuthAttemptState = {
  failures: number
  blockedUntil: number
  lastFailureAt: number
  lastFailureReason: string
}

type LoadedAuthConfig = NonNullable<ReturnType<typeof loadAuthConfig>>

const SESSION_IDLE_MS: Record<SessionFlow, number> = {
  touchid: 15 * 60 * 1000,
  touchid_totp: 15 * 60 * 1000,
  password: 15 * 60 * 1000,
  password_totp: 15 * 60 * 1000,
  recovery_code: 15 * 60 * 1000,
  mnemonic: 15 * 60 * 1000,
}

const AUTH_BACKOFF_BASE_MS = 1000
const AUTH_BACKOFF_MAX_MS = 5 * 60 * 1000
const AUTH_RESET_AFTER_MS = 15 * 60 * 1000
const SESSION_DETAIL_PAGE_LIMIT = 500
const SEARCH_MESSAGE_PAGE_LIMIT = 250
const CSRF_COOKIE = 'dm_csrf'
const CSRF_HEADER = 'x-dm-csrf'
const authAttempts = new Map<AuthMethod, AuthAttemptState>()
let activeSession: { token: string; flow: SessionFlow; idleMs: number; expiresAt: number } | null = null
let pendingAuth: { token: string; flow: SessionFlow; helperSessionId: string; expiresAt: number } | null = null
let pendingSetup: PendingSetupState | null = null
let pendingSetupInit: Promise<SetupInitPayload> | null = null

type SetupInitPayload = {
  setupNonce: string
  secret: string
  mnemonic: string
  qrDataUrl: string
  touchIdAvailable: boolean
  touchIdReason?: string
  bootstrapCapture: ReturnType<typeof bootstrapCaptureSummary>
}

function appVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function renderAboutMarkdown(markdown: string, version: string): string {
  return markdown
    .replace(/^# DataMoat(?: v[^\n]+)?$/m, '# DataMoat')
    .replace(/badge\/version-[^-]+-0F766E\?style=flat-square/gi, `badge/version-${version}-0F766E?style=flat-square`)
}

export function hasAuthenticatedUiSession(): boolean {
  return !!activeSession && activeSession.expiresAt > Date.now() && hasVaultSession()
}

function authMethodLabel(method: AuthMethod): string {
  switch (method) {
    case 'password': return 'password'
    case 'totp': return 'authenticator'
    case 'recovery_code': return 'recovery code'
    case 'mnemonic': return 'recovery phrase'
    case 'touchid': return 'Touch ID'
  }
}

function passwordRequirementError(password: string): string | null {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters'
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain uppercase, lowercase, and a number'
  }
  return null
}

async function setupInitPayload(): Promise<SetupInitPayload> {
  if (pendingSetupInit) return pendingSetupInit

  pendingSetupInit = (async () => {
    let initialized = false
    if (!pendingSetup) {
      pendingSetup = {
        nonce: crypto.randomBytes(24).toString('hex'),
        secret: generateTOTPSecret(),
        mnemonic: generateMnemonic(),
        qrDataUrl: '',
        createdAt: Date.now(),
      }
      initialized = true
    }

    const setup = pendingSetup
    const [qrDataUrl, touchIdStatus] = await Promise.all([
      setup.qrDataUrl ? Promise.resolve(setup.qrDataUrl) : QRCode.toDataURL(totpURL(setup.secret)),
      secureEnclaveStatus(),
    ])
    if (pendingSetup?.nonce === setup.nonce && !pendingSetup.qrDataUrl) {
      pendingSetup = { ...pendingSetup, qrDataUrl }
    }
    if (initialized) {
      writeAuditEvent('setup', 'setup_initialized', {
        touchIdAvailable: touchIdStatus.available,
        totpProvisioned: true,
      })
    }
    return {
      setupNonce: setup.nonce,
      secret: setup.secret,
      mnemonic: setup.mnemonic,
      qrDataUrl,
      touchIdAvailable: touchIdStatus.available,
      touchIdReason: touchIdStatus.reason,
      bootstrapCapture: bootstrapCaptureSummary(),
    }
  })()

  try {
    return await pendingSetupInit
  } finally {
    pendingSetupInit = null
  }
}

function recoveryUnlockFlow(flow: SessionFlow | null | undefined): flow is 'recovery_code' | 'mnemonic' {
  return flow === 'recovery_code' || flow === 'mnemonic'
}

async function touchIdUpgradeAvailable(config: LoadedAuthConfig | null): Promise<boolean> {
  if (!config) return false
  if (config.touchIdEnabled || config.touchIdWrappedVaultKey) return false
  return (await secureEnclaveStatus()).available
}

function authState(method: AuthMethod): AuthAttemptState {
  const now = Date.now()
  const current = authAttempts.get(method)
  if (!current || now - current.lastFailureAt > AUTH_RESET_AFTER_MS) {
    const fresh: AuthAttemptState = {
      failures: 0,
      blockedUntil: 0,
      lastFailureAt: 0,
      lastFailureReason: '',
    }
    authAttempts.set(method, fresh)
    return fresh
  }
  return current
}

function authBlockRemainingMs(method: AuthMethod): number {
  const remaining = authState(method).blockedUntil - Date.now()
  return remaining > 0 ? remaining : 0
}

function formatRetryDelay(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`
  return `${Math.ceil(ms / 60_000)}m`
}

function ensureAuthAllowed(method: AuthMethod, res: Response): boolean {
  const remaining = authBlockRemainingMs(method)
  if (remaining <= 0) return true
  res.status(429).json({
    error: `Too many ${authMethodLabel(method)} attempts. Try again in ${formatRetryDelay(remaining)}.`,
  })
  return false
}

function clearAuthAttempts(methods?: AuthMethod[]): void {
  if (!methods) {
    authAttempts.clear()
    return
  }
  for (const method of methods) authAttempts.delete(method)
}

function recordAuthFailure(method: AuthMethod, reason: string): void {
  const state = authState(method)
  state.failures += 1
  state.lastFailureAt = Date.now()
  state.lastFailureReason = reason
  const retryAfterMs = Math.min(
    AUTH_BACKOFF_BASE_MS * (2 ** Math.max(0, state.failures - 1)),
    AUTH_BACKOFF_MAX_MS,
  )
  state.blockedUntil = state.lastFailureAt + retryAfterMs
  authAttempts.set(method, state)

  writeLog('warn', 'auth', 'unlock_failed', {
    method,
    reason,
    failures: state.failures,
    retryAfterMs,
  })
  updateHealth('auth', {
    lastFailedAt: new Date(state.lastFailureAt).toISOString(),
    lastFailureMethod: method,
    lastFailureReason: reason,
    consecutiveFailures: state.failures,
    retryAfterMs,
  })
  writeAuditEvent('auth', 'unlock_failed', {
    method,
    reason,
    failures: state.failures,
    retryAfterMs,
  })
}

function recordAuthSuccess(method: AuthMethod): void {
  authAttempts.delete(method)
  writeLog('info', 'auth', 'unlock_succeeded', { method })
  updateHealth('auth', {
    lastSuccessAt: new Date().toISOString(),
    lastSuccessMethod: method,
    retryAfterMs: 0,
  })
  writeAuditEvent('auth', 'unlock_succeeded', { method })
}

function readCookie(req: Request, name: string): string | null {
  const cookie = req.headers.cookie ?? ''
  const match = cookie.match(new RegExp(`${name}=([a-f0-9]+)`))
  return match?.[1] ?? null
}

function appendCookieHeader(res: Response, cookie: string): void {
  const existing = res.getHeader('Set-Cookie')
  if (!existing) {
    res.setHeader('Set-Cookie', cookie)
    return
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie])
    return
  }
  res.setHeader('Set-Cookie', [String(existing), cookie])
}

function issueCsrfCookie(res: Response): string {
  const token = crypto.randomBytes(24).toString('hex')
  appendCookieHeader(res, `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict`)
  return token
}

function isMutatingMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

function sameHostRequest(req: Request, candidate?: string | null): boolean {
  if (!candidate) return false
  const host = req.headers.host?.toLowerCase()
  if (!host) return false
  try {
    const parsed = new URL(candidate)
    return parsed.host.toLowerCase() === host && ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function isSameOriginApiRequest(req: Request): boolean {
  const origin = req.get('origin')
  if (!origin) {
    const referrer = req.get('referer')
    return sameHostRequest(req, referrer)
  }
  return sameHostRequest(req, origin)
}

function safeMatchCookieSecret(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return crypto.timingSafeEqual(aBuf, bBuf)
}

function requireApiCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!isMutatingMethod(req.method)) return next()

  if (!isSameOriginApiRequest(req)) {
    writeLog('warn', 'http', 'api_request_blocked_origin', {
      method: req.method,
      path: req.path,
      origin: req.get('origin') || null,
      referer: req.get('referer') || null,
    })
    res.status(403).json({ error: 'request blocked by origin policy' })
    return
  }

  const cookieToken = readCookie(req, CSRF_COOKIE)
  const headerToken = req.get(CSRF_HEADER)
  if (!cookieToken || !headerToken || !safeMatchCookieSecret(cookieToken, headerToken)) {
    writeLog('warn', 'http', 'api_request_blocked_csrf', {
      method: req.method,
      path: req.path,
      hasCookieToken: !!cookieToken,
      hasHeaderToken: !!headerToken,
    })
    res.status(403).json({ error: 'csrf token missing or invalid' })
    return
  }

  next()
}

function isAuthenticated(req: Request): boolean {
  return !!activeSession
    && activeSession.expiresAt > Date.now()
    && hasVaultSession()
    && readCookie(req, 'dm_session') === activeSession.token
}

function denyAuth(req: Request, res: Response): void {
  if (req.path.startsWith('/api/')) {
    res.status(401).json({ error: 'auth required' })
    return
  }
  res.redirect(isSetupDone() ? '/unlock' : '/setup')
}

async function lockVault(res?: Response): Promise<void> {
  const activeHelperSessionId = getVaultSessionId()
  const captureHelperSessionId = getCaptureSessionId()
  const pendingHelperSessionId = pendingAuth?.helperSessionId ?? null
  pendingAuth = null
  activeSession = null
  clearVaultSession()
  if (!captureHelperSessionId) await stopWatchers()
  await Promise.allSettled(
    [activeHelperSessionId, pendingHelperSessionId]
      .filter((value): value is string => !!value)
      .map(sessionId => lockVaultSession(sessionId)),
  )
  updateHealth('daemon', {
    locked: true,
    lastLockedAt: new Date().toISOString(),
    captureRunning: !!captureHelperSessionId,
  })
  writeAuditEvent('vault', 'vault_locked', {
    activeSessionPresent: !!activeHelperSessionId,
    pendingSessionPresent: !!pendingHelperSessionId,
    captureSessionPresent: !!captureHelperSessionId,
  })
  if (res) {
    res.append('Set-Cookie', 'dm_pending=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
    res.append('Set-Cookie', 'dm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  }
}

function refreshSession(): boolean {
  if (!activeSession || activeSession.expiresAt <= Date.now()) return false
  activeSession.expiresAt = Date.now() + activeSession.idleMs
  return true
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (activeSession && activeSession.expiresAt <= Date.now()) {
    await lockVault(res)
    denyAuth(req, res)
    return
  }
  if (activeSession && !hasVaultSession()) {
    await lockVault(res)
    denyAuth(req, res)
    return
  }
  if (isAuthenticated(req)) { next(); return }
  denyAuth(req, res)
}

async function activateVault(
  helperSessionId: string,
  options: {
    skipBackgroundCaptureSetup?: boolean
    skipBackgroundCaptureStart?: boolean
    skipWatcherStart?: boolean
    suppressCaptureWarning?: boolean
  } = {},
): Promise<{ backgroundConfigured: boolean; backgroundStarted: boolean; captureWarning: string | null }> {
  writeLog('info', 'auth', 'activate_vault_started', {
    skipBackgroundCaptureSetup: !!options.skipBackgroundCaptureSetup,
    skipBackgroundCaptureStart: !!options.skipBackgroundCaptureStart,
    skipWatcherStart: !!options.skipWatcherStart,
    suppressCaptureWarning: !!options.suppressCaptureWarning,
  })
  setVaultSession(helperSessionId)
  writeLog('info', 'auth', 'activate_vault_step', { step: 'auth_config_migration_start' })
  await migrateAuthConfigProtectedFields(helperSessionId)
  writeLog('info', 'auth', 'activate_vault_step', { step: 'auth_config_migration_done' })
  let backgroundConfigured = false
  if (!options.skipBackgroundCaptureSetup) {
    try {
      backgroundConfigured = await ensureBackgroundCaptureConfigured(helperSessionId)
    } catch (error) {
      writeLog('warn', 'capture', 'background_capture_config_failed', { error })
      updateHealth('capture', {
        configured: false,
        running: false,
        lastErrorAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      })
      writeAuditEvent('capture', 'background_capture_config_failed')
    }
  } else {
    writeLog('info', 'capture', 'background_capture_config_skipped', {
      reason: 'recovery_unlock',
    })
  }
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_vault_files_start' })
  await encryptVaultFiles()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_vault_files_done' })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_attachment_files_start' })
  await encryptAttachmentFiles()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_attachment_files_done' })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_state_files_start' })
  await encryptStateFiles()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_state_files_done' })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'bootstrap_import_start' })
  const bootstrapImport = await importBootstrapCaptureIntoVault()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'bootstrap_import_done', ...bootstrapImport })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'state_migration_start' })
  const stateMigration = await migrateStateStorage()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'state_migration_done', ...stateMigration })
  if (stateMigration.offsetsMigrated || stateMigration.sessionsMigrated) {
    updateHealth('storage', {
      lastMigratedAt: new Date().toISOString(),
      offsetsMigrated: stateMigration.offsetsMigrated,
      sessionsMigrated: stateMigration.sessionsMigrated,
    })
    writeAuditEvent('storage', 'state_storage_migrated', stateMigration)
  }
  let backgroundStarted = false
  if (options.skipBackgroundCaptureStart) {
    writeLog('info', 'capture', 'background_capture_start_skipped', {
      reason: 'recovery_unlock',
    })
  } else {
    writeLog('info', 'auth', 'activate_vault_step', { step: 'background_start_start' })
    backgroundStarted = await startBackgroundCapture()
    writeLog('info', 'auth', 'activate_vault_step', { step: 'background_start_done', backgroundStarted })
  }
  if (!backgroundStarted && !options.skipWatcherStart) {
    writeLog('info', 'auth', 'activate_vault_step', { step: 'watchers_start_start' })
    await startWatchers('vault')
    writeLog('info', 'auth', 'activate_vault_step', { step: 'watchers_start_done' })
  } else if (!backgroundStarted && options.skipWatcherStart) {
    writeLog('info', 'auth', 'activate_vault_step', { step: 'watchers_start_deferred' })
  }
  updateHealth('daemon', {
    locked: false,
    unlockedAt: new Date().toISOString(),
    captureRunning: backgroundStarted,
    bootstrapImportedFiles: bootstrapImport.importedFiles,
    bootstrapImportedMessages: bootstrapImport.importedMessages,
    bootstrapRemainingFiles: bootstrapImport.remainingFiles,
  })
  updateHealth('capture', {
    configured: backgroundConfigured,
    running: backgroundStarted,
  })
  writeAuditEvent('vault', 'vault_activated', {
    ...stateMigration,
    backgroundConfigured,
    backgroundStarted,
    bootstrapImportedFiles: bootstrapImport.importedFiles,
    bootstrapImportedMessages: bootstrapImport.importedMessages,
    bootstrapRemainingFiles: bootstrapImport.remainingFiles,
  })
  const captureWarning = options.suppressCaptureWarning
    ? null
    : backgroundStarted
    ? null
    : 'Background capture is unavailable right now on this install. DataMoat will continue capturing only while the vault stays unlocked until the local OS secret store becomes available again.'
  return { backgroundConfigured, backgroundStarted, captureWarning }
}

async function restoreBackgroundCaptureAfterRecoveryReset(
  helperSessionId: string,
  flow: Extract<SessionFlow, 'recovery_code' | 'mnemonic'>,
): Promise<{ backgroundConfigured: boolean; backgroundStarted: boolean; captureWarning: string | null }> {
  const config = loadAuthConfig()
  const hasStoredConfig = !!config?.backgroundWrappedVaultKey && !!config.backgroundWrapSalt
  const captureSessionPresent = !!getCaptureSessionId()

  try {
    let backgroundConfigured = hasStoredConfig
    if (!captureSessionPresent) {
      backgroundConfigured = await ensureBackgroundCaptureConfigured(helperSessionId, {
        forceReconfigure: true,
        reason: `recovery_password_reset:${flow}`,
      })
    } else if (!hasStoredConfig) {
      backgroundConfigured = await ensureBackgroundCaptureConfigured(helperSessionId, {
        forceReconfigure: true,
        reason: `recovery_password_reset:${flow}`,
      })
    }

    const backgroundStarted = captureSessionPresent || await startBackgroundCapture()
    updateHealth('capture', {
      configured: backgroundConfigured,
      running: backgroundStarted,
      lastRecoveryResetRestoreAt: new Date().toISOString(),
    })
    writeAuditEvent('capture', 'background_capture_restore_after_recovery_reset', {
      flow,
      backgroundConfigured,
      backgroundStarted,
    })

    return {
      backgroundConfigured,
      backgroundStarted,
      captureWarning: backgroundStarted
        ? null
        : 'Background capture could not be restored automatically after recovery. DataMoat will keep capturing only while the vault stays unlocked until the local OS secret store becomes available again.',
    }
  } catch (error) {
    writeLog('warn', 'capture', 'background_capture_restore_after_recovery_reset_failed', {
      flow,
      error,
    })
    updateHealth('capture', {
      configured: false,
      running: false,
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
      lastRecoveryResetRestoreAt: new Date().toISOString(),
    })
    writeAuditEvent('capture', 'background_capture_restore_after_recovery_reset_failed', {
      flow,
    })
    return {
      backgroundConfigured: false,
      backgroundStarted: false,
      captureWarning: 'Background capture could not be restored automatically after recovery. DataMoat will keep capturing only while the vault stays unlocked until the local OS secret store becomes available again.',
    }
  }
}

function activationResponse(
  result: Awaited<ReturnType<typeof activateVault>>,
  extras: Record<string, unknown> = {},
): { ok: true; captureWarning?: string } & Record<string, unknown> {
  const base = result.captureWarning
    ? { ok: true as const, captureWarning: result.captureWarning }
    : { ok: true as const }
  return { ...base, ...extras }
}

async function activateVaultForSetup(helperSessionId: string): Promise<Awaited<ReturnType<typeof activateVault>>> {
  return activateVault(helperSessionId, {
    suppressCaptureWarning: true,
  })
}

async function sendJson(res: Response, status: number, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload)
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))
  await new Promise<void>(resolve => {
    res.end(body, () => resolve())
  })
}

function issueSession(res: Response, flow: SessionFlow): void {
  const idleMs = SESSION_IDLE_MS[flow]
  activeSession = {
    token: crypto.randomBytes(32).toString('hex'),
    flow,
    idleMs,
    expiresAt: Date.now() + idleMs,
  }
  res.append('Set-Cookie', `dm_session=${activeSession.token}; HttpOnly; SameSite=Strict; Path=/`)
}

function beginPendingAuth(helperSessionId: string, flow: SessionFlow, res: Response): void {
  const token = crypto.randomBytes(32).toString('hex')
  pendingAuth = {
    token,
    flow,
    helperSessionId,
    expiresAt: Date.now() + 2 * 60 * 1000,
  }
  res.append('Set-Cookie', `dm_pending=${token}; HttpOnly; SameSite=Strict; Path=/`)
}

function clearPendingAuth(res: Response): void {
  pendingAuth = null
  res.append('Set-Cookie', 'dm_pending=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
}

function hasValidPending(req: Request): boolean {
  return !!pendingAuth
    && pendingAuth.expiresAt > Date.now()
    && readCookie(req, 'dm_pending') === pendingAuth.token
}

async function loadLegacyVaultKey(config: NonNullable<ReturnType<typeof loadAuthConfig>>): Promise<string | null> {
  void config
  return null
}

async function encryptTotpSecretForSession(helperSessionId: string, secret: string): Promise<string> {
  const encrypted = await encryptBytesForSession(helperSessionId, Buffer.from(secret, 'utf8'))
  return encrypted.toString('base64')
}

async function decryptTotpSecretForSession(helperSessionId: string, blob: string): Promise<string> {
  const decrypted = await decryptBytesForSession(helperSessionId, Buffer.from(blob, 'base64'))
  return decrypted.toString('utf8')
}

async function migrateAuthConfigProtectedFields(helperSessionId: string): Promise<void> {
  const config = loadAuthConfig()
  if (!config) return

  const originalSchemaVersion = config.schemaVersion ?? 1
  const migratedFields: string[] = []

  if (config.totpEnrolled && config.totpSecret && !config.totpWrappedSecret) {
    config.totpWrappedSecret = await encryptTotpSecretForSession(helperSessionId, config.totpSecret)
    delete config.totpSecret
    migratedFields.push('totpWrappedSecret')
  }

  if (!config.totpEnrolled && (config.totpSecret || config.totpWrappedSecret)) {
    delete config.totpSecret
    delete config.totpWrappedSecret
    migratedFields.push('clearedTotpSecret')
  }

  if (originalSchemaVersion < AUTH_SCHEMA_VERSION) {
    migratedFields.push('schemaVersion')
  }

  if (migratedFields.length === 0) return

  saveAuthConfig(config)
  updateHealth('auth', {
    schemaVersion: AUTH_SCHEMA_VERSION,
    lastMigratedAt: new Date().toISOString(),
    migratedFields,
    totpWrapped: !!config.totpWrappedSecret,
  })
  writeAuditEvent('auth', 'auth_config_migrated', {
    fromSchemaVersion: originalSchemaVersion,
    toSchemaVersion: AUTH_SCHEMA_VERSION,
    migratedFields,
  })
}

async function loadTotpSecretForSession(config: LoadedAuthConfig, helperSessionId: string): Promise<string | null> {
  if (config.totpWrappedSecret) {
    return await decryptTotpSecretForSession(helperSessionId, config.totpWrappedSecret)
  }
  if (config.totpSecret) return config.totpSecret
  return null
}

async function unlockWithPassword(config: LoadedAuthConfig, password: string): Promise<string | null> {
  if (config.passwordWrappedVaultKey && config.passwordWrapSalt) {
    return await unwrapSecretToSession(password, config.passwordWrapSalt, config.passwordWrappedVaultKey)
  }
  return loadLegacyVaultKey(config)
}

async function unlockWithMnemonic(config: LoadedAuthConfig, mnemonic: string): Promise<string | null> {
  if (config.mnemonicWrappedVaultKey && config.mnemonicWrapSalt) {
    return await unwrapSecretToSession(normalizeMnemonic(mnemonic), config.mnemonicWrapSalt, config.mnemonicWrappedVaultKey)
  }
  return loadLegacyVaultKey(config)
}

async function unlockWithRecoveryCode(config: LoadedAuthConfig, recoveryCode: string, idx: number): Promise<string | null> {
  if (config.recoveryWrappedVaultKeys?.[idx] && config.recoveryWrapSalts?.[idx]) {
    return await unwrapSecretToSession(normalizeRecoveryCode(recoveryCode), config.recoveryWrapSalts[idx], config.recoveryWrappedVaultKeys[idx])
  }
  return loadLegacyVaultKey(config)
}

async function unlockWithTouchId(config: LoadedAuthConfig): Promise<string | null> {
  if (config.touchIdWrappedVaultKey) {
    return await unwrapTouchIdToSession(config.touchIdWrappedVaultKey)
  }
  return loadLegacyVaultKey(config)
}

export async function startUIServer(): Promise<{ port: number; url: string }> {
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    const host = req.headers.host ?? 'localhost'
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        `connect-src 'self' http://${host}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    )
    issueCsrfCookie(res)
    next()
  })
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    next()
  })
  app.use('/api', requireApiCsrf)
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))

  app.get('/api/meta', (_req, res) => {
    res.json({ pid: process.pid, route: isSetupDone() ? 'unlock' : 'setup' })
  })

  // ── Setup (first run only) ─────────────────────────────────────────────────

  app.get('/setup', (_req, res) => {
    if (isSetupDone()) return res.redirect('/unlock')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.send(setupPageHTML())
  })

  app.post('/api/setup/init', async (_req, res) => {
    if (isSetupDone()) return res.json({ error: 'already setup' })
    res.json(await setupInitPayload())
  })

  app.post('/api/setup/reset', (_req, res) => {
    pendingSetup = null
    writeAuditEvent('setup', 'setup_reset')
    res.json({ ok: true })
  })

  app.post('/api/setup/prepare', async (req, res) => {
    if (isSetupDone()) return res.json({ error: 'already setup' })
    const { setupNonce, password, passwordEnabled, touchIdEnabled, totpToken } = req.body as {
      setupNonce?: string; password?: string; passwordEnabled?: boolean; touchIdEnabled?: boolean; totpToken?: string
    }
    if (!pendingSetup || !setupNonce || setupNonce !== pendingSetup.nonce) {
      return res.status(400).json({ error: 'Setup expired. Restart from step 1.' })
    }
    const wantsPassword = !!passwordEnabled
    const wantsTouchId = !!touchIdEnabled
    const touchIdStatus = await secureEnclaveStatus()
    const touchIdAvailable = touchIdStatus.available
    if (!wantsPassword && !wantsTouchId) {
      return res.status(400).json({ error: 'Choose at least one unlock method' })
    }
    if (!touchIdAvailable && !wantsPassword) {
      return res.status(400).json({ error: 'Password is required on this build' })
    }
    if (wantsPassword) {
      const passwordError = passwordRequirementError(password || '')
      if (passwordError) {
        return res.status(400).json({ error: passwordError })
      }
    }
    if (wantsTouchId) {
      if (!IS_MAC) return res.status(400).json({ error: 'Touch ID requires macOS' })
      if (!touchIdAvailable) {
        return res.status(400).json({ error: touchIdStatus.reason || 'Touch ID / Secure Enclave is not available on this Mac' })
      }
    }
    const totpEnrolled = !!totpToken
    if (totpEnrolled && !verifyTOTP(pendingSetup.secret, totpToken.trim())) {
      return res.status(400).json({ error: 'Invalid TOTP code — try again' })
    }
    const { plain, hashed } = generateRecoveryCodes()
    pendingSetup = {
      ...pendingSetup,
      passwordEnabled: wantsPassword,
      touchIdEnabled: wantsTouchId,
      password: wantsPassword ? password : undefined,
      totpEnrolled,
      recoveryPlain: plain,
      recoveryHashed: hashed,
    }
    writeAuditEvent('setup', 'recovery_material_prepared', {
      passwordEnabled: wantsPassword,
      touchIdEnabled: wantsTouchId,
      totpEnrolled,
    })
    res.json({ recoveryCodes: plain })
  })

  app.post('/api/setup/activate', async (req, res) => {
    if (isSetupDone()) return res.json({ error: 'already setup' })
    const { setupNonce } = req.body as { setupNonce?: string }
    if (!pendingSetup || !setupNonce || setupNonce !== pendingSetup.nonce) {
      return res.status(400).json({ error: 'Setup expired. Restart from step 1.' })
    }
    if (!pendingSetup.recoveryPlain || !pendingSetup.recoveryHashed) {
      return res.status(400).json({ error: 'Complete the recovery steps before activation.' })
    }

    const wantsPassword = !!pendingSetup.passwordEnabled
    const wantsTouchId = !!pendingSetup.touchIdEnabled
    let helperSessionId: string | null = null

    try {
      const touchIdStatus = await secureEnclaveStatus()
      if (wantsTouchId && !touchIdStatus.available) {
        return res.status(400).json({ error: touchIdStatus.reason || 'Touch ID + Secure Enclave is unavailable in this build.' })
      }
      helperSessionId = await createVaultSession()
      const authRecord: Parameters<typeof saveAuthConfig>[0] = {
        setupComplete: false,
        passwordEnabled: wantsPassword,
        touchIdEnabled: wantsTouchId,
        totpEnrolled: !!pendingSetup.totpEnrolled,
        mnemonicHash: sha256(normalizeMnemonic(pendingSetup.mnemonic)),
        recoveryCodes: pendingSetup.recoveryHashed,
        setupAt: new Date().toISOString(),
      }

      if (pendingSetup.totpEnrolled) {
        authRecord.totpWrappedSecret = await encryptTotpSecretForSession(helperSessionId, pendingSetup.secret)
      }

      if (wantsPassword && pendingSetup.password) {
        const wrapped = await wrapSecretForSession(helperSessionId, pendingSetup.password)
        authRecord.passwordHash = await hashPassword(pendingSetup.password)
        authRecord.passwordWrappedVaultKey = wrapped.blob
        authRecord.passwordWrapSalt = wrapped.salt
      }
      if (wantsTouchId) authRecord.touchIdWrappedVaultKey = await wrapTouchIdForSession(helperSessionId)

      const mnemonicWrapped = await wrapSecretForSession(helperSessionId, normalizeMnemonic(pendingSetup.mnemonic))
      authRecord.mnemonicWrappedVaultKey = mnemonicWrapped.blob
      authRecord.mnemonicWrapSalt = mnemonicWrapped.salt

      const recoveryWrapped = await Promise.all(
        pendingSetup.recoveryPlain.map(code => wrapSecretForSession(helperSessionId!, normalizeRecoveryCode(code))),
      )
      authRecord.recoveryWrappedVaultKeys = recoveryWrapped.map(item => item.blob)
      authRecord.recoveryWrapSalts = recoveryWrapped.map(item => item.salt)

      saveAuthConfig(authRecord)
      const activation = await activateVaultForSetup(helperSessionId)
      saveAuthConfig({
        ...(loadAuthConfig() || {}),
        ...authRecord,
        setupComplete: true,
      })
      issueSession(res, wantsTouchId ? 'touchid' : 'password')
      writeAuditEvent('setup', 'setup_activated', {
        passwordEnabled: wantsPassword,
        touchIdEnabled: wantsTouchId,
        totpEnrolled: !!pendingSetup.totpEnrolled,
      })
      pendingSetup = null
      res.json(activationResponse(activation))
    } catch {
      const backgroundKeychainAccount = loadAuthConfig()?.backgroundKeychainAccount
      await lockVault()
      await stopBackgroundCapture()
      if (backgroundKeychainAccount) {
        await backgroundCaptureSecretDelete(backgroundKeychainAccount)
      }
      if (backgroundKeychainAccount !== 'backgroundCaptureSecret') {
        await backgroundCaptureSecretDelete()
      }
      deleteAuthConfig()
      res.status(500).json({ error: 'Could not activate vault' })
    }
  })

  // ── Unlock ─────────────────────────────────────────────────────────────────

  app.get('/unlock', async (req, res) => {
    if (!isSetupDone()) return res.redirect('/setup')
    if (activeSession && activeSession.expiresAt <= Date.now()) await lockVault(res)
    if (activeSession && !hasVaultSession()) await lockVault(res)
    if (isAuthenticated(req)) return res.redirect('/')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.send(unlockPageHTML())
  })

  app.get('/api/auth/options', async (_req, res) => {
    const config = loadAuthConfig()
    if (!config) return res.status(404).json({ error: 'config missing' })
    res.json({
      passwordEnabled: !!(config.passwordEnabled ?? config.passwordHash),
      touchIdEnabled: !!(config.touchIdEnabled || config.touchIdWrappedVaultKey) && await secureEnclaveAvailable(),
      totpEnrolled: !!config.totpEnrolled,
    })
  })

  app.get('/api/auth/touchid-upgrade', requireAuth, async (_req, res) => {
    const config = loadAuthConfig()
    if (!config) return res.status(404).json({ error: 'config missing' })
    const touchIdStatus = await secureEnclaveStatus()
    res.json({
      available: !(config.touchIdEnabled || config.touchIdWrappedVaultKey) && touchIdStatus.available,
      reason: touchIdStatus.reason,
    })
  })

  app.post('/api/auth/touchid-upgrade', requireAuth, async (_req, res) => {
    const config = loadAuthConfig()
    if (!config) return res.status(404).json({ error: 'config missing' })
    if (config.touchIdEnabled || config.touchIdWrappedVaultKey) {
      return res.json({ ok: true, alreadyEnabled: true })
    }
    const touchIdStatus = await secureEnclaveStatus()
    if (!touchIdStatus.available) {
      return res.status(400).json({ error: touchIdStatus.reason || 'Touch ID + Secure Enclave is unavailable in this build.' })
    }
    const helperSessionId = getVaultSessionId()
    if (!helperSessionId) {
      return res.status(401).json({ error: 'Unlock the vault first, then try enabling Touch ID again.' })
    }
    try {
      config.touchIdEnabled = true
      config.touchIdWrappedVaultKey = await wrapTouchIdForSession(helperSessionId)
      saveAuthConfig(config)
      updateHealth('auth', {
        touchIdEnabled: true,
        touchIdEnabledAt: new Date().toISOString(),
      })
      writeAuditEvent('auth', 'touchid_enabled_post_setup')
      return res.json({ ok: true })
    } catch {
      return res.status(401).json({ error: 'Touch ID failed or was cancelled' })
    }
  })

  app.post('/api/auth/verify', async (req, res) => {
    writeLog('info', 'auth', 'verify_request_received', {
      hasPassword: typeof req.body?.password === 'string' && req.body.password.length > 0,
      hasTotpToken: typeof req.body?.totpToken === 'string' && req.body.totpToken.length > 0,
      hasRecoveryCode: typeof req.body?.recoveryCode === 'string' && req.body.recoveryCode.length > 0,
      hasMnemonic: typeof req.body?.mnemonic === 'string' && req.body.mnemonic.length > 0,
    })
    if (!isSetupDone()) return res.status(400).json({ error: 'not setup' })
    const config = loadAuthConfig()
    if (!config) return res.status(500).json({ error: 'config missing' })

    const { password, totpToken, recoveryCode, mnemonic } = req.body as {
      password?: string; totpToken?: string; recoveryCode?: string; mnemonic?: string
    }

    // Pending TOTP second step
    if (totpToken && !password) {
      if (!ensureAuthAllowed('totp', res)) return
      if (!hasValidPending(req) || !pendingAuth) {
        recordAuthFailure('totp', 'missing_pending_unlock')
        clearPendingAuth(res)
        return res.status(401).json({ error: 'No pending unlock request' })
      }
      let totpSecret: string | null = null
      try {
        totpSecret = await loadTotpSecretForSession(config, pendingAuth.helperSessionId)
      } catch {
        recordAuthFailure('totp', 'secret_unavailable')
        return res.status(500).json({ error: 'Authenticator secret unavailable' })
      }
      if (!totpSecret || !verifyTOTP(totpSecret, totpToken.trim())) {
        recordAuthFailure('totp', 'invalid_code')
        return res.status(401).json({ error: 'Invalid authenticator code' })
      }
      const helperSessionId = pendingAuth.helperSessionId
      const flow = pendingAuth.flow
      clearPendingAuth(res)
      try {
        const activation = await activateVault(helperSessionId)
        clearAuthAttempts()
        recordAuthSuccess('totp')
        issueSession(res, flow)
        return res.json(activationResponse(activation))
      } catch {
        await lockVault()
        recordAuthFailure('totp', 'activation_failed')
        return res.status(500).json({ error: 'Vault key unavailable' })
      }
    }

    // Recovery code — standalone, no password needed
    if (recoveryCode) {
      if (!ensureAuthAllowed('recovery_code', res)) return
      const idx = findRecoveryCodeIndex(config, recoveryCode)
      if (idx === -1) {
        recordAuthFailure('recovery_code', 'invalid_code')
        return res.status(401).json({ error: 'Invalid recovery code' })
      }
      try {
        writeLog('info', 'auth', 'recovery_code_unlock_started', { idx })
        const helperSessionId = await unlockWithRecoveryCode(config, recoveryCode, idx)
        writeLog('info', 'auth', 'recovery_code_unwrapped', { hasHelperSessionId: !!helperSessionId })
        if (!helperSessionId) return res.status(500).json({ error: 'Vault key unavailable' })
        const activation = await activateVault(helperSessionId, {
          skipBackgroundCaptureSetup: true,
          skipBackgroundCaptureStart: true,
          suppressCaptureWarning: true,
        })
        writeLog('info', 'auth', 'recovery_code_activation_complete', activation)
        consumeRecoveryCode(config, idx)
        clearAuthAttempts()
        recordAuthSuccess('recovery_code')
        issueSession(res, 'recovery_code')
        await sendJson(res, 200, activationResponse(activation, {
          passwordResetRecommended: true,
          passwordResetFlow: 'recovery_code',
        }))
        writeLog('info', 'auth', 'recovery_code_response_sent')
        return
      } catch (error) {
        writeLog('error', 'auth', 'recovery_code_unlock_exception', { error })
        await lockVault()
        recordAuthFailure('recovery_code', 'unlock_failed')
        return res.status(500).json({ error: 'Vault key unavailable' })
      }
    }

    // Mnemonic — standalone, no password needed
    if (mnemonic) {
      if (!ensureAuthAllowed('mnemonic', res)) return
      const hash = sha256(normalizeMnemonic(mnemonic))
      if (hash !== config.mnemonicHash) {
        recordAuthFailure('mnemonic', 'invalid_phrase')
        return res.status(401).json({ error: 'Invalid recovery phrase' })
      }
      try {
        writeLog('info', 'auth', 'mnemonic_unlock_started')
        const helperSessionId = await unlockWithMnemonic(config, mnemonic)
        writeLog('info', 'auth', 'mnemonic_unwrapped', { hasHelperSessionId: !!helperSessionId })
        if (!helperSessionId) return res.status(500).json({ error: 'Vault key unavailable' })
        const activation = await activateVault(helperSessionId, {
          skipBackgroundCaptureSetup: true,
          skipBackgroundCaptureStart: true,
          suppressCaptureWarning: true,
        })
        writeLog('info', 'auth', 'mnemonic_activation_complete', activation)
        clearAuthAttempts()
        recordAuthSuccess('mnemonic')
        issueSession(res, 'mnemonic')
        await sendJson(res, 200, activationResponse(activation, {
          passwordResetRecommended: true,
          passwordResetFlow: 'mnemonic',
        }))
        writeLog('info', 'auth', 'mnemonic_response_sent')
        return
      } catch (error) {
        writeLog('error', 'auth', 'mnemonic_unlock_exception', { error })
        await lockVault()
        recordAuthFailure('mnemonic', 'unlock_failed')
        return res.status(500).json({ error: 'Vault key unavailable' })
      }
    }

    // Password (required for normal login)
    if (!ensureAuthAllowed('password', res)) return
    if (!password) return res.status(400).json({ error: 'Password required' })
    if (!(config.passwordEnabled ?? !!config.passwordHash) || !config.passwordHash) {
      return res.status(400).json({ error: 'Password unlock is disabled for this vault' })
    }
    const passwordOk = await verifyPassword(password, config.passwordHash)
    if (!passwordOk) {
      recordAuthFailure('password', 'wrong_password')
      return res.status(401).json({ error: 'Wrong password' })
    }
    let helperSessionId: string | null = null
    try {
      helperSessionId = await unlockWithPassword(config, password)
    } catch {
      await lockVault()
      recordAuthFailure('password', 'unwrap_failed')
      return res.status(500).json({ error: 'Vault key unavailable' })
    }
    if (!helperSessionId) return res.status(500).json({ error: 'Vault key unavailable' })

    // If TOTP enrolled, also verify the TOTP token
    if (config.totpEnrolled) {
      await migrateAuthConfigProtectedFields(helperSessionId)
      clearAuthAttempts(['password'])
      beginPendingAuth(helperSessionId, 'password_totp', res)
      return res.json({ ok: false, needsTotp: true })
    }

    try {
      const activation = await activateVault(helperSessionId)
      clearAuthAttempts()
      recordAuthSuccess('password')
      issueSession(res, 'password')
      res.json(activationResponse(activation))
    } catch {
      await lockVault()
      recordAuthFailure('password', 'activation_failed')
      res.status(500).json({ error: 'Vault key unavailable' })
    }
  })

  app.post('/api/auth/reset-password', requireAuth, async (req, res) => {
    if (!activeSession || !recoveryUnlockFlow(activeSession.flow)) {
      return res.status(403).json({ error: 'Password reset from recovery is only available right after recovery unlock' })
    }
    const config = loadAuthConfig()
    if (!config) return res.status(500).json({ error: 'config missing' })

    const { password } = req.body as { password?: string }
    const passwordError = passwordRequirementError(password || '')
    if (passwordError) {
      return res.status(400).json({ error: passwordError })
    }

    const helperSessionId = getVaultSessionId()
    if (!helperSessionId) {
      return res.status(500).json({ error: 'Vault session unavailable' })
    }

    try {
      const resetFlow = activeSession.flow
      const wrapped = await wrapSecretForSession(helperSessionId, password!)
      config.passwordHash = await hashPassword(password!)
      config.passwordWrappedVaultKey = wrapped.blob
      config.passwordWrapSalt = wrapped.salt
      config.passwordEnabled = true
      saveAuthConfig(config)

      const captureRestore = await restoreBackgroundCaptureAfterRecoveryReset(helperSessionId, resetFlow)

      updateHealth('auth', {
        passwordEnabled: true,
        lastPasswordResetAt: new Date().toISOString(),
        lastPasswordResetFlow: resetFlow,
      })
      activeSession.flow = 'password'
      writeAuditEvent('auth', 'password_reset_after_recovery_unlock', {
        flow: resetFlow,
        backgroundConfigured: captureRestore.backgroundConfigured,
        backgroundStarted: captureRestore.backgroundStarted,
      })
      return res.json({
        ok: true,
        backgroundConfigured: captureRestore.backgroundConfigured,
        backgroundStarted: captureRestore.backgroundStarted,
        ...(captureRestore.captureWarning ? { captureWarning: captureRestore.captureWarning } : {}),
      })
    } catch (error) {
      writeLog('error', 'auth', 'password_reset_after_recovery_unlock_failed', {
        flow: activeSession.flow,
        error,
      })
      return res.status(500).json({ error: 'Password reset failed' })
    }
  })

  // ── Touch ID availability check (no prompt) ────────────────────────────────
  app.get('/api/auth/touchid-available', (_req, res) => {
    void secureEnclaveStatus().then(status => res.json(status))
  })

  app.post('/api/auth/touchid', async (_req, res) => {
    if (!isSetupDone()) return res.status(400).json({ error: 'not setup' })
    if (!ensureAuthAllowed('touchid', res)) return
    const config = loadAuthConfig()
    if (!config) return res.status(500).json({ error: 'config missing' })
    const touchIdStatus = await secureEnclaveStatus()
    if (!touchIdStatus.available) {
      return res.status(400).json({ error: touchIdStatus.reason || 'Touch ID + Secure Enclave is unavailable in this build.' })
    }
    if (!(config.touchIdEnabled || config.touchIdWrappedVaultKey)) {
      return res.status(400).json({ error: 'Touch ID unlock is disabled for this vault' })
    }
    try {
      const helperSessionId = await unlockWithTouchId(config)
      if (!helperSessionId) return res.status(500).json({ error: 'Vault key unavailable' })
      if (config.totpEnrolled) {
        await migrateAuthConfigProtectedFields(helperSessionId)
        clearAuthAttempts(['touchid'])
        beginPendingAuth(helperSessionId, 'touchid_totp', res)
        return res.json({ ok: false, needsTotp: true })
      }
      const activation = await activateVault(helperSessionId)
      clearAuthAttempts()
      recordAuthSuccess('touchid')
      issueSession(res, 'touchid')
      return res.json(activationResponse(activation))
    } catch {
      await lockVault()
      recordAuthFailure('touchid', 'touchid_failed_or_cancelled')
      return res.status(401).json({ error: 'Touch ID failed or was cancelled' })
    }
  })

  app.post('/api/auth/logout', async (_req, res) => {
    await lockVault(res)
    writeAuditEvent('auth', 'logout_completed')
    res.json({ ok: true })
  })

  app.post('/api/auth/ping', async (req, res) => {
    if (activeSession && activeSession.expiresAt <= Date.now()) {
      await lockVault(res)
      return res.status(401).json({ error: 'session expired' })
    }
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'auth required' })
    refreshSession()
    res.json({ ok: true, expiresAt: activeSession?.expiresAt ?? null, flow: activeSession?.flow ?? null })
  })

  // ── Protected API ──────────────────────────────────────────────────────────

  app.get('/api/sessions', requireAuth, async (_req, res) => {
    const sessions = await loadSessions()
    res.json(await normalizeSessionsForUI(sessions))
  })

  app.get('/api/session/:id', requireAuth, async (req, res) => {
    const sessions = await loadSessions()
    const session = sessions.find(s => (s.uid ?? s.id) === req.params.id)
    if (!session) return res.status(404).json({ error: 'not found' })
    const offset = positiveIntQuery(req.query.offset)
    const requestedLimit = positiveIntQuery(req.query.limit)
    const limit = requestedLimit > 0 ? Math.min(requestedLimit, SESSION_DETAIL_PAGE_LIMIT) : 0
    const messages = await readMessagesForUI(session, { offset, limit })
    const totalMessages = session.messageCount || messages.length
    res.json({
      session: normalizeSessionForUI(session, messages),
      messages,
      totalMessages,
      offset,
      limit,
      nextOffset: limit > 0 ? offset + messages.length : messages.length,
      hasMore: limit > 0 && offset + messages.length < totalMessages,
    })
  })

  app.get('/api/search', requireAuth, async (req, res) => {
    const startedAt = Date.now()
    const q = ((req.query.q as string) || '').toLowerCase().trim()
    if (!q || q.length < 2) return res.json([])
    const sessions = await loadSessions()
    const results: { id: string; excerpt: string }[] = []
    for (const session of sessions) {
      const excerpt = await findSearchExcerptForUI(session, q)
      if (excerpt) results.push({ id: session.uid ?? session.id, excerpt })
      if (results.length >= 50) break  // cap at 50 matches
    }
    updateHealth('search', {
      lastQuery: q,
      lastResultCount: results.length,
      lastDurationMs: Date.now() - startedAt,
      lastSessionCount: sessions.length,
      lastMatchedSessionIds: results.slice(0, 10).map(result => result.id),
      lastSearchedAt: new Date().toISOString(),
    })
    writeAuditEvent('search', 'search_completed', {
      query: q,
      resultCount: results.length,
      durationMs: Date.now() - startedAt,
      sessionCount: sessions.length,
      matchedSessionIds: results.slice(0, 10).map(result => result.id),
    })
    res.json(results)
  })

  app.get('/api/attachment/:id', requireAuth, async (req, res) => {
    try {
      const attachment = await readAttachment(req.params.id)
      if (!attachment) return res.status(404).json({ error: 'not found' })
      res.setHeader('Content-Type', attachment.mediaType)
      res.setHeader('Cache-Control', 'no-store')
      res.send(attachment.data)
    } catch {
      res.status(500).json({ error: 'attachment unavailable' })
    }
  })

  app.get('/api/status', requireAuth, async (_req, res) => {
    const sessions = await loadSessions()
    const bySource = sessions.reduce<Record<string, number>>((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1
      return acc
    }, {})
    res.json({ totalSessions: sessions.length, bySource, lastUpdate: sessions[0]?.lastTimestamp ?? null })
  })

  app.get('/api/update/settings', requireAuth, (_req, res) => {
    res.json({
      ...loadAppConfig(),
      appVersion: appVersion(),
      state: loadUpdateState(),
      reinstall: recordedReinstallSource(),
      releasesUrl: updateReleasesUrl(),
    })
  })

  app.post('/api/update/settings', requireAuth, (req, res) => {
    const { autoUpdateEnabled } = req.body as { autoUpdateEnabled?: boolean }
    if (typeof autoUpdateEnabled !== 'boolean') {
      return res.status(400).json({ error: 'autoUpdateEnabled must be boolean' })
    }
    const config = saveAppConfig({ autoUpdateEnabled })
    res.json({
      ...config,
      appVersion: appVersion(),
      state: loadUpdateState(),
      reinstall: recordedReinstallSource(),
      releasesUrl: updateReleasesUrl(),
    })
  })

  app.get('/api/update/status', requireAuth, (_req, res) => {
    res.json(loadUpdateState())
  })

  app.post('/api/update/check', requireAuth, (_req, res) => {
    const install = detectInstallContext()
    if (install.updateStrategy === 'packaged-auto-update') {
      return res.status(400).json({ error: 'packaged app updates must be checked from the DataMoat desktop app window' })
    }
    const checkedAt = new Date().toISOString()
    const status = checkForUpdate()
    if (!status.supported) {
      return res.json(writeUpdateState({
        running: isUpdateRunning(),
        lastCheckedAt: checkedAt,
        lastResult: 'unsupported',
        message: status.reason,
        installMode: status.mode,
        updateStrategy: status.strategy,
        supported: false,
        currentVersion: null,
        branch: null,
        remote: null,
        ahead: null,
        behind: null,
        clean: null,
      }))
    }

    const reason = updateBlockReason(status)
    const isCurrent = reason === 'already up to date'
    const lastResult = status.behind > 0 && !reason
      ? 'available'
      : isCurrent
        ? 'up-to-date'
        : 'blocked'

    const message = !reason
      ? `${status.behind} update${status.behind === 1 ? '' : 's'} available on origin/${status.branch}`
      : reason

    res.json(writeUpdateState({
      running: isUpdateRunning(),
      lastCheckedAt: checkedAt,
      lastResult,
      message,
      installMode: status.mode,
      updateStrategy: status.strategy,
      supported: true,
      currentVersion: status.current,
      branch: status.branch,
      remote: status.remote,
      ahead: status.ahead,
      behind: status.behind,
      clean: status.clean,
    }))
  })

  app.post('/api/update/apply', requireAuth, (_req, res) => {
    const install = detectInstallContext()
    if (install.updateStrategy === 'packaged-auto-update') {
      return res.status(400).json({ error: 'packaged app updates must be installed from the DataMoat desktop app window' })
    }
    if (isUpdateRunning()) {
      return res.status(409).json({ error: 'update already running', state: loadUpdateState() })
    }
    if (!triggerDetachedUpdate('manual')) {
      return res.status(500).json({ error: 'could not start update worker' })
    }
    res.json(writeUpdateState({
      running: true,
      lastResult: 'checking',
      message: 'starting update worker',
    }))
  })

  app.post('/api/update/reinstall', requireAuth, (req, res) => {
    if (isUpdateRunning()) {
      return res.status(409).json({ error: 'another maintenance task is already running', state: loadUpdateState() })
    }

    const { sourcePath, confirmReinstall, confirmText } = req.body as {
      sourcePath?: string
      confirmReinstall?: boolean
      confirmText?: string
    }
    if (confirmReinstall !== true || confirmText !== 'REINSTALL') {
      return res.status(400).json({ error: 'source reinstall requires explicit confirmation' })
    }
    const source = inspectReinstallSource(sourcePath ?? recordedReinstallSource().root)
    if (!source.available || !source.root) {
      return res.status(400).json({ error: source.reason || 'source reinstall is not available' })
    }
    if (!triggerDetachedReinstall(source.root)) {
      return res.status(500).json({ error: 'could not start reinstall worker' })
    }

    res.json({
      source,
      state: writeUpdateState({
        running: true,
        lastResult: 'updating',
        message: source.liveCheckout
          ? `starting reinstall from live git checkout: ${source.root}`
          : `starting reinstall from recorded source snapshot: ${source.root}`,
      }),
    })
  })

  app.post('/api/update/install-latest', requireAuth, async (_req, res) => {
    try {
      const { default: open } = await import('open')
      const releasesUrl = updateReleasesUrl()
      await open(releasesUrl)
      res.json({ ok: true, url: releasesUrl })
    } catch {
      res.status(500).json({ error: 'could not open the latest release page' })
    }
  })

  // ── About / README ─────────────────────────────────────────────────────────

  app.get('/about', requireAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    const publicReadmePath = path.join(__dirname, '..', '..', 'README.public.md')
    const readmePath = fs.existsSync(publicReadmePath)
      ? publicReadmePath
      : path.join(__dirname, '..', '..', 'README.md')
    try {
      const version = appVersion()
      const md = renderAboutMarkdown(require('fs').readFileSync(readmePath, 'utf8'), version)
      res.send(markdownPageHTML('About', md, version))
    } catch {
      res.status(404).send('README not found')
    }
  })

  app.get('/security-model', requireAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.redirect('/about')
  })

  // ── Main UI ────────────────────────────────────────────────────────────────

  app.get('/', requireAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    res.sendFile(path.join(__dirname, 'index.html'))
  })

  const port = await findFreePort(UI_PORT_RANGE.min, UI_PORT_RANGE.max)
  await new Promise<void>(resolve => {
    const server = app.listen(port, '127.0.0.1', resolve)
    server.on('error', (err) => { throw err })
  })

  const bootstrap = loadBootstrapCaptureState()
  if (!isSetupDone() && bootstrap) {
    if (await preflightBootstrapCapture()) {
      await startWatchers('bootstrap')
      updateHealth('daemon', {
        bootstrapCapture: true,
        bootstrapCaptureRequestedBy: bootstrap.requestedBy,
        bootstrapCaptureStartedAt: bootstrap.createdAt,
      })
      writeLog('info', 'daemon', 'bootstrap_capture_running', {
        requestedBy: bootstrap.requestedBy,
        startedAt: bootstrap.createdAt,
      })
    } else {
      updateHealth('daemon', {
        bootstrapCapture: false,
        bootstrapCaptureRequestedBy: bootstrap.requestedBy,
        bootstrapCaptureStartedAt: bootstrap.createdAt,
        bootstrapCaptureErrorAt: new Date().toISOString(),
        bootstrapCaptureError: 'bootstrap capture secret unavailable in OS keychain',
      })
      writeLog('error', 'daemon', 'bootstrap_capture_unavailable', {
        requestedBy: bootstrap.requestedBy,
      })
    }
  }

  return { port, url: `http://localhost:${port}` }
}

async function normalizeSessionsForUI(sessions: Session[]): Promise<Session[]> {
  return sessions.map(session => normalizeSessionForUI(session))
}

function normalizeSessionForUI(session: Session, messages?: Message[]): Session {
  return {
    ...session,
    cwd: normalizeClaudeAppCwdForUI(session),
    hasThinking: session.hasThinking || (messages ? messages.some(messageHasThinkingBlock) : false),
  }
}

type ReadMessagesForUIOptions = {
  offset?: number
  limit?: number
}

async function readMessagesForUI(session: Session, options: ReadMessagesForUIOptions = {}): Promise<Message[]> {
  const limit = typeof options.limit === 'number' ? Math.max(0, Math.floor(options.limit)) : 0
  const offset = typeof options.offset === 'number' ? Math.max(0, Math.floor(options.offset)) : 0
  const pageMode = limit > 0
  const rawMessages = pageMode
    ? await readSessionMessagesPage(session, offset, limit)
    : await readSessionMessages(session)
  const messages = rawMessages.map(message => ({
    ...message,
    content: message.content,
    hasThinking: messageHasThinkingBlock(message),
  }))
  if (pageMode) return messages
  return await backfillThinkingMessagesForUI(session, messages)
}

async function findSearchExcerptForUI(session: Session, q: string): Promise<string | null> {
  const total = session.messageCount || 0
  const searchLimit = total > 0 ? total : Number.MAX_SAFE_INTEGER
  for (let offset = 0; offset < searchLimit; offset += SEARCH_MESSAGE_PAGE_LIMIT) {
    const messages = await readMessagesForUI(session, { offset, limit: SEARCH_MESSAGE_PAGE_LIMIT })
    if (messages.length === 0) break
    const excerpt = findSearchExcerptInMessages(messages, q)
    if (excerpt) return excerpt
    if (messages.length < SEARCH_MESSAGE_PAGE_LIMIT) break
  }
  return null
}

function findSearchExcerptInMessages(messages: Message[], q: string): string | null {
  for (const msg of messages) {
    for (const block of msg.content) {
      const text = block.text || block.thinking || stringifySearchableBlock(block)
      const idx = text.toLowerCase().indexOf(q)
      if (idx === -1) continue
      const start = Math.max(0, idx - 40)
      const end = Math.min(text.length, idx + q.length + 80)
      return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
    }
  }
  return null
}

function positiveIntQuery(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function messageHasThinkingBlock(message: Message): boolean {
  return message.content.some(block => block.type === 'thinking')
}

async function backfillThinkingMessagesForUI(session: Session, messages: Message[]): Promise<Message[]> {
  if (!session.hasThinking || messages.some(messageHasThinkingBlock)) return messages

  const rawRecords = await readRawRecords(session.source, session.uid)
  if (rawRecords.length === 0) return messages

  const existingThinkingSignatures = new Set(
    messages
      .filter(messageHasThinkingBlock)
      .map(thinkingMessageSignature),
  )

  const augmented = [...messages]
  let backfillCount = 0

  for (const rawRecord of rawRecords) {
    const message = extractThinkingMessageFromRawRecord(session.source, rawRecord.raw)
    if (!message) continue
    const signature = thinkingMessageSignature(message)
    if (existingThinkingSignatures.has(signature)) continue
    existingThinkingSignatures.add(signature)
    augmented.push(message)
    backfillCount += 1
  }

  if (backfillCount === 0) return messages

  writeLog('info', 'ui', 'thinking_backfilled_from_raw', {
    session: session.uid,
    source: session.source,
    backfillCount,
  })

  return augmented.sort((a, b) => {
    const aTime = Date.parse(a.timestamp) || 0
    const bTime = Date.parse(b.timestamp) || 0
    return aTime - bTime
  })
}

function extractThinkingMessageFromRawRecord(source: Source, raw: unknown): Message | null {
  const rawLine = typeof raw === 'string' ? raw : safeJson(raw)
  if (!rawLine) return null

  const extracted = source === 'codex-cli'
    ? extractCodexLine(rawLine)
    : source === 'openclaw'
      ? extractOpenclawLine(rawLine)
      : extractClaudeLine(rawLine)

  if (!extracted?.message) return null
  return messageHasThinkingBlock(extracted.message) ? extracted.message : null
}

function thinkingMessageSignature(message: Message): string {
  const thinking = message.content
    .filter(block => block.type === 'thinking')
    .map(block => block.thinking || '')
  return JSON.stringify({
    timestamp: message.timestamp,
    role: message.role,
    sourceEventType: message.sourceEventType || '',
    thinking,
  })
}

function normalizeClaudeAppCwdForUI(session: Session): string {
  if (session.source !== 'claude-app') return session.cwd

  const cwd = session.cwd || ''
  const normalized = cwd.replace(/\\/g, '/')
  if (!normalized.includes('/local-agent-mode-sessions/') || !normalized.endsWith('/outputs')) return cwd

  const originalPath = session.originalPath || ''
  if (!originalPath) return cwd
  const sessionDir = path.dirname(originalPath)
  const sessionName = path.basename(sessionDir)
  if (!sessionName.startsWith('local_')) return cwd

  try {
    const metadataPath = path.join(path.dirname(sessionDir), `${sessionName}.json`)
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, unknown>
    const processName = typeof metadata.processName === 'string' ? metadata.processName.trim() : ''
    return processName ? `/sessions/${processName}` : cwd
  } catch {
    return cwd
  }
}

function stringifySearchableBlock(block: Message['content'][number]): string {
  const parts = [
    block.name,
    typeof block.input === 'string' ? block.input : safeJson(block.input),
    typeof block.content === 'string' ? block.content : safeJson(block.content),
  ].filter(Boolean)
  return parts.join('\n')
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function findFreePort(min: number, max: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > max) return reject(new Error('no free port found'))
      const srv = http.createServer()
      srv.listen(port, '127.0.0.1', () => { srv.close(() => resolve(port)) })
      srv.on('error', () => tryPort(port + 1))
    }
    tryPort(min)
  })
}

// ── Pages ──────────────────────────────────────────────────────────────────

function setupPageHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DataMoat — Setup</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0b0f14; --surface: rgba(15,22,31,0.94); --surface-2: #111a24; --border: #223041;
    --accent: #f2b24d; --accent2: #2bc46d; --text: #e8edf3;
    --muted: #8d98a8; --danger: #f05d54; --mono: ui-monospace, 'SF Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace; --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  html, body {
    height: 100%;
    background:
      radial-gradient(circle at top, rgba(50,198,133,0.08), transparent 28%),
      radial-gradient(circle at 18% 8%, rgba(242,178,77,0.08), transparent 26%),
      linear-gradient(180deg, #0b0f14 0%, #0f141c 100%);
    color: var(--text);
    font-family: var(--sans);
  }
  body {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    min-height: 100vh;
    padding: 14px 16px;
    overflow: hidden;
  }
  .logo { font-family: var(--mono); font-size: 11px; letter-spacing: 4px; color: #23c6a9; text-transform: uppercase; margin-bottom: 14px; }
  .logo span { color: var(--muted); }
  .card {
    width: 100%;
    max-width: 600px;
    max-height: calc(100vh - 56px);
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, rgba(20,28,39,0.96), rgba(13,19,27,0.98));
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 18px;
    overflow: hidden;
    box-shadow: 0 24px 70px rgba(0,0,0,0.28);
  }
  .card-header { padding: 18px 22px; border-bottom: 1px solid rgba(255,255,255,0.07); display: flex; align-items: center; gap: 12px; }
  .card-header h1 { font-size: 18px; font-weight: 500; letter-spacing: -0.02em; }
  .step-badge { background: rgba(242,178,77,0.14); color: var(--accent); font-family: var(--mono); font-size: 10px; font-weight: 600; padding: 5px 10px; border-radius: 999px; letter-spacing: 1px; border: 1px solid rgba(242,178,77,0.28); }
  .card-body {
    flex: 1 1 auto;
    min-height: 0;
    padding: 18px 20px 20px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .card-body::-webkit-scrollbar { width: 6px; }
  .card-body::-webkit-scrollbar-track { background: transparent; }
  .card-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 999px; }
  .section { margin-bottom: 18px; }
  .section:last-child { margin-bottom: 0; }
  .section-label { font-family: var(--mono); font-size: 10px; letter-spacing: 1.8px; color: var(--muted); text-transform: uppercase; margin-bottom: 10px; }
  .mnemonic-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; background: #0a1018; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 14px; }
  .word-cell { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
  .word-num { font-size: 9px; color: var(--muted); min-width: 16px; }
  .word-text { font-size: 12px; color: var(--accent); font-weight: 500; }
  .warning-box { background: rgba(240,93,84,0.08); border: 1px solid rgba(240,93,84,0.28); border-radius: 12px; padding: 12px 14px; font-size: 12px; line-height: 1.6; color: #f4b0aa; }
  .warning-box strong { color: var(--danger); }
  .info-box { background: rgba(43,196,109,0.08); border: 1px solid rgba(43,196,109,0.24); border-radius: 12px; padding: 12px 14px; font-size: 12px; line-height: 1.6; color: #aee0bd; }
  .qr-block { display: flex; gap: 20px; align-items: flex-start; }
  .qr-wrap { background: #fff; padding: 8px; border-radius: 10px; flex-shrink: 0; }
  .qr-wrap img { display: block; width: 140px; height: 140px; }
  .qr-instructions { font-size: 12px; line-height: 1.75; color: var(--text); }
  .qr-instructions ol { padding-left: 16px; }
  .qr-instructions li { margin-bottom: 6px; }
  .secret-box { margin-top: 12px; background: #0b1018; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; padding: 10px 14px; font-size: 11px; letter-spacing: 1px; color: var(--muted); word-break: break-all; font-family: var(--mono); }
  .secret-label { font-family: var(--mono); font-size: 9px; color: var(--muted); margin-bottom: 4px; letter-spacing: 1px; }
  .totp-row { display: flex; gap: 10px; align-items: center; }
  .totp-input { background: #0b1018; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px 14px; font-family: var(--mono); font-size: 20px; letter-spacing: 8px; color: var(--accent2); width: 180px; text-align: center; }
  .totp-input:focus { outline: none; border-color: var(--accent2); }
  .recovery-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; background: #0a1018; border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 14px; }
  .recovery-code { font-family: var(--mono); font-size: 13px; letter-spacing: 2px; color: var(--accent2); padding: 8px 10px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); }
  .btn { font-family: var(--sans); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; border: none; border-radius: 10px; padding: 11px 20px; transition: opacity 0.15s, transform 0.15s, border-color 0.15s; }
  .btn[data-off="1"] { opacity: 0.35; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #111; font-weight: 600; box-shadow: 0 12px 30px rgba(242,178,77,0.16); }
  .btn-primary:hover:not([data-off="1"]) { opacity: 0.92; transform: translateY(-1px); }
  .btn-success { background: var(--accent2); color: #08110d; font-weight: 600; box-shadow: 0 12px 30px rgba(43,196,109,0.16); }
  .btn-success:hover:not([data-off="1"]) { opacity: 0.92; transform: translateY(-1px); }
  .btn-ghost { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.22); color: #edf2f7; font-size: 11px; letter-spacing: 0.04em; }
  .btn-ghost:hover { border-color: rgba(255,255,255,0.48); color: #fff; }
  .btn-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .btn-wide { width: 100%; justify-content: center; }
  .error-msg { color: var(--danger); font-size: 12px; margin-top: 10px; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #000; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Password input */
  .pw-input { width: 100%; background: #0b1018; border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 12px 14px; font-family: var(--sans); font-size: 15px; color: var(--text); outline: none; transition: border-color 0.15s, box-shadow 0.15s; }
  .pw-input:focus { border-color: var(--accent); }
  .pw-strength { height: 3px; border-radius: 2px; margin-top: 6px; transition: width 0.3s, background 0.3s; background: var(--border); }
  .pw-hint { font-size: 12px; color: var(--muted); margin-top: 8px; }
  /* Activation overlay */
  .activate-overlay { display: none; position: fixed; inset: 0; z-index: 999; background: var(--bg); flex-direction: column; align-items: center; justify-content: center; gap: 32px; }
  .activate-overlay.show { display: flex; }
  .activate-logo { font-size: 13px; letter-spacing: 4px; color: var(--muted); text-transform: uppercase; }
  .activate-logo span { color: var(--accent); }
  .activate-label { font-size: 11px; letter-spacing: 2px; color: var(--muted); text-transform: uppercase; min-height: 18px; transition: color 0.5s; }
  .activate-label.bright { color: var(--accent2); }
  .progress-track { width: 480px; max-width: 90vw; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; width: 0%; background: var(--accent2); border-radius: 2px; transition: width linear; box-shadow: 0 0 10px var(--accent2); }
  .activate-done { font-size: 22px; color: var(--accent2); opacity: 0; transition: opacity 0.6s; }
  .activate-done.show { opacity: 1; }
  /* Steps nav */
  .steps { display: flex; gap: 0; margin-bottom: 16px; }
  .step-tab { flex: 1; padding: 10px 8px; text-align: center; font-family: var(--mono); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); border-bottom: 2px solid rgba(255,255,255,0.08); cursor: default; }
  .step-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .step-tab.done { color: var(--accent2); border-bottom-color: var(--accent2); }
  .phase { display: none; }
  .phase.active { display: block; }
  .checkbox-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; cursor: pointer; font-size: 11px; line-height: 1.6; }
  .checkbox-row input { width: 14px; height: 14px; accent-color: var(--accent); margin-top: 2px; flex-shrink: 0; cursor: pointer; }
  .final-check-list { margin-bottom: 20px; }
  .doc-link { color: var(--accent); text-decoration: none; }
  .doc-link:hover { text-decoration: underline; }
  .method-stack { display: flex; flex-direction: column; gap: 14px; }
  .method-card {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px;
    padding: 14px;
    cursor: pointer;
    transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s, opacity 0.12s;
    background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
  }
  .method-card:hover:not(.disabled) { transform: translateY(-1px); }
  .method-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .method-body { flex: 1; }
  .method-card.selected.password {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px rgba(232,160,32,0.25), 0 0 24px rgba(232,160,32,0.08);
    background: linear-gradient(180deg, rgba(232,160,32,0.12), rgba(232,160,32,0.04));
  }
  .method-card.selected.touchid {
    border-color: var(--accent2);
    box-shadow: 0 0 0 1px rgba(63,185,80,0.25), 0 0 24px rgba(63,185,80,0.08);
    background: linear-gradient(180deg, rgba(63,185,80,0.12), rgba(63,185,80,0.04));
  }
  .method-card.disabled { opacity: 0.35; cursor: not-allowed; }
  .method-card.locked { cursor: default; }
  .method-card.locked:hover { transform: none; }
  .method-title { font-size: 18px; font-weight: 500; letter-spacing: -0.02em; margin-bottom: 7px; }
  .method-copy { font-size: 12px; line-height: 1.55; color: #b1bcc9; max-width: 430px; }
  .method-switch {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    min-width: 72px;
    flex-shrink: 0;
  }
  .method-switch-track {
    width: 54px;
    height: 30px;
    border-radius: 999px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06);
    position: relative;
    transition: background 0.15s, border-color 0.15s;
  }
  .method-switch-thumb {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(255,255,255,0.86);
    box-shadow: 0 2px 10px rgba(0,0,0,0.22);
    transition: transform 0.15s, background 0.15s;
  }
  .method-switch-label {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--muted);
  }
  .method-switch.password.enabled .method-switch-track { border-color: rgba(43,196,109,0.48); background: rgba(43,196,109,0.22); }
  .method-switch.touchid.enabled .method-switch-track { border-color: rgba(43,196,109,0.48); background: rgba(43,196,109,0.22); }
  .method-switch.enabled .method-switch-thumb { transform: translateX(24px); }
  .method-switch.password.enabled .method-switch-label { color: var(--accent2); }
  .method-switch.touchid.enabled .method-switch-label { color: var(--accent2); }
  .method-switch.disabled .method-switch-label,
  .method-switch.unavailable .method-switch-label { color: var(--muted); }
  .method-switch.unavailable .method-switch-track { opacity: 0.5; }
  .method-switch.locked { min-width: auto; }
  .method-switch.locked .method-switch-track { display: none; }
  .method-switch.locked .method-switch-label {
    color: var(--accent);
    border: 1px solid rgba(242,178,77,0.28);
    background: rgba(242,178,77,0.12);
    border-radius: 999px;
    padding: 6px 10px;
  }
  .method-fields {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .method-fields.hidden { display: block; opacity: 0.45; }
  .method-field { margin-bottom: 12px; }
  .method-field:last-child { margin-bottom: 0; }
  .method-section-label { margin-bottom: 8px; }
  .pw-input-wrap { transition: opacity 0.15s; }
  .pw-input-wrap.off { opacity: 0.4; pointer-events: none; }
  .pw-card-note { margin-top: 12px; }
  .phase-actions {
    position: sticky;
    bottom: -20px;
    z-index: 2;
    margin-top: 14px;
    margin-inline: -20px;
    padding: 12px 20px 0;
    border-top: 1px solid rgba(255,255,255,0.07);
    background: linear-gradient(180deg, rgba(13,19,27,0.18), rgba(13,19,27,0.96) 32%, rgba(13,19,27,0.99));
  }
  @media (max-height: 820px) {
    body { padding: 10px 12px; }
    .logo { margin-bottom: 10px; }
    .card { max-height: calc(100vh - 40px); }
    .card-header { padding: 14px 18px; }
    .card-body { padding: 14px 16px 16px; }
    .phase-actions {
      bottom: -16px;
      margin-inline: -16px;
      padding: 10px 16px 0;
    }
  }
  strong { color: #f3f7fb; font-weight: 600; }
</style>
</head>
<body>
<div class="logo">data<span>moat</span> — first-run setup</div>

<div class="card">
  <div class="card-header">
    <div class="step-badge" id="step-badge">STEP 1 / 4</div>
    <h1 id="card-title">Choose unlock methods</h1>
  </div>
  <div class="card-body">
    <div class="section" id="bootstrap-capture-banner" style="display:none;">
      <div class="warning-box" id="bootstrap-capture-copy">
        Capture is already running in the background. Passwords, the 24-word recovery phrase, and recovery codes will only be shown on this desktop during final setup. Do not relay or screenshot recovery material through chat apps.
      </div>
    </div>
    <div class="steps">
      <div class="step-tab active" id="tab1">Unlock</div>
      <div class="step-tab" id="tab2">Recovery</div>
      <div class="step-tab" id="tab3">Authenticator</div>
      <div class="step-tab" id="tab4">Final Step</div>
    </div>

    <!-- Phase 1: unlock methods -->
    <div class="phase active" id="phase1">
      <div class="section" id="touchid-info-section" style="display:none">
        <div class="info-box">
          If Touch ID is selected, this Mac can unlock the vault with biometric approval through <strong>Apple Secure Enclave</strong>.
        </div>
      </div>
      <div class="section">
        <div class="section-label" id="unlock-methods-label">Set a local password to unlock this vault</div>
        <div class="method-stack">
          <div class="method-card password selected locked" id="method-password" onclick="toggleMethod('password')">
            <div class="method-head">
              <div class="method-body">
                <div class="method-title">Master password</div>
                <div class="method-copy">
                  Stored as a verifier hash and used to unwrap a password-protected copy of the vault key.
                </div>
              </div>
              <div class="method-switch password locked enabled" id="method-password-state" style="display:none">
                <div class="method-switch-track"><div class="method-switch-thumb"></div></div>
                <div class="method-switch-label">Required</div>
              </div>
            </div>
            <div class="method-fields" id="password-fields">
              <div class="method-field">
                <div class="section-label method-section-label">Master password</div>
                <div class="pw-input-wrap" id="password-input-wrap">
                  <input class="pw-input" id="pw-input" type="password" placeholder="Enter a strong password (min 8 chars)" autocomplete="new-password" />
                  <div class="pw-strength" id="pw-strength" style="width:0%"></div>
                  <div class="pw-hint" id="pw-hint">At least 8 characters</div>
                </div>
              </div>
              <div class="method-field">
                <div class="section-label method-section-label">Confirm password</div>
                <div class="pw-input-wrap" id="password-confirm-wrap">
                  <input class="pw-input" id="pw-confirm" type="password" placeholder="Re-enter password" autocomplete="new-password" />
                  <div class="error-msg" id="pw-error" style="display:none;"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="method-card touchid disabled" id="method-touchid" style="display:none" onclick="toggleMethod('touchid')">
            <div class="method-head">
              <div class="method-body">
                <div class="method-title">Enable Touch ID on this Mac</div>
                <div class="method-copy" id="touchid-copy">
                  Daily unlock on this Mac using <strong>Apple Secure Enclave</strong>. The Touch ID private key stays inside Apple hardware and is used to release vault access on this Mac only.
                </div>
              </div>
              <div class="method-switch touchid unavailable" id="method-touchid-state">
                <div class="method-switch-track"><div class="method-switch-thumb"></div></div>
                <div class="method-switch-label">N/A</div>
              </div>
            </div>
          </div>
        </div>
        <div class="error-msg" id="method-error" style="display:none;"></div>
      </div>
      <div class="phase-actions">
        <button class="btn btn-primary btn-wide" id="btn-next1" type="button">Continue →</button>
      </div>
    </div>

    <!-- Phase 2: mnemonic -->
    <div class="phase" id="phase2">
      <div class="section">
        <div class="section-label">24-word emergency recovery phrase</div>
        <div class="mnemonic-grid" id="mnemonic-grid">
          <div class="word-cell" style="grid-column: span 4; justify-content: center; color: var(--muted); font-size: 11px;">Generating…</div>
        </div>
      </div>
      <div class="section">
        <div class="warning-box">
          <strong>Write these down on paper.</strong> Shown <strong>exactly once</strong> — never stored.
          This phrase is randomly generated (unrelated to your password) and lets you regain access if all other methods fail.
          Store it physically (safe, safety deposit box). Never type it into a terminal or chat.
        </div>
      </div>
      <div class="section">
        <label class="checkbox-row">
          <input type="checkbox" id="mnemonic-saved">
          I have written down all 24 words on paper and stored them safely.
        </label>
        <button class="btn btn-primary" id="btn-next2" data-off="1" type="button">Continue →</button>
      </div>
    </div>

    <!-- Phase 3: TOTP (optional) -->
    <div class="phase" id="phase3">
      <div class="section">
        <div class="info-box">
          If enabled, every login will require the 6-digit code after your chosen primary unlock method.
        </div>
      </div>
      <div class="section">
        <div class="section-label">Two-factor authentication (optional)</div>
        <div class="qr-block">
          <div class="qr-wrap">
            <img id="qr-img" src="" alt="QR Code loading…" />
          </div>
          <div class="qr-instructions">
            <ol>
              <li>Open <strong>Google Authenticator</strong> on your phone</li>
              <li>Tap <strong>+</strong> → <strong>Scan QR code</strong></li>
              <li>Scan the QR code on the left</li>
              <li>Enter the 6-digit code below to confirm</li>
            </ol>
            <div class="secret-label" style="margin-top:14px;">Manual entry key:</div>
            <div class="secret-box" id="totp-secret-display">loading…</div>
          </div>
        </div>
      </div>
      <div class="section">
        <div class="section-label">Confirm code from your app</div>
        <div class="totp-row">
          <input class="totp-input" id="setup-totp" type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" />
          <button class="btn btn-primary" id="btn-next3" data-off="1" type="button">Verify →</button>
        </div>
        <div class="error-msg" id="totp-error" style="display:none;"></div>
      </div>
      <div class="section">
        <button class="btn btn-primary btn-wide" id="btn-skip-totp" type="button">Skip 2-step verification (can add later)</button>
      </div>
    </div>

    <!-- Phase 4: Recovery codes + final confirm -->
    <div class="phase" id="phase4">
      <div class="section">
        <div class="section-label">One-time recovery codes</div>
        <div class="recovery-grid" id="recovery-grid">
          <div style="color:var(--muted); font-size:11px; grid-column:span 2; text-align:center;">Generating…</div>
        </div>
      </div>
      <div class="section">
        <div class="warning-box">
          Each code can be used <strong>once</strong> if you ever get locked out. Store them separately from your recovery phrase.
        </div>
      </div>
      <div class="section final-check-list">
        <label class="checkbox-row">
          <input type="checkbox" class="final-check" onchange="checkFinal()">
          I have saved the 8 recovery codes in a secure location.
        </label>
        <label class="checkbox-row">
          <input type="checkbox" class="final-check" onchange="checkFinal()">
          I understand: if I lose my password, recovery codes, AND the 24-word phrase, my vault cannot be recovered.
        </label>
      </div>
      <button class="btn btn-success" id="btn-activate" data-off="1" type="button">Activate DataMoat</button>
      <div class="error-msg" id="activate-error" style="display:none;"></div>
    </div>

  </div>
</div>

<!-- Activation overlay -->
<div class="activate-overlay" id="activate-overlay">
  <div class="activate-logo">data<span>moat</span></div>
  <div class="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
  <div class="activate-label" id="activate-label">Initialising vault…</div>
  <div class="activate-done" id="activate-done">✓</div>
</div>

<script>
let _setupNonce = '', _secret = '', _mnemonic = '', _password = '', _enrollTotp = false;
let _touchIdAvailable = false, _passwordEnabled = true, _touchIdEnabled = false;
let _setupCommitted = false;
let _passwordRequired = true;
function esc(s) {
  return String(s || '').replace(/[&<>\"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;', \"'\":'&#39;' }[ch]));
}

function dmCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&') + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : ''
}
function apiFetch(url, options) {
  const opts = options ? { ...options } : {}
  const method = ((opts.method || 'GET') || 'GET').toUpperCase()
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = dmCookie('dm_csrf')
    if (token) {
      const headers = new Headers(opts.headers || {})
      if (!headers.has('X-DM-CSRF')) {
        headers.set('X-DM-CSRF', token)
      }
      opts.headers = headers
    }
  }
  return fetch(url, opts)
}

async function syncSetupRoute(force = false) {
  try {
    const r = await apiFetch('/api/meta');
    const d = await r.json();
    if (!d || typeof d.route !== 'string') return false;
    if (d.route === 'unlock' || d.route === 'app') {
      if (force || window.location.pathname === '/setup') {
        window.location.href = d.route === 'app' ? '/' : '/unlock';
        return true;
      }
    }
  } catch {}
  return false;
}

async function init() {
  if (await syncSetupRoute(true)) return;
  const r = await apiFetch('/api/setup/init', { method: 'POST' });
  const d = await r.json();
  if (d && d.error === 'already setup') {
    window.location.href = '/unlock';
    return;
  }
  _setupNonce = d.setupNonce;
  _secret = d.secret;
  _mnemonic = d.mnemonic;
  _touchIdAvailable = !!d.touchIdAvailable;
  _touchIdEnabled = _touchIdAvailable;
  const touchIdReason = typeof d.touchIdReason === 'string' ? d.touchIdReason : '';
  const words = d.mnemonic.split(' ');
  document.getElementById('mnemonic-grid').innerHTML = words.map((w, i) =>
    '<div class="word-cell"><span class="word-num">' + (i+1) + '</span><span class="word-text">' + w + '</span></div>'
  ).join('');
  document.getElementById('qr-img').src = d.qrDataUrl;
  document.getElementById('totp-secret-display').textContent = d.secret;
  if (d.bootstrapCapture && d.bootstrapCapture.enabled) {
    const banner = document.getElementById('bootstrap-capture-banner');
    const copy = document.getElementById('bootstrap-capture-copy');
    const remoteNoScreen = d.bootstrapCapture.requestedBy === 'remote-no-screen';
    banner.style.display = '';
    copy.innerHTML = remoteNoScreen
      ? '<strong>Remote no-screen capture already started.</strong> DataMoat is already collecting supported local records on this machine. Passwords, the 24-word recovery phrase, and recovery codes will only be shown on this desktop during final setup and should never be relayed through Telegram, WhatsApp, OpenClaw, screenshots, or any remote chat channel.'
      : '<strong>Background capture already started.</strong> DataMoat is already collecting supported local records on this machine. Passwords, the 24-word recovery phrase, and recovery codes will only be shown on this desktop during final setup and should never be relayed through Telegram, WhatsApp, OpenClaw, screenshots, or any remote chat channel.';
  }
  if (!_touchIdAvailable) {
    _passwordRequired = true;
    _passwordEnabled = true;
    _touchIdEnabled = false;
    document.getElementById('touchid-copy').innerHTML = touchIdReason
      ? 'Touch ID with <strong>Apple Secure Enclave</strong> is unavailable right now. <span style=\"opacity:.82\">' + esc(touchIdReason) + '</span>'
      : 'Touch ID with <strong>Apple Secure Enclave</strong> is not available on this Mac, so this option is disabled.';
  }
  renderMethodCards();
  updatePwUI();
}
init();

window.addEventListener('focus', () => { void syncSetupRoute(false); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void syncSetupRoute(false);
});

function setOff(id, off) { document.getElementById(id).dataset.off = off ? '1' : '0'; }
function isOff(id) { return document.getElementById(id).dataset.off === '1'; }
function showMethodError(msg) {
  const el = document.getElementById('method-error');
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

function renderMethodCards() {
  const pwCard = document.getElementById('method-password');
  const tiCard = document.getElementById('method-touchid');
  const pwFields = document.getElementById('password-fields');
  const pwInputWrap = document.getElementById('password-input-wrap');
  const pwConfirmWrap = document.getElementById('password-confirm-wrap');
  const pwState = document.getElementById('method-password-state');
  const tiState = document.getElementById('method-touchid-state');
  const pwStateLabel = pwState.querySelector('.method-switch-label');
  const tiStateLabel = tiState.querySelector('.method-switch-label');
  const touchInfo = document.getElementById('touchid-info-section');
  const methodsLabel = document.getElementById('unlock-methods-label');

  pwCard.className = 'method-card password' + (_passwordEnabled ? ' selected' : '') + (_passwordRequired ? ' locked' : '');
  tiCard.className = 'method-card touchid' + (_touchIdEnabled ? ' selected' : '') + (_touchIdAvailable ? '' : ' disabled');
  pwState.className = 'method-switch password ' + (_passwordRequired ? 'locked enabled' : (_passwordEnabled ? 'enabled' : 'disabled'));
  tiState.className = 'method-switch touchid ' + (_touchIdAvailable ? (_touchIdEnabled ? 'enabled' : 'disabled') : 'unavailable');
  if (pwStateLabel) pwStateLabel.textContent = _passwordRequired ? 'Required' : (_passwordEnabled ? 'On' : 'Off');
  if (tiStateLabel) tiStateLabel.textContent = _touchIdAvailable ? (_touchIdEnabled ? 'On' : 'Off') : 'N/A';
  tiCard.style.display = _touchIdAvailable ? '' : 'none';
  touchInfo.style.display = _touchIdAvailable ? '' : 'none';
  pwState.style.display = _touchIdAvailable ? '' : 'none';
  methodsLabel.textContent = _touchIdAvailable
    ? 'Choose at least one local unlock method to enable'
    : 'Set a local password to unlock this vault';

  pwFields.classList.toggle('hidden', !_passwordEnabled);
  pwInputWrap.classList.toggle('off', !_passwordEnabled);
  pwConfirmWrap.classList.toggle('off', !_passwordEnabled);
  document.getElementById('pw-input').disabled = !_passwordEnabled;
  document.getElementById('pw-confirm').disabled = !_passwordEnabled;
}

function toggleMethod(kind) {
  if (kind === 'password' && _passwordRequired) return;
  if (kind === 'touchid' && !_touchIdAvailable) return;
  const current = kind === 'password' ? _passwordEnabled : _touchIdEnabled;
  const other = kind === 'password' ? _touchIdEnabled : _passwordEnabled;
  if (current && !other) {
    showMethodError('Choose at least one unlock method.');
    return;
  }
  showMethodError('');
  if (kind === 'password') _passwordEnabled = !_passwordEnabled;
  else _touchIdEnabled = !_touchIdEnabled;
  renderMethodCards();
  updatePwUI();
}

// Password strength
const pwInput = document.getElementById('pw-input');
const pwConfirm = document.getElementById('pw-confirm');
function pwMeetsReqs(p) {
  return p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p);
}
function pwScore(p) {
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 12) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++;
  if (/[0-9]/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return s;
}
function updatePwUI() {
  const p = pwInput.value, c = pwConfirm.value;
  const score = pwScore(p);
  const colors = ['#f85149','#f85149','#e8a020','#e8a020','#3fb950','#3fb950'];
  const bar = document.getElementById('pw-strength');
  bar.style.width = (score * 20) + '%';
  bar.style.background = colors[score] || '#3fb950';
  // Show missing requirements
  const reqs = [];
  if (p.length < 8) reqs.push('8+ chars');
  if (!/[A-Z]/.test(p)) reqs.push('uppercase');
  if (!/[a-z]/.test(p)) reqs.push('lowercase');
  if (!/[0-9]/.test(p)) reqs.push('number');
  const hint = document.getElementById('pw-hint');
  if (!_passwordEnabled) hint.textContent = 'Password unlock disabled for this vault';
  else if (p.length === 0) hint.textContent = 'Requires: 8+ chars, uppercase, lowercase, number';
  else if (reqs.length > 0) hint.textContent = 'Missing: ' + reqs.join(', ');
  else hint.textContent = score >= 4 ? 'Strong password' : 'Password ok';
  const err = document.getElementById('pw-error');
  if (_passwordEnabled && c.length > 0 && p !== c) { err.textContent = 'Passwords do not match'; err.style.display=''; }
  else { err.style.display='none'; }
}
pwInput.addEventListener('input', updatePwUI);
pwConfirm.addEventListener('input', updatePwUI);
pwConfirm.addEventListener('keydown', e => { if (e.key==='Enter') goToStep2(); });

document.getElementById('mnemonic-saved').addEventListener('change', e => setOff('btn-next2', !e.target.checked));
document.getElementById('setup-totp').addEventListener('input', e => {
  const v = e.target.value.replace(/\\D/g,''); e.target.value = v;
  setOff('btn-next3', v.length !== 6);
});
document.getElementById('btn-next1').addEventListener('click', () => goToStep2());
document.getElementById('btn-next2').addEventListener('click', () => { if (!isOff('btn-next2')) goToStep3(); });
document.getElementById('btn-next3').addEventListener('click', () => { if (!isOff('btn-next3')) goToStep4WithTOTP(); });
document.getElementById('btn-skip-totp').addEventListener('click', () => skipTOTP());
document.getElementById('btn-activate').addEventListener('click', () => { if (!isOff('btn-activate')) activate(); });

const TOTAL = 4;
function setStep(n) {
  ['phase1','phase2','phase3','phase4'].forEach((id, i) => {
    document.getElementById(id).classList.toggle('active', i === n-1);
  });
  ['tab1','tab2','tab3','tab4'].forEach((id, i) => {
    const el = document.getElementById(id);
    el.className = 'step-tab' + (i < n-1 ? ' done' : i === n-1 ? ' active' : '');
  });
  document.getElementById('step-badge').textContent = 'STEP ' + n + ' / ' + TOTAL;
  const titles = ['Choose unlock methods', 'Save recovery phrase', 'Two-factor authentication', 'Final step: save recovery codes'];
  document.getElementById('card-title').textContent = titles[n-1];
}

function validateStep1(showErrors) {
  showMethodError('');
  const err = document.getElementById('pw-error');
  err.style.display = 'none';

  if (!_passwordEnabled && !_touchIdEnabled) {
    if (showErrors) showMethodError('Choose at least one unlock method.');
    return false;
  }

  if (_passwordEnabled) {
    const p = pwInput.value;
    const c = pwConfirm.value;
    if (!p) {
      if (showErrors) {
        err.textContent = 'Enter a password or turn off password unlock.';
        err.style.display = '';
      }
      return false;
    }
    if (!pwMeetsReqs(p)) {
      if (showErrors) {
        err.textContent = 'Password must include 8+ chars, uppercase, lowercase, and a number.';
        err.style.display = '';
      }
      return false;
    }
    if (p !== c) {
      if (showErrors) {
        err.textContent = 'Passwords do not match';
        err.style.display = '';
      }
      return false;
    }
  }
  return true;
}

function goToStep2() {
  if (!validateStep1(true)) return;
  _password = document.getElementById('pw-input').value;
  setStep(2);
}
function goToStep3() { setStep(3); }

async function goToStep4WithTOTP() {
  const token = document.getElementById('setup-totp').value;
  const btn = document.getElementById('btn-next3');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Verifying…';
  try {
    const r = await apiFetch('/api/setup/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupNonce: _setupNonce,
        passwordEnabled: _passwordEnabled,
        touchIdEnabled: _touchIdEnabled,
        password: _password,
        totpToken: token
      }),
    });
    const d = await r.json();
    if (d.error) {
      document.getElementById('totp-error').textContent = d.error;
      document.getElementById('totp-error').style.display = '';
      btn.disabled = false;
      btn.textContent = 'Verify →';
      return;
    }
    _enrollTotp = true;
    showRecoveryCodes(d.recoveryCodes);
    document.getElementById('totp-error').style.display = 'none';
    setStep(4);
  } catch {
    document.getElementById('totp-error').textContent = 'Could not continue setup. Try again.';
    document.getElementById('totp-error').style.display = '';
    btn.disabled = false;
    btn.textContent = 'Verify →';
  }
}

async function skipTOTP() {
  const btn = document.getElementById('btn-skip-totp');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Continuing…';
  try {
    const r = await apiFetch('/api/setup/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setupNonce: _setupNonce,
        passwordEnabled: _passwordEnabled,
        touchIdEnabled: _touchIdEnabled,
        password: _password
      }),
    });
    const d = await r.json();
    if (d.error) {
      document.getElementById('totp-error').textContent = d.error;
      document.getElementById('totp-error').style.display = '';
      btn.disabled = false;
      btn.textContent = 'Skip 2-step verification (can add later)';
      return;
    }
    _enrollTotp = false;
    showRecoveryCodes(d.recoveryCodes);
    document.getElementById('totp-error').style.display = 'none';
    setStep(4);
    btn.disabled = false;
    btn.textContent = 'Skip 2-step verification (can add later)';
  } catch {
    document.getElementById('totp-error').textContent = 'Could not continue setup. Try again.';
    document.getElementById('totp-error').style.display = '';
    btn.disabled = false;
    btn.textContent = 'Skip 2-step verification (can add later)';
  }
}

function showRecoveryCodes(codes) {
  document.getElementById('recovery-grid').innerHTML = codes.map(c =>
    '<div class="recovery-code">' + c + '</div>'
  ).join('');
}

function checkFinal() {
  const all = [...document.querySelectorAll('.final-check')].every(c => c.checked);
  setOff('btn-activate', !all);
}

async function activate() {
  const overlay = document.getElementById('activate-overlay');
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('activate-label');
  const done = document.getElementById('activate-done');
  const err = document.getElementById('activate-error');
  err.style.display = 'none';
  done.classList.remove('show');
  label.classList.remove('bright');
  fill.style.transitionDuration = '0ms';
  fill.style.width = '0%';
  overlay.classList.add('show');
  fill.style.transitionDuration = '350ms';
  fill.style.width = '18%';
  label.textContent = 'Sealing vault…';
  const progressSteps = [
    { pct: 32, delay: 800, duration: 700, text: 'Preparing encrypted vault…' },
    { pct: 48, delay: 1800, duration: 1200, text: 'Importing existing conversations…' },
    { pct: 66, delay: 4200, duration: 2600, text: 'Scanning local history. This can take a few minutes on large vaults…' },
    { pct: 84, delay: 9000, duration: 7000, text: 'Finishing initial session index…' },
    { pct: 92, delay: 18000, duration: 15000, text: 'Still importing. DataMoat will open only after the scan is complete…' },
  ];
  const progressTimers = progressSteps.map(step => setTimeout(() => {
    fill.style.transitionDuration = step.duration + 'ms';
    fill.style.width = step.pct + '%';
    label.textContent = step.text;
  }, step.delay));
  const clearProgressTimers = () => progressTimers.forEach(timer => clearTimeout(timer));
  const rememberCaptureWarning = (payload) => {
    if (payload && typeof payload.captureWarning === 'string' && payload.captureWarning.trim()) {
      try { sessionStorage.setItem('dm_notice', payload.captureWarning.trim()); } catch {}
    }
  };
  try {
    const r = await apiFetch('/api/setup/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupNonce: _setupNonce }),
    });
    let d = null;
    try { d = await r.json(); } catch {}
    clearProgressTimers();
    if (!r.ok || d?.error) {
      if (d?.error === 'already setup') {
        _setupCommitted = true;
        window.location.href = '/unlock';
        return;
      }
      overlay.classList.remove('show');
      fill.style.width = '0%';
      err.textContent = (d && typeof d.error === 'string' && d.error.trim())
        ? d.error
        : 'Could not activate vault. Try again.';
      err.style.display = '';
      return;
    }
    _setupCommitted = true;
    rememberCaptureWarning(d);
  } catch {
    clearProgressTimers();
    overlay.classList.remove('show');
    fill.style.width = '0%';
    err.textContent = 'Could not activate vault. Try again.';
    err.style.display = '';
    return;
  }
  const steps = [
    { pct: 55, ms: 420, text: 'Writing session index…' },
    { pct: 82, ms: 360, text: 'Activating watcher…' },
    { pct: 100, ms: 320, text: 'Done.' },
  ];
  for (const step of steps) {
    fill.style.transitionDuration = step.ms + 'ms';
    fill.style.width = step.pct + '%';
    label.textContent = step.text;
    await new Promise(r => setTimeout(r, step.ms + 80));
  }
  label.classList.add('bright');
  done.classList.add('show');
  await new Promise(r => setTimeout(r, 600));
  window.location.replace('/?refresh=' + Date.now());
}
</script>
</body>
</html>`
}

function unlockPageHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DataMoat — Unlock</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #07090d; --surface: #0d1117; --border: #1e2530;
    --accent: #e8a020; --accent2: #3fb950; --text: #c9d1d9;
    --muted: #586069; --danger: #f85149; --mono: ui-monospace, 'SF Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--mono); }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  .logo { font-size: 11px; letter-spacing: 4px; color: #00c8a0; text-transform: uppercase; margin-bottom: 40px; }
  .logo span { color: var(--muted); }
  .lock-icon { font-size: 40px; margin-bottom: 20px; filter: grayscale(0.3); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.7; } 50% { opacity: 1; } }
  .card { width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .card-header { padding: 20px 24px; border-bottom: 1px solid var(--border); }
  .card-header h1 { font-size: 14px; font-weight: 500; letter-spacing: 1px; }
  .card-header p { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .card-body { padding: 28px 24px; }
  .label { font-size: 10px; letter-spacing: 2px; color: var(--muted); text-transform: uppercase; margin-bottom: 10px; }
  .pw-input {
    width: 100%; background: #060810; border: 1px solid var(--border);
    border-radius: 6px; padding: 14px;
    font-family: var(--mono); font-size: 15px;
    color: var(--text); outline: none; transition: border-color 0.15s;
  }
  .pw-input:focus { border-color: var(--accent); }
  .pw-input.error { border-color: var(--danger); animation: shake 0.3s ease; }
  .totp-big {
    width: 100%; text-align: center; background: #060810; border: 1px solid var(--border);
    border-radius: 6px; padding: 16px; font-family: var(--mono); font-size: 26px; letter-spacing: 10px;
    color: var(--accent2); outline: none; transition: border-color 0.15s;
  }
  .totp-big:focus { border-color: var(--accent2); }
  .totp-big.error { border-color: var(--danger); color: var(--danger); animation: shake 0.3s ease; }
  @keyframes shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
  .btn {
    width: 100%; font-family: var(--mono); font-size: 12px; letter-spacing: 2px;
    text-transform: uppercase; cursor: pointer; border: none;
    border-radius: 5px; padding: 12px; margin-top: 14px;
    transition: opacity 0.15s; font-weight: 600;
  }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: #000; }
  .btn-primary:hover:not(:disabled) { opacity: 0.85; }
  .divider { text-align: center; font-size: 10px; color: var(--muted); margin: 18px 0 14px; letter-spacing: 1px; }
  .recovery-link { text-align: center; }
  .recovery-link button { background: none; border: none; font-family: var(--mono); font-size: 11px; color: var(--muted); cursor: pointer; text-decoration: underline; padding: 0; }
  .recovery-link button:hover { color: var(--text); }
  .recovery-input {
    width: 100%; text-align: center; background: #060810; border: 1px solid var(--border);
    border-radius: 6px; padding: 12px; font-family: var(--mono); font-size: 14px; letter-spacing: 3px;
    color: var(--accent); outline: none; margin-top: 10px; text-transform: uppercase;
  }
  .recovery-input:focus { border-color: var(--accent); }
  .error-msg { color: var(--danger); font-size: 11px; margin-top: 10px; text-align: center; min-height: 18px; }
  .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; margin-right: 6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .btn-touchid {
    width: 100%; padding: 16px; margin-bottom: 4px; background: transparent;
    border: 1.5px solid var(--accent2); border-radius: 8px; cursor: pointer;
    color: var(--accent2); font-family: var(--mono); font-size: 13px; letter-spacing: 3px; text-transform: uppercase;
    display: flex; align-items: center; justify-content: center; gap: 12px;
    transition: background 0.15s, box-shadow 0.15s;
  }
  .btn-touchid:hover { background: rgba(63,185,80,0.07); box-shadow: 0 0 16px rgba(63,185,80,0.15); }
  .btn-touchid.waiting { opacity: 0.7; cursor: default; }
  .btn-touchid svg { flex-shrink: 0; }
  .method-note { font-size: 10px; color: var(--muted); line-height: 1.6; text-align: center; margin-top: 8px; }
  .method-note a { color: var(--accent); text-decoration: none; }
  .method-note a:hover { text-decoration: underline; }
  .skip-link { text-align: center; margin-top: 8px; }
  .skip-link button { background: none; border: none; font-family: var(--mono); font-size: 10px; color: var(--muted); cursor: pointer; letter-spacing: 1px; }
  .skip-link button:hover { color: var(--text); }
</style>
</head>
<body>
<div class="logo">data<span>moat</span></div>
<div class="lock-icon">🔐</div>

<div class="card">
  <div class="card-header">
    <h1>Unlock vault</h1>
    <p id="card-sub">Use a local unlock method</p>
  </div>
  <div class="card-body">

    <!-- Touch ID section (shown if available, hidden otherwise) -->
    <div id="touchid-section" style="display:none;">
      <button class="btn-touchid" id="btn-touchid" onclick="touchIDUnlock()">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/>
          <path d="M12 6c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2s2-.9 2-2V8c0-1.1-.9-2-2-2z"/>
          <path d="M8 10c0-2.21 1.79-4 4-4s4 1.79 4 4"/>
          <path d="M6 12c0-3.31 2.69-6 6-6s6 2.69 6 6"/>
          <path d="M4 12c0-4.42 3.58-8 8-8s8 3.58 8 8"/>
        </svg>
        Touch ID + Secure Enclave
      </button>
      <div class="error-msg" id="touchid-error"></div>
      <div class="method-note" id="touchid-hint">
        Click the Touch ID button when you want to unlock with Touch ID. If authenticator login is enabled, you will enter the 6-digit code after Touch ID.
      </div>
      <div class="divider">or use password</div>
    </div>

    <!-- Password section (always shown) -->
    <div id="password-section">
      <div id="password-controls">
        <div class="label">Master password</div>
        <input class="pw-input" id="pw-input" type="password" placeholder="Enter your password" autocomplete="current-password" />
        <button class="btn btn-primary" id="btn-unlock" disabled>Unlock</button>
        <div class="error-msg" id="pw-error"></div>
      </div>
      <div class="method-note" id="password-disabled-note" style="display:none;">
        Password unlock is disabled for this vault.
      </div>
      <div class="divider">or</div>
      <div class="recovery-link">
        <button onclick="showRecovery()">Use a recovery code or phrase</button>
      </div>
    </div>

    <!-- TOTP section (shown after password verify if needsTotp=true) -->
    <div id="totp-section" style="display:none;">
      <div class="label">Authenticator code</div>
      <input class="totp-big" id="totp-input" type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" />
      <button class="btn btn-primary" id="btn-totp" disabled>Verify</button>
      <div class="error-msg" id="totp-error"></div>
    </div>

    <!-- Recovery section -->
    <div id="recovery-section" style="display:none;">
      <div class="label">Recovery code or 24-word phrase</div>
      <input class="recovery-input" id="recovery-input" type="text" placeholder="XXXX-XXXX-XXXX or word1 word2 …" />
      <button class="btn btn-primary" id="btn-recover" onclick="unlockWithRecovery()">Recover access</button>
      <div class="error-msg" id="recovery-error"></div>
      <div class="divider">or</div>
      <div class="recovery-link">
        <button onclick="showPassword()">Back to password</button>
      </div>
    </div>

  </div>
</div>

<script>
const TOUCHID_SVG = \`<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"/><path d="M12 6c-1.1 0-2 .9-2 2v4c0 1.1.9 2 2 2s2-.9 2-2V8c0-1.1-.9-2-2-2z"/><path d="M8 10c0-2.21 1.79-4 4-4s4 1.79 4 4"/><path d="M6 12c0-3.31 2.69-6 6-6s6 2.69 6 6"/><path d="M4 12c0-4.42 3.58-8 8-8s8 3.58 8 8"/></svg>Touch ID + Secure Enclave\`;
function dmCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&') + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : ''
}
function apiFetch(url, options) {
  const opts = options ? { ...options } : {}
  const method = ((opts.method || 'GET') || 'GET').toUpperCase()
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = dmCookie('dm_csrf')
    if (token) {
      const headers = new Headers(opts.headers || {})
      if (!headers.has('X-DM-CSRF')) {
        headers.set('X-DM-CSRF', token)
      }
      opts.headers = headers
    }
  }
  return fetch(url, opts)
}
let unlockOptions = { passwordEnabled: true, touchIdEnabled: false, totpEnrolled: false };
const TOUCHID_HINT_DEFAULT = 'Touch ID opens automatically when this screen appears. You can also click the Touch ID button again or use your password.';
let touchIdUnlockInFlight = false;
let touchIdAutoPrompted = false;
let touchIdAutoPromptTimer = null;

function setTouchIdHint(message) {
  const hint = document.getElementById('touchid-hint');
  if (hint) hint.textContent = message;
}

function restoreTouchIdHint() {
  setTouchIdHint(TOUCHID_HINT_DEFAULT);
}

function maybeAutoTouchIdUnlock() {
  if (touchIdAutoPrompted || touchIdUnlockInFlight || !unlockOptions.touchIdEnabled) return;
  const section = document.getElementById('touchid-section');
  if (!section || section.style.display === 'none') return;
  touchIdAutoPrompted = true;
  if (touchIdAutoPromptTimer) window.clearTimeout(touchIdAutoPromptTimer);
  const start = Date.now();
  const attempt = () => {
    if (!touchIdUnlockInFlight) {
      void touchIDUnlock('auto');
      return;
    }
    if (Date.now() - start < 2500) {
      touchIdAutoPromptTimer = window.setTimeout(attempt, 250);
    }
  };
  touchIdAutoPromptTimer = window.setTimeout(attempt, 900);
}

async function loadUnlockOptions() {
  try {
    const r = await apiFetch('/api/auth/options');
    const d = await r.json();
    unlockOptions = d;
    document.getElementById('touchid-section').style.display = d.touchIdEnabled ? '' : 'none';
    document.getElementById('password-controls').style.display = d.passwordEnabled ? '' : 'none';
    document.getElementById('password-disabled-note').style.display = d.passwordEnabled ? 'none' : '';
    document.getElementById('password-section').style.display = d.passwordEnabled ? '' : '';
    if (!d.passwordEnabled && d.touchIdEnabled) {
      document.getElementById('card-sub').textContent = d.totpEnrolled
        ? 'Use Touch ID, then enter your authenticator code'
        : 'Use Touch ID to unlock';
    }
    restoreTouchIdHint();
    maybeAutoTouchIdUnlock();
  } catch {}
}
loadUnlockOptions();

document.addEventListener('visibilitychange', () => {
  maybeAutoTouchIdUnlock();
});
window.addEventListener('focus', () => maybeAutoTouchIdUnlock());
window.addEventListener('pageshow', () => maybeAutoTouchIdUnlock());

function rememberPostUnlockState(payload) {
  if (payload && typeof payload.captureWarning === 'string' && payload.captureWarning.trim()) {
    try { sessionStorage.setItem('dm_notice', payload.captureWarning.trim()); } catch {}
  }
  if (payload && payload.passwordResetRecommended === true) {
    try {
      sessionStorage.setItem('dm_recovery_password_reset_prompt', JSON.stringify({
        flow: typeof payload.passwordResetFlow === 'string' ? payload.passwordResetFlow : 'recovery',
      }))
    } catch {}
  }
}

async function touchIDUnlock(_source = 'manual') {
  if (touchIdUnlockInFlight) return;
  const btn = document.getElementById('btn-touchid');
  const err = document.getElementById('touchid-error');
  touchIdUnlockInFlight = true;
  btn.classList.add('waiting');
  btn.innerHTML = '<span class="spinner"></span>Waiting for Touch ID…';
  setTouchIdHint('Touch ID prompt opened. Place your finger on Touch ID now.');
  err.textContent = '';
  try {
    const r = await apiFetch('/api/auth/touchid', { method: 'POST' });
    const d = await r.json();
    if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return; }
    if (d.needsTotp) {
      document.getElementById('password-section').style.display = 'none';
      document.getElementById('totp-section').style.display = '';
      document.getElementById('touchid-section').style.display = 'none';
      document.getElementById('card-sub').textContent = 'Enter authenticator code';
      document.getElementById('totp-input').focus();
      btn.classList.remove('waiting');
      btn.innerHTML = TOUCHID_SVG;
      touchIdUnlockInFlight = false;
      return;
    }
    err.textContent = d.error || 'Touch ID failed';
    restoreTouchIdHint();
  } catch {
    err.textContent = 'Touch ID not available';
    restoreTouchIdHint();
  }
  btn.classList.remove('waiting');
  btn.innerHTML = TOUCHID_SVG;
  touchIdUnlockInFlight = false;
}

// Password flow
const pwInput = document.getElementById('pw-input');
const btnUnlock = document.getElementById('btn-unlock');
pwInput.addEventListener('input', () => {
  btnUnlock.disabled = pwInput.value.length < 1;
  document.getElementById('pw-error').textContent = '';
  pwInput.classList.remove('error');
});
pwInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !btnUnlock.disabled) unlock(); });
btnUnlock.addEventListener('click', unlock);

async function unlock() {
  const password = pwInput.value;
  btnUnlock.disabled = true;
  btnUnlock.innerHTML = '<span class="spinner"></span>Verifying…';
  const r = await apiFetch('/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const d = await r.json();
  if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return; }
  if (d.needsTotp) {
    // Password ok, need TOTP step
    document.getElementById('password-section').style.display = 'none';
    document.getElementById('totp-section').style.display = '';
    document.getElementById('touchid-section').style.display = 'none';
    document.getElementById('card-sub').textContent = 'Enter authenticator code';
    document.getElementById('totp-input').focus();
    btnUnlock.disabled = false; btnUnlock.textContent = 'Unlock';
    return;
  }
  pwInput.classList.add('error');
  document.getElementById('pw-error').textContent = d.error || 'Wrong password';
  btnUnlock.disabled = false; btnUnlock.textContent = 'Unlock';
  pwInput.value = '';
  setTimeout(() => pwInput.classList.remove('error'), 600);
}

// TOTP step (only if needsTotp)
const totpInput = document.getElementById('totp-input');
const btnTotp = document.getElementById('btn-totp');
totpInput.addEventListener('input', e => {
  const v = e.target.value.replace(/\\D/g,''); e.target.value = v;
  btnTotp.disabled = v.length !== 6;
  document.getElementById('totp-error').textContent = '';
  totpInput.classList.remove('error');
});
totpInput.addEventListener('keydown', e => { if (e.key==='Enter' && !btnTotp.disabled) verifyTOTP(); });
btnTotp.addEventListener('click', verifyTOTP);

async function verifyTOTP() {
  const totpToken = totpInput.value;
  btnTotp.disabled = true;
  btnTotp.innerHTML = '<span class="spinner"></span>Verifying…';
  const r = await apiFetch('/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totpToken }),
  });
  const d = await r.json();
  if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return; }
  totpInput.classList.add('error');
  document.getElementById('totp-error').textContent = d.error || 'Invalid code';
  btnTotp.disabled = false; btnTotp.textContent = 'Verify';
  totpInput.value = '';
  setTimeout(() => totpInput.classList.remove('error'), 600);
}

// Recovery
function showRecovery() {
  document.getElementById('password-section').style.display = 'none';
  document.getElementById('totp-section').style.display = 'none';
  document.getElementById('touchid-section').style.display = 'none';
  document.getElementById('recovery-section').style.display = '';
  document.getElementById('card-sub').textContent = 'Recovery access';
}
function showPassword() {
  document.getElementById('recovery-section').style.display = 'none';
  document.getElementById('password-section').style.display = '';
  document.getElementById('card-sub').textContent = 'Use a local unlock method';
  document.getElementById('touchid-section').style.display = unlockOptions.touchIdEnabled ? '' : 'none';
  document.getElementById('password-controls').style.display = unlockOptions.passwordEnabled ? '' : 'none';
  document.getElementById('password-disabled-note').style.display = unlockOptions.passwordEnabled ? 'none' : '';
}

async function unlockWithRecovery() {
  const val = document.getElementById('recovery-input').value.trim();
  const btn = document.getElementById('btn-recover');
  const error = document.getElementById('recovery-error');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Verifying…';
  error.textContent = '';
  // Detect if it looks like a mnemonic (multiple words) or a recovery code
  const isPhrase = val.split(/\\s+/).length > 4;
  const body = isPhrase
    ? { mnemonic: val }
    : { recoveryCode: val.toUpperCase() };
  try {
    const r = await apiFetch('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return; }
    error.textContent = d.error || 'Invalid code or phrase';
  } catch (err) {
    error.textContent = err instanceof Error && err.message
      ? err.message
      : 'Recovery unlock failed';
  }
  btn.disabled = false;
  btn.textContent = 'Recover access';
}
</script>
</body>
</html>`
}

function markdownPageHTML(title: string, markdown: string, version: string): string {
  const escape = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const escapeAttr = (s: string) => escape(s).replace(/"/g, '&quot;')
  const decodeBadgePart = (value: string): string => {
    try {
      return decodeURIComponent(value).replace(/--/g, '-')
    } catch {
      return value.replace(/--/g, '-')
    }
  }
  const shieldBadge = (img: string, href?: string, fallbackLabel = 'badge') => {
    const wrap = (body: string) => {
      if (!href || href === '#') return body
      if (/^https?:\/\//.test(href) || href.startsWith('#')) {
        return `<a class="md-shield-link" href="${escapeAttr(href)}"${/^https?:\/\//.test(href) ? ' target="_blank" rel="noreferrer"' : ''}>${body}</a>`
      }
      return body
    }
    try {
      const url = new URL(img)
      if (url.hostname !== 'img.shields.io') throw new Error('not shields')
      const badgePath = (url.pathname.split('/badge/')[1] || '').replace(/\.(svg|png)$/i, '')
      const parts = badgePath.split('-')
      if (parts.length < 3) throw new Error('invalid shields badge')
      const color = parts[parts.length - 1]
      const value = decodeBadgePart(parts[parts.length - 2])
      const label = decodeBadgePart(parts.slice(0, -2).join('-'))
      const safeColor = /^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color) ? `#${color}` : '#374151'
      const body = `<span class="md-shield"><span class="md-shield-label">${escape(label || fallbackLabel)}</span><span class="md-shield-value" style="background:${escapeAttr(safeColor)}">${escape(value || '')}</span></span>`
      return wrap(body)
    } catch {
      const body = `<span class="md-badge">${escape(fallbackLabel.trim() || 'badge')}</span>`
      return wrap(body)
    }
  }
  function inlineMd(s: string): string {
    const tokens: string[] = []
    const token = (html: string) => {
      const key = `@@MDTOKEN${tokens.length}@@`
      tokens.push(html)
      return key
    }
    const badge = (label: string, href?: string) => {
      const body = `<span class="md-badge">${escape(label.trim() || 'link')}</span>`
      if (!href || href === '#') return body
      if (/^https?:\/\//.test(href) || href.startsWith('#')) {
        return `<a class="md-badge-link" href="${escapeAttr(href)}"${/^https?:\/\//.test(href) ? ' target="_blank" rel="noreferrer"' : ''}>${body}</a>`
      }
      return body
    }
    const link = (label: string, href: string) => {
      if (/^https?:\/\//.test(href) || href.startsWith('#')) {
        return `<a class="lnk" href="${escapeAttr(href)}"${/^https?:\/\//.test(href) ? ' target="_blank" rel="noreferrer"' : ''}>${escape(label)}</a>`
      }
      return `<span class="lnk">${escape(label)}</span>`
    }
    let out = s
    out = out.replace(/\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g, (_m, label, img, href) => token(shieldBadge(img, href, label)))
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, label, img) => token(shieldBadge(img, undefined, label)))
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => token(link(label, href)))
    out = escape(out)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
    tokens.forEach((html, index) => {
      out = out.replace(`@@MDTOKEN${index}@@`, html)
    })
    return out
  }
  const lines = markdown.split('\n')
  const isBadgeOnlyLine = (line: string): boolean => /^(\s*\[!\[[^\]]*\]\([^)]+\)\]\([^)]+\)\s*)+$/.test(line.trim())
  let html = '', inTable = false, inCode = false, inList = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      if (inCode) { html += '</code></pre>'; inCode = false }
      else { if (inList) { html += '</ul>'; inList = false } html += '<pre><code>'; inCode = true }
      continue
    }
    if (inCode) { html += escape(line) + '\n'; continue }
    if (line.startsWith('|')) {
      if (line.replace(/[\s|:-]/g,'').length === 0) continue  // separator row
      if (!inTable) { html += '<table>'; inTable = true }
      const cells = line.split('|').filter((_,i,a) => i>0&&i<a.length-1).map(c=>`<td>${inlineMd(c.trim())}</td>`).join('')
      html += `<tr>${cells}</tr>`; continue
    }
    if (inTable) { html += '</table>'; inTable = false }
    if (/^[-*_]{3,}$/.test(line.trim())) { html += '<hr>'; continue }  // horizontal rule
    if (line.startsWith('> ')) { if(inList){html+='</ul>';inList=false} html += `<blockquote>${inlineMd(line.slice(2))}</blockquote>`; continue }
    if (line.startsWith('### ')) { if(inList){html+='</ul>';inList=false} html+=`<h3>${inlineMd(line.slice(4))}</h3>`; continue }
    if (line.startsWith('## '))  { if(inList){html+='</ul>';inList=false} html+=`<h2>${inlineMd(line.slice(3))}</h2>`; continue }
    if (line.startsWith('# '))   { if(inList){html+='</ul>';inList=false} html+=`<h1>${inlineMd(line.slice(2))}</h1>`; continue }
    if (isBadgeOnlyLine(line)) {
      const badgeLines = [line.trim()]
      while (i + 1 < lines.length && isBadgeOnlyLine(lines[i + 1])) {
        badgeLines.push(lines[++i].trim())
      }
      html += `<div class="badge-row">${badgeLines.map(part => inlineMd(part)).join('')}</div>`
      continue
    }
    if (line.startsWith('- ')||line.startsWith('* ')) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${inlineMd(line.slice(2))}</li>`; continue
    }
    if (inList) { html += '</ul>'; inList = false }
    if (line.trim()==='') continue
    html += `<p>${inlineMd(line)}</p>`
  }
  if (inTable) html += '</table>'
  if (inList)  html += '</ul>'
  if (inCode)  html += '</code></pre>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>DataMoat — ${title}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#080b0f;--surface:#0e1318;--border:#1c2430;--accent:#00c8a0;--accent2:#0088ff;--warn:#ffaa00;--text:#c8d8e8;--muted:#4a6070;--mono:ui-monospace,'SF Mono','SFMono-Regular',Menlo,Monaco,Consolas,'Liberation Mono',monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
  html,body{background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.7}
  .topbar{position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--border);padding:12px 32px;display:flex;align-items:center;gap:24px;z-index:10}
  .topbar a{font-family:var(--mono);font-size:11px;letter-spacing:2px;color:var(--muted);text-decoration:none}
  .topbar a:hover{color:var(--accent)}
  .logo{font-family:var(--mono);font-size:15px;font-weight:600;color:var(--accent);letter-spacing:0.05em}
  .logo span{color:var(--muted);font-weight:300}
  .version-badge{margin-left:auto;font-family:var(--mono);font-size:11px;letter-spacing:1px;color:var(--text);border:1px solid var(--border);border-radius:999px;padding:6px 10px;background:rgba(255,255,255,0.03)}
  .content{max-width:800px;margin:0 auto;padding:48px 32px 96px}
  h1{font-family:var(--mono);font-size:22px;color:var(--warn);margin:32px 0 16px;letter-spacing:1px}
  h2{font-family:var(--mono);font-size:16px;color:var(--accent2);margin:28px 0 12px;letter-spacing:1px;border-bottom:1px solid var(--border);padding-bottom:8px}
  h3{font-family:var(--mono);font-size:13px;color:var(--text);margin:20px 0 8px}
  p{font-size:14px;color:var(--text);margin:6px 0}
  pre{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:14px 18px;overflow-x:auto;margin:12px 0}
  code{font-family:var(--mono);font-size:12px;color:var(--accent2)}
  pre code{color:var(--text)}
  ul{padding-left:20px;margin:8px 0}
  li{font-size:14px;margin:4px 0}
  table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13px}
  td{padding:8px 12px;border:1px solid var(--border)}
  tr:nth-child(even) td{background:rgba(255,255,255,0.02)}
  strong{color:var(--accent);font-weight:500}
  hr{border:none;border-top:1px solid var(--border);margin:24px 0}
  .lnk{color:var(--accent2);text-decoration:none}
  .lnk:hover{text-decoration:underline}
  blockquote{margin:14px 0;padding:12px 16px;border-left:3px solid var(--accent);background:rgba(255,255,255,0.03);font-size:15px}
  .badge-row{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 14px}
  .md-badge{display:inline-flex;align-items:center;padding:4px 10px;border:1px solid var(--border);border-radius:999px;background:rgba(255,255,255,0.04);font-family:var(--mono);font-size:11px;letter-spacing:.5px;color:var(--text)}
  .md-badge-link{text-decoration:none}
  .md-badge-link:hover .md-badge{border-color:var(--accent2);color:var(--accent2)}
  .md-shield-link{text-decoration:none}
  .md-shield{display:inline-flex;align-items:center;border-radius:4px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);font-family:var(--mono);font-size:11px;line-height:1;box-shadow:0 1px 0 rgba(0,0,0,0.14)}
  .md-shield-label{padding:5px 8px;background:#1f2937;color:#e5e7eb}
  .md-shield-value{padding:5px 8px;color:#ffffff}
  .md-shield-link:hover .md-shield{box-shadow:0 0 0 1px rgba(43,196,109,0.35)}
  .gap{height:8px}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">data<span>moat</span></div>
  <a href="/">← Back to vault</a>
  <a href="/about">About</a>
<div class="version-badge">v${escape(version)}</div>
</div>
<div class="content">${html}</div>
<script>
  function dmCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[-/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&') + '=([^;]+)'))
    return match ? decodeURIComponent(match[1]) : ''
  }
  function apiFetch(url, options) {
    const opts = options ? { ...options } : {}
    const method = ((opts.method || 'GET') || 'GET').toUpperCase()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const token = dmCookie('dm_csrf')
      if (token) {
        const headers = new Headers(opts.headers || {})
        if (!headers.has('X-DM-CSRF')) headers.set('X-DM-CSRF', token)
        opts.headers = headers
      }
    }
    return fetch(url, opts)
  }
  (async () => {
    const nav = performance.getEntriesByType('navigation')[0]
    if (nav && nav.type === 'reload') {
      try { await apiFetch('/api/auth/logout', { method: 'POST' }) } catch {}
      window.location.replace('/unlock')
    }
  })()
</script>
</body>
</html>`
}
