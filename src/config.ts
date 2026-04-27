import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Source } from './types'

const USER_HOME = os.homedir()
export const DATAMOAT_ROOT = process.env.DATAMOAT_HOME?.trim()
  ? path.resolve(process.env.DATAMOAT_HOME.trim())
  : path.join(USER_HOME, '.datamoat')

function envRoots(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  return raw
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value))
}

export const VAULT_DIR        = path.join(DATAMOAT_ROOT, 'vault')
export const ATTACHMENTS_DIR  = path.join(DATAMOAT_ROOT, 'vault', 'attachments')
export const RAW_DIR          = path.join(DATAMOAT_ROOT, 'vault', 'raw')
export const STATE_DIR   = path.join(DATAMOAT_ROOT, 'state')
export const LOG_FILE    = path.join(DATAMOAT_ROOT, 'daemon.log')
export const PID_FILE    = path.join(DATAMOAT_ROOT, 'daemon.pid')
export const OFFSETS_FILE = path.join(STATE_DIR, 'offsets.json')
export const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json')
export const PUBLIC_STATUS_FILE = path.join(STATE_DIR, 'status.json')
export const HEALTH_FILE = path.join(STATE_DIR, 'health.json')
export const CRASH_FILE = path.join(STATE_DIR, 'crash.jsonl')
export const AUDIT_FILE = path.join(STATE_DIR, 'audit.jsonl')
export const INSTALL_INFO_FILE = path.join(STATE_DIR, 'install-source.json')
export const INSTALL_CHOICE_FILE = path.join(STATE_DIR, 'install-choice.json')
export const UPDATE_STATUS_FILE = path.join(STATE_DIR, 'update-status.json')
export const UPDATE_LOCK_FILE = path.join(STATE_DIR, 'update.lock')
export const BOOTSTRAP_CAPTURE_FILE = path.join(STATE_DIR, 'bootstrap-capture.json')
export const BOOTSTRAP_CAPTURE_INDEX_FILE = path.join(STATE_DIR, 'bootstrap-capture-index.json')
export const CONFIG_FILE  = path.join(DATAMOAT_ROOT, 'config.json')
export const AUTH_FILE    = path.join(DATAMOAT_ROOT, 'auth.json')
export const BOOTSTRAP_CAPTURE_DIR = path.join(DATAMOAT_ROOT, 'bootstrap-capture')

export const ALL_SOURCES: readonly Source[] = ['claude-cli', 'codex-cli', 'claude-app', 'openclaw']

const STATIC_WATCH_PATHS: Record<Exclude<Source, 'openclaw'>, string[]> = {
  'claude-cli': envRoots('DATAMOAT_CLAUDE_CLI_ROOTS', [
    path.join(USER_HOME, '.claude', 'projects'),
  ]),
  'codex-cli': envRoots('DATAMOAT_CODEX_CLI_ROOTS', [
    path.join(USER_HOME, '.codex', 'sessions'),
  ]),
  'claude-app': envRoots('DATAMOAT_CLAUDE_APP_ROOTS', [
    path.join(USER_HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
  ]),
}

function readableDir(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

function listSiblingHomes(baseDir: string): string[] {
  if (!readableDir(baseDir)) return []
  try {
    return fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => path.join(baseDir, entry.name))
  } catch {
    return []
  }
}

function discoverOpenclawRoots(): string[] {
  const roots = new Set<string>()
  const envRoots = (process.env.DATAMOAT_OPENCLAW_ROOTS || '')
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean)

  const homeCandidates = new Set<string>(
    envRoots.length > 0
      ? envRoots
      : process.platform === 'darwin'
        ? [USER_HOME]
        : [
            USER_HOME,
            ...listSiblingHomes('/home'),
            ...listSiblingHomes('/Users'),
            '/root',
          ],
  )

  for (const root of [...homeCandidates, ...envRoots]) {
    const clawRoot = root.endsWith('.openclaw') ? root : path.join(root, '.openclaw')
    const agentsDir = path.join(clawRoot, 'agents')
    const cronRunsDir = path.join(clawRoot, 'cron', 'runs')
    if (readableDir(agentsDir)) roots.add(agentsDir)
    if (readableDir(cronRunsDir)) roots.add(cronRunsDir)
  }

  return Array.from(roots)
}

export function resolveWatchPaths(): Record<Source, string[]> {
  return {
    ...STATIC_WATCH_PATHS,
    'openclaw': discoverOpenclawRoots(),
  }
}

export const GLOB_PATTERNS = {
  'claude-cli':  '**/*.jsonl',
  'codex-cli':   '**/*.jsonl',
  'claude-app':  '**/audit.jsonl',
  'openclaw':    '**/*.jsonl',
} as const

export const UI_PORT_RANGE = { min: 49200, max: 49300 }
