import * as fs from 'fs'
import * as child_process from 'child_process'
import { CONFIG_FILE, UPDATE_LOCK_FILE, UPDATE_STATUS_FILE } from './config'
import { InstallMode, UpdateStrategy, detectInstallContext } from './install-context'
import { ensureDirs } from './store'
import { isBranchAllowed, isRemoteAllowed } from './update-policy'

export const APP_CONFIG_SCHEMA_VERSION = 1
export const DEFAULT_AUTO_UPDATE_INTERVAL_HOURS = 6

export type AppConfig = {
  schemaVersion: number
  autoUpdateEnabled: boolean
  autoUpdateIntervalHours: number
}

export type UpdateResult =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'updating'
  | 'installing'
  | 'updated'
  | 'blocked'
  | 'unsupported'
  | 'error'

export type UpdateState = {
  running: boolean
  lastCheckedAt: string | null
  lastAppliedAt: string | null
  lastResult: UpdateResult
  message: string | null
  installMode: InstallMode | null
  updateStrategy: UpdateStrategy | null
  supported: boolean | null
  currentVersion: string | null
  availableVersion: string | null
  downloadedVersion: string | null
  downloadProgressPercent: number | null
  branch: string | null
  remote: string | null
  ahead: number | null
  behind: number | null
  clean: boolean | null
  updatedAt: string | null
}

type UpdateLock = {
  pid: number
  startedAt: string
}

const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: APP_CONFIG_SCHEMA_VERSION,
  autoUpdateEnabled: false,
  autoUpdateIntervalHours: DEFAULT_AUTO_UPDATE_INTERVAL_HOURS,
}

const DEFAULT_STATE: UpdateState = {
  running: false,
  lastCheckedAt: null,
  lastAppliedAt: null,
  lastResult: 'idle',
  message: null,
  installMode: null,
  updateStrategy: null,
  supported: null,
  currentVersion: null,
  availableVersion: null,
  downloadedVersion: null,
  downloadProgressPercent: null,
  branch: null,
  remote: null,
  ahead: null,
  behind: null,
  clean: null,
  updatedAt: null,
}

function isTrustedSourceForAutoUpdate(): boolean {
  const context = detectInstallContext()
  if (context.updateStrategy !== 'source-git-pull' || !context.root) return false

  try {
    const remote = child_process
      .execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: context.root, encoding: 'utf8' })
      .trim()
    if (!isRemoteAllowed(remote)) return false

    const branch = child_process
      .execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: context.root, encoding: 'utf8' })
      .trim()
    return isBranchAllowed(branch)
  } catch {
    return false
  }
}

function isPackagedAutoUpdateSupported(): boolean {
  const context = detectInstallContext()
  return context.updateStrategy === 'packaged-auto-update'
}

function isAutoUpdateSupportedOnThisInstall(): boolean {
  return isTrustedSourceForAutoUpdate() || isPackagedAutoUpdateSupported()
}

function defaultAutoUpdateEnabled(): boolean {
  return isAutoUpdateSupportedOnThisInstall()
}

function parseJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function loadAppConfig(): AppConfig {
  const parsed = parseJsonFile<Partial<AppConfig>>(CONFIG_FILE) || {}
  const interval = Number(parsed.autoUpdateIntervalHours)
  const requestedAutoUpdate = typeof parsed.autoUpdateEnabled === 'boolean' ? parsed.autoUpdateEnabled : defaultAutoUpdateEnabled()
  return {
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
    autoUpdateEnabled: requestedAutoUpdate && isAutoUpdateSupportedOnThisInstall(),
    autoUpdateIntervalHours: Number.isFinite(interval) && interval >= 1
      ? Math.max(1, Math.round(interval))
      : DEFAULT_AUTO_UPDATE_INTERVAL_HOURS,
  }
}

export function saveAppConfig(next: Partial<AppConfig>): AppConfig {
  ensureDirs()
  const supportedInstall = isAutoUpdateSupportedOnThisInstall()
  const nextConfig = { ...next }
  if (typeof nextConfig.autoUpdateEnabled === 'boolean' && nextConfig.autoUpdateEnabled && !supportedInstall) {
    nextConfig.autoUpdateEnabled = false
  }
  const config = {
    ...loadAppConfig(),
    ...nextConfig,
    schemaVersion: APP_CONFIG_SCHEMA_VERSION,
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
  return config
}

export function readUpdateLock(): UpdateLock | null {
  const lock = parseJsonFile<UpdateLock>(UPDATE_LOCK_FILE)
  if (!lock?.pid || !isPidRunning(lock.pid)) return null
  return lock
}

export function isUpdateRunning(): boolean {
  return !!readUpdateLock()
}

export function acquireUpdateLock(): boolean {
  ensureDirs()
  if (readUpdateLock()) return false
  const payload: UpdateLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  try {
    fs.writeFileSync(UPDATE_LOCK_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export function releaseUpdateLock(): void {
  try {
    const lock = parseJsonFile<UpdateLock>(UPDATE_LOCK_FILE)
    if (lock?.pid && lock.pid !== process.pid && isPidRunning(lock.pid)) return
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(UPDATE_LOCK_FILE)) fs.unlinkSync(UPDATE_LOCK_FILE)
  } catch {
    // ignore
  }
}

export function loadUpdateState(): UpdateState {
  const parsed = parseJsonFile<Partial<UpdateState>>(UPDATE_STATUS_FILE) || {}
  const context = detectInstallContext()
  const state: UpdateState = {
    ...DEFAULT_STATE,
    ...parsed,
    installMode: context.mode,
    updateStrategy: context.updateStrategy,
    running: isUpdateRunning(),
  }
  if (
    context.updateStrategy !== 'source-git-pull'
    && context.updateStrategy !== 'packaged-auto-update'
    && context.updateStrategy !== 'packaged-manual-update'
  ) {
    state.supported = false
    state.branch = null
    state.remote = null
    state.ahead = null
    state.behind = null
    state.clean = null
    if (state.lastResult !== 'error' && state.lastResult !== 'unsupported') {
      state.lastResult = 'unsupported'
    }
  } else if (context.updateStrategy === 'packaged-auto-update' || context.updateStrategy === 'packaged-manual-update') {
    state.branch = null
    state.remote = null
    state.ahead = null
    state.behind = null
    state.clean = null
    if (state.supported === null) state.supported = true
    if (context.updateStrategy === 'packaged-manual-update' && state.lastResult === 'unsupported') {
      state.lastResult = 'idle'
      state.message = null
    }
  }
  return state
}

export function writeUpdateState(next: Partial<UpdateState>): UpdateState {
  ensureDirs()
  const context = detectInstallContext()
  const state: UpdateState = {
    ...loadUpdateState(),
    ...next,
    installMode: context.mode,
    updateStrategy: context.updateStrategy,
    running: typeof next.running === 'boolean' ? next.running : isUpdateRunning(),
    updatedAt: new Date().toISOString(),
  }
  if (
    context.updateStrategy !== 'source-git-pull'
    && context.updateStrategy !== 'packaged-auto-update'
    && context.updateStrategy !== 'packaged-manual-update'
  ) {
    state.supported = false
    state.branch = null
    state.remote = null
    state.ahead = null
    state.behind = null
    state.clean = null
    if (state.lastResult !== 'error' && state.lastResult !== 'unsupported') {
      state.lastResult = 'unsupported'
    }
  } else if (context.updateStrategy === 'packaged-auto-update' || context.updateStrategy === 'packaged-manual-update') {
    state.supported = typeof state.supported === 'boolean' ? state.supported : true
    state.branch = null
    state.remote = null
    state.ahead = null
    state.behind = null
    state.clean = null
  }
  fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify(state, null, 2), { mode: 0o600 })
  return state
}
