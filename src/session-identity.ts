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
