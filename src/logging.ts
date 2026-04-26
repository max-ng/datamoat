import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { AUDIT_FILE, CRASH_FILE, HEALTH_FILE, LOG_FILE } from './config'
import { detectInstallContext } from './install-context'
import type { AuditEntry } from './types'

type LogLevel = 'info' | 'warn' | 'error'

function ensureStateDirFor(filePath: string): void {
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* non-fatal */
  }
}

type HealthState = {
  updatedAt: string
  version: string
  platform: string
  mode: 'source' | 'packaged' | 'unknown'
  components: Record<string, Record<string, unknown>>
}

function installMode(): 'source' | 'packaged' | 'unknown' {
  const mode = detectInstallContext().mode
  if (mode === 'packaged') return 'packaged'
  if (mode === 'source-copy' || mode === 'source-dev') return 'source'
  return 'unknown'
}

function packageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json')
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function readHealth(): HealthState {
  try {
    return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) as HealthState
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      version: packageVersion(),
      platform: process.platform,
      mode: installMode(),
      components: {},
    }
  }
}

function writeHealth(state: HealthState): void {
  ensureStateDirFor(HEALTH_FILE)
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
}

function redactString(value: string): string {
  return value
    .replace(/[A-Fa-f0-9]{48,}/g, '[REDACTED_HEX]')
    .replace(/[A-Za-z0-9+/=]{80,}/g, '[REDACTED_BLOB]')
    .replace(/\b(password|secret|token|mnemonic|recovery(?:Code)?|vaultKey)\b\s*[:=]\s*([^\s,]+)/gi, '$1=[REDACTED]')
}

function sanitize(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(sanitize)
  if (value instanceof Error) return safeError(value)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitize(entry)]),
    )
  }
  return String(value)
}

export function safeError(error: unknown): Record<string, unknown> {
  const err = error instanceof Error ? error : new Error(String(error))
  const stack = err.stack || err.message
  return {
    name: err.name || 'Error',
    message: redactString(err.message || 'unknown error'),
    stackHash: crypto.createHash('sha256').update(stack).digest('hex').slice(0, 16),
  }
}

export function writeLog(level: LogLevel, component: string, event: string, fields: Record<string, unknown> = {}): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    component,
    event,
    fields: sanitize(fields),
  }

  if (process.env.DATAMOAT_DEBUG_LOGS === '1') {
    try {
      ensureStateDirFor(LOG_FILE)
      fs.appendFileSync(LOG_FILE, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
    } catch {
      /* non-fatal */
    }
  }
}

function auditLines(): string[] {
  try {
    return fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function auditHash(payload: Omit<AuditEntry, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function writeAuditEvent(component: string, event: string, fields: Record<string, unknown> = {}): void {
  try {
    const lines = auditLines()
    let prevHash: string | null = null
    if (lines.length > 0) {
      try {
        const previous = JSON.parse(lines[lines.length - 1]) as AuditEntry
        prevHash = previous.hash
      } catch {
        prevHash = crypto.createHash('sha256').update(lines[lines.length - 1]).digest('hex')
      }
    }

    const payload: Omit<AuditEntry, 'hash'> = {
      version: 1,
      ts: new Date().toISOString(),
      component,
      event,
      fields: sanitize(fields) as Record<string, unknown>,
      prevHash,
    }
    const entry: AuditEntry = {
      ...payload,
      hash: auditHash(payload),
    }
    ensureStateDirFor(AUDIT_FILE)
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    updateHealth('audit', {
      lastEventAt: entry.ts,
      lastEventComponent: component,
      lastEvent: event,
      lastHash: entry.hash,
    })
  } catch (error) {
    writeLog('warn', 'audit', 'audit_write_failed', { error: safeError(error) })
    try {
      updateHealth('audit', {
        lastErrorAt: new Date().toISOString(),
        lastError: safeError(error),
      })
    } catch {
      /* ignore */
    }
  }
}

export function verifyAuditChain(): { ok: boolean; entries: number; lastHash: string | null; error?: string } {
  const lines = auditLines()
  let previousHash: string | null = null

  for (let index = 0; index < lines.length; index += 1) {
    let entry: AuditEntry
    try {
      entry = JSON.parse(lines[index]) as AuditEntry
    } catch {
      return { ok: false, entries: index, lastHash: previousHash, error: `invalid JSON at line ${index + 1}` }
    }

    const { hash, ...payload } = entry
    const expectedHash = auditHash(payload)
    if (entry.prevHash !== previousHash) {
      return {
        ok: false,
        entries: index,
        lastHash: previousHash,
        error: `hash chain mismatch at line ${index + 1}`,
      }
    }
    if (entry.hash !== expectedHash) {
      return {
        ok: false,
        entries: index,
        lastHash: previousHash,
        error: `content hash mismatch at line ${index + 1}`,
      }
    }
    previousHash = entry.hash
  }

  return { ok: true, entries: lines.length, lastHash: previousHash }
}

export function updateHealth(component: string, patch: Record<string, unknown>): void {
  const health = readHealth()
  health.updatedAt = new Date().toISOString()
  health.version = packageVersion()
  health.platform = process.platform
  health.mode = installMode()
  health.components[component] = {
    ...(health.components[component] || {}),
    ...sanitize(patch) as Record<string, unknown>,
  }
  writeHealth(health)
}

export function recordCrash(component: string, error: unknown, extra: Record<string, unknown> = {}): void {
  try {
    const payload = {
      ts: new Date().toISOString(),
      component,
      version: packageVersion(),
      platform: process.platform,
      mode: installMode(),
      error: safeError(error),
      extra: sanitize(extra),
    }

    let existing = ''
    try { existing = fs.readFileSync(CRASH_FILE, 'utf8') } catch { /* ignore */ }
    const lines = existing.split('\n').filter(Boolean).slice(-19)
    lines.push(JSON.stringify(payload))
    try {
      ensureStateDirFor(CRASH_FILE)
      fs.writeFileSync(CRASH_FILE, `${lines.join('\n')}\n`, { mode: 0o600 })
    } catch {
      /* non-fatal: crash logger must never throw */
    }
    try {
      updateHealth(component, { lastCrashAt: payload.ts, lastCrash: payload.error })
    } catch {
      /* non-fatal: crash logger must never throw */
    }
  } catch {
    /* non-fatal: crash logger must never throw */
  }
}

export function installCrashHandlers(component: string): void {
  process.on('uncaughtException', error => {
    recordCrash(component, error, { source: 'uncaughtException' })
    process.exit(1)
  })
  process.on('unhandledRejection', reason => {
    recordCrash(component, reason, { source: 'unhandledRejection' })
    process.exit(1)
  })
}
