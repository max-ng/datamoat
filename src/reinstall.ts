import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { launcherBinaryForScripts, launcherEnvForScripts } from './runtime'
import { hasGitRepo, loadInstallInfo } from './install-context'
import { isBranchAllowed, isBranchNameSafe, isRemoteAllowed, remoteToDisplay } from './update-policy'

export type ReinstallSourceInfo = {
  root: string | null
  installScriptPath: string | null
  available: boolean
  liveCheckout: boolean
  looksLikeDataMoat: boolean
  reason: string | null
}

function expandUserPath(input: string): string {
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

type PackageManifest = {
  name?: string
  repository?: string | { url?: string }
}

function repositoryUrlFromPackage(pkg: PackageManifest): string | null {
  if (typeof pkg.repository === 'string') return pkg.repository
  if (pkg.repository && typeof pkg.repository === 'object') {
    return typeof pkg.repository.url === 'string' ? pkg.repository.url : null
  }
  return null
}

function looksLikeDataMoatSource(root: string): { ok: boolean; reasons: string[] } {
  try {
    const pkgPath = path.join(root, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as PackageManifest
    if (pkg.name !== 'datamoat') return { ok: false, reasons: ['package name is not datamoat'] }

    const repo = repositoryUrlFromPackage(pkg)
    if (repo && !isRemoteAllowed(repo)) {
      return {
        ok: false,
        reasons: [`repository is not allow-listed for reinstall (${remoteToDisplay(repo)})`],
      }
    }

    if (!hasGitRepo(root)) {
      return {
        ok: false,
        reasons: ['reinstall from non-live snapshot is disabled for trusted-update-only mode'],
      }
    }

    try {
      const remote = child_process.execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
      if (!isRemoteAllowed(remote)) {
        return { ok: false, reasons: [`origin remote is not allow-listed (${remoteToDisplay(remote)})`] }
      }
    } catch {
      return { ok: false, reasons: ['unable to read git origin remote'] }
    }

    try {
      const branch = child_process.execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
      if (!isBranchNameSafe(branch)) {
        return { ok: false, reasons: [`unsafe git branch name (${branch})`] }
      }
      if (!isBranchAllowed(branch)) {
        return { ok: false, reasons: [`branch is not in allow-list for trusted updates (${branch})`] }
      }
    } catch {
      return { ok: false, reasons: ['unable to read current git branch'] }
    }

    return { ok: true, reasons: [] }
  } catch {
    return { ok: false, reasons: ['package.json missing or not parseable'] }
  }
}

export function inspectReinstallSource(sourcePath: string | null | undefined): ReinstallSourceInfo {
  const raw = (sourcePath || '').trim()
  if (!raw) {
    return {
      root: null,
      installScriptPath: null,
      available: false,
      liveCheckout: false,
      looksLikeDataMoat: false,
      reason: 'no source path configured',
    }
  }

  const root = path.resolve(expandUserPath(raw))
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      root,
      installScriptPath: null,
      available: false,
      liveCheckout: false,
      looksLikeDataMoat: false,
      reason: `source path does not exist: ${root}`,
    }
  }

  const installScriptPath = path.join(root, 'install.sh')
  if (!fs.existsSync(installScriptPath)) {
    return {
      root,
      installScriptPath: null,
      available: false,
      liveCheckout: false,
      looksLikeDataMoat: false,
      reason: `install.sh not found in source path: ${root}`,
    }
  }

  const validation = looksLikeDataMoatSource(root)
  if (!validation.ok) {
    return {
      root,
      installScriptPath,
      available: false,
      liveCheckout: false,
      looksLikeDataMoat: false,
      reason: `source path does not pass DataMoat source checks: ${validation.reasons.join('; ')}`
    }
  }

  return {
    root,
    installScriptPath,
    available: true,
    liveCheckout: hasGitRepo(root),
    looksLikeDataMoat: true,
    reason: null,
  }
}

export function recordedReinstallSource(): ReinstallSourceInfo {
  return inspectReinstallSource(loadInstallInfo()?.sourceRoot ?? null)
}

export function triggerDetachedReinstall(sourcePath: string): boolean {
  try {
    child_process.spawn(
      launcherBinaryForScripts(),
      [path.join(__dirname, 'reinstall-worker.js'), sourcePath],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...launcherEnvForScripts(), DATAMOAT_REINSTALL_SOURCE: sourcePath },
      },
    ).unref()
    return true
  } catch {
    return false
  }
}
