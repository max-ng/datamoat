import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INSTALL_INFO_FILE } from './config'
import { isBranchAllowed, isBranchNameSafe, isRemoteAllowed, remoteToDisplay } from './update-policy'

export type InstallMode = 'source-copy' | 'source-dev' | 'packaged' | 'unknown'
export type UpdateStrategy = 'source-git-pull' | 'source-manual-reinstall' | 'packaged-auto-update' | 'packaged-auto-unavailable' | 'unknown'

export type InstallInfo = {
  schemaVersion?: number
  mode?: InstallMode
  sourceRoot?: string
  nodeBin?: string
  scriptLauncherBin?: string
  installedAt?: string
  previousMode?: InstallMode
  packagedAppPath?: string
  handoffFromSourceAt?: string
}

export type InstallContext = {
  mode: InstallMode
  updateStrategy: UpdateStrategy
  installInfo: InstallInfo | null
  root: string | null
  sourceRoot: string | null
  nodeBin: string | null
  reason: string | null
}

export function loadInstallInfo(): InstallInfo | null {
  try {
    return JSON.parse(fs.readFileSync(INSTALL_INFO_FILE, 'utf8')) as InstallInfo
  } catch {
    return null
  }
}

export function installRoot(): string {
  return path.join(__dirname, '..')
}

export function hasGitRepo(root: string): boolean {
  return fs.existsSync(path.join(root, '.git'))
}

function trustedGitCheckout(root: string): { ok: boolean; reason: string | null } {
  if (!hasGitRepo(root)) {
    return { ok: false, reason: `no git checkout found at ${root}` }
  }

  try {
    const remote = child_process.execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
    if (!isRemoteAllowed(remote)) {
      return { ok: false, reason: `remote is not in allow-list (${remoteToDisplay(remote)})` }
    }
  } catch {
    return { ok: false, reason: 'unable to read git origin remote' }
  }

  try {
    const branch = child_process.execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    if (!isBranchNameSafe(branch)) {
      return { ok: false, reason: `unsafe git branch name (${branch})` }
    }
    if (!isBranchAllowed(branch)) {
      return { ok: false, reason: `branch is not in allow-list (${branch})` }
    }
  } catch {
    return { ok: false, reason: 'unable to read current git branch' }
  }

  return { ok: true, reason: null }
}

function currentAppPathFromExecutable(executable: string): string | null {
  const marker = '.app/Contents/MacOS/'
  const index = executable.indexOf(marker)
  if (index === -1) return null
  return executable.slice(0, index + 4)
}

function sourceInstallAppPaths(info: InstallInfo | null): string[] {
  const home = os.homedir()
  const candidates = new Set<string>([
    path.join(home, '.datamoat', 'app', 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app'),
  ])
  if (info?.sourceRoot) {
    candidates.add(path.join(info.sourceRoot, 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app'))
  }
  return [...candidates].map(candidate => path.resolve(candidate))
}

function packagedInstallAppPaths(info: InstallInfo | null): string[] {
  const home = os.homedir()
  const candidates = new Set<string>([
    path.join('/Applications', 'DataMoat.app'),
    path.join(home, 'Applications', 'DataMoat.app'),
  ])
  if (info?.packagedAppPath) candidates.add(info.packagedAppPath)
  return [...candidates].map(candidate => path.resolve(candidate))
}

function looksPackagedInstall(root: string): boolean {
  return /\/Contents\/Resources\/app(?:\.asar)?$/.test(root)
}

function normalizeMode(info: InstallInfo | null, root: string): InstallMode {
  const currentAppPath = currentAppPathFromExecutable(process.execPath)
  if (currentAppPath) {
    const resolvedCurrentAppPath = path.resolve(currentAppPath)
    if (sourceInstallAppPaths(info).includes(resolvedCurrentAppPath)) return 'source-copy'
    if (packagedInstallAppPaths(info).includes(resolvedCurrentAppPath)) return 'packaged'
  }
  if (looksPackagedInstall(root)) return 'packaged'
  if (info?.mode === 'source-copy' || info?.mode === 'source-dev' || info?.mode === 'packaged') {
    return info.mode
  }
  if (info?.sourceRoot) return 'source-copy'
  if (hasGitRepo(root)) return 'source-dev'
  if (!!process.versions.electron) return 'packaged'
  return 'unknown'
}

export function detectInstallContext(): InstallContext {
  const info = loadInstallInfo()
  const root = installRoot()
  const mode = normalizeMode(info, root)
  const sourceRoot = info?.sourceRoot ?? null
  const nodeBin = info?.nodeBin ?? null

  if (mode === 'packaged') {
    return {
      mode,
      updateStrategy: process.platform === 'darwin' ? 'packaged-auto-update' : 'packaged-auto-unavailable',
      installInfo: info,
      root: null,
      sourceRoot,
      nodeBin,
      reason: process.platform === 'darwin'
        ? null
        : 'packaged app updates are not implemented on this platform',
    }
  }

  if (sourceRoot && hasGitRepo(sourceRoot)) {
    const trust = trustedGitCheckout(sourceRoot)
    if (trust.ok) {
      return {
        mode: 'source-copy',
        updateStrategy: 'source-git-pull',
        installInfo: info,
        root: sourceRoot,
        sourceRoot,
        nodeBin,
        reason: null,
      }
    }
    return {
      mode: 'source-copy',
      updateStrategy: 'source-manual-reinstall',
      installInfo: info,
      root: null,
      sourceRoot,
      nodeBin,
      reason: `source-copy install is linked to an untrusted git checkout: ${trust.reason}`,
    }
  }

  if (hasGitRepo(root)) {
    const trust = trustedGitCheckout(root)
    if (trust.ok) {
      return {
        mode: mode === 'unknown' ? 'source-dev' : mode,
        updateStrategy: 'source-git-pull',
        installInfo: info,
        root,
        sourceRoot,
        nodeBin,
        reason: null,
      }
    }
    return {
      mode: mode === 'unknown' ? 'source-dev' : mode,
      updateStrategy: 'source-manual-reinstall',
      installInfo: info,
      root: null,
      sourceRoot,
      nodeBin,
      reason: `git checkout is not trusted for automatic updates: ${trust.reason}`,
    }
  }

  if (mode === 'source-copy') {
    return {
      mode,
      updateStrategy: 'source-manual-reinstall',
      installInfo: info,
      root: null,
      sourceRoot,
      nodeBin,
      reason: sourceRoot
        ? `source-copy install is not linked to a live git checkout: ${sourceRoot}`
        : 'source-copy install is missing its original source root metadata',
    }
  }

  return {
    mode: 'unknown',
    updateStrategy: 'unknown',
    installInfo: info,
    root: null,
    sourceRoot,
    nodeBin,
    reason: 'install mode could not be determined; refusing automatic update',
  }
}
