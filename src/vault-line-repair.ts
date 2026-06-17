import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { RAW_ARCHIVE_DIR, RAW_DIR, STATE_DIR, VAULT_DIR } from './config'
import {
  getVaultSessionId,
  loadOffsets,
  loadSessions,
  makeRawPath,
  saveOffsets,
  saveSessions,
} from './store'
import { decryptLinesForSession } from './vault-helper'
import { isBackgroundMaintenanceRunning } from './vault-maintenance'
import { requestSourceFileReprocess } from './watcher'
import { safeError, updateHealth, writeAuditEvent, writeLog } from './logging'
import type { Session } from './types'

// Background repair for vault lines that no longer decrypt (e.g. lines written
// by a crash-looping daemon with a stale wrapped key). One undecryptable line
// poisons every whole-session decrypt batch, so the session disappears from
// search and errors out of maintenance until it is repaired.
//
// Strategy, per session with bad lines:
// - If the session's single source file still exists (file-per-session sources
//   only), wipe the parsed/raw/raw-archive copies, reset the watcher offset to
//   zero, and queue a full reprocess. The session is rebuilt wholesale from the
//   plaintext source, so nothing can duplicate and nothing is lost.
// - Otherwise move the bad lines into vault/quarantine/ and keep the good
//   lines, so the session decrypts and searches again with a bounded gap.
//
// The scan is silent, checkpointed per session, resumable after kill/crash, and
// skips files that were touched in the last few minutes so it never races live
// capture appends.

const REPAIR_VERSION = 1
const PROGRESS_FILE = path.join(STATE_DIR, 'vault-line-repair-progress.json')
const DONE_FILE = path.join(STATE_DIR, 'vault-line-repair.json')
const QUARANTINE_DIR = path.join(VAULT_DIR, 'quarantine')
const START_DELAY_MS = positiveNumber(process.env.DATAMOAT_LINE_REPAIR_START_DELAY_MS, 20_000)
const NEXT_DELAY_MS = positiveNumber(process.env.DATAMOAT_LINE_REPAIR_NEXT_DELAY_MS, 5_000)
const ACTIVE_FILE_COOLDOWN_MS = positiveNumber(process.env.DATAMOAT_LINE_REPAIR_ACTIVE_COOLDOWN_MS, 5 * 60 * 1000)
const DETECT_BATCH_LINES = 200
const MAX_ACTIVE_RETRIES = 3

// Sources where one source file maps to one session, so a wholesale rebuild
// from that file is lossless. Claude sessions can merge forked files into one
// canonical session, so they only ever get quarantine, never a wipe.
const REBUILD_SOURCES: ReadonlySet<string> = new Set(['codex-cli', 'openclaw', 'cursor'])

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

type RepairAction = 'verified' | 'quarantined' | 'rebuild_scheduled' | 'skipped_active' | 'error'

type SessionRepairOutcome = {
  uid: string
  source: string
  action: RepairAction
  badMessageLines: number
  badRawLines: number
  error?: string
}

type LineRepairState = {
  version: number
  status: 'running' | 'complete'
  startedAt: string
  updatedAt: string
  queue: string[]
  activeRetries: Record<string, number>
  verifiedSessions: number
  repaired: SessionRepairOutcome[]
  errors: Array<{ uid: string; error: string }>
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
}

function readDoneState(): { version: number } | null {
  try {
    return JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')) as { version: number }
  } catch {
    return null
  }
}

function readProgressState(): LineRepairState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) as LineRepairState
    if (parsed.version !== REPAIR_VERSION) return null
    if (!Array.isArray(parsed.queue) || !Array.isArray(parsed.repaired)) return null
    return parsed
  } catch {
    return null
  }
}

async function decryptable(sessionId: string, lines: string[]): Promise<boolean> {
  try {
    await decryptLinesForSession(sessionId, lines)
    return true
  } catch {
    return false
  }
}

async function bisectBadLines(
  sessionId: string,
  entries: Array<{ index: number; line: string }>,
  bad: number[],
): Promise<void> {
  if (entries.length === 0) return
  if (await decryptable(sessionId, entries.map(entry => entry.line))) return
  if (entries.length === 1) {
    bad.push(entries[0].index)
    return
  }
  const mid = Math.floor(entries.length / 2)
  await bisectBadLines(sessionId, entries.slice(0, mid), bad)
  await bisectBadLines(sessionId, entries.slice(mid), bad)
}

// Returns indexes (counting non-empty lines from 0) that fail to decrypt.
// Plaintext files (unencrypted vaults) trivially have no bad lines.
async function detectBadLineIndexes(filePath: string, sessionId: string): Promise<{ total: number; bad: number[] }> {
  if (!fs.existsSync(filePath)) return { total: 0, bad: [] }
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const bad: number[] = []
  let batch: Array<{ index: number; line: string }> = []
  let index = 0
  let plaintext = false

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const current = batch
    batch = []
    if (!await decryptable(sessionId, current.map(entry => entry.line))) {
      await bisectBadLines(sessionId, current, bad)
    }
  }

  try {
    for await (const line of reader) {
      if (!line) continue
      if (index === 0 && line.startsWith('{')) plaintext = true
      if (!plaintext) batch.push({ index, line })
      index += 1
      if (batch.length >= DETECT_BATCH_LINES) await flush()
    }
    await flush()
  } finally {
    reader.close()
    stream.destroy()
  }
  return { total: index, bad }
}

// Rewrites filePath without the bad lines (kept lines stay byte-identical) and
// appends the bad lines, still encrypted, to quarantinePath. Lines appended to
// the file after detection are preserved.
function stripAndQuarantineLines(filePath: string, quarantinePath: string, badIndexes: Set<number>): number {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  const kept: string[] = []
  const quarantined: string[] = []
  lines.forEach((line, index) => {
    if (badIndexes.has(index)) quarantined.push(line)
    else kept.push(line)
  })
  if (quarantined.length === 0) return lines.length

  fs.mkdirSync(path.dirname(quarantinePath), { recursive: true, mode: 0o700 })
  fs.appendFileSync(quarantinePath, `${quarantined.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.repair.tmp`
  fs.writeFileSync(tmpPath, kept.length > 0 ? `${kept.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 })
  const fd = fs.openSync(tmpPath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
  return kept.length
}

function recentlyModified(filePath: string | undefined): boolean {
  if (!filePath) return false
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs < ACTIVE_FILE_COOLDOWN_MS
  } catch {
    return false
  }
}

export async function repairSessionLines(session: Session): Promise<SessionRepairOutcome> {
  const sessionId = getVaultSessionId()
  if (!sessionId) throw new Error('vault is locked')

  const messagesPath = path.join(VAULT_DIR, session.vaultPath)
  const rawPath = path.join(RAW_DIR, makeRawPath(session.source, session.uid))
  const base: SessionRepairOutcome = {
    uid: session.uid,
    source: session.source,
    action: 'verified',
    badMessageLines: 0,
    badRawLines: 0,
  }

  // Never race live capture: anything written to recently gets retried later.
  if (recentlyModified(messagesPath) || recentlyModified(rawPath) || recentlyModified(session.originalPath)) {
    return { ...base, action: 'skipped_active' }
  }

  const messages = await detectBadLineIndexes(messagesPath, sessionId)
  const raw = await detectBadLineIndexes(rawPath, sessionId)
  base.badMessageLines = messages.bad.length
  base.badRawLines = raw.bad.length
  if (messages.bad.length === 0 && raw.bad.length === 0) return base

  const canRebuild = REBUILD_SOURCES.has(session.source)
    && !!session.originalPath
    && fs.existsSync(session.originalPath)

  if (canRebuild) {
    // Wipe every derived copy, then reprocess the whole source file through the
    // normal capture path. Replacement, not append: nothing can duplicate.
    fs.rmSync(messagesPath, { force: true })
    fs.rmSync(rawPath, { force: true })
    fs.rmSync(path.join(RAW_ARCHIVE_DIR, session.source, session.uid), { recursive: true, force: true })
    const offsets = await loadOffsets()
    const offsetKey = offsets[session.originalPath] !== undefined
      ? session.originalPath
      : path.resolve(session.originalPath)
    offsets[offsetKey] = {
      offset: 0,
      sessionId: offsets[offsetKey]?.sessionId ?? '',
      source: session.source,
      lastMod: 0,
    }
    await saveOffsets(offsets)
    requestSourceFileReprocess(session.originalPath, session.source)
    return { ...base, action: 'rebuild_scheduled' }
  }

  const quarantineBase = path.join(QUARANTINE_DIR, session.source)
  let keptMessages = messages.total - messages.bad.length
  if (messages.bad.length > 0) {
    keptMessages = stripAndQuarantineLines(
      messagesPath,
      path.join(quarantineBase, `${session.uid}.messages.jsonl`),
      new Set(messages.bad),
    )
  }
  if (raw.bad.length > 0) {
    stripAndQuarantineLines(
      rawPath,
      path.join(quarantineBase, `${session.uid}.raw.jsonl`),
      new Set(raw.bad),
    )
  }
  if (messages.bad.length > 0) {
    const sessions = await loadSessions()
    await saveSessions(sessions.map(item => (
      item.uid === session.uid ? { ...item, messageCount: keptMessages } : item
    )))
  }
  return { ...base, action: 'quarantined' }
}

async function createState(reason: string): Promise<LineRepairState> {
  const sessions = await loadSessions()
  const now = new Date().toISOString()
  const state: LineRepairState = {
    version: REPAIR_VERSION,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    queue: sessions.map(session => session.uid),
    activeRetries: {},
    verifiedSessions: 0,
    repaired: [],
    errors: [],
  }
  writePrivateJson(PROGRESS_FILE, state)
  writeAuditEvent('vault-line-repair', 'repair_scan_started', {
    reason,
    candidateSessions: state.queue.length,
  })
  return state
}

// Processes one session per call so a kill at any point loses at most one
// session of progress. Returns the final state once the queue is drained.
export async function vaultLineRepairStep(reason: string): Promise<LineRepairState | null> {
  if (isBackgroundMaintenanceRunning()) return null
  if (!getVaultSessionId()) return null

  const state = readProgressState() ?? await createState(reason)
  if (state.status === 'complete') return state

  if (state.queue.length === 0) {
    const completed: LineRepairState = {
      ...state,
      status: 'complete',
      updatedAt: new Date().toISOString(),
    }
    writePrivateJson(PROGRESS_FILE, completed)
    writePrivateJson(DONE_FILE, {
      version: REPAIR_VERSION,
      completedAt: completed.updatedAt,
      verifiedSessions: completed.verifiedSessions,
      repaired: completed.repaired,
      errors: completed.errors,
    })
    updateHealth('vault-line-repair', {
      running: false,
      reason,
      completedAt: completed.updatedAt,
      verifiedSessions: completed.verifiedSessions,
      repairedSessions: completed.repaired.length,
      errors: completed.errors.length,
    })
    writeAuditEvent('vault-line-repair', 'repair_scan_completed', {
      reason,
      verifiedSessions: completed.verifiedSessions,
      repairedSessions: completed.repaired.length,
      errors: completed.errors.length,
    })
    return completed
  }

  const [uid, ...remaining] = state.queue
  const sessions = await loadSessions()
  const session = sessions.find(item => item.uid === uid)
  const nextState: LineRepairState = {
    ...state,
    queue: remaining,
    updatedAt: new Date().toISOString(),
  }

  try {
    if (session) {
      updateHealth('vault-line-repair', {
        running: true,
        reason,
        currentSession: uid,
        remainingSessions: remaining.length,
      })
      const outcome = await repairSessionLines(session)
      if (outcome.action === 'verified') {
        nextState.verifiedSessions += 1
      } else if (outcome.action === 'skipped_active') {
        const retries = (nextState.activeRetries[uid] ?? 0) + 1
        if (retries <= MAX_ACTIVE_RETRIES) {
          nextState.activeRetries[uid] = retries
          nextState.queue = [...remaining, uid]
          // Retrying before the cooldown lapses would burn the retry budget in
          // seconds; only check this session again once it can actually pass.
          if (remaining.length === 0) deferNextStep = true
        } else {
          nextState.repaired.push(outcome)
        }
      } else {
        nextState.repaired.push(outcome)
        writeAuditEvent('vault-line-repair', outcome.action === 'rebuild_scheduled'
          ? 'session_rebuild_scheduled'
          : 'session_lines_quarantined', {
          reason,
          uid,
          source: session.source,
          badMessageLines: outcome.badMessageLines,
          badRawLines: outcome.badRawLines,
        })
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // A momentary lock (auto-lock blip, helper session rotation) must not
    // permanently abandon a session: re-queue it within a bounded budget so it
    // is rechecked once the vault is active again.
    const retries = (nextState.activeRetries[uid] ?? 0) + 1
    if (message.includes('vault is locked') && retries <= MAX_ACTIVE_RETRIES) {
      nextState.activeRetries[uid] = retries
      nextState.queue = [...remaining, uid]
      if (remaining.length === 0) deferNextStep = true
    } else {
      nextState.errors.push({ uid, error: message })
      writeLog('warn', 'vault-line-repair', 'session_repair_failed', {
        reason,
        uid,
        error: safeError(error),
      })
    }
  }

  writePrivateJson(PROGRESS_FILE, nextState)
  return null
}

let scheduledRepair: Promise<void> | null = null
let deferNextStep = false

export function scheduleVaultLineRepair(reason: string): void {
  const done = readDoneState()
  if (done && done.version >= REPAIR_VERSION) return
  if (scheduledRepair) return

  let resolveScheduled: () => void = () => {}
  const runStep = (delayMs: number): void => {
    setTimeout(() => {
      vaultLineRepairStep(reason)
        .then(state => {
          if (state && state.status === 'complete') resolveScheduled()
          else if (scheduledRepair) {
            const delay = deferNextStep ? ACTIVE_FILE_COOLDOWN_MS : NEXT_DELAY_MS
            deferNextStep = false
            runStep(delay)
          }
        })
        .catch(error => {
          updateHealth('vault-line-repair', {
            running: false,
            reason,
            failedAt: new Date().toISOString(),
            error: safeError(error),
          })
          writeLog('warn', 'vault-line-repair', 'failed', { reason, error: safeError(error) })
          resolveScheduled()
        })
    }, delayMs)
  }

  scheduledRepair = new Promise(resolve => {
    resolveScheduled = () => {
      scheduledRepair = null
      resolve()
    }
    runStep(START_DELAY_MS)
  })

  updateHealth('vault-line-repair', {
    running: true,
    reason,
    startedAt: new Date().toISOString(),
  })
}
