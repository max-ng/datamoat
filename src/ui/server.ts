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
  forEachSessionMessageLineBatch,
  readAttachment,
  readPublicStatus,
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
import { DATAMOAT_ROOT, UI_PORT_RANGE } from '../config'
import {
  isSetupDone, loadAuthConfig, saveAuthConfig,
  generateTOTPSecret, verifyTOTP, generateMnemonic,
  sha256, totpURL,
  hashPassword, verifyPassword,
  normalizeMnemonic,
  AUTH_SCHEMA_VERSION, deleteAuthConfig,
  backupAuthConfigForMigration, passwordHashNeedsMigration, retireRecoveryCodeFields,
} from '../auth'
import { authConfigHasTouchId, shouldExposeTouchIdUnlock } from '../auth-options'
import { IS_MAC, secureEnclaveStatus, backgroundCaptureSecretDelete } from '../keychain'
import { updateHealth, writeAuditEvent, writeLog } from '../logging'
import { BootstrapImportProgress, getWatcherStartupProgress, importBootstrapCaptureIntoVault, startWatchers, stopWatchers } from '../watcher'
import { ensureBackgroundCaptureConfigured, startBackgroundCapture, stopBackgroundCapture } from '../background-capture'
import {
  createVaultSession,
  decryptBytesForSession,
  encryptBytesForSession,
  lockVaultSession,
  restartVaultHelper,
  resetTouchIdKey,
  unwrapSecretToSession,
  unwrapTouchIdToSession,
  wrapSecretForSession,
  wrapTouchIdForSession,
} from '../vault-helper'
import { triggerDetachedUpdate } from '../auto-update'
import { currentRuntimeBuildId } from '../runtime'
import { inspectReinstallSource, recordedReinstallSource, triggerDetachedReinstall } from '../reinstall'
import { checkForUpdate, updateBlockReason } from '../update'
import {
  loadAppConfig,
  loadUpdateState,
  writeUpdateState,
  saveAppConfig,
  isUpdateRunning,
} from '../update-config'
import { bootstrapCaptureSummary } from '../bootstrap-capture'
import { extractClaudeLine } from '../extractors/claude'
import { extractCodexLine } from '../extractors/codex'
import { extractOpenclawLine } from '../extractors/openclaw'
import { extractCursorLine } from '../extractors/cursor'
import { detectInstallContext } from '../install-context'
import { updateReleasesUrl } from '../update-channel'
import {
  readSkillFileForUI,
  readSkillManifestForUI,
  readSkillsBackupIndexForUI,
  scanAndBackupSkills,
} from '../skills-backup'
import {
  queueReferencedAttachmentBackfill,
  readReferencedAttachmentsForSessionUI,
  referencedAttachmentStatus,
  scheduleReferencedAttachmentBackfillAfterUnlock,
  setReferencedAttachmentBackupEnabled,
} from '../referenced-attachments'
import {
  openTransferFolder,
  transferExportStatus,
  writeTransferManifest,
} from '../transfer-export'
import {
  cancelTransferImport,
  currentTransferImportJob,
  preflightTransferSource,
  resumeTransferImport,
  runTransferImport,
  verifyTransferredRootCanLoadSessions,
} from '../transfer-import'
import type { TransferMode } from '../transfer-types'

type SessionFlow =
  | 'touchid'
  | 'touchid_totp'
  | 'password'
  | 'password_totp'
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
}

type SetupActivationProgress = {
  running: boolean
  phase: string
  label: string
  detail: string
  percent: number | null
  importedFiles: number
  totalFiles: number
  importedMessages: number
  progressUnit?: string
  progressText?: string
  stepText?: string
  processedSessions?: number
  totalSessions?: number
  discoveredSessions?: number
  sourceRecordsProcessed?: number
  sourceRecordsTotal?: number
  elapsedLabel?: string
  done: boolean
  updatedAt: string | null
}

type AuthMethod = 'password' | 'totp' | 'mnemonic' | 'touchid'
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
  mnemonic: 15 * 60 * 1000,
}

const AUTH_BACKOFF_BASE_MS = 1000
const AUTH_BACKOFF_MAX_MS = 5 * 60 * 1000
const AUTH_RESET_AFTER_MS = 15 * 60 * 1000
const SESSION_DETAIL_PAGE_LIMIT = 500
const SEARCH_MESSAGE_PAGE_LIMIT = 250
const BACKGROUND_CAPTURE_RETRY_THROTTLE_MS = 30000
const CSRF_COOKIE = 'dm_csrf'
const CSRF_HEADER = 'x-dm-csrf'
const authAttempts = new Map<AuthMethod, AuthAttemptState>()
let activeSession: { token: string; flow: SessionFlow; idleMs: number; expiresAt: number } | null = null
let pendingAuth: { token: string; flow: SessionFlow; helperSessionId: string; expiresAt: number } | null = null
let pendingSetup: PendingSetupState | null = null
let pendingSetupInit: Promise<SetupInitPayload> | null = null
let backgroundCaptureRetryInFlight = false
let lastBackgroundCaptureRetryAt = 0
let touchIdRepairNeeded = false
let touchIdRepairReason = ''
let activeUiServer: http.Server | null = null
let setupActivationProgress: SetupActivationProgress = {
  running: false,
  phase: 'idle',
  label: 'Waiting to activate setup',
  detail: '',
  percent: null,
  importedFiles: 0,
  totalFiles: 0,
  importedMessages: 0,
  done: false,
  updatedAt: null,
}

type SetupInitPayload = {
  setupNonce: string
  secret: string
  mnemonic: string
  qrDataUrl: string
  platform: NodeJS.Platform
  touchIdSupportedPlatform: boolean
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

function readAboutMarkdown(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'README.public.md'),
    path.join(__dirname, '..', '..', 'README.md'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
  }
  return [
    '# DataMoat',
    '',
    'DataMoat backs up supported local AI conversation records into an encrypted local vault.',
    '',
    'This packaged build does not include the full README file. Open Settings to check the current update path, or use the project release page for the latest packaged installer.',
  ].join('\n')
}

export function hasAuthenticatedUiSession(): boolean {
  return !!activeSession && activeSession.expiresAt > Date.now() && hasVaultSession()
}

function authMethodLabel(method: AuthMethod): string {
  switch (method) {
    case 'password': return 'password'
    case 'totp': return 'authenticator'
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
      platform: process.platform,
      touchIdSupportedPlatform: IS_MAC,
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

function recoveryUnlockFlow(flow: SessionFlow | null | undefined): flow is 'mnemonic' {
  return flow === 'mnemonic'
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

function updateSetupActivationProgress(progress: Partial<SetupActivationProgress>): void {
  setupActivationProgress = {
    ...setupActivationProgress,
    ...progress,
    updatedAt: new Date().toISOString(),
  }
}

function setupActivationProgressSnapshot(): SetupActivationProgress & Record<string, unknown> {
  const progress = { ...setupActivationProgress } as SetupActivationProgress & Record<string, unknown>
  if (!progress.running || progress.done || progress.phase !== 'scanning') return progress

  const watcherProgress = getWatcherStartupProgress()
  if (watcherProgress.mode !== 'vault') return progress
  if (!watcherProgress.running && watcherProgress.phase === 'idle' && watcherProgress.queuedSessions === 0) return progress

  const queuedRecords = watcherProgress.queuedSessions
  const processedRecords = watcherProgress.processedSessions
  const visibleSessions = Math.max(0, Number(readPublicStatus()?.totalSessions || 0))
  const elapsedMs = watcherProgress.startedAt
    ? Math.max(0, Date.now() - Date.parse(watcherProgress.startedAt))
    : 0
  const elapsedSeconds = Math.floor(elapsedMs / 1000)
  const elapsedLabel = elapsedSeconds >= 60
    ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
    : `${elapsedSeconds}s`
  const hasKnownTotal = queuedRecords > 0
  const scanPercent = hasKnownTotal
    ? Math.max(0, Math.min(100, (processedRecords / Math.max(queuedRecords, 1)) * 100))
    : null
  const current = watcherProgress.currentSource
    ? `${watcherProgress.currentSource}${watcherProgress.currentSession ? ` · ${watcherProgress.currentSession}` : ''}`
    : ''
  const progressText = hasKnownTotal && scanPercent !== null
    ? `${Math.round(scanPercent)}%`
    : (elapsedLabel || 'scanning')

  return {
    ...progress,
    phase: hasKnownTotal ? 'processing' : 'discovering',
    label: visibleSessions > 0 ? 'Building session index' : 'Scanning local AI work records',
    detail: visibleSessions > 0
      ? `Building the session index. The final session count will appear after indexing${current ? ` · ${current}` : ''}.`
      : `Reading supported local Claude, Codex, Cursor, OpenClaw, and agent records before opening${current ? ` · ${current}` : ''}.`,
    percent: scanPercent,
    importedFiles: visibleSessions,
    totalFiles: 0,
    discoveredSessions: 0,
    processedSessions: visibleSessions,
    totalSessions: 0,
    sourceRecordsProcessed: processedRecords,
    sourceRecordsTotal: queuedRecords,
    progressUnit: 'sessions',
    progressText,
    stepText: visibleSessions > 0 ? 'Indexing sessions' : 'Scanning local records',
    elapsedSeconds,
    elapsedLabel,
    watcherReady: watcherProgress.ready,
    watcherRunning: watcherProgress.running,
  }
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
    bootstrapImportProgress?: (progress: BootstrapImportProgress) => void
    setupProgress?: (progress: Partial<SetupActivationProgress>) => void
  } = {},
): Promise<{ backgroundConfigured: boolean; backgroundStarted: boolean; captureWarning: string | null }> {
  const report = (progress: Partial<SetupActivationProgress>): void => {
    const phase = progress.phase
    const activePhase = phase !== 'done' && phase !== 'error'
    options.setupProgress?.({
      ...progress,
      running: activePhase,
      done: phase === 'done' ? true : activePhase ? false : progress.done,
    })
  }
  writeLog('info', 'auth', 'activate_vault_started', {
    skipBackgroundCaptureSetup: !!options.skipBackgroundCaptureSetup,
    skipBackgroundCaptureStart: !!options.skipBackgroundCaptureStart,
    skipWatcherStart: !!options.skipWatcherStart,
    suppressCaptureWarning: !!options.suppressCaptureWarning,
  })
  report({
    running: true,
    phase: 'sealing',
    label: 'Creating encrypted vault',
    detail: 'Setting up local-only encrypted storage on this Mac.',
    percent: 8,
  })
  setVaultSession(helperSessionId)
  writeLog('info', 'auth', 'activate_vault_step', { step: 'auth_config_migration_start' })
  await safeMigrateAuthConfigProtectedFields(helperSessionId)
  writeLog('info', 'auth', 'activate_vault_step', { step: 'auth_config_migration_done' })
  let backgroundConfigured = false
  if (!options.skipBackgroundCaptureSetup) {
    report({
      phase: 'background',
      label: 'Preparing locked background capture',
      detail: 'Saving a local OS-protected capture key so DataMoat can keep working while locked.',
      percent: 18,
    })
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
  report({
    phase: 'sealing',
    label: 'Sealing existing encrypted files',
    detail: 'Migrating any previous vault, attachment, and state files into the current encrypted format.',
    percent: 28,
  })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_vault_files_start' })
  await encryptVaultFiles()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_vault_files_done' })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_attachment_files_start' })
  await encryptAttachmentFiles()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_attachment_files_done' })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_state_files_start' })
  await encryptStateFiles()
  writeLog('info', 'auth', 'activate_vault_step', { step: 'encrypt_state_files_done' })
  const bootstrapBeforeImport = bootstrapCaptureSummary()
  if (bootstrapBeforeImport.enabled || bootstrapBeforeImport.entries > 0) {
    writeLog('info', 'auth', 'activate_vault_step', { step: 'bootstrap_watchers_stop_start', ...bootstrapBeforeImport })
    await stopWatchers()
    writeLog('info', 'auth', 'activate_vault_step', { step: 'bootstrap_watchers_stop_done' })
  }
  report({
    phase: 'importing',
    label: bootstrapBeforeImport.entries > 0 ? 'Importing protected pre-setup capture' : 'Checking pre-setup capture',
    detail: bootstrapBeforeImport.entries > 0
      ? 'Moving protected records into the encrypted vault.'
      : 'Checking protected records before opening.',
    percent: 42,
    totalFiles: bootstrapBeforeImport.entries,
    progressUnit: 'pre-setup records',
  })
  writeLog('info', 'auth', 'activate_vault_step', { step: 'bootstrap_import_start' })
  const bootstrapImport = await importBootstrapCaptureIntoVault(options.bootstrapImportProgress)
  writeLog('info', 'auth', 'activate_vault_step', { step: 'bootstrap_import_done', ...bootstrapImport })
  report({
    phase: 'indexing',
    label: 'Building session index',
    detail: 'Preparing the session list before the app opens.',
    percent: 58,
  })
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
    const visibleSessions = Math.max(0, Number(readPublicStatus()?.totalSessions || 0))
    report({
      phase: 'scanning',
      label: visibleSessions > 0 ? 'Building session index' : 'Scanning local AI work records',
      detail: visibleSessions > 0
        ? 'Building the session index. The final session count will appear after indexing.'
        : 'Reading supported local Claude, Codex, Cursor, OpenClaw, and agent records before opening.',
      percent: null,
      importedFiles: visibleSessions,
      totalFiles: 0,
      processedSessions: visibleSessions,
      totalSessions: 0,
      discoveredSessions: 0,
      progressUnit: 'sessions',
      progressText: visibleSessions > 0 ? 'indexing' : 'scanning',
      stepText: visibleSessions > 0 ? 'Indexing sessions' : 'Scanning local records',
    })
    backgroundStarted = await startBackgroundCapture({ parserReparse: 'skip' })
    writeLog('info', 'auth', 'activate_vault_step', { step: 'background_start_done', backgroundStarted })
  }
  if (!backgroundStarted && !options.skipWatcherStart) {
    writeLog('info', 'auth', 'activate_vault_step', { step: 'watchers_start_start' })
    writeLog('info', 'parser-reparse', 'foreground_watcher_reparse_deferred')
    const visibleSessions = Math.max(0, Number(readPublicStatus()?.totalSessions || 0))
    report({
      phase: 'scanning',
      label: visibleSessions > 0 ? 'Building session index' : 'Scanning local AI work records',
      detail: visibleSessions > 0
        ? 'Building the session index. The final session count will appear after indexing.'
        : 'Reading supported local Claude, Codex, Cursor, OpenClaw, and agent records before opening.',
      percent: null,
      importedFiles: visibleSessions,
      totalFiles: 0,
      processedSessions: visibleSessions,
      totalSessions: 0,
      discoveredSessions: 0,
      progressUnit: 'sessions',
      progressText: visibleSessions > 0 ? 'indexing' : 'scanning',
      stepText: visibleSessions > 0 ? 'Indexing sessions' : 'Scanning local records',
    })
    await startWatchers('vault')
    writeLog('info', 'auth', 'activate_vault_step', { step: 'watchers_start_done' })
  } else if (!backgroundStarted && options.skipWatcherStart) {
    writeLog('info', 'auth', 'activate_vault_step', { step: 'watchers_start_deferred' })
  }
  writeLog('info', 'auth', 'activate_vault_step', { step: 'skills_backup_scan_start' })
    report({
      phase: 'skills',
      label: 'Backing up skills folders',
      detail: 'Saving full supported skills folder contents into the encrypted vault.',
      percent: null,
      importedFiles: 0,
      totalFiles: 0,
      progressUnit: 'skills folders',
      progressText: 'backing up',
      stepText: 'Backing up skills',
      processedSessions: 0,
      totalSessions: 0,
      discoveredSessions: 0,
      sourceRecordsProcessed: 0,
      sourceRecordsTotal: 0,
    })
  const skillsBackup = await scanAndBackupSkills('vault_activated')
  writeLog('info', 'auth', 'activate_vault_step', {
    step: 'skills_backup_scan_done',
    skillsBackedUp: skillsBackup?.skillsBackedUp ?? 0,
    filesBackedUp: skillsBackup?.filesBackedUp ?? 0,
  })
  // Keep unlock/setup on the critical path small. Large existing vaults can
  // contain many stale transcript paths; any consented backfill is delayed.
  updateHealth('referenced-attachments', {
    running: false,
    lastScanSkippedAt: new Date().toISOString(),
    lastScanSkipReason: 'vault_activation_immediate_backfill_disabled',
  })
  scheduleReferencedAttachmentBackfillAfterUnlock('unlock-idle')
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
  report({
    phase: 'done',
    label: 'Setup complete',
    detail: 'Opening DataMoat now.',
    percent: 100,
    done: true,
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
  flow: Extract<SessionFlow, 'mnemonic'>,
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

    const backgroundStarted = captureSessionPresent || await startBackgroundCapture({ parserReparse: 'skip' })
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

async function activateVaultForSetup(
  helperSessionId: string,
  bootstrapImportProgress?: (progress: BootstrapImportProgress) => void,
  setupProgress?: (progress: Partial<SetupActivationProgress>) => void,
): Promise<Awaited<ReturnType<typeof activateVault>>> {
  return activateVault(helperSessionId, {
    suppressCaptureWarning: true,
    bootstrapImportProgress,
    setupProgress,
  })
}

async function retryBackgroundCaptureForActiveVault(reason: string): Promise<void> {
  const helperSessionId = getVaultSessionId()
  if (!helperSessionId || getCaptureSessionId()) return

  const now = Date.now()
  if (backgroundCaptureRetryInFlight || now - lastBackgroundCaptureRetryAt < BACKGROUND_CAPTURE_RETRY_THROTTLE_MS) {
    return
  }

  backgroundCaptureRetryInFlight = true
  lastBackgroundCaptureRetryAt = now
  try {
    writeLog('info', 'capture', 'background_capture_auto_retry_started', { reason })
    const backgroundConfigured = await ensureBackgroundCaptureConfigured(helperSessionId, {
      forceReconfigure: true,
      reason,
    })
    const backgroundStarted = await startBackgroundCapture({ parserReparse: 'skip' })
    updateHealth('capture', {
      configured: backgroundConfigured,
      running: backgroundStarted,
      lastAutoRetryAt: new Date().toISOString(),
      lastErrorAt: backgroundStarted ? null : new Date().toISOString(),
      lastError: backgroundStarted ? null : 'background capture auto retry did not start',
    })
    updateHealth('daemon', {
      captureRunning: backgroundStarted,
    })
    writeAuditEvent('capture', 'background_capture_auto_retry_completed', {
      reason,
      backgroundConfigured,
      backgroundStarted,
    })
  } catch (error) {
    writeLog('warn', 'capture', 'background_capture_auto_retry_failed', { reason, error })
    updateHealth('capture', {
      configured: false,
      running: false,
      lastAutoRetryAt: new Date().toISOString(),
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    })
    writeAuditEvent('capture', 'background_capture_auto_retry_failed', { reason })
  } finally {
    backgroundCaptureRetryInFlight = false
  }
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

function wrapSaltNeedsMigration(salt: string | undefined): boolean {
  return !!salt && !salt.startsWith('pbkdf2:v2:')
}

async function migrateAuthConfigProtectedFields(
  helperSessionId: string,
  secrets: { password?: string; mnemonic?: string } = {},
): Promise<void> {
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

  const retiredFields = retireRecoveryCodeFields(config)
  migratedFields.push(...retiredFields.map(field => `retired:${field}`))

  if (secrets.password && config.passwordHash && passwordHashNeedsMigration(config.passwordHash)) {
    config.passwordHash = await hashPassword(secrets.password)
    migratedFields.push('passwordHash:scrypt-v2')
  }

  if (
    secrets.password
    && config.passwordWrappedVaultKey
    && config.passwordWrapSalt
    && wrapSaltNeedsMigration(config.passwordWrapSalt)
  ) {
    const wrapped = await wrapSecretForSession(helperSessionId, secrets.password)
    config.passwordWrappedVaultKey = wrapped.blob
    config.passwordWrapSalt = wrapped.salt
    migratedFields.push('passwordWrappedVaultKey:pbkdf2-v2')
  }

  if (
    secrets.mnemonic
    && config.mnemonicWrappedVaultKey
    && config.mnemonicWrapSalt
    && wrapSaltNeedsMigration(config.mnemonicWrapSalt)
  ) {
    const wrapped = await wrapSecretForSession(helperSessionId, normalizeMnemonic(secrets.mnemonic))
    config.mnemonicWrappedVaultKey = wrapped.blob
    config.mnemonicWrapSalt = wrapped.salt
    migratedFields.push('mnemonicWrappedVaultKey:pbkdf2-v2')
  }

  if (originalSchemaVersion < AUTH_SCHEMA_VERSION) {
    migratedFields.push('schemaVersion')
  }

  if (migratedFields.length === 0) return

  backupAuthConfigForMigration()
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

async function safeMigrateAuthConfigProtectedFields(
  helperSessionId: string,
  secrets: { password?: string; mnemonic?: string } = {},
): Promise<void> {
  try {
    await migrateAuthConfigProtectedFields(helperSessionId, secrets)
  } catch (error) {
    writeLog('warn', 'auth', 'auth_config_migration_failed', { error })
    updateHealth('auth', {
      lastMigrationErrorAt: new Date().toISOString(),
      lastMigrationError: error instanceof Error ? error.message : String(error),
    })
  }
}

function markTouchIdRepairNeeded(error: unknown): void {
  touchIdRepairNeeded = true
  touchIdRepairReason = error instanceof Error ? error.message : String(error)
  const config = loadAuthConfig()
  if (config) {
    config.touchIdRefreshRequired = true
    config.touchIdRefreshRequiredAt = new Date().toISOString()
    saveAuthConfig(config)
  }
  writeLog('warn', 'auth', 'touchid_repair_needed', { reason: touchIdRepairReason })
  updateHealth('auth', {
    touchIdRepairNeeded: true,
    lastTouchIdFailureAt: new Date().toISOString(),
    lastTouchIdFailure: touchIdRepairReason,
  })
}

function touchIdNeedsPasswordRefresh(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return message.includes('secure enclave key missing')
    || message.includes('secure enclave unwrap failed')
    || message.includes('cryptotokenkit error -3')
    || message.includes('unwrap_touchid did not respond')
    || message.includes('touch id helper did not respond')
    || message.includes('vault helper did not become ready')
    || message.includes('vault helper failed to start')
    || message.includes('vault helper exited')
    || message.includes('vault helper restarted')
}

async function wrapAndVerifyTouchIdForSession(helperSessionId: string): Promise<string> {
  const blob = await wrapTouchIdForSession(helperSessionId)
  let verifiedSessionId: string | null = null
  try {
    verifiedSessionId = await unwrapTouchIdToSession(blob)
    if (!verifiedSessionId) throw new Error('Touch ID verification returned no session')
    return blob
  } finally {
    if (verifiedSessionId && verifiedSessionId !== helperSessionId) {
      try {
        await lockVaultSession(verifiedSessionId)
      } catch (error) {
        writeLog('warn', 'auth', 'touchid_verify_session_lock_failed', { error })
      }
    }
  }
}

async function repairTouchIdWrapAfterUnlock(
  helperSessionId: string,
  trigger: 'password_unlock' | 'password_totp_unlock' | 'mnemonic_unlock',
): Promise<{ repaired: boolean }> {
  const config = loadAuthConfig()
  if (!config || !(config.touchIdEnabled || config.touchIdWrappedVaultKey)) {
    touchIdRepairNeeded = false
    touchIdRepairReason = ''
    return { repaired: false }
  }
  const hadRepairFlag = touchIdRepairNeeded || !!config.touchIdRefreshRequired

  try {
    const touchIdStatus = await secureEnclaveStatus()
    if (!touchIdStatus.available) {
      writeLog('warn', 'auth', 'touchid_repair_skipped_unavailable', {
        trigger,
        reason: touchIdStatus.reason,
      })
      updateHealth('auth', {
        touchIdRepairNeeded: true,
        lastTouchIdRepairSkippedAt: new Date().toISOString(),
        lastTouchIdRepairSkippedReason: touchIdStatus.reason || 'Touch ID unavailable',
      })
      return { repaired: false }
    }

    if (hadRepairFlag) await resetTouchIdKey()
    config.touchIdEnabled = true
    config.touchIdWrappedVaultKey = await wrapAndVerifyTouchIdForSession(helperSessionId)
    delete config.touchIdRefreshRequired
    delete config.touchIdRefreshRequiredAt
    saveAuthConfig(config)
    touchIdRepairNeeded = false
    const repairedReason = touchIdRepairReason
    touchIdRepairReason = ''
    updateHealth('auth', {
      touchIdEnabled: true,
      touchIdRepairNeeded: false,
      lastTouchIdRefreshedAt: new Date().toISOString(),
      lastTouchIdRefreshTrigger: trigger,
      ...(hadRepairFlag ? { lastTouchIdRepairedAt: new Date().toISOString(), lastTouchIdRepairTrigger: trigger } : {}),
    })
    writeAuditEvent('auth', hadRepairFlag ? 'touchid_repaired_after_unlock' : 'touchid_refreshed_after_unlock', {
      trigger,
      ...(hadRepairFlag ? { previousFailure: repairedReason } : {}),
    })
    writeLog('info', 'auth', hadRepairFlag ? 'touchid_repaired_after_unlock' : 'touchid_refreshed_after_unlock', { trigger })
    return { repaired: hadRepairFlag }
  } catch (error) {
    writeLog('warn', 'auth', 'touchid_repair_failed', { trigger, error })
    updateHealth('auth', {
      touchIdRepairNeeded: true,
      lastTouchIdRepairErrorAt: new Date().toISOString(),
      lastTouchIdRepairError: error instanceof Error ? error.message : String(error),
    })
    return { repaired: false }
  }
}

function scheduleTouchIdRepairAfterUnlock(
  helperSessionId: string,
  trigger: 'password_unlock' | 'password_totp_unlock' | 'mnemonic_unlock',
): void {
  setTimeout(() => {
    void repairTouchIdWrapAfterUnlock(helperSessionId, trigger)
  }, 0)
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
    res.json({
      pid: process.pid,
      version: appVersion(),
      buildId: currentRuntimeBuildId(),
      dataRoot: DATAMOAT_ROOT,
      route: isSetupDone() ? 'unlock' : 'setup',
      platform: process.platform,
      touchIdSupportedPlatform: IS_MAC,
    })
  })

  // ── Setup (first run only) ─────────────────────────────────────────────────

  app.get('/setup', (_req, res) => {
    if (isSetupDone()) return res.redirect('/unlock')
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.send(setupPageHTML())
  })

  app.post('/api/setup/init', async (_req, res) => {
    if (isSetupDone()) return res.json({ error: 'already setup' })
    updateSetupActivationProgress({
      running: false,
      phase: 'idle',
      label: 'Waiting to activate setup',
      detail: '',
      percent: null,
      importedFiles: 0,
      totalFiles: 0,
      importedMessages: 0,
      progressUnit: undefined,
      progressText: undefined,
      stepText: undefined,
      processedSessions: 0,
      totalSessions: 0,
      discoveredSessions: 0,
      sourceRecordsProcessed: 0,
      sourceRecordsTotal: 0,
      elapsedLabel: undefined,
      done: false,
    })
    res.json(await setupInitPayload())
  })

  app.get('/api/setup/progress', (_req, res) => {
    res.json(setupActivationProgressSnapshot())
  })

  app.post('/api/setup/reset', (_req, res) => {
    pendingSetup = null
    updateSetupActivationProgress({
      running: false,
      phase: 'idle',
      label: 'Waiting to activate setup',
      detail: '',
      percent: null,
      importedFiles: 0,
      totalFiles: 0,
      importedMessages: 0,
      progressUnit: undefined,
      progressText: undefined,
      stepText: undefined,
      processedSessions: 0,
      totalSessions: 0,
      discoveredSessions: 0,
      sourceRecordsProcessed: 0,
      sourceRecordsTotal: 0,
      elapsedLabel: undefined,
      done: false,
    })
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
    pendingSetup = {
      ...pendingSetup,
      passwordEnabled: wantsPassword,
      touchIdEnabled: wantsTouchId,
      password: wantsPassword ? password : undefined,
      totpEnrolled,
    }
    writeAuditEvent('setup', 'auth_material_prepared', {
      passwordEnabled: wantsPassword,
      touchIdEnabled: wantsTouchId,
      totpEnrolled,
    })
    res.json({ ok: true })
  })

  app.post('/api/setup/activate', async (req, res) => {
    if (isSetupDone()) return res.json({ error: 'already setup' })
    const { setupNonce } = req.body as { setupNonce?: string }
    if (!pendingSetup || !setupNonce || setupNonce !== pendingSetup.nonce) {
      return res.status(400).json({ error: 'Setup expired. Restart from step 1.' })
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
      if (wantsTouchId) authRecord.touchIdWrappedVaultKey = await wrapAndVerifyTouchIdForSession(helperSessionId)

      const mnemonicWrapped = await wrapSecretForSession(helperSessionId, normalizeMnemonic(pendingSetup.mnemonic))
      authRecord.mnemonicWrappedVaultKey = mnemonicWrapped.blob
      authRecord.mnemonicWrapSalt = mnemonicWrapped.salt

      saveAuthConfig(authRecord)
      updateSetupActivationProgress({
        running: true,
        phase: 'starting',
        label: 'Starting first-run setup',
        detail: 'DataMoat is preparing local encrypted storage.',
        percent: 4,
        importedFiles: 0,
        totalFiles: bootstrapCaptureSummary().entries,
        importedMessages: 0,
        progressUnit: 'pre-setup records',
        progressText: undefined,
        stepText: undefined,
        processedSessions: 0,
        totalSessions: 0,
        discoveredSessions: 0,
        sourceRecordsProcessed: 0,
        sourceRecordsTotal: 0,
        elapsedLabel: undefined,
        done: false,
      })
      const activation = await activateVaultForSetup(helperSessionId, progress => {
        const total = progress.totalFiles
        const imported = progress.importedFiles
        const pct = total > 0
          ? Math.max(42, Math.min(58, 42 + (imported / total) * 16))
          : 48
        updateSetupActivationProgress({
          running: !progress.done,
          phase: 'importing',
          label: total > 0 ? 'Importing protected pre-setup capture' : 'Checking pre-setup capture',
          detail: total > 0
            ? 'Moving protected records into the encrypted vault.'
            : 'Checking protected records before opening.',
          percent: pct,
          importedFiles: progress.importedFiles,
          totalFiles: progress.totalFiles,
          importedMessages: progress.importedMessages,
          progressUnit: 'pre-setup records',
          progressText: undefined,
          stepText: undefined,
          processedSessions: 0,
          totalSessions: 0,
          discoveredSessions: 0,
          sourceRecordsProcessed: progress.importedFiles,
          sourceRecordsTotal: progress.totalFiles,
          done: progress.done,
        })
      }, updateSetupActivationProgress)
      updateSetupActivationProgress({
        running: false,
        phase: 'done',
        label: 'Setup complete',
        detail: 'Opening DataMoat now.',
        percent: 100,
        importedFiles: setupActivationProgress.importedFiles,
        totalFiles: setupActivationProgress.totalFiles,
        importedMessages: setupActivationProgress.importedMessages,
        progressUnit: undefined,
        progressText: undefined,
        stepText: undefined,
        processedSessions: Math.max(0, Number(readPublicStatus()?.totalSessions || 0)),
        totalSessions: 0,
        discoveredSessions: 0,
        sourceRecordsProcessed: setupActivationProgress.sourceRecordsProcessed || 0,
        sourceRecordsTotal: setupActivationProgress.sourceRecordsTotal || 0,
        elapsedLabel: undefined,
        done: true,
      })
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
    } catch (error) {
      updateSetupActivationProgress({
        running: false,
        phase: 'error',
        label: 'Setup failed',
        detail: error instanceof Error ? error.message : String(error),
        percent: null,
        done: false,
      })
      writeLog('error', 'setup', 'setup_activate_failed', { error })
      updateHealth('setup', {
        lastErrorAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      })
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
    const installMode = detectInstallContext().mode
    const touchIdConfigured = shouldExposeTouchIdUnlock(config, installMode, false)
    let touchIdRefreshRequired = !!config.touchIdRefreshRequired
    if (touchIdConfigured && !touchIdRefreshRequired) {
      const touchIdStatus = await secureEnclaveStatus()
      touchIdRefreshRequired = !touchIdStatus.available
      if (touchIdRefreshRequired) {
        config.touchIdRefreshRequired = true
        config.touchIdRefreshRequiredAt = new Date().toISOString()
        saveAuthConfig(config)
      }
    }
    res.json({
      passwordEnabled: !!(config.passwordEnabled ?? config.passwordHash),
      touchIdEnabled: touchIdConfigured && !touchIdRefreshRequired,
      touchIdRefreshRequired,
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
      config.touchIdWrappedVaultKey = await wrapAndVerifyTouchIdForSession(helperSessionId)
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
      hasUnsupportedRecoveryMethod: typeof req.body?.recoveryCode === 'string' && req.body.recoveryCode.length > 0,
      hasMnemonic: typeof req.body?.mnemonic === 'string' && req.body.mnemonic.length > 0,
    })
    if (!isSetupDone()) return res.status(400).json({ error: 'not setup' })
    const config = loadAuthConfig()
    if (!config) return res.status(500).json({ error: 'config missing' })

    const { password, totpToken, mnemonic } = req.body as {
      password?: string; totpToken?: string; mnemonic?: string
    }

    if (typeof req.body?.recoveryCode === 'string' && req.body.recoveryCode.length > 0) {
      writeAuditEvent('auth', 'unsupported_recovery_method_submitted')
      return res.status(400).json({ error: 'Invalid recovery method' })
    }

    // Pending TOTP second step
    if (totpToken && !password) {
      if (!ensureAuthAllowed('totp', res)) return
      if (!hasValidPending(req) || !pendingAuth) {
        writeLog('info', 'auth', 'totp_pending_unlock_missing')
        clearPendingAuth(res)
        return res.status(409).json({
          error: 'Unlock request expired. Start unlock again.',
          restartAuth: true,
        })
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
        if (flow === 'password_totp') scheduleTouchIdRepairAfterUnlock(helperSessionId, 'password_totp_unlock')
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
        await safeMigrateAuthConfigProtectedFields(helperSessionId, { mnemonic })
        const touchIdRepair = await repairTouchIdWrapAfterUnlock(helperSessionId, 'mnemonic_unlock')
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
          ...(touchIdRepair.repaired ? { touchIdRepaired: true } : {}),
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

    await safeMigrateAuthConfigProtectedFields(helperSessionId, { password })

    // If TOTP enrolled, also verify the TOTP token
    if (config.totpEnrolled) {
      clearAuthAttempts(['password'])
      beginPendingAuth(helperSessionId, 'password_totp', res)
      return res.json({ ok: false, needsTotp: true })
    }

    try {
      const activation = await activateVault(helperSessionId)
      scheduleTouchIdRepairAfterUnlock(helperSessionId, 'password_unlock')
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
    if (detectInstallContext().mode !== 'packaged') {
      return res.status(400).json({ error: 'Touch ID + Secure Enclave is only available in the packaged app.' })
    }
    if (!(config.touchIdEnabled || config.touchIdWrappedVaultKey)) {
      return res.status(400).json({ error: 'Touch ID unlock is disabled for this vault' })
    }
    try {
      if (!hasVaultSession()) {
        await restartVaultHelper('touchid unlock preflight')
      }
      const helperSessionId = await unlockWithTouchId(config)
      if (!helperSessionId) return res.status(500).json({ error: 'Vault key unavailable' })
      if (config.totpEnrolled) {
        await safeMigrateAuthConfigProtectedFields(helperSessionId)
        clearAuthAttempts(['touchid'])
        beginPendingAuth(helperSessionId, 'touchid_totp', res)
        return res.json({ ok: false, needsTotp: true })
      }
      const activation = await activateVault(helperSessionId)
      clearAuthAttempts()
      recordAuthSuccess('touchid')
      issueSession(res, 'touchid')
      return res.json(activationResponse(activation))
    } catch (error) {
      await lockVault()
      if (touchIdNeedsPasswordRefresh(error)) {
        markTouchIdRepairNeeded(error)
        return res.status(409).json({
          error: 'Use your master password once to refresh Touch ID on this Mac.',
          touchIdRefreshRequired: true,
        })
      }
      recordAuthFailure('touchid', 'touchid_failed_or_cancelled')
      return res.status(401).json({ error: 'Touch ID was cancelled or is unavailable. Use your password to unlock.' })
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
    await retryBackgroundCaptureForActiveVault('sessions_auto_retry')
    const sessions = await loadSessions()
    res.json(await normalizeSessionsForUI(sessions))
  })

  app.get('/api/skills-backup', requireAuth, async (_req, res) => {
    res.json(await readSkillsBackupIndexForUI())
  })

  app.get('/api/skills-backup/manifest/:snapshotId', requireAuth, async (req, res) => {
    const manifest = await readSkillManifestForUI(req.params.snapshotId)
    if (!manifest) return res.status(404).json({ error: 'skill snapshot not found' })
    res.json(manifest)
  })

  app.get('/api/skills-backup/file/:snapshotId', requireAuth, async (req, res) => {
    const rawPath = Array.isArray(req.query.path) ? req.query.path[0] : req.query.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
      return res.status(400).json({ error: 'path required' })
    }
    const file = await readSkillFileForUI(req.params.snapshotId, rawPath)
    if (!file) return res.status(404).json({ error: 'skill file not found' })
    res.json(file)
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
    await retryBackgroundCaptureForActiveVault('status_auto_retry')
    const sessions = await loadSessions()
    const bySource = sessions.reduce<Record<string, number>>((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1
      return acc
    }, {})
    res.json({ totalSessions: sessions.length, bySource, lastUpdate: sessions[0]?.lastTimestamp ?? null })
  })

  app.get('/api/analytics/weekly', requireAuth, async (req, res) => {
    const requestedDays = positiveIntQuery(req.query.days)
    const days = requestedDays > 0 ? Math.min(requestedDays, 30) : 7
    const endedAt = new Date()
    const startedAt = new Date(endedAt.getTime() - days * 24 * 60 * 60 * 1000)
    const sessions = await loadSessions()
    try {
      res.json(await buildWeeklyAnalytics(sessions, startedAt, endedAt, days))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeLog('warn', 'analytics', 'weekly_analytics_fallback', { error: message })
      updateHealth('analytics', {
        lastFallbackAt: new Date().toISOString(),
        lastError: message,
      })
      res.json(buildWeeklyAnalyticsIndexFallback(sessions, startedAt, endedAt, days, message))
    }
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

  app.get('/api/referenced-attachments', requireAuth, async (_req, res) => {
    res.json(await referencedAttachmentStatus())
  })

  app.post('/api/referenced-attachments/enable', requireAuth, async (_req, res) => {
    res.json(await setReferencedAttachmentBackupEnabled(true))
  })

  app.post('/api/referenced-attachments/scan', requireAuth, async (_req, res) => {
    queueReferencedAttachmentBackfill('manual')
    res.json(await referencedAttachmentStatus())
  })

  app.get('/api/transfer/export/status', requireAuth, async (_req, res) => {
    const sessions = await loadSessions()
    res.json(await transferExportStatus({ sessionCount: sessions.length }))
  })

  app.post('/api/transfer/export/check', requireAuth, async (_req, res) => {
    const sessions = await loadSessions()
    const manifest = await writeTransferManifest({ sessionCount: sessions.length })
    res.json({
      ok: true,
      manifest,
      status: await transferExportStatus({ sessionCount: sessions.length }),
    })
  })

  app.post('/api/transfer/export/open-folder', requireAuth, async (_req, res) => {
    res.json(await openTransferFolder())
  })

  app.post('/api/transfer/import/preflight', async (req, res) => {
    if (isSetupDone() && !isAuthenticated(req)) return denyAuth(req, res)
    const sourceRoot = String((req.body?.sourceRoot || req.body?.folder || '')).trim()
    if (!sourceRoot) return res.status(400).json({ error: 'transfer folder path required' })
    const rawMode = String(req.body?.mode || '').trim()
    const mode = (['adopt', 'merge', 'replace'].includes(rawMode)
      ? rawMode
      : (isSetupDone() ? 'merge' : 'adopt')) as TransferMode
    try {
      res.json(await preflightTransferSource(sourceRoot, mode))
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/transfer/import/status', async (req, res) => {
    if (isSetupDone() && !isAuthenticated(req)) return denyAuth(req, res)
    res.json(currentTransferImportJob() ?? { phase: 'idle', done: false })
  })

  app.post('/api/transfer/import/resume', async (req, res) => {
    if (isSetupDone() && !isAuthenticated(req)) return denyAuth(req, res)
    try {
      res.json(resumeTransferImport())
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/transfer/import/cancel', async (req, res) => {
    if (isSetupDone() && !isAuthenticated(req)) return denyAuth(req, res)
    try {
      res.json(cancelTransferImport())
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/transfer/import/start', async (req, res) => {
    const mode = String(req.body?.mode || (isSetupDone() ? 'merge' : 'adopt')) as TransferMode
    if (!['adopt', 'merge', 'replace'].includes(mode)) return res.status(400).json({ error: 'invalid transfer mode' })
    if (mode !== 'adopt' && !isAuthenticated(req)) return denyAuth(req, res)
    if (mode === 'adopt' && isSetupDone()) return res.status(400).json({ error: 'adopt is only available before setup; use merge or replace' })

    const sourceRoot = String((req.body?.sourceRoot || req.body?.folder || '')).trim()
    if (!sourceRoot) return res.status(400).json({ error: 'transfer folder path required' })
    const credentials = {
      password: typeof req.body?.password === 'string' ? req.body.password : undefined,
      mnemonic: typeof req.body?.mnemonic === 'string' ? req.body.mnemonic : undefined,
    }
    if (typeof req.body?.recoveryCode === 'string' && req.body.recoveryCode.length > 0) {
      return res.status(400).json({ error: 'Invalid transfer unlock method' })
    }
    if (mode === 'replace') {
      const replaceConfirmText = typeof req.body?.replaceConfirmText === 'string' ? req.body.replaceConfirmText : ''
      const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : ''
      if (replaceConfirmText !== 'DELETE CURRENT DATA') {
        return res.status(400).json({ error: 'Type DELETE CURRENT DATA to confirm deleting current data and using the backup' })
      }
      if (!currentPassword) return res.status(400).json({ error: 'Current master password required before deleting current data' })
      const config = loadAuthConfig()
      if (!config?.passwordHash || !(config.passwordEnabled ?? true)) {
        return res.status(400).json({ error: 'Current master password unlock is not available for replace confirmation' })
      }
      const currentPasswordOk = await verifyPassword(currentPassword, config.passwordHash)
      if (!currentPasswordOk) return res.status(401).json({ error: 'Wrong current master password' })
    }

    try {
      if (mode === 'replace') {
        await stopBackgroundCapture()
        await stopWatchers()
      }
      const job = await runTransferImport({ sourceRoot, mode, credentials })
      if (mode === 'adopt' || mode === 'replace') {
        const helperSessionId = getVaultSessionId()
        if (!helperSessionId) return res.status(500).json({ error: 'transferred vault key unavailable', job })
        const activation = await activateVault(helperSessionId, {
          setupProgress: mode === 'adopt' ? updateSetupActivationProgress : undefined,
        })
        clearAuthAttempts()
        issueSession(res, credentials.mnemonic ? 'mnemonic' : 'password')
        const sessions = await verifyTransferredRootCanLoadSessions()
        return res.json({ ok: true, job, activation, sessions: sessions.length })
      }
      res.json({ ok: true, job })
    } catch (error) {
      writeLog('error', 'transfer-import', 'start_failed', { error })
      res.status(400).json({ error: error instanceof Error ? error.message : String(error), job: currentTransferImportJob() })
    }
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
    try {
      const version = appVersion()
      const md = renderAboutMarkdown(readAboutMarkdown(), version)
      res.send(markdownPageHTML('About', md, version))
    } catch (error) {
      writeLog('error', 'ui', 'about_render_failed', { error })
      res.status(500).send(markdownPageHTML('About', '# DataMoat\n\nAbout information is temporarily unavailable.', appVersion()))
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
    activeUiServer = server
    server.on('close', () => {
      if (activeUiServer === server) activeUiServer = null
    })
    server.on('error', (err) => { throw err })
  })

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
  const withReferencedAttachments = await attachReferencedAttachmentsForUI(session, messages)
  if (pageMode) return withReferencedAttachments
  return await backfillThinkingMessagesForUI(session, withReferencedAttachments)
}

function normalizeReferencedTextPath(value: string): string {
  let out = String(value || '').trim()
  if (out.startsWith('file://')) {
    try {
      out = decodeURIComponent(new URL(out).pathname)
    } catch {
      out = out.replace(/^file:\/\//, '')
    }
  } else {
    try {
      out = decodeURIComponent(out)
    } catch {
      // Keep the original string when it is not URI-encoded.
    }
  }
  out = out.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(out) ? out.toLowerCase() : out
}

function textReferencesPath(text: string, originalPath: string): boolean {
  if (text.includes(originalPath)) return true
  const normalizedPath = normalizeReferencedTextPath(originalPath)
  const normalizedText = normalizeReferencedTextPath(text)
  return normalizedPath ? normalizedText.includes(normalizedPath) : false
}

async function attachReferencedAttachmentsForUI(session: Session, messages: Message[]): Promise<Message[]> {
  const attachments = await readReferencedAttachmentsForSessionUI(session.source, session.uid)
  if (attachments.length === 0) return messages
  return messages.map(message => ({
    ...message,
    content: message.content.map(block => {
      if (block.type !== 'text' || !block.text) return block
      const matches = attachments.filter(item => textReferencesPath(block.text || '', item.originalPath))
      return matches.length > 0
        ? { ...block, referencedAttachments: matches }
        : block
    }),
  }))
}

async function findSearchExcerptForUI(session: Session, q: string): Promise<string | null> {
  let matched: string | null = null
  await forEachSessionMessageLineBatch(session, SEARCH_MESSAGE_PAGE_LIMIT, lines => {
    for (const line of lines) {
      if (!line.toLowerCase().includes(q)) continue
      let message: Message | null = null
      try {
        message = JSON.parse(line) as Message
      } catch {
        message = null
      }
      const excerpt = message
        ? findSearchExcerptInMessages([message], q)
        : findSearchExcerptInRawLine(line, q)
      if (excerpt) {
        matched = excerpt
        return false
      }
    }
    return true
  })
  return matched
}

function findSearchExcerptInRawLine(line: string, q: string): string | null {
  const idx = line.toLowerCase().indexOf(q)
  if (idx === -1) return null
  const start = Math.max(0, idx - 40)
  const end = Math.min(line.length, idx + q.length + 80)
  return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '')
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

type WeeklyAnalyticsBucket = { key: string; count: number }
type WeeklyAnalytics = {
  computedFrom: 'message-scan' | 'index-fallback'
  error?: string
  range: {
    days: number
    startedAt: string
    endedAt: string
  }
  summary: {
    conversations: number
    newConversations: number
    continuedConversations: number
    messages: number
    activeConversationMessages: number
    visibleTextChars: number
    estimatedTranscriptTokens: number
    estimatedInputLikeTokens: number
    estimatedAssistantTokens: number
    toolOutputs: number
    largestWorkstreamMessages: number
  }
  roles: Record<string, number>
  bySource: Record<string, number>
  topProjects: WeeklyAnalyticsBucket[]
  topModels: WeeklyAnalyticsBucket[]
  tokenUsage: {
    exactInputTokens: number
    exactOutputTokens: number
    exactCacheReadTokens: number
    exactCacheWriteTokens: number
    exactTotalTokens: number
    exactCost: number
    messagesWithExactUsage: number
    messagesWithoutExactUsage: number
  }
  timingsMs: {
    total: number
  }
}

const ANALYTICS_MESSAGE_PAGE_LIMIT = 1000

async function buildWeeklyAnalytics(
  sessions: Session[],
  rangeStart: Date,
  rangeEnd: Date,
  days: number,
): Promise<WeeklyAnalytics> {
  const startedAtMs = Date.now()
  const rangeStartMs = rangeStart.getTime()
  const rangeEndMs = rangeEnd.getTime()
  const activeSessions = sessions.filter(session => sessionOverlapsRange(session, rangeStartMs, rangeEndMs))
  const roles: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const projectMessages: Record<string, number> = {}
  const modelMessages: Record<string, number> = {}
  const tokenUsage: WeeklyAnalytics['tokenUsage'] = {
    exactInputTokens: 0,
    exactOutputTokens: 0,
    exactCacheReadTokens: 0,
    exactCacheWriteTokens: 0,
    exactTotalTokens: 0,
    exactCost: 0,
    messagesWithExactUsage: 0,
    messagesWithoutExactUsage: 0,
  }
  let messages = 0
  let visibleTextChars = 0
  let estimatedInputLikeTokens = 0
  let estimatedAssistantTokens = 0
  let toolOutputs = 0
  let largestWorkstreamMessages = 0

  for (const session of activeSessions) {
    bySource[session.source] = (bySource[session.source] || 0) + 1
    largestWorkstreamMessages = Math.max(largestWorkstreamMessages, session.messageCount || 0)

    const messageCount = session.messageCount || 0
    for (let offset = 0; offset < Math.max(messageCount, 1); offset += ANALYTICS_MESSAGE_PAGE_LIMIT) {
      const page = await readSessionMessagesPage(session, offset, ANALYTICS_MESSAGE_PAGE_LIMIT)
      if (page.length === 0) break

      for (const message of page) {
        const timestampMs = timestampValue(message.timestamp)
        if (timestampMs < rangeStartMs || timestampMs > rangeEndMs) continue

        messages += 1
        const role = message.role || 'unknown'
        roles[role] = (roles[role] || 0) + 1
        if (role === 'tool') toolOutputs += 1
        const project = session.cwd || '(unknown project)'
        projectMessages[project] = (projectMessages[project] || 0) + 1
        const model = message.model || session.model || 'unknown'
        modelMessages[model] = (modelMessages[model] || 0) + 1

        const charCount = visibleMessageText(message).length
        visibleTextChars += charCount
        const estimatedTokens = estimateTokensFromChars(charCount)
        if (role === 'assistant') estimatedAssistantTokens += estimatedTokens
        else estimatedInputLikeTokens += estimatedTokens

        if (messageHasUsage(message)) {
          tokenUsage.messagesWithExactUsage += 1
          tokenUsage.exactInputTokens += message.usage?.inputTokens || 0
          tokenUsage.exactOutputTokens += message.usage?.outputTokens || 0
          tokenUsage.exactCacheReadTokens += message.usage?.cacheReadTokens || 0
          tokenUsage.exactCacheWriteTokens += message.usage?.cacheWriteTokens || 0
          tokenUsage.exactTotalTokens += message.usage?.totalTokens || 0
          tokenUsage.exactCost += message.usage?.cost || message.cost || 0
        } else {
          tokenUsage.messagesWithoutExactUsage += 1
        }
      }

      if (page.length < ANALYTICS_MESSAGE_PAGE_LIMIT) break
    }
  }

  const newConversations = activeSessions.filter(session => {
    const first = timestampValue(session.firstTimestamp)
    return first >= rangeStartMs && first <= rangeEndMs
  }).length

  return {
    computedFrom: 'message-scan',
    range: {
      days,
      startedAt: rangeStart.toISOString(),
      endedAt: rangeEnd.toISOString(),
    },
    summary: {
      conversations: activeSessions.length,
      newConversations,
      continuedConversations: Math.max(0, activeSessions.length - newConversations),
      messages,
      activeConversationMessages: activeSessions.reduce((sum, session) => sum + (session.messageCount || 0), 0),
      visibleTextChars,
      estimatedTranscriptTokens: estimatedInputLikeTokens + estimatedAssistantTokens,
      estimatedInputLikeTokens,
      estimatedAssistantTokens,
      toolOutputs,
      largestWorkstreamMessages,
    },
    roles,
    bySource,
    topProjects: topBuckets(projectMessages, 6),
    topModels: topBuckets(modelMessages, 6),
    tokenUsage,
    timingsMs: {
      total: Date.now() - startedAtMs,
    },
  }
}

function buildWeeklyAnalyticsIndexFallback(
  sessions: Session[],
  rangeStart: Date,
  rangeEnd: Date,
  days: number,
  error?: string,
): WeeklyAnalytics {
  const startedAtMs = Date.now()
  const rangeStartMs = rangeStart.getTime()
  const rangeEndMs = rangeEnd.getTime()
  const activeSessions = sessions.filter(session => sessionOverlapsRange(session, rangeStartMs, rangeEndMs))
  const bySource: Record<string, number> = {}
  const projectConversations: Record<string, number> = {}
  const modelConversations: Record<string, number> = {}
  let activeConversationMessages = 0
  let largestWorkstreamMessages = 0

  for (const session of activeSessions) {
    bySource[session.source] = (bySource[session.source] || 0) + 1
    projectConversations[session.cwd || '(unknown project)'] = (projectConversations[session.cwd || '(unknown project)'] || 0) + 1
    modelConversations[session.model || 'unknown'] = (modelConversations[session.model || 'unknown'] || 0) + 1
    activeConversationMessages += session.messageCount || 0
    largestWorkstreamMessages = Math.max(largestWorkstreamMessages, session.messageCount || 0)
  }

  const newConversations = activeSessions.filter(session => {
    const first = timestampValue(session.firstTimestamp)
    return first >= rangeStartMs && first <= rangeEndMs
  }).length

  return {
    computedFrom: 'index-fallback',
    ...(error ? { error } : {}),
    range: {
      days,
      startedAt: rangeStart.toISOString(),
      endedAt: rangeEnd.toISOString(),
    },
    summary: {
      conversations: activeSessions.length,
      newConversations,
      continuedConversations: Math.max(0, activeSessions.length - newConversations),
      messages: 0,
      activeConversationMessages,
      visibleTextChars: 0,
      estimatedTranscriptTokens: 0,
      estimatedInputLikeTokens: 0,
      estimatedAssistantTokens: 0,
      toolOutputs: 0,
      largestWorkstreamMessages,
    },
    roles: {},
    bySource,
    topProjects: topBuckets(projectConversations, 6),
    topModels: topBuckets(modelConversations, 6),
    tokenUsage: {
      exactInputTokens: 0,
      exactOutputTokens: 0,
      exactCacheReadTokens: 0,
      exactCacheWriteTokens: 0,
      exactTotalTokens: 0,
      exactCost: 0,
      messagesWithExactUsage: 0,
      messagesWithoutExactUsage: 0,
    },
    timingsMs: {
      total: Date.now() - startedAtMs,
    },
  }
}

function sessionOverlapsRange(session: Session, rangeStartMs: number, rangeEndMs: number): boolean {
  const first = timestampValue(session.firstTimestamp)
  const last = timestampValue(session.lastTimestamp)
  return first <= rangeEndMs && last >= rangeStartMs
}

function timestampValue(value: string | null | undefined): number {
  if (!value) return -1
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : -1
}

function topBuckets(values: Record<string, number>, limit: number): WeeklyAnalyticsBucket[] {
  return Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4)
}

function messageHasUsage(message: Message): boolean {
  const usage = message.usage
  return !!usage && Object.values(usage).some(value => typeof value === 'number' && Number.isFinite(value))
}

function visibleMessageText(message: Message): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(block => {
    if (!block || typeof block !== 'object') return ''
    const parts = [
      block.text,
      block.thinking,
      block.name,
      typeof block.input === 'string' ? block.input : safeJson(block.input),
      typeof block.content === 'string' ? block.content : safeJson(block.content),
      block.attachmentName,
    ].filter(Boolean)
    return parts.join('\n')
  }).filter(Boolean).join('\n')
}

function messageHasThinkingBlock(message: Message): boolean {
  return Array.isArray(message.content) && message.content.some(block => block.type === 'thinking')
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
      : source === 'cursor'
        ? extractCursorLine(rawLine)
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
  .setup-banner-row {
    padding: 14px 20px 0;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
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
  .info-box strong { color: #6fe39a; }
  .bootstrap-capture-box {
    border-color: rgba(0,214,186,0.42);
    background: linear-gradient(180deg, rgba(0,214,186,0.13), rgba(43,196,109,0.08));
    color: #c9f5ea;
  }
  .bootstrap-capture-box strong {
    display: block;
    margin-bottom: 4px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 1.2px;
    text-transform: uppercase;
    color: var(--accent2);
  }
  .bootstrap-capture-box span {
    display: block;
  }
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
  .activate-overlay { display: none; position: fixed; inset: 0; z-index: 999; background: var(--bg); flex-direction: column; align-items: center; justify-content: center; gap: 24px; }
  .activate-overlay.show { display: flex; }
  .activate-logo { font-size: 13px; letter-spacing: 4px; color: var(--accent2); text-transform: uppercase; }
  .activate-logo span { color: var(--accent2); }
  .activate-label { max-width: 640px; padding: 0 24px; text-align: center; font-size: 11px; letter-spacing: 2px; color: var(--muted); text-transform: uppercase; min-height: 18px; transition: color 0.5s; }
  .activate-label.bright { color: var(--accent2); }
  .activate-detail { max-width: 640px; min-height: 42px; padding: 0 24px; text-align: center; font-size: 12px; line-height: 1.55; color: #aab5c3; }
  .activate-progress-wrap { width: 480px; max-width: 90vw; display: grid; gap: 8px; }
  .activate-progress-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; font-family: var(--mono); }
  .activate-step { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; }
  .activate-percent { flex: 0 0 auto; color: var(--accent2); font-size: 14px; letter-spacing: 1px; }
  .progress-track { width: 480px; max-width: 90vw; height: 3px; background: var(--border); border-radius: 2px; overflow: hidden; }
  .progress-fill { height: 100%; width: 0%; background: var(--accent2); border-radius: 2px; transition: width linear; box-shadow: 0 0 10px var(--accent2); }
  .progress-track.indeterminate .progress-fill { width: 32%; animation: progress-slide 1.25s ease-in-out infinite; transition: none; }
  @keyframes progress-slide { from { transform: translateX(-120%); } to { transform: translateX(340%); } }
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
  .transfer-setup-card {
    border: 1px solid rgba(43,196,109,0.22);
    border-radius: 14px;
    padding: 14px;
    background: linear-gradient(180deg, rgba(43,196,109,0.10), rgba(255,255,255,0.02));
    display: grid;
    gap: 10px;
  }
  .transfer-setup-entry {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px;
    padding: 14px;
    background: rgba(255,255,255,0.025);
    display: grid;
    gap: 10px;
  }
  .transfer-setup-card[hidden],
  .transfer-setup-entry[hidden],
  .transfer-setup-fields[hidden] {
    display: none;
  }
  .transfer-setup-entry .btn { width: fit-content; }
  .transfer-setup-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .transfer-setup-title { font-size: 17px; font-weight: 500; letter-spacing: -0.02em; }
  .transfer-setup-badge {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--accent2);
    border: 1px solid rgba(43,196,109,0.36);
    border-radius: 999px;
    padding: 5px 9px;
    background: rgba(43,196,109,0.12);
  }
  .transfer-setup-copy { color: #b7c5d3; font-size: 12px; line-height: 1.55; }
  .transfer-setup-fields { display: grid; gap: 8px; }
  .transfer-selected-folder {
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 10px 11px;
    color: #cbd6e2;
    background: rgba(0,0,0,0.16);
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .transfer-auth-tabs {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .transfer-auth-tab {
    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(255,255,255,0.04);
    color: #cbd6e2;
    border-radius: 999px;
    padding: 8px 12px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 1px;
    text-transform: uppercase;
    cursor: pointer;
  }
  .transfer-auth-tab.active {
    border-color: rgba(242,178,77,0.6);
    color: var(--accent);
    background: rgba(242,178,77,0.13);
  }
  .transfer-auth-pane[hidden] { display: none; }
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
  <div class="setup-banner-row" id="bootstrap-capture-banner" style="display:none;">
    <div class="info-box bootstrap-capture-box" id="bootstrap-capture-copy">
      Capture is active. DataMoat is collecting supported local records on this machine. Finish password and recovery setup on this desktop; do not share recovery material in chat.
    </div>
  </div>
  <div class="card-body">
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
      <div class="section" id="setup-local-unlock-section">
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
      <div class="section">
        <div class="transfer-setup-entry" id="setup-transfer-entry">
          <div>
            <div class="transfer-setup-title">Restore from an existing DataMoat folder</div>
            <div class="transfer-setup-copy">Already have a DataMoat backup or another computer's DataMoat folder? Select it here instead of creating a new empty vault.</div>
          </div>
          <button class="btn btn-ghost" id="btn-setup-transfer-start" type="button">Choose backup folder</button>
        </div>
        <div class="transfer-setup-card" id="setup-transfer-card" hidden>
          <div class="transfer-setup-head">
            <div>
              <div class="transfer-setup-title">Restore existing DataMoat data</div>
              <div class="transfer-setup-copy">Choose the copied DataMoat data folder. After it checks successfully, unlock the old vault with its old password or old 24-word phrase.</div>
            </div>
            <div class="transfer-setup-badge" id="setup-transfer-badge">waiting</div>
          </div>
          <input id="setup-transfer-folder-picker" type="file" webkitdirectory directory hidden />
          <div class="transfer-selected-folder" id="setup-transfer-folder-label">No folder selected.</div>
          <div class="transfer-setup-fields">
            <input class="pw-input" id="setup-transfer-folder" type="text" placeholder="/path/to/copied/.datamoat" autocomplete="off" />
          </div>
          <div class="btn-row">
            <button class="btn btn-ghost" id="btn-setup-transfer-select" type="button">Choose different folder</button>
            <button class="btn btn-ghost" id="btn-setup-transfer-cancel" type="button">Back</button>
          </div>
          <div class="transfer-setup-fields" id="setup-transfer-credentials" hidden>
            <div class="section-label">Old vault unlock</div>
            <div class="transfer-auth-tabs">
              <button class="transfer-auth-tab active" id="setup-transfer-auth-password" type="button">Old password</button>
              <button class="transfer-auth-tab" id="setup-transfer-auth-phrase" type="button">Old 24-word phrase</button>
            </div>
            <div class="transfer-auth-pane" id="setup-transfer-password-pane">
              <input class="pw-input" id="setup-transfer-password" type="password" placeholder="Old master password" autocomplete="current-password" />
            </div>
            <div class="transfer-auth-pane" id="setup-transfer-phrase-pane" hidden>
              <textarea class="pw-input" id="setup-transfer-mnemonic" rows="3" placeholder="Old 24-word recovery phrase" autocomplete="off"></textarea>
            </div>
            <button class="btn btn-success" id="btn-setup-transfer-import" type="button">Restore this DataMoat folder</button>
          </div>
          <div class="error-msg" id="setup-transfer-error" style="display:none;"></div>
        </div>
      </div>
      <div class="phase-actions" id="setup-local-actions">
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

    <!-- Phase 4: Final confirm -->
    <div class="phase" id="phase4">
      <div class="section">
        <div class="section-label">Final recovery check</div>
        <div class="warning-box">
          Your 24-word recovery phrase is the emergency recovery method for this vault. Keep it somewhere private and offline.
        </div>
      </div>
      <div class="section final-check-list">
        <label class="checkbox-row">
          <input type="checkbox" class="final-check" onchange="checkFinal()">
          I have saved the 24-word recovery phrase in a secure location.
        </label>
        <label class="checkbox-row">
          <input type="checkbox" class="final-check" onchange="checkFinal()">
          I understand: if I lose my unlock methods and the 24-word phrase, my vault cannot be recovered.
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
  <div class="activate-progress-wrap">
    <div class="activate-progress-head">
      <div class="activate-step" id="activate-step">Starting setup</div>
      <div class="activate-percent" id="activate-percent">0%</div>
    </div>
    <div class="progress-track" id="progress-track"><div class="progress-fill" id="progress-fill"></div></div>
  </div>
  <div class="activate-label" id="activate-label">Initialising vault…</div>
  <div class="activate-detail" id="activate-detail">This first scan runs once and stays local.</div>
  <div class="activate-done" id="activate-done">✓</div>
</div>

<script>
let _setupNonce = '', _secret = '', _mnemonic = '', _password = '', _enrollTotp = false;
let _touchIdAvailable = false, _passwordEnabled = true, _touchIdEnabled = false;
let _setupCommitted = false;
let _passwordRequired = true;
let _touchIdSupportedPlatform = true;
let _touchIdReason = '';
let _touchIdUserTouched = false;
let _touchIdRefreshAttempts = 0;
let _touchIdRefreshTimer = 0;
let _setupTransferAuthMode = 'password';
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

async function setupJsonOrThrow(response) {
  let data = null
  try { data = await response.json() } catch {}
  if (!response.ok || data?.error) throw new Error(data?.error || ('HTTP ' + response.status))
  return data
}

function setupTransferElements() {
  return {
    localUnlock: document.getElementById('setup-local-unlock-section'),
    localActions: document.getElementById('setup-local-actions'),
    entry: document.getElementById('setup-transfer-entry'),
    card: document.getElementById('setup-transfer-card'),
    picker: document.getElementById('setup-transfer-folder-picker'),
    source: document.getElementById('setup-transfer-folder'),
    label: document.getElementById('setup-transfer-folder-label'),
    credentials: document.getElementById('setup-transfer-credentials'),
    password: document.getElementById('setup-transfer-password'),
    mnemonic: document.getElementById('setup-transfer-mnemonic'),
    passwordPane: document.getElementById('setup-transfer-password-pane'),
    phrasePane: document.getElementById('setup-transfer-phrase-pane'),
    passwordTab: document.getElementById('setup-transfer-auth-password'),
    phraseTab: document.getElementById('setup-transfer-auth-phrase'),
    startBtn: document.getElementById('btn-setup-transfer-start'),
    selectBtn: document.getElementById('btn-setup-transfer-select'),
    cancelBtn: document.getElementById('btn-setup-transfer-cancel'),
    importBtn: document.getElementById('btn-setup-transfer-import'),
    badge: document.getElementById('setup-transfer-badge'),
    error: document.getElementById('setup-transfer-error'),
  };
}

function showSetupTransfer(open) {
  const el = setupTransferElements();
  el.localUnlock.hidden = !!open;
  el.localActions.hidden = !!open;
  el.entry.hidden = !!open;
  el.card.hidden = !open;
  if (!open) {
    el.credentials.hidden = true;
    el.badge.textContent = 'waiting';
    el.error.style.display = 'none';
    el.error.textContent = '';
  }
}

function setSetupTransferBusy(busy, message) {
  const el = setupTransferElements();
  el.startBtn.disabled = busy;
  el.selectBtn.disabled = busy;
  el.cancelBtn.disabled = busy;
  el.importBtn.disabled = busy;
  el.source.disabled = busy;
  el.password.disabled = busy;
  el.mnemonic.disabled = busy;
  el.badge.textContent = busy ? (message || 'checking') : (message || el.badge.textContent || 'waiting');
  if (busy) {
    el.error.style.display = 'none';
    el.error.textContent = '';
  }
}

function setSetupTransferAuthMode(mode) {
  _setupTransferAuthMode = mode === 'phrase' ? 'phrase' : 'password';
  const el = setupTransferElements();
  el.passwordTab.classList.toggle('active', _setupTransferAuthMode === 'password');
  el.phraseTab.classList.toggle('active', _setupTransferAuthMode === 'phrase');
  el.passwordPane.hidden = _setupTransferAuthMode !== 'password';
  el.phrasePane.hidden = _setupTransferAuthMode !== 'phrase';
}

function setSetupTransferFolder(sourceRoot) {
  const el = setupTransferElements();
  el.source.value = sourceRoot || '';
  el.label.textContent = sourceRoot || 'No folder selected.';
}

async function chooseSetupTransferFolder() {
  showSetupTransfer(true);
  const desktopSelect = window.datamoatDesktop?.transfer?.selectFolder;
  if (desktopSelect) {
    try {
      const selected = await desktopSelect();
      if (selected && !selected.canceled && selected.path) {
        setSetupTransferFolder(selected.path);
        await setupTransferPreflight(selected.path);
      }
      return;
    } catch {
      // Fall through to browser picker/manual path.
    }
  }
  setupTransferElements().picker.click();
}

function folderPathFromPickedFiles(input) {
  const file = input.files && input.files[0];
  if (!file) return '';
  const fullPath = file.path || '';
  const relative = file.webkitRelativePath || file.name || '';
  if (!fullPath) return '';
  if (!relative || relative === file.name) return fullPath.replace(/[\\\\/][^\\\\/]+$/, '');
  const separator = fullPath.includes('\\\\') ? '\\\\' : '/';
  const normalizedRelative = relative.replace(/\\//g, separator);
  if (fullPath.endsWith(normalizedRelative)) {
    return fullPath.slice(0, fullPath.length - normalizedRelative.length).replace(/[\\\\/]$/, '');
  }
  return fullPath.replace(/[\\\\/][^\\\\/]+$/, '');
}

async function setupTransferPickedFolder() {
  const el = setupTransferElements();
  const sourceRoot = folderPathFromPickedFiles(el.picker);
  if (!sourceRoot) {
    el.error.textContent = 'Folder selected. If the path is not visible here, paste the copied DataMoat folder path below.';
    el.error.style.display = '';
    return;
  }
  setSetupTransferFolder(sourceRoot);
  await setupTransferPreflight(sourceRoot);
}

function setupTransferAuthSummary(auth) {
  const methods = [];
  if (auth?.hasPassword) methods.push('old password');
  if (auth?.hasMnemonic) methods.push('old 24-word phrase');
  return methods.length ? methods.join(' or ') : 'old password or old 24-word phrase';
}

async function setupTransferPreflight(sourceRootInput) {
  const el = setupTransferElements();
  const sourceRoot = (sourceRootInput || el.source.value || '').trim();
  if (!sourceRoot) {
    el.error.textContent = 'Choose the copied DataMoat folder first.';
    el.error.style.display = '';
    return;
  }
  setSetupTransferFolder(sourceRoot);
  setSetupTransferBusy(true, 'checking');
  try {
    const data = await setupJsonOrThrow(await apiFetch('/api/transfer/import/preflight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceRoot, mode: 'adopt' }),
    }));
    el.badge.textContent = data.ok ? 'ready' : 'needs repair';
    el.credentials.hidden = !data.ok;
    el.error.textContent = data.ok
      ? 'Folder is ready. Unlock the old vault with ' + setupTransferAuthSummary(data.auth) + '.'
      : ((data.errors || []).join(' · ') || 'Transfer folder failed preflight.');
    el.error.style.display = '';
    if (data.ok) {
      if (data.auth?.hasPassword) setSetupTransferAuthMode('password');
      else if (data.auth?.hasMnemonic) setSetupTransferAuthMode('phrase');
    }
  } catch (err) {
    el.credentials.hidden = true;
    el.badge.textContent = 'failed';
    el.error.textContent = err instanceof Error ? err.message : String(err);
    el.error.style.display = '';
  } finally {
    setSetupTransferBusy(false);
  }
}

async function setupTransferImport() {
  const el = setupTransferElements();
  const sourceRoot = el.source.value.trim();
  const password = el.password.value;
  const mnemonic = el.mnemonic.value.trim();
  const usePhrase = _setupTransferAuthMode === 'phrase';
  if (!sourceRoot || (usePhrase ? !mnemonic : !password)) {
    el.error.textContent = usePhrase
      ? 'Choose a DataMoat folder and enter the old 24-word phrase.'
      : 'Choose a DataMoat folder and enter the old master password.';
    el.error.style.display = '';
    return;
  }
  setSetupTransferBusy(true, 'importing');
  const overlay = document.getElementById('activate-overlay');
  const track = document.getElementById('progress-track');
  const fill = document.getElementById('progress-fill');
  const percent = document.getElementById('activate-percent');
  const stepName = document.getElementById('activate-step');
  const label = document.getElementById('activate-label');
  const detail = document.getElementById('activate-detail');
  const setOverlayProgress = (pct, text, detailText, stepText, progressText) => {
    const hasPct = typeof pct === 'number' && Number.isFinite(pct);
    if (hasPct) {
      const safePct = Math.max(0, Math.min(100, Math.round(pct)));
      track.classList.remove('indeterminate');
      fill.style.transitionDuration = '450ms';
      fill.style.width = safePct + '%';
      percent.textContent = progressText || (safePct + '%');
    } else {
      track.classList.add('indeterminate');
      fill.style.transitionDuration = '0ms';
      percent.textContent = progressText || 'working';
    }
    if (stepText) stepName.textContent = stepText;
    if (text) label.textContent = text;
    if (detailText) detail.textContent = detailText;
  };
  const formatLocalBytes = value => {
    const bytes = Number(value) || 0;
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return Math.max(0, Math.round(bytes)) + ' B';
  };
  const transferPhaseText = job => {
    const phase = job?.phase || 'preflight';
    const counts = job?.counts || {};
    const imported = job?.imported || {};
    const copiedBytes = Number(job?.copy?.bytes || 0);
    const totalBytes = Number(counts.totalBytes || 0);
    const copyPercent = totalBytes > 0
      ? Math.max(38, Math.min(72, 38 + ((copiedBytes / totalBytes) * 34)))
      : 55;
    const copyText = copiedBytes > 0 && totalBytes > 0
      ? formatLocalBytes(copiedBytes) + '/' + formatLocalBytes(totalBytes)
      : 'copying';
    const currentFileName = typeof job?.currentFile === 'string' && job.currentFile
      ? job.currentFile.split(/[\\\\/]/).slice(-2).join('/')
      : '';
    const currentFile = currentFileName
      ? ' Current file: ' + currentFileName
      : '';
    if (phase === 'preflight') return [8, 'Checking copied folder…', 'DataMoat is checking the selected transfer folder before unlock.', 'Checking folder'];
    if (phase === 'unlocking-source') return [16, 'Unlocking old vault…', 'This uses the old password or old 24-word phrase. It is not related to folder size.', 'Unlocking old vault'];
    if (phase === 'validating-source') return [26, 'Validating old vault…', 'DataMoat is confirming the copied folder is complete.', 'Validating folder'];
    if (phase === 'backing-up-current-root') return [38, 'Backing up current setup…', 'DataMoat is keeping a rollback copy before using the transferred folder.', 'Preparing rollback'];
    if (phase === 'copying-source-root') return [copyPercent, 'Copying DataMoat folder…', 'Copying ' + (counts.sessions || 0) + ' sessions and ' + (counts.attachments || 0) + ' attachments into this vault.' + currentFile, 'Copying folder', copyText];
    if (phase === 'cleaning-machine-bound-auth') return [74, 'Removing old machine unlock methods…', 'Touch ID and old background unlock secrets cannot transfer to this computer.', 'Cleaning unlock methods'];
    if (phase === 'finalizing-transfer-root') return [82, 'Finalizing transferred vault…', 'DataMoat is switching to the cleaned transferred folder.', 'Finalizing transfer'];
    if (phase === 'importing-sessions') return [70, 'Importing sessions…', (imported.sessions || 0) + '/' + (counts.sessions || 0) + ' sessions imported.', 'Importing sessions'];
    if (phase === 'importing-attachments') return [78, 'Importing attachments…', (imported.attachments || 0) + '/' + (counts.attachments || 0) + ' attachments imported.', 'Importing attachments'];
    if (phase === 'completed') return [88, 'Starting DataMoat…', 'Restore completed. Opening the vault now.', 'Restore complete'];
    if (phase === 'failed') return [null, 'Restore failed', job?.lastError || 'DataMoat could not complete the transfer.', 'Restore failed', 'failed'];
    return [null, 'Working…', 'DataMoat is restoring the copied folder.', 'Restoring folder', 'working'];
  };
  const pollTransferProgress = async () => {
    try {
      const status = await apiFetch('/api/transfer/import/status');
      if (status.ok) {
        const job = await status.json();
        const args = transferPhaseText(job);
        setOverlayProgress(args[0], args[1], args[2], args[3], args[4]);
      }
    } catch {}
    try {
      const progress = await apiFetch('/api/setup/progress');
      if (progress.ok) {
        const p = await progress.json();
        if (p?.running || p?.done) {
          const pct = typeof p.percent === 'number' ? Math.max(88, Math.min(100, p.percent)) : null;
          setOverlayProgress(
            pct,
            p.label || 'Starting DataMoat…',
            p.detail || 'Finishing vault activation.',
            p.stepText || 'Activating vault',
            p.progressText || '',
          );
        }
      }
    } catch {}
    try {
      const meta = await apiFetch('/api/meta');
      const data = await meta.json();
      if (data?.route === 'app' || data?.route === 'unlock') {
        window.location.replace(data.route === 'app' ? '/?setup=' + Date.now() : '/unlock?setup=' + Date.now());
      }
    } catch {}
  };
  overlay.classList.add('show');
  setOverlayProgress(8, 'Checking copied folder…', 'DataMoat is validating the copied folder and removing old machine-bound unlock methods.', 'Restoring DataMoat folder');
  const transferProgressTimer = setInterval(pollTransferProgress, 1000);
  void pollTransferProgress();
  try {
    const body = usePhrase
      ? { sourceRoot, mnemonic, mode: 'adopt' }
      : { sourceRoot, password, mode: 'adopt' };
    await setupJsonOrThrow(await apiFetch('/api/transfer/import/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    _setupCommitted = true;
    setOverlayProgress(100, 'Restore complete', 'Opening DataMoat now.', 'Restore complete');
    window.location.replace('/?setup=' + Date.now());
  } catch (err) {
    if (await syncSetupRoute(true)) return;
    overlay.classList.remove('show');
    el.error.textContent = err instanceof Error ? err.message : String(err);
    el.error.style.display = '';
  } finally {
    clearInterval(transferProgressTimer);
    setSetupTransferBusy(false);
  }
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
  const words = d.mnemonic.split(' ');
  document.getElementById('mnemonic-grid').innerHTML = words.map((w, i) =>
    '<div class="word-cell"><span class="word-num">' + (i+1) + '</span><span class="word-text">' + w + '</span></div>'
  ).join('');
  document.getElementById('qr-img').src = d.qrDataUrl;
  document.getElementById('totp-secret-display').textContent = d.secret;
  _touchIdSupportedPlatform = d.touchIdSupportedPlatform !== false;
  if (d.bootstrapCapture && d.bootstrapCapture.enabled) {
    const banner = document.getElementById('bootstrap-capture-banner');
    const copy = document.getElementById('bootstrap-capture-copy');
    const remoteNoScreen = d.bootstrapCapture.requestedBy === 'remote-no-screen';
    const files = Number(d.bootstrapCapture.entries || 0);
    const detail = files > 0
      ? files + ' files are already protected before setup. Finish setup here to import them into the vault.'
      : 'Capture is armed and waiting for supported local records before setup. Finish setup on this desktop.';
    banner.style.display = '';
    copy.innerHTML = remoteNoScreen
      ? '<strong>No-screen capture is running</strong><span>' + detail + '</span>'
      : '<strong>Capture-before-setup is running</strong><span>' + detail + '</span>';
    document.querySelector('.card-body')?.scrollTo({ top: 0, left: 0 });
    window.scrollTo(0, 0);
  }
  setTouchIdAvailability(_touchIdSupportedPlatform && !!d.touchIdAvailable, typeof d.touchIdReason === 'string' ? d.touchIdReason : '', true);
  renderMethodCards();
  updatePwUI();
  scheduleTouchIdRefresh();
}
init();

window.addEventListener('focus', () => {
  void syncSetupRoute(false);
  void refreshTouchIdAvailability(true);
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void syncSetupRoute(false);
    void refreshTouchIdAvailability(true);
  }
});

function setTouchIdAvailability(available, reason, enableIfAvailable) {
  _touchIdAvailable = !!available;
  _touchIdReason = reason || '';
  const copy = document.getElementById('touchid-copy');
  if (_touchIdAvailable) {
    if (enableIfAvailable && !_touchIdUserTouched) {
      _touchIdEnabled = true;
    }
    copy.innerHTML = 'Daily unlock on this Mac using <strong>Apple Secure Enclave</strong>. The Touch ID private key stays inside Apple hardware and is used to release vault access on this Mac only.';
  } else {
    _passwordRequired = true;
    _passwordEnabled = true;
    _touchIdEnabled = false;
    copy.innerHTML = _touchIdReason
      ? 'Touch ID with <strong>Apple Secure Enclave</strong> is unavailable right now. <span style=\"opacity:.82\">' + esc(_touchIdReason) + '</span>'
      : 'Touch ID with <strong>Apple Secure Enclave</strong> is not available on this Mac, so this option is disabled.';
  }
}

async function refreshTouchIdAvailability(enableIfAvailable = false) {
  if (!_touchIdSupportedPlatform) return;
  try {
    const r = await apiFetch('/api/auth/touchid-available');
    const d = await r.json();
    setTouchIdAvailability(!!d.available, typeof d.reason === 'string' ? d.reason : '', enableIfAvailable);
    renderMethodCards();
    updatePwUI();
    if (_touchIdAvailable && _touchIdRefreshTimer) {
      clearTimeout(_touchIdRefreshTimer);
      _touchIdRefreshTimer = 0;
    }
  } catch {}
}

function scheduleTouchIdRefresh() {
  if (!_touchIdSupportedPlatform) return;
  if (_touchIdAvailable || _touchIdRefreshAttempts >= 8) return;
  if (_touchIdRefreshTimer) clearTimeout(_touchIdRefreshTimer);
  const delay = _touchIdRefreshAttempts === 0 ? 750 : 2000;
  _touchIdRefreshTimer = window.setTimeout(async () => {
    _touchIdRefreshTimer = 0;
    _touchIdRefreshAttempts += 1;
    await refreshTouchIdAvailability(true);
    scheduleTouchIdRefresh();
  }, delay);
}

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
  if (!_touchIdSupportedPlatform) {
    tiCard.style.display = 'none';
    touchInfo.style.display = 'none';
    pwState.style.display = 'none';
    methodsLabel.textContent = 'Set a local password to unlock this vault';
    pwFields.classList.toggle('hidden', !_passwordEnabled);
    pwInputWrap.classList.toggle('off', !_passwordEnabled);
    pwConfirmWrap.classList.toggle('off', !_passwordEnabled);
    document.getElementById('pw-input').disabled = !_passwordEnabled;
    document.getElementById('pw-confirm').disabled = !_passwordEnabled;
    return;
  }
  tiCard.className = 'method-card touchid' + (_touchIdEnabled ? ' selected' : '') + (_touchIdAvailable ? '' : ' disabled');
  pwState.className = 'method-switch password ' + (_passwordRequired ? 'locked enabled' : (_passwordEnabled ? 'enabled' : 'disabled'));
  tiState.className = 'method-switch touchid ' + (_touchIdAvailable ? (_touchIdEnabled ? 'enabled' : 'disabled') : 'unavailable');
  if (pwStateLabel) pwStateLabel.textContent = _passwordRequired ? 'Required' : (_passwordEnabled ? 'On' : 'Off');
  if (tiStateLabel) tiStateLabel.textContent = _touchIdAvailable ? (_touchIdEnabled ? 'On' : 'Off') : 'N/A';
  tiCard.style.display = '';
  touchInfo.style.display = _touchIdAvailable ? '' : 'none';
  pwState.style.display = '';
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
  if (kind === 'touchid') _touchIdUserTouched = true;
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
document.getElementById('btn-setup-transfer-start').addEventListener('click', () => { void chooseSetupTransferFolder(); });
document.getElementById('btn-setup-transfer-select').addEventListener('click', () => { void chooseSetupTransferFolder(); });
document.getElementById('btn-setup-transfer-cancel').addEventListener('click', () => showSetupTransfer(false));
document.getElementById('setup-transfer-folder-picker').addEventListener('change', () => { void setupTransferPickedFolder(); });
document.getElementById('setup-transfer-folder').addEventListener('change', e => { void setupTransferPreflight(e.target.value); });
document.getElementById('setup-transfer-folder').addEventListener('keydown', e => {
  if (e.key === 'Enter') void setupTransferPreflight(e.target.value);
});
document.getElementById('setup-transfer-auth-password').addEventListener('click', () => setSetupTransferAuthMode('password'));
document.getElementById('setup-transfer-auth-phrase').addEventListener('click', () => setSetupTransferAuthMode('phrase'));
document.getElementById('btn-setup-transfer-import').addEventListener('click', () => { void setupTransferImport(); });

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
  const titles = ['Choose unlock methods', 'Save recovery phrase', 'Two-factor authentication', 'Final check'];
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

async function goToStep2() {
  await refreshTouchIdAvailability(true);
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

function checkFinal() {
  const all = [...document.querySelectorAll('.final-check')].every(c => c.checked);
  setOff('btn-activate', !all);
}

async function activate() {
  const overlay = document.getElementById('activate-overlay');
  const track = document.getElementById('progress-track');
  const fill = document.getElementById('progress-fill');
  const percent = document.getElementById('activate-percent');
  const stepName = document.getElementById('activate-step');
  const label = document.getElementById('activate-label');
  const detail = document.getElementById('activate-detail');
  const done = document.getElementById('activate-done');
  const err = document.getElementById('activate-error');
  const clampPct = value => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const setActivationProgress = (pct, text, detailText, stepText, durationMs = 450, progressText = '') => {
    const hasPct = typeof pct === 'number' && Number.isFinite(pct);
    if (hasPct) {
      const safePct = clampPct(pct);
      track.classList.remove('indeterminate');
      fill.style.transform = '';
      fill.style.transitionDuration = durationMs + 'ms';
      fill.style.width = safePct + '%';
      percent.textContent = progressText || (safePct + '%');
    } else {
      track.classList.add('indeterminate');
      fill.style.transitionDuration = '0ms';
      percent.textContent = progressText || 'working';
    }
    if (stepText) stepName.textContent = stepText;
    if (text) label.textContent = text;
    if (detailText) detail.textContent = detailText;
  };
  err.style.display = 'none';
  done.classList.remove('show');
  label.classList.remove('bright');
  track.classList.remove('indeterminate');
  fill.style.transitionDuration = '0ms';
  fill.style.transform = '';
  fill.style.width = '0%';
  percent.textContent = '0%';
  stepName.textContent = 'Starting setup';
  overlay.classList.add('show');
  setActivationProgress(18, 'Creating encrypted vault…', 'DataMoat is setting up local encrypted storage. This first scan stays on this Mac.', 'Local vault', 350);
  const clearProgressTimers = () => {};
  let serverProgressSeen = false;
  const progressPollTimer = setInterval(async () => {
    try {
      const r = await apiFetch('/api/setup/progress');
      if (!r.ok) return;
      const p = await r.json();
      const unit = typeof p.progressUnit === 'string' && p.progressUnit.trim() ? p.progressUnit.trim() : 'sessions';
      const usesSessionProgress = unit === 'sessions';
      const totalSessions = usesSessionProgress ? Number(p.totalSessions || 0) : 0;
      const protectedSessions = usesSessionProgress ? Number(p.processedSessions || 0) : 0;
      const sourceRecordsTotal = Number(p.sourceRecordsTotal || 0);
      const progressTextFromServer = typeof p.progressText === 'string' ? p.progressText.trim() : '';
      const stepTextFromServer = typeof p.stepText === 'string' ? p.stepText.trim() : '';
      const elapsedLabel = typeof p.elapsedLabel === 'string' ? p.elapsedLabel : '';
      const hasServerPercent = typeof p.percent === 'number' && Number.isFinite(p.percent);
      const pctFromServer = hasServerPercent ? Number(p.percent) : null;
      const labelFromServer = typeof p.label === 'string' ? p.label.trim() : '';
      const detailFromServer = typeof p.detail === 'string' ? p.detail.trim() : '';
      if (!hasServerPercent && !labelFromServer && !detailFromServer && !progressTextFromServer && totalSessions <= 0 && sourceRecordsTotal <= 0) return;
      if (!serverProgressSeen) {
        serverProgressSeen = true;
        clearProgressTimers();
      }
      const pct = hasServerPercent ? Math.max(0, Math.min(100, pctFromServer)) : null;
      const stepText = stepTextFromServer || (totalSessions > 0
        ? protectedSessions + '/' + totalSessions + ' ' + unit
        : (sourceRecordsTotal > 0 ? 'Scanning local records' : (p.phase || 'Setup')));
      const progressText = progressTextFromServer || (totalSessions > 0
        ? protectedSessions + '/' + totalSessions
        : (hasServerPercent ? clampPct(pct) + '%' : (elapsedLabel || 'scanning')));
      setActivationProgress(
        pct,
        labelFromServer || (protectedSessions > 0 ? ('Indexed ' + protectedSessions + ' sessions') : 'Scanning local AI work records'),
        detailFromServer || 'Reading local records and building the session index.',
        stepText,
        450,
        progressText,
      );
    } catch {}
  }, 1000);
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
    clearInterval(progressPollTimer);
    if (!r.ok || d?.error) {
      if (d?.error === 'already setup') {
        _setupCommitted = true;
        window.location.href = '/unlock';
        return;
      }
      overlay.classList.remove('show');
      track.classList.remove('indeterminate');
      fill.style.width = '0%';
      detail.textContent = '';
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
    clearInterval(progressPollTimer);
    overlay.classList.remove('show');
    track.classList.remove('indeterminate');
    fill.style.width = '0%';
    detail.textContent = '';
    err.textContent = 'Could not activate vault. Try again.';
    err.style.display = '';
    return;
  }
  const steps = [
    { pct: 94, ms: 260, text: 'Finalising session index…', detail: 'Almost there.' },
    { pct: 98, ms: 260, text: 'Starting background capture…', detail: 'Future records will continue to be captured while DataMoat is locked.' },
    { pct: 100, ms: 320, text: 'Done.', detail: 'Opening DataMoat now.' },
  ];
  for (const step of steps) {
    setActivationProgress(step.pct, step.text, step.detail, step.text.replace(/…|\\.$/g, ''), step.ms);
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
      <div class="method-note" id="pw-note"></div>
      <div class="error-msg" id="pw-error"></div>
      </div>
      <div class="method-note" id="password-disabled-note" style="display:none;">
        Password unlock is disabled for this vault.
      </div>
      <div class="divider">or</div>
      <div class="recovery-link">
        <button onclick="showRecovery()">Use 24-word recovery phrase</button>
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
      <div class="label">24-word recovery phrase</div>
      <input class="recovery-input" id="recovery-input" type="text" placeholder="word1 word2 … word24" />
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

function showTotpStep() {
  document.getElementById('password-section').style.display = 'none';
  document.getElementById('totp-section').style.display = '';
  document.getElementById('touchid-section').style.display = 'none';
  document.getElementById('card-sub').textContent = 'Enter authenticator code';
  const input = document.getElementById('totp-input');
  const button = document.getElementById('btn-totp');
  button.disabled = input.value.replace(/\\D/g,'').length !== 6;
  button.textContent = 'Verify';
  input.focus();
}

function setTouchIdHint(message) {
  const hint = document.getElementById('touchid-hint');
  if (hint) hint.textContent = message;
}

function restoreTouchIdHint() {
  setTouchIdHint(TOUCHID_HINT_DEFAULT);
}

function showTouchIdRefreshRequired(message) {
  unlockOptions.touchIdEnabled = false;
  const section = document.getElementById('touchid-section');
  const btn = document.getElementById('btn-touchid');
  const err = document.getElementById('touchid-error');
  const note = document.getElementById('pw-note');
  if (section) section.style.display = 'none';
  if (err) err.textContent = '';
  if (btn) {
    btn.classList.remove('waiting');
    btn.innerHTML = TOUCHID_SVG;
    btn.disabled = true;
  }
  setTouchIdHint('');
  document.getElementById('card-sub').textContent = 'Use your master password once to refresh Touch ID';
  document.getElementById('pw-error').textContent = '';
  if (note) note.textContent = message || 'For this update, unlock once with your master password. DataMoat will refresh Touch ID automatically.';
  if (unlockOptions.passwordEnabled) {
    document.getElementById('password-section').style.display = '';
    document.getElementById('password-controls').style.display = '';
    document.getElementById('pw-input').focus();
  }
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
    if (d.touchIdRefreshRequired) {
      showTouchIdRefreshRequired('Use your master password once. DataMoat will refresh Touch ID automatically after unlock.');
      return;
    }
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
      showTotpStep();
      btn.classList.remove('waiting');
      btn.innerHTML = TOUCHID_SVG;
      touchIdUnlockInFlight = false;
      return;
    }
    if (d.touchIdRefreshRequired) {
      showTouchIdRefreshRequired(d.error);
      touchIdUnlockInFlight = false;
      return;
    }
    showTouchIdRefreshRequired('Use your master password once. DataMoat will refresh Touch ID automatically after unlock.');
    restoreTouchIdHint();
  } catch {
    showTouchIdRefreshRequired('Use your master password once. DataMoat will refresh Touch ID automatically after unlock.');
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
  try {
    const r = await apiFetch('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const d = await r.json();
    if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return; }
    if (d.needsTotp) {
      // Password ok, need TOTP step
      showTotpStep();
      btnUnlock.disabled = false; btnUnlock.textContent = 'Unlock';
      return;
    }
    pwInput.classList.add('error');
    document.getElementById('pw-error').textContent = d.error || 'Wrong password';
    pwInput.value = '';
    setTimeout(() => pwInput.classList.remove('error'), 600);
  } catch {
    document.getElementById('pw-error').textContent = 'DataMoat is reconnecting. Try again in a moment.';
  }
  btnUnlock.disabled = false; btnUnlock.textContent = 'Unlock';
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

function showExpiredUnlock(message) {
  showPassword();
  document.getElementById('pw-error').textContent = message;
  btnUnlock.disabled = pwInput.value.length < 1;
  btnUnlock.textContent = 'Unlock';
  btnTotp.disabled = true;
  btnTotp.textContent = 'Verify';
  totpInput.value = '';
}

async function restartPasswordAuthForTotp(totpToken) {
  const password = pwInput.value;
  if (!password) {
    showExpiredUnlock('Unlock request expired. Enter your password again.');
    return true;
  }
  document.getElementById('totp-error').textContent = 'Refreshing unlock request...';
  const r = await apiFetch('/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const d = await r.json();
  if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return true; }
  if (d.needsTotp) {
    showTotpStep();
    totpInput.value = totpToken;
    await verifyTOTP({ totpToken, allowRestart: false });
    return true;
  }
  showExpiredUnlock(d.error || 'Unlock request expired. Enter your password again.');
  return true;
}

async function verifyTOTP(options = {}) {
  const totpToken = typeof options.totpToken === 'string' ? options.totpToken : totpInput.value;
  const allowRestart = options.allowRestart !== false;
  btnTotp.disabled = true;
  btnTotp.innerHTML = '<span class="spinner"></span>Verifying…';
  const r = await apiFetch('/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totpToken }),
  });
  const d = await r.json();
  if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return; }
  if (d.restartAuth && allowRestart) {
    await restartPasswordAuthForTotp(totpToken);
    return;
  }
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
  try {
    const r = await apiFetch('/api/auth/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mnemonic: val }),
    });
    const d = await r.json();
    if (d.ok) { rememberPostUnlockState(d); window.location.replace('/?refresh=' + Date.now()); return; }
    error.textContent = d.error || 'Invalid recovery phrase';
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
