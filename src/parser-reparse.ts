import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { PARSER_REPARSE_FILE } from './config'
import { CODEX_EXTRACTOR_VERSION, extractCodexLine } from './extractors/codex'
import type { RawImageData } from './extractors/claude'
import { safeError, updateHealth, writeAuditEvent, writeLog } from './logging'
import { sourceAccountFromPath } from './session-identity'
import {
  getCaptureSessionId,
  getVaultSessionId,
  loadSessions,
  makeVaultPath,
  readRawRecords,
  replaceSessionMessages,
  saveAttachment,
  upsertSession,
} from './store'
import type { Message, RawRecord, Session, Source } from './types'
import {
  decryptStateForSession,
  encryptStateForSession,
} from './vault-helper'

const STATE_PREFIX = 'dmstate1:'
const REPARSE_STATE_VERSION = 1
const SOURCE_PARSER_VERSIONS: Partial<Record<Source, number>> = {
  'codex-cli': CODEX_EXTRACTOR_VERSION,
}

type SessionReparseState = {
  source: Source
  parserVersion: number
  rawCount: number
  lastRawHash: string
  reparsedAt: string
  messageCount: number
}

type ParserReparseState = {
  version: number
  updatedAt: string
  sessions: Record<string, SessionReparseState>
}

type ReparseResult = {
  checked: number
  reparsed: number
  skipped: number
  errors: number
}

let reparseInFlight: Promise<ReparseResult> | null = null

function defaultState(): ParserReparseState {
  return {
    version: REPARSE_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    sessions: {},
  }
}

function stateSessionId(): string | null {
  return getVaultSessionId() ?? getCaptureSessionId()
}

function ensurePrivateDir(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* non-fatal */ }
}

async function readState(): Promise<ParserReparseState> {
  try {
    if (!fs.existsSync(PARSER_REPARSE_FILE)) return defaultState()
    const raw = fs.readFileSync(PARSER_REPARSE_FILE, 'utf8').trim()
    if (!raw) return defaultState()
    if (raw.startsWith('{')) return normalizeState(JSON.parse(raw))
    const sessionId = stateSessionId()
    if (!sessionId || !raw.startsWith(STATE_PREFIX)) return defaultState()
    const json = await decryptStateForSession(sessionId, raw.slice(STATE_PREFIX.length))
    return normalizeState(JSON.parse(json))
  } catch (error) {
    writeLog('warn', 'parser-reparse', 'read_state_failed', { error: safeError(error) })
    return defaultState()
  }
}

function normalizeState(value: unknown): ParserReparseState {
  if (!value || typeof value !== 'object') return defaultState()
  const raw = value as Partial<ParserReparseState>
  return {
    version: REPARSE_STATE_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
  }
}

async function writeState(state: ParserReparseState): Promise<void> {
  const sessionId = stateSessionId()
  if (!sessionId) throw new Error('parser reparse state session unavailable')
  const updated: ParserReparseState = {
    ...state,
    version: REPARSE_STATE_VERSION,
    updatedAt: new Date().toISOString(),
  }
  const encrypted = await encryptStateForSession(sessionId, JSON.stringify(updated))
  ensurePrivateDir(PARSER_REPARSE_FILE)
  const tmp = `${PARSER_REPARSE_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, `${STATE_PREFIX}${encrypted}`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, PARSER_REPARSE_FILE)
  try { fs.chmodSync(PARSER_REPARSE_FILE, 0o600) } catch { /* non-fatal */ }
}

export async function runParserReparseIfNeeded(reason: string): Promise<ReparseResult> {
  if (reparseInFlight) return reparseInFlight
  reparseInFlight = runParserReparse(reason).finally(() => {
    reparseInFlight = null
  })
  return reparseInFlight
}

async function runParserReparse(reason: string): Promise<ReparseResult> {
  if (!stateSessionId()) return { checked: 0, reparsed: 0, skipped: 0, errors: 0 }
  const startedAt = new Date().toISOString()
  const result: ReparseResult = { checked: 0, reparsed: 0, skipped: 0, errors: 0 }
  const state = await readState()
  const sessions = (await loadSessions()).filter(session => SOURCE_PARSER_VERSIONS[session.source])
  updateHealth('parser-reparse', {
    running: true,
    reason,
    startedAt,
    totalSessions: sessions.length,
  })

  for (const session of sessions) {
    result.checked += 1
    const parserVersion = SOURCE_PARSER_VERSIONS[session.source]
    if (!parserVersion) {
      result.skipped += 1
      continue
    }

    try {
      const rawRecords = dedupeRawRecords(await readRawRecords(session.source, session.uid))
      if (rawRecords.length === 0) {
        result.skipped += 1
        continue
      }
      const lastRawHash = rawRecords[rawRecords.length - 1]?.rawHash || ''
      const previous = state.sessions[session.uid]
      if (
        previous
        && previous.source === session.source
        && previous.parserVersion === parserVersion
        && previous.rawCount === rawRecords.length
        && previous.lastRawHash === lastRawHash
      ) {
        result.skipped += 1
        continue
      }

      const reparsed = await reparseSession(session, rawRecords)
      state.sessions[session.uid] = {
        source: session.source,
        parserVersion,
        rawCount: rawRecords.length,
        lastRawHash,
        reparsedAt: new Date().toISOString(),
        messageCount: reparsed.messageCount,
      }
      await writeState(state)
      result.reparsed += 1
      updateHealth('parser-reparse', {
        running: true,
        checked: result.checked,
        reparsed: result.reparsed,
        skipped: result.skipped,
        errors: result.errors,
        lastSession: session.uid,
      })
      await yieldToEventLoop()
    } catch (error) {
      result.errors += 1
      writeLog('warn', 'parser-reparse', 'session_reparse_failed', {
        source: session.source,
        session: session.uid,
        error: safeError(error),
      })
    }
  }

  updateHealth('parser-reparse', {
    running: false,
    reason,
    startedAt,
    completedAt: new Date().toISOString(),
    ...result,
  })
  writeAuditEvent('parser-reparse', 'completed', { reason, ...result })
  return result
}

function dedupeRawRecords(records: RawRecord[]): RawRecord[] {
  const seen = new Set<string>()
  const out: RawRecord[] = []
  for (const record of records) {
    const key = `${record.sourcePath}:${record.sourceByteOffset}:${record.rawHash}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(record)
  }
  return out.sort((a, b) => (
    a.sourcePath.localeCompare(b.sourcePath)
    || a.sourceByteOffset - b.sourceByteOffset
    || a.capturedAt.localeCompare(b.capturedAt)
  ))
}

async function reparseSession(session: Session, records: RawRecord[]): Promise<Session> {
  if (session.source !== 'codex-cli') return session

  let next: Session = { ...session }
  let sawModelFromRaw = false
  let sawCwdFromRaw = false
  const messages: Message[] = []
  for (const record of records) {
    const line = rawRecordLine(record)
    if (!line) continue
    const parsed = extractCodexLine(line)
    if (!parsed) continue
    if (parsed.sessionId) next.id = parsed.sessionId
    if (parsed.appVersion) next.appVersion = parsed.appVersion
    if (parsed.sourceClient) next.sourceClient = parsed.sourceClient
    if (parsed.model && !sawModelFromRaw) {
      next.model = parsed.model
      sawModelFromRaw = true
    }
    if (parsed.cwd && !sawCwdFromRaw) {
      next.cwd = parsed.cwd
      sawCwdFromRaw = true
    }
    if (!parsed.message) continue

    parsed.message.rawRef = { sessionUid: session.uid, rawHash: record.rawHash }
    await attachRawImages(parsed.message, parsed.rawImages)
    decorateMessageWithSession(parsed.message, next)
    updateSessionFromMessage(next, parsed.message)
    messages.push(parsed.message)
  }

  if (messages.length === 0) return next
  next = {
    ...next,
    sourceAccount: sourceAccountFromPath(next.source, next.originalPath),
    vaultPath: makeVaultPath(next.source, next.uid),
    messageCount: messages.length,
    firstTimestamp: messages[0]?.timestamp || next.firstTimestamp,
    lastTimestamp: messages[messages.length - 1]?.timestamp || next.lastTimestamp,
    hasThinking: messages.some(message => message.hasThinking),
  }
  await replaceSessionMessages(next, messages)
  await upsertSession(next)
  return next
}

function rawRecordLine(record: RawRecord): string | null {
  if (record.parseError) return typeof record.raw === 'string' ? record.raw : null
  try {
    return JSON.stringify(record.raw)
  } catch {
    return null
  }
}

async function attachRawImages(message: Message, rawImages: RawImageData[]): Promise<void> {
  for (const img of rawImages) {
    try {
      const attachmentId = await saveAttachment(img.base64Data, img.mediaType)
      const block = message.content[img.blockIndex]
      if (!block) continue
      if (typeof img.innerIndex === 'number') {
        block.attachmentIds = [...(block.attachmentIds || []), attachmentId]
      } else if (block.type === 'image') {
        block.attachmentId = attachmentId
        block.mediaType = img.mediaType
        if (img.attachmentName) block.attachmentName = img.attachmentName
      }
    } catch {
      // Message text remains protected even if one attachment cannot be saved.
    }
  }
}

function decorateMessageWithSession(message: Message, session: Session): void {
  if (!message.appVersion && session.appVersion) message.appVersion = session.appVersion
  if (!message.model && session.model && session.model !== 'unknown') message.model = session.model
}

function updateSessionFromMessage(session: Session, message: Message): void {
  if (!session.firstTimestamp || Date.parse(message.timestamp) < Date.parse(session.firstTimestamp)) {
    session.firstTimestamp = message.timestamp
  }
  if (!session.lastTimestamp || Date.parse(message.timestamp) > Date.parse(session.lastTimestamp)) {
    session.lastTimestamp = message.timestamp
  }
  if (message.hasThinking) session.hasThinking = true
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}
