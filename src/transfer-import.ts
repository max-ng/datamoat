import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  loadAuthConfig,
  normalizeMnemonic,
  sha256,
  verifyPassword,
} from './auth'
import type { AuthConfig } from './auth'
import {
  AUTH_FILE,
  DATAMOAT_ROOT,
  OFFSETS_FILE,
  SESSIONS_FILE,
  STATE_DIR,
  VAULT_DIR,
} from './config'
import {
  appendMessages,
  appendRawRecords,
  ensureDirs,
  getVaultSessionId,
  hasVaultSession,
  loadSessions,
  makeVaultPath,
  saveSessions,
  setVaultSession,
} from './store'
import type { Message, RawRecord, Session, SessionsIndex, Source } from './types'
import { normalizeSessionIdentity } from './session-identity'
import {
  decryptBytesForSession,
  decryptLinesForSession,
  decryptStateForSession,
  encryptBytesForSession,
  lockVaultSession,
  unwrapSecretToSession,
} from './vault-helper'
import {
  computeTransferRootFingerprint,
  inspectTransferRoot,
  transferManifestPath,
  transferStateManifestPath,
} from './transfer-export'
import {
  TRANSFER_IMPORTS_VERSION,
  TRANSFER_JOB_VERSION,
  TRANSFER_MANIFEST_FORMAT,
  type TransferAuthMethod,
  type TransferAuthSummary,
  type TransferCounts,
  type TransferCredentials,
  type TransferImportJob,
  type TransferImportedSessionRecord,
  type TransferImportsState,
  type TransferManifest,
  type TransferMode,
  type TransferPhase,
  type TransferPreflightResult,
  type TransferStorageCheck,
  type TransferUnlockResult,
} from './transfer-types'

const STATE_PREFIX = 'dmstate1:'
const TRANSFER_JOB_FILE = path.join(STATE_DIR, 'transfer-import-job.json')
const TRANSFER_IMPORTS_FILE = path.join(STATE_DIR, 'transfer-imports.json')
const REPLACE_JOURNAL_FILE = path.join(STATE_DIR, 'transfer-replace-journal.json')
const IMPORTED_SESSION_PREFIX = 'transfer-import'
const STORAGE_SAFETY_MIN_BYTES = 512 * 1024 * 1024
const STORAGE_SAFETY_MAX_BYTES = 2 * 1024 * 1024 * 1024
const STORAGE_SAFETY_RATIO = 0.05

type SourceSessionPayload = {
  session: Session
  messages: Message[]
  rawRecords: RawRecord[]
  identity: string
  basicIdentity: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  const fd = fs.openSync(tmpPath, 'r')
  try {
    fs.fsyncSync(fd)
  } catch {
    /* non-fatal */
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
}

function writeJob(job: TransferImportJob): void {
  writePrivateJson(TRANSFER_JOB_FILE, job)
}

function updateJob(job: TransferImportJob, patch: Partial<TransferImportJob> & { phase?: TransferPhase }): TransferImportJob {
  const next = {
    ...job,
    ...patch,
    updatedAt: nowIso(),
  }
  writeJob(next)
  return next
}

export function currentTransferImportJob(): TransferImportJob | null {
  return readJsonFile<TransferImportJob>(TRANSFER_JOB_FILE)
}

function defaultCounts(): TransferCounts {
  return {
    sessions: 0,
    vaultFiles: 0,
    rawFiles: 0,
    attachments: 0,
    skillsFiles: 0,
    stateFiles: 0,
    totalBytes: 0,
  }
}

function createJob(
  mode: TransferMode,
  sourceRoot: string,
  counts: TransferCounts,
  storage?: TransferStorageCheck | null,
): TransferImportJob {
  const startedAt = nowIso()
  return {
    version: TRANSFER_JOB_VERSION,
    id: crypto.randomBytes(12).toString('hex'),
    mode,
    sourceRoot,
    sourceVaultFingerprint: null,
    phase: 'preflight',
    startedAt,
    updatedAt: startedAt,
    counts,
    imported: { sessions: 0, messages: 0, rawRecords: 0, attachments: 0 },
    skipped: { sessions: 0, messages: 0, rawRecords: 0, attachments: 0, duplicates: 0 },
    failed: { sessions: 0, attachments: 0 },
    cursor: { sessionIndex: 0, attachmentIndex: 0 },
    storage,
    done: false,
  }
}

function defaultImportsState(): TransferImportsState {
  return {
    version: TRANSFER_IMPORTS_VERSION,
    updatedAt: nowIso(),
    sourceFingerprints: {},
    sessionIdentities: {},
    basicSessionIdentities: {},
    attachmentIds: {},
  }
}

function readImportsState(): TransferImportsState {
  const raw = readJsonFile<Partial<TransferImportsState>>(TRANSFER_IMPORTS_FILE)
  if (!raw || typeof raw !== 'object') return defaultImportsState()
  return {
    version: TRANSFER_IMPORTS_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    sourceFingerprints: raw.sourceFingerprints && typeof raw.sourceFingerprints === 'object' ? raw.sourceFingerprints : {},
    sessionIdentities: raw.sessionIdentities && typeof raw.sessionIdentities === 'object' ? raw.sessionIdentities : {},
    basicSessionIdentities: raw.basicSessionIdentities && typeof raw.basicSessionIdentities === 'object' ? raw.basicSessionIdentities : {},
    attachmentIds: raw.attachmentIds && typeof raw.attachmentIds === 'object' ? raw.attachmentIds : {},
  }
}

function writeImportsState(state: TransferImportsState): void {
  writePrivateJson(TRANSFER_IMPORTS_FILE, {
    ...state,
    version: TRANSFER_IMPORTS_VERSION,
    updatedAt: nowIso(),
  })
}

function sourceAuthSummary(config: AuthConfig): TransferAuthSummary {
  return {
    hasPassword: !!(config.passwordEnabled ?? config.passwordHash),
    hasMnemonic: !!config.mnemonicWrappedVaultKey || !!config.mnemonicHash,
    hasTouchId: !!(config.touchIdEnabled || config.touchIdWrappedVaultKey),
    hasBackgroundUnlock: !!config.backgroundWrappedVaultKey,
    totpEnrolled: config.totpEnrolled === true,
  }
}

function loadSourceAuthConfig(root: string): AuthConfig | null {
  const config = path.resolve(root) === DATAMOAT_ROOT
    ? loadAuthConfig()
    : readJsonFile<AuthConfig>(path.join(root, 'auth.json'))
  return config
    ? {
        ...config,
        setupComplete: config.setupComplete ?? true,
      }
    : null
}

function loadManifest(root: string): TransferManifest | null {
  const manifest = readJsonFile<TransferManifest>(transferManifestPath(root))
    ?? readJsonFile<TransferManifest>(transferStateManifestPath(root))
  if (manifest?.format !== TRANSFER_MANIFEST_FORMAT) return null
  return manifest
}

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory()
  } catch {
    return false
  }
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.max(0, Math.round(bytes))} B`
}

function transferStorageSafetyBytes(sourceBytes: number): number {
  const bytes = Math.max(0, Math.ceil(Number(sourceBytes) || 0))
  if (bytes <= 0) return 0
  return Math.min(
    STORAGE_SAFETY_MAX_BYTES,
    Math.max(STORAGE_SAFETY_MIN_BYTES, Math.ceil(bytes * STORAGE_SAFETY_RATIO)),
  )
}

export function requiredTransferStorageBytes(sourceBytes: number): number {
  const bytes = Math.max(0, Math.ceil(Number(sourceBytes) || 0))
  return bytes + transferStorageSafetyBytes(bytes)
}

export function evaluateTransferStorage(
  sourceBytes: number,
  availableBytes: number | null,
  destinationRoot = DATAMOAT_ROOT,
  checkedPath = path.dirname(DATAMOAT_ROOT),
): TransferStorageCheck {
  const normalizedSourceBytes = Math.max(0, Math.ceil(Number(sourceBytes) || 0))
  const safetyBytes = transferStorageSafetyBytes(normalizedSourceBytes)
  const requiredBytes = normalizedSourceBytes + safetyBytes
  const normalizedAvailableBytes = availableBytes === null || availableBytes === undefined
    ? null
    : Math.max(0, Math.floor(Number(availableBytes) || 0))
  const ok = normalizedAvailableBytes !== null && normalizedAvailableBytes >= requiredBytes
  const reason = ok
    ? undefined
    : normalizedAvailableBytes === null
      ? `Could not check free disk space before copying ${formatBytes(normalizedSourceBytes)} of DataMoat data.`
      : `Not enough disk space to restore this DataMoat folder. Need ${formatBytes(requiredBytes)} free, but only ${formatBytes(normalizedAvailableBytes)} is available.`
  return {
    ok,
    destinationRoot,
    checkedPath,
    sourceBytes: normalizedSourceBytes,
    safetyBytes,
    requiredBytes,
    availableBytes: normalizedAvailableBytes,
    reason,
  }
}

function nearestExistingPath(filePath: string): string {
  let current = path.resolve(filePath)
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return parent
    current = parent
  }
  return current
}

function availableBytesForPath(filePath: string): { checkedPath: string; availableBytes: number | null } {
  const checkedPath = nearestExistingPath(filePath)
  try {
    const stats = fs.statfsSync(checkedPath)
    const blockSize = Number(stats.bsize || 0)
    const availableBlocks = Number(stats.bavail ?? stats.bfree ?? 0)
    if (!Number.isFinite(blockSize) || !Number.isFinite(availableBlocks) || blockSize <= 0 || availableBlocks < 0) {
      return { checkedPath, availableBytes: null }
    }
    return { checkedPath, availableBytes: Math.floor(blockSize * availableBlocks) }
  } catch {
    return { checkedPath, availableBytes: null }
  }
}

export function checkTransferDestinationStorage(
  sourceBytes: number,
  mode: TransferMode | null | undefined,
  destinationRoot = DATAMOAT_ROOT,
): TransferStorageCheck | null {
  if (mode !== 'adopt' && mode !== 'replace') return null
  const destinationParent = path.dirname(path.resolve(destinationRoot))
  const { checkedPath, availableBytes } = availableBytesForPath(destinationParent)
  return evaluateTransferStorage(sourceBytes, availableBytes, destinationRoot, checkedPath)
}

export async function preflightTransferSource(root: string, mode?: TransferMode): Promise<TransferPreflightResult> {
  const resolvedRoot = path.resolve(root)
  const required = {
    authJson: fs.existsSync(path.join(resolvedRoot, 'auth.json')),
    vault: isDirectory(path.join(resolvedRoot, 'vault')),
    sessionsJson: fs.existsSync(path.join(resolvedRoot, 'state', 'sessions.json')),
  }
  const errors: string[] = []
  if (!required.authJson) errors.push('missing auth.json')
  if (!required.vault) errors.push('missing vault')
  if (!required.sessionsJson) errors.push('missing state/sessions.json')

  const authConfig = loadSourceAuthConfig(resolvedRoot)
  const auth = authConfig ? sourceAuthSummary(authConfig) : null
  if (auth && !auth.hasPassword && !auth.hasMnemonic) {
    errors.push('no portable unlock method found')
  }

  const counts = inspectTransferRoot(resolvedRoot)
  const storage = checkTransferDestinationStorage(counts.totalBytes, mode)
  if (storage && !storage.ok) errors.push(storage.reason || 'not enough disk space to restore this DataMoat folder')
  const manifest = loadManifest(resolvedRoot)
  const warnings: string[] = []
  if (auth?.hasTouchId) warnings.push('old Touch ID cannot be used on this computer')
  if (auth?.hasBackgroundUnlock) warnings.push('old background unlock secret cannot be used on this computer')
  if (manifest?.warnings?.length) warnings.push(...manifest.warnings)
  if (!manifest) warnings.push('transfer manifest not found; DataMoat will validate required files directly')

  let rootFingerprint: string | null = null
  try {
    rootFingerprint = computeTransferRootFingerprint(resolvedRoot)
  } catch (error) {
    warnings.push(`could not compute root fingerprint: ${safeError(error)}`)
  }

  return {
    ok: errors.length === 0,
    root: resolvedRoot,
    status: errors.length > 0 ? 'failed' : 'unlock required',
    required,
    counts: {
      ...counts,
      sessions: manifest?.counts.sessions ?? counts.sessions,
    },
    auth,
    manifest,
    storage,
    warnings: Array.from(new Set(warnings)),
    errors,
    rootFingerprint,
  }
}

export async function unlockTransferSource(root: string, credentials: TransferCredentials): Promise<TransferUnlockResult> {
  const resolvedRoot = path.resolve(root)
  const config = loadSourceAuthConfig(resolvedRoot)
  if (!config) throw new Error('transfer source auth.json is missing or unreadable')
  const rootFingerprint = computeTransferRootFingerprint(resolvedRoot)

  let method: TransferAuthMethod | null = null
  let helperSessionId: string | null = null

  if (credentials.password) {
    if (!(config.passwordEnabled ?? !!config.passwordHash) || !config.passwordHash) {
      throw new Error('password unlock is disabled for the transfer source')
    }
    if (!await verifyPassword(credentials.password, config.passwordHash)) {
      throw new Error('wrong password for transfer source')
    }
    if (!config.passwordWrappedVaultKey || !config.passwordWrapSalt) {
      throw new Error('transfer source password wrapper is missing')
    }
    helperSessionId = await unwrapSecretToSession(credentials.password, config.passwordWrapSalt, config.passwordWrappedVaultKey)
    method = 'password'
  } else if (credentials.mnemonic) {
    const normalized = normalizeMnemonic(credentials.mnemonic)
    if (sha256(normalized) !== config.mnemonicHash) {
      throw new Error('invalid recovery phrase for transfer source')
    }
    if (!config.mnemonicWrappedVaultKey || !config.mnemonicWrapSalt) {
      throw new Error('transfer source recovery phrase wrapper is missing')
    }
    helperSessionId = await unwrapSecretToSession(normalized, config.mnemonicWrapSalt, config.mnemonicWrappedVaultKey)
    method = 'mnemonic'
  }

  if (!helperSessionId || !method) {
    const auth = sourceAuthSummary(config)
    if (auth.hasTouchId && !auth.hasPassword && !auth.hasMnemonic) {
      throw new Error('Touch ID cannot transfer to another computer. Use the old computer to set or recover a master password or 24-word phrase first.')
    }
    throw new Error('enter the old master password or 24-word recovery phrase')
  }

  return {
    root: resolvedRoot,
    helperSessionId,
    method,
    rootFingerprint,
    auth: sourceAuthSummary(config),
  }
}

async function readSourceProtectedJson<T>(root: string, helperSessionId: string, relativePath: string, fallback: T): Promise<T> {
  const filePath = path.join(root, ...relativePath.split(/[\\/]/))
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return fallback
    if (raw.startsWith('{') || raw.startsWith('[')) return JSON.parse(raw) as T
    if (raw.startsWith(STATE_PREFIX)) {
      const json = await decryptStateForSession(helperSessionId, raw.slice(STATE_PREFIX.length))
      return JSON.parse(json) as T
    }
    const json = (await decryptLinesForSession(helperSessionId, [raw]))[0]
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

async function readSourceJsonLines<T>(filePath: string, helperSessionId: string): Promise<T[]> {
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) return []
  const decoded = lines[0].startsWith('{')
    ? lines
    : await decryptLinesForSession(helperSessionId, lines)
  return decoded.map(line => {
    try {
      return JSON.parse(line) as T
    } catch {
      return null
    }
  }).filter((value): value is T => value !== null)
}

function relativeVaultPath(root: string, relativePath: string): string {
  return path.join(root, 'vault', ...relativePath.split(/[\\/]/).filter(Boolean))
}

function rawPathForSession(root: string, source: Source, sessionUid: string): string {
  return path.join(root, 'vault', 'raw', source, `${sessionUid}.jsonl`)
}

async function readSourceSessions(root: string, helperSessionId: string): Promise<Session[]> {
  const raw = await readSourceProtectedJson<SessionsIndex | Session[] | null>(root, helperSessionId, 'state/sessions.json', null)
  if (!raw) return []
  const sessions = Array.isArray(raw) ? raw : raw.sessions ?? []
  return sessions.map(normalizeSessionIdentity)
}

function shaObject(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function basicSessionIdentity(session: Session): string {
  return crypto
    .createHash('sha256')
    .update([
      session.source,
      session.sourceClient ?? '',
      session.sourceAccount ?? '',
      session.id,
    ].join('\0'))
    .digest('hex')
}

function transferSessionIdentity(session: Session, rawRecords: RawRecord[], messages: Message[]): string {
  const firstRaw = rawRecords[0]?.rawHash ?? ''
  const lastRaw = rawRecords[rawRecords.length - 1]?.rawHash ?? ''
  const firstMessage = messages[0] ? shaObject(messages[0]) : ''
  const lastMessage = messages[messages.length - 1] ? shaObject(messages[messages.length - 1]) : ''
  return crypto
    .createHash('sha256')
    .update([
      'transfer-session-v1',
      session.source,
      session.sourceClient ?? '',
      session.sourceAccount ?? '',
      session.id,
      firstRaw,
      lastRaw,
      String(rawRecords.length),
      firstMessage,
      lastMessage,
      String(messages.length),
    ].join('\0'))
    .digest('hex')
}

function importedSessionUid(identity: string, existing: Set<string>): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const uid = crypto.createHash('sha256')
      .update(`${IMPORTED_SESSION_PREFIX}\0${identity}\0${attempt}`)
      .digest('hex')
      .slice(0, 24)
    if (!existing.has(uid)) return uid
  }
  throw new Error('could not allocate imported session uid')
}

function rewriteMessageForDestination(message: Message, sourceUid: string, destinationUid: string): Message {
  if (message.rawRef?.sessionUid !== sourceUid) return message
  return {
    ...message,
    rawRef: {
      ...message.rawRef,
      sessionUid: destinationUid,
    },
  }
}

function rewriteRawRecordForDestination(record: RawRecord, destinationSession: Session): RawRecord {
  return {
    ...record,
    source: destinationSession.source,
    sourcePath: record.sourcePath || destinationSession.originalPath,
  }
}

function isAttachmentId(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function collectAttachmentIds(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) collectAttachmentIds(item, out)
    return out
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'attachmentId' && typeof raw === 'string' && isAttachmentId(raw)) {
      out.add(raw.toLowerCase())
      continue
    }
    if (key === 'attachmentIds' && Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string' && isAttachmentId(item)) out.add(item.toLowerCase())
      }
      continue
    }
    collectAttachmentIds(raw, out)
  }
  return out
}

async function readSourceSessionPayload(root: string, helperSessionId: string, session: Session): Promise<SourceSessionPayload> {
  const sourceVaultPath = relativeVaultPath(root, session.vaultPath)
  const rawFilePath = rawPathForSession(root, session.source, session.uid)
  if (!fs.existsSync(sourceVaultPath)) {
    throw new Error(`missing vault file for session ${session.uid}`)
  }
  const messages = await readSourceJsonLines<Message>(sourceVaultPath, helperSessionId)
  const rawRecords = await readSourceJsonLines<RawRecord>(rawFilePath, helperSessionId)
  return {
    session,
    messages,
    rawRecords,
    identity: transferSessionIdentity(session, rawRecords, messages),
    basicIdentity: basicSessionIdentity(session),
  }
}

async function validateUnlockedSource(root: string, helperSessionId: string): Promise<Session[]> {
  const sessions = await readSourceSessions(root, helperSessionId)
  const missing: string[] = []
  for (const session of sessions) {
    if (!fs.existsSync(relativeVaultPath(root, session.vaultPath))) missing.push(session.vaultPath)
    if (missing.length >= 5) break
  }
  if (missing.length > 0) {
    throw new Error(`This transfer folder looks incomplete. Missing vault files: ${missing.join(', ')}`)
  }
  return sessions
}

function attachmentIdFromFile(fileName: string): string | null {
  const match = fileName.match(/^([a-f0-9]{64})\.[^.]+\.dmenc$/i)
  return match ? match[1].toLowerCase() : null
}

function listSourceAttachments(root: string): Array<{ id: string; filePath: string; fileName: string }> {
  const dir = path.join(root, 'vault', 'attachments')
  if (!fs.existsSync(dir)) return []
  const out: Array<{ id: string; filePath: string; fileName: string }> = []
  for (const fileName of fs.readdirSync(dir)) {
    const id = attachmentIdFromFile(fileName)
    if (!id) continue
    out.push({ id, filePath: path.join(dir, fileName), fileName })
  }
  return out.sort((a, b) => a.fileName.localeCompare(b.fileName))
}

function destinationAttachmentExists(id: string): boolean {
  const dir = path.join(VAULT_DIR, 'attachments')
  try {
    return fs.readdirSync(dir).some(fileName => fileName.toLowerCase().startsWith(`${id.toLowerCase()}.`))
  } catch {
    return false
  }
}

async function importAttachments(
  job: TransferImportJob,
  source: TransferUnlockResult,
  importsState: TransferImportsState,
  neededAttachmentIds?: Set<string>,
): Promise<TransferImportJob> {
  let nextJob = updateJob(job, { phase: 'importing-attachments' })
  const currentSessionId = getVaultSessionId()
  if (!currentSessionId) throw new Error('current vault is locked')
  const attachments = listSourceAttachments(source.root)
  nextJob.counts.attachments = attachments.length
  const destinationDir = path.join(VAULT_DIR, 'attachments')
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 })

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index]
    nextJob.currentFile = toPosix(path.relative(source.root, attachment.filePath))
    nextJob.cursor.attachmentIndex = index
    if (neededAttachmentIds && !neededAttachmentIds.has(attachment.id)) {
      nextJob.skipped.attachments += 1
      writeJob(nextJob)
      continue
    }
    if (importsState.attachmentIds[attachment.id] || destinationAttachmentExists(attachment.id)) {
      nextJob.skipped.attachments += 1
      writeJob(nextJob)
      continue
    }
    try {
      const plaintext = await decryptBytesForSession(source.helperSessionId, fs.readFileSync(attachment.filePath))
      const encrypted = await encryptBytesForSession(currentSessionId, plaintext)
      const destination = path.join(destinationDir, attachment.fileName)
      const tmp = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
      fs.writeFileSync(tmp, encrypted, { mode: 0o600 })
      fs.renameSync(tmp, destination)
      importsState.attachmentIds[attachment.id] = {
        importedAt: nowIso(),
        sourceFingerprint: source.rootFingerprint,
      }
      nextJob.imported.attachments += 1
      writeImportsState(importsState)
      writeJob(nextJob)
    } catch (error) {
      nextJob.failed.attachments += 1
      nextJob.lastError = safeError(error)
      writeJob(nextJob)
    }
  }
  nextJob.currentFile = undefined
  return updateJob(nextJob, { phase: 'importing-sessions' })
}

async function mergeSourceIntoCurrentVault(job: TransferImportJob, source: TransferUnlockResult, sessions: Session[]): Promise<TransferImportJob> {
  if (!hasVaultSession()) throw new Error('current vault must be unlocked before merge')
  ensureDirs()
  let nextJob = updateJob(job, {
    phase: 'importing-sessions',
    sourceVaultFingerprint: source.rootFingerprint,
    counts: {
      ...job.counts,
      sessions: sessions.length,
    },
  })
  const importsState = readImportsState()
  const currentSessions = await loadSessions()
  const existingUids = new Set(currentSessions.map(session => session.uid))
  const existingBasicIdentities = new Set(currentSessions.map(basicSessionIdentity))
  const mergedSessions = [...currentSessions]
  const neededAttachmentIds = new Set<string>()

  for (let index = 0; index < sessions.length; index += 1) {
    const sourceSession = sessions[index]
    nextJob.cursor.sessionIndex = index
    nextJob.currentSession = sourceSession.uid
    writeJob(nextJob)

    const sourceBasicIdentity = basicSessionIdentity(sourceSession)
    if (
      importsState.basicSessionIdentities[sourceBasicIdentity]
      || existingBasicIdentities.has(sourceBasicIdentity)
    ) {
      nextJob.skipped.sessions += 1
      nextJob.skipped.duplicates += 1
      nextJob.skipped.messages += Math.max(0, Number(sourceSession.messageCount || 0))
      writeJob(nextJob)
      continue
    }

    let payload: SourceSessionPayload
    try {
      payload = await readSourceSessionPayload(source.root, source.helperSessionId, sourceSession)
    } catch (error) {
      nextJob.failed.sessions += 1
      nextJob.lastError = safeError(error)
      writeJob(nextJob)
      continue
    }

    if (
      importsState.sessionIdentities[payload.identity]
      || importsState.basicSessionIdentities[payload.basicIdentity]
    ) {
      nextJob.skipped.sessions += 1
      nextJob.skipped.duplicates += 1
      nextJob.skipped.messages += payload.messages.length
      nextJob.skipped.rawRecords += payload.rawRecords.length
      writeJob(nextJob)
      continue
    }

    const destinationUid = existingUids.has(sourceSession.uid)
      ? importedSessionUid(payload.identity, existingUids)
      : sourceSession.uid
    existingUids.add(destinationUid)
    const destinationSession: Session = normalizeSessionIdentity({
      ...sourceSession,
      uid: destinationUid,
      vaultPath: makeVaultPath(sourceSession.source, destinationUid),
      messageCount: payload.messages.length || sourceSession.messageCount,
    })
    const destinationMessages = payload.messages.map(message => rewriteMessageForDestination(message, sourceSession.uid, destinationUid))
    const destinationRawRecords = payload.rawRecords.map(record => rewriteRawRecordForDestination(record, destinationSession))
    collectAttachmentIds(destinationMessages, neededAttachmentIds)

    await appendMessages(destinationSession, destinationMessages)
    await appendRawRecords(destinationSession.source, destinationSession.uid, destinationRawRecords)
    mergedSessions.push(destinationSession)
    await saveSessions(mergedSessions)

    const importedAt = nowIso()
    const record: TransferImportedSessionRecord = {
      source: sourceSession.source,
      sourceUid: sourceSession.uid,
      destinationUid,
      identity: payload.identity,
      basicIdentity: payload.basicIdentity,
      importedAt,
    }
    importsState.sessionIdentities[payload.identity] = record
    importsState.basicSessionIdentities[payload.basicIdentity] = record
    importsState.sourceFingerprints[source.rootFingerprint] = {
      root: source.root,
      firstImportedAt: importsState.sourceFingerprints[source.rootFingerprint]?.firstImportedAt ?? importedAt,
      lastImportedAt: importedAt,
      mode: 'merge',
    }
    existingBasicIdentities.add(payload.basicIdentity)
    writeImportsState(importsState)

    nextJob.imported.sessions += 1
    nextJob.imported.messages += destinationMessages.length
    nextJob.imported.rawRecords += destinationRawRecords.length
    writeJob(nextJob)
  }

  nextJob = await importAttachments(nextJob, source, importsState, neededAttachmentIds)
  nextJob.currentSession = undefined
  nextJob.currentFile = undefined
  nextJob.done = true
  nextJob.completedAt = nowIso()
  return updateJob(nextJob, { phase: 'completed' })
}

function isRootEmpty(root: string): boolean {
  try {
    if (!fs.existsSync(root)) return true
    return fs.readdirSync(root).filter(name => !isTransferNoiseName(name)).length === 0
  } catch {
    return true
  }
}

function sourceInsideDestination(sourceRoot: string, destinationRoot: string): boolean {
  const source = path.resolve(sourceRoot)
  const destination = path.resolve(destinationRoot)
  const relative = path.relative(destination, source)
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function backupPathForRoot(root: string): string {
  const parent = path.dirname(root)
  const base = path.basename(root)
  return path.join(parent, `${base}.transfer-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`)
}

function stagingPathForRoot(root: string): string {
  const parent = path.dirname(root)
  const base = path.basename(root)
  return path.join(parent, `${base}.transfer-staging-${new Date().toISOString().replace(/[:.]/g, '-')}`)
}

function isTransferNoiseName(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._')
}

function removeTransferNoiseFiles(root: string): void {
  if (!fs.existsSync(root)) return
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (isTransferNoiseName(entry.name)) {
        try { fs.rmSync(absolute, { recursive: true, force: true }) } catch { /* non-fatal */ }
        continue
      }
      if (entry.isDirectory()) stack.push(absolute)
    }
  }
}

function isTransferTransientPath(relativePath: string): boolean {
  const normalized = toPosix(relativePath)
  return normalized === 'daemon.pid'
    || normalized === 'state/port'
    || normalized === 'state/status.json'
    || normalized === 'state/health.json'
    || normalized === 'state/transfer-import-job.json'
    || normalized === 'state/transfer-imports.json'
    || normalized === 'state/transfer-replace-journal.json'
}

async function copyDirectory(
  source: string,
  destination: string,
  onProgress?: (relativePath: string, progress: { bytesDelta?: number; fileDone?: boolean }) => void,
): Promise<void> {
  const sourceRoot = path.resolve(source)
  const destinationRoot = path.resolve(destination)
  const copyFileWithProgress = async (from: string, to: string, relativePath: string, mode: number): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const input = fs.createReadStream(from)
      const output = fs.createWriteStream(to, { flags: 'wx', mode })
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        input.destroy()
        output.destroy()
        reject(error)
      }
      input.on('data', chunk => {
        onProgress?.(relativePath, { bytesDelta: Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk) })
      })
      input.on('error', fail)
      output.on('error', fail)
      output.on('finish', () => {
        if (settled) return
        settled = true
        onProgress?.(relativePath, { fileDone: true })
        resolve()
      })
      input.pipe(output)
    })
  }
  const copyEntry = async (from: string, to: string): Promise<void> => {
    const name = path.basename(from)
    if (isTransferNoiseName(name)) return
    const relativePath = toPosix(path.relative(sourceRoot, from))
    if (relativePath && isTransferTransientPath(relativePath)) return
    const stat = await fs.promises.lstat(from)
    if (stat.isDirectory()) {
      await fs.promises.mkdir(to, { recursive: true, mode: stat.mode })
      const children = await fs.promises.readdir(from)
      for (const child of children) {
        await copyEntry(path.join(from, child), path.join(to, child))
      }
      return
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.promises.readlink(from)
      await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
      await fs.promises.symlink(target, to)
      return
    }
    if (!stat.isFile()) return
    await fs.promises.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
    await copyFileWithProgress(from, to, relativePath, stat.mode)
    try { await fs.promises.chmod(to, stat.mode) } catch { /* non-fatal */ }
  }

  await fs.promises.mkdir(destinationRoot, { recursive: true, mode: 0o700 })
  const children = await fs.promises.readdir(sourceRoot)
  for (const child of children) {
    await copyEntry(path.join(sourceRoot, child), path.join(destinationRoot, child))
  }
}

function cleanMachineBoundTransferredState(root: string): void {
  const authPath = path.join(root, 'auth.json')
  const config = readJsonFile<AuthConfig>(authPath)
  if (config) {
    delete config.touchIdWrappedVaultKey
    config.touchIdEnabled = false
    delete config.backgroundWrappedVaultKey
    delete config.backgroundWrapSalt
    delete config.backgroundKeychainAccount
    delete config.backgroundKeychainRequester
    config.setupComplete = true
    writePrivateJson(authPath, config)
  }

  for (const relative of [
    'daemon.pid',
    'state/offsets.json',
    'state/port',
    'state/status.json',
    'state/health.json',
    'state/transfer-import-job.json',
    'state/transfer-imports.json',
    'state/transfer-replace-journal.json',
    'state/bootstrap-capture.json',
    'state/bootstrap-capture-index.json',
  ]) {
    try { fs.rmSync(path.join(root, ...relative.split('/')), { force: true }) } catch { /* ignore */ }
  }
  try { fs.rmSync(path.join(root, 'bootstrap-capture'), { recursive: true, force: true }) } catch { /* ignore */ }
}

async function switchCurrentRootToSource(job: TransferImportJob, sourceRoot: string): Promise<TransferImportJob> {
  if (sourceInsideDestination(sourceRoot, DATAMOAT_ROOT)) {
    throw new Error('transfer source folder must not be inside the active DataMoat folder')
  }
  let nextJob = updateJob(job, { phase: 'backing-up-current-root' })
  const backupRoot = backupPathForRoot(DATAMOAT_ROOT)
  const stagingRoot = stagingPathForRoot(DATAMOAT_ROOT)
  const hadCurrentRoot = job.mode !== 'adopt' && fs.existsSync(DATAMOAT_ROOT) && !isRootEmpty(DATAMOAT_ROOT)
  let currentRootMoved = false
  let stagingPromoted = false
  writePrivateJson(REPLACE_JOURNAL_FILE, {
    version: 1,
    mode: job.mode,
    sourceRoot,
    destinationRoot: DATAMOAT_ROOT,
    backupRoot,
    stagingRoot,
    phase: 'replace-started',
    startedAt: nowIso(),
  })

  try {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    nextJob = updateJob(nextJob, { phase: 'copying-source-root', backupRoot: hadCurrentRoot ? backupRoot : undefined })
    let copiedFiles = 0
    let copiedBytes = 0
    let lastJobWriteAt = 0
    await copyDirectory(sourceRoot, stagingRoot, (relativePath, progress) => {
      copiedBytes += Math.max(0, Number(progress.bytesDelta || 0))
      if (progress.fileDone) copiedFiles += 1
      const now = Date.now()
      const firstProgress = !nextJob.copy
      if (progress.fileDone || firstProgress || now - lastJobWriteAt >= 500) {
        lastJobWriteAt = now
        nextJob = updateJob(nextJob, {
          currentFile: relativePath,
          copy: { files: copiedFiles, bytes: copiedBytes },
        })
      } else {
        nextJob.currentFile = relativePath
        nextJob.copy = { files: copiedFiles, bytes: copiedBytes }
      }
    })
    nextJob = updateJob(nextJob, {
      currentFile: undefined,
      copy: { files: copiedFiles, bytes: copiedBytes },
    })
    removeTransferNoiseFiles(stagingRoot)
    nextJob = updateJob(nextJob, { phase: 'cleaning-machine-bound-auth' })
    cleanMachineBoundTransferredState(stagingRoot)
    removeTransferNoiseFiles(stagingRoot)
    nextJob = updateJob(nextJob, { phase: 'finalizing-transfer-root' })
    if (hadCurrentRoot) {
      await fs.promises.rename(DATAMOAT_ROOT, backupRoot)
      currentRootMoved = true
      nextJob.backupRoot = backupRoot
      writePrivateJson(path.join(backupRoot, 'state', 'transfer-replace-journal.json'), {
        version: 1,
        mode: job.mode,
        sourceRoot,
        destinationRoot: DATAMOAT_ROOT,
        backupRoot,
        stagingRoot,
        phase: 'current-root-backed-up',
        updatedAt: nowIso(),
      })
    } else {
      fs.rmSync(DATAMOAT_ROOT, { recursive: true, force: true })
      currentRootMoved = true
    }
    await fs.promises.rename(stagingRoot, DATAMOAT_ROOT)
    stagingPromoted = true
    writePrivateJson(path.join(DATAMOAT_ROOT, 'state', 'transfer-replace-journal.json'), {
      version: 1,
      mode: job.mode,
      sourceRoot,
      destinationRoot: DATAMOAT_ROOT,
      backupRoot: hadCurrentRoot ? backupRoot : null,
      stagingRoot,
      phase: 'completed',
      completedAt: nowIso(),
    })
    return nextJob
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    if (stagingPromoted || (!hadCurrentRoot && currentRootMoved)) {
      fs.rmSync(DATAMOAT_ROOT, { recursive: true, force: true })
    }
    if (hadCurrentRoot && fs.existsSync(backupRoot) && !fs.existsSync(DATAMOAT_ROOT)) {
      await fs.promises.rename(backupRoot, DATAMOAT_ROOT)
    }
    throw error
  }
}

async function adoptOrReplaceRoot(job: TransferImportJob, source: TransferUnlockResult, sessions: Session[]): Promise<TransferImportJob> {
  let nextJob = updateJob(job, {
    sourceVaultFingerprint: source.rootFingerprint,
    counts: {
      ...job.counts,
      sessions: sessions.length,
    },
  })
  nextJob = await switchCurrentRootToSource(nextJob, source.root)
  setVaultSession(source.helperSessionId)
  nextJob.done = true
  nextJob.completedAt = nowIso()
  nextJob.imported.sessions = sessions.length
  nextJob.imported.attachments = listSourceAttachments(source.root).length
  return updateJob(nextJob, { phase: 'completed' })
}

export async function runTransferImport(options: {
  sourceRoot: string
  mode: TransferMode
  credentials: TransferCredentials
}): Promise<TransferImportJob> {
  const sourceRoot = path.resolve(options.sourceRoot)
  const preflight = await preflightTransferSource(sourceRoot, options.mode)
  let job = createJob(options.mode, sourceRoot, preflight.counts, preflight.storage)
  writeJob(job)
  let source: TransferUnlockResult | null = null

  try {
    if (!preflight.ok) throw new Error(preflight.errors.join('; ') || 'transfer preflight failed')
    if ((options.mode === 'merge' || options.mode === 'replace') && !hasVaultSession()) {
      throw new Error('current vault must be unlocked before merge or replace')
    }
    if (options.mode === 'adopt' && fs.existsSync(AUTH_FILE) && !isRootEmpty(DATAMOAT_ROOT)) {
      throw new Error('adopt is only available before setup; use merge or replace for an existing vault')
    }

    job = updateJob(job, { phase: 'unlocking-source' })
    source = await unlockTransferSource(sourceRoot, options.credentials)
    job = updateJob(job, { phase: 'validating-source', sourceVaultFingerprint: source.rootFingerprint })
    const sessions = await validateUnlockedSource(source.root, source.helperSessionId)

    if (options.mode === 'merge') {
      return await mergeSourceIntoCurrentVault(job, source, sessions)
    }
    return await adoptOrReplaceRoot(job, source, sessions)
  } catch (error) {
    job.lastError = safeError(error)
    job.done = true
    job = updateJob(job, { phase: 'failed' })
    throw error
  } finally {
    if (source && options.mode === 'merge') {
      try { await lockVaultSession(source.helperSessionId) } catch { /* non-fatal */ }
    }
  }
}

export function resumeTransferImport(): TransferImportJob {
  const job = currentTransferImportJob()
  if (!job) throw new Error('no transfer import job exists')
  if (job.done) return job
  const next = {
    ...job,
    phase: fs.existsSync(job.sourceRoot) ? 'needs-reconnect' as const : 'needs-reconnect' as const,
    updatedAt: nowIso(),
    lastError: 'Reconnect the transfer folder and start the import again.',
  }
  writeJob(next)
  return next
}

export function cancelTransferImport(): TransferImportJob {
  const job = currentTransferImportJob()
  if (!job) throw new Error('no transfer import job exists')
  const next = {
    ...job,
    phase: 'cancelled' as const,
    done: true,
    updatedAt: nowIso(),
  }
  writeJob(next)
  return next
}

export async function verifyTransferredRootCanLoadSessions(): Promise<Session[]> {
  if (!hasVaultSession()) throw new Error('vault is locked')
  if (!fs.existsSync(SESSIONS_FILE)) throw new Error('sessions index is missing')
  if (!fs.existsSync(VAULT_DIR)) throw new Error('vault directory is missing')
  return await loadSessions()
}

export function transferredRootWasMachineCleaned(root = DATAMOAT_ROOT): boolean {
  const config = readJsonFile<AuthConfig>(path.join(root, 'auth.json'))
  if (!config) return false
  return !config.touchIdWrappedVaultKey
    && config.touchIdEnabled !== true
    && !config.backgroundWrappedVaultKey
    && !fs.existsSync(root === DATAMOAT_ROOT ? OFFSETS_FILE : path.join(root, 'state', 'offsets.json'))
}
