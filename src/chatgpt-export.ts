import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { Readable } from 'stream'
import { STATE_DIR } from './config'
import {
  appendMessages,
  appendRawRecords,
  ensureDirs,
  hasVaultSession,
  loadSessions,
  makeVaultPath,
  readRawRecords,
  replaceSessionMessages,
  saveAttachment,
  saveAttachmentFromStream,
  saveSessions,
} from './store'
import type {
  ContentBlock,
  ConversationBranchSummary,
  ConversationGraphSummary,
  Message,
  RawRecord,
  Session,
} from './types'

const CHATGPT_EXPORT_SOURCE = 'chatgpt-export' as const
const CHATGPT_IMPORTS_VERSION = 1
const CHATGPT_IMPORT_JOB_VERSION = 1
const CHATGPT_PARSER_VERSION = 2
const CHATGPT_IMPORTS_FILE = path.join(STATE_DIR, 'chatgpt-export-imports.json')
const CHATGPT_IMPORT_JOB_FILE = path.join(STATE_DIR, 'chatgpt-export-import-job.json')
const MAX_ZIP_ENTRY_COUNT = 100_000
const MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 12 * 1024 * 1024 * 1024
const MAX_ZIP_SINGLE_ENTRY_BYTES = MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES
const LARGE_ASSET_STREAM_THRESHOLD_BYTES = positiveByteLimit(
  process.env.DATAMOAT_CHATGPT_LARGE_ASSET_STREAM_THRESHOLD_BYTES,
  16 * 1024 * 1024,
)
const STRONG_DUPLICATE_MIN_TEXT_CHARS = 200
const STRONG_DUPLICATE_MIN_MESSAGES = 3

function positiveByteLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

type ZipEntry = {
  path: string
  compressedSize: number
  uncompressedSize: number
  method: number
  flags: number
  localHeaderOffset: number
}

type ExportEntry = {
  path: string
  size: number
}

type ChatGptExportReader = {
  kind: 'folder' | 'zip'
  rootPath: string
  listEntries(): ExportEntry[]
  has(relativePath: string): boolean
  readBuffer(relativePath: string): Buffer
  createReadStream(relativePath: string): NodeJS.ReadableStream
  close?(): void
}

type ChatGptManifest = {
  version?: number
  manifest_file?: string
  export_files_count?: number
  logical_files_count?: number
  export_files?: Array<{ path?: string; size_bytes?: number }>
}

type ChatGptConversation = {
  id?: string
  conversation_id?: string
  title?: string
  create_time?: number | null
  update_time?: number | null
  current_node?: string | null
  default_model_slug?: string | null
  mapping?: Record<string, ChatGptNode>
}

type ChatGptNode = {
  id?: string
  parent?: string | null
  message?: ChatGptMessage | null
}

type ChatGptMessage = {
  id?: string
  author?: {
    role?: string | null
    name?: string | null
  }
  content?: Record<string, unknown>
  create_time?: number | null
  metadata?: Record<string, unknown>
}

type AssetFileRecord = {
  datFile: string
  attachmentId: string
  mediaType: string
  attachmentName?: string
  originalPath?: string
  sizeBytes: number
  sha256: string
}

type AssetsJson = Record<string, string[]>
type AssetFileMap = Record<string, AssetFileRecord>

type PreparedConversation = {
  session: Session
  messages: Message[]
  rawRecord: RawRecord
  currentPathFingerprint: string
  rawConversationHash: string
  strongFingerprint: boolean
}

export type ChatGptExportCounts = {
  files: number
  totalBytes: number
  conversations: number
  nodes: number
  currentPathNodes: number
  currentPathMessages: number
  currentPathAttachments: number
  assetFiles: number
  assetReferences: number
  uniqueAssetHashes: number
  duplicateAssetFiles: number
  branchConversations: number
  branchParents: number
  branches: number
  offPathMessages: number
  offPathAttachments: number
  thoughts: number
  unknownContentTypes: Record<string, number>
  mimeTypes: Record<string, number>
}

export type ChatGptExportPreflightResult = {
  ok: boolean
  sourcePath: string
  sourceKind: 'folder' | 'zip'
  status: 'ready' | 'failed'
  format: 'chatgpt-export'
  manifestVersion: number | null
  counts: ChatGptExportCounts
  warnings: string[]
  errors: string[]
  files: {
    manifest: boolean
    conversations: number
    chatHtml: boolean
    assetsJson: boolean
    assetNames: boolean
  }
}

export type ChatGptImportPhase =
  | 'idle'
  | 'preflight'
  | 'reading-export'
  | 'importing-attachments'
  | 'importing-conversations'
  | 'completed'
  | 'failed'

export type ChatGptImportJob = {
  version: typeof CHATGPT_IMPORT_JOB_VERSION
  id: string
  sourcePath: string
  sourceKind: 'folder' | 'zip'
  phase: ChatGptImportPhase
  startedAt: string
  updatedAt: string
  completedAt?: string
  currentConversation?: string
  currentFile?: string
  lastError?: string
  counts: ChatGptExportCounts
  imported: {
    sessions: number
    messages: number
    rawRecords: number
    attachments: number
  }
  updated: {
    sessions: number
    messages: number
  }
  skipped: {
    sessions: number
    messages: number
    duplicates: number
  }
  failed: {
    sessions: number
    attachments: number
  }
  cursor: {
    conversationIndex: number
    attachmentIndex: number
  }
  warnings: string[]
  done: boolean
}

type ChatGptImportedConversationRecord = {
  parserVersion?: number
  sourceAccount?: string
  conversationId: string
  destinationUid: string
  currentPathFingerprint: string
  rawConversationHash: string
  strongFingerprint: boolean
  firstImportedAt: string
  lastImportedAt: string
  lastAction: 'imported' | 'updated' | 'skipped'
}

type ChatGptImportsState = {
  version: typeof CHATGPT_IMPORTS_VERSION
  updatedAt: string
  conversations: Record<string, ChatGptImportedConversationRecord>
  currentPathFingerprints: Record<string, ChatGptImportedConversationRecord>
  rawConversationHashes: Record<string, ChatGptImportedConversationRecord>
  attachmentIds: Record<string, { importedAt: string }>
}

function nowIso(): string {
  return new Date().toISOString()
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
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

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function readJob(): ChatGptImportJob | null {
  return readJsonFile<ChatGptImportJob>(CHATGPT_IMPORT_JOB_FILE)
}

function writeJob(job: ChatGptImportJob): void {
  writePrivateJson(CHATGPT_IMPORT_JOB_FILE, job)
}

function updateJob(job: ChatGptImportJob, patch: Partial<ChatGptImportJob>): ChatGptImportJob {
  const next = { ...job, ...patch, updatedAt: nowIso() }
  writeJob(next)
  return next
}

function defaultImportsState(): ChatGptImportsState {
  return {
    version: CHATGPT_IMPORTS_VERSION,
    updatedAt: nowIso(),
    conversations: {},
    currentPathFingerprints: {},
    rawConversationHashes: {},
    attachmentIds: {},
  }
}

function readImportsState(): ChatGptImportsState {
  const raw = readJsonFile<Partial<ChatGptImportsState>>(CHATGPT_IMPORTS_FILE)
  if (!raw || typeof raw !== 'object') return defaultImportsState()
  return {
    version: CHATGPT_IMPORTS_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    conversations: raw.conversations && typeof raw.conversations === 'object' ? raw.conversations : {},
    currentPathFingerprints: raw.currentPathFingerprints && typeof raw.currentPathFingerprints === 'object' ? raw.currentPathFingerprints : {},
    rawConversationHashes: raw.rawConversationHashes && typeof raw.rawConversationHashes === 'object' ? raw.rawConversationHashes : {},
    attachmentIds: raw.attachmentIds && typeof raw.attachmentIds === 'object' ? raw.attachmentIds : {},
  }
}

function writeImportsState(state: ChatGptImportsState): void {
  writePrivateJson(CHATGPT_IMPORTS_FILE, {
    ...state,
    version: CHATGPT_IMPORTS_VERSION,
    updatedAt: nowIso(),
  })
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function safeZipPath(name: string): string {
  if (name.includes('\0')) throw new Error('zip entry path contains NUL byte')
  const normalized = toPosixPath(name)
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('~')) {
    throw new Error(`unsafe zip entry path: ${name}`)
  }
  if (/^[A-Za-z]:\//.test(normalized)) throw new Error(`unsafe zip entry path: ${name}`)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some(part => part === '..')) throw new Error(`unsafe zip entry path: ${name}`)
  return parts.join('/')
}

function listFolderEntries(root: string): ExportEntry[] {
  const entries: ExportEntry[] = []
  const walk = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (entry.name === '.DS_Store' || entry.name.startsWith('._')) continue
      const absolute = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const relative = toPosixPath(path.relative(root, absolute))
      entries.push({ path: relative, size: fs.statSync(absolute).size })
    }
  }
  walk(root)
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

function folderReader(rootPath: string): ChatGptExportReader {
  const resolved = path.resolve(rootPath)
  const entries = listFolderEntries(resolved)
  const entrySet = new Set(entries.map(entry => entry.path))
  const resolveEntryPath = (relativePath: string): string => {
    const safe = safeZipPath(relativePath)
    if (!entrySet.has(safe)) throw new Error(`export file not found: ${relativePath}`)
    const absolute = path.join(resolved, ...safe.split('/'))
    const normalized = path.resolve(absolute)
    if (!normalized.startsWith(`${resolved}${path.sep}`) && normalized !== resolved) {
      throw new Error(`unsafe export file path: ${relativePath}`)
    }
    return normalized
  }
  return {
    kind: 'folder',
    rootPath: resolved,
    listEntries: () => entries,
    has: relativePath => entrySet.has(toPosixPath(relativePath)),
    readBuffer(relativePath: string): Buffer {
      return fs.readFileSync(resolveEntryPath(relativePath))
    },
    createReadStream(relativePath: string): NodeJS.ReadableStream {
      return fs.createReadStream(resolveEntryPath(relativePath))
    },
  }
}

function readAt(fd: number, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  const bytesRead = fs.readSync(fd, buffer, 0, length, offset)
  if (bytesRead !== length) throw new Error('unexpected end of zip file')
  return buffer
}

function uint64ToSafeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`zip64 ${label} is too large`)
  return Number(value)
}

function zip64ExtraValues(
  extra: Buffer,
  fields: { uncompressed: number; compressed: number; localHeaderOffset: number },
): { uncompressedSize: number; compressedSize: number; localHeaderOffset: number } {
  let uncompressedSize = fields.uncompressed
  let compressedSize = fields.compressed
  let localHeaderOffset = fields.localHeaderOffset
  let cursor = 0
  while (cursor + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(cursor)
    const dataSize = extra.readUInt16LE(cursor + 2)
    const dataStart = cursor + 4
    const dataEnd = dataStart + dataSize
    if (dataEnd > extra.length) break
    if (headerId === 0x0001) {
      let valueCursor = dataStart
      const readZip64Value = (label: string): number => {
        if (valueCursor + 8 > dataEnd) throw new Error(`zip64 extra field is truncated: ${label}`)
        const value = uint64ToSafeNumber(extra.readBigUInt64LE(valueCursor), label)
        valueCursor += 8
        return value
      }
      if (fields.uncompressed === 0xffffffff) uncompressedSize = readZip64Value('uncompressed size')
      if (fields.compressed === 0xffffffff) compressedSize = readZip64Value('compressed size')
      if (fields.localHeaderOffset === 0xffffffff) localHeaderOffset = readZip64Value('local header offset')
      return { uncompressedSize, compressedSize, localHeaderOffset }
    }
    cursor = dataEnd
  }
  if (
    fields.uncompressed === 0xffffffff
    || fields.compressed === 0xffffffff
    || fields.localHeaderOffset === 0xffffffff
  ) {
    throw new Error('zip64 extra field is missing')
  }
  return { uncompressedSize, compressedSize, localHeaderOffset }
}

function zipCentralDirectoryLocation(
  fd: number,
  stat: fs.Stats,
  eocdOffset: number,
  eocd: Buffer,
): { entriesTotal: number; centralSize: number; centralOffset: number } {
  const diskNumber = eocd.readUInt16LE(4)
  const centralDisk = eocd.readUInt16LE(6)
  const entriesThisDisk = eocd.readUInt16LE(8)
  const entriesTotal32 = eocd.readUInt16LE(10)
  const centralSize32 = eocd.readUInt32LE(12)
  const centralOffset32 = eocd.readUInt32LE(16)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesThisDisk !== entriesTotal32) {
    throw new Error('multi-disk zip files are not supported')
  }

  const needsZip64 = entriesTotal32 === 0xffff || centralSize32 === 0xffffffff || centralOffset32 === 0xffffffff
  if (!needsZip64) {
    return {
      entriesTotal: entriesTotal32,
      centralSize: centralSize32,
      centralOffset: centralOffset32,
    }
  }

  if (eocdOffset < 20) throw new Error('zip64 locator is missing')
  const locator = readAt(fd, eocdOffset - 20, 20)
  if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error('zip64 locator is missing')
  const locatorDisk = locator.readUInt32LE(4)
  const zip64EocdOffset = uint64ToSafeNumber(locator.readBigUInt64LE(8), 'end-of-central-directory offset')
  const totalDisks = locator.readUInt32LE(16)
  if (locatorDisk !== 0 || totalDisks !== 1) throw new Error('multi-disk zip files are not supported')
  if (zip64EocdOffset < 0 || zip64EocdOffset + 56 > stat.size) throw new Error('invalid zip64 end-of-central-directory offset')

  const zip64Header = readAt(fd, zip64EocdOffset, 56)
  if (zip64Header.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 end-of-central-directory record not found')
  const zip64Disk = zip64Header.readUInt32LE(16)
  const zip64CentralDisk = zip64Header.readUInt32LE(20)
  const zip64EntriesThisDisk = uint64ToSafeNumber(zip64Header.readBigUInt64LE(24), 'entry count')
  const zip64EntriesTotal = uint64ToSafeNumber(zip64Header.readBigUInt64LE(32), 'entry count')
  if (zip64Disk !== 0 || zip64CentralDisk !== 0 || zip64EntriesThisDisk !== zip64EntriesTotal) {
    throw new Error('multi-disk zip files are not supported')
  }
  return {
    entriesTotal: zip64EntriesTotal,
    centralSize: uint64ToSafeNumber(zip64Header.readBigUInt64LE(40), 'central directory size'),
    centralOffset: uint64ToSafeNumber(zip64Header.readBigUInt64LE(48), 'central directory offset'),
  }
}

function parseZipEntries(zipPath: string, fd: number): Map<string, ZipEntry> {
  const stat = fs.fstatSync(fd)
  const tailLength = Math.min(stat.size, 66_000)
  const tail = readAt(fd, stat.size - tailLength, tailLength)
  let eocdOffset = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = stat.size - tailLength + i
      break
    }
  }
  if (eocdOffset < 0) throw new Error('zip end-of-central-directory record not found')
  const eocd = readAt(fd, eocdOffset, 22)
  const { entriesTotal, centralSize, centralOffset } = zipCentralDirectoryLocation(fd, stat, eocdOffset, eocd)
  if (entriesTotal > MAX_ZIP_ENTRY_COUNT) throw new Error('zip has too many files')
  const central = readAt(fd, centralOffset, centralSize)
  const entries = new Map<string, ZipEntry>()
  let cursor = 0
  let totalUncompressed = 0
  for (let index = 0; index < entriesTotal; index += 1) {
    if (central.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`invalid zip central directory in ${path.basename(zipPath)}`)
    const flags = central.readUInt16LE(cursor + 8)
    const method = central.readUInt16LE(cursor + 10)
    const compressedSize32 = central.readUInt32LE(cursor + 20)
    const uncompressedSize32 = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const localHeaderOffset32 = central.readUInt32LE(cursor + 42)
    const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (name.endsWith('/')) continue
    const { compressedSize, uncompressedSize, localHeaderOffset } = zip64ExtraValues(extra, {
      compressed: compressedSize32,
      uncompressed: uncompressedSize32,
      localHeaderOffset: localHeaderOffset32,
    })
    if (flags & 0x1) throw new Error(`encrypted zip entry is not supported: ${name}`)
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip compression method ${method}: ${name}`)
    if (uncompressedSize > MAX_ZIP_SINGLE_ENTRY_BYTES) throw new Error(`zip entry is too large: ${name}`)
    totalUncompressed += uncompressedSize
    if (totalUncompressed > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES) throw new Error('zip uncompressed size is too large')
    const safe = safeZipPath(name)
    entries.set(safe, { path: safe, compressedSize, uncompressedSize, method, flags, localHeaderOffset })
  }
  return entries
}

function zipEntryDataOffset(fd: number, entry: ZipEntry, relativePath: string): number {
  const local = readAt(fd, entry.localHeaderOffset, 30)
  if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`invalid zip local header: ${relativePath}`)
  const nameLength = local.readUInt16LE(26)
  const extraLength = local.readUInt16LE(28)
  return entry.localHeaderOffset + 30 + nameLength + extraLength
}

function zipReader(zipPath: string): ChatGptExportReader {
  const resolved = path.resolve(zipPath)
  const fd = fs.openSync(resolved, 'r')
  let closed = false
  const entries = parseZipEntries(resolved, fd)
  const list = Array.from(entries.values()).map(entry => ({ path: entry.path, size: entry.uncompressedSize }))
    .sort((a, b) => a.path.localeCompare(b.path))
  return {
    kind: 'zip',
    rootPath: resolved,
    listEntries: () => list,
    has: relativePath => entries.has(toPosixPath(relativePath)),
    readBuffer(relativePath: string): Buffer {
      const safe = safeZipPath(relativePath)
      const entry = entries.get(safe)
      if (!entry) throw new Error(`export file not found: ${relativePath}`)
      const dataOffset = zipEntryDataOffset(fd, entry, relativePath)
      const compressed = readAt(fd, dataOffset, entry.compressedSize)
      const data = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed)
      if (data.length !== entry.uncompressedSize) throw new Error(`zip entry size mismatch: ${relativePath}`)
      return data
    },
    createReadStream(relativePath: string): NodeJS.ReadableStream {
      const safe = safeZipPath(relativePath)
      const entry = entries.get(safe)
      if (!entry) throw new Error(`export file not found: ${relativePath}`)
      if (entry.compressedSize === 0) return Readable.from([])
      const dataOffset = zipEntryDataOffset(fd, entry, relativePath)
      const compressed = fs.createReadStream(resolved, {
        start: dataOffset,
        end: dataOffset + entry.compressedSize - 1,
      })
      return entry.method === 0 ? compressed : compressed.pipe(zlib.createInflateRaw())
    },
    close() {
      if (closed) return
      closed = true
      fs.closeSync(fd)
    },
  }
}

function openExportReader(sourcePath: string): ChatGptExportReader {
  const resolved = path.resolve(sourcePath)
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) return folderReader(resolved)
  if (!stat.isFile()) throw new Error('ChatGPT export path must be a zip file or extracted folder')
  const fd = fs.openSync(resolved, 'r')
  try {
    const signature = readAt(fd, 0, Math.min(4, stat.size))
    if (signature.length < 4 || signature.readUInt32LE(0) !== 0x04034b50) {
      throw new Error('ChatGPT export file must be a .zip file')
    }
  } finally {
    fs.closeSync(fd)
  }
  return zipReader(resolved)
}

function readJsonFromExport<T>(reader: ChatGptExportReader, relativePath: string, fallback: T): T {
  if (!reader.has(relativePath)) return fallback
  return JSON.parse(reader.readBuffer(relativePath).toString('utf8')) as T
}

function emptyCounts(entries: ExportEntry[]): ChatGptExportCounts {
  return {
    files: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    conversations: 0,
    nodes: 0,
    currentPathNodes: 0,
    currentPathMessages: 0,
    currentPathAttachments: 0,
    assetFiles: 0,
    assetReferences: 0,
    uniqueAssetHashes: 0,
    duplicateAssetFiles: 0,
    branchConversations: 0,
    branchParents: 0,
    branches: 0,
    offPathMessages: 0,
    offPathAttachments: 0,
    thoughts: 0,
    unknownContentTypes: {},
    mimeTypes: {},
  }
}

function extractJsonObjectAfter(text: string, marker: string): unknown | null {
  const markerIndex = text.indexOf(marker)
  if (markerIndex < 0) return null
  const start = text.indexOf('{', markerIndex)
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, index + 1))
    }
  }
  return null
}

function readAssetsJson(reader: ChatGptExportReader, warnings: string[]): AssetsJson {
  if (!reader.has('chat.html')) return {}
  const html = reader.readBuffer('chat.html').toString('utf8')
  try {
    const parsed = extractJsonObjectAfter(html, 'var assetsJson = ')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: AssetsJson = {}
    for (const [messageId, files] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(files)) continue
      out[messageId] = files.filter((file): file is string => typeof file === 'string')
        .map(file => toPosixPath(file))
    }
    return out
  } catch (error) {
    warnings.push(`Could not parse chat.html asset index: ${safeError(error)}`)
    return {}
  }
}

function loadConversations(reader: ChatGptExportReader): Array<{ file: string; conversation: ChatGptConversation }> {
  const files = reader.listEntries()
    .map(entry => entry.path)
    .filter(file => /^conversations-\d+\.json$/.test(file))
    .sort()
  const out: Array<{ file: string; conversation: ChatGptConversation }> = []
  for (const file of files) {
    const parsed = JSON.parse(reader.readBuffer(file).toString('utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error(`${file} is not a ChatGPT conversations array`)
    for (const conversation of parsed) {
      if (conversation && typeof conversation === 'object') {
        out.push({ file, conversation: conversation as ChatGptConversation })
      }
    }
  }
  return out
}

function currentPathIds(conversation: ChatGptConversation): string[] {
  const mapping = conversation.mapping ?? {}
  const ids: string[] = []
  const seen = new Set<string>()
  let id = typeof conversation.current_node === 'string' ? conversation.current_node : ''
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id)
    ids.push(id)
    id = typeof mapping[id].parent === 'string' ? mapping[id].parent || '' : ''
  }
  return ids.reverse()
}

function childrenByParent(conversation: ChatGptConversation): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [id, node] of Object.entries(conversation.mapping ?? {})) {
    if (!node.parent) continue
    const children = out.get(node.parent) ?? []
    children.push(id)
    out.set(node.parent, children)
  }
  return out
}

function chatGptRole(role: string | null | undefined): Message['role'] {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') return role
  return 'assistant'
}

function isoFromChatGptTime(value: unknown, fallback?: string): string {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString()
  }
  return fallback ?? new Date(0).toISOString()
}

function pushText(blocks: ContentBlock[], text: unknown): void {
  if (typeof text !== 'string') return
  const trimmed = text.trim()
  if (!trimmed) return
  const previous = blocks[blocks.length - 1]
  if (previous?.type === 'text' && typeof previous.text === 'string') {
    previous.text = `${previous.text}\n${trimmed}`
  } else {
    blocks.push({ type: 'text', text: trimmed })
  }
}

function stringifyCompact(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function contentText(content: Record<string, unknown> | undefined): string {
  if (!content) return ''
  const blocks: ContentBlock[] = []
  collectContentBlocks(content, blocks, undefined, {})
  return blocks.map(block => block.text || block.thinking || stringifyCompact(block.content)).filter(Boolean).join('\n')
}

function thoughtText(content: Record<string, unknown>): string {
  const thoughts = content.thoughts
  const parts: string[] = []
  if (Array.isArray(thoughts)) {
    for (const thought of thoughts) {
      if (!thought || typeof thought !== 'object') continue
      const record = thought as Record<string, unknown>
      if (typeof record.content === 'string') parts.push(record.content)
      if (typeof record.summary === 'string') parts.push(record.summary)
      if (Array.isArray(record.chunks)) parts.push(...record.chunks.filter((chunk): chunk is string => typeof chunk === 'string'))
    }
  }
  if (typeof content.text === 'string') parts.push(content.text)
  return parts.map(part => part.trim()).filter(Boolean).join('\n')
}

function collectContentBlocks(
  content: Record<string, unknown> | undefined,
  blocks: ContentBlock[],
  role: Message['role'] | undefined,
  rawMessage: Record<string, unknown>,
): void {
  if (!content) return
  const contentType = typeof content.content_type === 'string' ? content.content_type : ''
  if (contentType === 'text' || contentType === 'multimodal_text') {
    const parts = content.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part === 'string') {
          pushText(blocks, part)
        } else if (part && typeof part === 'object') {
          const item = part as Record<string, unknown>
          if (typeof item.text === 'string') pushText(blocks, item.text)
          else if (typeof item.content === 'string') pushText(blocks, item.content)
          else if (typeof item.name === 'string' && item.content_type === 'text') pushText(blocks, item.name)
        }
      }
    }
    if (typeof content.text === 'string') pushText(blocks, content.text)
    return
  }
  if (contentType === 'thoughts' || contentType === 'reasoning_recap') {
    const thinking = thoughtText(content)
    if (thinking) blocks.push({ type: 'thinking', thinking })
    return
  }
  if (contentType === 'code') {
    const codeText = codeContentText(content)
    const parsedInput = parseJsonish(codeText)
    const authorName = authorNameFromRawMessage(rawMessage)
    if (parsedInput !== undefined || (authorName && authorName !== 'assistant')) {
      blocks.push({
        type: 'tool_use',
        name: inferChatGptToolName(authorName, parsedInput),
        input: parsedInput ?? codeText,
        text: codeText,
      })
    } else {
      pushText(blocks, codeText)
    }
    return
  }
  if (contentType === 'execution_output' || contentType === 'computer_output' || contentType === 'tether_browsing_display') {
    const output = content.result ?? content.text ?? content.output ?? content
    blocks.push({
      type: 'tool_result',
      name: contentType,
      content,
      text: typeof output === 'string' ? output : stringifyCompact(output),
    })
    return
  }
  if (contentType === 'user_editable_context') {
    pushText(blocks, content.text ?? stringifyCompact(content))
    return
  }
  const fallback = contentTextFallback(content, rawMessage)
  if (fallback) {
    blocks.push({
      type: role === 'tool' ? 'tool_result' : 'other',
      content,
      text: fallback,
    })
  }
}

function codeContentText(content: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof content.text === 'string') parts.push(content.text)
  if (Array.isArray(content.parts)) {
    parts.push(...content.parts.filter((part): part is string => typeof part === 'string'))
  }
  return parts.map(part => part.trim()).filter(Boolean).join('\n')
}

function parseJsonish(value: string): unknown {
  const trimmed = String(value || '').trim()
  if (!trimmed || !/^[\[{]/.test(trimmed)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function authorNameFromRawMessage(rawMessage: Record<string, unknown>): string {
  const author = rawMessage.author
  if (!author || typeof author !== 'object') return ''
  const name = (author as Record<string, unknown>).name
  return typeof name === 'string' ? name.trim() : ''
}

function inferChatGptToolName(authorName: string, input: unknown): string {
  const normalizedAuthor = authorName.trim()
  if (normalizedAuthor && normalizedAuthor !== 'assistant') return normalizedAuthor
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    if (Array.isArray(record.queries) || record.source_filter) return 'file_search'
    if (typeof record.query === 'string') return 'search'
  }
  return 'chatgpt_tool'
}

function contentTextFallback(content: Record<string, unknown>, rawMessage: Record<string, unknown>): string {
  if (typeof content.text === 'string') return content.text.trim()
  if (typeof content.result === 'string') return content.result.trim()
  if (Array.isArray(content.parts)) {
    const text = content.parts.map(part => typeof part === 'string' ? part : '').filter(Boolean).join('\n').trim()
    if (text) return text
  }
  const compact = stringifyCompact(rawMessage)
  return compact === '{}' ? '' : compact
}

function originalAttachmentName(originalPath: string | undefined, fallback: string): string {
  const value = String(originalPath || '').replace(/\\/g, '/')
  const last = value.split('/').filter(Boolean).pop()
  return last || fallback
}

function appendAssetBlocks(blocks: ContentBlock[], messageId: string, assetsJson: AssetsJson, assetFiles: AssetFileMap): number {
  const files = assetsJson[messageId] ?? []
  let count = 0
  const seen = new Set<string>()
  for (const file of files) {
    const asset = assetFiles[file]
    if (!asset || seen.has(asset.attachmentId)) continue
    seen.add(asset.attachmentId)
    count += 1
    blocks.push({
      type: asset.mediaType.startsWith('image/') ? 'image' : 'file',
      attachmentId: asset.attachmentId,
      mediaType: asset.mediaType,
      attachmentName: asset.attachmentName,
      text: asset.attachmentName,
    })
  }
  return count
}

function messageFromNode(
  conversation: ChatGptConversation,
  nodeId: string,
  assetsJson: AssetsJson,
  assetFiles: AssetFileMap,
): Message | null {
  const node = conversation.mapping?.[nodeId]
  const sourceMessage = node?.message
  if (!sourceMessage) return null
  const role = chatGptRole(sourceMessage.author?.role)
  const blocks: ContentBlock[] = []
  collectContentBlocks(sourceMessage.content, blocks, role, sourceMessage as unknown as Record<string, unknown>)
  appendAssetBlocks(blocks, sourceMessage.id || nodeId, assetsJson, assetFiles)
  if (blocks.length === 0) return null
  const timestamp = isoFromChatGptTime(sourceMessage.create_time, isoFromChatGptTime(conversation.create_time))
  const contentType = typeof sourceMessage.content?.content_type === 'string' ? sourceMessage.content.content_type : undefined
  const model = typeof sourceMessage.metadata?.model_slug === 'string'
    ? sourceMessage.metadata.model_slug
    : typeof conversation.default_model_slug === 'string'
      ? conversation.default_model_slug
      : undefined
  return {
    id: sourceMessage.id || nodeId,
    role,
    timestamp,
    content: blocks,
    hasThinking: blocks.some(block => block.type === 'thinking'),
    sourceEventType: contentType ? `chatgpt.${contentType}` : 'chatgpt.message',
    model,
    unknownAttrs: {
      chatgptNodeId: nodeId,
      chatgptParentId: node?.parent ?? null,
      chatgptAuthorName: sourceMessage.author?.name ?? null,
      chatgptMetadata: sourceMessage.metadata ?? {},
    },
  }
}

function renderableMessageCount(conversation: ChatGptConversation, ids: string[], assetsJson: AssetsJson): number {
  let count = 0
  for (const id of ids) {
    const message = conversation.mapping?.[id]?.message
    if (!message) continue
    if (contentText(message.content).trim() || (assetsJson[message.id || id]?.length ?? 0) > 0) count += 1
  }
  return count
}

function subtreeIds(startId: string, children: Map<string, string[]>): string[] {
  const out: string[] = []
  const stack = [startId]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    for (const child of children.get(id) ?? []) stack.push(child)
  }
  return out
}

function bestLeafPath(startId: string, conversation: ChatGptConversation, children: Map<string, string[]>, assetsJson: AssetsJson): string[] {
  const candidates: string[][] = []
  const walk = (id: string, prefix: string[]): void => {
    const next = children.get(id) ?? []
    if (next.length === 0) {
      candidates.push([...prefix, id])
      return
    }
    for (const child of next) walk(child, [...prefix, id])
  }
  walk(startId, [])
  if (candidates.length === 0) return [startId]
  return candidates.sort((a, b) => renderableMessageCount(conversation, b, assetsJson) - renderableMessageCount(conversation, a, assetsJson))[0]
}

function attachmentCountForIds(conversation: ChatGptConversation, ids: string[], assetsJson: AssetsJson): number {
  let count = 0
  for (const id of ids) {
    const messageId = conversation.mapping?.[id]?.message?.id || id
    count += assetsJson[messageId]?.length ?? 0
  }
  return count
}

function timestampRange(conversation: ChatGptConversation, ids: string[]): { first: string | null; last: string | null } {
  const values = ids
    .map(id => conversation.mapping?.[id]?.message?.create_time)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b)
  return {
    first: values.length > 0 ? new Date(values[0] * 1000).toISOString() : null,
    last: values.length > 0 ? new Date(values[values.length - 1] * 1000).toISOString() : null,
  }
}

function buildGraphSummary(conversation: ChatGptConversation, assetsJson: AssetsJson): ConversationGraphSummary {
  const mapping = conversation.mapping ?? {}
  const currentIds = currentPathIds(conversation)
  const currentSet = new Set(currentIds)
  const children = childrenByParent(conversation)
  let branchParentCount = 0
  let offPathMessageCount = 0
  let offPathAttachmentCount = 0
  const branches: ConversationBranchSummary[] = []
  for (const [parentId, childIds] of children) {
    if (childIds.length < 2) continue
    branchParentCount += 1
    for (const childId of childIds) {
      if (currentSet.has(childId)) continue
      const subtree = subtreeIds(childId, children)
      const pathIds = bestLeafPath(childId, conversation, children, assetsJson)
      const messageCount = renderableMessageCount(conversation, subtree, assetsJson)
      const pathMessageCount = renderableMessageCount(conversation, pathIds, assetsJson)
      const attachments = attachmentCountForIds(conversation, subtree, assetsJson)
      const range = timestampRange(conversation, subtree)
      offPathMessageCount += messageCount
      offPathAttachmentCount += attachments
      branches.push({
        id: `${parentId}>${childId}`,
        label: `Branch ${branches.length + 1}`,
        parentMessageId: mapping[parentId]?.message?.id || parentId || null,
        startMessageId: mapping[childId]?.message?.id || childId,
        leafMessageId: mapping[pathIds[pathIds.length - 1]]?.message?.id || pathIds[pathIds.length - 1] || null,
        messageCount,
        pathMessageCount,
        attachmentCount: attachments,
        firstTimestamp: range.first,
        lastTimestamp: range.last,
        role: mapping[childId]?.message?.author?.role || undefined,
      })
    }
  }
  return {
    kind: 'chatgpt-tree',
    currentPathMessageCount: renderableMessageCount(conversation, currentIds, assetsJson),
    totalNodeCount: Object.keys(mapping).length,
    branchParentCount,
    branchCount: branches.length,
    offPathMessageCount,
    offPathAttachmentCount,
    branches,
  }
}

function mediaTypeFromName(name: string): string | null {
  const lower = String(name || '').toLowerCase()
  if (/\.(mp4|m4v)$/i.test(lower)) return 'video/mp4'
  if (/\.(mov|qt)$/i.test(lower)) return 'video/quicktime'
  if (/\.webm$/i.test(lower)) return 'video/webm'
  if (/\.mp3$/i.test(lower)) return 'audio/mpeg'
  if (/\.wav$/i.test(lower)) return 'audio/wav'
  if (/\.zip$/i.test(lower)) return 'application/zip'
  if (/\.md$/i.test(lower)) return 'text/markdown'
  if (/\.csv$/i.test(lower)) return 'text/csv'
  if (/\.json$/i.test(lower)) return 'application/json'
  if (/\.tex$/i.test(lower)) return 'text/x-tex'
  return null
}

function sniffMediaType(buffer: Buffer, fallbackName = ''): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return /\.mov$/i.test(fallbackName) ? 'video/quicktime' : 'video/mp4'
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm'
  const named = mediaTypeFromName(fallbackName)
  if (named) return named
  const prefix = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trimStart().toLowerCase()
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) return 'text/html'
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  if (sample.length > 0) {
    let printable = 0
    for (const byte of sample) {
      if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 0xc2) printable += 1
    }
    if (printable / sample.length > 0.85) return 'text/plain'
  }
  return 'application/octet-stream'
}

function loadAssetNames(reader: ChatGptExportReader): Record<string, string> {
  return readJsonFromExport<Record<string, string>>(reader, 'conversation_asset_file_names.json', {})
}

function assetMessageReferences(assetsJson: AssetsJson): number {
  return Object.values(assetsJson).reduce((sum, files) => sum + files.length, 0)
}

async function readStreamSample(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const rawChunk of stream as AsyncIterable<Buffer | string>) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    if (bytes < maxBytes) {
      const needed = Math.min(maxBytes - bytes, chunk.length)
      chunks.push(chunk.subarray(0, needed))
      bytes += needed
    }
    if (bytes >= maxBytes) break
  }
  const destroyable = stream as unknown as { destroy?: () => void }
  if (typeof destroyable.destroy === 'function') {
    destroyable.destroy()
  }
  return Buffer.concat(chunks)
}

async function analyzeAssetEntry(
  reader: ChatGptExportReader,
  entry: ExportEntry,
  fallbackName: string,
): Promise<{ mediaType: string; sha256: string }> {
  if (entry.size <= LARGE_ASSET_STREAM_THRESHOLD_BYTES) {
    const buffer = reader.readBuffer(entry.path)
    return {
      mediaType: sniffMediaType(buffer, fallbackName),
      sha256: sha256Hex(buffer),
    }
  }

  const hash = crypto.createHash('sha256')
  const sampleChunks: Buffer[] = []
  let sampleBytes = 0
  await new Promise<void>((resolve, reject) => {
    const stream = reader.createReadStream(entry.path)
    stream.on('data', rawChunk => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      hash.update(chunk)
      if (sampleBytes < 4096) {
        const needed = Math.min(4096 - sampleBytes, chunk.length)
        sampleChunks.push(chunk.subarray(0, needed))
        sampleBytes += needed
      }
    })
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return {
    mediaType: sniffMediaType(Buffer.concat(sampleChunks), fallbackName),
    sha256: hash.digest('hex'),
  }
}

async function summarizeExport(
  reader: ChatGptExportReader,
  manifest: ChatGptManifest | null,
  conversations: Array<{ file: string; conversation: ChatGptConversation }>,
  assetsJson: AssetsJson,
  assetNames: Record<string, string>,
): Promise<ChatGptExportCounts> {
  const entries = reader.listEntries()
  const counts = emptyCounts(entries)
  counts.conversations = conversations.length
  counts.assetFiles = entries.filter(entry => entry.path.endsWith('.dat')).length
  counts.assetReferences = assetMessageReferences(assetsJson)
  const hashes = new Map<string, number>()
  for (const entry of entries.filter(item => item.path.endsWith('.dat'))) {
    const analyzed = await analyzeAssetEntry(reader, entry, assetNames[entry.path] || entry.path)
    const mediaType = analyzed.mediaType
    counts.mimeTypes[mediaType] = (counts.mimeTypes[mediaType] || 0) + 1
    hashes.set(analyzed.sha256, (hashes.get(analyzed.sha256) || 0) + 1)
  }
  counts.uniqueAssetHashes = hashes.size
  counts.duplicateAssetFiles = Array.from(hashes.values()).reduce((sum, value) => sum + Math.max(0, value - 1), 0)
  for (const { conversation } of conversations) {
    const mapping = conversation.mapping ?? {}
    const currentIds = currentPathIds(conversation)
    const currentSet = new Set(currentIds)
    const graph = buildGraphSummary(conversation, assetsJson)
    counts.nodes += Object.keys(mapping).length
    counts.currentPathNodes += currentIds.length
    counts.currentPathMessages += graph.currentPathMessageCount ?? 0
    counts.currentPathAttachments += attachmentCountForIds(conversation, currentIds, assetsJson)
    counts.branchParents += graph.branchParentCount ?? 0
    counts.branches += graph.branchCount ?? 0
    counts.offPathMessages += graph.offPathMessageCount ?? 0
    counts.offPathAttachments += graph.offPathAttachmentCount ?? 0
    if ((graph.branchCount ?? 0) > 0) counts.branchConversations += 1
    for (const [id, node] of Object.entries(mapping)) {
      const contentType = typeof node.message?.content?.content_type === 'string' ? node.message.content.content_type : ''
      if (contentType === 'thoughts' || contentType === 'reasoning_recap') counts.thoughts += 1
      if (contentType && !['text', 'multimodal_text', 'thoughts', 'reasoning_recap', 'code', 'execution_output', 'tether_browsing_display', 'computer_output', 'user_editable_context', 'system_error'].includes(contentType)) {
        counts.unknownContentTypes[contentType] = (counts.unknownContentTypes[contentType] || 0) + 1
      }
      if (!currentSet.has(id) && node.message) {
        // off-path renderable counting is computed in graph; this loop tracks unknown content only.
      }
    }
  }
  if (manifest?.export_files_count && manifest.export_files_count !== counts.files) {
    // Kept in warnings by preflight; counts stay based on the actual export reader.
  }
  return counts
}

export async function preflightChatGptExport(sourcePath: string): Promise<ChatGptExportPreflightResult> {
  const warnings: string[] = []
  const errors: string[] = []
  let reader: ChatGptExportReader | null = null
  try {
    reader = openExportReader(sourcePath)
    const entries = reader.listEntries()
    const manifest = reader.has('export_manifest.json')
      ? readJsonFromExport<ChatGptManifest>(reader, 'export_manifest.json', {})
      : null
    const assetsJson = readAssetsJson(reader, warnings)
    const assetNames = loadAssetNames(reader)
    const conversations = loadConversations(reader)
    if (!manifest) warnings.push('export_manifest.json is missing; DataMoat will use structural detection')
    if (manifest?.version !== undefined && manifest.version !== 1) warnings.push(`ChatGPT export manifest version ${manifest.version} is unverified; raw data will still be preserved`)
    if (manifest?.export_files_count && manifest.export_files_count !== entries.length) warnings.push(`Manifest lists ${manifest.export_files_count} files, but DataMoat found ${entries.length}`)
    if (conversations.length === 0) errors.push('No conversations-*.json files were found')
    const counts = await summarizeExport(reader, manifest, conversations, assetsJson, assetNames)
    if (counts.branches > 0) warnings.push(`${counts.branchConversations} conversations contain alternate branches; the main path and branch index will both be imported`)
    if (counts.duplicateAssetFiles > 0) warnings.push(`${counts.duplicateAssetFiles} asset files have duplicate bytes and will be deduplicated in the vault`)
    return {
      ok: errors.length === 0,
      sourcePath: path.resolve(sourcePath),
      sourceKind: reader.kind,
      status: errors.length === 0 ? 'ready' : 'failed',
      format: 'chatgpt-export',
      manifestVersion: typeof manifest?.version === 'number' ? manifest.version : null,
      counts,
      warnings,
      errors,
      files: {
        manifest: reader.has('export_manifest.json'),
        conversations: entries.filter(entry => /^conversations-\d+\.json$/.test(entry.path)).length,
        chatHtml: reader.has('chat.html'),
        assetsJson: Object.keys(assetsJson).length > 0,
        assetNames: reader.has('conversation_asset_file_names.json'),
      },
    }
  } catch (error) {
    errors.push(safeError(error))
    const entries = reader?.listEntries() ?? []
    return {
      ok: false,
      sourcePath: path.resolve(sourcePath),
      sourceKind: reader?.kind ?? (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory() ? 'folder' : 'zip'),
      status: 'failed',
      format: 'chatgpt-export',
      manifestVersion: null,
      counts: emptyCounts(entries),
      warnings,
      errors,
      files: {
        manifest: !!reader?.has('export_manifest.json'),
        conversations: entries.filter(entry => /^conversations-\d+\.json$/.test(entry.path)).length,
        chatHtml: !!reader?.has('chat.html'),
        assetsJson: false,
        assetNames: !!reader?.has('conversation_asset_file_names.json'),
      },
    }
  } finally {
    reader?.close?.()
  }
}

function userHash(reader: ChatGptExportReader): string | undefined {
  if (!reader.has('user.json')) return undefined
  try {
    const raw = reader.readBuffer('user.json').toString('utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const candidate = String(parsed.id || parsed.email || parsed.user_id || raw).trim()
    return `chatgpt:${sha256Hex(candidate).slice(0, 12)}`
  } catch {
    return undefined
  }
}

function stableSessionUid(sourceAccount: string | undefined, conversationId: string): string {
  return sha256Hex(`${CHATGPT_EXPORT_SOURCE}\0${sourceAccount ?? ''}\0${conversationId}`).slice(0, 24)
}

function explicitConversationId(conversation: ChatGptConversation): string {
  return String(conversation.conversation_id || conversation.id || '').trim()
}

function fallbackConversationId(conversation: ChatGptConversation, rawConversationHash: string): string {
  const title = String(conversation.title || '').trim()
  const created = String(conversation.create_time || '').trim()
  const titleHash = sha256Hex(`${title}\0${created}\0${rawConversationHash}`).slice(0, 10)
  return `missing-id-${titleHash}-${rawConversationHash.slice(0, 16)}`
}

function currentPathFingerprint(messages: Message[]): { hash: string; strong: boolean; textChars: number } {
  let textChars = 0
  const normalized = messages.map(message => {
    const content = message.content.map(block => {
      if (block.type === 'text') {
        const text = String(block.text || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
        textChars += text.length
        return { type: block.type, text }
      }
      if (block.type === 'thinking') {
        const text = String(block.thinking || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
        textChars += text.length
        return { type: block.type, thinking: text }
      }
      return {
        type: block.type,
        attachmentId: block.attachmentId,
        mediaType: block.mediaType,
        name: block.name,
        text: String(block.text || '').normalize('NFKC').replace(/\s+/g, ' ').trim(),
      }
    })
    return { role: message.role, content }
  })
  const hasAttachment = messages.some(message => message.content.some(block => !!block.attachmentId))
  return {
    hash: sha256Hex(JSON.stringify(normalized)),
    strong: hasAttachment || messages.length >= STRONG_DUPLICATE_MIN_MESSAGES || textChars >= STRONG_DUPLICATE_MIN_TEXT_CHARS,
    textChars,
  }
}

async function importAssets(
  reader: ChatGptExportReader,
  assetsJson: AssetsJson,
  assetNames: Record<string, string>,
  job: ChatGptImportJob,
  importsState: ChatGptImportsState,
): Promise<{ assetFiles: AssetFileMap; job: ChatGptImportJob }> {
  const entriesByPath = new Map(reader.listEntries().map(entry => [entry.path, entry]))
  const files = Array.from(entriesByPath.keys()).filter(file => file.endsWith('.dat')).sort()
  const assetFiles: AssetFileMap = {}
  let nextJob = updateJob(job, {
    phase: 'importing-attachments',
    cursor: { ...job.cursor, attachmentIndex: 0 },
  })
  for (let index = 0; index < files.length; index += 1) {
    const datFile = files[index]
    nextJob.cursor.attachmentIndex = index
    nextJob.currentFile = datFile
    writeJob(nextJob)
    try {
      const entry = entriesByPath.get(datFile)
      if (!entry) throw new Error(`export file not found: ${datFile}`)
      const fallbackName = assetNames[datFile] || datFile
      let mediaType: string
      let attachmentId: string
      if (entry.size <= LARGE_ASSET_STREAM_THRESHOLD_BYTES) {
        const buffer = reader.readBuffer(datFile)
        mediaType = sniffMediaType(buffer, fallbackName)
        attachmentId = await saveAttachment(buffer.toString('base64'), mediaType)
      } else {
        const sample = await readStreamSample(reader.createReadStream(datFile), 4096)
        mediaType = sniffMediaType(sample, fallbackName)
        attachmentId = await saveAttachmentFromStream(reader.createReadStream(datFile), mediaType)
      }
      const record: AssetFileRecord = {
        datFile,
        attachmentId,
        mediaType,
        attachmentName: originalAttachmentName(assetNames[datFile], datFile),
        originalPath: assetNames[datFile],
        sizeBytes: entry.size,
        sha256: attachmentId,
      }
      assetFiles[datFile] = record
      if (!importsState.attachmentIds[attachmentId]) {
        importsState.attachmentIds[attachmentId] = { importedAt: nowIso() }
        nextJob.imported.attachments += 1
      }
    } catch (error) {
      nextJob.failed.attachments += 1
      nextJob.lastError = safeError(error)
    }
    writeImportsState(importsState)
    writeJob(nextJob)
  }
  nextJob.currentFile = undefined
  return { assetFiles, job: updateJob(nextJob, { phase: 'importing-conversations' }) }
}

function prepareConversation(
  conversation: ChatGptConversation,
  sourceAccount: string | undefined,
  assetsJson: AssetsJson,
  assetFiles: AssetFileMap,
  manifestVersion: number | null,
): PreparedConversation {
  const rawConversationHash = sha256Hex(JSON.stringify(conversation))
  const conversationId = explicitConversationId(conversation) || fallbackConversationId(conversation, rawConversationHash)
  const currentIds = currentPathIds(conversation)
  const messages = currentIds
    .map(id => messageFromNode(conversation, id, assetsJson, assetFiles))
    .filter((message): message is Message => message !== null)
  const fallbackTime = isoFromChatGptTime(conversation.create_time)
  const firstTimestamp = messages[0]?.timestamp || fallbackTime
  const lastTimestamp = messages[messages.length - 1]?.timestamp || isoFromChatGptTime(conversation.update_time, firstTimestamp)
  const graph = buildGraphSummary(conversation, assetsJson)
  const uid = stableSessionUid(sourceAccount, conversationId)
  const originalPath = `chatgpt-export://${sourceAccount ?? 'unknown'}/${conversationId}`
  const model = String(conversation.default_model_slug || messages.find(message => message.model)?.model || 'ChatGPT')
  const fingerprint = currentPathFingerprint(messages)
  const session: Session = {
    uid,
    id: conversationId,
    source: CHATGPT_EXPORT_SOURCE,
    sourceClient: 'ChatGPT export',
    sourceAccount,
    appVersion: `${manifestVersion ? `export-v${manifestVersion}` : 'export-unknown'} parser-v${CHATGPT_PARSER_VERSION}`,
    model,
    modelProvider: 'openai',
    firstTimestamp,
    lastTimestamp,
    cwd: conversation.title || 'Untitled ChatGPT conversation',
    messageCount: messages.length,
    hasThinking: messages.some(message => message.hasThinking),
    vaultPath: makeVaultPath(CHATGPT_EXPORT_SOURCE, uid),
    originalPath,
    graph,
  }
  const rawRecord: RawRecord = {
    v: 1,
    source: CHATGPT_EXPORT_SOURCE,
    sourcePath: originalPath,
    sourceByteOffset: 0,
    capturedAt: nowIso(),
    rawHash: rawConversationHash,
    raw: {
      type: 'chatgpt-conversation-snapshot',
      manifestVersion,
      conversation,
      assetsJsonForConversation: Object.fromEntries(Object.entries(assetsJson).filter(([messageId]) => {
        return Object.values(conversation.mapping ?? {}).some(node => (node.message?.id || node.id) === messageId)
      })),
      assetFiles,
    },
  }
  return {
    session,
    messages,
    rawRecord,
    currentPathFingerprint: fingerprint.hash,
    rawConversationHash,
    strongFingerprint: fingerprint.strong,
  }
}

function conversationRecordKey(sourceAccount: string | undefined, conversationId: string): string {
  return `${sourceAccount ?? ''}\0${conversationId}`
}

function scopedImportIndexKey(sourceAccount: string | undefined, value: string): string {
  return `${sourceAccount ?? ''}\0${value}`
}

function sameAccountRecord(
  record: ChatGptImportedConversationRecord | undefined,
  sourceAccount: string | undefined,
): ChatGptImportedConversationRecord | undefined {
  if (!record) return undefined
  return (record.sourceAccount ?? '') === (sourceAccount ?? '') ? record : undefined
}

function newJob(sourcePath: string, sourceKind: 'folder' | 'zip', counts: ChatGptExportCounts, warnings: string[]): ChatGptImportJob {
  const startedAt = nowIso()
  return {
    version: CHATGPT_IMPORT_JOB_VERSION,
    id: crypto.randomUUID(),
    sourcePath: path.resolve(sourcePath),
    sourceKind,
    phase: 'preflight',
    startedAt,
    updatedAt: startedAt,
    counts,
    imported: { sessions: 0, messages: 0, rawRecords: 0, attachments: 0 },
    updated: { sessions: 0, messages: 0 },
    skipped: { sessions: 0, messages: 0, duplicates: 0 },
    failed: { sessions: 0, attachments: 0 },
    cursor: { conversationIndex: 0, attachmentIndex: 0 },
    warnings,
    done: false,
  }
}

export function currentChatGptImportJob(): ChatGptImportJob | null {
  return readJob()
}

export async function runChatGptExportImport(sourcePath: string): Promise<ChatGptImportJob> {
  if (!hasVaultSession()) throw new Error('current vault must be unlocked before importing ChatGPT exports')
  ensureDirs()
  const preflight = await preflightChatGptExport(sourcePath)
  if (!preflight.ok) throw new Error(preflight.errors.join(' · ') || 'ChatGPT export preflight failed')
  let job = newJob(sourcePath, preflight.sourceKind, preflight.counts, preflight.warnings)
  writeJob(job)
  let reader: ChatGptExportReader | null = null
  try {
    reader = openExportReader(sourcePath)
    job = updateJob(job, { phase: 'reading-export' })
    const warnings = [...preflight.warnings]
    const manifest = reader.has('export_manifest.json')
      ? readJsonFromExport<ChatGptManifest>(reader, 'export_manifest.json', {})
      : null
    const manifestVersion = typeof manifest?.version === 'number' ? manifest.version : null
    const assetsJson = readAssetsJson(reader, warnings)
    const assetNames = loadAssetNames(reader)
    const conversations = loadConversations(reader)
    const sourceAccount = userHash(reader)
    const importsState = readImportsState()
    const importedAssets = await importAssets(reader, assetsJson, assetNames, job, importsState)
    job = importedAssets.job
    const assetFiles = importedAssets.assetFiles
    const sessions = await loadSessions()
    const sessionByUid = new Map(sessions.map(session => [session.uid, session]))
    const merged = [...sessions]
    const indexByUid = new Map(merged.map((session, index) => [session.uid, index]))
    let sessionsDirty = false
    const flushSessions = async (): Promise<void> => {
      if (!sessionsDirty) return
      await saveSessions(merged)
      sessionsDirty = false
    }

    for (let index = 0; index < conversations.length; index += 1) {
      const conversation = conversations[index].conversation
      const conversationId = explicitConversationId(conversation)
      job.cursor.conversationIndex = index
      job.currentConversation = conversationId || conversations[index].file
      writeJob(job)
      try {
        const prepared = prepareConversation(conversation, sourceAccount, assetsJson, assetFiles, manifestVersion)
        const key = conversationRecordKey(sourceAccount, prepared.session.id)
        const existingRecord = importsState.conversations[key]
        const sameRaw = importsState.rawConversationHashes[scopedImportIndexKey(sourceAccount, prepared.rawConversationHash)]
          || sameAccountRecord(importsState.rawConversationHashes[prepared.rawConversationHash], sourceAccount)
        const sameStrongFingerprint = prepared.strongFingerprint
          ? importsState.currentPathFingerprints[scopedImportIndexKey(sourceAccount, prepared.currentPathFingerprint)]
            || sameAccountRecord(importsState.currentPathFingerprints[prepared.currentPathFingerprint], sourceAccount)
          : undefined
        const destinationUid = existingRecord?.destinationUid || sameRaw?.destinationUid || sameStrongFingerprint?.destinationUid || prepared.session.uid
        const existingSession = sessionByUid.get(destinationUid) || sessionByUid.get(prepared.session.uid)
        const rawAlreadyStored = !!sameRaw

        const existingCurrentParser = existingRecord?.parserVersion === CHATGPT_PARSER_VERSION
        const sameRawCurrentParser = sameRaw?.parserVersion === CHATGPT_PARSER_VERSION
        const sameStrongCurrentParser = sameStrongFingerprint?.parserVersion === CHATGPT_PARSER_VERSION
        if (
          (existingRecord && existingCurrentParser && existingRecord.currentPathFingerprint === prepared.currentPathFingerprint)
          || (sameRaw && sameRawCurrentParser)
          || (sameStrongFingerprint && sameStrongCurrentParser && sameStrongFingerprint.conversationId !== prepared.session.id)
        ) {
          job.skipped.sessions += 1
          job.skipped.duplicates += 1
          job.skipped.messages += prepared.messages.length
          const record = existingRecord || sameRaw || sameStrongFingerprint!
          record.lastImportedAt = nowIso()
          record.lastAction = 'skipped'
          importsState.conversations[key] = record
          writeImportsState(importsState)
          writeJob(job)
          continue
        }

        const destinationSession: Session = {
          ...prepared.session,
          uid: destinationUid,
          vaultPath: makeVaultPath(CHATGPT_EXPORT_SOURCE, destinationUid),
        }

        if (existingSession || existingRecord) {
          await replaceSessionMessages(destinationSession, prepared.messages)
          const existingIndex = indexByUid.get(destinationUid)
          if (existingIndex !== undefined) merged[existingIndex] = destinationSession
          else {
            merged.push(destinationSession)
            indexByUid.set(destinationUid, merged.length - 1)
          }
          job.updated.sessions += 1
          job.updated.messages += prepared.messages.length
        } else {
          await appendMessages(destinationSession, prepared.messages)
          merged.push(destinationSession)
          indexByUid.set(destinationUid, merged.length - 1)
          sessionByUid.set(destinationUid, destinationSession)
          job.imported.sessions += 1
          job.imported.messages += prepared.messages.length
        }
        sessionsDirty = true

        if (!rawAlreadyStored) {
          await appendRawRecords(CHATGPT_EXPORT_SOURCE, destinationUid, [{
            ...prepared.rawRecord,
            sourcePath: destinationSession.originalPath,
          }])
          job.imported.rawRecords += 1
        }
        await saveSessions(merged)
        const importedAt = nowIso()
        const record: ChatGptImportedConversationRecord = {
          parserVersion: CHATGPT_PARSER_VERSION,
          sourceAccount,
          conversationId: prepared.session.id,
          destinationUid,
          currentPathFingerprint: prepared.currentPathFingerprint,
          rawConversationHash: prepared.rawConversationHash,
          strongFingerprint: prepared.strongFingerprint,
          firstImportedAt: existingRecord?.firstImportedAt ?? importedAt,
          lastImportedAt: importedAt,
          lastAction: existingSession || existingRecord ? 'updated' : 'imported',
        }
        importsState.conversations[key] = record
        importsState.rawConversationHashes[scopedImportIndexKey(sourceAccount, prepared.rawConversationHash)] = record
        if (prepared.strongFingerprint) importsState.currentPathFingerprints[scopedImportIndexKey(sourceAccount, prepared.currentPathFingerprint)] = record
        writeImportsState(importsState)
        if (index % 25 === 24) await flushSessions()
        writeJob(job)
      } catch (error) {
        job.failed.sessions += 1
        job.lastError = safeError(error)
        writeJob(job)
      }
    }
    await flushSessions()
    job.currentConversation = undefined
    job = updateJob(job, {
      phase: 'completed',
      completedAt: nowIso(),
      warnings,
      lastError: undefined,
      done: true,
    })
    return job
  } catch (error) {
    job = updateJob(job, {
      phase: 'failed',
      lastError: safeError(error),
      done: true,
    })
    return job
  } finally {
    reader?.close?.()
  }
}

type RawSnapshot = {
  type?: string
  manifestVersion?: number | null
  conversation?: ChatGptConversation
  assetsJsonForConversation?: AssetsJson
  assetFiles?: AssetFileMap
}

function branchIdsFromBranchId(branchId: string): { parentId: string; childId: string } | null {
  const idx = branchId.indexOf('>')
  if (idx < 1 || idx >= branchId.length - 1) return null
  return { parentId: branchId.slice(0, idx), childId: branchId.slice(idx + 1) }
}

function branchPathIds(conversation: ChatGptConversation, branchId: string, assetsJson: AssetsJson): string[] {
  const parsed = branchIdsFromBranchId(branchId)
  if (!parsed) throw new Error('invalid branch id')
  const currentIds = currentPathIds(conversation)
  const parentIndex = currentIds.indexOf(parsed.parentId)
  const prefix = parentIndex >= 0 ? currentIds.slice(0, parentIndex + 1) : []
  const children = childrenByParent(conversation)
  const branchPath = bestLeafPath(parsed.childId, conversation, children, assetsJson)
  return [...prefix, ...branchPath]
}

export async function readChatGptBranchMessages(session: Session, branchId: string): Promise<{ messages: Message[]; branch: ConversationBranchSummary | null }> {
  if (session.source !== CHATGPT_EXPORT_SOURCE) throw new Error('session is not a ChatGPT export')
  const rawRecords = await readRawRecords(CHATGPT_EXPORT_SOURCE, session.uid)
  const snapshot = rawRecords
    .map(record => record.raw as RawSnapshot)
    .find(raw => raw?.type === 'chatgpt-conversation-snapshot' && raw.conversation)
  if (!snapshot?.conversation) throw new Error('ChatGPT raw conversation snapshot not found')
  const assetsJson = snapshot.assetsJsonForConversation ?? {}
  const assetFiles = snapshot.assetFiles ?? {}
  const graph = buildGraphSummary(snapshot.conversation, assetsJson)
  const branch = graph.branches?.find(item => item.id === branchId) ?? null
  const ids = branchPathIds(snapshot.conversation, branchId, assetsJson)
  const messages = ids
    .map(id => messageFromNode(snapshot.conversation!, id, assetsJson, assetFiles))
    .filter((message): message is Message => message !== null)
  return { messages, branch }
}
