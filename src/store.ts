import * as fs from 'fs'
import * as crypto from 'crypto'
import * as path from 'path'
import { Session, SessionsIndex, OffsetState, OffsetsIndex, Source, Message, RawRecord } from './types'
import { normalizeSessionIdentity } from './session-identity'
import {
  VAULT_DIR,
  ATTACHMENTS_DIR,
  RAW_DIR,
  STATE_DIR,
  OFFSETS_FILE,
  SESSIONS_FILE,
  PUBLIC_STATUS_FILE,
} from './config'
import {
  decryptBytesForSession,
  decryptLinesForSession,
  decryptStateForSession,
  encryptBytesForSession,
  encryptLinesForSession,
  encryptStateForSession,
} from './vault-helper'

let _vaultSessionId: string | null = null
let _captureSessionId: string | null = null

type PublicStatus = {
  totalSessions: number
  bySource: Partial<Record<Source, number>>
  lastTimestamp: string | null
  updatedAt: string
}

const OFFSETS_SCHEMA_VERSION = 2
const SESSIONS_SCHEMA_VERSION = 2
const STATE_PREFIX = 'dmstate1:'

function ensurePrivateDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dirPath, 0o700)
  } catch {
    /* non-fatal */
  }
}

function writePrivateText(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath))
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  const fd = fs.openSync(tmpPath, 'r')
  try {
    fs.fsyncSync(fd)
  } catch {
    /* non-fatal */
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

function writePrivateBytes(filePath: string, content: Buffer): void {
  ensurePrivateDir(path.dirname(filePath))
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, content, { mode: 0o600 })
  const fd = fs.openSync(tmpPath, 'r')
  try {
    fs.fsyncSync(fd)
  } catch {
    /* non-fatal */
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function setVaultSession(sessionId: string): void {
  _vaultSessionId = sessionId
}

export function clearVaultSession(): void {
  _vaultSessionId = null
}

export function hasVaultSession(): boolean {
  return _vaultSessionId !== null
}

export function getVaultSessionId(): string | null {
  return _vaultSessionId
}

export function setCaptureSession(sessionId: string): void {
  _captureSessionId = sessionId
}

export function clearCaptureSession(): void {
  _captureSessionId = null
}

export function hasCaptureSession(): boolean {
  return _captureSessionId !== null
}

export function getCaptureSessionId(): string | null {
  return _captureSessionId
}

function requireReadSession(): string {
  if (!_vaultSessionId) throw new Error('vault is locked')
  return _vaultSessionId
}

function requireWriteSession(): string {
  const sessionId = _captureSessionId ?? _vaultSessionId
  if (!sessionId) throw new Error('vault capture session missing')
  return sessionId
}

function availableStateSession(): string | null {
  return _vaultSessionId ?? _captureSessionId
}

export function ensureDirs(): void {
  const dirs = [
    STATE_DIR,
    VAULT_DIR,
    ATTACHMENTS_DIR,
    RAW_DIR,
    path.join(VAULT_DIR, 'claude-cli'),
    path.join(VAULT_DIR, 'codex-cli'),
    path.join(VAULT_DIR, 'claude-app'),
    path.join(VAULT_DIR, 'openclaw'),
    path.join(RAW_DIR, 'claude-cli'),
    path.join(RAW_DIR, 'codex-cli'),
    path.join(RAW_DIR, 'claude-app'),
    path.join(RAW_DIR, 'openclaw'),
  ]
  let firstError: Error | null = null
  for (const dir of dirs) {
    try {
      ensurePrivateDir(dir)
    } catch (error) {
      if (!firstError) {
        firstError = error instanceof Error ? error : new Error(String(error))
      }
    }
  }
  if (firstError) {
    throw firstError
  }
}

const EXT_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_MAP).map(([mime, ext]) => [ext, mime]),
) as Record<string, string>

export async function saveAttachment(base64Data: string, mediaType: string): Promise<string> {
  const sessionId = requireWriteSession()
  const buf = Buffer.from(base64Data, 'base64')
  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  const ext = EXT_MAP[mediaType] ?? 'bin'
  const filePath = path.join(ATTACHMENTS_DIR, `${hash}.${ext}.dmenc`)
  if (!fs.existsSync(filePath)) {
    const encrypted = await encryptBytesForSession(sessionId, buf)
    writePrivateBytes(filePath, encrypted)
  }
  return hash
}

function attachmentFileInfo(id: string): { path: string; ext: string; encrypted: boolean } | null {
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR)
    for (const file of files) {
      const encryptedMatch = file.match(new RegExp(`^${id}\\.([^.]+)\\.dmenc$`))
      if (encryptedMatch) {
        return { path: path.join(ATTACHMENTS_DIR, file), ext: encryptedMatch[1], encrypted: true }
      }
      const legacyMatch = file.match(new RegExp(`^${id}\\.([^.]+)$`))
      if (legacyMatch) {
        return { path: path.join(ATTACHMENTS_DIR, file), ext: legacyMatch[1], encrypted: false }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function readAttachment(id: string): Promise<{ data: Buffer; mediaType: string } | null> {
  const info = attachmentFileInfo(id)
  if (!info) return null
  const mediaType = EXT_MIME[info.ext] ?? 'application/octet-stream'
  const data = fs.readFileSync(info.path)
  if (!info.encrypted) return { data, mediaType }
  return { data: await decryptBytesForSession(requireReadSession(), data), mediaType }
}

async function decryptJsonLine<T>(line: string): Promise<T> {
  const sessionId = availableStateSession()
  if (!sessionId) throw new Error('vault state session missing')
  const payload = line.startsWith(STATE_PREFIX) ? line.slice(STATE_PREFIX.length) : line
  const json = line.startsWith(STATE_PREFIX)
    ? await decryptStateForSession(sessionId, payload)
    : (await decryptLinesForSession(requireReadSession(), [line]))[0]
  return JSON.parse(json) as T
}

async function encryptJsonLine(value: unknown): Promise<string> {
  const json = JSON.stringify(value, null, 2)
  const line = await encryptStateForSession(requireWriteSession(), json)
  return `${STATE_PREFIX}${line}`
}

async function readProtectedJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim()
    if (!raw) return fallback
    if (raw.startsWith('{') || raw.startsWith('[')) return JSON.parse(raw) as T
    if (!availableStateSession()) return fallback
    return await decryptJsonLine<T>(raw)
  } catch {
    return fallback
  }
}

async function writeProtectedJson(filePath: string, value: unknown): Promise<void> {
  writePrivateText(filePath, await encryptJsonLine(value))
}

function timestampValue(value: string | null | undefined): number {
  if (!value) return -1
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : -1
}

function compareSessionsByActivity(a: Session, b: Session): number {
  const lastDelta = timestampValue(b.lastTimestamp) - timestampValue(a.lastTimestamp)
  if (lastDelta !== 0) return lastDelta

  const firstDelta = timestampValue(b.firstTimestamp) - timestampValue(a.firstTimestamp)
  if (firstDelta !== 0) return firstDelta

  const messageDelta = b.messageCount - a.messageCount
  if (messageDelta !== 0) return messageDelta

  return (a.uid || a.id).localeCompare(b.uid || b.id)
}

async function protectedStateVersion(filePath: string, kind: 'offsets' | 'sessions'): Promise<number | null> {
  if (!fs.existsSync(filePath)) return null
  const raw = await readProtectedJson<unknown | null>(filePath, null)
  if (!raw) return null

  if (kind === 'offsets') {
    if (isObjectRecord(raw) && isObjectRecord(raw.offsets)) {
      return typeof raw.version === 'number' ? raw.version : 0
    }
    return 0
  }

  if (Array.isArray(raw)) return 0
  if (isObjectRecord(raw) && Array.isArray(raw.sessions)) {
    return typeof raw.version === 'number' ? raw.version : 0
  }
  return 0
}

function writePublicStatus(sessions: Session[]): void {
  const bySource = sessions.reduce<PublicStatus['bySource']>((acc, session) => {
    acc[session.source] = (acc[session.source] || 0) + 1
    return acc
  }, {})

  const status: PublicStatus = {
    totalSessions: sessions.length,
    bySource,
    lastTimestamp: sessions[0]?.lastTimestamp ?? null,
    updatedAt: new Date().toISOString(),
  }

  ensurePrivateDir(path.dirname(PUBLIC_STATUS_FILE))
  writePrivateText(PUBLIC_STATUS_FILE, JSON.stringify(status, null, 2))
}

export function readPublicStatus(): PublicStatus | null {
  try {
    return JSON.parse(fs.readFileSync(PUBLIC_STATUS_FILE, 'utf8')) as PublicStatus
  } catch {
    return null
  }
}

export async function loadOffsets(): Promise<OffsetState> {
  const raw = await readProtectedJson<OffsetsIndex | OffsetState | null>(OFFSETS_FILE, null)
  if (!raw) return {}
  if (
    typeof raw === 'object'
    && raw !== null
    && 'offsets' in raw
    && typeof (raw as OffsetsIndex).offsets === 'object'
  ) {
    return (raw as OffsetsIndex).offsets
  }
  return raw as OffsetState
}

export async function saveOffsets(state: OffsetState): Promise<void> {
  const idx: OffsetsIndex = {
    version: OFFSETS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    offsets: state,
  }
  await writeProtectedJson(OFFSETS_FILE, idx)
}

export async function loadSessions(): Promise<Session[]> {
  const raw = await readProtectedJson<SessionsIndex | Session[] | null>(SESSIONS_FILE, null)
  if (!raw) return []
  const sessions = Array.isArray(raw) ? raw : (raw.sessions ?? [])
  return sessions.map(normalizeSessionIdentity).sort(compareSessionsByActivity)
}

export async function saveSessions(sessions: Session[]): Promise<void> {
  const idx: SessionsIndex = {
    version: SESSIONS_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    sessions: sessions.map(normalizeSessionIdentity).sort(compareSessionsByActivity),
  }
  await writeProtectedJson(SESSIONS_FILE, idx)
  writePublicStatus(idx.sessions)
}

export async function migrateStateStorage(): Promise<{ offsetsMigrated: boolean; sessionsMigrated: boolean }> {
  const offsetsVersion = await protectedStateVersion(OFFSETS_FILE, 'offsets')
  const sessionsVersion = await protectedStateVersion(SESSIONS_FILE, 'sessions')

  const offsetsMigrated = offsetsVersion !== null && offsetsVersion < OFFSETS_SCHEMA_VERSION
  const sessionsMigrated = sessionsVersion !== null && sessionsVersion < SESSIONS_SCHEMA_VERSION

  if (offsetsMigrated) {
    await saveOffsets(await loadOffsets())
  }
  if (sessionsMigrated) {
    await saveSessions(await loadSessions())
  }

  return { offsetsMigrated, sessionsMigrated }
}

export async function upsertSession(session: Session): Promise<void> {
  const sessions = await loadSessions()
  const normalized = normalizeSessionIdentity(session)
  const idx = sessions.findIndex(existing => existing.uid === normalized.uid)
  if (idx >= 0) sessions[idx] = normalized
  else sessions.push(normalized)
  await saveSessions(sessions)
}

export async function appendMessages(session: Session, messages: Message[]): Promise<void> {
  if (messages.length === 0) return
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)

  const serialized = messages.map(message => JSON.stringify(message))
  const encrypted = await encryptLinesForSession(requireWriteSession(), serialized)
  fs.appendFileSync(filePath, `${encrypted.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

export function makeRawPath(source: Source, sessionUid: string): string {
  return path.join(source, `${sessionUid}.jsonl`)
}

export async function appendRawRecords(source: Source, sessionUid: string, records: RawRecord[]): Promise<void> {
  if (records.length === 0) return
  const filePath = path.join(RAW_DIR, makeRawPath(source, sessionUid))
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)

  const serialized = records.map(record => JSON.stringify(record))
  const encrypted = await encryptLinesForSession(requireWriteSession(), serialized)
  fs.appendFileSync(filePath, `${encrypted.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

export async function readRawRecords(source: Source, sessionUid: string): Promise<RawRecord[]> {
  const filePath = path.join(RAW_DIR, makeRawPath(source, sessionUid))
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) return []

  const decrypted = hasVaultSession() && !lines[0].startsWith('{')
    ? await decryptLinesForSession(requireReadSession(), lines)
    : lines

  return decrypted.map(line => {
    try {
      return JSON.parse(line) as RawRecord
    } catch {
      return null
    }
  }).filter((r): r is RawRecord => r !== null)
}

export async function readSessionMessages(session: Session): Promise<Message[]> {
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) return []

  const decrypted = hasVaultSession() && !lines[0].startsWith('{')
    ? await decryptLinesForSession(requireReadSession(), lines)
    : lines

  return decrypted.map(line => {
    try {
      return JSON.parse(line) as Message
    } catch {
      return null
    }
  }).filter((message): message is Message => message !== null)
}

export async function encryptVaultFiles(): Promise<void> {
  if (!hasVaultSession()) return
  const sources = ['claude-cli', 'codex-cli', 'claude-app', 'openclaw']
  for (const source of sources) {
    const dir = path.join(VAULT_DIR, source)
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(dir, file)
      try {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
        if (!lines.some(line => line.startsWith('{'))) continue
        const plaintext = lines.filter(line => line.startsWith('{'))
        const encryptedPlaintext = await encryptLinesForSession(requireReadSession(), plaintext)
        let index = 0
        const rewritten = lines.map(line => (
          line.startsWith('{') ? encryptedPlaintext[index++] : line
        ))
        writePrivateText(filePath, `${rewritten.join('\n')}\n`)
      } catch {
        /* non-fatal */
      }
    }
  }
}

export async function encryptAttachmentFiles(): Promise<void> {
  if (!hasVaultSession()) return
  if (!fs.existsSync(ATTACHMENTS_DIR)) return

  for (const file of fs.readdirSync(ATTACHMENTS_DIR)) {
    if (file.endsWith('.dmenc')) continue
    const filePath = path.join(ATTACHMENTS_DIR, file)
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      const plaintext = fs.readFileSync(filePath)
      const encrypted = await encryptBytesForSession(requireReadSession(), plaintext)
      writePrivateBytes(`${filePath}.dmenc`, encrypted)
      fs.unlinkSync(filePath)
    } catch {
      /* non-fatal */
    }
  }
}

export async function encryptStateFiles(): Promise<void> {
  if (!hasVaultSession()) return
  const targets = [OFFSETS_FILE, SESSIONS_FILE]
  for (const filePath of targets) {
    if (!fs.existsSync(filePath)) continue
    try {
      const decoded = await readProtectedJson<unknown | null>(filePath, null)
      if (!decoded) continue
      await writeProtectedJson(filePath, decoded)
    } catch {
      /* non-fatal */
    }
  }
}

export function makeVaultPath(source: Source, sessionId: string): string {
  return path.join(source, `${sessionId}.jsonl`)
}
