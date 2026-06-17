import * as fs from 'fs'
import * as crypto from 'crypto'
import * as path from 'path'
import * as readline from 'readline'
import { Session, SessionsIndex, OffsetState, OffsetsIndex, Source, Message, RawRecord } from './types'
import { normalizeSessionIdentity } from './session-identity'
import {
  forEachSourceArchiveRawRecordBatch,
  readSourceArchiveRawRecords,
} from './source-archive'
import {
  VAULT_DIR,
  ATTACHMENTS_DIR,
  RAW_DIR,
  RAW_ARCHIVE_DIR,
  ANNOTATIONS_DIR,
  SKILLS_BACKUP_DIR,
  SKILLS_BLOBS_DIR,
  SKILLS_MANIFESTS_DIR,
  STATE_DIR,
  OFFSETS_FILE,
  SESSIONS_FILE,
  PUBLIC_STATUS_FILE,
  ALL_SOURCES,
  WATCHED_SOURCES,
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
  totalMessages?: number
  bySource: Partial<Record<Source, number>>
  messagesBySource?: Partial<Record<Source, number>>
  lastTimestamp: string | null
  updatedAt: string
}

const OFFSETS_SCHEMA_VERSION = 2
const SESSIONS_SCHEMA_VERSION = 2
const STATE_PREFIX = 'dmstate1:'
const RAW_RECORD_STREAM_BATCH_LINES = 25
const RAW_RECORD_STREAM_BATCH_BYTES = 8 * 1024 * 1024

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
    RAW_ARCHIVE_DIR,
    ANNOTATIONS_DIR,
    SKILLS_BACKUP_DIR,
    SKILLS_BLOBS_DIR,
    SKILLS_MANIFESTS_DIR,
    ...ALL_SOURCES.map(source => path.join(VAULT_DIR, source)),
    ...ALL_SOURCES.map(source => path.join(RAW_DIR, source)),
    ...ALL_SOURCES.map(source => path.join(RAW_ARCHIVE_DIR, source)),
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
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
}

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_MAP).map(([mime, ext]) => [ext, mime]),
) as Record<string, string>

type AttachmentFileInfo = { path: string; ext: string; encrypted: 'single' | 'chunked' | 'wrapped-chunked' | false }

const CHUNKED_ATTACHMENT_MAGIC = Buffer.from('dmattchunk1\n', 'utf8')
const CHUNKED_ATTACHMENT_PLAINTEXT_BYTES = 2 * 1024 * 1024

function validAttachmentId(id: string): boolean {
  return /^[a-f0-9]{64}$/i.test(id)
}

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

export async function saveAttachmentFromStream(readable: NodeJS.ReadableStream, mediaType: string): Promise<string> {
  const sessionId = requireWriteSession()
  const ext = EXT_MAP[mediaType] ?? 'bin'
  ensurePrivateDir(ATTACHMENTS_DIR)
  const tmpPath = path.join(ATTACHMENTS_DIR, `.attachment-${process.pid}-${crypto.randomBytes(6).toString('hex')}.dmchunk.tmp`)
  const fd = fs.openSync(tmpPath, 'w', 0o600)
  const hash = crypto.createHash('sha256')
  let closed = false
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  const close = (): void => {
    if (closed) return
    closed = true
    fs.closeSync(fd)
  }

  const writeEncryptedChunk = async (plaintext: Buffer): Promise<void> => {
    if (plaintext.length === 0) return
    const encrypted = await encryptBytesForSession(sessionId, plaintext)
    const lengthPrefix = Buffer.alloc(4)
    lengthPrefix.writeUInt32BE(encrypted.length, 0)
    fs.writeSync(fd, lengthPrefix)
    fs.writeSync(fd, encrypted)
  }

  try {
    fs.writeSync(fd, CHUNKED_ATTACHMENT_MAGIC)
    for await (const rawChunk of readable as AsyncIterable<Buffer | string>) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      hash.update(chunk)
      let combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
      while (combined.length >= CHUNKED_ATTACHMENT_PLAINTEXT_BYTES) {
        await writeEncryptedChunk(combined.subarray(0, CHUNKED_ATTACHMENT_PLAINTEXT_BYTES))
        combined = combined.subarray(CHUNKED_ATTACHMENT_PLAINTEXT_BYTES)
      }
      pending = combined
    }
    await writeEncryptedChunk(pending)
    try {
      fs.fsyncSync(fd)
    } catch {
      /* non-fatal */
    }
    close()
    const attachmentId = hash.digest('hex')
    const filePath = path.join(ATTACHMENTS_DIR, `${attachmentId}.${ext}.dmchunk`)
    if (fs.existsSync(filePath)) {
      fs.rmSync(tmpPath, { force: true })
    } else {
      fs.renameSync(tmpPath, filePath)
      try {
        fs.chmodSync(filePath, 0o600)
      } catch {
        /* non-fatal */
      }
    }
    return attachmentId
  } catch (error) {
    close()
    fs.rmSync(tmpPath, { force: true })
    throw error
  }
}

function attachmentFileInfo(id: string): AttachmentFileInfo | null {
  if (!validAttachmentId(id)) return null
  const normalizedId = id.toLowerCase()
  try {
    const files = fs.readdirSync(ATTACHMENTS_DIR)
    for (const file of files) {
      const wrappedChunkedMatch = file.match(new RegExp(`^${normalizedId}\\.([^.]+)\\.dmchunk\\.dmenc$`, 'i'))
      if (wrappedChunkedMatch) {
        return { path: path.join(ATTACHMENTS_DIR, file), ext: wrappedChunkedMatch[1], encrypted: 'wrapped-chunked' }
      }
      const chunkedMatch = file.match(new RegExp(`^${normalizedId}\\.([^.]+)\\.dmchunk$`, 'i'))
      if (chunkedMatch) {
        return { path: path.join(ATTACHMENTS_DIR, file), ext: chunkedMatch[1], encrypted: 'chunked' }
      }
      const encryptedMatch = file.match(new RegExp(`^${normalizedId}\\.([^.]+)\\.dmenc$`, 'i'))
      if (encryptedMatch) {
        return { path: path.join(ATTACHMENTS_DIR, file), ext: encryptedMatch[1], encrypted: 'single' }
      }
      const legacyMatch = file.match(new RegExp(`^${normalizedId}\\.([^.]+)$`, 'i'))
      if (legacyMatch) {
        return { path: path.join(ATTACHMENTS_DIR, file), ext: legacyMatch[1], encrypted: false }
      }
    }
  } catch {
    return null
  }
  return null
}

function readExact(fd: number, length: number): Buffer | null {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const bytesRead = fs.readSync(fd, buffer, offset, length - offset, null)
    if (bytesRead === 0) {
      if (offset === 0) return null
      throw new Error('unexpected end of attachment file')
    }
    offset += bytesRead
  }
  return buffer
}

async function forEachChunkedAttachment(
  info: AttachmentFileInfo,
  onPlaintext: (chunk: Buffer) => Promise<void> | void,
): Promise<void> {
  const sessionId = requireReadSession()
  const fd = fs.openSync(info.path, 'r')
  try {
    const magic = readExact(fd, CHUNKED_ATTACHMENT_MAGIC.length)
    if (!magic || !magic.equals(CHUNKED_ATTACHMENT_MAGIC)) throw new Error('invalid chunked attachment')
    for (;;) {
      const lengthPrefix = readExact(fd, 4)
      if (!lengthPrefix) break
      const encryptedLength = lengthPrefix.readUInt32BE(0)
      if (encryptedLength <= 0) throw new Error('invalid chunked attachment length')
      const encrypted = readExact(fd, encryptedLength)
      if (!encrypted) throw new Error('truncated chunked attachment')
      await onPlaintext(await decryptBytesForSession(sessionId, encrypted))
    }
  } finally {
    fs.closeSync(fd)
  }
}

async function forEachWrappedChunkedAttachment(
  info: AttachmentFileInfo,
  onPlaintext: (chunk: Buffer) => Promise<void> | void,
): Promise<void> {
  const sessionId = requireReadSession()
  const wrapped = fs.readFileSync(info.path)
  const payload = await decryptBytesForSession(sessionId, wrapped)
  let offset = 0
  const read = (length: number): Buffer | null => {
    if (offset >= payload.length) return null
    if (offset + length > payload.length) throw new Error('truncated wrapped chunked attachment')
    const chunk = payload.subarray(offset, offset + length)
    offset += length
    return chunk
  }

  const magic = read(CHUNKED_ATTACHMENT_MAGIC.length)
  if (!magic || !magic.equals(CHUNKED_ATTACHMENT_MAGIC)) throw new Error('invalid wrapped chunked attachment')
  for (;;) {
    const lengthPrefix = read(4)
    if (!lengthPrefix) break
    const encryptedLength = lengthPrefix.readUInt32BE(0)
    if (encryptedLength <= 0) throw new Error('invalid wrapped chunked attachment length')
    const encrypted = read(encryptedLength)
    if (!encrypted) throw new Error('truncated wrapped chunked attachment')
    await onPlaintext(await decryptBytesForSession(sessionId, encrypted))
  }
}

export async function readAttachment(id: string): Promise<{ data: Buffer; mediaType: string } | null> {
  const info = attachmentFileInfo(id)
  if (!info) return null
  const mediaType = EXT_MIME[info.ext] ?? 'application/octet-stream'
  if (info.encrypted === 'chunked' || info.encrypted === 'wrapped-chunked') {
    const chunks: Buffer[] = []
    const forEach = info.encrypted === 'wrapped-chunked'
      ? forEachWrappedChunkedAttachment
      : forEachChunkedAttachment
    await forEach(info, chunk => {
      chunks.push(chunk)
    })
    return { data: Buffer.concat(chunks), mediaType }
  }
  const data = fs.readFileSync(info.path)
  if (!info.encrypted) return { data, mediaType }
  return { data: await decryptBytesForSession(requireReadSession(), data), mediaType }
}

export function attachmentMetadata(id: string): { mediaType: string; chunked: boolean } | null {
  const info = attachmentFileInfo(id)
  if (!info) return null
  return {
    mediaType: EXT_MIME[info.ext] ?? 'application/octet-stream',
    chunked: info.encrypted === 'chunked' || info.encrypted === 'wrapped-chunked',
  }
}

async function writeBufferToWritable(writable: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onDrain = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      writable.removeListener('error', onError)
      writable.removeListener('drain', onDrain)
    }
    writable.once('error', onError)
    if (writable.write(chunk)) {
      cleanup()
      resolve()
    } else {
      writable.once('drain', onDrain)
    }
  })
}

export async function writeAttachmentToWritable(id: string, writable: NodeJS.WritableStream): Promise<{ mediaType: string } | null> {
  const info = attachmentFileInfo(id)
  if (!info) return null
  const mediaType = EXT_MIME[info.ext] ?? 'application/octet-stream'
  if (info.encrypted === 'chunked' || info.encrypted === 'wrapped-chunked') {
    const forEach = info.encrypted === 'wrapped-chunked'
      ? forEachWrappedChunkedAttachment
      : forEachChunkedAttachment
    await forEach(info, async chunk => {
      await writeBufferToWritable(writable, chunk)
    })
    return { mediaType }
  }
  const attachment = await readAttachment(id)
  if (!attachment) return null
  await writeBufferToWritable(writable, attachment.data)
  return { mediaType: attachment.mediaType }
}

export async function writeAttachmentToFile(id: string, destinationPath: string): Promise<{ mediaType: string } | null> {
  const info = attachmentFileInfo(id)
  if (!info) return null
  const mediaType = EXT_MIME[info.ext] ?? 'application/octet-stream'
  ensurePrivateDir(path.dirname(destinationPath))
  if (info.encrypted !== 'chunked' && info.encrypted !== 'wrapped-chunked') {
    const attachment = await readAttachment(id)
    if (!attachment) return null
    writePrivateBytes(destinationPath, attachment.data)
    return { mediaType: attachment.mediaType }
  }
  const tmpPath = `${destinationPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const fd = fs.openSync(tmpPath, 'w', 0o600)
  try {
    const forEach = info.encrypted === 'wrapped-chunked'
      ? forEachWrappedChunkedAttachment
      : forEachChunkedAttachment
    await forEach(info, chunk => {
      fs.writeSync(fd, chunk)
    })
    try {
      fs.fsyncSync(fd)
    } catch {
      /* non-fatal */
    }
  } catch (error) {
    fs.closeSync(fd)
    fs.rmSync(tmpPath, { force: true })
    throw error
  }
  fs.closeSync(fd)
  fs.renameSync(tmpPath, destinationPath)
  try {
    fs.chmodSync(destinationPath, 0o600)
  } catch {
    /* non-fatal */
  }
  return { mediaType }
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

  const messagesBySource = sessions.reduce<NonNullable<PublicStatus['messagesBySource']>>((acc, session) => {
    const count = Number.isFinite(session.messageCount) ? Math.max(0, session.messageCount) : 0
    acc[session.source] = (acc[session.source] || 0) + count
    return acc
  }, {})

  const status: PublicStatus = {
    totalSessions: sessions.length,
    totalMessages: Object.values(messagesBySource).reduce((sum, count) => sum + count, 0),
    bySource,
    messagesBySource,
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
  await appendSerializedMessages(session, messages.map(message => JSON.stringify(message)))
}

export async function appendSerializedMessages(session: Session, serialized: string[]): Promise<void> {
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)
  if (serialized.length === 0) {
    if (!fs.existsSync(filePath)) writePrivateText(filePath, '')
    return
  }

  const encrypted = await encryptLinesForSession(requireWriteSession(), serialized)
  fs.appendFileSync(filePath, `${encrypted.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

export async function replaceSessionMessages(session: Session, messages: Message[]): Promise<void> {
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)

  const serialized = messages.map(message => JSON.stringify(message))
  const encrypted = serialized.length > 0
    ? await encryptLinesForSession(requireWriteSession(), serialized)
    : []
  writePrivateText(filePath, encrypted.length > 0 ? `${encrypted.join('\n')}\n` : '')
}

export function makeRawPath(source: Source, sessionUid: string): string {
  return path.join(source, `${sessionUid}.jsonl`)
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

function parseRawRecordLine(line: string): RawRecord | null {
  try {
    return JSON.parse(line) as RawRecord
  } catch {
    return null
  }
}

export async function appendRawRecords(source: Source, sessionUid: string, records: RawRecord[]): Promise<void> {
  await appendSerializedRawRecords(source, sessionUid, records.map(record => JSON.stringify(record)))
}

export async function appendSerializedRawRecords(source: Source, sessionUid: string, serialized: string[]): Promise<void> {
  if (serialized.length === 0) return
  const filePath = path.join(RAW_DIR, makeRawPath(source, sessionUid))
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)

  const encrypted = await encryptLinesForSession(requireWriteSession(), serialized)
  fs.appendFileSync(filePath, `${encrypted.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

export async function replaceRawRecords(source: Source, sessionUid: string, records: RawRecord[]): Promise<void> {
  const filePath = path.join(RAW_DIR, makeRawPath(source, sessionUid))
  const dir = path.dirname(filePath)
  ensurePrivateDir(dir)

  const serialized = records.map(record => JSON.stringify(record))
  const encrypted = serialized.length > 0
    ? await encryptLinesForSession(requireWriteSession(), serialized)
    : []
  writePrivateText(filePath, encrypted.length > 0 ? `${encrypted.join('\n')}\n` : '')
}

export async function readRawRecords(source: Source, sessionUid: string): Promise<RawRecord[]> {
  const filePath = path.join(RAW_DIR, makeRawPath(source, sessionUid))
  const sessionId = availableStateSession()
  const archiveRecords = sessionId ? await readSourceArchiveRawRecords(sessionId, source, sessionUid) : []
  if (!fs.existsSync(filePath)) {
    return archiveRecords
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) {
    return archiveRecords
  }

  const decrypted = sessionId && !lines[0].startsWith('{')
    ? await decryptLinesForSession(sessionId, lines)
    : lines

  const legacyRecords = decrypted.map(parseRawRecordLine).filter((r): r is RawRecord => r !== null)
  return dedupeRawRecords([...legacyRecords, ...archiveRecords])
}

export async function forEachRawRecordBatch(
  source: Source,
  sessionUid: string,
  visitor: (records: RawRecord[]) => boolean | Promise<boolean | void> | void,
  options: { batchLines?: number; batchBytes?: number } = {},
): Promise<void> {
  const filePath = path.join(RAW_DIR, makeRawPath(source, sessionUid))
  const sessionId = getVaultSessionId()
  const batchLines = Math.max(1, Math.floor(options.batchLines || RAW_RECORD_STREAM_BATCH_LINES))
  const batchBytes = Math.max(1024, Math.floor(options.batchBytes || RAW_RECORD_STREAM_BATCH_BYTES))
  const seen = new Set<string>()

  const emitRecords = async (records: RawRecord[]): Promise<boolean> => {
    if (records.length === 0) return true
    const out: RawRecord[] = []
    for (const record of records) {
      const key = rawRecordDedupeKey(record)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(record)
    }
    if (out.length === 0) return true
    return (await visitor(out)) !== false
  }

  if (fs.existsSync(filePath)) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
    let encryptedLegacy: boolean | null = null
    let lines: string[] = []
    let bytes = 0

    const flush = async (): Promise<boolean> => {
      if (lines.length === 0) return true
      const current = lines
      lines = []
      bytes = 0
      const decrypted = encryptedLegacy
        ? await decryptLinesForSession(requireReadSession(), current)
        : current
      return emitRecords(decrypted.map(parseRawRecordLine).filter((r): r is RawRecord => r !== null))
    }

    for await (const rawLine of reader) {
      const line = rawLine.trim()
      if (!line) continue
      if (encryptedLegacy === null) encryptedLegacy = hasVaultSession() && !line.startsWith('{')
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (lines.length > 0 && (lines.length >= batchLines || bytes + lineBytes > batchBytes)) {
        if (!(await flush())) {
          reader.close()
          stream.destroy()
          return
        }
      }
      lines.push(line)
      bytes += lineBytes
      if (lineBytes >= batchBytes && !(await flush())) {
        reader.close()
        stream.destroy()
        return
      }
    }
    if (!(await flush())) return
  }

  if (sessionId) {
    await forEachSourceArchiveRawRecordBatch(sessionId, source, sessionUid, batchLines, emitRecords)
  }
}

export async function readSessionMessages(session: Session): Promise<Message[]> {
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  return await parseSessionMessageLines(lines)
}

export async function readSessionMessagesPage(session: Session, offset: number, limit: number): Promise<Message[]> {
  if (!Number.isFinite(limit) || limit <= 0) return []
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  if (!fs.existsSync(filePath)) return []
  const lines = await readNonEmptyLinePage(filePath, Math.max(0, Math.floor(offset)), Math.floor(limit))
  return await parseSessionMessageLines(lines)
}

export async function forEachSessionMessageBatch(
  session: Session,
  batchSize: number,
  visitor: (messages: Message[]) => boolean | Promise<boolean>,
): Promise<void> {
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  if (!fs.existsSync(filePath)) return
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const size = Math.max(1, Math.floor(batchSize))
  let batch: string[] = []

  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true
    const current = batch
    batch = []
    return await visitor(await parseSessionMessageLines(current))
  }

  try {
    for await (const line of reader) {
      if (!line) continue
      batch.push(line)
      if (batch.length >= size && !await flush()) break
    }
    await flush()
  } finally {
    reader.close()
    stream.destroy()
  }
}

export async function forEachSessionMessageLineBatch(
  session: Session,
  batchSize: number,
  visitor: (lines: string[]) => boolean | Promise<boolean>,
): Promise<void> {
  const filePath = path.join(VAULT_DIR, session.vaultPath)
  if (!fs.existsSync(filePath)) return
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const size = Math.max(1, Math.floor(batchSize))
  let batch: string[] = []

  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true
    const current = batch
    batch = []
    const decrypted = hasVaultSession() && !current[0].startsWith('{')
      ? await decryptLinesForSession(requireReadSession(), current)
      : current
    return await visitor(decrypted)
  }

  try {
    for await (const line of reader) {
      if (!line) continue
      batch.push(line)
      if (batch.length >= size && !await flush()) break
    }
    await flush()
  } finally {
    reader.close()
    stream.destroy()
  }
}

async function parseSessionMessageLines(lines: string[]): Promise<Message[]> {
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

async function readNonEmptyLinePage(filePath: string, offset: number, limit: number): Promise<string[]> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const selected: string[] = []
  let index = 0
  try {
    for await (const line of reader) {
      if (!line) continue
      if (index >= offset) selected.push(line)
      index += 1
      if (selected.length >= limit) break
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return selected
}

function fileStartsWithPlaintextJsonLine(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(8192)
    let position = 0
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position)
      if (bytesRead <= 0) return false
      for (let i = 0; i < bytesRead; i += 1) {
        const byte = buffer[i]
        if (byte === 10 || byte === 13 || byte === 32 || byte === 9) continue
        return byte === 123 // "{"
      }
      position += bytesRead
    }
  } finally {
    fs.closeSync(fd)
  }
}

export async function encryptVaultFiles(): Promise<void> {
  if (!hasVaultSession()) return
  for (const source of WATCHED_SOURCES) {
    const dir = path.join(VAULT_DIR, source)
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (file === '.DS_Store' || file.startsWith('._')) continue
      if (!file.endsWith('.jsonl')) continue
      const filePath = path.join(dir, file)
      try {
        if (!fileStartsWithPlaintextJsonLine(filePath)) continue
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
        const plaintext = lines.filter(line => line.startsWith('{'))
        if (plaintext.length === 0) continue
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
    if (file === '.DS_Store' || file.startsWith('._')) continue
    if (file.endsWith('.dmenc')) continue
    if (file.endsWith('.dmchunk')) continue
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
