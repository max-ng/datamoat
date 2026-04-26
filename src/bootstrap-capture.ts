import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { OffsetState, Source } from './types'
import {
  BOOTSTRAP_CAPTURE_DIR,
  BOOTSTRAP_CAPTURE_FILE,
  BOOTSTRAP_CAPTURE_INDEX_FILE,
  STATE_DIR,
} from './config'
import {
  bootstrapCaptureSecretDelete,
  bootstrapCaptureSecretLoad,
  bootstrapCaptureSecretStore,
} from './keychain'
import {
  createSessionFromSecret,
  decryptLinesForSession,
  decryptStateForSession,
  encryptLinesForSession,
  encryptStateForSession,
  lockVaultSession,
} from './vault-helper'

const BOOTSTRAP_CAPTURE_SCHEMA_VERSION = 1
const BOOTSTRAP_CAPTURE_MODE = 'capture_only'
const BOOTSTRAP_INDEX_PREFIX = 'dmbootstrap1:'

export type BootstrapCaptureState = {
  schemaVersion: number
  enabled: boolean
  mode: typeof BOOTSTRAP_CAPTURE_MODE
  requestedBy: string | null
  createdAt: string
}

type BootstrapCaptureEntry = {
  source: Source
  originalPath: string
  spoolFile: string
  offset: number
  lastMod: number
  sessionId?: string
}

type BootstrapCaptureIndex = {
  schemaVersion: number
  updatedAt: string
  entries: Record<string, BootstrapCaptureEntry>
}

let bootstrapSessionId: string | null = null

function ensurePrivateDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dirPath, 0o700)
  } catch {
    /* non-fatal */
  }
}

function writePrivateText(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath))
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(tmpPath, 0o600)
  } catch {
    /* non-fatal */
  }
  fs.renameSync(tmpPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function spoolIdFor(source: Source, originalPath: string): string {
  return crypto.createHash('sha256').update(`${source}:${originalPath}`).digest('hex')
}

function spoolFileFor(source: Source, originalPath: string): string {
  return path.join(BOOTSTRAP_CAPTURE_DIR, source, `${spoolIdFor(source, originalPath)}.jsonl`)
}

function normalizeState(raw: Partial<BootstrapCaptureState> | null): BootstrapCaptureState | null {
  if (!raw || raw.enabled !== true) return null
  return {
    schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
    enabled: true,
    mode: BOOTSTRAP_CAPTURE_MODE,
    requestedBy: typeof raw.requestedBy === 'string' ? raw.requestedBy : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  }
}

function ensureBootstrapCaptureDirs(): void {
  ensurePrivateDir(STATE_DIR)
  ensurePrivateDir(BOOTSTRAP_CAPTURE_DIR)
}

async function ensureBootstrapCaptureSecret(): Promise<string> {
  const existing = await bootstrapCaptureSecretLoad()
  if (existing) return existing
  const secret = crypto.randomBytes(32).toString('hex')
  await bootstrapCaptureSecretStore(secret)
  return secret
}

async function ensureBootstrapCaptureSession(): Promise<string> {
  if (bootstrapSessionId) return bootstrapSessionId
  const secret = await ensureBootstrapCaptureSecret()
  bootstrapSessionId = await createSessionFromSecret(secret)
  return bootstrapSessionId
}

export async function stopBootstrapCaptureSession(): Promise<void> {
  if (!bootstrapSessionId) return
  const sessionId = bootstrapSessionId
  bootstrapSessionId = null
  await lockVaultSession(sessionId)
}

export async function preflightBootstrapCapture(): Promise<boolean> {
  try {
    await ensureBootstrapCaptureSession()
    await stopBootstrapCaptureSession()
    return true
  } catch {
    return false
  }
}

async function loadIndexRaw(): Promise<BootstrapCaptureIndex> {
  if (!fs.existsSync(BOOTSTRAP_CAPTURE_INDEX_FILE)) {
    return {
      schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      entries: {},
    }
  }

  try {
    const raw = fs.readFileSync(BOOTSTRAP_CAPTURE_INDEX_FILE, 'utf8').trim()
    if (!raw) {
      return {
        schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        entries: {},
      }
    }
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Partial<BootstrapCaptureIndex>
      return {
        schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries as Record<string, BootstrapCaptureEntry> : {},
      }
    }
    const sessionId = await ensureBootstrapCaptureSession()
    const payload = raw.startsWith(BOOTSTRAP_INDEX_PREFIX) ? raw.slice(BOOTSTRAP_INDEX_PREFIX.length) : raw
    const decrypted = await decryptStateForSession(sessionId, payload)
    const parsed = JSON.parse(decrypted) as Partial<BootstrapCaptureIndex>
    return {
      schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries as Record<string, BootstrapCaptureEntry> : {},
    }
  } catch {
    return {
      schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      entries: {},
    }
  }
}

async function saveIndex(entries: Record<string, BootstrapCaptureEntry>): Promise<void> {
  ensureBootstrapCaptureDirs()
  const sessionId = await ensureBootstrapCaptureSession()
  const encrypted = await encryptStateForSession(sessionId, JSON.stringify({
    schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries,
  }, null, 2))
  writePrivateText(BOOTSTRAP_CAPTURE_INDEX_FILE, `${BOOTSTRAP_INDEX_PREFIX}${encrypted}`)
}

function countBootstrapSpoolFiles(): number {
  if (!fs.existsSync(BOOTSTRAP_CAPTURE_DIR)) return 0
  const stack = [BOOTSTRAP_CAPTURE_DIR]
  let count = 0
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile()) count += 1
    }
  }
  return count
}

export function loadBootstrapCaptureState(): BootstrapCaptureState | null {
  return normalizeState(readJsonFile<Partial<BootstrapCaptureState>>(BOOTSTRAP_CAPTURE_FILE))
}

export function isBootstrapCaptureEnabled(): boolean {
  return !!loadBootstrapCaptureState()
}

export function enableBootstrapCapture(requestedBy: string | null): BootstrapCaptureState {
  ensureBootstrapCaptureDirs()
  const state: BootstrapCaptureState = {
    schemaVersion: BOOTSTRAP_CAPTURE_SCHEMA_VERSION,
    enabled: true,
    mode: BOOTSTRAP_CAPTURE_MODE,
    requestedBy,
    createdAt: new Date().toISOString(),
  }
  writePrivateText(BOOTSTRAP_CAPTURE_FILE, JSON.stringify(state, null, 2))
  return state
}

export function disableBootstrapCapture(): void {
  try {
    if (fs.existsSync(BOOTSTRAP_CAPTURE_FILE)) fs.unlinkSync(BOOTSTRAP_CAPTURE_FILE)
  } catch {
    /* non-fatal */
  }
}

export async function loadBootstrapOffsetState(): Promise<OffsetState> {
  const idx = await loadIndexRaw()
  const offsets: OffsetState = {}
  for (const entry of Object.values(idx.entries)) {
    offsets[entry.originalPath] = {
      offset: entry.offset,
      source: entry.source,
      lastMod: entry.lastMod,
      sessionId: entry.sessionId ?? '',
    }
  }
  return offsets
}

export async function listBootstrapEntries(): Promise<BootstrapCaptureEntry[]> {
  return Object.values((await loadIndexRaw()).entries)
}

export async function appendBootstrapCapture(params: {
  source: Source
  originalPath: string
  lines: string[]
  offset: number
  lastMod: number
  sessionId?: string
}): Promise<void> {
  if (params.lines.length === 0) return
  ensureBootstrapCaptureDirs()
  const sessionId = await ensureBootstrapCaptureSession()
  const spoolFile = spoolFileFor(params.source, params.originalPath)
  ensurePrivateDir(path.dirname(spoolFile))
  const encryptedLines = await encryptLinesForSession(sessionId, params.lines)
  fs.appendFileSync(spoolFile, `${encryptedLines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(spoolFile, 0o600)
  } catch {
    /* non-fatal */
  }

  const entries = (await loadIndexRaw()).entries
  entries[params.originalPath] = {
    source: params.source,
    originalPath: params.originalPath,
    spoolFile,
    offset: params.offset,
    lastMod: params.lastMod,
    sessionId: params.sessionId,
  }
  await saveIndex(entries)
}

export async function readBootstrapCaptureLines(filePath: string): Promise<string[]> {
  const sessionId = await ensureBootstrapCaptureSession()
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim())
  if (lines.length === 0) return []
  return await decryptLinesForSession(sessionId, lines)
}

export async function markBootstrapEntryImported(originalPath: string): Promise<void> {
  const idx = await loadIndexRaw()
  const entry = idx.entries[originalPath]
  if (!entry) return
  try {
    if (fs.existsSync(entry.spoolFile)) fs.unlinkSync(entry.spoolFile)
  } catch {
    /* non-fatal */
  }
  delete idx.entries[originalPath]
  await saveIndex(idx.entries)
}

export async function clearBootstrapCaptureData(): Promise<void> {
  try {
    if (fs.existsSync(BOOTSTRAP_CAPTURE_INDEX_FILE)) fs.unlinkSync(BOOTSTRAP_CAPTURE_INDEX_FILE)
  } catch {
    /* non-fatal */
  }
  try {
    if (fs.existsSync(BOOTSTRAP_CAPTURE_DIR)) fs.rmSync(BOOTSTRAP_CAPTURE_DIR, { recursive: true, force: true })
  } catch {
    /* non-fatal */
  }
  await stopBootstrapCaptureSession()
  await bootstrapCaptureSecretDelete()
}

export function bootstrapCaptureSummary(): { enabled: boolean; requestedBy: string | null; createdAt: string | null; entries: number } {
  const state = loadBootstrapCaptureState()
  return {
    enabled: !!state,
    requestedBy: state?.requestedBy ?? null,
    createdAt: state?.createdAt ?? null,
    entries: countBootstrapSpoolFiles(),
  }
}
