import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { RAW_ARCHIVE_DIR, RAW_DIR, STATE_DIR, VAULT_DIR, VAULT_MAINTENANCE_FILE } from './config'
import {
  getVaultSessionId,
  loadSessions,
  makeRawPath,
  saveSessions,
} from './store'
import { decryptLinesForSession, encryptLinesForSession } from './vault-helper'
import { safeError, updateHealth, writeAuditEvent, writeLog } from './logging'
import { sourceArchiveSize } from './source-archive'
import type { ContentBlock, Message, RawRecord, Session } from './types'

export type VaultMaintenanceMode = 'dry-run' | 'apply'

export type VaultMaintenanceResult = {
  mode: VaultMaintenanceMode
  applied: boolean
  sessionsChecked: number
  sessionsWithDuplicateMessages: number
  duplicateMessages: number
  rawSessionsChecked: number
  rawSessionsWithDuplicateRecords: number
  duplicateRawRecords: number
  duplicateSessionGroups: number
  duplicateSessions: number
  estimatedReclaimableParsedBytes: number
  estimatedReclaimableRawBytes: number
  changedSessions: Array<{
    uid: string
    source: string
    duplicateMessages: number
    duplicateRawRecords: number
  }>
  errors: Array<{ uid: string; error: string }>
}

export type VaultSessionCompactResult = {
  uid: string
  source: string
  messageCount: number
  duplicateMessages: number
  duplicateMessageBytes: number
  duplicateRawRecords: number
  duplicateRawBytes: number
  nextMessageCount: number
  messageSequenceHash?: string
  rawSequenceHash?: string
}

type JsonlCompactResult = {
  uniqueCount: number
  duplicates: number
  duplicateBytes: number
  sequenceHash?: string
}

type VaultMaintenanceState = {
  version: number
  completedAt: string
  result: VaultMaintenanceResult
}

type BackgroundMaintenanceState = {
  version: number
  status: 'running' | 'complete'
  startedAt: string
  updatedAt: string
  queue: string[]
  completed: string[]
  totals: VaultMaintenanceResult
}

let scheduledMaintenance: Promise<VaultMaintenanceResult | null> | null = null
const VAULT_MAINTENANCE_VERSION = 3
const TRANSFER_REPLACE_JOURNAL_FILE = path.join(STATE_DIR, 'transfer-replace-journal.json')
const VAULT_MAINTENANCE_PROGRESS_FILE = path.join(STATE_DIR, 'vault-maintenance-progress.json')
const AUTO_MAINTENANCE_START_DELAY_MS = positiveNumber(process.env.DATAMOAT_AUTO_MAINTENANCE_START_DELAY_MS, 2_000)
const AUTO_MAINTENANCE_NEXT_DELAY_MS = positiveNumber(process.env.DATAMOAT_AUTO_MAINTENANCE_NEXT_DELAY_MS, 5_000)

type TransferReplaceJournal = {
  mode?: string
  phase?: string
  completedAt?: string
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function normalizedBlock(block: ContentBlock): unknown {
  return {
    ...block,
    attachmentId: block.attachmentId || undefined,
    attachmentIds: block.attachmentIds || undefined,
  }
}

function normalizedMessageKey(message: Message): string {
  return stableStringify({
    role: message.role,
    timestamp: message.timestamp,
    model: message.model || '',
    sourceEventType: message.sourceEventType || '',
    content: message.content.map(normalizedBlock),
    usage: message.usage || null,
    hasThinking: message.hasThinking,
  })
}

function rawRecordKey(record: RawRecord): string {
  return stableStringify({
    sourcePath: record.sourcePath,
    sourceByteOffset: record.sourceByteOffset,
    rawHash: record.rawHash,
  })
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function fileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function sessionVaultSize(session: Session): number {
  return fileSize(path.join(VAULT_DIR, session.vaultPath))
}

function rawVaultSize(session: Session): number {
  return fileSize(path.join(RAW_DIR, makeRawPath(session.source, session.uid))) + sourceArchiveSize(session.source, session.uid)
}

function sessionTotalVaultBytes(session: Session): number {
  return sessionVaultSize(session) + rawVaultSize(session)
}

function coarseDuplicateKey(session: Session): string {
  return [
    session.source,
    session.messageCount,
    session.firstTimestamp || '',
    session.lastTimestamp || '',
    session.model || '',
  ].join('\0')
}

function strongDuplicateKeys(session: Session): string[] {
  const source = session.source
  const id = session.id || ''
  const originalPath = session.originalPath || ''
  const lastTimestamp = session.lastTimestamp || ''
  const firstTimestamp = session.firstTimestamp || ''
  const keys = [coarseDuplicateKey(session)]

  if (id && originalPath && lastTimestamp) {
    keys.push(['source-id-path-last', source, id, originalPath, lastTimestamp].join('\0'))
  }
  if (originalPath && lastTimestamp) {
    keys.push(['source-path-last', source, originalPath, lastTimestamp].join('\0'))
  }
  if (id && lastTimestamp) {
    keys.push(['source-id-last', source, id, lastTimestamp].join('\0'))
  }
  if (id && firstTimestamp && lastTimestamp) {
    keys.push(['source-id-time-range', source, id, firstTimestamp, lastTimestamp].join('\0'))
  }

  return keys
}

function lastCompletedTransferAt(): number | null {
  let journal: TransferReplaceJournal | null = null
  try {
    journal = JSON.parse(fs.readFileSync(TRANSFER_REPLACE_JOURNAL_FILE, 'utf8')) as TransferReplaceJournal
  } catch {
    return null
  }
  if (!journal || journal.phase !== 'completed') return null
  if (journal.mode !== 'adopt' && journal.mode !== 'replace') return null
  const completedAt = Date.parse(journal.completedAt || '')
  return Number.isFinite(completedAt) ? completedAt : null
}

function transferBackfillCandidateUids(sessions: Session[]): Set<string> {
  const completedAt = lastCompletedTransferAt()
  const out = new Set<string>()
  if (!completedAt) return out
  for (const session of sessions) {
    const parsedPath = path.join(VAULT_DIR, session.vaultPath)
    const rawPath = path.join(RAW_DIR, makeRawPath(session.source, session.uid))
    if (fileMtimeMs(parsedPath) > completedAt || fileMtimeMs(rawPath) > completedAt) {
      out.add(session.uid)
    }
  }
  return out
}

function candidateDuplicateSessionUids(sessions: Session[]): Set<string> {
  const groups = new Map<string, Session[]>()
  for (const session of sessions) {
    for (const key of strongDuplicateKeys(session)) {
      const group = groups.get(key) || []
      group.push(session)
      groups.set(key, group)
    }
  }
  const out = new Set<string>()
  for (const group of groups.values()) {
    if (group.length <= 1) continue
    for (const session of group) out.add(session.uid)
  }
  for (const uid of transferBackfillCandidateUids(sessions)) out.add(uid)
  return out
}

async function compactJsonlFile(
  filePath: string,
  keyFor: (value: unknown) => string,
  mode: VaultMaintenanceMode,
  sequenceHash?: crypto.Hash,
  sequenceKeyFor?: (value: unknown) => string,
): Promise<JsonlCompactResult> {
  if (!fs.existsSync(filePath)) return { uniqueCount: 0, duplicates: 0, duplicateBytes: 0 }
  const sessionId = getVaultSessionId()
  const apply = mode === 'apply'
  if (apply && !sessionId) throw new Error('vault is locked')

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.compact.tmp`
  if (apply) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(tmpPath, '', { encoding: 'utf8', mode: 0o600 })
  }

  const seen = new Set<string>()
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let batch: string[] = []
  let uniqueCount = 0
  let duplicates = 0
  let duplicateBytes = 0

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const current = batch
    batch = []
    const decrypted = sessionId && !current[0].startsWith('{')
      ? await decryptLinesForSession(sessionId, current)
      : current
    const uniquePlaintext: string[] = []
    for (const line of decrypted) {
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = line
      }
      const key = keyFor(parsed)
      if (seen.has(key)) {
        duplicates += 1
        duplicateBytes += Buffer.byteLength(line, 'utf8')
        continue
      }
      seen.add(key)
      uniqueCount += 1
      if (sequenceHash) sequenceHash.update(sequenceKeyFor ? sequenceKeyFor(parsed) : key).update('\n')
      if (apply) uniquePlaintext.push(line)
    }
    if (apply && uniquePlaintext.length > 0) {
      const outLines = sessionId
        ? await encryptLinesForSession(sessionId, uniquePlaintext)
        : uniquePlaintext
      fs.appendFileSync(tmpPath, `${outLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    }
  }

  try {
    for await (const line of reader) {
      if (!line) continue
      batch.push(line)
      if (batch.length >= 500) await flush()
    }
    await flush()
  } catch (error) {
    if (apply) fs.rmSync(tmpPath, { force: true })
    throw error
  } finally {
    reader.close()
    stream.destroy()
  }

  if (apply) {
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

  return { uniqueCount, duplicates, duplicateBytes }
}

async function compactSessionMessageFile(session: Session, mode: VaultMaintenanceMode): Promise<JsonlCompactResult> {
  const sequenceHash = crypto.createHash('sha256')
  const result = await compactJsonlFile(
    path.join(VAULT_DIR, session.vaultPath),
    value => normalizedMessageKey(value as Message),
    mode,
    sequenceHash,
  )
  return { ...result, sequenceHash: sequenceHash.digest('hex') }
}

async function compactRawRecordFile(session: Session, mode: VaultMaintenanceMode): Promise<JsonlCompactResult> {
  const filePath = path.join(RAW_DIR, makeRawPath(session.source, session.uid))
  if (!fs.existsSync(filePath)) return { uniqueCount: 0, duplicates: 0, duplicateBytes: 0 }
  const sequenceHash = crypto.createHash('sha256')
  const result = await compactJsonlFile(
    filePath,
    value => rawRecordKey(value as RawRecord),
    mode,
    sequenceHash,
    value => (value as RawRecord).rawHash || '',
  )
  return { ...result, sequenceHash: sequenceHash.digest('hex') }
}

export async function compactVaultSessionDuplicates(session: Session, mode: VaultMaintenanceMode): Promise<VaultSessionCompactResult> {
  const messageDedupe = await compactSessionMessageFile(session, mode)
  const rawDedupe = await compactRawRecordFile(session, mode)
  return {
    uid: session.uid,
    source: session.source,
    messageCount: session.messageCount,
    duplicateMessages: messageDedupe.duplicates,
    duplicateMessageBytes: messageDedupe.duplicateBytes,
    duplicateRawRecords: rawDedupe.duplicates,
    duplicateRawBytes: rawDedupe.duplicateBytes,
    nextMessageCount: messageDedupe.uniqueCount || session.messageCount,
    messageSequenceHash: messageDedupe.sequenceHash,
    rawSequenceHash: rawDedupe.sequenceHash,
  }
}

function readMaintenanceState(): VaultMaintenanceState | null {
  try {
    return JSON.parse(fs.readFileSync(VAULT_MAINTENANCE_FILE, 'utf8')) as VaultMaintenanceState
  } catch {
    return null
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
}

function emptyMaintenanceResult(): VaultMaintenanceResult {
  return {
    mode: 'apply',
    applied: true,
    sessionsChecked: 0,
    sessionsWithDuplicateMessages: 0,
    duplicateMessages: 0,
    rawSessionsChecked: 0,
    rawSessionsWithDuplicateRecords: 0,
    duplicateRawRecords: 0,
    duplicateSessionGroups: 0,
    duplicateSessions: 0,
    estimatedReclaimableParsedBytes: 0,
    estimatedReclaimableRawBytes: 0,
    changedSessions: [],
    errors: [],
  }
}

function readBackgroundMaintenanceState(): BackgroundMaintenanceState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(VAULT_MAINTENANCE_PROGRESS_FILE, 'utf8')) as BackgroundMaintenanceState
    if (parsed.version !== VAULT_MAINTENANCE_VERSION) return null
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.completed)) return null
    return parsed
  } catch {
    return null
  }
}

function mergeSessionCompactResult(totals: VaultMaintenanceResult, result: VaultSessionCompactResult): void {
  totals.sessionsChecked += 1
  totals.rawSessionsChecked += 1
  if (result.duplicateMessages > 0) {
    totals.sessionsWithDuplicateMessages += 1
    totals.duplicateMessages += result.duplicateMessages
    totals.estimatedReclaimableParsedBytes += result.duplicateMessageBytes
  }
  if (result.duplicateRawRecords > 0) {
    totals.rawSessionsWithDuplicateRecords += 1
    totals.duplicateRawRecords += result.duplicateRawRecords
    totals.estimatedReclaimableRawBytes += result.duplicateRawBytes
  }
  if (result.duplicateMessages > 0 || result.duplicateRawRecords > 0) {
    totals.changedSessions.push({
      uid: result.uid,
      source: result.source,
      duplicateMessages: result.duplicateMessages,
      duplicateRawRecords: result.duplicateRawRecords,
    })
  }
}

function removeSessionFiles(session: Session): void {
  fs.rmSync(path.join(VAULT_DIR, session.vaultPath), { force: true })
  fs.rmSync(path.join(RAW_DIR, makeRawPath(session.source, session.uid)), { force: true })
  fs.rmSync(path.join(RAW_ARCHIVE_DIR, session.source, session.uid), { recursive: true, force: true })
}

export async function auditAndCompactVaultDuplicates(mode: VaultMaintenanceMode = 'dry-run'): Promise<VaultMaintenanceResult> {
  const sessions = await loadSessions()
  const candidateUids = candidateDuplicateSessionUids(sessions)
  const result: VaultMaintenanceResult = {
    mode,
    applied: mode === 'apply',
    sessionsChecked: 0,
    sessionsWithDuplicateMessages: 0,
    duplicateMessages: 0,
    rawSessionsChecked: 0,
    rawSessionsWithDuplicateRecords: 0,
    duplicateRawRecords: 0,
    duplicateSessionGroups: 0,
    duplicateSessions: 0,
    estimatedReclaimableParsedBytes: 0,
    estimatedReclaimableRawBytes: 0,
    changedSessions: [],
    errors: [],
  }

  const sequenceGroups = new Map<string, Array<{ session: Session; parsedBytes: number; rawBytes: number }>>()
  const updatedSessions: Session[] = []

  for (const session of sessions) {
    try {
      if (!candidateUids.has(session.uid)) {
        updatedSessions.push(session)
        continue
      }
      result.sessionsChecked += 1
      const sessionDedupe = await compactVaultSessionDuplicates(session, mode)
      if (sessionDedupe.duplicateMessages > 0) {
        result.sessionsWithDuplicateMessages += 1
        result.duplicateMessages += sessionDedupe.duplicateMessages
        result.estimatedReclaimableParsedBytes += sessionDedupe.duplicateMessageBytes
      }

      result.rawSessionsChecked += 1
      if (sessionDedupe.duplicateRawRecords > 0) {
        result.rawSessionsWithDuplicateRecords += 1
        result.duplicateRawRecords += sessionDedupe.duplicateRawRecords
        result.estimatedReclaimableRawBytes += sessionDedupe.duplicateRawBytes
      }

      const nextSession = sessionDedupe.duplicateMessages > 0 || sessionDedupe.nextMessageCount !== session.messageCount
        ? { ...session, messageCount: sessionDedupe.nextMessageCount }
        : session
      updatedSessions.push(nextSession)

      if (sessionDedupe.duplicateMessages > 0 || sessionDedupe.duplicateRawRecords > 0) {
        result.changedSessions.push({
          uid: session.uid,
          source: session.source,
          duplicateMessages: sessionDedupe.duplicateMessages,
          duplicateRawRecords: sessionDedupe.duplicateRawRecords,
        })
      }

      if (sessionDedupe.nextMessageCount > 0 && sessionDedupe.messageSequenceHash && sessionDedupe.rawSequenceHash) {
        const sequenceKey = `${session.source}\0${sessionDedupe.messageSequenceHash}\0${sessionDedupe.rawSequenceHash}`
        const group = sequenceGroups.get(sequenceKey) || []
        group.push({
          session: nextSession,
          parsedBytes: sessionVaultSize(session),
          rawBytes: rawVaultSize(session),
        })
        sequenceGroups.set(sequenceKey, group)
      }
    } catch (error) {
      result.errors.push({ uid: session.uid, error: errorMessage(error) })
      updatedSessions.push(session)
    }
  }

  const duplicateSessionUids = new Set<string>()
  for (const group of sequenceGroups.values()) {
    if (group.length <= 1) continue
    group.sort((a, b) => {
      if (a.session.messageCount !== b.session.messageCount) return b.session.messageCount - a.session.messageCount
      return Date.parse(b.session.lastTimestamp || '') - Date.parse(a.session.lastTimestamp || '')
    })
    result.duplicateSessionGroups += 1
    result.duplicateSessions += group.length - 1
    for (const duplicate of group.slice(1)) {
      result.estimatedReclaimableParsedBytes += duplicate.parsedBytes
      result.estimatedReclaimableRawBytes += duplicate.rawBytes
      duplicateSessionUids.add(duplicate.session.uid)
    }
  }

  if (mode === 'apply') {
    if (result.duplicateMessages > 0 || result.duplicateRawRecords > 0 || duplicateSessionUids.size > 0) {
      await saveSessions(updatedSessions.filter(session => !duplicateSessionUids.has(session.uid)))
    }
    if (duplicateSessionUids.size > 0) {
      for (const duplicate of updatedSessions.filter(session => duplicateSessionUids.has(session.uid))) {
        removeSessionFiles(duplicate)
      }
    }
  }

  return result
}

function updateSessionMessageCount(sessions: Session[], uid: string, nextMessageCount: number): Session[] {
  return sessions.map(session => (
    session.uid === uid && session.messageCount !== nextMessageCount
      ? { ...session, messageCount: nextMessageCount }
      : session
  ))
}

async function createBackgroundMaintenanceState(reason: string): Promise<BackgroundMaintenanceState | null> {
  const sessions = await loadSessions()
  const candidateUids = candidateDuplicateSessionUids(sessions)
  const candidateSessions = sessions.filter(session => candidateUids.has(session.uid))
    .sort((a, b) => sessionTotalVaultBytes(b) - sessionTotalVaultBytes(a))

  if (candidateSessions.length === 0) {
    const result = emptyMaintenanceResult()
    const completedAt = new Date().toISOString()
    const completed = {
      version: VAULT_MAINTENANCE_VERSION,
      completedAt,
      result,
    }
    writePrivateJson(VAULT_MAINTENANCE_FILE, completed)
    const state: BackgroundMaintenanceState = {
      version: VAULT_MAINTENANCE_VERSION,
      status: 'complete',
      startedAt: completedAt,
      updatedAt: completedAt,
      queue: [],
      completed: [],
      totals: result,
    }
    writePrivateJson(VAULT_MAINTENANCE_PROGRESS_FILE, state)
    updateHealth('vault-maintenance', {
      running: false,
      reason,
      completedAt: completed.completedAt,
      candidateSessions: 0,
    })
    return state
  }

  const now = new Date().toISOString()
  const state: BackgroundMaintenanceState = {
    version: VAULT_MAINTENANCE_VERSION,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    queue: candidateSessions.map(session => session.uid),
    completed: [],
    totals: emptyMaintenanceResult(),
  }
  writePrivateJson(VAULT_MAINTENANCE_PROGRESS_FILE, state)
  updateHealth('vault-maintenance', {
    running: true,
    reason,
    startedAt: now,
    candidateSessions: state.queue.length,
    remainingSessions: state.queue.length,
  })
  writeAuditEvent('vault-maintenance', 'background_repair_started', {
    reason,
    candidateSessions: state.queue.length,
  })
  return state
}

async function backgroundMaintenanceStep(reason: string): Promise<VaultMaintenanceResult | null> {
  let state = readBackgroundMaintenanceState() || await createBackgroundMaintenanceState(reason)
  if (!state) return null
  if (state.queue.length === 0) {
    state = {
      ...state,
      status: 'complete',
      updatedAt: new Date().toISOString(),
    }
    writePrivateJson(VAULT_MAINTENANCE_PROGRESS_FILE, state)
    writePrivateJson(VAULT_MAINTENANCE_FILE, {
      version: VAULT_MAINTENANCE_VERSION,
      completedAt: state.updatedAt,
      result: state.totals,
    })
    updateHealth('vault-maintenance', {
      running: false,
      reason,
      completedAt: state.updatedAt,
      completedSessions: state.completed.length,
      duplicateMessages: state.totals.duplicateMessages,
      duplicateRawRecords: state.totals.duplicateRawRecords,
      estimatedReclaimableParsedBytes: state.totals.estimatedReclaimableParsedBytes,
      estimatedReclaimableRawBytes: state.totals.estimatedReclaimableRawBytes,
      errors: state.totals.errors.length,
    })
    writeAuditEvent('vault-maintenance', 'background_repair_completed', {
      reason,
      ...state.totals,
    })
    return state.totals
  }

  const [uid, ...remaining] = state.queue
  const sessions = await loadSessions()
  const session = sessions.find(item => item.uid === uid)
  const nextState: BackgroundMaintenanceState = {
    ...state,
    queue: remaining,
    completed: [...state.completed, uid],
    updatedAt: new Date().toISOString(),
  }

  try {
    if (session) {
      updateHealth('vault-maintenance', {
        running: true,
        reason,
        currentSession: uid,
        completedSessions: state.completed.length,
        remainingSessions: state.queue.length,
      })
      const result = await compactVaultSessionDuplicates(session, 'apply')
      mergeSessionCompactResult(nextState.totals, result)
      if (result.nextMessageCount !== session.messageCount) {
        await saveSessions(updateSessionMessageCount(sessions, uid, result.nextMessageCount))
      }
      writeAuditEvent('vault-maintenance', 'background_session_repaired', {
        reason,
        uid,
        source: session.source,
        duplicateMessages: result.duplicateMessages,
        duplicateRawRecords: result.duplicateRawRecords,
        duplicateMessageBytes: result.duplicateMessageBytes,
        duplicateRawBytes: result.duplicateRawBytes,
      })
    }
  } catch (error) {
    nextState.totals.errors.push({ uid, error: errorMessage(error) })
    writeLog('warn', 'vault-maintenance', 'background_session_failed', {
      reason,
      uid,
      error: safeError(error),
    })
  }

  writePrivateJson(VAULT_MAINTENANCE_PROGRESS_FILE, nextState)
  updateHealth('vault-maintenance', {
    running: true,
    reason,
    lastSession: uid,
    completedSessions: nextState.completed.length,
    remainingSessions: nextState.queue.length,
    duplicateMessages: nextState.totals.duplicateMessages,
    duplicateRawRecords: nextState.totals.duplicateRawRecords,
    estimatedReclaimableParsedBytes: nextState.totals.estimatedReclaimableParsedBytes,
    estimatedReclaimableRawBytes: nextState.totals.estimatedReclaimableRawBytes,
    errors: nextState.totals.errors.length,
  })
  return null
}

export function scheduleVaultDuplicateMaintenance(reason: string): void {
  const previous = readMaintenanceState()
  if (previous && previous.version >= VAULT_MAINTENANCE_VERSION) return
  if (scheduledMaintenance) return

  const runStep = (delayMs: number): void => {
    setTimeout(() => {
      backgroundMaintenanceStep(reason)
        .then(result => {
          if (result) resolveScheduled(result)
          else if (scheduledMaintenance) runStep(AUTO_MAINTENANCE_NEXT_DELAY_MS)
        })
        .catch(error => {
          updateHealth('vault-maintenance', {
            running: false,
            reason,
            failedAt: new Date().toISOString(),
            error: safeError(error),
          })
          writeLog('warn', 'vault-maintenance', 'failed', { reason, error: safeError(error) })
          resolveScheduled(null)
        })
    }, delayMs)
  }

  let resolveScheduled: (result: VaultMaintenanceResult | null) => void = () => {}
  scheduledMaintenance = new Promise(resolve => {
    resolveScheduled = result => {
      scheduledMaintenance = null
      resolve(result)
    }
    runStep(AUTO_MAINTENANCE_START_DELAY_MS)
  })

  updateHealth('vault-maintenance', {
    running: true,
    reason,
    startedAt: new Date().toISOString(),
  })
}
