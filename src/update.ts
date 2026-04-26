import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { InstallMode, UpdateStrategy, detectInstallContext } from './install-context'
import { ensureDaemonRunning, findDaemonPids, nodeBinaryForBuildTasks, stopDaemonPids } from './runtime'
import { isBranchAllowed, isBranchNameSafe, isRemoteAllowed, remoteToDisplay } from './update-policy'

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return child_process.execFileSync(cmd, args, { cwd, env, encoding: 'utf8' }).trim()
}

function installScriptEnv(): NodeJS.ProcessEnv {
  const nodeBin = nodeBinaryForBuildTasks()
  return {
    ...process.env,
    NODE_BIN: nodeBin,
    PATH: `${path.dirname(nodeBin)}:${process.env.PATH || ''}`,
  }
}

export type UpdateStatus =
  | { supported: false; reason: string; mode: InstallMode; strategy: UpdateStrategy }
  | {
      supported: true
      mode: InstallMode
      strategy: UpdateStrategy
      root: string
      branch: string
      current: string
      remote: string
      ahead: number
      behind: number
      clean: boolean
    }

export function updateBlockReason(status: UpdateStatus): string | null {
  if (!status.supported) return status.reason
  if (!status.clean) return 'working tree has local changes; skipping automatic update'
  if (status.ahead > 0 && status.behind > 0) return 'local branch has diverged from origin; manual merge required'
  if (status.ahead > 0) return 'local branch has local commits; skipping automatic update'
  if (status.behind === 0) return 'already up to date'
  return null
}

export function checkForUpdate(): UpdateStatus {
  const context = detectInstallContext()
  if (!context.root) {
    return {
      supported: false,
      reason: context.reason || 'automatic update is not available for this install',
      mode: context.mode,
      strategy: context.updateStrategy,
    }
  }

  try {
    const remote = run('git', ['remote', 'get-url', 'origin'], context.root)
    if (!isRemoteAllowed(remote)) {
      return {
        supported: false,
        reason: `update blocked: remote is not in allow-list (${remoteToDisplay(remote)})`,
        mode: context.mode,
        strategy: context.updateStrategy,
      }
    }

    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], context.root)
    if (!isBranchNameSafe(branch)) {
      return {
        supported: false,
        reason: `update blocked: unsafe git branch name (${branch})`,
        mode: context.mode,
        strategy: context.updateStrategy,
      }
    }
    if (!isBranchAllowed(branch)) {
      return {
        supported: false,
        reason: `update blocked: branch not in allow-list (${branch})`,
        mode: context.mode,
        strategy: context.updateStrategy,
      }
    }

    run('git', ['fetch', '--quiet', 'origin', branch], context.root)
    const current = run('git', ['rev-parse', 'HEAD'], context.root)
    const ahead = Number(run('git', ['rev-list', '--count', `origin/${branch}..HEAD`], context.root) || '0')
    const behind = Number(run('git', ['rev-list', '--count', `HEAD..origin/${branch}`], context.root) || '0')
    const clean = run('git', ['status', '--porcelain'], context.root).length === 0
    return {
      supported: true,
      mode: context.mode,
      strategy: context.updateStrategy,
      root: context.root,
      branch,
      current,
      remote,
      ahead,
      behind,
      clean,
    }
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
      mode: context.mode,
      strategy: context.updateStrategy,
    }
  }
}

export async function applyUpdate(): Promise<{ updated: boolean; root: string; version: string }> {
  const status = checkForUpdate()
  if (!status.supported) throw new Error(status.reason)
  if (!status.clean) throw new Error('update blocked: working tree has local changes')
  if (status.ahead > 0 && status.behind > 0) throw new Error('update blocked: local branch has diverged from origin')
  if (status.ahead > 0) throw new Error('update blocked: local branch has local commits')
  if (status.behind === 0) {
    return { updated: false, root: status.root, version: status.current }
  }

  run('git', ['pull', '--ff-only', 'origin', status.branch], status.root)
  const installScript = path.join(status.root, 'install.sh')
  const env = installScriptEnv()

  if (fs.existsSync(installScript)) {
    run('bash', ['-n', installScript], status.root, env)
    run('bash', [installScript], status.root, env)
  } else {
    run('npm', ['install', '--include=dev', '--silent'], status.root, env)
    run('npm', ['run', 'build'], status.root, env)
  }

  const pids = Array.from(new Set(findDaemonPids()))
  if (pids.length > 0) {
    stopDaemonPids(pids)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  await ensureDaemonRunning()
  return {
    updated: true,
    root: status.root,
    version: run('git', ['rev-parse', 'HEAD'], status.root),
  }
}
