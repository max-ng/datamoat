import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import type { Session } from './types'

type TitleMapCache = {
  mtimeMs: number
  size: number
  titles: Map<string, string>
}

const codexTitleCache = new Map<string, TitleMapCache>()
let cursorTitleCache: { checkedAt: number; titles: Map<string, string> } | null = null
const CURSOR_TITLE_CACHE_MS = 5000

function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.trim()
  return title ? title : undefined
}

function pathExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}

function findAncestorNamed(filePath: string, name: string): string | null {
  let current = path.resolve(filePath)
  if (!path.extname(current)) current = path.resolve(current)
  let dir = current
  for (;;) {
    if (path.basename(dir) === name) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function codexSessionIndexPath(originalPath: string): string | null {
  const sessionsDir = findAncestorNamed(originalPath, 'sessions')
    || findAncestorNamed(originalPath, 'archived_sessions')
  if (!sessionsDir) return null
  return path.join(path.dirname(sessionsDir), 'session_index.jsonl')
}

function readCodexTitleMap(indexPath: string): Map<string, string> {
  try {
    const stat = fs.statSync(indexPath)
    const cached = codexTitleCache.get(indexPath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.titles
    }

    const titles = new Map<string, string>()
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line) as Record<string, unknown>
        const id = cleanTitle(record.id)
        const title = cleanTitle(record.thread_name)
        if (id && title) titles.set(id, title)
      } catch {
        /* skip bad sidecar rows */
      }
    }
    codexTitleCache.set(indexPath, { mtimeMs: stat.mtimeMs, size: stat.size, titles })
    return titles
  } catch {
    return new Map()
  }
}

export function codexSessionTitle(originalPath: string, sessionId: string): string | undefined {
  const indexPath = codexSessionIndexPath(originalPath)
  if (!indexPath || !pathExists(indexPath)) return undefined
  return readCodexTitleMap(indexPath).get(sessionId)
}

function cursorGlobalStateDbCandidates(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return [path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
  }
  return [
    path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    path.join(home, '.cursor', 'User', 'globalStorage', 'state.vscdb'),
  ]
}

function readCursorComposerHeaders(dbPath: string): unknown {
  const result = spawnSync('sqlite3', [
    dbPath,
    "select value from ItemTable where key='composer.composerHeaders';",
  ], {
    encoding: 'utf8',
    timeout: 1500,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.status !== 0 || !result.stdout.trim()) return null
  try {
    return JSON.parse(result.stdout.trim())
  } catch {
    return null
  }
}

function readCursorTitleMap(): Map<string, string> {
  const now = Date.now()
  if (cursorTitleCache && now - cursorTitleCache.checkedAt < CURSOR_TITLE_CACHE_MS) {
    return cursorTitleCache.titles
  }

  const titles = new Map<string, string>()
  for (const dbPath of cursorGlobalStateDbCandidates()) {
    if (!pathExists(dbPath)) continue
    const headers = readCursorComposerHeaders(dbPath)
    if (!headers || typeof headers !== 'object') continue
    const allComposers = (headers as Record<string, unknown>).allComposers
    if (!Array.isArray(allComposers)) continue
    for (const item of allComposers) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const id = cleanTitle(record.composerId)
      const title = cleanTitle(record.name)
      if (id && title) titles.set(id, title)
    }
  }

  cursorTitleCache = { checkedAt: now, titles }
  return titles
}

export function cursorSessionTitle(sessionId: string): string | undefined {
  return readCursorTitleMap().get(sessionId)
}

export function titleForSession(session: Session): string | undefined {
  if (session.source === 'codex-cli') {
    return codexSessionTitle(session.originalPath, session.id)
  }
  if (session.source === 'cursor') {
    return cursorSessionTitle(session.id)
  }
  if (session.source === 'chatgpt-export') {
    return cleanTitle(session.title) || cleanTitle(session.cwd)
  }
  return cleanTitle(session.title)
}

export function refreshSessionTitles(sessions: Session[]): { sessions: Session[]; changed: boolean } {
  let changed = false
  const next = sessions.map(session => {
    const title = titleForSession(session)
    if (!title || title === session.title) return session
    changed = true
    return { ...session, title }
  })
  return { sessions: next, changed }
}
