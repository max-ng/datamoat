import * as childProcess from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import { loadAuthConfig } from './auth'
import {
  ATTACHMENTS_DIR,
  AUTH_FILE,
  BOOTSTRAP_CAPTURE_DIR,
  DATAMOAT_ROOT,
  RAW_ARCHIVE_DIR,
  RAW_DIR,
  SESSIONS_FILE,
  SKILLS_BACKUP_DIR,
  STATE_DIR,
  VAULT_DIR,
} from './config'
import { bootstrapCaptureSummary } from './bootstrap-capture'
import type { TransferAuthSummary, TransferBootstrapSummary, TransferCounts, TransferManifest } from './transfer-types'
import { TRANSFER_MANIFEST_FORMAT } from './transfer-types'
import { appendMessages, getVaultSessionId, loadSessions, makeRawPath } from './store'
import type { RawRecord, Session } from './types'
import { decryptLinesForSession } from './vault-helper'
import { appendRawRecordArchiveLines, verifySourceArchive } from './source-archive'

const MANIFEST_BASENAME = '.datamoat-transfer.json'
const STATE_MANIFEST_BASENAME = 'transfer-export-manifest.json'

export type TransferExportPreparationStatus = {
  running: boolean
  phase: 'raw-archives' | 'manifest' | 'done' | 'failed'
  startedAt: string
  updatedAt: string
  sessionsProcessed: number
  totalSessions: number
  legacyFiles: number
  migratedFiles: number
  migratedRecords: number
  legacyBytes: number
  rawArchiveBytes: number
  currentSession?: string
  error?: string
}

let transferPreparationStatus: TransferExportPreparationStatus | null = null
let activeTransferManifestWrite: Promise<TransferManifest> | null = null

function updateTransferPreparationStatus(patch: Partial<TransferExportPreparationStatus>): void {
  const now = new Date().toISOString()
  const phase = patch.phase ?? transferPreparationStatus?.phase ?? 'raw-archives'
  transferPreparationStatus = {
    running: patch.running ?? (phase !== 'done' && phase !== 'failed'),
    phase,
    startedAt: patch.startedAt ?? transferPreparationStatus?.startedAt ?? now,
    updatedAt: now,
    sessionsProcessed: patch.sessionsProcessed ?? transferPreparationStatus?.sessionsProcessed ?? 0,
    totalSessions: patch.totalSessions ?? transferPreparationStatus?.totalSessions ?? 0,
    legacyFiles: patch.legacyFiles ?? transferPreparationStatus?.legacyFiles ?? 0,
    migratedFiles: patch.migratedFiles ?? transferPreparationStatus?.migratedFiles ?? 0,
    migratedRecords: patch.migratedRecords ?? transferPreparationStatus?.migratedRecords ?? 0,
    legacyBytes: patch.legacyBytes ?? transferPreparationStatus?.legacyBytes ?? 0,
    rawArchiveBytes: patch.rawArchiveBytes ?? transferPreparationStatus?.rawArchiveBytes ?? 0,
    currentSession: Object.prototype.hasOwnProperty.call(patch, 'currentSession') ? patch.currentSession : transferPreparationStatus?.currentSession,
    error: Object.prototype.hasOwnProperty.call(patch, 'error') ? patch.error : transferPreparationStatus?.error,
  }
}

export function currentTransferExportPreparationStatus(): TransferExportPreparationStatus | null {
  return transferPreparationStatus ? { ...transferPreparationStatus } : null
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function safeJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function isTransferNoiseName(name: string): boolean {
  return name === '.DS_Store' || name.startsWith('._')
}

function isTransferNoisePath(relativePath: string): boolean {
  return relativePath.split('/').some(isTransferNoiseName)
}

function isTransferTransientPath(relativePath: string): boolean {
  const normalized = toPosix(relativePath)
  return normalized === 'daemon.pid'
    || normalized === 'state/port'
    || normalized === 'state/status.json'
    || normalized === 'state/health.json'
    || normalized === 'state/transfer-import-job.json'
    || normalized === 'state/transfer-imports.json'
    || normalized === 'state/transfer-replace-journal.json'
}

function packageVersion(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ]
  for (const candidate of candidates) {
    const parsed = safeJson<{ version?: string }>(candidate)
    if (parsed?.version) return parsed.version
  }
  return '0.0.0'
}

function authSummaryForRoot(root: string): TransferAuthSummary | null {
  const config = root === DATAMOAT_ROOT
    ? loadAuthConfig()
    : safeJson<ReturnType<typeof loadAuthConfig>>(path.join(root, 'auth.json'))
  if (!config) return null
  return {
    hasPassword: !!(config.passwordEnabled ?? config.passwordHash),
    hasMnemonic: !!config.mnemonicWrappedVaultKey || !!config.mnemonicHash,
    hasTouchId: !!(config.touchIdEnabled || config.touchIdWrappedVaultKey),
    hasBackgroundUnlock: !!config.backgroundWrappedVaultKey,
    totpEnrolled: config.totpEnrolled === true,
  }
}

function countMatchingFiles(dirPath: string, predicate: (absolutePath: string, relativePath: string) => boolean): { count: number; bytes: number; entries: string[] } {
  const entries: string[] = []
  let count = 0
  let bytes = 0
  const walk = (current: string): void => {
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const child of children) {
      const absolute = path.join(current, child.name)
      if (isTransferNoiseName(child.name)) continue
      if (child.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!child.isFile()) continue
      const relative = toPosix(path.relative(dirPath, absolute))
      if (isTransferNoisePath(relative)) continue
      if (isTransferTransientPath(relative)) continue
      if (!predicate(absolute, relative)) continue
      const stat = safeStat(absolute)
      if (stat) bytes += stat.size
      count += 1
      entries.push(relative)
    }
  }
  if (fs.existsSync(dirPath)) walk(dirPath)
  entries.sort()
  return { count, bytes, entries }
}

export function transferManifestPath(root = DATAMOAT_ROOT): string {
  return path.join(root, MANIFEST_BASENAME)
}

export function transferStateManifestPath(root = DATAMOAT_ROOT): string {
  return path.join(root, 'state', STATE_MANIFEST_BASENAME)
}

export function inspectTransferRoot(root = DATAMOAT_ROOT): TransferCounts {
  const resolvedRoot = path.resolve(root)
  const vaultRoot = path.join(resolvedRoot, 'vault')
  const rawRoot = path.join(vaultRoot, 'raw')
  const attachmentsRoot = path.join(vaultRoot, 'attachments')
  const skillsRoot = path.join(vaultRoot, 'skills')
  const stateRoot = path.join(resolvedRoot, 'state')
  const vault = countMatchingFiles(vaultRoot, (_absolute, relative) => {
    if (relative.startsWith('raw/')) return false
    if (relative.startsWith('attachments/')) return false
    if (relative.startsWith('skills/')) return false
    return relative.endsWith('.jsonl')
  })
  const raw = countMatchingFiles(rawRoot, (_absolute, relative) => relative.endsWith('.jsonl'))
  const attachments = countMatchingFiles(attachmentsRoot, (_absolute, relative) => relative.endsWith('.dmenc'))
  const skills = countMatchingFiles(skillsRoot, () => true)
  const state = countMatchingFiles(stateRoot, () => true)
  const rootFiles = countMatchingFiles(resolvedRoot, (_absolute, relative) => !relative.includes('/'))
  const rootSize = countMatchingFiles(resolvedRoot, () => true)

  return {
    sessions: 0,
    vaultFiles: vault.count,
    rawFiles: raw.count,
    attachments: attachments.count,
    skillsFiles: skills.count,
    stateFiles: state.count,
    totalBytes: rootSize.bytes,
  }
}

export function computeTransferRootFingerprint(root = DATAMOAT_ROOT): string {
  const resolvedRoot = path.resolve(root)
  const hash = crypto.createHash('sha256')
  const importantFiles = [
    path.join(resolvedRoot, 'auth.json'),
    path.join(resolvedRoot, 'state', 'sessions.json'),
    path.join(resolvedRoot, 'state', 'referenced-attachments.json'),
  ]

  hash.update('datamoat-transfer-root-v1\0')
  for (const filePath of importantFiles) {
    const stat = safeStat(filePath)
    hash.update(`${toPosix(path.relative(resolvedRoot, filePath))}\0`)
    if (!stat?.isFile()) {
      hash.update('missing\0')
      continue
    }
    hash.update(`${stat.size}\0`)
    const fileHash = crypto.createHash('sha256')
    fileHash.update(fs.readFileSync(filePath))
    hash.update(`${fileHash.digest('hex')}\0`)
  }

  const vaultEntries = countMatchingFiles(path.join(resolvedRoot, 'vault'), () => true).entries
  for (const relative of vaultEntries) {
    const stat = safeStat(path.join(resolvedRoot, 'vault', ...relative.split('/')))
    hash.update(`${relative}\0${stat?.size ?? 0}\0`)
  }

  return `sha256:${hash.digest('hex')}`
}

function bootstrapSummaryForRoot(root: string): TransferBootstrapSummary {
  if (root === DATAMOAT_ROOT) {
    const summary = bootstrapCaptureSummary()
    return {
      present: summary.entries > 0,
      entries: summary.entries,
      portable: false,
    }
  }
  const bootstrapRoot = path.join(root, 'bootstrap-capture')
  let entries = 0
  try {
    entries = fs.existsSync(bootstrapRoot) ? fs.readdirSync(bootstrapRoot).length : 0
  } catch {
    entries = 0
  }
  return { present: entries > 0, entries, portable: false }
}

export function transferExportWarnings(root = DATAMOAT_ROOT): string[] {
  const warnings: string[] = []
  const auth = authSummaryForRoot(root)
  if (auth?.hasTouchId) warnings.push('touch-id-not-portable')
  if (auth?.hasBackgroundUnlock) warnings.push('background-unlock-not-portable')
  const bootstrap = bootstrapSummaryForRoot(root)
  if (bootstrap.present) warnings.push('bootstrap-capture-not-portable')
  if (!auth?.hasPassword && !auth?.hasMnemonic) {
    warnings.push('no-portable-unlock-method-detected')
  }
  return warnings
}

function sessionVaultWarnings(counts: TransferCounts): string[] {
  return counts.sessions > counts.vaultFiles ? ['session-index-missing-vault-files'] : []
}

export async function buildTransferManifest(options: { sessionCount?: number; root?: string } = {}): Promise<TransferManifest> {
  const root = path.resolve(options.root ?? DATAMOAT_ROOT)
  const auth = authSummaryForRoot(root)
  const counts = inspectTransferRoot(root)
  counts.sessions = Math.max(0, options.sessionCount ?? counts.vaultFiles)
  const warnings = [
    ...transferExportWarnings(root),
    ...sessionVaultWarnings(counts),
  ]
  return {
    format: TRANSFER_MANIFEST_FORMAT,
    createdAt: new Date().toISOString(),
    datamoatVersion: packageVersion(),
    platform: process.platform,
    arch: os.arch(),
    rootFingerprint: computeTransferRootFingerprint(root),
    rootPath: root,
    auth: auth ?? {
      hasPassword: false,
      hasMnemonic: false,
      hasTouchId: false,
      hasBackgroundUnlock: false,
      totpEnrolled: false,
    },
    counts,
    warnings,
    bootstrapCapture: bootstrapSummaryForRoot(root),
  }
}

function writePrivateJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
}

function rawRecordLine(record: RawRecord): string {
  return JSON.stringify(record)
}

async function prepareLegacyRawFileForTransfer(sessionId: string, session: Session): Promise<{
  migrated: boolean
  records: number
  legacyBytes: number
}> {
  const rawPath = path.join(RAW_DIR, makeRawPath(session.source, session.uid))
  const stat = safeStat(rawPath)
  if (!stat?.isFile()) return { migrated: false, records: 0, legacyBytes: 0 }

  const stream = fs.createReadStream(rawPath, { encoding: 'utf8' })
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let batch: string[] = []
  let records = 0

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return
    const current = batch
    batch = []
    const decoded = current[0].startsWith('{')
      ? current
      : await decryptLinesForSession(sessionId, current)
    const rawRecordLines: string[] = []
    for (const line of decoded) {
      if (!line.trim()) continue
      try {
        rawRecordLines.push(rawRecordLine(JSON.parse(line) as RawRecord))
      } catch {
        /* Keep export preparation resilient; malformed legacy raw lines were unreadable already. */
      }
    }
    if (rawRecordLines.length === 0) return
    await appendRawRecordArchiveLines(sessionId, session.source, session.uid, rawRecordLines)
    records += rawRecordLines.length
  }

  try {
    for await (const line of reader) {
      if (!line) continue
      batch.push(line)
      if (batch.length >= 500) await flush()
    }
    await flush()
  } finally {
    reader.close()
    stream.destroy()
  }

  if (records === 0) return { migrated: false, records: 0, legacyBytes: stat.size }
  await verifySourceArchive(sessionId, session.source, session.uid)
  fs.rmSync(rawPath, { force: true })
  return { migrated: true, records, legacyBytes: stat.size }
}

export async function prepareTransferRawArchives(options: { root?: string } = {}): Promise<{
  skipped: boolean
  legacyFiles: number
  migratedFiles: number
  migratedRecords: number
  legacyBytes: number
  rawArchiveBytes: number
}> {
  const root = path.resolve(options.root ?? DATAMOAT_ROOT)
  if (root !== DATAMOAT_ROOT) {
    return { skipped: true, legacyFiles: 0, migratedFiles: 0, migratedRecords: 0, legacyBytes: 0, rawArchiveBytes: 0 }
  }
  const sessionId = getVaultSessionId()
  if (!sessionId) {
    return { skipped: true, legacyFiles: 0, migratedFiles: 0, migratedRecords: 0, legacyBytes: 0, rawArchiveBytes: 0 }
  }

  const sessions = await loadSessions()
  for (const session of sessions) {
    if (Math.max(0, Number(session.messageCount || 0)) === 0) await appendMessages(session, [])
  }
  updateTransferPreparationStatus({
    phase: 'raw-archives',
    running: true,
    totalSessions: sessions.length,
    sessionsProcessed: 0,
    legacyFiles: 0,
    migratedFiles: 0,
    migratedRecords: 0,
    legacyBytes: 0,
    rawArchiveBytes: countMatchingFiles(RAW_ARCHIVE_DIR, () => true).bytes,
    currentSession: undefined,
  })

  let legacyFiles = 0
  let migratedFiles = 0
  let migratedRecords = 0
  let legacyBytes = 0
  let sessionsProcessed = 0
  for (const session of sessions) {
    updateTransferPreparationStatus({
      phase: 'raw-archives',
      currentSession: session.uid,
      sessionsProcessed,
      totalSessions: sessions.length,
      legacyFiles,
      migratedFiles,
      migratedRecords,
      legacyBytes,
    })
    const rawPath = path.join(RAW_DIR, makeRawPath(session.source, session.uid))
    if (!safeStat(rawPath)?.isFile()) {
      sessionsProcessed += 1
      continue
    }
    legacyFiles += 1
    const result = await prepareLegacyRawFileForTransfer(sessionId, session)
    sessionsProcessed += 1
    if (!result.migrated) continue
    migratedFiles += 1
    migratedRecords += result.records
    legacyBytes += result.legacyBytes
    updateTransferPreparationStatus({
      phase: 'raw-archives',
      sessionsProcessed,
      totalSessions: sessions.length,
      legacyFiles,
      migratedFiles,
      migratedRecords,
      legacyBytes,
    })
  }

  const rawArchiveBytes = countMatchingFiles(RAW_ARCHIVE_DIR, () => true).bytes
  updateTransferPreparationStatus({
    phase: 'raw-archives',
    sessionsProcessed: sessions.length,
    totalSessions: sessions.length,
    legacyFiles,
    migratedFiles,
    migratedRecords,
    legacyBytes,
    rawArchiveBytes,
    currentSession: undefined,
  })
  return { skipped: false, legacyFiles, migratedFiles, migratedRecords, legacyBytes, rawArchiveBytes }
}

async function writeTransferManifestOnce(options: { sessionCount?: number; root?: string } = {}): Promise<TransferManifest> {
  const root = path.resolve(options.root ?? DATAMOAT_ROOT)
  try {
    await prepareTransferRawArchives({ root })
    if (root === DATAMOAT_ROOT) updateTransferPreparationStatus({ phase: 'manifest', running: true })
    const manifest = await buildTransferManifest({ ...options, root })
    writePrivateJson(transferManifestPath(root), manifest)
    writePrivateJson(transferStateManifestPath(root), manifest)
    if (root === DATAMOAT_ROOT) {
      updateTransferPreparationStatus({
        phase: 'done',
        running: false,
        sessionsProcessed: manifest.counts.sessions,
        totalSessions: manifest.counts.sessions,
        rawArchiveBytes: manifest.counts.totalBytes,
        currentSession: undefined,
      })
    }
    return manifest
  } catch (error) {
    if (root === DATAMOAT_ROOT) {
      updateTransferPreparationStatus({
        phase: 'failed',
        running: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    throw error
  }
}

export async function writeTransferManifest(options: { sessionCount?: number; root?: string } = {}): Promise<TransferManifest> {
  const root = path.resolve(options.root ?? DATAMOAT_ROOT)
  if (root !== DATAMOAT_ROOT) return writeTransferManifestOnce(options)
  if (!activeTransferManifestWrite) {
    activeTransferManifestWrite = writeTransferManifestOnce({ ...options, root })
      .finally(() => {
        activeTransferManifestWrite = null
      })
  }
  return activeTransferManifestWrite
}

export async function transferExportStatus(options: { sessionCount?: number; root?: string } = {}): Promise<{
  root: string
  status: 'ready' | 'checking' | 'needs attention' | 'cannot transfer yet'
  counts: TransferCounts
  auth: TransferAuthSummary | null
  warnings: string[]
  required: { authJson: boolean; vault: boolean; sessionsJson: boolean }
  manifest: TransferManifest | null
  manifestPath: string
  stateManifestPath: string
  preparation: TransferExportPreparationStatus | null
}> {
  const root = path.resolve(options.root ?? DATAMOAT_ROOT)
  const required = {
    authJson: fs.existsSync(root === DATAMOAT_ROOT ? AUTH_FILE : path.join(root, 'auth.json')),
    vault: fs.existsSync(root === DATAMOAT_ROOT ? VAULT_DIR : path.join(root, 'vault')),
    sessionsJson: fs.existsSync(root === DATAMOAT_ROOT ? SESSIONS_FILE : path.join(root, 'state', 'sessions.json')),
  }
  const counts = inspectTransferRoot(root)
  counts.sessions = Math.max(0, options.sessionCount ?? counts.vaultFiles)
  const auth = authSummaryForRoot(root)
  const warnings = [
    ...transferExportWarnings(root),
    ...sessionVaultWarnings(counts),
  ]
  const preparation = root === DATAMOAT_ROOT ? currentTransferExportPreparationStatus() : null
  const manifest = safeJson<TransferManifest>(transferManifestPath(root))
    ?? safeJson<TransferManifest>(transferStateManifestPath(root))
  const requiredOk = required.authJson && required.vault && required.sessionsJson
  const hasPortableUnlock = !!(auth?.hasPassword || auth?.hasMnemonic)
  return {
    root,
    status: preparation?.running
      ? 'checking'
      : !requiredOk || !hasPortableUnlock
      ? 'cannot transfer yet'
      : warnings.length > 0
        ? 'needs attention'
        : 'ready',
    counts,
    auth,
    warnings,
    required,
    manifest,
    manifestPath: transferManifestPath(root),
    stateManifestPath: transferStateManifestPath(root),
    preparation,
  }
}

export async function openTransferFolder(root = DATAMOAT_ROOT): Promise<{ ok: boolean; path: string; error?: string }> {
  const resolved = path.resolve(root)
  if (!fs.existsSync(resolved)) return { ok: false, path: resolved, error: 'DataMoat folder does not exist yet' }
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd.exe'
      : 'xdg-open'
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', resolved]
    : [resolved]
  try {
    const child = childProcess.spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return { ok: true, path: resolved }
  } catch (error) {
    return { ok: false, path: resolved, error: error instanceof Error ? error.message : String(error) }
  }
}

export function transferExportPaths(): {
  root: string
  authFile: string
  vaultDir: string
  rawDir: string
  attachmentsDir: string
  skillsBackupDir: string
  stateDir: string
  sessionsFile: string
  bootstrapCaptureDir: string
} {
  return {
    root: DATAMOAT_ROOT,
    authFile: AUTH_FILE,
    vaultDir: VAULT_DIR,
    rawDir: RAW_DIR,
    attachmentsDir: ATTACHMENTS_DIR,
    skillsBackupDir: SKILLS_BACKUP_DIR,
    stateDir: STATE_DIR,
    sessionsFile: SESSIONS_FILE,
    bootstrapCaptureDir: BOOTSTRAP_CAPTURE_DIR,
  }
}
