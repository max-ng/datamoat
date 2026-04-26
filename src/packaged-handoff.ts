import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INSTALL_CHOICE_FILE, INSTALL_INFO_FILE } from './config'
import type { InstallInfo, InstallMode } from './install-context'
import { loadInstallInfo } from './install-context'

const HOME = os.homedir()
const MAC_LAUNCH_AGENTS_DIR = path.join(HOME, 'Library', 'LaunchAgents')

export type InstallPreference = 'packaged' | 'source'
export type InstallVariant = 'packaged' | 'source' | 'unknown'

export type InstallChoice = {
  schemaVersion: number
  preferred: InstallPreference
  chosenAt: string
  sourceRoot?: string | null
  sourceAppPath?: string | null
  packagedAppPath?: string | null
}

export type DualInstallState = {
  eligible: boolean
  currentExecutable: string
  currentAppPath: string | null
  currentVariant: InstallVariant
  sourceRoot: string | null
  packagedAppPath: string | null
  sourceAppPath: string | null
  hasBoth: boolean
  storedChoice: InstallChoice | null
}

export type InstallPreferenceApplyResult = {
  applied: boolean
  preference: InstallPreference
  disabledLaunchAgents: string[]
  restoredLaunchAgents: string[]
  stoppedPids: number[]
  updatedInstallInfo: boolean
  targetAppPath: string | null
}

type HandoffOptions = {
  currentExecutable?: string
}

type PsEntry = {
  pid: number
  command: string
}

function currentAppPathFromExecutable(executable: string): string | null {
  const marker = '.app/Contents/MacOS/'
  const index = executable.indexOf(marker)
  if (index === -1) return null
  return executable.slice(0, index + 4)
}

function sourceInstallAppPaths(info: InstallInfo | null): string[] {
  const paths = new Set<string>([
    path.join(HOME, '.datamoat', 'app', 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app'),
  ])
  if (info?.sourceRoot) {
    paths.add(path.join(info.sourceRoot, 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app'))
  }
  return [...paths].filter(candidate => fs.existsSync(candidate))
}

function packagedAppPaths(info: InstallInfo | null, currentAppPath: string | null): string[] {
  const candidates = new Set<string>()
  if (info?.packagedAppPath) candidates.add(info.packagedAppPath)
  candidates.add(path.join('/Applications', 'DataMoat.app'))
  candidates.add(path.join(HOME, 'Applications', 'DataMoat.app'))
  if (currentAppPath && !sourceInstallAppPaths(info).includes(currentAppPath)) {
    candidates.add(currentAppPath)
  }
  return [...candidates].filter(candidate => fs.existsSync(candidate))
}

function legacySourceDaemonScripts(info: InstallInfo | null): string[] {
  const scripts = new Set<string>([
    path.join(HOME, '.datamoat', 'app', 'dist', 'daemon.js'),
  ])
  if (info?.sourceRoot) {
    scripts.add(path.join(info.sourceRoot, 'dist', 'daemon.js'))
  }
  return [...scripts].filter(candidate => fs.existsSync(candidate))
}

function packagedDaemonScripts(info: InstallInfo | null, currentAppPath: string | null): string[] {
  const scripts = new Set<string>()
  for (const appPath of packagedAppPaths(info, currentAppPath)) {
    scripts.add(path.join(appPath, 'Contents', 'Resources', 'app', 'dist', 'daemon.js'))
  }
  return [...scripts].filter(candidate => fs.existsSync(candidate))
}

function sourceMarkers(info: InstallInfo | null): string[] {
  const markers = new Set<string>([
    path.join(HOME, '.datamoat', 'app') + path.sep,
  ])
  if (info?.sourceRoot) {
    markers.add(path.resolve(info.sourceRoot) + path.sep)
  }
  return [...markers]
}

function readPsEntries(): PsEntry[] {
  try {
    const out = child_process.execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        const match = line.match(/^(\d+)\s+(.*)$/)
        if (!match) return []
        const pid = Number(match[1])
        const command = match[2]
        if (!Number.isFinite(pid)) return []
        return [{ pid, command }]
      })
  } catch {
    return []
  }
}

function stopPids(pids: number[]): number[] {
  const unique = [...new Set(pids)].filter(pid => pid !== process.pid)
  for (const pid of unique) {
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }
  return unique
}

function matchingLegacyPids(currentExecutable: string, info: InstallInfo | null): number[] {
  const appPrefixes = sourceInstallAppPaths(info).map(appPath => path.join(appPath, 'Contents') + path.sep)
  const daemonScripts = legacySourceDaemonScripts(info)
  const currentAppPath = currentAppPathFromExecutable(currentExecutable)

  return readPsEntries()
    .filter(entry => {
      if (entry.pid === process.pid) return false
      if (entry.command.includes(currentExecutable)) return false
      if (currentAppPath && entry.command.includes(currentAppPath)) return false
      return appPrefixes.some(prefix => entry.command.includes(prefix))
        || daemonScripts.some(script => entry.command.includes(script))
    })
    .map(entry => entry.pid)
}

function matchingPackagedPids(currentExecutable: string, info: InstallInfo | null): number[] {
  const currentAppPath = currentAppPathFromExecutable(currentExecutable)
  const appPrefixes = packagedAppPaths(info, currentAppPath).map(appPath => path.join(appPath, 'Contents') + path.sep)
  const daemonScripts = packagedDaemonScripts(info, currentAppPath)

  return readPsEntries()
    .filter(entry => {
      if (entry.pid === process.pid) return false
      return appPrefixes.some(prefix => entry.command.includes(prefix))
        || daemonScripts.some(script => entry.command.includes(script))
    })
    .map(entry => entry.pid)
}

function unloadLaunchAgent(plistPath: string, label: string): void {
  try { child_process.execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }) } catch { /* ignore */ }
  if (typeof process.getuid === 'function') {
    try { child_process.execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, label], { stdio: 'ignore' }) } catch { /* ignore */ }
  }
}

function loadLaunchAgent(plistPath: string): void {
  try { child_process.execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' }) } catch { /* ignore */ }
}

function disableLegacyLaunchAgent(plistPath: string, label: string, markers: string[], currentExecutable: string): string | null {
  if (!fs.existsSync(plistPath)) return null
  const content = fs.readFileSync(plistPath, 'utf8')
  if (content.includes(currentExecutable)) return null
  if (!markers.some(marker => content.includes(marker))) return null

  unloadLaunchAgent(plistPath, label)
  const disabledPath = `${plistPath}.disabled-by-packaged`
  try { fs.rmSync(disabledPath, { force: true }) } catch { /* ignore */ }
  fs.renameSync(plistPath, disabledPath)
  return disabledPath
}

function restoreLaunchAgent(plistPath: string): string | null {
  const disabledPath = `${plistPath}.disabled-by-packaged`
  if (!fs.existsSync(disabledPath)) return null
  try { fs.rmSync(plistPath, { force: true }) } catch { /* ignore */ }
  fs.renameSync(disabledPath, plistPath)
  loadLaunchAgent(plistPath)
  return plistPath
}

function writeInstallInfo(info: InstallInfo | null, patch: Partial<InstallInfo>): boolean {
  const nextInfo: InstallInfo = {
    ...(info ?? {}),
    schemaVersion: 1,
    ...patch,
  }
  fs.writeFileSync(INSTALL_INFO_FILE, `${JSON.stringify(nextInfo, null, 2)}\n`, { mode: 0o600 })
  return true
}

export function loadInstallChoice(): InstallChoice | null {
  try {
    return JSON.parse(fs.readFileSync(INSTALL_CHOICE_FILE, 'utf8')) as InstallChoice
  } catch {
    return null
  }
}

export function clearInstallChoice(): void {
  try {
    fs.rmSync(INSTALL_CHOICE_FILE, { force: true })
  } catch {
    // ignore
  }
}

export function saveInstallChoice(preferred: InstallPreference, patch: Partial<InstallChoice> = {}): InstallChoice {
  const choice: InstallChoice = {
    schemaVersion: 1,
    preferred,
    chosenAt: new Date().toISOString(),
    ...patch,
  }
  fs.writeFileSync(INSTALL_CHOICE_FILE, `${JSON.stringify(choice, null, 2)}\n`, { mode: 0o600 })
  return choice
}

export function detectDualInstallState(options: HandoffOptions = {}): DualInstallState {
  const info = loadInstallInfo()
  const currentExecutable = options.currentExecutable ?? process.execPath
  const currentAppPath = currentAppPathFromExecutable(currentExecutable)
  const sourceAppPath = sourceInstallAppPaths(info)[0] ?? null
  const packagedAppPath = packagedAppPaths(info, currentAppPath)[0] ?? null
  const sourceRoot = info?.sourceRoot ?? null
  const currentVariant: InstallVariant = currentAppPath
    ? sourceInstallAppPaths(info).includes(currentAppPath)
      ? 'source'
      : 'packaged'
    : 'unknown'

  return {
    eligible: process.platform === 'darwin' && !!currentAppPath,
    currentExecutable,
    currentAppPath,
    currentVariant,
    sourceRoot,
    packagedAppPath,
    sourceAppPath,
    hasBoth: !!sourceAppPath && !!packagedAppPath && sourceAppPath !== packagedAppPath,
    storedChoice: loadInstallChoice(),
  }
}

export function applyInstallPreference(preference: InstallPreference, options: HandoffOptions = {}): InstallPreferenceApplyResult {
  const state = detectDualInstallState(options)
  const info = loadInstallInfo()
  const currentExecutable = state.currentExecutable
  const markers = sourceMarkers(info)
  const daemonPlist = path.join(MAC_LAUNCH_AGENTS_DIR, 'com.datamoat.daemon.plist')
  const trayPlist = path.join(MAC_LAUNCH_AGENTS_DIR, 'com.datamoat.tray.plist')

  saveInstallChoice(preference, {
    sourceRoot: info?.sourceRoot ?? null,
    sourceAppPath: state.sourceAppPath,
    packagedAppPath: state.packagedAppPath,
  })

  if (preference === 'packaged') {
    const disabledLaunchAgents = [
      disableLegacyLaunchAgent(daemonPlist, 'com.datamoat.daemon', markers, currentExecutable),
      disableLegacyLaunchAgent(trayPlist, 'com.datamoat.tray', markers, currentExecutable),
    ].filter((value): value is string => !!value)
    const stoppedPids = stopPids(matchingLegacyPids(currentExecutable, info))
    const updatedInstallInfo = state.packagedAppPath
      ? writeInstallInfo(info, {
          previousMode: info?.mode ?? 'unknown',
          mode: 'packaged',
          packagedAppPath: state.packagedAppPath,
          handoffFromSourceAt: new Date().toISOString(),
        })
      : false
    return {
      applied: disabledLaunchAgents.length > 0 || stoppedPids.length > 0 || updatedInstallInfo,
      preference,
      disabledLaunchAgents,
      restoredLaunchAgents: [],
      stoppedPids,
      updatedInstallInfo,
      targetAppPath: state.packagedAppPath,
    }
  }

  const restoredLaunchAgents = [
    restoreLaunchAgent(daemonPlist),
    restoreLaunchAgent(trayPlist),
  ].filter((value): value is string => !!value)
  const stoppedPids = stopPids(matchingPackagedPids(currentExecutable, info))

  const nextMode: InstallMode = info?.sourceRoot ? 'source-copy' : 'unknown'
  const updatedInstallInfo = writeInstallInfo(info, {
    previousMode: info?.mode ?? 'unknown',
    mode: nextMode,
  })

  return {
    applied: restoredLaunchAgents.length > 0 || stoppedPids.length > 0 || updatedInstallInfo,
    preference,
    disabledLaunchAgents: [],
    restoredLaunchAgents,
    stoppedPids,
    updatedInstallInfo,
    targetAppPath: state.sourceAppPath,
  }
}
