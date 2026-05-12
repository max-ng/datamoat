import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  SKILLS_BACKUP_DIR,
  SKILLS_BLOBS_DIR,
  SKILLS_INDEX_FILE,
  SKILLS_MANIFESTS_DIR,
} from './config'
import {
  getCaptureSessionId,
  getVaultSessionId,
  loadSessions,
} from './store'
import { Session } from './types'
import { decryptBytesForSession, encryptBytesForSession } from './vault-helper'
import { updateHealth, writeAuditEvent, writeLog } from './logging'

type SkillScope = 'global' | 'project'

type SkillRootCandidate = {
  scope: SkillScope
  tool: 'claude' | 'codex' | 'agents'
  root: string
  project?: string
}

type SkillFileRecord = {
  path: string
  sha256: string
  size: number
  mtimeMs: number
  mode: number
}

type SkillRootSelection = {
  roots: SkillRootCandidate[]
  skippedProtectedProjects: Map<string, string>
}

export type SkillSnapshotManifest = {
  version: 1
  snapshotId: string
  scope: SkillScope
  tool: string
  skill: string
  root: string
  project?: string
  capturedAt: string
  files: SkillFileRecord[]
  skipped: Array<{ path: string; reason: string }>
}

export type SkillScanIndex = {
  version: 1
  updatedAt: string
  reason: string
  rootsScanned: number
  skillsBackedUp: number
  filesBackedUp: number
  uniqueBlobs: number
  snapshots: Array<{
    snapshotId: string
    scope: SkillScope
    tool: string
    skill: string
    root: string
    project?: string
    fileCount: number
  }>
}

const USER_HOME = os.homedir()
const MAX_SKILL_FILE_BYTES = 25 * 1024 * 1024
const MAX_SKILL_FILES = 5000
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.cache',
  'cache',
  'tmp',
  '.tmp',
  'dist',
  'build',
  '.next',
  '__pycache__',
])
const SKIP_FILES = new Set([
  '.DS_Store',
])

let scanInFlight: Promise<SkillScanIndex | null> | null = null

function ensurePrivateDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dirPath, 0o700)
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

function sha256(buf: Buffer | string): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function readableDir(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function isSameOrInsidePath(candidate: string, parent: string): boolean {
  const resolvedCandidate = path.resolve(candidate)
  const resolvedParent = path.resolve(parent)
  return resolvedCandidate === resolvedParent || resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
}

export function protectedMacUserContentPathKind(dirPath: string): string | null {
  if (process.platform !== 'darwin') return null
  const protectedRoots = [
    ['downloads', path.join(USER_HOME, 'Downloads')],
    ['desktop', path.join(USER_HOME, 'Desktop')],
    ['documents', path.join(USER_HOME, 'Documents')],
    ['icloud', path.join(USER_HOME, 'Library', 'Mobile Documents')],
    ['cloud-storage', path.join(USER_HOME, 'Library', 'CloudStorage')],
  ] as const
  for (const [kind, root] of protectedRoots) {
    if (isSameOrInsidePath(dirPath, root)) return kind
  }
  return null
}

function writeSessionId(): string | null {
  return getCaptureSessionId() ?? getVaultSessionId()
}

function ancestorsForProject(cwd: string): string[] {
  const start = path.resolve(cwd)
  const dirs: string[] = []
  let current = start
  while (current && current !== path.dirname(current)) {
    if (current === USER_HOME) break
    if (!current.startsWith(USER_HOME)) break
    dirs.push(current)
    current = path.dirname(current)
  }
  return dirs
}

function selectCandidateRoots(sessions: Session[]): SkillRootSelection {
  const roots: SkillRootCandidate[] = [
    { scope: 'global', tool: 'claude', root: path.join(USER_HOME, '.claude', 'skills') },
    { scope: 'global', tool: 'codex', root: path.join(USER_HOME, '.codex', 'skills') },
    { scope: 'global', tool: 'agents', root: path.join(USER_HOME, '.agents', 'skills') },
  ]

  const projectDirs = new Set<string>()
  const skippedProtectedProjects = new Map<string, string>()
  for (const session of sessions) {
    if (!session.cwd || !path.isAbsolute(session.cwd)) continue
    for (const dir of ancestorsForProject(session.cwd)) {
      const protectedKind = protectedMacUserContentPathKind(dir)
      if (protectedKind) {
        skippedProtectedProjects.set(dir, protectedKind)
        continue
      }
      projectDirs.add(dir)
    }
  }

  for (const project of projectDirs) {
    roots.push({ scope: 'project', tool: 'claude', root: path.join(project, '.claude', 'skills'), project })
    roots.push({ scope: 'project', tool: 'codex', root: path.join(project, '.codex', 'skills'), project })
    roots.push({ scope: 'project', tool: 'agents', root: path.join(project, '.agents', 'skills'), project })
  }

  const seen = new Set<string>()
  const readableRoots = roots.filter(root => {
    const key = `${root.scope}\0${root.tool}\0${path.resolve(root.root)}`
    if (seen.has(key)) return false
    seen.add(key)
    return readableDir(root.root)
  })
  return { roots: readableRoots, skippedProtectedProjects }
}

export function candidateRootsForSkillsBackup(sessions: Session[]): SkillRootCandidate[] {
  return selectCandidateRoots(sessions).roots
}

function walkForSkillDirs(root: string): string[] {
  const skillDirs = new Set<string>()
  const visit = (dirPath: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        skillDirs.add(dirPath)
        continue
      }
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      visit(fullPath)
    }
  }
  visit(root)
  return Array.from(skillDirs).sort()
}

function walkSkillFiles(skillDir: string): { files: SkillFileRecord[]; skipped: Array<{ path: string; reason: string }> } {
  const files: SkillFileRecord[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  const visit = (dirPath: string): void => {
    if (files.length >= MAX_SKILL_FILES) {
      skipped.push({ path: path.relative(skillDir, dirPath) || '.', reason: 'file_limit' })
      return
    }
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      skipped.push({ path: path.relative(skillDir, dirPath) || '.', reason: 'unreadable' })
      return
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const relPath = path.relative(skillDir, fullPath)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push({ path: relPath, reason: 'ignored_directory' })
          continue
        }
        visit(fullPath)
        continue
      }
      if (!entry.isFile()) {
        skipped.push({ path: relPath, reason: 'not_regular_file' })
        continue
      }
      if (SKIP_FILES.has(entry.name)) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(fullPath)
      } catch {
        skipped.push({ path: relPath, reason: 'unreadable' })
        continue
      }
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        skipped.push({ path: relPath, reason: 'too_large' })
        continue
      }
      const bytes = fs.readFileSync(fullPath)
      files.push({
        path: relPath,
        sha256: sha256(bytes),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode & 0o777,
      })
      if (files.length >= MAX_SKILL_FILES) {
        skipped.push({ path: '.', reason: 'file_limit' })
        return
      }
    }
  }

  visit(skillDir)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, skipped }
}

function snapshotIdFor(root: SkillRootCandidate, skillDir: string, files: SkillFileRecord[]): string {
  const input = JSON.stringify({
    scope: root.scope,
    tool: root.tool,
    root: path.resolve(root.root),
    skillDir: path.resolve(skillDir),
    files: files.map(file => [file.path, file.sha256, file.size]),
  })
  return sha256(input).slice(0, 32)
}

function skillNameFor(root: SkillRootCandidate, skillDir: string): string {
  const rel = path.relative(root.root, skillDir)
  return rel && rel !== '.' ? rel : path.basename(skillDir)
}

function blobPath(hash: string): string {
  return path.join(SKILLS_BLOBS_DIR, `${hash}.dmenc`)
}

async function writeEncryptedJson(filePath: string, sessionId: string, value: unknown): Promise<void> {
  const encrypted = await encryptBytesForSession(sessionId, Buffer.from(JSON.stringify(value, null, 2), 'utf8'))
  writePrivateBytes(filePath, encrypted)
}

async function backupSkillFolder(root: SkillRootCandidate, skillDir: string, sessionId: string, capturedAt: string): Promise<SkillSnapshotManifest> {
  const { files, skipped } = walkSkillFiles(skillDir)
  for (const file of files) {
    const dest = blobPath(file.sha256)
    if (fs.existsSync(dest)) continue
    const sourcePath = path.join(skillDir, file.path)
    const encrypted = await encryptBytesForSession(sessionId, fs.readFileSync(sourcePath))
    writePrivateBytes(dest, encrypted)
  }

  const snapshotId = snapshotIdFor(root, skillDir, files)
  const manifest: SkillSnapshotManifest = {
    version: 1,
    snapshotId,
    scope: root.scope,
    tool: root.tool,
    skill: skillNameFor(root, skillDir),
    root: skillDir,
    ...(root.project ? { project: root.project } : {}),
    capturedAt,
    files,
    skipped,
  }
  const manifestPath = path.join(SKILLS_MANIFESTS_DIR, `${snapshotId}.json.dmenc`)
  if (!fs.existsSync(manifestPath)) await writeEncryptedJson(manifestPath, sessionId, manifest)
  return manifest
}

export async function scanAndBackupSkills(reason = 'automatic'): Promise<SkillScanIndex | null> {
  if (scanInFlight) return scanInFlight
  scanInFlight = scanAndBackupSkillsInner(reason).finally(() => {
    scanInFlight = null
  })
  return scanInFlight
}

export async function readSkillsBackupIndexForUI(): Promise<SkillScanIndex | null> {
  const sessionId = getVaultSessionId()
  if (!sessionId || !fs.existsSync(SKILLS_INDEX_FILE)) return null
  try {
    const decrypted = await decryptBytesForSession(sessionId, fs.readFileSync(SKILLS_INDEX_FILE))
    return JSON.parse(decrypted.toString('utf8')) as SkillScanIndex
  } catch (error) {
    writeLog('warn', 'skills-backup', 'read_index_failed', { error })
    return null
  }
}

function validSnapshotId(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value)
}

export async function readSkillManifestForUI(snapshotId: string): Promise<SkillSnapshotManifest | null> {
  const sessionId = getVaultSessionId()
  if (!sessionId || !validSnapshotId(snapshotId)) return null
  const manifestPath = path.join(SKILLS_MANIFESTS_DIR, `${snapshotId}.json.dmenc`)
  if (!fs.existsSync(manifestPath)) return null
  try {
    const decrypted = await decryptBytesForSession(sessionId, fs.readFileSync(manifestPath))
    return JSON.parse(decrypted.toString('utf8')) as SkillSnapshotManifest
  } catch (error) {
    writeLog('warn', 'skills-backup', 'read_manifest_failed', { snapshotId, error })
    return null
  }
}

export async function readSkillFileForUI(
  snapshotId: string,
  relativePath: string,
): Promise<{
  path: string
  sha256: string
  size: number
  text?: string
  base64?: string
  binary: boolean
  truncated: boolean
} | null> {
  const sessionId = getVaultSessionId()
  if (!sessionId) return null
  const manifest = await readSkillManifestForUI(snapshotId)
  if (!manifest) return null
  const normalizedPath = relativePath.replace(/\\/g, '/')
  if (normalizedPath.startsWith('/') || normalizedPath.includes('../')) return null
  const file = manifest.files.find(item => item.path === normalizedPath)
  if (!file) return null
  const encryptedPath = blobPath(file.sha256)
  if (!fs.existsSync(encryptedPath)) return null

  const bytes = await decryptBytesForSession(sessionId, fs.readFileSync(encryptedPath))
  const binary = bytes.includes(0)
  const maxTextBytes = 200 * 1024
  if (!binary) {
    const shown = bytes.subarray(0, maxTextBytes).toString('utf8')
    return {
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      text: shown,
      binary: false,
      truncated: bytes.length > maxTextBytes,
    }
  }
  return {
    path: file.path,
    sha256: file.sha256,
    size: file.size,
    base64: bytes.length <= maxTextBytes ? bytes.toString('base64') : undefined,
    binary: true,
    truncated: bytes.length > maxTextBytes,
  }
}

async function scanAndBackupSkillsInner(reason: string): Promise<SkillScanIndex | null> {
  const sessionId = writeSessionId()
  if (!sessionId) {
    updateHealth('skills-backup', {
      running: false,
      lastSkippedAt: new Date().toISOString(),
      lastSkippedReason: 'vault_session_missing',
    })
    return null
  }

  const startedAt = new Date().toISOString()
  updateHealth('skills-backup', {
    running: true,
    startedAt,
    reason,
  })
  writeLog('info', 'skills-backup', 'scan_started', { reason })

  try {
    ensurePrivateDir(SKILLS_BACKUP_DIR)
    ensurePrivateDir(SKILLS_BLOBS_DIR)
    ensurePrivateDir(SKILLS_MANIFESTS_DIR)

    const sessions = await loadSessions()
    const selectedRoots = selectCandidateRoots(sessions)
    const roots = selectedRoots.roots
    if (selectedRoots.skippedProtectedProjects.size > 0) {
      const kinds = Array.from(new Set(selectedRoots.skippedProtectedProjects.values())).sort()
      updateHealth('skills-backup', {
        skippedProtectedProjectRoots: selectedRoots.skippedProtectedProjects.size,
        skippedProtectedProjectRootKinds: kinds,
        skippedProtectedProjectRootsAt: new Date().toISOString(),
      })
      writeLog('info', 'skills-backup', 'protected_project_roots_skipped', {
        count: selectedRoots.skippedProtectedProjects.size,
        kinds,
      })
    }
    const manifests: SkillSnapshotManifest[] = []
    for (const root of roots) {
      for (const skillDir of walkForSkillDirs(root.root)) {
        manifests.push(await backupSkillFolder(root, skillDir, sessionId, startedAt))
      }
    }

    const uniqueBlobs = new Set<string>()
    let fileCount = 0
    for (const manifest of manifests) {
      fileCount += manifest.files.length
      for (const file of manifest.files) uniqueBlobs.add(file.sha256)
    }

    const index: SkillScanIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      reason,
      rootsScanned: roots.length,
      skillsBackedUp: manifests.length,
      filesBackedUp: fileCount,
      uniqueBlobs: uniqueBlobs.size,
      snapshots: manifests.map(manifest => ({
        snapshotId: manifest.snapshotId,
        scope: manifest.scope,
        tool: manifest.tool,
        skill: manifest.skill,
        root: manifest.root,
        ...(manifest.project ? { project: manifest.project } : {}),
        fileCount: manifest.files.length,
      })),
    }
    await writeEncryptedJson(SKILLS_INDEX_FILE, sessionId, index)

    updateHealth('skills-backup', {
      running: false,
      lastScanAt: index.updatedAt,
      reason,
      rootsScanned: index.rootsScanned,
      skillsBackedUp: index.skillsBackedUp,
      filesBackedUp: index.filesBackedUp,
      uniqueBlobs: index.uniqueBlobs,
    })
    writeAuditEvent('skills-backup', 'skills_backup_scanned', {
      reason,
      rootsScanned: index.rootsScanned,
      skillsBackedUp: index.skillsBackedUp,
      filesBackedUp: index.filesBackedUp,
      uniqueBlobs: index.uniqueBlobs,
    })
    writeLog('info', 'skills-backup', 'scan_done', {
      reason,
      rootsScanned: index.rootsScanned,
      skillsBackedUp: index.skillsBackedUp,
      filesBackedUp: index.filesBackedUp,
      uniqueBlobs: index.uniqueBlobs,
    })
    return index
  } catch (error) {
    updateHealth('skills-backup', {
      running: false,
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    })
    writeLog('error', 'skills-backup', 'scan_failed', { error })
    return null
  }
}
