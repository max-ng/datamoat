import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { ANNOTATIONS_DIR } from './config'
import { getVaultSessionId } from './store'
import { decryptLinesForSession, encryptLinesForSession } from './vault-helper'
import { stableStringify, normalizedMessageKey } from './message-key'
import type { Message, Session } from './types'

// User annotations (bookmarks, votes, future labels) live in a third store,
// vault/annotations/<sessionAnchor>.jsonl, separate from raw and parsed data.
// Records are an append-only op log. State is a deterministic fold of the log,
// merges are unions deduped by opId, so export/import/restore in any order and
// any number of times always converges without losing or duplicating anything.
// Anchors are path-independent: sessions are keyed by their internal sessionId,
// messages by source uuid (verified stable across Claude resume/fork replays)
// with a content-hash fallback. See ANNOTATION_SYSTEM_DESIGN.md.

export type AnnotationScope = 'session' | 'message'
export type AnnotationKind = 'bookmark' | 'vote' | 'label'
export type AnnotationAction = 'set' | 'clear' | 'add' | 'remove'

export interface AnnotationOp {
  v: 1
  opId: string
  at: string
  device?: string
  target: {
    scope: AnnotationScope
    session: {
      source: string
      sourceAccount: string
      sessionId: string
      anchorWeak: boolean
    }
    message?: {
      uuid: string
      contentHash: string
      timestamp: string
      role: string
    }
  }
  kind: AnnotationKind
  action: AnnotationAction
  value?: unknown
}

export interface MessageAnnotationState {
  bookmark: boolean
  vote: 'up' | 'down' | null
  labels: string[]
}

export interface SessionAnnotationState {
  bookmark: boolean
  labels: string[]
  // Keyed by message uuid; entries that only resolved via contentHash are keyed
  // by `hash:<contentHash>` so the caller can still re-bind them.
  messages: Record<string, MessageAnnotationState>
  orphanCount: number
}

export function sessionAnchorForSession(session: Session): { anchor: string; weak: boolean } {
  const internalId = String(session.id || '').trim()
  const weak = internalId.length === 0
  const key = weak ? String(session.uid || '') : internalId
  const anchor = crypto
    .createHash('sha256')
    .update(`dmanno1\0${session.source}\0${session.sourceAccount ?? ''}\0${key}`)
    .digest('hex')
    .slice(0, 24)
  return { anchor, weak }
}

export function annotationFilePath(anchor: string): string {
  return path.join(ANNOTATIONS_DIR, `${anchor}.jsonl`)
}

export function messageContentHash(message: Message): string {
  return crypto.createHash('sha256').update(normalizedMessageKey(message)).digest('hex').slice(0, 24)
}

export function buildAnnotationOp(params: {
  session: Session
  scope: AnnotationScope
  message?: Message
  kind: AnnotationKind
  action: AnnotationAction
  value?: unknown
  at?: string
  device?: string
}): AnnotationOp {
  const { weak } = sessionAnchorForSession(params.session)
  const op: Omit<AnnotationOp, 'opId'> = {
    v: 1,
    at: params.at || new Date().toISOString(),
    ...(params.device ? { device: params.device } : {}),
    target: {
      scope: params.scope,
      session: {
        source: params.session.source,
        sourceAccount: params.session.sourceAccount ?? '',
        sessionId: String(params.session.id || params.session.uid || ''),
        anchorWeak: weak,
      },
      ...(params.scope === 'message' && params.message
        ? {
            message: {
              uuid: String(params.message.id || ''),
              contentHash: messageContentHash(params.message),
              timestamp: params.message.timestamp || '',
              role: params.message.role || '',
            },
          }
        : {}),
    },
    kind: params.kind,
    action: params.action,
    ...(params.value !== undefined ? { value: params.value } : {}),
  }
  return { ...op, opId: annotationOpId(op) }
}

export function annotationOpId(op: Omit<AnnotationOp, 'opId'>): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify({
      v: op.v,
      at: op.at,
      target: op.target,
      kind: op.kind,
      action: op.action,
      value: op.value === undefined ? null : op.value,
    }))
    .digest('hex')
    .slice(0, 24)
}

function ensureAnnotationsDir(): void {
  if (!fs.existsSync(ANNOTATIONS_DIR)) fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(ANNOTATIONS_DIR, 0o700) } catch { /* non-fatal */ }
}

function requireUnlockedSession(): string {
  const sessionId = getVaultSessionId()
  if (!sessionId) throw new Error('vault is locked')
  return sessionId
}

export async function appendAnnotationOps(anchor: string, ops: AnnotationOp[]): Promise<void> {
  if (ops.length === 0) return
  const helperSession = requireUnlockedSession()
  ensureAnnotationsDir()
  const serialized = ops.map(op => JSON.stringify(op))
  const encrypted = await encryptLinesForSession(helperSession, serialized)
  fs.appendFileSync(annotationFilePath(anchor), `${encrypted.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  try { fs.chmodSync(annotationFilePath(anchor), 0o600) } catch { /* non-fatal */ }
}

function parseAnnotationOpLine(line: string): AnnotationOp | null {
  try {
    const parsed = JSON.parse(line) as AnnotationOp
    if (!parsed || parsed.v !== 1 || !parsed.opId || !parsed.target) return null
    return parsed
  } catch {
    return null
  }
}

// Reads ops for one anchor: decrypt, drop malformed lines, dedupe by opId,
// sort by (at, opId) so the fold is deterministic everywhere.
export async function readAnnotationOps(anchor: string): Promise<AnnotationOp[]> {
  const filePath = annotationFilePath(anchor)
  if (!fs.existsSync(filePath)) return []
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
  if (lines.length === 0) return []
  const helperSession = requireUnlockedSession()
  const decoded = lines[0].startsWith('{') ? lines : await decryptLinesForSession(helperSession, lines)
  return dedupeAndSortOps(decoded.map(parseAnnotationOpLine).filter((op): op is AnnotationOp => op !== null))
}

export function dedupeAndSortOps(ops: AnnotationOp[]): AnnotationOp[] {
  const byId = new Map<string, AnnotationOp>()
  for (const op of ops) {
    if (!byId.has(op.opId)) byId.set(op.opId, op)
  }
  return [...byId.values()].sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1
    return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0
  })
}

// Union-merge incoming ops (e.g. from a backup/transfer import) into an anchor
// file. Idempotent: re-importing the same ops is a no-op. Rewrites atomically.
export async function mergeAnnotationOps(anchor: string, incoming: AnnotationOp[]): Promise<{ added: number; total: number }> {
  const existing = await readAnnotationOps(anchor)
  const existingIds = new Set(existing.map(op => op.opId))
  const newOps = dedupeAndSortOps(incoming).filter(op => !existingIds.has(op.opId))
  if (newOps.length === 0) return { added: 0, total: existing.length }
  const merged = dedupeAndSortOps([...existing, ...newOps])
  await rewriteAnnotationFile(anchor, merged)
  return { added: newOps.length, total: merged.length }
}

async function rewriteAnnotationFile(anchor: string, ops: AnnotationOp[]): Promise<void> {
  const helperSession = requireUnlockedSession()
  ensureAnnotationsDir()
  const filePath = annotationFilePath(anchor)
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  const serialized = ops.map(op => JSON.stringify(op))
  const encrypted = serialized.length > 0 ? await encryptLinesForSession(helperSession, serialized) : []
  fs.writeFileSync(tmpPath, encrypted.length > 0 ? `${encrypted.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmpPath, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch { /* non-fatal */ }
}

// Dedupe an anchor file in place (maintenance). Returns removed duplicate count.
export async function compactAnnotationFile(anchor: string): Promise<{ removedDuplicates: number }> {
  const filePath = annotationFilePath(anchor)
  if (!fs.existsSync(filePath)) return { removedDuplicates: 0 }
  const rawLineCount = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length
  const ops = await readAnnotationOps(anchor)
  if (ops.length === rawLineCount) return { removedDuplicates: 0 }
  await rewriteAnnotationFile(anchor, ops)
  return { removedDuplicates: rawLineCount - ops.length }
}

export function listAnnotationAnchors(): string[] {
  if (!fs.existsSync(ANNOTATIONS_DIR)) return []
  return fs.readdirSync(ANNOTATIONS_DIR)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => name.slice(0, -'.jsonl'.length))
}

function emptyMessageState(): MessageAnnotationState {
  return { bookmark: false, vote: null, labels: [] }
}

// Fold the op log into current state. LWW per (target, kind); labels fold
// per label value. Ops must already be deduped and sorted (readAnnotationOps).
// `knownMessageUuids`/`knownContentHashes` (when provided) classify message ops
// whose target no longer resolves as orphans instead of silently showing them.
export function foldAnnotationOps(
  ops: AnnotationOp[],
  known?: { uuids: Set<string>; contentHashes: Map<string, string> },
): SessionAnnotationState {
  const state: SessionAnnotationState = { bookmark: false, labels: [], messages: {}, orphanCount: 0 }
  const sessionLabels = new Map<string, boolean>()
  const messageLabels = new Map<string, Map<string, boolean>>()
  const orphanKeys = new Set<string>()

  for (const op of ops) {
    if (op.target.scope === 'session') {
      if (op.kind === 'bookmark') state.bookmark = op.action === 'set'
      else if (op.kind === 'label' && typeof op.value === 'string') sessionLabels.set(op.value, op.action === 'add')
      // Session-level votes are not part of the product (sessions only have
      // bookmark); ignore defensively if an op ever carries one.
      continue
    }
    const target = op.target.message
    if (!target) continue
    let key = target.uuid || ''
    if (known) {
      if (key && known.uuids.has(key)) {
        orphanKeys.delete(key)
      } else {
        const reboundUuid = target.contentHash ? known.contentHashes.get(target.contentHash) : undefined
        if (reboundUuid) {
          key = reboundUuid
        } else {
          orphanKeys.add(key || `hash:${target.contentHash}`)
          continue
        }
      }
    } else if (!key) {
      key = `hash:${target.contentHash}`
    }
    const messageState = state.messages[key] || emptyMessageState()
    if (op.kind === 'bookmark') messageState.bookmark = op.action === 'set'
    else if (op.kind === 'vote') {
      messageState.vote = op.action === 'set' && (op.value === 'up' || op.value === 'down') ? op.value : null
    } else if (op.kind === 'label' && typeof op.value === 'string') {
      const labels = messageLabels.get(key) || new Map<string, boolean>()
      labels.set(op.value, op.action === 'add')
      messageLabels.set(key, labels)
    }
    state.messages[key] = messageState
  }

  state.labels = [...sessionLabels.entries()].filter(([, on]) => on).map(([label]) => label).sort()
  for (const [key, labels] of messageLabels) {
    const messageState = state.messages[key] || emptyMessageState()
    messageState.labels = [...labels.entries()].filter(([, on]) => on).map(([label]) => label).sort()
    state.messages[key] = messageState
  }
  // Drop message entries folded down to "nothing annotated".
  for (const [key, value] of Object.entries(state.messages)) {
    if (!value.bookmark && !value.vote && value.labels.length === 0) delete state.messages[key]
  }
  state.orphanCount = orphanKeys.size
  return state
}
