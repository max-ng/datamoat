import * as crypto from 'crypto'
import * as path from 'path'
import type { Session, Source } from './types'

function usernameFromPath(filePath: string): string | null {
  const normalized = path.resolve(filePath)
  const parts = normalized.split(path.sep).filter(Boolean)
  const usersIdx = parts.indexOf('Users')
  if (usersIdx >= 0 && parts[usersIdx + 1]) return parts[usersIdx + 1]
  const homeIdx = parts.indexOf('home')
  if (homeIdx >= 0 && parts[homeIdx + 1]) return parts[homeIdx + 1]
  return null
}

function userHomeFromPath(filePath: string): string | null {
  const normalized = path.resolve(filePath)
  const parts = normalized.split(path.sep).filter(Boolean)
  const usersIdx = parts.indexOf('Users')
  if (usersIdx >= 0 && parts[usersIdx + 1]) return `${path.sep}Users${path.sep}${parts[usersIdx + 1]}`
  const homeIdx = parts.indexOf('home')
  if (homeIdx >= 0 && parts[homeIdx + 1]) return `${path.sep}home${path.sep}${parts[homeIdx + 1]}`
  return null
}

export function sourceAccountFromPath(source: Source, filePath: string): string | undefined {
  const normalized = path.resolve(filePath)
  const user = usernameFromPath(normalized) ?? 'unknown'

  if (source === 'cursor') {
    const marker = `${path.sep}.cursor${path.sep}projects${path.sep}`
    const markerIdx = normalized.indexOf(marker)
    if (markerIdx === -1) return user
    const afterRoot = normalized.slice(markerIdx + marker.length)
    const parts = afterRoot.split(path.sep).filter(Boolean)
    return parts[0] ? `${user}/${parts[0]}` : user
  }

  if (source !== 'openclaw') return undefined
  const userHome = userHomeFromPath(normalized)
  const marker = `${path.sep}.openclaw${path.sep}`
  const markerIdx = normalized.indexOf(marker)
  if (markerIdx === -1) return user
  const beforeRoot = userHome && markerIdx > userHome.length
    ? normalized.slice(userHome.length, markerIdx).replace(new RegExp(`^${path.sep}+|${path.sep}+$`, 'g'), '')
    : ''
  const scope = beforeRoot
    ? beforeRoot.split(path.sep).filter(Boolean).join('/')
    : ''
  const afterRoot = normalized.slice(markerIdx + marker.length)
  const parts = afterRoot.split(path.sep).filter(Boolean)
  if (parts[0] === 'agents' && parts[1]) return scope ? `${user}/${scope}/${parts[1]}` : `${user}/${parts[1]}`
  if (parts[0] === 'cron') return scope ? `${user}/${scope}/cron` : `${user}/cron`
  return user
}

export function buildSessionUid(params: {
  source: Source
  sourceAccount?: string
  sessionId: string
  originalPath: string
}): string {
  return crypto
    .createHash('sha256')
    .update(`${params.source}\0${params.sourceAccount ?? ''}\0${params.sessionId}\0${path.resolve(params.originalPath)}`)
    .digest('hex')
    .slice(0, 24)
}

// Claude Code creates a NEW session file (new filename) every time a session is
// resumed or forked, but the resumed file replays the whole prior transcript and
// keeps the ORIGINAL internal sessionId. Because buildSessionUid mixes in the file
// path, each such file otherwise becomes a separate vault session holding a
// near-duplicate copy of the same conversation. Group those copies by their shared
// (source, account, sessionId) so capture can route them into one canonical session
// and maintenance can merge existing duplicates.
export function claudeForkGroupKey(
  source: Source,
  sourceAccount: string | undefined,
  sessionId: string,
): string | null {
  if (source !== 'claude-cli' && source !== 'claude-app') return null
  if (!sessionId) return null
  return `${source}\0${sourceAccount ?? ''}\0${sessionId}`
}

export function claudeForkGroupKeyForSession(session: Session): string | null {
  return claudeForkGroupKey(session.source, session.sourceAccount, session.id)
}

export interface ForkMemberIdentity {
  uid: string
  id: string
  originalPath: string
}

// A resumed/forked group's canonical member is the original "root" file — the one
// whose filename equals the internal sessionId. Resume/fork files get fresh
// filenames, so only the root matches. When no root file is present (e.g. it was
// deleted or compacted away), fall back to the lexicographically smallest uid so
// both capture and maintenance always agree on the same target.
export function pickCanonicalForkUid<T extends ForkMemberIdentity>(members: T[]): string {
  let root: T | null = null
  let smallest: T | null = null
  for (const member of members) {
    if (!smallest || member.uid < smallest.uid) smallest = member
    const base = path.basename(member.originalPath, '.jsonl')
    if (base && base === member.id && (!root || member.uid < root.uid)) root = member
  }
  return (root ?? smallest)?.uid ?? members[0]?.uid ?? ''
}

export function normalizeSessionIdentity(session: Session): Session {
  const sourceAccount = session.sourceAccount ?? sourceAccountFromPath(session.source, session.originalPath)
  const uid = session.uid ?? buildSessionUid({
    source: session.source,
    sourceAccount,
    sessionId: session.id,
    originalPath: session.originalPath,
  })
  return { ...session, uid, sourceAccount }
}
