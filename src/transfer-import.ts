import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
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
  BOOTSTRAP_CAPTURE_DIR,
  BOOTSTRAP_CAPTURE_FILE,
  BOOTSTRAP_CAPTURE_INDEX_FILE,
  DATAMOAT_ROOT,
  INSTALL_CHOICE_FILE,
  INSTALL_INFO_FILE,
  OFFSETS_FILE,
  RAW_ARCHIVE_DIR,
  RAW_DIR,
  SESSIONS_FILE,
  STATE_DIR,
  VAULT_DIR,
} from './config'
import {
  appendSerializedMessages,
  appendSerializedRawRecords,
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
  encryptStateForSession,
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
  copySourceArchiveFromRoot,
  summarizeSourceArchiveFromRoot,
  type SourceArchiveSummary,
} from './source-archive'
import { dedupeAndSortOps, mergeAnnotationOps } from './annotations'
import type { AnnotationOp } from './annotations'
import { writeAuditEvent, writeLog } from './logging'
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
import { stopBootstrapCaptureSession } from './bootstrap-capture'
import { stopWatchers } from './watcher'

const STATE_PREFIX = 'dmstate1:'
const TRANSFER_JOB_FILE = path.join(STATE_DIR, 'transfer-import-job.json')
const TRANSFER_IMPORTS_FILE = path.join(STATE_DIR, 'transfer-imports.json')
const REPLACE_JOURNAL_FILE = path.join(STATE_DIR, 'transfer-replace-journal.json')
const IMPORTED_SESSION_PREFIX = 'transfer-import'
const STORAGE_SAFETY_MIN_BYTES = 512 * 1024 * 1024
const STORAGE_SAFETY_MAX_BYTES = 2 * 1024 * 1024 * 1024
const STORAGE_SAFETY_RATIO = 0.05
const PRESERVED_BOOTSTRAP_CAPTURE_ROOT = 'datamoat-bootstrap-capture-'
const BOOTSTRAP_CAPTURE_SECRET_FILE = path.join(STATE_DIR, 'bootstrap-capture-secret')
const WINDOWS_BOOTSTRAP_CAPTURE_SECRET_FILE = path.join(
  STATE_DIR,
  'windows-secrets',
  `${Buffer.from('bootstrapCaptureSecret', 'utf8').toString('base64url')}.dpapi`,
)

type SourceSessionPayload = {
  session: Session
  messages: Message[]
  messageLines: string[]
  rawRecords: RawRecord[]
  legacyRawRecordLines: string[]
  archiveSummary: SourceArchiveSummary
  rawRecordCount: number
  identity: string
  basicIdentity: string
}

type SourceJsonLinePayload<T> = {
  values: T[]
  lines: string[]
}

type SourceValidationResult = {
  sessions: Session[]
  skippedMissingSessions: Session[]
  skippedMissingVaultPaths: string[]
  totalSessions: number
}

type PreservedBootstrapCapture = {
  root: string
}

type TransferredReferencedAttachmentIndex = {
  protected?: unknown
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

async function readSourceJsonLinePayload<T>(filePath: string, helperSessionId: string): Promise<SourceJsonLinePayload<T>> {
  if (!fs.existsSync(filePath)) return { values: [], lines: [] }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) return { values: [], lines: [] }
  const decoded = lines[0].startsWith('{')
    ? lines
    : await decryptLinesForSession(helperSessionId, lines)
  const values: T[] = []
  const validLines: string[] = []
  for (const line of decoded) {
    try {
      values.push(JSON.parse(line) as T)
      validLines.push(line)
    } catch {
      /* skip malformed legacy lines */
    }
  }
  return { values, lines: validLines }
}

async function readSourceJsonLines<T>(filePath: string, helperSessionId: string): Promise<T[]> {
  return (await readSourceJsonLinePayload<T>(filePath, helperSessionId)).values
}

function relativeVaultPath(root: string, relativePath: string): string {
  return path.join(root, 'vault', ...relativePath.split(/[\\/]/).filter(Boolean))
}

function writePrivateText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
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

function shaText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
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

function messageIdentity(message: Message | undefined): string {
  if (!message) return ''
  return [
    message.id,
    message.role,
    message.timestamp,
    message.model ?? '',
    message.rawRef?.rawHash ?? '',
  ].join('\0')
}

function transferSessionIdentity(
  session: Session,
  rawRecords: RawRecord[],
  archiveSummary: SourceArchiveSummary,
  messages: Message[],
  messageLines: string[],
): string {
  const firstRaw = rawRecords[0]?.rawHash || archiveSummary.firstRawHash || ''
  const lastRaw = archiveSummary.lastRawHash || rawRecords[rawRecords.length - 1]?.rawHash || ''
  const firstMessage = messageLines[0] ? shaText(messageLines[0]) : messageIdentity(messages[0])
  const lastMessage = messageLines[messageLines.length - 1] ? shaText(messageLines[messageLines.length - 1]) : messageIdentity(messages[messages.length - 1])
  const rawRecordCount = rawRecords.length + Math.max(0, Number(archiveSummary.rawRecords || 0))
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
      String(rawRecordCount),
      archiveSummary.fingerprint || '',
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

function serializedMessagesForDestination(payload: SourceSessionPayload, destinationUid: string): string[] {
  if (payload.session.uid === destinationUid) return payload.messageLines
  const needle = `"sessionUid":"${payload.session.uid}"`
  const replacement = `"sessionUid":"${destinationUid}"`
  return payload.messageLines.map(line => line.includes(needle) ? line.split(needle).join(replacement) : line)
}

function cleanupFailedDestinationSession(destinationSession: Session): void {
  try { fs.rmSync(path.join(VAULT_DIR, destinationSession.vaultPath), { force: true }) } catch { /* non-fatal */ }
  try { fs.rmSync(path.join(RAW_DIR, destinationSession.source, `${destinationSession.uid}.jsonl`), { force: true }) } catch { /* non-fatal */ }
  try { fs.rmSync(path.join(RAW_ARCHIVE_DIR, destinationSession.source, destinationSession.uid), { recursive: true, force: true }) } catch { /* non-fatal */ }
}

function rawRecordDedupeKey(record: RawRecord): string {
  return [
    record.source || '',
    record.sourcePath || '',
    record.sourceByteOffset ?? '',
    record.rawHash || '',
    record.capturedAt || '',
  ].join('\0')
}

function dedupeRawRecords(records: RawRecord[]): RawRecord[] {
  const seen = new Set<string>()
  const out: RawRecord[] = []
  for (const record of records) {
    const key = rawRecordDedupeKey(record)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(record)
  }
  return out
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
  const messagePayload = await readSourceJsonLinePayload<Message>(sourceVaultPath, helperSessionId)
  const legacyRawRecordPayload = await readSourceJsonLinePayload<RawRecord>(rawFilePath, helperSessionId)
  const archiveSummary = await summarizeSourceArchiveFromRoot(
    helperSessionId,
    path.join(root, 'vault', 'raw-archive'),
    session.source,
    session.uid,
  )
  const rawRecords = dedupeRawRecords(legacyRawRecordPayload.values)
  return {
    session,
    messages: messagePayload.values,
    messageLines: messagePayload.lines,
    rawRecords,
    legacyRawRecordLines: legacyRawRecordPayload.lines,
    archiveSummary,
    rawRecordCount: rawRecords.length + Math.max(0, Number(archiveSummary.rawRecords || 0)),
    identity: transferSessionIdentity(session, rawRecords, archiveSummary, messagePayload.values, messagePayload.lines),
    basicIdentity: basicSessionIdentity(session),
  }
}

async function validateUnlockedSource(root: string, helperSessionId: string): Promise<SourceValidationResult> {
  const sessions = await readSourceSessions(root, helperSessionId)
  const available: Session[] = []
  const missingSessions: Session[] = []
  for (const session of sessions) {
    if (fs.existsSync(relativeVaultPath(root, session.vaultPath))) available.push(session)
    else missingSessions.push(session)
  }
  const missingPaths = missingSessions.map(session => session.vaultPath)
  if (missingPaths.length > 0) {
    return {
      sessions: available,
      skippedMissingSessions: missingSessions,
      skippedMissingVaultPaths: missingPaths,
      totalSessions: sessions.length,
    }
  }
  return {
    sessions,
    skippedMissingSessions: [],
    skippedMissingVaultPaths: [],
    totalSessions: sessions.length,
  }
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

async function mergeSourceIntoCurrentVault(job: TransferImportJob, source: TransferUnlockResult, validation: SourceValidationResult): Promise<TransferImportJob> {
  if (!hasVaultSession()) throw new Error('current vault must be unlocked before merge')
  ensureDirs()
  const sessions = validation.sessions
  let nextJob = updateJob(job, {
    phase: 'importing-sessions',
    sourceVaultFingerprint: source.rootFingerprint,
    counts: {
      ...job.counts,
      sessions: Math.max(job.counts.sessions || 0, validation.totalSessions),
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

    const payload = await readSourceSessionPayload(source.root, source.helperSessionId, sourceSession)

    if (
      importsState.sessionIdentities[payload.identity]
      || importsState.basicSessionIdentities[payload.basicIdentity]
    ) {
      nextJob.skipped.sessions += 1
      nextJob.skipped.duplicates += 1
      nextJob.skipped.messages += payload.messages.length
      nextJob.skipped.rawRecords += payload.rawRecordCount
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
    const destinationMessageLines = serializedMessagesForDestination(payload, destinationUid)
    const destinationLegacyRawRecordLines = payload.legacyRawRecordLines
    let importedRawRecords = destinationLegacyRawRecordLines.length
    try {
      collectAttachmentIds(destinationMessages, neededAttachmentIds)
      await appendSerializedMessages(destinationSession, destinationMessageLines)
      await appendSerializedRawRecords(destinationSession.source, destinationSession.uid, destinationLegacyRawRecordLines)
      const currentSessionId = getVaultSessionId()
      if (!currentSessionId) throw new Error('current vault is locked')
      const archiveCopy = await copySourceArchiveFromRoot(
        source.helperSessionId,
        path.join(source.root, 'vault', 'raw-archive'),
        currentSessionId,
        sourceSession.source,
        sourceSession.uid,
        destinationSession.uid,
      )
      importedRawRecords += archiveCopy.rawRecords
      mergedSessions.push(destinationSession)
      await saveSessions(mergedSessions)
    } catch (error) {
      cleanupFailedDestinationSession(destinationSession)
      existingUids.delete(destinationUid)
      const mergedIndex = mergedSessions.findIndex(session => session.uid === destinationUid)
      if (mergedIndex >= 0) mergedSessions.splice(mergedIndex, 1)
      throw error
    }

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
    nextJob.imported.rawRecords += importedRawRecords
    writeJob(nextJob)
  }

  nextJob = await importAttachments(nextJob, source, importsState, neededAttachmentIds)
  await importAnnotationsFromSource(source)
  nextJob.currentSession = undefined
  nextJob.currentFile = undefined
  nextJob.done = true
  nextJob.completedAt = nowIso()
  return updateJob(nextJob, { phase: 'completed' })
}

// Union-merge the source vault's annotation op logs into the current vault.
// Ops are deduped by opId, so re-importing the same backup is a no-op and a
// backup made before new local annotations never drops them. Anchors are
// path-independent session identities, so ops re-attach even when the session
// uids differ between the two vaults. Failures are logged per anchor and never
// abort the surrounding import.
async function importAnnotationsFromSource(source: TransferUnlockResult): Promise<{ anchors: number; addedOps: number }> {
  const annotationsRoot = path.join(source.root, 'vault', 'annotations')
  let anchors = 0
  let addedOps = 0
  let entries: string[] = []
  try {
    entries = fs.existsSync(annotationsRoot)
      ? fs.readdirSync(annotationsRoot).filter(name => name.endsWith('.jsonl'))
      : []
  } catch {
    entries = []
  }
  for (const entry of entries) {
    const anchor = entry.slice(0, -'.jsonl'.length)
    try {
      const rawOps = await readSourceJsonLines<AnnotationOp>(path.join(annotationsRoot, entry), source.helperSessionId)
      const ops = dedupeAndSortOps(rawOps.filter(op => op && op.v === 1 && typeof op.opId === 'string' && op.opId.length > 0))
      if (ops.length === 0) continue
      const merged = await mergeAnnotationOps(anchor, ops)
      anchors += 1
      addedOps += merged.added
    } catch (error) {
      writeLog('warn', 'transfer', 'annotation_import_failed', { anchor, error: safeError(error) })
    }
  }
  if (anchors > 0) {
    writeAuditEvent('transfer', 'annotations_imported', { anchors, addedOps })
  }
  return { anchors, addedOps }
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
    || normalized === path.basename(INSTALL_CHOICE_FILE)
    || normalized === path.basename(INSTALL_INFO_FILE)
    || normalized === 'state/install-choice.json'
    || normalized === 'state/install-source.json'
    || normalized === 'state/port'
    || normalized === 'state/status.json'
    || normalized === 'state/health.json'
    || normalized === 'state/transfer-import-job.json'
    || normalized === 'state/transfer-imports.json'
    || normalized === 'state/transfer-replace-journal.json'
}

function hasCurrentBootstrapCapture(): boolean {
  return fs.existsSync(BOOTSTRAP_CAPTURE_FILE)
    || fs.existsSync(BOOTSTRAP_CAPTURE_INDEX_FILE)
    || fs.existsSync(BOOTSTRAP_CAPTURE_DIR)
}

function copyIfExists(from: string, to: string): void {
  if (!fs.existsSync(from)) return
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(from)
  if (stat.isDirectory()) {
    fs.cpSync(from, to, { recursive: true })
  } else if (stat.isFile()) {
    fs.copyFileSync(from, to)
    try { fs.chmodSync(to, stat.mode) } catch { /* non-fatal */ }
  }
}

async function preserveCurrentBootstrapCapture(): Promise<PreservedBootstrapCapture | null> {
  if (!hasCurrentBootstrapCapture()) return null

  await stopWatchers()
  await stopBootstrapCaptureSession()

  const preserveRoot = fs.mkdtempSync(path.join(os.tmpdir(), PRESERVED_BOOTSTRAP_CAPTURE_ROOT))
  copyIfExists(BOOTSTRAP_CAPTURE_FILE, path.join(preserveRoot, 'state', 'bootstrap-capture.json'))
  copyIfExists(BOOTSTRAP_CAPTURE_INDEX_FILE, path.join(preserveRoot, 'state', 'bootstrap-capture-index.json'))
  copyIfExists(BOOTSTRAP_CAPTURE_SECRET_FILE, path.join(preserveRoot, 'state', 'bootstrap-capture-secret'))
  copyIfExists(WINDOWS_BOOTSTRAP_CAPTURE_SECRET_FILE, path.join(preserveRoot, 'state', 'windows-secrets', path.basename(WINDOWS_BOOTSTRAP_CAPTURE_SECRET_FILE)))
  copyIfExists(BOOTSTRAP_CAPTURE_DIR, path.join(preserveRoot, 'bootstrap-capture'))
  return { root: preserveRoot }
}

function restorePreservedBootstrapCapture(preserved: PreservedBootstrapCapture | null): void {
  if (!preserved) return
  copyIfExists(path.join(preserved.root, 'state', 'bootstrap-capture.json'), BOOTSTRAP_CAPTURE_FILE)
  copyIfExists(path.join(preserved.root, 'state', 'bootstrap-capture-index.json'), BOOTSTRAP_CAPTURE_INDEX_FILE)
  copyIfExists(path.join(preserved.root, 'state', 'bootstrap-capture-secret'), BOOTSTRAP_CAPTURE_SECRET_FILE)
  copyIfExists(path.join(preserved.root, 'state', 'windows-secrets', path.basename(WINDOWS_BOOTSTRAP_CAPTURE_SECRET_FILE)), WINDOWS_BOOTSTRAP_CAPTURE_SECRET_FILE)
  copyIfExists(path.join(preserved.root, 'bootstrap-capture'), BOOTSTRAP_CAPTURE_DIR)
}

function removePreservedBootstrapCapture(preserved: PreservedBootstrapCapture | null): void {
  if (!preserved) return
  try { fs.rmSync(preserved.root, { recursive: true, force: true }) } catch { /* non-fatal */ }
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
    delete config.touchIdRefreshRequired
    delete config.touchIdRefreshRequiredAt
    delete config.backgroundWrappedVaultKey
    delete config.backgroundWrapSalt
    delete config.backgroundKeychainAccount
    delete config.backgroundKeychainRequester
    config.setupComplete = true
    writePrivateJson(authPath, config)
  }

  for (const relative of [
    'daemon.pid',
    `state/${path.basename(INSTALL_CHOICE_FILE)}`,
    `state/${path.basename(INSTALL_INFO_FILE)}`,
    'state/port',
    'state/status.json',
    'state/health.json',
    'state/transfer-import-job.json',
    'state/transfer-imports.json',
    'state/transfer-replace-journal.json',
    'state/bootstrap-capture.json',
    'state/bootstrap-capture-index.json',
    'state/bootstrap-capture-secret',
    `state/windows-secrets/${path.basename(WINDOWS_BOOTSTRAP_CAPTURE_SECRET_FILE)}`,
  ]) {
    try { fs.rmSync(path.join(root, ...relative.split('/')), { force: true }) } catch { /* ignore */ }
  }
  try { fs.rmSync(path.join(root, 'bootstrap-capture'), { recursive: true, force: true }) } catch { /* ignore */ }
}

async function resetTransferredReferencedAttachmentConsent(root: string, helperSessionId: string): Promise<void> {
  const statePath = path.join(root, 'state', 'referenced-attachments.json')
  if (!fs.existsSync(statePath)) return

  let protectedRecords: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(statePath, 'utf8').trim()
    let parsed: TransferredReferencedAttachmentIndex | null = null
    if (raw.startsWith('{')) {
      parsed = JSON.parse(raw) as TransferredReferencedAttachmentIndex
    } else if (raw.startsWith(STATE_PREFIX)) {
      parsed = JSON.parse(await decryptStateForSession(helperSessionId, raw.slice(STATE_PREFIX.length))) as TransferredReferencedAttachmentIndex
    }
    if (parsed?.protected && typeof parsed.protected === 'object' && !Array.isArray(parsed.protected)) {
      protectedRecords = parsed.protected as Record<string, unknown>
    }
  } catch (error) {
    writePrivateJson(path.join(root, 'state', 'referenced-attachments-reset-warning.json'), {
      resetAt: nowIso(),
      reason: safeError(error),
    })
  }

  const cleaned = {
    version: 2,
    enabled: false,
    enabledByUserAt: null,
    updatedAt: nowIso(),
    lastScanAt: null,
    previousSessionsChecked: 0,
    protected: protectedRecords,
    permissionIssues: {},
    checkedSessions: {},
  }

  try {
    const encrypted = await encryptStateForSession(helperSessionId, JSON.stringify(cleaned))
    writePrivateText(statePath, `${STATE_PREFIX}${encrypted}`)
  } catch (error) {
    writePrivateJson(path.join(root, 'state', 'referenced-attachments-reset-warning.json'), {
      resetAt: nowIso(),
      reason: safeError(error),
    })
    try { fs.rmSync(statePath, { force: true }) } catch { /* ignore */ }
  }
}

function sortSessionsForIndex(sessions: Session[]): Session[] {
  return sessions
    .map(normalizeSessionIdentity)
    .sort((a, b) => {
      const timeDelta = Date.parse(b.lastTimestamp || '') - Date.parse(a.lastTimestamp || '')
      if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta
      const messageDelta = (b.messageCount || 0) - (a.messageCount || 0)
      if (messageDelta !== 0) return messageDelta
      return String(a.uid || a.id).localeCompare(String(b.uid || b.id))
    })
}

async function writeTransferredSessionsIndex(root: string, helperSessionId: string, sessions: Session[]): Promise<void> {
  const sorted = sortSessionsForIndex(sessions)
  const idx: SessionsIndex = {
    version: 2,
    updatedAt: nowIso(),
    sessions: sorted,
  }
  const encrypted = await encryptStateForSession(helperSessionId, JSON.stringify(idx))
  writePrivateText(path.join(root, 'state', 'sessions.json'), `${STATE_PREFIX}${encrypted}`)
  const bySource: Partial<Record<Source, number>> = {}
  for (const session of sorted) bySource[session.source] = (bySource[session.source] ?? 0) + 1
  writePrivateJson(path.join(root, 'state', 'status.json'), {
    totalSessions: sorted.length,
    bySource,
    lastTimestamp: sorted[0]?.lastTimestamp ?? null,
    updatedAt: idx.updatedAt,
  })
}

async function switchCurrentRootToSource(
  job: TransferImportJob,
  sourceRoot: string,
  helperSessionId: string,
  sourceSessions: Session[],
): Promise<TransferImportJob> {
  if (sourceInsideDestination(sourceRoot, DATAMOAT_ROOT)) {
    throw new Error('transfer source folder must not be inside the active DataMoat folder')
  }
  let nextJob = updateJob(job, { phase: 'backing-up-current-root' })
  const backupRoot = backupPathForRoot(DATAMOAT_ROOT)
  const stagingRoot = stagingPathForRoot(DATAMOAT_ROOT)
  const hadCurrentRoot = job.mode !== 'adopt' && fs.existsSync(DATAMOAT_ROOT) && !isRootEmpty(DATAMOAT_ROOT)
  let currentRootMoved = false
  let stagingPromoted = false
  let preservedBootstrap: PreservedBootstrapCapture | null = null
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
    await resetTransferredReferencedAttachmentConsent(stagingRoot, helperSessionId)
    removeTransferNoiseFiles(stagingRoot)
    await writeTransferredSessionsIndex(stagingRoot, helperSessionId, sourceSessions)
    nextJob = updateJob(nextJob, { phase: 'finalizing-transfer-root' })
    preservedBootstrap = await preserveCurrentBootstrapCapture()
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
    restorePreservedBootstrapCapture(preservedBootstrap)
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
    restorePreservedBootstrapCapture(preservedBootstrap)
    throw error
  } finally {
    removePreservedBootstrapCapture(preservedBootstrap)
  }
}

async function adoptOrReplaceRoot(job: TransferImportJob, source: TransferUnlockResult, validation: SourceValidationResult): Promise<TransferImportJob> {
  const sessions = validation.sessions
  let nextJob = updateJob(job, {
    sourceVaultFingerprint: source.rootFingerprint,
    counts: {
      ...job.counts,
      sessions: Math.max(job.counts.sessions || 0, validation.totalSessions),
    },
  })
  nextJob = await switchCurrentRootToSource(nextJob, source.root, source.helperSessionId, sessions)
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
    const validation = await validateUnlockedSource(source.root, source.helperSessionId)
    if (validation.skippedMissingSessions.length > 0) {
      const skippedMessages = validation.skippedMissingSessions.reduce((sum, session) => sum + Math.max(0, Number(session.messageCount || 0)), 0)
      job = updateJob(job, {
        skipped: {
          ...job.skipped,
          sessions: job.skipped.sessions + validation.skippedMissingSessions.length,
          messages: job.skipped.messages + skippedMessages,
        },
        warnings: [
          ...(job.warnings ?? []),
          `Skipped ${validation.skippedMissingSessions.length} stale session index entr${validation.skippedMissingSessions.length === 1 ? 'y' : 'ies'} whose parsed vault file was missing from the transfer folder.`,
        ],
        counts: {
          ...job.counts,
          sessions: Math.max(job.counts.sessions || 0, validation.totalSessions),
        },
      })
    }

    if (options.mode === 'merge') {
      return await mergeSourceIntoCurrentVault(job, source, validation)
    }
    return await adoptOrReplaceRoot(job, source, validation)
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
}
