import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'
import { RAW_ARCHIVE_DIR } from './config'
import type { RawRecord, Source } from './types'
import { decryptBytesForSession, encryptBytesForSession } from './vault-helper'

type SourceArchiveChunk = {
  id: string
  sourcePath: string
  startOffset: number
  endOffset: number
  rawBytes: number
  compressedBytes: number
  encryptedBytes: number
  rawSha256: string
  compressedSha256: string
  createdAt: string
  recordFormat?: 'source-jsonl' | 'raw-record-jsonl'
  recordCount?: number
}

type SourceArchiveManifest = {
  version: number
  source: Source
  sessionUid: string
  chunks: SourceArchiveChunk[]
}

type PendingChunkEntry = {
  name: string
  filePath: string
  chunk: SourceArchiveChunk
}

export type SourceArchiveAppend = {
  source: Source
  sessionUid: string
  sourcePath: string
  startOffset: number
  endOffset: number
  bytes: Buffer
}

export type SourceArchivePendingCleanupResult = {
  scannedArchives: number
  archivesWithPending: number
  pendingFiles: number
  mergedPendingFiles: number
  skippedPendingFiles: number
  removedPendingDirs: number
  missingChunks: number
  malformedPendingFiles: number
  errors: Array<{ archive: string; file?: string; error: string }>
}

export type SourceArchiveSummary = {
  chunks: number
  rawRecords: number
  rawBytes: number
  firstRawHash: string
  lastRawHash: string
  fingerprint: string
}

export type SourceArchiveCopyResult = SourceArchiveSummary & {
  copiedChunks: number
}

function archiveDirFromRoot(rawArchiveRoot: string, source: Source, sessionUid: string): string {
  return path.join(rawArchiveRoot, source, sessionUid)
}

function archiveDir(source: Source, sessionUid: string): string {
  return archiveDirFromRoot(RAW_ARCHIVE_DIR, source, sessionUid)
}

function manifestPathFromRoot(rawArchiveRoot: string, source: Source, sessionUid: string): string {
  return path.join(archiveDirFromRoot(rawArchiveRoot, source, sessionUid), 'manifest.json.dmenc')
}

function manifestPath(source: Source, sessionUid: string): string {
  return manifestPathFromRoot(RAW_ARCHIVE_DIR, source, sessionUid)
}

function chunkPathFromRoot(rawArchiveRoot: string, source: Source, sessionUid: string, chunkId: string): string {
  return path.join(archiveDirFromRoot(rawArchiveRoot, source, sessionUid), 'chunks', `${chunkId}.dmenc`)
}

function chunkPath(source: Source, sessionUid: string, chunkId: string): string {
  return chunkPathFromRoot(RAW_ARCHIVE_DIR, source, sessionUid, chunkId)
}

function pendingDirFromRoot(rawArchiveRoot: string, source: Source, sessionUid: string): string {
  return path.join(archiveDirFromRoot(rawArchiveRoot, source, sessionUid), 'pending')
}

function pendingEntryPath(source: Source, sessionUid: string, chunkId: string): string {
  return path.join(pendingDirFromRoot(RAW_ARCHIVE_DIR, source, sessionUid), `${chunkId}.json.dmenc`)
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function countJsonlRecords(bytes: Buffer): number {
  return bytes.toString('utf8').split('\n').filter(line => line.trim().length > 0).length
}

function chunkKey(chunk: SourceArchiveChunk): string {
  return [
    chunk.id,
    chunk.sourcePath,
    chunk.startOffset,
    chunk.endOffset,
    chunk.rawSha256,
    chunk.recordFormat || '',
    chunk.recordCount ?? '',
  ].join('\0')
}

function sortChunks(chunks: SourceArchiveChunk[]): SourceArchiveChunk[] {
  return chunks.sort((a, b) => (
    a.sourcePath.localeCompare(b.sourcePath)
    || a.startOffset - b.startOffset
    || a.endOffset - b.endOffset
    || a.id.localeCompare(b.id)
  ))
}

function dedupeChunks(chunks: SourceArchiveChunk[]): SourceArchiveChunk[] {
  const seen = new Set<string>()
  const out: SourceArchiveChunk[] = []
  for (const chunk of chunks) {
    const key = chunkKey(chunk)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(chunk)
  }
  return sortChunks(out)
}

function isCaptureOnlySessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('vault session is capture-only')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyPendingCleanupResult(): SourceArchivePendingCleanupResult {
  return {
    scannedArchives: 0,
    archivesWithPending: 0,
    pendingFiles: 0,
    mergedPendingFiles: 0,
    skippedPendingFiles: 0,
    removedPendingDirs: 0,
    missingChunks: 0,
    malformedPendingFiles: 0,
    errors: [],
  }
}

function writePrivateBytes(filePath: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
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
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
}

async function readManifest(sessionId: string, source: Source, sessionUid: string): Promise<SourceArchiveManifest> {
  return await readManifestFromRoot(sessionId, RAW_ARCHIVE_DIR, source, sessionUid)
}

async function readBaseManifestFromRoot(sessionId: string, rawArchiveRoot: string, source: Source, sessionUid: string): Promise<SourceArchiveManifest> {
  const filePath = manifestPathFromRoot(rawArchiveRoot, source, sessionUid)
  let manifest: SourceArchiveManifest = { version: 1, source, sessionUid, chunks: [] }
  if (fs.existsSync(filePath)) {
    const encrypted = fs.readFileSync(filePath)
    const plaintext = await decryptBytesForSession(sessionId, encrypted)
    const parsed = JSON.parse(plaintext.toString('utf8')) as SourceArchiveManifest
    if (Array.isArray(parsed.chunks)) manifest = parsed
  }
  return manifest
}

async function readPendingChunkEntriesFromRoot(
  sessionId: string,
  rawArchiveRoot: string,
  source: Source,
  sessionUid: string,
  options: { strict: boolean } = { strict: true },
): Promise<{
  entries: PendingChunkEntry[]
  files: number
  errors: Array<{ file: string; error: string }>
}> {
  const pendingDir = pendingDirFromRoot(rawArchiveRoot, source, sessionUid)
  if (!fs.existsSync(pendingDir)) return { entries: [], files: 0, errors: [] }

  const entries: PendingChunkEntry[] = []
  const errors: Array<{ file: string; error: string }> = []
  let files = 0
  for (const entry of fs.readdirSync(pendingDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.dmenc')) continue
    files += 1
    const filePath = path.join(pendingDir, entry.name)
    try {
      const encrypted = fs.readFileSync(filePath)
      const plaintext = await decryptBytesForSession(sessionId, encrypted)
      const parsed = JSON.parse(plaintext.toString('utf8')) as SourceArchiveChunk
      if (!parsed || typeof parsed.id !== 'string' || typeof parsed.rawSha256 !== 'string') {
        throw new Error(`raw archive pending entry malformed: ${source}/${sessionUid}/${entry.name}`)
      }
      entries.push({ name: entry.name, filePath, chunk: parsed })
    } catch (error) {
      if (options.strict) throw error
      errors.push({ file: entry.name, error: errorMessage(error) })
    }
  }
  return { entries, files, errors }
}

async function readManifestFromRoot(sessionId: string, rawArchiveRoot: string, source: Source, sessionUid: string): Promise<SourceArchiveManifest> {
  const manifest = await readBaseManifestFromRoot(sessionId, rawArchiveRoot, source, sessionUid)
  const pending = await readPendingChunkEntriesFromRoot(sessionId, rawArchiveRoot, source, sessionUid, { strict: true })
  if (pending.entries.length === 0) return { ...manifest, chunks: dedupeChunks(manifest.chunks) }

  return { ...manifest, chunks: dedupeChunks([...manifest.chunks, ...pending.entries.map(entry => entry.chunk)]) }
}

async function writeManifestFile(sessionId: string, manifest: SourceArchiveManifest): Promise<void> {
  const plaintext = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const encrypted = await encryptBytesForSession(sessionId, plaintext)
  writePrivateBytes(manifestPath(manifest.source, manifest.sessionUid), encrypted)
}

async function writeManifest(sessionId: string, manifest: SourceArchiveManifest): Promise<void> {
  await writeManifestFile(sessionId, manifest)
  fs.rmSync(pendingDirFromRoot(RAW_ARCHIVE_DIR, manifest.source, manifest.sessionUid), { recursive: true, force: true })
}

function hasArchiveIndex(rawArchiveRoot: string, source: Source, sessionUid: string): boolean {
  return fs.existsSync(manifestPathFromRoot(rawArchiveRoot, source, sessionUid))
    || fs.existsSync(pendingDirFromRoot(rawArchiveRoot, source, sessionUid))
}

async function appendPendingSourceArchiveChunk(
  sessionId: string,
  entry: SourceArchiveAppend,
  rawSha256: string,
): Promise<{ appended: boolean; rawBytes: number; encryptedBytes: number }> {
  const compressed = zlib.gzipSync(entry.bytes, { level: 6 })
  const compressedSha256 = sha256Hex(compressed)
  const chunkId = sha256Hex(`${entry.sourcePath}\0${entry.startOffset}\0${entry.endOffset}\0${rawSha256}`).slice(0, 32)
  const encryptedPath = chunkPath(entry.source, entry.sessionUid, chunkId)
  const pendingPath = pendingEntryPath(entry.source, entry.sessionUid, chunkId)
  const existing = fs.existsSync(encryptedPath) && fs.existsSync(pendingPath)
  if (existing) {
    return { appended: false, rawBytes: entry.bytes.length, encryptedBytes: fs.statSync(encryptedPath).size }
  }

  const encrypted = await encryptBytesForSession(sessionId, compressed)
  writePrivateBytes(encryptedPath, encrypted)
  const chunk: SourceArchiveChunk = {
    id: chunkId,
    sourcePath: entry.sourcePath,
    startOffset: entry.startOffset,
    endOffset: entry.endOffset,
    rawBytes: entry.bytes.length,
    compressedBytes: compressed.length,
    encryptedBytes: encrypted.length,
    rawSha256,
    compressedSha256,
    createdAt: new Date().toISOString(),
  }
  const pending = await encryptBytesForSession(sessionId, Buffer.from(`${JSON.stringify(chunk)}\n`, 'utf8'))
  writePrivateBytes(pendingPath, pending)
  return { appended: true, rawBytes: entry.bytes.length, encryptedBytes: encrypted.length }
}

export async function appendSourceArchiveChunk(sessionId: string, entry: SourceArchiveAppend): Promise<{ appended: boolean; rawBytes: number; encryptedBytes: number }> {
  if (entry.bytes.length === 0 || entry.endOffset <= entry.startOffset) {
    return { appended: false, rawBytes: 0, encryptedBytes: 0 }
  }
  const rawSha256 = sha256Hex(entry.bytes)
  let manifest: SourceArchiveManifest
  try {
    manifest = await readManifest(sessionId, entry.source, entry.sessionUid)
  } catch (error) {
    if (isCaptureOnlySessionError(error)) {
      return await appendPendingSourceArchiveChunk(sessionId, entry, rawSha256)
    }
    throw error
  }
  const existing = manifest.chunks.find(chunk => (
    chunk.sourcePath === entry.sourcePath
    && chunk.startOffset === entry.startOffset
    && chunk.endOffset === entry.endOffset
    && chunk.rawSha256 === rawSha256
  ))
  if (existing) return { appended: false, rawBytes: existing.rawBytes, encryptedBytes: existing.encryptedBytes }

  const compressed = zlib.gzipSync(entry.bytes, { level: 6 })
  const compressedSha256 = sha256Hex(compressed)
  const chunkId = sha256Hex(`${entry.sourcePath}\0${entry.startOffset}\0${entry.endOffset}\0${rawSha256}`).slice(0, 32)
  const encrypted = await encryptBytesForSession(sessionId, compressed)
  writePrivateBytes(chunkPath(entry.source, entry.sessionUid, chunkId), encrypted)

  manifest.chunks.push({
    id: chunkId,
    sourcePath: entry.sourcePath,
    startOffset: entry.startOffset,
    endOffset: entry.endOffset,
    rawBytes: entry.bytes.length,
    compressedBytes: compressed.length,
    encryptedBytes: encrypted.length,
    rawSha256,
    compressedSha256,
    createdAt: new Date().toISOString(),
  })
  manifest.chunks = dedupeChunks(manifest.chunks)
  await writeManifest(sessionId, manifest)
  return { appended: true, rawBytes: entry.bytes.length, encryptedBytes: encrypted.length }
}

function recordsFromChunk(source: Source, chunk: SourceArchiveChunk, bytes: Buffer): RawRecord[] {
  const out: RawRecord[] = []
  const text = bytes.toString('utf8')
  const parts = text.split('\n')
  if (chunk.recordFormat === 'raw-record-jsonl') {
    for (const line of parts) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as RawRecord)
      } catch {
        /* skip malformed legacy raw-record lines */
      }
    }
    return out
  }
  const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 10
  let cursor = chunk.startOffset
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index]
    const isFinalWithoutNewline = index === parts.length - 1 && !endsWithNewline
    const newlineBytes = isFinalWithoutNewline ? 0 : 1
    if (line.trim()) {
      let raw: unknown = line
      let parseError: string | undefined
      try {
        raw = JSON.parse(line)
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error)
      }
      out.push({
        v: 1,
        source,
        sourcePath: chunk.sourcePath,
        sourceByteOffset: cursor,
        capturedAt: chunk.createdAt,
        rawHash: sha256Hex(line),
        raw,
        ...(parseError ? { parseError } : {}),
      })
    }
    cursor += Buffer.byteLength(line, 'utf8') + newlineBytes
  }
  return out
}

export async function readSourceArchiveRawRecords(sessionId: string, source: Source, sessionUid: string): Promise<RawRecord[]> {
  return await readSourceArchiveRawRecordsFromRoot(sessionId, RAW_ARCHIVE_DIR, source, sessionUid)
}

export async function readSourceArchiveRawRecordsFromRoot(sessionId: string, rawArchiveRoot: string, source: Source, sessionUid: string): Promise<RawRecord[]> {
  if (!hasArchiveIndex(rawArchiveRoot, source, sessionUid)) return []
  const manifest = await readManifestFromRoot(sessionId, rawArchiveRoot, source, sessionUid)
  const records: RawRecord[] = []
  for (const chunk of manifest.chunks) {
    const encryptedPath = chunkPathFromRoot(rawArchiveRoot, source, sessionUid, chunk.id)
    if (!fs.existsSync(encryptedPath)) continue
    const encrypted = fs.readFileSync(encryptedPath)
    const compressed = await decryptBytesForSession(sessionId, encrypted)
    if (sha256Hex(compressed) !== chunk.compressedSha256) {
      throw new Error(`raw archive compressed hash mismatch: ${source}/${sessionUid}/${chunk.id}`)
    }
    const raw = zlib.gunzipSync(compressed)
    if (sha256Hex(raw) !== chunk.rawSha256) {
      throw new Error(`raw archive hash mismatch: ${source}/${sessionUid}/${chunk.id}`)
    }
    records.push(...recordsFromChunk(source, chunk, raw))
  }
  return records
}

function emptyArchiveSummary(): SourceArchiveSummary {
  return {
    chunks: 0,
    rawRecords: 0,
    rawBytes: 0,
    firstRawHash: '',
    lastRawHash: '',
    fingerprint: '',
  }
}

function summarizeArchiveChunks(chunks: SourceArchiveChunk[]): SourceArchiveSummary {
  if (chunks.length === 0) return emptyArchiveSummary()
  let rawRecords = 0
  let rawBytes = 0
  const fingerprints: string[] = []
  for (const chunk of chunks) {
    rawRecords += Math.max(0, Number(chunk.recordCount || 0))
    rawBytes += Math.max(0, Number(chunk.rawBytes || 0))
    fingerprints.push([
      chunk.id,
      chunk.sourcePath,
      chunk.startOffset,
      chunk.endOffset,
      chunk.rawSha256,
      chunk.recordFormat || '',
      chunk.recordCount ?? '',
    ].join('\0'))
  }
  return {
    chunks: chunks.length,
    rawRecords,
    rawBytes,
    firstRawHash: chunks[0]?.rawSha256 || '',
    lastRawHash: chunks[chunks.length - 1]?.rawSha256 || '',
    fingerprint: sha256Hex(fingerprints.join('\n')),
  }
}

export async function summarizeSourceArchiveFromRoot(
  sessionId: string,
  rawArchiveRoot: string,
  source: Source,
  sessionUid: string,
): Promise<SourceArchiveSummary> {
  if (!hasArchiveIndex(rawArchiveRoot, source, sessionUid)) return emptyArchiveSummary()
  const manifest = await readManifestFromRoot(sessionId, rawArchiveRoot, source, sessionUid)
  return summarizeArchiveChunks(manifest.chunks)
}

export async function copySourceArchiveFromRoot(
  sourceSessionId: string,
  sourceRawArchiveRoot: string,
  destinationSessionId: string,
  source: Source,
  sourceUid: string,
  destinationUid: string,
): Promise<SourceArchiveCopyResult> {
  if (!hasArchiveIndex(sourceRawArchiveRoot, source, sourceUid)) {
    return { ...emptyArchiveSummary(), copiedChunks: 0 }
  }

  const sourceManifest = await readManifestFromRoot(sourceSessionId, sourceRawArchiveRoot, source, sourceUid)
  const destinationManifest = await readManifest(destinationSessionId, source, destinationUid)
  const existing = new Set(destinationManifest.chunks.map(chunk => chunkKey(chunk)))
  let copiedChunks = 0
  let rawRecords = 0
  let rawBytes = 0
  const copied: SourceArchiveChunk[] = []

  for (const chunk of sourceManifest.chunks) {
    const encryptedPath = chunkPathFromRoot(sourceRawArchiveRoot, source, sourceUid, chunk.id)
    if (!fs.existsSync(encryptedPath)) {
      throw new Error(`raw archive chunk missing: ${source}/${sourceUid}/${chunk.id}`)
    }
    const compressed = await decryptBytesForSession(sourceSessionId, fs.readFileSync(encryptedPath))
    if (sha256Hex(compressed) !== chunk.compressedSha256) {
      throw new Error(`raw archive compressed hash mismatch: ${source}/${sourceUid}/${chunk.id}`)
    }
    const raw = zlib.gunzipSync(compressed)
    if (sha256Hex(raw) !== chunk.rawSha256) {
      throw new Error(`raw archive hash mismatch: ${source}/${sourceUid}/${chunk.id}`)
    }

    const recordCount = Math.max(0, Number(chunk.recordCount || 0)) || countJsonlRecords(raw)
    const normalizedChunk: SourceArchiveChunk = { ...chunk, recordCount }
    rawRecords += recordCount
    rawBytes += Math.max(0, Number(chunk.rawBytes || raw.length))
    copied.push(normalizedChunk)
    const key = chunkKey(normalizedChunk)
    if (existing.has(key)) continue

    const encrypted = await encryptBytesForSession(destinationSessionId, compressed)
    writePrivateBytes(chunkPath(source, destinationUid, chunk.id), encrypted)
    destinationManifest.chunks.push(normalizedChunk)
    existing.add(key)
    copiedChunks += 1
  }

  if (copiedChunks > 0) {
    await writeManifest(destinationSessionId, {
      version: 1,
      source,
      sessionUid: destinationUid,
      chunks: dedupeChunks(destinationManifest.chunks),
    })
  }

  const summary = summarizeArchiveChunks(copied)
  return {
    ...summary,
    rawRecords,
    rawBytes,
    copiedChunks,
  }
}

export async function forEachSourceArchiveRawRecordBatch(
  sessionId: string,
  source: Source,
  sessionUid: string,
  batchSize: number,
  visitor: (records: RawRecord[]) => boolean | Promise<boolean | void> | void,
): Promise<void> {
  if (!hasArchiveIndex(RAW_ARCHIVE_DIR, source, sessionUid)) return
  const manifest = await readManifest(sessionId, source, sessionUid)
  const normalizedBatchSize = Math.max(1, Math.floor(batchSize))
  let batch: RawRecord[] = []

  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true
    const current = batch
    batch = []
    return (await visitor(current)) !== false
  }

  for (const chunk of manifest.chunks) {
    const encryptedPath = chunkPath(source, sessionUid, chunk.id)
    if (!fs.existsSync(encryptedPath)) continue
    const encrypted = fs.readFileSync(encryptedPath)
    const compressed = await decryptBytesForSession(sessionId, encrypted)
    if (sha256Hex(compressed) !== chunk.compressedSha256) {
      throw new Error(`raw archive compressed hash mismatch: ${source}/${sessionUid}/${chunk.id}`)
    }
    const raw = zlib.gunzipSync(compressed)
    if (sha256Hex(raw) !== chunk.rawSha256) {
      throw new Error(`raw archive hash mismatch: ${source}/${sessionUid}/${chunk.id}`)
    }
    for (const record of recordsFromChunk(source, chunk, raw)) {
      batch.push(record)
      if (batch.length >= normalizedBatchSize && !(await flush())) return
    }
  }
  await flush()
}

export async function verifySourceArchive(sessionId: string, source: Source, sessionUid: string): Promise<{ chunks: number; records: number; rawBytes: number; encryptedBytes: number }> {
  if (!hasArchiveIndex(RAW_ARCHIVE_DIR, source, sessionUid)) return { chunks: 0, records: 0, rawBytes: 0, encryptedBytes: 0 }
  const manifest = await readManifest(sessionId, source, sessionUid)
  let records = 0
  let rawBytes = 0
  let encryptedBytes = 0
  for (const chunk of manifest.chunks) {
    const encryptedPath = chunkPath(source, sessionUid, chunk.id)
    if (!fs.existsSync(encryptedPath)) {
      throw new Error(`raw archive chunk missing: ${source}/${sessionUid}/${chunk.id}`)
    }
    const encrypted = fs.readFileSync(encryptedPath)
    const compressed = await decryptBytesForSession(sessionId, encrypted)
    if (sha256Hex(compressed) !== chunk.compressedSha256) {
      throw new Error(`raw archive compressed hash mismatch: ${source}/${sessionUid}/${chunk.id}`)
    }
    const raw = zlib.gunzipSync(compressed)
    if (sha256Hex(raw) !== chunk.rawSha256) {
      throw new Error(`raw archive hash mismatch: ${source}/${sessionUid}/${chunk.id}`)
    }
    const text = raw.toString('utf8')
    records += text.split('\n').filter(line => line.trim()).length
    rawBytes += raw.length
    encryptedBytes += encrypted.length
  }
  return { chunks: manifest.chunks.length, records, rawBytes, encryptedBytes }
}

function mergeCleanupResult(target: SourceArchivePendingCleanupResult, patch: SourceArchivePendingCleanupResult): SourceArchivePendingCleanupResult {
  target.scannedArchives += patch.scannedArchives
  target.archivesWithPending += patch.archivesWithPending
  target.pendingFiles += patch.pendingFiles
  target.mergedPendingFiles += patch.mergedPendingFiles
  target.skippedPendingFiles += patch.skippedPendingFiles
  target.removedPendingDirs += patch.removedPendingDirs
  target.missingChunks += patch.missingChunks
  target.malformedPendingFiles += patch.malformedPendingFiles
  target.errors.push(...patch.errors)
  return target
}

function removePendingDirIfEmpty(rawArchiveRoot: string, source: Source, sessionUid: string): boolean {
  const pendingDir = pendingDirFromRoot(rawArchiveRoot, source, sessionUid)
  try {
    if (!fs.existsSync(pendingDir)) return false
    const remaining = fs.readdirSync(pendingDir, { withFileTypes: true })
      .some(entry => entry.isFile() || entry.isDirectory())
    if (remaining) return false
    fs.rmSync(pendingDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export async function cleanupSourceArchivePending(
  sessionId: string,
  source: Source,
  sessionUid: string,
  options: { rawArchiveRoot?: string } = {},
): Promise<SourceArchivePendingCleanupResult> {
  const rawArchiveRoot = path.resolve(options.rawArchiveRoot ?? RAW_ARCHIVE_DIR)
  const result = emptyPendingCleanupResult()
  const archiveLabel = `${source}/${sessionUid}`
  result.scannedArchives = 1

  const pendingDir = pendingDirFromRoot(rawArchiveRoot, source, sessionUid)
  if (!fs.existsSync(pendingDir)) return result
  result.archivesWithPending = 1

  let manifest: SourceArchiveManifest
  try {
    manifest = await readBaseManifestFromRoot(sessionId, rawArchiveRoot, source, sessionUid)
  } catch (error) {
    result.errors.push({ archive: archiveLabel, error: errorMessage(error) })
    return result
  }

  const pending = await readPendingChunkEntriesFromRoot(sessionId, rawArchiveRoot, source, sessionUid, { strict: false })
  result.pendingFiles = pending.files
  result.malformedPendingFiles = pending.errors.length
  for (const error of pending.errors) {
    result.errors.push({ archive: archiveLabel, file: error.file, error: error.error })
  }

  const mergeable: PendingChunkEntry[] = []
  for (const entry of pending.entries) {
    const chunkFile = chunkPathFromRoot(rawArchiveRoot, source, sessionUid, entry.chunk.id)
    if (!fs.existsSync(chunkFile)) {
      result.missingChunks += 1
      result.skippedPendingFiles += 1
      result.errors.push({
        archive: archiveLabel,
        file: entry.name,
        error: `raw archive chunk missing: ${entry.chunk.id}`,
      })
      continue
    }
    mergeable.push(entry)
  }

  if (mergeable.length > 0) {
    const merged: SourceArchiveManifest = {
      ...manifest,
      source,
      sessionUid,
      chunks: dedupeChunks([...manifest.chunks, ...mergeable.map(entry => entry.chunk)]),
    }
    try {
      await writeManifestFile(sessionId, merged)
      for (const entry of mergeable) {
        fs.rmSync(entry.filePath, { force: true })
        result.mergedPendingFiles += 1
      }
    } catch (error) {
      result.errors.push({ archive: archiveLabel, error: errorMessage(error) })
      result.skippedPendingFiles += mergeable.length
    }
  }

  result.skippedPendingFiles += result.malformedPendingFiles
  if (removePendingDirIfEmpty(rawArchiveRoot, source, sessionUid)) result.removedPendingDirs += 1
  return result
}

export async function cleanupAllSourceArchivePending(sessionId: string): Promise<SourceArchivePendingCleanupResult> {
  const result = emptyPendingCleanupResult()
  if (!fs.existsSync(RAW_ARCHIVE_DIR)) return result

  for (const sourceEntry of fs.readdirSync(RAW_ARCHIVE_DIR, { withFileTypes: true })) {
    if (!sourceEntry.isDirectory()) continue
    const source = sourceEntry.name as Source
    const sourceDir = path.join(RAW_ARCHIVE_DIR, sourceEntry.name)
    for (const sessionEntry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const pendingDir = pendingDirFromRoot(RAW_ARCHIVE_DIR, source, sessionEntry.name)
      if (!fs.existsSync(pendingDir)) continue
      mergeCleanupResult(result, await cleanupSourceArchivePending(sessionId, source, sessionEntry.name))
    }
  }
  return result
}

export async function appendRawRecordArchiveLines(
  sessionId: string,
  source: Source,
  sessionUid: string,
  lines: string[],
): Promise<{ appended: boolean; rawBytes: number; encryptedBytes: number; records: number }> {
  const normalized = lines.map(line => line.trim()).filter(Boolean)
  if (normalized.length === 0) return { appended: false, rawBytes: 0, encryptedBytes: 0, records: 0 }
  const bytes = Buffer.from(`${normalized.join('\n')}\n`, 'utf8')
  const rawSha256 = sha256Hex(bytes)
  const manifest = await readManifest(sessionId, source, sessionUid)
  const existing = manifest.chunks.find(chunk => (
    chunk.recordFormat === 'raw-record-jsonl'
    && chunk.rawSha256 === rawSha256
    && chunk.recordCount === normalized.length
  ))
  if (existing) {
    return {
      appended: false,
      rawBytes: existing.rawBytes,
      encryptedBytes: existing.encryptedBytes,
      records: existing.recordCount || normalized.length,
    }
  }

  const compressed = zlib.gzipSync(bytes, { level: 6 })
  const compressedSha256 = sha256Hex(compressed)
  const chunkId = sha256Hex(`raw-record-jsonl\0${source}\0${sessionUid}\0${rawSha256}`).slice(0, 32)
  const encrypted = await encryptBytesForSession(sessionId, compressed)
  writePrivateBytes(chunkPath(source, sessionUid, chunkId), encrypted)
  manifest.chunks.push({
    id: chunkId,
    sourcePath: 'legacy-raw-records',
    startOffset: 0,
    endOffset: bytes.length,
    rawBytes: bytes.length,
    compressedBytes: compressed.length,
    encryptedBytes: encrypted.length,
    rawSha256,
    compressedSha256,
    createdAt: new Date().toISOString(),
    recordFormat: 'raw-record-jsonl',
    recordCount: normalized.length,
  })
  manifest.chunks = dedupeChunks(manifest.chunks)
  await writeManifest(sessionId, manifest)
  return { appended: true, rawBytes: bytes.length, encryptedBytes: encrypted.length, records: normalized.length }
}

export function sourceArchiveSize(source: Source, sessionUid: string): number {
  const dir = archiveDir(source, sessionUid)
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(absolute)
      else if (entry.isFile()) total += fs.statSync(absolute).size
    }
  }
  return total
}
