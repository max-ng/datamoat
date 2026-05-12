import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import {
  REFERENCED_ATTACHMENTS_FILE,
} from './config'
import type { RawRecord, Source } from './types'
import {
  getCaptureSessionId,
  getVaultSessionId,
  loadSessions,
  readRawRecords,
  saveAttachment,
} from './store'
import {
  decryptStateForSession,
  encryptStateForSession,
} from './vault-helper'
import {
  safeError,
  updateHealth,
  writeAuditEvent,
  writeLog,
} from './logging'

const STATE_PREFIX = 'dmstate1:'
const INDEX_VERSION = 1
const MAX_REFERENCE_SCAN_CHARS = 256 * 1024
const MAX_REFERENCES_PER_TEXT = 50
const MAX_REFERENCED_FILE_BYTES = 100 * 1024 * 1024
const MAX_BACKFILL_SESSIONS_PER_RUN = 5000
const MAX_BACKFILL_RECORDS_PER_SESSION = 5000
const MAX_QUEUE_BATCHES_PER_DRAIN = 25
const MAX_BACKFILL_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.DATAMOAT_REFERENCED_ATTACHMENT_BACKFILL_CONCURRENCY || 3) || 3))

type PermissionIssueRecord = {
  kind: string
  label: string
  lastSeenAt: string
}

type ProtectedFolderSummary = {
  label: string
  files: number
}

type ReferencedAttachmentRecord = {
  key: string
  source: Source
  sessionUid: string
  rawHash: string
  originalPath: string
  attachmentId: string
  mediaType: string
  size: number
  fileModifiedAt: string | null
  capturedAt: string
}

type ReferencedAttachmentIndex = {
  version: number
  enabled: boolean
  updatedAt: string
  lastScanAt: string | null
  previousSessionsChecked: number
  protected: Record<string, ReferencedAttachmentRecord>
  permissionIssues: Record<string, PermissionIssueRecord>
}

export type ReferencedAttachmentStatus = {
  enabled: boolean
  running: boolean
  protectedFiles: number
  previousSessionsChecked: number
  coveredApps: Source[]
  protectedFolders: ProtectedFolderSummary[]
  permissionIssues: PermissionIssueRecord[]
  scanProgress: {
    phase: string
    checked: number
    total: number
    startedAt: string
  } | null
  lastScanAt: string | null
  updatedAt: string | null
  platform: NodeJS.Platform
}

export type ReferencedAttachmentForUI = {
  originalPath: string
  attachmentId: string
  mediaType: string
  attachmentName: string
}

type QueuedRawBatch = {
  source: Source
  sessionUid: string
  records: RawRecord[]
}

let queue: QueuedRawBatch[] = []
let drainScheduled = false
let scanInFlight: Promise<ReferencedAttachmentStatus> | null = null
let activeScanProgress: ReferencedAttachmentStatus['scanProgress'] = null

const REFERENCED_FILE_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'pdf',
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'rtf', 'html', 'htm', 'xml', 'log',
  'zip',
]

const EXT_PATTERN = `(?:${REFERENCED_FILE_EXTENSIONS.join('|')})`

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'application/jsonl',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  rtf: 'application/rtf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  log: 'text/plain',
}

function defaultIndex(): ReferencedAttachmentIndex {
  return {
    version: INDEX_VERSION,
    enabled: false,
    updatedAt: new Date().toISOString(),
    lastScanAt: null,
    previousSessionsChecked: 0,
    protected: {},
    permissionIssues: {},
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

async function readIndex(): Promise<ReferencedAttachmentIndex> {
  try {
    if (!fs.existsSync(REFERENCED_ATTACHMENTS_FILE)) return defaultIndex()
    const raw = fs.readFileSync(REFERENCED_ATTACHMENTS_FILE, 'utf8').trim()
    if (!raw) return defaultIndex()
    if (raw.startsWith('{')) return normalizeIndex(JSON.parse(raw))
    const sessionId = stateSessionId()
    if (!sessionId || !raw.startsWith(STATE_PREFIX)) return defaultIndex()
    const json = await decryptStateForSession(sessionId, raw.slice(STATE_PREFIX.length))
    return normalizeIndex(JSON.parse(json))
  } catch (error) {
    writeLog('warn', 'referenced-attachments', 'read_index_failed', { error: safeError(error) })
    updateHealth('referenced-attachments', {
      lastErrorAt: new Date().toISOString(),
      lastError: safeError(error),
    })
    return defaultIndex()
  }
}

function normalizeIndex(value: unknown): ReferencedAttachmentIndex {
  if (!value || typeof value !== 'object') return defaultIndex()
  const raw = value as Partial<ReferencedAttachmentIndex>
  return {
    version: INDEX_VERSION,
    enabled: raw.enabled === true,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    lastScanAt: typeof raw.lastScanAt === 'string' ? raw.lastScanAt : null,
    previousSessionsChecked: typeof raw.previousSessionsChecked === 'number'
      ? raw.previousSessionsChecked
      : 0,
    protected: raw.protected && typeof raw.protected === 'object' ? raw.protected : {},
    permissionIssues: raw.permissionIssues && typeof raw.permissionIssues === 'object'
      ? raw.permissionIssues
      : {},
  }
}

async function writeIndex(index: ReferencedAttachmentIndex): Promise<void> {
  const sessionId = stateSessionId()
  if (!sessionId) throw new Error('referenced attachment state session unavailable')
  const updated: ReferencedAttachmentIndex = {
    ...index,
    version: INDEX_VERSION,
    updatedAt: new Date().toISOString(),
  }
  const encrypted = await encryptStateForSession(sessionId, JSON.stringify(updated))
  ensurePrivateDir(REFERENCED_ATTACHMENTS_FILE)
  const tmp = `${REFERENCED_ATTACHMENTS_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, `${STATE_PREFIX}${encrypted}`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, REFERENCED_ATTACHMENTS_FILE)
  try { fs.chmodSync(REFERENCED_ATTACHMENTS_FILE, 0o600) } catch { /* non-fatal */ }
}

function statusFromIndex(index: ReferencedAttachmentIndex, running = false): ReferencedAttachmentStatus {
  const coveredApps = new Set<Source>()
  const uniqueAttachments = new Set<string>()
  const folderAttachments = new Map<string, Set<string>>()
  for (const item of Object.values(index.protected)) {
    coveredApps.add(item.source)
    uniqueAttachments.add(item.attachmentId)
    const folderLabel = protectedFolderLabelForPath(item.originalPath)
    if (!folderAttachments.has(folderLabel)) folderAttachments.set(folderLabel, new Set())
    folderAttachments.get(folderLabel)?.add(item.attachmentId)
  }
  const protectedFolders = Array.from(folderAttachments.entries())
    .map(([label, attachments]) => ({ label, files: attachments.size }))
    .sort((a, b) => b.files - a.files || a.label.localeCompare(b.label))
    .slice(0, 8)
  return {
    enabled: index.enabled,
    running,
    protectedFiles: uniqueAttachments.size,
    previousSessionsChecked: Math.max(index.previousSessionsChecked, activeScanProgress?.checked ?? 0),
    coveredApps: Array.from(coveredApps).sort(),
    protectedFolders,
    permissionIssues: Object.values(index.permissionIssues).sort((a, b) => a.label.localeCompare(b.label)),
    scanProgress: activeScanProgress,
    lastScanAt: index.lastScanAt,
    updatedAt: index.updatedAt || null,
    platform: process.platform,
  }
}

export async function referencedAttachmentStatus(): Promise<ReferencedAttachmentStatus> {
  const running = !!scanInFlight || drainScheduled
  const index = await readIndex()
  if (index.enabled && clearResolvedPermissionIssues(index)) {
    await writeIndex(index)
  }
  return statusFromIndex(index, running)
}

export async function readReferencedAttachmentsForSessionUI(
  source: Source,
  sessionUid: string,
): Promise<ReferencedAttachmentForUI[]> {
  const index = await readIndex()
  if (!index.enabled) return []
  const seen = new Set<string>()
  const out: ReferencedAttachmentForUI[] = []
  for (const item of Object.values(index.protected)) {
    if (item.source !== source || item.sessionUid !== sessionUid) continue
    const key = normalizeKeyPath(item.originalPath)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      originalPath: item.originalPath,
      attachmentId: item.attachmentId,
      mediaType: item.mediaType,
      attachmentName: path.basename(item.originalPath),
    })
  }
  return out
}

export async function setReferencedAttachmentBackupEnabled(enabled: boolean): Promise<ReferencedAttachmentStatus> {
  const index = await readIndex()
  index.enabled = enabled
  await writeIndex(index)
  updateHealth('referenced-attachments', {
    enabled,
    updatedAt: new Date().toISOString(),
  })
  writeAuditEvent('referenced-attachments', enabled ? 'enabled' : 'disabled')
  if (enabled) queueReferencedAttachmentBackfill('enabled')
  return statusFromIndex(index, enabled)
}

export function queueReferencedAttachmentBackupForRawRecords(
  source: Source,
  sessionUid: string,
  records: RawRecord[],
): void {
  if (records.length === 0) return
  queue.push({ source, sessionUid, records })
  if (queue.length > 100) queue = queue.slice(-100)
  scheduleDrain()
}

export function queueReferencedAttachmentBackfill(reason: string): void {
  if (scanInFlight) return
  scanInFlight = scanPreviousSessionsForReferencedAttachments(reason)
    .catch(error => {
      writeLog('warn', 'referenced-attachments', 'backfill_failed', { reason, error: safeError(error) })
      updateHealth('referenced-attachments', {
        lastErrorAt: new Date().toISOString(),
        lastError: safeError(error),
      })
      return referencedAttachmentStatus()
    })
    .finally(() => {
      activeScanProgress = null
      scanInFlight = null
    }) as Promise<ReferencedAttachmentStatus>
}

function scheduleDrain(): void {
  if (drainScheduled) return
  drainScheduled = true
  setTimeout(() => {
    void drainQueuedRawBatches()
  }, 250)
}

async function drainQueuedRawBatches(): Promise<void> {
  drainScheduled = false
  const batches = queue.splice(0, MAX_QUEUE_BATCHES_PER_DRAIN)
  if (batches.length === 0) return

  try {
    let index = await readIndex()
    if (!index.enabled) return
    for (const batch of batches) {
      index = await backUpRawRecordReferences(index, batch.source, batch.sessionUid, batch.records)
    }
    index.lastScanAt = new Date().toISOString()
    await writeIndex(index)
  } catch (error) {
    writeLog('warn', 'referenced-attachments', 'queue_drain_failed', { error: safeError(error) })
    updateHealth('referenced-attachments', {
      lastErrorAt: new Date().toISOString(),
      lastError: safeError(error),
    })
  } finally {
    if (queue.length > 0) scheduleDrain()
  }
}

export async function scanPreviousSessionsForReferencedAttachments(
  reason = 'manual',
): Promise<ReferencedAttachmentStatus> {
  let index = await readIndex()
  if (!index.enabled) return statusFromIndex(index)

  const sessions = (await loadSessions()).slice(0, MAX_BACKFILL_SESSIONS_PER_RUN)
  let checked = 0
  activeScanProgress = {
    phase: 'checking previous sessions',
    checked,
    total: sessions.length,
    startedAt: new Date().toISOString(),
  }
  updateHealth('referenced-attachments', {
    running: true,
    lastScanStartedAt: activeScanProgress.startedAt,
    reason,
    totalSessions: sessions.length,
    concurrency: MAX_BACKFILL_CONCURRENCY,
  })

  let nextSessionIndex = 0
  const worker = async (): Promise<void> => {
    while (nextSessionIndex < sessions.length) {
      const session = sessions[nextSessionIndex]
      nextSessionIndex += 1
      try {
        const rawRecords = (await readRawRecords(session.source, session.uid)).slice(0, MAX_BACKFILL_RECORDS_PER_SESSION)
        index = await backUpRawRecordReferences(index, session.source, session.uid, rawRecords)
      } catch (error) {
        writeLog('warn', 'referenced-attachments', 'session_scan_skipped', {
          source: session.source,
          session: session.uid.slice(0, 8),
          error: safeError(error),
        })
      } finally {
        checked += 1
        if (activeScanProgress) activeScanProgress.checked = checked
        if (checked % 10 === 0 || checked === sessions.length) {
          updateHealth('referenced-attachments', {
            running: true,
            progressChecked: checked,
            progressTotal: sessions.length,
            protectedFiles: statusFromIndex(index, true).protectedFiles,
          })
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_BACKFILL_CONCURRENCY, sessions.length || 1) }, () => worker()),
  )

  index.previousSessionsChecked = Math.max(index.previousSessionsChecked, checked)
  index.lastScanAt = new Date().toISOString()
  await writeIndex(index)
  updateHealth('referenced-attachments', {
    running: false,
    lastScanAt: index.lastScanAt,
    protectedFiles: statusFromIndex(index).protectedFiles,
    previousSessionsChecked: index.previousSessionsChecked,
    permissionIssueKinds: Object.keys(index.permissionIssues),
  })
  writeAuditEvent('referenced-attachments', 'scan_completed', {
    reason,
    protectedFiles: statusFromIndex(index).protectedFiles,
    previousSessionsChecked: index.previousSessionsChecked,
  })
  return statusFromIndex(index)
}

async function backUpRawRecordReferences(
  index: ReferencedAttachmentIndex,
  source: Source,
  sessionUid: string,
  records: RawRecord[],
): Promise<ReferencedAttachmentIndex> {
  for (const record of records) {
    const text = rawRecordSearchText(record)
    if (!text) continue
    const paths = extractReferencedFilePathsFromText(text)
    for (const filePath of paths) {
      const key = referencedFileKey(source, sessionUid, record.rawHash, filePath)
      if (index.protected[key]) continue
      const result = await tryBackUpReferencedFile(filePath)
      if (result.permissionIssue) {
        index.permissionIssues[result.permissionIssue.kind] = result.permissionIssue
      }
      const saved = result.saved
      if (!saved) continue
      const issueKind = protectedFolderKind(filePath)
      if (issueKind) delete index.permissionIssues[issueKind]
      index.protected[key] = {
        key,
        source,
        sessionUid,
        rawHash: record.rawHash,
        originalPath: filePath,
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        size: saved.size,
        fileModifiedAt: saved.fileModifiedAt,
        capturedAt: new Date().toISOString(),
      }
    }
  }
  return index
}

function rawRecordSearchText(record: RawRecord): string {
  try {
    const text = typeof record.raw === 'string' ? record.raw : JSON.stringify(record.raw)
    if (!text) return ''
    if (text.length <= MAX_REFERENCE_SCAN_CHARS) return text
    return `${text.slice(0, MAX_REFERENCE_SCAN_CHARS / 2)}\n${text.slice(-MAX_REFERENCE_SCAN_CHARS / 2)}`
  } catch {
    return ''
  }
}

function referencedFileKey(source: Source, sessionUid: string, rawHash: string, filePath: string): string {
  return crypto
    .createHash('sha256')
    .update(`${source}\0${sessionUid}\0${rawHash}\0${normalizeKeyPath(filePath)}`)
    .digest('hex')
}

function normalizeKeyPath(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath
}

async function tryBackUpReferencedFile(filePath: string): Promise<{
  saved: {
    attachmentId: string
    mediaType: string
    size: number
    fileModifiedAt: string | null
  } | null
  permissionIssue: PermissionIssueRecord | null
}> {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return { saved: null, permissionIssue: null }
    if (stat.size <= 0 || stat.size > MAX_REFERENCED_FILE_BYTES) return { saved: null, permissionIssue: null }
    const mediaType = mediaTypeForPath(filePath)
    const data = fs.readFileSync(filePath)
    const attachmentId = await saveAttachment(data.toString('base64'), mediaType)
    return {
      saved: {
        attachmentId,
        mediaType,
        size: stat.size,
        fileModifiedAt: Number.isFinite(stat.mtimeMs) ? stat.mtime.toISOString() : null,
      },
      permissionIssue: null,
    }
  } catch (error) {
    const permissionIssue = permissionIssueForPath(filePath, error)
    writeLog('info', 'referenced-attachments', 'referenced_file_not_copied', {
      pathHash: crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16),
      error: safeError(error),
      permissionKind: permissionIssue?.kind,
    })
    return { saved: null, permissionIssue }
  }
}

function permissionIssueForPath(filePath: string, error: unknown): PermissionIssueRecord | null {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null
  if (code !== 'EACCES' && code !== 'EPERM') return null
  const kind = protectedFolderKind(filePath)
  if (!kind) return null
  return {
    kind,
    label: protectedFolderLabel(kind),
    lastSeenAt: new Date().toISOString(),
  }
}

function protectedFolderKind(filePath: string): string | null {
  const normalizedRaw = filePath.replace(/\\/g, '/')
  const normalized = process.platform === 'win32' ? normalizedRaw.toLowerCase() : normalizedRaw
  for (const [kind, root] of protectedFolderRoots()) {
    const rootRaw = root.replace(/\\/g, '/')
    const normalizedRoot = process.platform === 'win32' ? rootRaw.toLowerCase() : rootRaw
    if (normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`)) return kind
  }
  return null
}

function protectedFolderRoots(): Array<[string, string]> {
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/')
  if (!home) return []
  const roots: Array<[string, string]> = [
    ['downloads', `${home}/Downloads`],
    ['desktop', `${home}/Desktop`],
    ['documents', `${home}/Documents`],
  ]
  if (process.platform === 'darwin') {
    roots.push(
      ['icloud-drive', `${home}/Library/Mobile Documents`],
      ['cloud-storage', `${home}/Library/CloudStorage`],
    )
  }
  if (process.platform === 'win32') {
    roots.push(
      ['pictures', `${home}/Pictures`],
      ['onedrive', `${home}/OneDrive`],
    )
  }
  return roots
}

function protectedFolderRoot(kind: string): string | null {
  return protectedFolderRoots().find(([candidate]) => candidate === kind)?.[1] || null
}

function clearResolvedPermissionIssues(index: ReferencedAttachmentIndex): boolean {
  let changed = false
  for (const kind of Object.keys(index.permissionIssues)) {
    if (protectedFolderAccessAvailable(kind)) {
      delete index.permissionIssues[kind]
      changed = true
    }
  }
  return changed
}

function protectedFolderAccessAvailable(kind: string): boolean {
  const root = protectedFolderRoot(kind)
  if (!root) return false
  if (!fs.existsSync(root)) return true
  try {
    fs.accessSync(root, fs.constants.R_OK)
    const stat = fs.statSync(root)
    if (stat.isDirectory()) {
      const dir = fs.opendirSync(root)
      try { dir.readSync() } finally { dir.closeSync() }
    }
    return true
  } catch {
    return false
  }
}

function protectedFolderLabelForPath(filePath: string): string {
  const kind = protectedFolderKind(filePath)
  if (kind) return protectedFolderLabel(kind)
  const dir = path.dirname(filePath).replace(/\\/g, '/')
  const home = (process.env.HOME || process.env.USERPROFILE || '').replace(/\\/g, '/')
  if (home && (dir === home || dir.startsWith(`${home}/`))) {
    const relative = dir.slice(home.length).replace(/^\/+/, '')
    const first = relative.split('/').filter(Boolean)[0]
    return first || 'Home'
  }
  return process.platform === 'win32'
    ? path.win32.parse(filePath).root || 'Other folders'
    : 'Other folders'
}

function protectedFolderLabel(kind: string): string {
  switch (kind) {
    case 'downloads': return 'Downloads'
    case 'desktop': return 'Desktop'
    case 'documents': return 'Documents'
    case 'icloud-drive': return 'iCloud Drive'
    case 'cloud-storage': return 'Cloud Storage'
    case 'pictures': return 'Pictures'
    case 'onedrive': return 'OneDrive'
    default: return kind
  }
}

function mediaTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

export function extractReferencedFilePathsFromText(
  text: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!text) return []
  const input = text.length <= MAX_REFERENCE_SCAN_CHARS
    ? text
    : `${text.slice(0, MAX_REFERENCE_SCAN_CHARS / 2)}\n${text.slice(-MAX_REFERENCE_SCAN_CHARS / 2)}`
  const out: string[] = []
  const seen = new Set<string>()

  for (const candidate of referencedPathCandidates(input)) {
    if (out.length >= MAX_REFERENCES_PER_TEXT) break
    const normalized = normalizeReferencedPath(candidate, platform)
    if (!normalized) continue
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }

  return out
}

function referencedPathCandidates(text: string): string[] {
  const candidates: string[] = []
  const patterns = [
    new RegExp(`\\[[^\\]\\n]{0,200}]\\((file:\\/\\/\\/[^)\\n]+?\\.${EXT_PATTERN}|\\/[^)\\n]+?\\.${EXT_PATTERN}|[A-Za-z]:[\\\\/][^)\\n]+?\\.${EXT_PATTERN}|\\\\\\\\[^)\\n]+?\\.${EXT_PATTERN})\\)`, 'gi'),
    new RegExp(`[\\\`"'](file:\\/\\/\\/[^"'\\\`\\n]+?\\.${EXT_PATTERN}|\\/[^"'\\\`\\n]+?\\.${EXT_PATTERN}|[A-Za-z]:[\\\\/][^"'\\\`\\n]+?\\.${EXT_PATTERN}|\\\\\\\\[^"'\\\`\\n]+?\\.${EXT_PATTERN})[\\\`"']`, 'gi'),
    new RegExp(`(?:^|[\\s:])(file:\\/\\/\\/[^\\s"'\\\`<>)\\]]+?\\.${EXT_PATTERN})(?=$|[\\s"'\\\`<>)\\]])`, 'gi'),
    new RegExp(`(?:^|[\\s:])(\\/(?:Users|home|tmp|var|private|Volumes|mnt|media|root|opt)[^"'\\\`<>\\n]{1,${MAX_REFERENCE_SCAN_CHARS}}?\\.${EXT_PATTERN})(?=$|[\\s"'\\\`<>)\\]])`, 'gi'),
    new RegExp(`(?:^|[\\s:])([A-Za-z]:[\\\\/][^"'\\\`<>\\n]{1,${MAX_REFERENCE_SCAN_CHARS}}?\\.${EXT_PATTERN})(?=$|[\\s"'\\\`<>)\\]])`, 'gi'),
    new RegExp(`(?:^|[\\s:])(\\/[^\\s"'\\\`<>)\\]]+?\\.${EXT_PATTERN})(?=$|[\\s"'\\\`<>)\\]])`, 'gi'),
    new RegExp(`(?:^|[\\s:])([A-Za-z]:[\\\\/][^\\s"'\\\`<>)\\]]+?\\.${EXT_PATTERN})(?=$|[\\s"'\\\`<>)\\]])`, 'gi'),
    new RegExp(`(?:^|[\\s:])(\\\\\\\\[^\\s"'\\\`<>)\\]]+?\\.${EXT_PATTERN})(?=$|[\\s"'\\\`<>)\\]])`, 'gi'),
  ]

  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      candidates.push(match[1])
    }
  }
  return candidates
}

function normalizeReferencedPath(candidate: string, platform: NodeJS.Platform): string | null {
  let value = candidate.trim()
  value = value.replace(/[.,;!?]+$/g, '')
  if (value.startsWith('file://')) {
    try {
      const url = new URL(value)
      value = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1)
    } catch {
      value = value.slice('file://'.length)
    }
  } else {
    try { value = decodeURIComponent(value) } catch { /* keep original */ }
  }

  value = value.replace(/\\ /g, ' ')
  if (platform === 'win32') {
    if (/^[A-Za-z]:\//.test(value)) value = value.replace(/\//g, '\\')
    if (/^[A-Za-z]:\\/.test(value) || value.startsWith('\\\\')) return path.win32.normalize(value)
    return null
  }

  if (value.startsWith('//')) return null
  if (!value.startsWith('/')) return null
  return path.posix.normalize(value)
}
