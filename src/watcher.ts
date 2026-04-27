import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import chokidar from 'chokidar'
import { Source, Session, Message, OffsetState, RawRecord } from './types'
import { ALL_SOURCES, GLOB_PATTERNS, HEALTH_FILE, resolveWatchPaths } from './config'
import { loadOffsets, saveOffsets, upsertSession, appendMessages, appendRawRecords, makeVaultPath, saveAttachment, loadSessions } from './store'
import {
  appendBootstrapCapture,
  clearBootstrapCaptureData,
  disableBootstrapCapture,
  listBootstrapEntries,
  loadBootstrapOffsetState,
  markBootstrapEntryImported,
  readBootstrapCaptureLines,
} from './bootstrap-capture'
import { extractClaudeLine, extractClaudeModel } from './extractors/claude'
import { extractCodexLine, sessionIdFromPath as codexSessionIdFromPath } from './extractors/codex'
import { extractOpenclawLine } from './extractors/openclaw'
import { safeError, updateHealth, writeAuditEvent, writeLog } from './logging'
import { buildSessionUid, sourceAccountFromPath } from './session-identity'

function log(event: string, fields: Record<string, unknown> = {}): void {
  writeLog('info', 'watcher', event, fields)
}

// Peek a session id out of a parsed raw object without full extraction.
// Each source stores the identifier in a well-known location.
function peekSessionId(source: Source, obj: unknown): string {
  if (!obj || typeof obj !== 'object') return ''
  const o = obj as Record<string, unknown>
  if (source === 'claude-cli' || source === 'claude-app') {
    return (o.sessionId as string) || (o.session_id as string) || ''
  }
  if (source === 'codex-cli') {
    const payload = o.payload as Record<string, unknown> | undefined
    return (payload?.id as string) || ''
  }
  if (source === 'openclaw') {
    if (o.type === 'session') return (o.id as string) || ''
    return ''
  }
  return ''
}

// Replace base64 payloads (image/document/file blocks) with attachment-refs in
// a deep-cloned raw object. Prevents the raw store from duplicating multi-MB
// blobs that already live in attachments/.
function stripBase64Payloads(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripBase64Payloads)
  if (!node || typeof node !== 'object') return node
  const obj = node as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'source' && value && typeof value === 'object') {
      const src = value as Record<string, unknown>
      if (src.type === 'base64' && typeof src.data === 'string') {
        out[key] = {
          ...src,
          data: `<stripped base64 ${src.data.length} chars>`,
        }
        continue
      }
    }
    out[key] = stripBase64Payloads(value)
  }
  return out
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function fallbackRawSessionId(source: Source, filePath: string): string {
  return `raw-${crypto.createHash('sha256').update(`${source}:${path.resolve(filePath)}`).digest('hex').slice(0, 16)}`
}

// Known event types per source — anything outside this set is counted as an
// "unknown event type" for drift observability. Keep in sync with extractors.
const KNOWN_EVENT_TYPES: Record<Source, Set<string>> = {
  'claude-cli': new Set(['user', 'assistant', 'system', 'summary']),
  'claude-app': new Set(['user', 'assistant', 'system', 'summary']),
  'codex-cli': new Set(['session_meta', 'turn_context', 'response_item']),
  'openclaw': new Set(['session', 'message', 'custom', 'thinking_level_change']),
}

// Known top-level keys per source — same as above but for attribute drift.
// Kept intentionally narrow: only the keys the current extractor actually
// reads. Everything else bumps unknownTopLevelKeys counters.
const KNOWN_TOPLEVEL_KEYS: Record<Source, Set<string>> = {
  'claude-cli': new Set(['type', 'uuid', 'sessionId', 'session_id', 'version', 'claude_code_version', 'timestamp', '_audit_timestamp', 'message', 'cwd', 'parent_tool_use_id', 'model']),
  'claude-app': new Set(['type', 'uuid', 'sessionId', 'session_id', 'version', 'claude_code_version', 'timestamp', '_audit_timestamp', '_audit_hmac', 'message', 'cwd', 'parent_tool_use_id', 'model', 'client_platform']),
  'codex-cli': new Set(['type', 'timestamp', 'payload']),
  'openclaw': new Set(['type', 'id', 'timestamp', 'cwd', 'message', 'customType', 'data']),
}

type DriftBuckets = {
  unknownEventTypes: Record<string, number>
  unknownTopLevelKeys: Record<string, number>
}

function observeDrift(source: Source, obj: unknown, buckets: DriftBuckets): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
  const o = obj as Record<string, unknown>

  const type = typeof o.type === 'string' ? o.type : null
  if (type && !KNOWN_EVENT_TYPES[source].has(type)) {
    buckets.unknownEventTypes[type] = (buckets.unknownEventTypes[type] || 0) + 1
  }

  for (const key of Object.keys(o)) {
    if (!KNOWN_TOPLEVEL_KEYS[source].has(key)) {
      buckets.unknownTopLevelKeys[key] = (buckets.unknownTopLevelKeys[key] || 0) + 1
    }
  }
}

function mergeDriftInto(existing: Record<string, number> | undefined, patch: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...(existing || {}) }
  for (const [key, count] of Object.entries(patch)) {
    merged[key] = (merged[key] || 0) + count
  }
  return merged
}

// Read current drift counters for the source, merge in the new observations,
// and write back. Silent: no user-visible alert, no audit event. This exists
// so the team can inspect health.json after upstream updates and see which
// fields or event types are new.
function updateHealthDrift(source: Source, drift: DriftBuckets): void {
  let existingEventTypes: Record<string, number> | undefined
  let existingKeys: Record<string, number> | undefined
  try {
    const raw = fs.readFileSync(HEALTH_FILE, 'utf8')
    const parsed = JSON.parse(raw) as { components?: Record<string, Record<string, unknown>> }
    const comp = parsed.components?.[`watcher:${source}`] as Record<string, unknown> | undefined
    if (comp) {
      existingEventTypes = comp.unknownEventTypes as Record<string, number> | undefined
      existingKeys = comp.unknownTopLevelKeys as Record<string, number> | undefined
    }
  } catch {
    /* non-fatal — first write */
  }
  updateHealth(`watcher:${source}`, {
    unknownEventTypes: mergeDriftInto(existingEventTypes, drift.unknownEventTypes),
    unknownTopLevelKeys: mergeDriftInto(existingKeys, drift.unknownTopLevelKeys),
  })
}

// Per-file in-memory session state (accumulates metadata as we read lines)
interface FileState {
  sessionId: string
  source: Source
  sourceClient?: string
  appVersion: string
  model: string
  modelProvider: string
  cwd: string
  firstTimestamp: string
  lastTimestamp: string
  messageCount: number
  hasThinking: boolean
}

const fileStates = new Map<string, FileState>()
let watchersStarted = false
const activeWatchers: chokidar.FSWatcher[] = []
let offsetsPromise: Promise<OffsetState> | null = null
let processQueue = Promise.resolve()
type WatcherMode = 'vault' | 'bootstrap'
let watcherMode: WatcherMode = 'vault'

const WATCHER_READY_TIMEOUT_MS = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_READY_TIMEOUT_MS, 10_000)
const WATCHER_INITIAL_QUEUE_TIMEOUT_MS = nonNegativeTimeoutMs(process.env.DATAMOAT_WATCHER_INITIAL_QUEUE_TIMEOUT_MS, 0)
const WATCHER_YIELD_EVERY_LINES = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_YIELD_EVERY_LINES, 100)
const WATCHER_MAX_BATCH_BYTES = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_MAX_BATCH_BYTES, 512 * 1024)
const WATCHER_MAX_RECORD_BYTES = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_MAX_RECORD_BYTES, 32 * 1024 * 1024)

type StartupPhaseStatus = 'completed' | 'timed_out'

function positiveTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

async function waitForStartupPhase(
  phase: 'ready' | 'initial_queue',
  promise: Promise<void>,
  timeoutMs: number,
  fields: Record<string, unknown>,
): Promise<StartupPhaseStatus> {
  const startedAt = Date.now()
  let timedOut = false

  if (timeoutMs <= 0) {
    await promise
    writeLog('info', 'watcher', 'startup_phase_completed', {
      ...fields,
      phase,
      elapsedMs: Date.now() - startedAt,
    })
    return 'completed'
  }

  return new Promise<StartupPhaseStatus>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      const elapsedMs = Date.now() - startedAt
      writeLog('warn', 'watcher', 'startup_phase_timeout', {
        ...fields,
        phase,
        timeoutMs,
        elapsedMs,
      })
      updateHealth('watcher', {
        lastStartupTimeoutAt: new Date().toISOString(),
        lastStartupTimeoutPhase: phase,
        lastStartupTimeoutMs: timeoutMs,
      })
      writeAuditEvent('watcher', 'startup_phase_timeout', {
        phase,
        timeoutMs,
      })
      resolve('timed_out')
    }, timeoutMs)

    promise.then(() => {
      clearTimeout(timer)
      if (timedOut) {
        writeLog('info', 'watcher', 'startup_phase_completed_after_timeout', {
          ...fields,
          phase,
          elapsedMs: Date.now() - startedAt,
        })
        return
      }
      resolve('completed')
    }, error => {
      clearTimeout(timer)
      if (timedOut) {
        writeLog('error', 'watcher', 'startup_phase_failed_after_timeout', {
          ...fields,
          phase,
          error: safeError(error),
        })
        return
      }
      reject(error)
    })
  })
}

function isTransientFileError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

function readFileBatch(filePath: string, startOffset: number, fileSize: number): {
  buffer: Buffer
  endOffset: number
  skippedOversizedRecord: boolean
} {
  const remaining = fileSize - startOffset
  if (remaining <= 0) return { buffer: Buffer.alloc(0), endOffset: startOffset, skippedOversizedRecord: false }

  const fd = fs.openSync(filePath, 'r')
  try {
    const initialBytes = Math.min(remaining, WATCHER_MAX_BATCH_BYTES)
    const initial = Buffer.alloc(initialBytes)
    fs.readSync(fd, initial, 0, initialBytes, startOffset)

    if (startOffset + initialBytes >= fileSize) {
      return { buffer: initial, endOffset: fileSize, skippedOversizedRecord: false }
    }

    const lastNewline = initial.lastIndexOf(10)
    if (lastNewline >= 0) {
      const endOffset = startOffset + lastNewline + 1
      return { buffer: initial.subarray(0, lastNewline + 1), endOffset, skippedOversizedRecord: false }
    }

    const recordLimit = Math.min(remaining, WATCHER_MAX_RECORD_BYTES)
    const extended = Buffer.alloc(recordLimit)
    initial.copy(extended, 0, 0, initialBytes)
    if (recordLimit > initialBytes) {
      fs.readSync(fd, extended, initialBytes, recordLimit - initialBytes, startOffset + initialBytes)
    }
    const newline = extended.indexOf(10)
    if (newline >= 0) {
      const endOffset = startOffset + newline + 1
      return { buffer: extended.subarray(0, newline + 1), endOffset, skippedOversizedRecord: false }
    }

    throw new Error(`oversized_jsonl_record_exceeds_limit:${recordLimit}`)
  } finally {
    fs.closeSync(fd)
  }
}

async function continueFileIfPending(
  filePath: string,
  source: Source,
  offsets: OffsetState,
  processedOffset: number,
  fileSize: number,
): Promise<void> {
  if (processedOffset >= fileSize) return
  await yieldToEventLoop()
  await processFile(filePath, source, offsets)
}

function defaultState(source: Source): FileState {
  return {
    sessionId: '',
    source,
    sourceClient: undefined,
    appVersion: '',
    model: 'unknown',
    modelProvider: source.startsWith('codex') ? 'openai' : source === 'openclaw' ? 'openai/anthropic' : 'anthropic',
    cwd: '',
    firstTimestamp: '',
    lastTimestamp: '',
    messageCount: 0,
    hasThinking: false,
  }
}

async function hydrateState(filePath: string, source: Source, offsets: OffsetState): Promise<FileState> {
  const state = defaultState(source)
  const saved = offsets[filePath]
  const guessedSessionId = source === 'codex-cli' ? codexSessionIdFromPath(filePath) : saved?.sessionId

  if (saved?.sessionId) state.sessionId = saved.sessionId
  if (guessedSessionId && !state.sessionId) state.sessionId = guessedSessionId

  try {
    const sessions = await loadSessions()
    const existing = sessions.find(session =>
      session.originalPath === filePath
      || (!!saved?.sessionId && session.id === saved.sessionId)
      || (!!guessedSessionId && session.id === guessedSessionId)
    )
    if (existing) {
      state.sessionId = existing.id
      state.sourceClient = existing.sourceClient
      state.appVersion = existing.appVersion
      state.model = existing.model
      state.modelProvider = existing.modelProvider
      state.cwd = source === 'claude-app' ? normalizeClaudeAppCwd(filePath, existing.cwd) : existing.cwd
      state.firstTimestamp = existing.firstTimestamp
      state.lastTimestamp = existing.lastTimestamp
      state.messageCount = existing.messageCount
      state.hasThinking = existing.hasThinking
    }
  } catch {
    /* non-fatal */
  }

  if (source === 'codex-cli' && (!state.appVersion || state.model === 'unknown' || !state.cwd)) {
    hydrateCodexStateFromHeader(filePath, state)
  }

  return state
}

function hydrateCodexStateFromHeader(filePath: string, state: FileState): void {
  try {
    const stat = fs.statSync(filePath)
    const bytesToRead = Math.min(stat.size, 64 * 1024)
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(bytesToRead)
    fs.readSync(fd, buffer, 0, bytesToRead, 0)
    fs.closeSync(fd)
    const lines = buffer.toString('utf8').split('\n').filter(line => line.trim()).slice(0, 40)
    for (const line of lines) {
      const result = extractCodexLine(line)
      if (!result) continue
      if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
      if (result.sourceClient && !state.sourceClient) state.sourceClient = result.sourceClient
      if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
      if (result.model && state.model === 'unknown') state.model = result.model
      if (result.cwd && !state.cwd) state.cwd = result.cwd
      if (state.sessionId && state.sourceClient && state.appVersion && state.model !== 'unknown' && state.cwd) break
    }
  } catch {
    /* non-fatal */
  }
}

function readClaudeAppSessionMetadata(filePath: string): Record<string, unknown> | null {
  const sessionDir = path.dirname(filePath)
  const sessionName = path.basename(sessionDir)
  if (!sessionName.startsWith('local_')) return null

  const metadataPath = path.join(path.dirname(sessionDir), `${sessionName}.json`)
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function normalizeClaudeAppCwd(filePath: string, cwd: string): string {
  if (!cwd) return cwd

  const normalized = cwd.replace(/\\/g, '/')
  if (!normalized.includes('/local-agent-mode-sessions/') || !normalized.endsWith('/outputs')) return cwd

  const metadata = readClaudeAppSessionMetadata(filePath)
  const processName = typeof metadata?.processName === 'string' ? metadata.processName.trim() : ''
  return processName ? `/sessions/${processName}` : cwd
}

async function loadWatcherOffsets(mode: WatcherMode): Promise<OffsetState> {
  return mode === 'bootstrap' ? loadBootstrapOffsetState() : loadOffsets()
}

export async function startWatchers(mode: WatcherMode = 'vault'): Promise<void> {
  if (watchersStarted && watcherMode === mode) return
  if (watchersStarted && watcherMode !== mode) await stopWatchers()
  watcherMode = mode
  watchersStarted = true
  const offsets = await loadWatcherOffsets(mode)
  offsetsPromise = Promise.resolve(offsets)
  const watchPaths = resolveWatchPaths()
  const readyPromises: Promise<void>[] = []

  for (const [source, basePaths] of Object.entries(watchPaths)) {
    const src = source as Source
    const pattern = GLOB_PATTERNS[src]

    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) {
        log('watch_path_missing', { source: src })
        continue
      }

      const watchPath = path.join(basePath, pattern)
      log('watching', { source: src })
      updateHealth(`watcher:${src}`, { watching: true, lastStartedAt: new Date().toISOString() })

      const watcher = chokidar.watch(watchPath, {
        persistent: true,
        ignoreInitial: false,   // process existing files on startup
        usePolling: false,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      })
      activeWatchers.push(watcher)

      readyPromises.push(new Promise<void>(resolve => {
        watcher.once('ready', () => resolve())
      }))

      watcher
        .on('add', filePath => queueProcessFile(filePath, src))
        .on('change', filePath => queueProcessFile(filePath, src))
        .on('error', err => {
          writeLog('error', 'watcher', 'watcher_error', { source: src, error: safeError(err) })
          updateHealth(`watcher:${src}`, { lastErrorAt: new Date().toISOString(), lastError: safeError(err) })
        })
    }
  }

  const readyStatus = await waitForStartupPhase(
    'ready',
    Promise.all(readyPromises).then(() => undefined),
    WATCHER_READY_TIMEOUT_MS,
    { mode, watcherCount: activeWatchers.length },
  )
  const queueStatus = await waitForStartupPhase(
    'initial_queue',
    processQueue,
    WATCHER_INITIAL_QUEUE_TIMEOUT_MS,
    { mode, watcherCount: activeWatchers.length },
  )
  log('initial_scan_complete', { mode, watcherCount: activeWatchers.length, readyStatus, queueStatus })
}

export async function stopWatchers(): Promise<void> {
  if (!watchersStarted && activeWatchers.length === 0) return
  watchersStarted = false
  watcherMode = 'vault'
  fileStates.clear()
  offsetsPromise = null
  const watchers = activeWatchers.splice(0)
  await Promise.allSettled(watchers.map(watcher => watcher.close()))
  log('stopped')
  for (const source of ALL_SOURCES) {
    updateHealth(`watcher:${source}`, { watching: false, stoppedAt: new Date().toISOString() })
  }
}

function queueProcessFile(filePath: string, source: Source): void {
  processQueue = processQueue
    .then(async () => {
      await yieldToEventLoop()
      const offsets = offsetsPromise ? await offsetsPromise : await loadOffsets()
      await processFile(filePath, source, offsets)
      await yieldToEventLoop()
    })
    .catch(err => {
      writeLog('error', 'watcher', 'process_file_failed', {
        source,
        file: path.basename(filePath),
        error: safeError(err),
      })
    })
}

async function processFile(filePath: string, source: Source, offsets: Awaited<ReturnType<typeof loadOffsets>>): Promise<void> {
  try {
    const stat = fs.statSync(filePath)
    const offsetKey = filePath
    const savedOffset = offsets[offsetKey]?.offset ?? 0
    const fileSize = stat.size

    if (fileSize <= savedOffset) return  // nothing new

    const batch = readFileBatch(filePath, savedOffset, fileSize)
    if (batch.skippedOversizedRecord) {
      offsets[offsetKey] = {
        offset: batch.endOffset,
        sessionId: offsets[offsetKey]?.sessionId ?? '',
        source,
        lastMod: stat.mtimeMs,
      }
      await saveOffsets(offsets)
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
        lastSkippedReason: 'oversized_jsonl_record',
        lastSkippedBytes: batch.endOffset - savedOffset,
      })
      writeAuditEvent('watcher', 'oversized_jsonl_record_skipped', {
        source,
        file: path.basename(filePath),
        bytes: batch.endOffset - savedOffset,
      })
      await continueFileIfPending(filePath, source, offsets, batch.endOffset, fileSize)
      return
    }

    const buffer = batch.buffer

    const newContent = buffer.toString('utf8')
    // Keep byte offsets per line so raw records can point back into the source file.
    const splitLines = newContent.split('\n')
    const lineMetas: Array<{ line: string; byteOffset: number }> = []
    {
      let cursor = savedOffset
      for (const raw of splitLines) {
        if (raw.trim()) lineMetas.push({ line: raw, byteOffset: cursor })
        cursor += Buffer.byteLength(raw, 'utf8') + 1  // +1 for the '\n'
      }
    }
    const lines = lineMetas.map(m => m.line)

    if (lines.length === 0) {
      await continueFileIfPending(filePath, source, offsets, batch.endOffset, fileSize)
      return
    }

    const state = fileStates.get(filePath) ?? await hydrateState(filePath, source, offsets)
    const newMessages: Message[] = []
    const rawRecords: RawRecord[] = []
    const drift: DriftBuckets = { unknownEventTypes: {}, unknownTopLevelKeys: {} }
    let skippedLines = 0
    let wroteToVault = false
    const capturedAt = new Date().toISOString()

    for (let index = 0; index < lines.length; index += 1) {
      // Build the raw record first — it is never allowed to fail, even if the
      // extractor later errors. If JSON.parse fails we still capture the line.
      const lineText = lineMetas[index].line
      let parsed: unknown = null
      let parseError: string | undefined
      try {
        parsed = JSON.parse(lineText)
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err)
      }
      if (parseError === undefined) observeDrift(source, parsed, drift)
      rawRecords.push({
        v: 1,
        source,
        sourcePath: filePath,
        sourceByteOffset: lineMetas[index].byteOffset,
        capturedAt,
        rawHash: sha256Hex(lineText),
        raw: parseError === undefined ? stripBase64Payloads(parsed) : lineText,
        ...(parseError !== undefined ? { parseError } : {}),
      })
      // Let the extractor peek sessionId early so even lines that fail parsing
      // upstream still land in the right raw file once we know the session.
      if (!state.sessionId && parseError === undefined) {
        const peek = peekSessionId(source, parsed)
        if (peek) state.sessionId = peek
      }

      try {
        await processLine(lineMetas[index].line, filePath, source, state, newMessages, watcherMode !== 'bootstrap')
      } catch (err) {
        skippedLines += 1
        writeLog('warn', 'watcher', 'line_skipped', {
          source,
          file: path.basename(filePath),
          line: index + 1,
          error: safeError(err),
        })
      }
      if ((index + 1) % WATCHER_YIELD_EVERY_LINES === 0) await yieldToEventLoop()
    }

    if (watcherMode === 'bootstrap') {
      await appendBootstrapCapture({
        source,
        originalPath: filePath,
        lines,
        offset: batch.endOffset,
        lastMod: stat.mtimeMs,
        sessionId: state.sessionId || undefined,
      })
      offsets[offsetKey] = {
        offset: batch.endOffset,
        sessionId: state.sessionId,
        source,
        lastMod: stat.mtimeMs,
      }
      fileStates.set(filePath, state)
      log('messages_buffered_pre_setup', {
        source,
        lines: lines.length,
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
      })
      writeAuditEvent('watcher', 'messages_buffered_pre_setup', {
        source,
        lines: lines.length,
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
        file: path.basename(filePath),
      })
      updateHealth(`watcher:${source}`, {
        lastCaptureAt: new Date().toISOString(),
        lastSession: state.sessionId ? state.sessionId.slice(0, 8) : null,
        lastCaptureCount: lines.length,
        lastSkippedLines: skippedLines,
        mode: 'bootstrap',
      })
      if (skippedLines > 0) {
        updateHealth(`watcher:${source}`, {
          lastSkippedAt: new Date().toISOString(),
          lastSkippedFile: path.basename(filePath),
          lastSkippedLines: skippedLines,
        })
      }
      await continueFileIfPending(filePath, source, offsets, batch.endOffset, fileSize)
      return
    }

    // Raw-first invariant: write raw records to vault/raw/<source>/<uid>.jsonl
    // BEFORE attempting parsed-message persistence or advancing the offset.
    // If typed session metadata is missing, raw still gets a deterministic
    // source-path fallback id so the original line is not lost.
    const rawSessionId = state.sessionId || fallbackRawSessionId(source, filePath)
    const usedFallbackRawSession = !state.sessionId
    if (usedFallbackRawSession) {
      writeLog('warn', 'watcher', 'raw_saved_with_fallback_session', {
        source,
        file: path.basename(filePath),
        lines: lines.length,
      })
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
        lastSkippedReason: 'missing_session_metadata_raw_fallback',
      })
    }

    const rawSessionUid = buildSessionUid({
      source,
      sourceAccount: sourceAccountFromPath(source, filePath),
      sessionId: rawSessionId,
      originalPath: filePath,
    })
    try {
      await appendRawRecords(source, rawSessionUid, rawRecords)
    } catch (err) {
      writeLog('error', 'watcher', 'raw_append_failed', {
        source,
        file: path.basename(filePath),
        error: safeError(err),
      })
      updateHealth(`watcher:${source}`, {
        lastErrorAt: new Date().toISOString(),
        lastError: safeError(err),
      })
      return  // leave offset unchanged so we retry
    }

    wroteToVault = await persistMessages(filePath, source, state, newMessages, skippedLines)

    if (newMessages.length > 0 && !wroteToVault) {
      writeLog('warn', 'watcher', 'messages_not_saved_missing_session', {
        source,
        file: path.basename(filePath),
      })
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
        lastSkippedReason: 'missing_session_metadata',
      })
      return
    }

    if (skippedLines > 0) {
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
        lastSkippedLines: skippedLines,
      })
    }

    // Merge drift counters into health.json. Silent — no user-visible alert.
    const hasDrift = Object.keys(drift.unknownEventTypes).length > 0
                  || Object.keys(drift.unknownTopLevelKeys).length > 0
    if (hasDrift) {
      updateHealthDrift(source, drift)
    }
    updateHealth(`watcher:${source}`, {
      lastRawWriteAt: new Date().toISOString(),
      lastRawWriteCount: rawRecords.length,
      lastRawWriteUsedFallbackSession: usedFallbackRawSession,
    })

    // Advance offsets only after a successful raw + vault write.
    offsets[offsetKey] = {
      offset: batch.endOffset,
      sessionId: state.sessionId || '',
      source,
      lastMod: stat.mtimeMs,
    }
    await saveOffsets(offsets)
    fileStates.set(filePath, state)
    await continueFileIfPending(filePath, source, offsets, batch.endOffset, fileSize)
  } catch (err) {
    if (isTransientFileError(err)) {
      writeLog('warn', 'watcher', 'process_file_skipped', {
        source,
        file: path.basename(filePath),
        error: safeError(err),
      })
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
      })
      return
    }
    writeLog('error', 'watcher', 'process_file_error', {
      source,
      file: path.basename(filePath),
      error: safeError(err),
    })
    updateHealth(`watcher:${source}`, {
      lastErrorAt: new Date().toISOString(),
      lastError: safeError(err),
    })
  }
}

async function persistMessages(
  filePath: string,
  source: Source,
  state: FileState,
  newMessages: Message[],
  skippedLines: number,
): Promise<boolean> {
  if (!state.sessionId || newMessages.length === 0) return false
  const sourceAccount = sourceAccountFromPath(source, filePath)
  const uid = buildSessionUid({
    source,
    sourceAccount,
    sessionId: state.sessionId,
    originalPath: filePath,
  })
  const session: Session = {
    uid,
    id: state.sessionId,
    source,
    sourceClient: state.sourceClient,
    sourceAccount,
    appVersion: state.appVersion,
    model: state.model,
    modelProvider: state.modelProvider,
    firstTimestamp: state.firstTimestamp,
    lastTimestamp: state.lastTimestamp,
    cwd: state.cwd,
    messageCount: state.messageCount,
    hasThinking: state.hasThinking,
    vaultPath: makeVaultPath(source, uid),
    originalPath: filePath,
  }
  await appendMessages(session, newMessages)
  await upsertSession(session)
  log('messages_saved', {
    source,
    count: newMessages.length,
    session: state.sessionId.slice(0, 8),
  })
  writeAuditEvent('watcher', 'messages_saved', {
    source,
    count: newMessages.length,
    session: state.sessionId.slice(0, 8),
    file: path.basename(filePath),
  })
  updateHealth(`watcher:${source}`, {
    lastCaptureAt: new Date().toISOString(),
    lastSession: state.sessionId.slice(0, 8),
    lastCaptureCount: newMessages.length,
    lastSkippedLines: skippedLines,
    mode: 'vault',
  })
  return true
}

function decorateWithSessionState(message: Message, state: FileState): void {
  // Fall back to session-level state whenever the extractor did not provide
  // per-line values. Keeps messages self-describing even when upstream only
  // emits version/model on session_meta or system events.
  if (!message.appVersion && state.appVersion) message.appVersion = state.appVersion
  if (!message.model && state.model && state.model !== 'unknown') message.model = state.model
}

async function processLine(
  line: string,
  filePath: string,
  source: Source,
  state: FileState,
  out: Message[],
  captureAttachments: boolean,
): Promise<void> {
  if (source === 'claude-cli' || source === 'claude-app') {
    const modelInfo = extractClaudeModel(line)
    if (modelInfo?.model) { state.model = modelInfo.model }
    if (modelInfo?.cwd && !state.cwd) {
      state.cwd = source === 'claude-app' ? normalizeClaudeAppCwd(filePath, modelInfo.cwd) : modelInfo.cwd
    }
    if (modelInfo?.appVersion && !state.appVersion) { state.appVersion = modelInfo.appVersion }

    const result = extractClaudeLine(line)
    if (result) {
      if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
      if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
      if (captureAttachments) {
        await attachRawImages(source, filePath, state, result.message, result.rawImages)
      }
      decorateWithSessionState(result.message, state)
      updateStateFromMessage(state, result.message)
      out.push(result.message)
    }
    return
  }

  if (source === 'codex-cli') {
    const result = extractCodexLine(line)
    if (!result) return
    if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
    if (result.sourceClient && !state.sourceClient) state.sourceClient = result.sourceClient
    if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
    if (result.model && state.model === 'unknown') state.model = result.model
    if (result.cwd && !state.cwd) state.cwd = result.cwd
    if (result.message) {
      if (captureAttachments) {
        await attachRawImages(source, filePath, state, result.message, result.rawImages)
      }
      decorateWithSessionState(result.message, state)
      updateStateFromMessage(state, result.message)
      out.push(result.message)
    }
    return
  }

  if (source === 'openclaw') {
    const result = extractOpenclawLine(line)
    if (!result) return
    if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
    if (result.model && state.model === 'unknown') state.model = result.model
    if (result.modelProvider) state.modelProvider = result.modelProvider
    if (result.cwd && !state.cwd) state.cwd = result.cwd
    if (result.message) {
      decorateWithSessionState(result.message, state)
      updateStateFromMessage(state, result.message)
      out.push(result.message)
    }
  }
}

async function attachRawImages(
  source: Source,
  filePath: string,
  state: FileState,
  message: Message,
  rawImages: Array<{
    blockIndex: number
    innerIndex?: number
    base64Data: string
    mediaType: string
    attachmentName?: string
  }>,
): Promise<void> {
  for (const img of rawImages) {
    try {
      const hash = await saveAttachment(img.base64Data, img.mediaType)
      if (img.innerIndex === undefined) {
        const block = message.content[img.blockIndex]
        if (block?.type === 'image' || block?.type === 'file') {
          block.attachmentId = hash
          if (img.attachmentName && block.type === 'file') {
            block.attachmentName = img.attachmentName
          }
        }
        continue
      }

      const outer = message.content[img.blockIndex]
      if (outer?.type === 'tool_result') {
        if (!outer.attachmentIds) outer.attachmentIds = []
        outer.attachmentIds.push(hash)
      }
    } catch (error) {
      writeLog('warn', 'watcher', 'attachment_save_failed', {
        source,
        file: path.basename(filePath),
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
        messageId: message.id,
        blockIndex: img.blockIndex,
        innerIndex: img.innerIndex,
        mediaType: img.mediaType,
        attachmentName: img.attachmentName,
        error: safeError(error),
      })
      writeAuditEvent('watcher', 'attachment_save_failed', {
        source,
        file: path.basename(filePath),
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
        blockIndex: img.blockIndex,
        innerIndex: img.innerIndex,
        mediaType: img.mediaType,
        attachmentName: img.attachmentName,
        error: safeError(error),
      })
      updateHealth(`watcher:${source}`, {
        lastAttachmentErrorAt: new Date().toISOString(),
        lastAttachmentErrorFile: path.basename(filePath),
        lastAttachmentErrorSession: state.sessionId ? state.sessionId.slice(0, 8) : null,
        lastAttachmentErrorBlock: img.blockIndex,
        lastAttachmentErrorInnerBlock: img.innerIndex ?? null,
        lastAttachmentErrorMediaType: img.mediaType,
        lastAttachmentError: safeError(error),
      })
    }
  }
}

function updateStateFromMessage(state: FileState, msg: Message): void {
  if (!state.firstTimestamp || msg.timestamp < state.firstTimestamp) {
    state.firstTimestamp = msg.timestamp
  }
  if (!state.lastTimestamp || msg.timestamp > state.lastTimestamp) {
    state.lastTimestamp = msg.timestamp
  }
  state.messageCount++
  if (msg.hasThinking) state.hasThinking = true
}

export async function importBootstrapCaptureIntoVault(): Promise<{ importedFiles: number; importedMessages: number; remainingFiles: number }> {
  const entries = await listBootstrapEntries()
  if (entries.length === 0) {
    await clearBootstrapCaptureData()
    disableBootstrapCapture()
    return { importedFiles: 0, importedMessages: 0, remainingFiles: 0 }
  }

  const offsets = await loadOffsets()
  let importedFiles = 0
  let importedMessages = 0

  for (const entry of entries) {
    try {
      if (!fs.existsSync(entry.spoolFile)) {
        offsets[entry.originalPath] = {
          offset: entry.offset,
          source: entry.source,
          lastMod: entry.lastMod,
          sessionId: entry.sessionId ?? '',
        }
        await saveOffsets(offsets)
        await markBootstrapEntryImported(entry.originalPath)
        importedFiles += 1
        continue
      }

      const lines = await readBootstrapCaptureLines(entry.spoolFile)
      const state = fileStates.get(entry.originalPath) ?? await hydrateState(entry.originalPath, entry.source, offsets)
      const newMessages: Message[] = []
      const rawRecords: RawRecord[] = []
      const drift: DriftBuckets = { unknownEventTypes: {}, unknownTopLevelKeys: {} }
      let skippedLines = 0
      const capturedAt = new Date().toISOString()
      // Bootstrap spool does not preserve per-line byte offsets; use a running
      // counter inside the spool so raw records still carry a stable ordering.
      let spoolCursor = 0

      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index]
        let parsed: unknown = null
        let parseError: string | undefined
        try {
          parsed = JSON.parse(lineText)
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err)
        }
        if (parseError === undefined) observeDrift(entry.source, parsed, drift)
        rawRecords.push({
          v: 1,
          source: entry.source,
          sourcePath: entry.originalPath,
          sourceByteOffset: spoolCursor,
          capturedAt,
          rawHash: sha256Hex(lineText),
          raw: parseError === undefined ? stripBase64Payloads(parsed) : lineText,
          ...(parseError !== undefined ? { parseError } : {}),
        })
        spoolCursor += Buffer.byteLength(lineText, 'utf8') + 1
        if (!state.sessionId && parseError === undefined) {
          const peek = peekSessionId(entry.source, parsed)
          if (peek) state.sessionId = peek
        }

        try {
          await processLine(lineText, entry.originalPath, entry.source, state, newMessages, true)
        } catch (err) {
          skippedLines += 1
          writeLog('warn', 'watcher', 'bootstrap_line_skipped', {
            source: entry.source,
            file: path.basename(entry.originalPath),
            line: index + 1,
            error: safeError(err),
          })
        }
      }

      const rawSessionId = state.sessionId || entry.sessionId || fallbackRawSessionId(entry.source, entry.originalPath)
      const usedFallbackRawSession = !state.sessionId && !entry.sessionId
      const rawSessionUid = buildSessionUid({
        source: entry.source,
        sourceAccount: sourceAccountFromPath(entry.source, entry.originalPath),
        sessionId: rawSessionId,
        originalPath: entry.originalPath,
      })
      try {
        await appendRawRecords(entry.source, rawSessionUid, rawRecords)
        updateHealth(`watcher:${entry.source}`, {
          lastRawWriteAt: new Date().toISOString(),
          lastRawWriteCount: rawRecords.length,
          lastRawWriteUsedFallbackSession: usedFallbackRawSession,
        })
      } catch (err) {
        writeLog('error', 'watcher', 'bootstrap_raw_append_failed', {
          source: entry.source,
          file: path.basename(entry.originalPath),
          error: safeError(err),
        })
      }
      const hasDrift = Object.keys(drift.unknownEventTypes).length > 0
                    || Object.keys(drift.unknownTopLevelKeys).length > 0
      if (hasDrift) updateHealthDrift(entry.source, drift)

      const wroteToVault = await persistMessages(entry.originalPath, entry.source, state, newMessages, skippedLines)
      if (newMessages.length > 0 && !wroteToVault) {
        writeLog('warn', 'watcher', 'bootstrap_messages_missing_session', {
          source: entry.source,
          file: path.basename(entry.originalPath),
        })
      }

      offsets[entry.originalPath] = {
        offset: entry.offset,
        source: entry.source,
        lastMod: entry.lastMod,
        sessionId: state.sessionId || entry.sessionId || '',
      }
      await saveOffsets(offsets)
      fileStates.set(entry.originalPath, state)
      await markBootstrapEntryImported(entry.originalPath)
      importedFiles += 1
      importedMessages += newMessages.length
    } catch (err) {
      writeLog('error', 'watcher', 'bootstrap_import_failed', {
        source: entry.source,
        file: path.basename(entry.originalPath),
        error: safeError(err),
      })
      updateHealth(`watcher:${entry.source}`, {
        lastErrorAt: new Date().toISOString(),
        lastError: safeError(err),
      })
    }
  }

  const remainingFiles = (await listBootstrapEntries()).length
  if (remainingFiles === 0) {
    await clearBootstrapCaptureData()
    disableBootstrapCapture()
  }
  writeAuditEvent('watcher', 'bootstrap_import_completed', {
    importedFiles,
    importedMessages,
    remainingFiles,
  })
  return { importedFiles, importedMessages, remainingFiles }
}
