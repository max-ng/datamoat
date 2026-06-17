import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { Source, WatchedSource, Session, Message, OffsetState, RawRecord } from './types'
import { ALL_SOURCES, GLOB_PATTERNS, HEALTH_FILE, STATE_DIR, resolveWatchPaths } from './config'
import { clearCaptureSession, hasVaultSession, loadOffsets, saveOffsets, upsertSession, appendMessages, appendRawRecords, makeVaultPath, saveAttachment, loadSessions, getCaptureSessionId, getVaultSessionId, readSessionMessages } from './store'
import {
  appendBootstrapCapture,
  clearBootstrapCaptureData,
  disableBootstrapCapture,
  forEachBootstrapCaptureLineBatch,
  listBootstrapEntries,
  loadBootstrapOffsetState,
  markBootstrapEntryImported,
  updateBootstrapEntryImportCursor,
} from './bootstrap-capture'
import { extractClaudeLine, extractClaudeModel, isClaudeSyntheticModel } from './extractors/claude'
import { extractCodexLine, sessionIdFromPath as codexSessionIdFromPath } from './extractors/codex'
import { extractOpenclawLine } from './extractors/openclaw'
import { extractCursorLine, sessionIdFromPath as cursorSessionIdFromPath } from './extractors/cursor'
import { detectInstallContext } from './install-context'
import { safeError, updateHealth, writeAuditEvent, writeLog } from './logging'
import { buildSessionUid, sourceAccountFromPath, claudeForkGroupKey, claudeForkGroupKeyForSession, pickCanonicalForkUid } from './session-identity'
import { normalizedMessageKey } from './message-key'
import { queueReferencedAttachmentBackupForRawRecords } from './referenced-attachments'
import { appendSourceArchiveChunk } from './source-archive'
import { codexSessionTitle, cursorSessionTitle } from './session-titles'

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
  if (source === 'cursor') {
    return (o.sessionId as string)
      || (o.session_id as string)
      || (o.conversationId as string)
      || (o.composerId as string)
      || (o.chatId as string)
      || ''
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

const CLAUDE_EVENT_TYPES = [
  'user',
  'assistant',
  'system',
  'summary',
  'result',
  'rate_limit_event',
  'ai-title',
  'tool_use_summary',
  'queue-operation',
  'last-prompt',
  'custom-title',
  'mode',
  'permission-mode',
  'attachment',
  'file-history-snapshot',
  'progress',
]

const CLAUDE_TOPLEVEL_KEYS = [
  'type',
  'uuid',
  'sessionId',
  'session_id',
  'version',
  'claude_code_version',
  'timestamp',
  '_audit_timestamp',
  '_audit_hmac',
  'message',
  'aiTitle',
  'customTitle',
  'mode',
  'content',
  'operation',
  'model',
  'cwd',
  'parent_tool_use_id',
  'client_platform',
  'subtype',
  'duration_ms',
  'duration_api_ms',
  'num_turns',
  'result',
  'stop_reason',
  'total_cost_usd',
  'usage',
  'is_error',
  'api_error_status',
  'error',
  'error_status',
  'attempt',
  'max_retries',
  'retry_delay_ms',
  'terminal_reason',
  'rate_limit_info',
  'fast_mode_state',
  'skills',
  'plugins',
  'agents',
  'tools',
  'mcp_servers',
  'permissionMode',
  'permission_denials',
  'output_style',
  'slash_commands',
  'apiKeySource',
  'modelUsage',
  'isReplay',
  'status',
  'leafUuid',
  'parentUuid',
  'isSidechain',
  'attachment',
  'userType',
  'entrypoint',
  'gitBranch',
  'messageId',
  'snapshot',
  'isSnapshotUpdate',
  'promptId',
  'agentId',
  'data',
  'parentToolUseID',
  'parentUuid',
  'slug',
  'toolUseID',
  'preceding_tool_use_ids',
  'summary',
]

// Known event types per source — anything outside this set is counted as an
// "unknown event type" for drift observability. Keep in sync with extractors.
export const KNOWN_EVENT_TYPES: Record<WatchedSource, Set<string>> = {
  'claude-cli': new Set(CLAUDE_EVENT_TYPES),
  'claude-app': new Set(CLAUDE_EVENT_TYPES),
  'codex-cli': new Set([
    'session_meta',
    'turn_context',
    'compacted',
    'response_item.message',
    'response_item.reasoning',
    'response_item.function_call',
    'response_item.function_call_output',
    'response_item.custom_tool_call',
    'response_item.custom_tool_call_output',
    'response_item.web_search_call',
    'response_item.tool_search_call',
    'response_item.tool_search_output',
    'response_item.image_generation_call',
    'response_item.compaction',
    'response_item.context_compaction',
    'event_msg.task_started',
    'event_msg.task_complete',
    'event_msg.user_message',
    'event_msg.agent_message',
    'event_msg.agent_reasoning',
    'event_msg.agent_reasoning_raw_content',
    'event_msg.agent_reasoning_section_break',
    'event_msg.token_count',
    'event_msg.exec_command_begin',
    'event_msg.exec_command_output_delta',
    'event_msg.exec_command_end',
    'event_msg.terminal_interaction',
    'event_msg.mcp_startup_update',
    'event_msg.mcp_startup_complete',
    'event_msg.mcp_tool_call_begin',
    'event_msg.mcp_tool_call_end',
    'event_msg.web_search_begin',
    'event_msg.web_search_end',
    'event_msg.image_generation_begin',
    'event_msg.image_generation_end',
    'event_msg.patch_apply_begin',
    'event_msg.patch_apply_updated',
    'event_msg.patch_apply_end',
    'event_msg.thread_name_updated',
    'event_msg.thread_rolled_back',
    'event_msg.context_compacted',
    'event_msg.turn_aborted',
    'event_msg.view_image_tool_call',
    'event_msg.dynamic_tool_call_request',
    'event_msg.dynamic_tool_call_response',
    'event_msg.request_user_input',
    'event_msg.elicitation_request',
    'event_msg.skills_update_available',
    'event_msg.plan_update',
    'event_msg.plan_delta',
    'event_msg.item_started',
    'event_msg.item_completed',
    'event_msg.hook_started',
    'event_msg.hook_completed',
    'event_msg.collab_agent_spawn_begin',
    'event_msg.collab_agent_spawn_end',
    'event_msg.collab_agent_interaction_begin',
    'event_msg.collab_agent_interaction_end',
    'event_msg.collab_waiting_begin',
    'event_msg.collab_waiting_end',
    'event_msg.collab_close_begin',
    'event_msg.collab_close_end',
    'event_msg.collab_resume_begin',
    'event_msg.collab_resume_end',
    'event_msg.error',
    'event_msg.stream_error',
    'event_msg.deprecation_notice',
  ]),
  'openclaw': new Set(['session', 'message', 'custom', 'thinking_level_change']),
  'cursor': new Set(['message', 'user', 'assistant', 'system', 'tool']),
}

// Known top-level keys per source — same as above but for attribute drift.
// Kept intentionally narrow: only the keys the current extractor actually
// reads. Everything else bumps unknownTopLevelKeys counters.
export const KNOWN_TOPLEVEL_KEYS: Record<WatchedSource, Set<string>> = {
  'claude-cli': new Set(CLAUDE_TOPLEVEL_KEYS),
  'claude-app': new Set(CLAUDE_TOPLEVEL_KEYS),
  'codex-cli': new Set(['type', 'timestamp', 'payload']),
  'openclaw': new Set(['type', 'id', 'timestamp', 'cwd', 'message', 'customType', 'data']),
  'cursor': new Set(['type', 'id', 'sessionId', 'session_id', 'conversationId', 'composerId', 'chatId', 'role', 'message', 'content', 'text', 'timestamp', 'createdAt', 'updatedAt', 'model', 'usage', 'cwd', 'sourceClient', 'appVersion', 'cursorVersion']),
}

type DriftBuckets = {
  unknownEventTypes: Record<string, number>
  unknownTopLevelKeys: Record<string, number>
}

export type BootstrapImportProgress = {
  importedFiles: number
  importedMessages: number
  totalFiles: number
  remainingFiles: number
  done: boolean
}

export type WatcherStartupProgress = {
  running: boolean
  mode: WatcherMode
  phase: 'idle' | 'discovering' | 'processing' | 'complete'
  ready: boolean
  watcherCount: number
  queuedFiles: number
  processedFiles: number
  queuedSessions: number
  processedSessions: number
  queuedBytes: number
  processedBytes: number
  currentSource: Source | null
  currentFile: string | null
  currentSession: string | null
  startedAt: string | null
  updatedAt: string | null
}

function observeDrift(source: WatchedSource, obj: unknown, buckets: DriftBuckets): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
  const o = obj as Record<string, unknown>

  const type = normalizedEventType(source, o)
  if (type && !KNOWN_EVENT_TYPES[source].has(type)) {
    buckets.unknownEventTypes[type] = (buckets.unknownEventTypes[type] || 0) + 1
  }

  for (const key of Object.keys(o)) {
    if (!KNOWN_TOPLEVEL_KEYS[source].has(key)) {
      buckets.unknownTopLevelKeys[key] = (buckets.unknownTopLevelKeys[key] || 0) + 1
    }
  }
}

export function normalizedEventType(source: WatchedSource, obj: Record<string, unknown>): string | null {
  const type = typeof obj.type === 'string' ? obj.type : null
  if (!type) return null
  if (source !== 'codex-cli') return type
  if (type !== 'response_item' && type !== 'event_msg') return type
  const payload = obj.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return type
  const subType = (payload as Record<string, unknown>).type
  return typeof subType === 'string' && subType ? `${type}.${subType}` : type
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
  title?: string
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
// Content-keys already stored in a canonical Claude session, so a resumed/forked
// file routed into it appends only its genuinely new tail. Keyed by canonical uid,
// seeded lazily from the stored session the first time a fork is routed.
const canonicalKnownKeys = new Map<string, Set<string>>()
type WatchHandle = {
  close(): Promise<void> | void
}

type ChokidarWatcher = WatchHandle & {
  once(event: 'ready', callback: () => void): ChokidarWatcher
  on(event: 'add' | 'change', callback: (filePath: string) => void): ChokidarWatcher
  on(event: 'error', callback: (error: unknown) => void): ChokidarWatcher
}

type ChokidarModule = {
  watch(path: string, options: Record<string, unknown>): ChokidarWatcher
}

let watchersStarted = false
const activeWatchers: WatchHandle[] = []
let offsetsPromise: Promise<OffsetState> | null = null
let processQueue = Promise.resolve()
let processQueueRunning = false
type WatcherMode = 'vault' | 'bootstrap'
type StartWatchersOptions = {
  initialQueueTimeoutMs?: number
}
let watcherMode: WatcherMode = 'vault'
let watcherStartupProgress: WatcherStartupProgress = {
  running: false,
  mode: 'vault',
  phase: 'idle',
  ready: false,
  watcherCount: 0,
  queuedFiles: 0,
  processedFiles: 0,
  queuedSessions: 0,
  processedSessions: 0,
  queuedBytes: 0,
  processedBytes: 0,
  currentSource: null,
  currentFile: null,
  currentSession: null,
  startedAt: null,
  updatedAt: null,
}
const watcherStartupQueuedFiles = new Map<string, { size: number; processed: boolean; sessionKey: string }>()
const watcherStartupQueuedSessions = new Map<string, { label: string; queuedFiles: number; processedFiles: number; processed: boolean }>()

type ProcessJob = {
  filePath: string
  source: Source
  event: 'add' | 'change'
  mode: WatcherMode
  offsetsPromise: Promise<OffsetState> | null
  startupCount: { counted: boolean; key: string | null; size: number }
  modifiedMs: number
  queuedAt: number
}

const pendingProcessJobs: ProcessJob[] = []

const WATCHER_READY_TIMEOUT_MS = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_READY_TIMEOUT_MS, 10_000)
// Normal startup should not wait for the whole historical no-op scan before
// unlock. First-run setup passes 0 explicitly so the main UI opens with the
// complete captured session list instead of incrementing from a partial count.
const WATCHER_INITIAL_QUEUE_TIMEOUT_MS = nonNegativeTimeoutMs(process.env.DATAMOAT_WATCHER_INITIAL_QUEUE_TIMEOUT_MS, 2_000)
const WATCHER_YIELD_EVERY_LINES = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_YIELD_EVERY_LINES, 100)
const WATCHER_MAX_BATCH_BYTES = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_MAX_BATCH_BYTES, 512 * 1024)
const WATCHER_MAX_RECORD_BYTES = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_MAX_RECORD_BYTES, 32 * 1024 * 1024)
const BOOTSTRAP_IMPORT_FLUSH_LINES = positiveTimeoutMs(process.env.DATAMOAT_BOOTSTRAP_IMPORT_FLUSH_LINES, 500)
const WATCHER_POLL_INTERVAL_MS = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_POLL_INTERVAL_MS, 2_000)
const WATCHER_BINARY_POLL_INTERVAL_MS = positiveTimeoutMs(process.env.DATAMOAT_WATCHER_BINARY_POLL_INTERVAL_MS, 5_000)
const WATCHER_USE_POLLING = watcherUsePollingDefault()
const TRANSFER_REPLACE_JOURNAL_FILE = path.join(STATE_DIR, 'transfer-replace-journal.json')
const TRANSFER_INITIAL_SCAN_GUARD_FILE = path.join(STATE_DIR, 'transfer-initial-scan-guard.json')

type StartupPhaseStatus = 'completed' | 'timed_out'

type TransferReplaceJournal = {
  version?: number
  mode?: string
  sourceRoot?: string
  destinationRoot?: string
  phase?: string
  completedAt?: string
}

type TransferInitialScanGuard = {
  version?: number
  journalKey?: string
}

function positiveTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeTimeoutMs(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function booleanEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function watcherUsePollingDefault(): boolean {
  const override = booleanEnv(process.env.DATAMOAT_WATCHER_USE_POLLING)
  if (override !== null) return override

  try {
    // macOS FSEvents can miss append notifications for packaged LaunchAgent
    // processes after login/restart. Polling still uses the same capture path;
    // it only changes how file changes are detected.
    return process.platform === 'darwin' && detectInstallContext().mode === 'packaged'
  } catch {
    return false
  }
}

function updateWatcherStartupProgress(progress: Partial<WatcherStartupProgress>): void {
  watcherStartupProgress = {
    ...watcherStartupProgress,
    ...progress,
    updatedAt: new Date().toISOString(),
  }
}

export function getWatcherStartupProgress(): WatcherStartupProgress {
  return { ...watcherStartupProgress }
}

function watcherStartupKey(filePath: string, source: Source): string {
  return `${source}:${filePath}`
}

function watcherStartupSessionLabel(source: Source, filePath: string): string {
  if (source === 'codex-cli') return codexSessionIdFromPath(filePath) || path.basename(filePath, path.extname(filePath))
  if (source === 'cursor') return cursorSessionIdFromPath(filePath) || path.basename(filePath, path.extname(filePath))
  if (source === 'claude-app') return path.basename(path.dirname(filePath)) || path.basename(filePath, path.extname(filePath))
  return path.basename(filePath, path.extname(filePath))
}

function watcherStartupSessionKey(filePath: string, source: Source): string {
  return `${source}:${watcherStartupSessionLabel(source, filePath)}`
}

function markWatcherStartupQueued(filePath: string, source: Source, mode: WatcherMode): { counted: boolean; key: string | null; size: number } {
  if (!watcherStartupProgress.running || watcherStartupProgress.mode !== mode) return { counted: false, key: null, size: 0 }
  const key = `${source}:${filePath}`
  const existing = watcherStartupQueuedFiles.get(key)
  // Pre-scan (countExistingWatchFiles) records every existing file here before
  // chokidar replays its 'add' events. When that 'add' arrives and re-queues the
  // same file, we must still let the eventual processing mark it processed so the
  // progress bar advances — only a file already processed should be skipped.
  // Returning counted:false for not-yet-processed files left processedSessions
  // stuck at 0 for the whole initial scan (bar frozen at 0% until force-complete).
  if (existing) return { counted: !existing.processed, key, size: existing.size }
  const sessionKey = watcherStartupSessionKey(filePath, source)
  const sessionLabel = watcherStartupSessionLabel(source, filePath)
  const existingSession = watcherStartupQueuedSessions.get(sessionKey)
  if (existingSession) {
    existingSession.queuedFiles += 1
    if (existingSession.processed) existingSession.processed = false
  } else {
    watcherStartupQueuedSessions.set(sessionKey, {
      label: sessionLabel,
      queuedFiles: 1,
      processedFiles: 0,
      processed: false,
    })
  }
  let size = 0
  try {
    size = fs.statSync(filePath).size
  } catch {
    size = 0
  }
  watcherStartupQueuedFiles.set(key, { size, processed: false, sessionKey })
  updateWatcherStartupProgress({
    phase: watcherStartupProgress.ready ? 'processing' : 'discovering',
    queuedFiles: watcherStartupProgress.queuedFiles + 1,
    queuedSessions: watcherStartupQueuedSessions.size,
    queuedBytes: watcherStartupProgress.queuedBytes + size,
    currentSource: source,
    currentFile: path.basename(filePath),
    currentSession: sessionLabel,
  })
  return { counted: true, key, size }
}

function markWatcherStartupProcessed(filePath: string, source: Source, mode: WatcherMode, counted: boolean, key: string | null, size: number): void {
  if (!counted || !watcherStartupProgress.running || watcherStartupProgress.mode !== mode) return
  const progressKey = key || watcherStartupKey(filePath, source)
  const existing = watcherStartupQueuedFiles.get(progressKey)
  if (existing?.processed) return
  if (existing) existing.processed = true
  const sessionKey = existing?.sessionKey || watcherStartupSessionKey(filePath, source)
  const session = watcherStartupQueuedSessions.get(sessionKey)
  let processedSessions = watcherStartupProgress.processedSessions
  if (session) {
    session.processedFiles += 1
    if (!session.processed && session.processedFiles >= session.queuedFiles) {
      session.processed = true
      processedSessions += 1
    }
  }
  const nextProcessed = watcherStartupProgress.processedFiles + 1
  const complete = watcherStartupProgress.ready && nextProcessed >= watcherStartupProgress.queuedFiles
  updateWatcherStartupProgress({
    phase: complete ? 'complete' : 'processing',
    running: !complete,
    processedFiles: nextProcessed,
    processedSessions,
    processedBytes: watcherStartupProgress.processedBytes + size,
    currentSource: source,
    currentFile: path.basename(filePath),
    currentSession: session?.label || watcherStartupSessionLabel(source, filePath),
  })
}

function watchPatternMatches(source: WatchedSource, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  if (source === 'claude-app') return path.basename(filePath) === 'audit.jsonl'
  if (source === 'cursor') return normalized.includes('/agent-transcripts/') && normalized.endsWith('.jsonl')
  return normalized.endsWith('.jsonl')
}

function countExistingWatchFilesForSource(source: WatchedSource, root: string): void {
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
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile() || !watchPatternMatches(source, fullPath)) continue
      markWatcherStartupQueued(fullPath, source, watcherStartupProgress.mode)
    }
  }
}

function countExistingWatchFiles(watchPaths: Record<WatchedSource, string[]>): void {
  for (const [source, basePaths] of Object.entries(watchPaths)) {
    const src = source as WatchedSource
    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) continue
      countExistingWatchFilesForSource(src, basePath)
    }
  }
}

function listWatchFilesForSource(source: WatchedSource, root: string): string[] {
  const out: string[] = []
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
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile() || !watchPatternMatches(source, fullPath)) continue
      out.push(fullPath)
    }
  }
  return out.sort((a, b) => {
    const aModified = safeMtimeMs(a)
    const bModified = safeMtimeMs(b)
    if (aModified !== bModified) return bModified - aModified
    return a.localeCompare(b)
  })
}

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function readJsonRecord<T>(filePath: string): T | null {
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
  fs.renameSync(tmpPath, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
}

function transferJournalKey(journal: TransferReplaceJournal): string {
  return [
    journal.version || 0,
    journal.mode || '',
    journal.phase || '',
    journal.sourceRoot || '',
    journal.destinationRoot || '',
    journal.completedAt || '',
  ].join('\0')
}

async function guardInitialBackfillAfterTransfer(
  mode: WatcherMode,
  offsets: OffsetState,
  watchPaths: Record<WatchedSource, string[]>,
): Promise<void> {
  if (mode !== 'vault') return
  const journal = readJsonRecord<TransferReplaceJournal>(TRANSFER_REPLACE_JOURNAL_FILE)
  if (!journal || journal.phase !== 'completed') return
  if (journal.mode !== 'adopt' && journal.mode !== 'replace') return

  const journalKey = transferJournalKey(journal)
  const guard = readJsonRecord<TransferInitialScanGuard>(TRANSFER_INITIAL_SCAN_GUARD_FILE)
  if (guard?.journalKey === journalKey) return

  let seededFiles = 0
  let seededBytes = 0
  for (const [source, basePaths] of Object.entries(watchPaths)) {
    const src = source as WatchedSource
    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) continue
      for (const filePath of listWatchFilesForSource(src, basePath)) {
        let stat: fs.Stats
        try {
          stat = fs.statSync(filePath)
        } catch {
          continue
        }
        if (!stat.isFile()) continue
        const existing = offsets[filePath]
        if (existing && existing.offset >= 0 && existing.offset <= stat.size) continue
        offsets[filePath] = {
          offset: stat.size,
          sessionId: existing?.sessionId || '',
          source: src,
          lastMod: stat.mtimeMs,
        }
        seededFiles += 1
        seededBytes += stat.size
      }
    }
  }

  if (seededFiles > 0) await saveOffsets(offsets)
  writePrivateJson(TRANSFER_INITIAL_SCAN_GUARD_FILE, {
    version: 1,
    journalKey,
    mode: journal.mode,
    seededFiles,
    seededBytes,
    completedAt: new Date().toISOString(),
  })
  log('transfer_initial_backfill_guarded', {
    mode: journal.mode || null,
    seededFiles,
    seededBytes,
  })
  writeAuditEvent('watcher', 'transfer_initial_backfill_guarded', {
    mode: journal.mode || null,
    seededFiles,
    seededBytes,
  })
  updateHealth('watcher', {
    transferInitialBackfillGuardedAt: new Date().toISOString(),
    transferInitialBackfillGuardSeededFiles: seededFiles,
    transferInitialBackfillGuardSeededBytes: seededBytes,
  })
}

function pollingSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`
  } catch {
    return null
  }
}

function createPollingWatcher(source: Source, basePath: string): { handle: WatchHandle; ready: Promise<void> } {
  let closed = false
  const seen = new Map<string, string>()

  const scan = (eventForNewFiles: 'add' | 'change'): void => {
    if (closed) return
    const currentFiles = new Set<string>()
    for (const filePath of listWatchFilesForSource(source as WatchedSource, basePath)) {
      currentFiles.add(filePath)
      const signature = pollingSignature(filePath)
      if (!signature) continue
      const previous = seen.get(filePath)
      if (previous === signature) continue
      seen.set(filePath, signature)
      queueProcessFile(filePath, source, previous ? 'change' : eventForNewFiles)
    }
    for (const filePath of [...seen.keys()]) {
      if (!currentFiles.has(filePath)) seen.delete(filePath)
    }
  }

  const ready = new Promise<void>(resolve => {
    setImmediate(() => {
      scan('add')
      resolve()
    })
  })

  const timer = setInterval(() => scan('change'), WATCHER_POLL_INTERVAL_MS)
  const handle: WatchHandle = {
    close() {
      closed = true
      clearInterval(timer)
    },
  }
  return { handle, ready }
}

function createNativeWatcher(
  watchPath: string,
  source: Source,
  options: Record<string, unknown>,
): { handle: WatchHandle; ready: Promise<void> } {
  const chokidar = require('chokidar') as ChokidarModule
  const watcher = chokidar.watch(watchPath, options)
  const ready = new Promise<void>(resolve => {
    watcher.once('ready', () => resolve())
  })
  watcher
    .on('add', filePath => queueProcessFile(filePath, source, 'add'))
    .on('change', filePath => queueProcessFile(filePath, source, 'change'))
    .on('error', err => {
      writeLog('error', 'watcher', 'watcher_error', { source, error: safeError(err) })
      updateHealth(`watcher:${source}`, { lastErrorAt: new Date().toISOString(), lastError: safeError(err) })
    })
  return { handle: watcher, ready }
}

export function countExistingWatchSessions(): { totalSessions: number; bySource: Record<Source, number> } {
  const watchPaths = resolveWatchPaths()
  const sessions = new Set<string>()
  const bySource = Object.fromEntries(ALL_SOURCES.map(source => [source, 0])) as Record<Source, number>

  for (const [source, basePaths] of Object.entries(watchPaths)) {
    const src = source as Source
    const sourceSessions = new Set<string>()
    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) continue
      const stack = [basePath]
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
          const fullPath = path.join(current, entry.name)
          if (entry.isDirectory()) {
            stack.push(fullPath)
            continue
          }
          if (!entry.isFile() || !watchPatternMatches(src as WatchedSource, fullPath)) continue
          const key = watcherStartupSessionKey(fullPath, src)
          sessions.add(key)
          sourceSessions.add(key)
        }
      }
    }
    bySource[src] = sourceSessions.size
  }

  return { totalSessions: sessions.size, bySource }
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
  mode: WatcherMode,
  processedOffset: number,
  fileSize: number,
): Promise<void> {
  if (processedOffset >= fileSize) return
  await yieldToEventLoop()
  await processFile(filePath, source, offsets, mode)
}

function defaultState(source: Source): FileState {
  return {
    sessionId: '',
    source,
    sourceClient: undefined,
    title: undefined,
    appVersion: '',
    model: 'unknown',
    modelProvider: source.startsWith('codex') ? 'openai' : source === 'openclaw' || source === 'cursor' ? 'openai/anthropic' : 'anthropic',
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
  const guessedSessionId = source === 'codex-cli'
    ? codexSessionIdFromPath(filePath)
    : source === 'cursor'
      ? cursorSessionIdFromPath(filePath)
      : saved?.sessionId

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
      state.title = existing.title
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

  if ((source === 'claude-cli' || source === 'claude-app') && isClaudeSyntheticModel(state.model)) {
    state.model = 'unknown'
  }

  if (source === 'codex-cli' && (!state.appVersion || state.model === 'unknown' || !state.cwd)) {
    hydrateCodexStateFromHeader(filePath, state)
  }

  refreshStateTitle(filePath, source, state)

  return state
}

function refreshStateTitle(filePath: string, source: Source, state: FileState): void {
  if (!state.sessionId) return
  if (source === 'codex-cli') {
    const title = codexSessionTitle(filePath, state.sessionId)
    if (title) state.title = title
  } else if (source === 'cursor') {
    const title = cursorSessionTitle(state.sessionId)
    if (title) state.title = title
  }
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

export async function startWatchers(mode: WatcherMode = 'vault', options: StartWatchersOptions = {}): Promise<void> {
  if (watchersStarted && watcherMode === mode) return
  if (watchersStarted && watcherMode !== mode) await stopWatchers()
  watcherMode = mode
  watchersStarted = true
  watcherStartupQueuedFiles.clear()
  watcherStartupQueuedSessions.clear()
  updateWatcherStartupProgress({
    running: true,
    mode,
    phase: 'discovering',
    ready: false,
    watcherCount: 0,
    queuedFiles: 0,
    processedFiles: 0,
    queuedSessions: 0,
    processedSessions: 0,
    queuedBytes: 0,
    processedBytes: 0,
    currentSource: null,
    currentFile: null,
    currentSession: null,
    startedAt: new Date().toISOString(),
  })
  const offsets = await loadWatcherOffsets(mode)
  offsetsPromise = Promise.resolve(offsets)
  const watchPaths = resolveWatchPaths()
  await guardInitialBackfillAfterTransfer(mode, offsets, watchPaths)
  countExistingWatchFiles(watchPaths)
  const readyPromises: Promise<void>[] = []

  for (const [source, basePaths] of Object.entries(watchPaths)) {
    const src = source as WatchedSource
    const pattern = GLOB_PATTERNS[src]

    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) {
        log('watch_path_missing', { source: src })
        continue
      }

      const watchPath = path.join(basePath, pattern)
      const watcherBackend = WATCHER_USE_POLLING ? 'polling' : 'native'
      log('watching', { source: src, backend: watcherBackend })
      updateHealth(`watcher:${src}`, {
        watching: true,
        lastStartedAt: new Date().toISOString(),
        watchBackend: watcherBackend,
        watchRoot: basePath,
        watchPattern: pattern,
        ...(WATCHER_USE_POLLING
          ? {
              pollIntervalMs: WATCHER_POLL_INTERVAL_MS,
              binaryPollIntervalMs: WATCHER_BINARY_POLL_INTERVAL_MS,
            }
          : {}),
      })

      const watcher = WATCHER_USE_POLLING
        ? createPollingWatcher(src, basePath)
        : createNativeWatcher(watchPath, src, {
            persistent: true,
            ignoreInitial: false,   // process existing files on startup
            followSymlinks: false,
            usePolling: false,
            useFsEvents: true,
            interval: WATCHER_POLL_INTERVAL_MS,
            binaryInterval: WATCHER_BINARY_POLL_INTERVAL_MS,
            alwaysStat: true,
            awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
          })
      activeWatchers.push(watcher.handle)
      updateWatcherStartupProgress({ watcherCount: activeWatchers.length })

      readyPromises.push(watcher.ready)
    }
  }

  const readyStatus = await waitForStartupPhase(
    'ready',
    Promise.all(readyPromises).then(() => undefined),
    WATCHER_READY_TIMEOUT_MS,
    { mode, watcherCount: activeWatchers.length },
  )
  updateWatcherStartupProgress({
    phase: watcherStartupProgress.processedSessions >= watcherStartupProgress.queuedSessions ? 'complete' : 'processing',
    ready: true,
    running: watcherStartupProgress.processedSessions < watcherStartupProgress.queuedSessions,
    watcherCount: activeWatchers.length,
  })
  const initialQueueTimeoutMs = Number.isFinite(options.initialQueueTimeoutMs) && options.initialQueueTimeoutMs! >= 0
    ? options.initialQueueTimeoutMs!
    : WATCHER_INITIAL_QUEUE_TIMEOUT_MS
  const queueStatus = await waitForStartupPhase(
    'initial_queue',
    processQueue,
    initialQueueTimeoutMs,
    { mode, watcherCount: activeWatchers.length, initialQueueTimeoutMs },
  )
  if (queueStatus === 'completed') {
    updateWatcherStartupProgress({
      running: false,
      phase: 'complete',
      ready: true,
      processedFiles: watcherStartupProgress.queuedFiles,
      processedSessions: watcherStartupProgress.queuedSessions,
      processedBytes: Math.max(watcherStartupProgress.processedBytes, watcherStartupProgress.queuedBytes),
      currentFile: null,
      currentSource: null,
      currentSession: null,
    })
  }
  log('initial_scan_complete', { mode, watcherCount: activeWatchers.length, readyStatus, queueStatus })
}

export async function stopWatchers(): Promise<void> {
  if (!watchersStarted && activeWatchers.length === 0) return
  watchersStarted = false
  const watchers = activeWatchers.splice(0)
  await Promise.allSettled(watchers.map(watcher => watcher.close()))
  await processQueue.catch(err => {
    writeLog('error', 'watcher', 'process_queue_drain_failed', { error: safeError(err) })
  })
  watcherMode = 'vault'
  fileStates.clear()
  offsetsPromise = null
  watcherStartupQueuedFiles.clear()
  watcherStartupQueuedSessions.clear()
  updateWatcherStartupProgress({
    running: false,
    phase: 'idle',
    ready: false,
    watcherCount: 0,
    queuedFiles: 0,
    processedFiles: 0,
    queuedSessions: 0,
    processedSessions: 0,
    queuedBytes: 0,
    processedBytes: 0,
    currentFile: null,
    currentSource: null,
    currentSession: null,
    startedAt: null,
  })
  log('stopped')
  for (const source of ALL_SOURCES) {
    updateHealth(`watcher:${source}`, { watching: false, stoppedAt: new Date().toISOString() })
  }
}

function queueProcessFile(filePath: string, source: Source, event: 'add' | 'change'): void {
  const modeAtEnqueue = watcherMode
  const offsetsAtEnqueue = offsetsPromise
  const startupCount = markWatcherStartupQueued(filePath, source, modeAtEnqueue)
  updateHealth(`watcher:${source}`, {
    lastEventAt: new Date().toISOString(),
    lastEvent: event,
    lastEventFile: path.basename(filePath),
  })

  pendingProcessJobs.push({
    filePath,
    source,
    event,
    mode: modeAtEnqueue,
    offsetsPromise: offsetsAtEnqueue,
    startupCount,
    modifiedMs: safeMtimeMs(filePath),
    queuedAt: Date.now(),
  })
  startProcessQueue()
}

function startProcessQueue(): void {
  if (processQueueRunning) return
  processQueueRunning = true
  processQueue = drainProcessQueue()
}

// Queues a full reprocess of one watched source file through the normal
// capture queue (serialized with live capture jobs). Used by vault line repair
// after it wipes a damaged session and resets the file's offset to zero.
export function requestSourceFileReprocess(filePath: string, source: Source): void {
  if (!fs.existsSync(filePath)) return
  queueProcessFile(filePath, source, 'change')
}

function nextProcessJob(): ProcessJob | undefined {
  if (pendingProcessJobs.length === 0) return undefined
  let bestIndex = 0
  for (let index = 1; index < pendingProcessJobs.length; index += 1) {
    const candidate = pendingProcessJobs[index]
    const best = pendingProcessJobs[bestIndex]
    if (processJobSort(candidate, best) < 0) bestIndex = index
  }
  const [job] = pendingProcessJobs.splice(bestIndex, 1)
  return job
}

function processJobSort(a: ProcessJob, b: ProcessJob): number {
  const aPriority = a.event === 'change' ? 0 : 1
  const bPriority = b.event === 'change' ? 0 : 1
  if (aPriority !== bPriority) return aPriority - bPriority
  if (a.modifiedMs !== b.modifiedMs) return b.modifiedMs - a.modifiedMs
  return a.queuedAt - b.queuedAt
}

async function drainProcessQueue(): Promise<void> {
  try {
    while (pendingProcessJobs.length > 0) {
      const job = nextProcessJob()
      if (!job) break
      try {
        await yieldToEventLoop()
        const offsets = job.offsetsPromise ? await job.offsetsPromise : await loadWatcherOffsets(job.mode)
        await processFile(job.filePath, job.source, offsets, job.mode)
        markWatcherStartupProcessed(
          job.filePath,
          job.source,
          job.mode,
          job.startupCount.counted,
          job.startupCount.key,
          job.startupCount.size,
        )
        await yieldToEventLoop()
      } catch (err) {
        writeLog('error', 'watcher', 'process_file_failed', {
          source: job.source,
          file: path.basename(job.filePath),
          error: safeError(err),
        })
      }
    }
  } finally {
    processQueueRunning = false
    if (pendingProcessJobs.length > 0) startProcessQueue()
  }
}

function isVaultSessionMissingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('vault session missing')
}

async function processFile(
  filePath: string,
  source: Source,
  offsets: Awaited<ReturnType<typeof loadOffsets>>,
  mode: WatcherMode,
  retryStaleCaptureSession = true,
): Promise<void> {
  try {
    const stat = fs.statSync(filePath)
    const offsetKey = filePath
    const savedOffset = offsets[offsetKey]?.offset ?? 0
    const fileSize = stat.size

    updateHealth(`watcher:${source}`, {
      lastProcessAttemptAt: new Date().toISOString(),
      lastProcessAttemptFile: path.basename(filePath),
      lastProcessAttemptFileSize: fileSize,
      lastProcessAttemptOffset: savedOffset,
    })

    if (fileSize <= savedOffset) {
      updateHealth(`watcher:${source}`, {
        lastNoopAt: new Date().toISOString(),
        lastNoopFile: path.basename(filePath),
        lastNoopReason: 'file_size_at_or_below_offset',
        lastNoopFileSize: fileSize,
        lastNoopOffset: savedOffset,
        lastErrorAt: null,
        lastError: null,
      })
      return  // nothing new
    }

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
      await continueFileIfPending(filePath, source, offsets, mode, batch.endOffset, fileSize)
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
      await continueFileIfPending(filePath, source, offsets, mode, batch.endOffset, fileSize)
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
      if (parseError === undefined) observeDrift(source as WatchedSource, parsed, drift)
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
        await processLine(lineMetas[index].line, filePath, source, state, newMessages, mode !== 'bootstrap')
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

    if (mode === 'bootstrap') {
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
      await continueFileIfPending(filePath, source, offsets, mode, batch.endOffset, fileSize)
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

    // Resolve the canonical session up front so a Claude resume/fork file's raw,
    // source-archive, and parsed data all land under one uid instead of spawning
    // a duplicate session per replayed file.
    const captureTarget = await resolveCanonicalCaptureTarget(source, filePath, rawSessionId)
    const rawSessionUid = captureTarget.uid
    try {
      const archiveSessionId = getCaptureSessionId() ?? getVaultSessionId()
      if (!archiveSessionId) throw new Error('vault capture session missing')
      await appendSourceArchiveChunk(archiveSessionId, {
        source,
        sessionUid: rawSessionUid,
        sourcePath: filePath,
        startOffset: savedOffset,
        endOffset: batch.endOffset,
        bytes: batch.buffer,
      })
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

    wroteToVault = await persistMessages(filePath, source, state, newMessages, skippedLines, captureTarget)

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
      lastRawArchiveBytes: batch.buffer.length,
      lastRawWriteUsedFallbackSession: usedFallbackRawSession,
      lastErrorAt: null,
      lastError: null,
    })

    // Advance offsets only after a successful raw + vault write.
    offsets[offsetKey] = {
      offset: batch.endOffset,
      sessionId: state.sessionId || '',
      source,
      lastMod: stat.mtimeMs,
    }
    await saveOffsets(offsets)
    queueReferencedAttachmentBackupForRawRecords(source, rawSessionUid, rawRecords)
    fileStates.set(filePath, state)
    await continueFileIfPending(filePath, source, offsets, mode, batch.endOffset, fileSize)
  } catch (err) {
    if (retryStaleCaptureSession && isVaultSessionMissingError(err) && hasVaultSession()) {
      clearCaptureSession()
      writeLog('warn', 'watcher', 'stale_capture_session_recovered', {
        source,
        file: path.basename(filePath),
      })
      updateHealth(`watcher:${source}`, {
        lastRecoveredAt: new Date().toISOString(),
        lastRecoveredReason: 'stale_capture_session',
        lastRecoveredFile: path.basename(filePath),
      })
      await processFile(filePath, source, offsets, mode, false)
      return
    }
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

interface CanonicalCaptureTarget {
  uid: string
  routed: boolean
  baseSession?: Session
}

// Resolve the vault session a file's data belongs to. For Claude resume/fork
// files (same internal sessionId across multiple source files) this returns the
// canonical session's uid so the replayed copy collapses into one session instead
// of spawning a new duplicate. Returns the file's own uid for every other case.
async function resolveCanonicalCaptureTarget(
  source: Source,
  filePath: string,
  sessionId: string,
): Promise<CanonicalCaptureTarget> {
  const sourceAccount = sourceAccountFromPath(source, filePath)
  const fileUid = buildSessionUid({ source, sourceAccount, sessionId, originalPath: filePath })
  const groupKey = claudeForkGroupKey(source, sourceAccount, sessionId)
  if (!groupKey) return { uid: fileUid, routed: false }
  const sessions = await loadSessionsForRouting()
  const idents = sessions
    .filter(s => claudeForkGroupKeyForSession(s) === groupKey)
    .map(s => ({ uid: s.uid, id: s.id, originalPath: s.originalPath }))
  const others = idents.filter(m => m.uid !== fileUid)
  if (others.length === 0) return { uid: fileUid, routed: false }
  const uid = pickCanonicalForkUid([...idents, { uid: fileUid, id: sessionId, originalPath: filePath }])
  if (uid === fileUid) return { uid: fileUid, routed: false }
  return { uid, routed: true, baseSession: sessions.find(s => s.uid === uid) }
}

// loadSessions decrypts the whole session index through the vault helper.
// Canonical routing runs on every claude file batch, so an uncached call per
// batch makes first-unlock backlog processing crawl. Routing only needs an
// eventually-fresh view (a brand-new sibling fork is merged later by
// maintenance anyway), so a short TTL cache is safe.
const ROUTING_SESSIONS_TTL_MS = 5_000
let routingSessionsCache: { at: number; sessions: Session[] } | null = null
async function loadSessionsForRouting(): Promise<Session[]> {
  const now = Date.now()
  if (routingSessionsCache && now - routingSessionsCache.at < ROUTING_SESSIONS_TTL_MS) {
    return routingSessionsCache.sessions
  }
  const sessions = await loadSessions()
  routingSessionsCache = { at: now, sessions }
  return sessions
}

async function knownKeysForCanonical(uid: string, baseSession: Session | undefined): Promise<Set<string>> {
  let keys = canonicalKnownKeys.get(uid)
  if (keys) return keys
  keys = new Set<string>()
  if (baseSession) {
    const existing = await readSessionMessages(baseSession)
    for (const message of existing) keys.add(normalizedMessageKey(message))
  }
  canonicalKnownKeys.set(uid, keys)
  return keys
}

async function persistMessages(
  filePath: string,
  source: Source,
  state: FileState,
  newMessages: Message[],
  skippedLines: number,
  target: CanonicalCaptureTarget,
): Promise<boolean> {
  if (!state.sessionId || newMessages.length === 0) return false
  const sourceAccount = sourceAccountFromPath(source, filePath)
  const uid = target.uid

  // Resume/fork file routed into an existing canonical session: append only the
  // turns not already stored, and grow the canonical session's metadata.
  if (target.routed && target.baseSession) {
    const base = target.baseSession
    const keys = await knownKeysForCanonical(uid, base)
    const toAppend: Message[] = []
    for (const message of newMessages) {
      const key = normalizedMessageKey(message)
      if (keys.has(key)) continue
      keys.add(key)
      toAppend.push(message)
    }
    const lastTimestamp = state.lastTimestamp > (base.lastTimestamp || '') ? state.lastTimestamp : base.lastTimestamp
    const merged: Session = {
      ...base,
      lastTimestamp,
      messageCount: base.messageCount + toAppend.length,
      hasThinking: base.hasThinking || state.hasThinking,
    }
    if (toAppend.length > 0) await appendMessages(merged, toAppend)
    await upsertSession(merged)
    base.messageCount = merged.messageCount
    base.lastTimestamp = merged.lastTimestamp
    base.hasThinking = merged.hasThinking
    log('messages_saved', { source, count: toAppend.length, session: state.sessionId.slice(0, 8), merged: true })
    writeAuditEvent('watcher', 'messages_saved', {
      source,
      count: toAppend.length,
      session: state.sessionId.slice(0, 8),
      file: path.basename(filePath),
      mergedIntoCanonical: true,
    })
    updateHealth(`watcher:${source}`, {
      lastCaptureAt: new Date().toISOString(),
      lastSession: state.sessionId.slice(0, 8),
      lastCaptureCount: toAppend.length,
      lastSkippedLines: skippedLines,
      mode: 'vault',
    })
    return true
  }

  const session: Session = {
    uid,
    id: state.sessionId,
    source,
    sourceClient: state.sourceClient,
    sourceAccount,
    appVersion: state.appVersion,
    model: state.model,
    modelProvider: state.modelProvider,
    title: state.title,
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
    refreshStateTitle(filePath, source, state)
    if (result.sourceClient && !state.sourceClient) state.sourceClient = result.sourceClient
    if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
    if (result.model) state.model = result.model
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
    if (result.model) state.model = result.model
    if (result.modelProvider) state.modelProvider = result.modelProvider
    if (result.cwd && !state.cwd) state.cwd = result.cwd
    if (result.message) {
      decorateWithSessionState(result.message, state)
      updateStateFromMessage(state, result.message)
      out.push(result.message)
    }
    return
  }

  if (source === 'cursor') {
    const result = extractCursorLine(line, filePath)
    if (!result) return
    if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
    refreshStateTitle(filePath, source, state)
    if (result.sourceClient && !state.sourceClient) state.sourceClient = result.sourceClient
    if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
    if (result.model) state.model = result.model
    if (result.cwd && !state.cwd) state.cwd = result.cwd
    if (result.message) {
      if (captureAttachments) {
        await attachRawImages(source, filePath, state, result.message, result.rawImages)
      }
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

export async function importBootstrapCaptureIntoVault(
  onProgress?: (progress: BootstrapImportProgress) => void,
): Promise<{ importedFiles: number; importedMessages: number; remainingFiles: number }> {
  const entries = await listBootstrapEntries()
  if (entries.length === 0) {
    await clearBootstrapCaptureData()
    disableBootstrapCapture()
    onProgress?.({
      importedFiles: 0,
      importedMessages: 0,
      totalFiles: 0,
      remainingFiles: 0,
      done: true,
    })
    return { importedFiles: 0, importedMessages: 0, remainingFiles: 0 }
  }

  const offsets = await loadOffsets()
  const totalFiles = entries.length
  let importedFiles = 0
  let importedMessages = 0
  const emitProgress = (remainingFiles = Math.max(totalFiles - importedFiles, 0), done = false): void => {
    onProgress?.({
      importedFiles,
      importedMessages,
      totalFiles,
      remainingFiles,
      done,
    })
  }
  emitProgress()

  for (const entry of entries) {
    try {
      const savedOffset = offsets[entry.originalPath]?.offset ?? 0
      if (savedOffset >= entry.offset) {
        await markBootstrapEntryImported(entry.originalPath)
        importedFiles += 1
        updateHealth(`watcher:${entry.source}`, {
          lastBootstrapImportAt: new Date().toISOString(),
          lastBootstrapImportSkippedReason: 'source_already_imported',
          lastErrorAt: null,
          lastError: null,
        })
        emitProgress()
        continue
      }

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
        updateHealth(`watcher:${entry.source}`, {
          lastBootstrapImportAt: new Date().toISOString(),
          lastBootstrapImportSkippedReason: 'missing_spool_file',
          lastErrorAt: null,
          lastError: null,
        })
        emitProgress()
        continue
      }

      // Bootstrap watcher state may already include pre-setup scan counters.
      // Importing the encrypted spool must rebuild the vault session metadata
      // from the spool lines themselves, otherwise a daemon restart before
      // setup can double-count messages while only writing each message once.
      const state = await hydrateState(entry.originalPath, entry.source, offsets)
      if (!state.sessionId && entry.sessionId) state.sessionId = entry.sessionId
      let newMessages: Message[] = []
      let rawRecords: RawRecord[] = []
      const drift: DriftBuckets = { unknownEventTypes: {}, unknownTopLevelKeys: {} }
      let skippedLines = 0
      const capturedAt = new Date().toISOString()
      let entryImportedMessages = 0

      const flushBuffers = async (nextLine: number, nextSpoolCursor: number): Promise<void> => {
        if (rawRecords.length === 0 && newMessages.length === 0) return

        const bufferedRawRecords = rawRecords
        const bufferedMessages = newMessages
        rawRecords = []
        newMessages = []

        const rawSessionId = state.sessionId || entry.sessionId || fallbackRawSessionId(entry.source, entry.originalPath)
        const usedFallbackRawSession = !state.sessionId && !entry.sessionId
        const captureTarget = await resolveCanonicalCaptureTarget(entry.source, entry.originalPath, rawSessionId)
        const rawSessionUid = captureTarget.uid

        try {
          await appendRawRecords(entry.source, rawSessionUid, bufferedRawRecords)
          updateHealth(`watcher:${entry.source}`, {
            lastRawWriteAt: new Date().toISOString(),
            lastRawWriteCount: bufferedRawRecords.length,
            lastRawWriteUsedFallbackSession: usedFallbackRawSession,
          })
        } catch (err) {
          writeLog('error', 'watcher', 'bootstrap_raw_append_failed', {
            source: entry.source,
            file: path.basename(entry.originalPath),
            error: safeError(err),
          })
          updateHealth(`watcher:${entry.source}`, {
            lastErrorAt: new Date().toISOString(),
            lastError: safeError(err),
          })
          throw err
        }

        const wroteToVault = await persistMessages(entry.originalPath, entry.source, state, bufferedMessages, skippedLines, captureTarget)
        if (bufferedMessages.length > 0 && !wroteToVault) {
          writeLog('warn', 'watcher', 'bootstrap_messages_missing_session', {
            source: entry.source,
            file: path.basename(entry.originalPath),
          })
        }

        entryImportedMessages += bufferedMessages.length
        importedMessages += bufferedMessages.length
        await updateBootstrapEntryImportCursor(entry.originalPath, nextLine, nextSpoolCursor)
        updateHealth(`watcher:${entry.source}`, {
          lastBootstrapImportAt: new Date().toISOString(),
          lastBootstrapImportLine: nextLine,
          lastBootstrapImportedMessages: entryImportedMessages,
          lastErrorAt: null,
          lastError: null,
        })
        emitProgress()
        await yieldToEventLoop()
      }

      await forEachBootstrapCaptureLineBatch(
        entry.spoolFile,
        async batch => {
          let spoolCursor = batch.startSpoolCursor
          for (let index = 0; index < batch.lines.length; index += 1) {
            const lineText = batch.lines[index]
            const sourceByteOffset = spoolCursor
            spoolCursor += Buffer.byteLength(lineText, 'utf8') + 1

            let parsed: unknown = null
            let parseError: string | undefined
            try {
              parsed = JSON.parse(lineText)
            } catch (err) {
              parseError = err instanceof Error ? err.message : String(err)
            }
            if (parseError === undefined) observeDrift(entry.source as WatchedSource, parsed, drift)
            rawRecords.push({
              v: 1,
              source: entry.source,
              sourcePath: entry.originalPath,
              sourceByteOffset,
              capturedAt,
              rawHash: sha256Hex(lineText),
              raw: parseError === undefined ? stripBase64Payloads(parsed) : lineText,
              ...(parseError !== undefined ? { parseError } : {}),
            })
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
                line: batch.startLine + index + 1,
                error: safeError(err),
              })
            }

            if (
              rawRecords.length >= BOOTSTRAP_IMPORT_FLUSH_LINES
              || newMessages.length >= BOOTSTRAP_IMPORT_FLUSH_LINES
            ) {
              await flushBuffers(batch.startLine + index + 1, spoolCursor)
            }
            if ((index + 1) % WATCHER_YIELD_EVERY_LINES === 0) await yieldToEventLoop()
          }
          await flushBuffers(batch.nextLine, batch.nextSpoolCursor)
        },
        {
          startLine: entry.importLine ?? 0,
          startSpoolCursor: entry.importSpoolCursor ?? 0,
        },
      )

      const hasDrift = Object.keys(drift.unknownEventTypes).length > 0
                    || Object.keys(drift.unknownTopLevelKeys).length > 0
      if (hasDrift) updateHealthDrift(entry.source, drift)

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
      updateHealth(`watcher:${entry.source}`, {
        lastBootstrapImportAt: new Date().toISOString(),
        lastBootstrapImportedMessages: entryImportedMessages,
        lastErrorAt: null,
        lastError: null,
      })
      emitProgress()
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
  emitProgress(remainingFiles, true)
  writeAuditEvent('watcher', 'bootstrap_import_completed', {
    importedFiles,
    importedMessages,
    remainingFiles,
  })
  return { importedFiles, importedMessages, remainingFiles }
}
