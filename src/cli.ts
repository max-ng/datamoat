#!/usr/bin/env node
import { program } from 'commander'
import * as fs from 'fs'
import * as path from 'path'
import * as child_process from 'child_process'
import { PID_FILE, STATE_DIR, VAULT_DIR } from './config'
import { ensureDirs, readPublicStatus } from './store'
import { verifyAuditChain } from './logging'
import { ensureDaemonRunning, findDaemonPids, isDaemonRunning, stopDaemonPids } from './runtime'
import { applyUpdate, checkForUpdate } from './update'
import { isSetupDone, loadAuthConfig } from './auth'
import { disableBootstrapCapture, enableBootstrapCapture, preflightBootstrapCapture } from './bootstrap-capture'
import { ensureLinuxRemoteNoScreenAutostart } from './linux-autostart'

const REMOTE_NO_SCREEN_FLAGS = new Set([
  '--datamoat-remote-no-screen',
  '--datamoat-capture-before-setup',
  '--remote-no-screen',
  '--capture-before-setup',
  '--openclaw-remote',
])

function argvRequestsRemoteNoScreen(argv = process.argv.slice(2)): boolean {
  return argv.some(arg => REMOTE_NO_SCREEN_FLAGS.has(arg))
}

function packageVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function findMatchingProcessPids(entry: string): number[] {
  try {
    const out = child_process.execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    return out.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        const match = line.match(/^(\d+)\s+(.*)$/)
        if (!match) return []
        const pid = Number(match[1])
        const cmd = match[2]
        if (!Number.isFinite(pid) || pid === process.pid || !cmd.includes(entry)) return []
        return [pid]
      })
  } catch {
    return []
  }
}

function isElectronAppRunning(entry: string): boolean {
  return findMatchingProcessPids(entry).length > 0
}

function stopLinuxUserServiceIfPresent(): void {
  if (process.platform !== 'linux') return
  const serviceFile = path.join(process.env.HOME || '', '.config', 'systemd', 'user', 'datamoat-daemon.service')
  if (!fs.existsSync(serviceFile)) return
  try {
    child_process.execFileSync('systemctl', ['--user', 'stop', 'datamoat-daemon.service'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}

function packagedElectronApp(): string | null {
  if (process.platform !== 'darwin') return null
  const candidates = [
    path.join('/Applications', 'DataMoat.app'),
    path.join(process.env.HOME || '', 'Applications', 'DataMoat.app'),
    path.join(__dirname, '..', 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app'),
    path.join(__dirname, '..', 'release', 'DataMoat.app'),
  ]
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null
}

function packagedElectronExecutable(): string | null {
  const appPath = packagedElectronApp()
  if (!appPath) return null
  const executable = path.join(appPath, 'Contents', 'MacOS', 'DataMoat')
  return fs.existsSync(executable) ? executable : null
}

async function launchElectron(): Promise<boolean> {
  if (process.env.DATAMOAT_BROWSER === '1') return false
  try {
    const entry = path.join(__dirname, 'electron', 'main.js')
    const packagedApp = packagedElectronApp()
    const packagedExecutable = packagedElectronExecutable()

    if (process.platform === 'darwin' && packagedApp && packagedExecutable) {
      for (const pid of findMatchingProcessPids(entry)) {
        try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
      }
      if (isElectronAppRunning(packagedExecutable)) {
        child_process.spawn(packagedExecutable, [], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env },
        }).unref()
        return true
      }
      child_process.spawn('open', [packagedApp], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      }).unref()
      return true
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electronBinary = require('electron') as string
    if (process.platform === 'darwin' && isElectronAppRunning(entry)) {
      child_process.spawn(electronBinary, [entry], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      }).unref()
      return true
    }
    const child = child_process.spawn(electronBinary, [entry], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    const childPid = child.pid ?? null
    child.unref()
    if (process.platform !== 'linux') return true
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (childPid) {
      try {
        process.kill(childPid, 0)
        return true
      } catch {
        // fall through to browser fallback
      }
    }
    if (isElectronAppRunning(entry)) return true
    return false
  } catch {
    return false
  }
}

async function openUI() {
  ensureDirs()
  const wasRunning = !!isDaemonRunning()
  if (!wasRunning) console.log('starting DataMoat daemon…')

  let url = ''
  try {
    const runtime = await ensureDaemonRunning()
    url = runtime.url
  } catch {
    console.error('DataMoat daemon did not start in time — check ~/.datamoat/daemon.log')
    process.exit(1)
  }

  if (await launchElectron()) {
    if (process.platform === 'linux') {
      console.log(`opening desktop UI at ${url}`)
      console.log(`if no window appears, open ${url} in your browser`)
    }
    return
  }

  if (process.platform === 'linux' && process.env.DATAMOAT_BROWSER !== '1') {
    console.error('DataMoat desktop UI did not start. Opening browser fallback instead.')
  }
  console.log(`opening ${url}`)

  const { default: open } = await import('open')
  await open(url)
}

async function restartDaemonForRescan(): Promise<{ pid: number | null; port: number; url: string }> {
  ensureDirs()
  console.log('forcing full rescan…')

  const { OFFSETS_FILE } = await import('./config')
  if (fs.existsSync(OFFSETS_FILE)) fs.unlinkSync(OFFSETS_FILE)

  stopLinuxUserServiceIfPresent()
  const pids = Array.from(new Set(findDaemonPids()))
  if (pids.length > 0) {
    stopDaemonPids(pids)
    await new Promise(r => setTimeout(r, 800))
  }

  console.log('starting DataMoat daemon…')
  return ensureDaemonRunning()
}

function hasBackgroundCaptureConfigured(): boolean {
  const config = loadAuthConfig()
  return !!config?.backgroundWrappedVaultKey && !!config?.backgroundWrapSalt
}

async function startRemoteNoScreenCapture(): Promise<void> {
  ensureDirs()
  if (isSetupDone()) {
    const runtime = await ensureDaemonRunning()
    console.log('DataMoat is already set up. Remote no-screen bootstrap capture was not re-enabled.')
    console.log(`daemon: ${runtime.pid ? `running (pid ${runtime.pid})` : 'running'}`)
    return
  }

  const state = enableBootstrapCapture('remote-no-screen')
  if (!await preflightBootstrapCapture()) {
    disableBootstrapCapture()
    console.error('DataMoat remote no-screen capture could not start securely.')
    console.error('A working local OS keychain / secret service is required before pre-setup capture can begin.')
    process.exit(1)
  }

  if (!isSetupDone()) {
    stopLinuxUserServiceIfPresent()
    const pids = Array.from(new Set(findDaemonPids()))
    if (pids.length > 0) {
      stopDaemonPids(pids)
      await new Promise(resolve => setTimeout(resolve, 800))
    }
  }

  if (process.platform === 'linux') ensureLinuxRemoteNoScreenAutostart()

  const runtime = await ensureDaemonRunning()
  console.log('DataMoat remote no-screen capture is enabled.')
  console.log(`requestedBy: ${state.requestedBy}`)
  console.log(`daemon: ${runtime.pid ? `running (pid ${runtime.pid})` : 'running'}`)
  console.log('Complete password, authenticator, and recovery setup later on the protected desktop GUI, not in this chat.')
}

program
  .name('datamoat')
  .description('Automatically backs up Claude, Codex, OpenClaw, and Cursor conversations')
  .version(packageVersion())
  .action(openUI)  // default: open UI

program
  .command('status')
  .description('Show daemon status and capture stats')
  .action(() => {
    const pid = isDaemonRunning()
    const publicStatus = readPublicStatus()

    console.log(`\n  DataMoat v${packageVersion()}\n`)
    console.log(`  daemon:   ${pid ? `running (pid ${pid})` : 'stopped'}`)
    if (publicStatus) {
      console.log(`  sessions: ${publicStatus.totalSessions} total`)
      for (const [src, count] of Object.entries(publicStatus.bySource)) {
        console.log(`    ${src.padEnd(12)} ${count}`)
      }
      if (publicStatus.lastTimestamp) {
        console.log(`  last:     ${new Date(publicStatus.lastTimestamp).toLocaleString()}`)
      }
    } else {
      console.log('  sessions: unavailable until the vault has been unlocked at least once')
    }
    console.log(`  vault:    ${VAULT_DIR}\n`)
  })

program
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    stopLinuxUserServiceIfPresent()
    const pid = isDaemonRunning()
    const pids = Array.from(new Set([
      ...(pid ? [pid] : []),
      ...findDaemonPids(),
    ]))
    if (pids.length === 0) { console.log('daemon is not running'); return }
    stopDaemonPids(pids)
    console.log(`stopped daemon (${pids.join(', ')})`)
  })

program
  .command('scan')
  .description('Force re-scan all source files (catches any missed sessions)')
  .action(async () => {
    try {
      const runtime = await restartDaemonForRescan()
      if (hasBackgroundCaptureConfigured()) {
        console.log(`background rescan started on ${runtime.url}`)
        console.log('open DataMoat separately with `datamoat` if you want the desktop UI')
        return
      }
      console.log(`daemon restarted on ${runtime.url}`)
      console.log('background capture is not configured on this install, so the full rescan will start after you unlock DataMoat once')
      console.log('open DataMoat with `datamoat`, unlock it, and keep the window open until the missing conversations appear')
    } catch {
      console.error('DataMoat daemon did not start in time after forcing rescan')
      process.exit(1)
    }
  })

const update = program
  .command('update')
  .description('Check or apply source-install updates')

update
  .command('check')
  .description('Check whether the current source install is behind its git remote')
  .action(() => {
    const status = checkForUpdate()
    if (!status.supported) {
      console.log(`mode:    ${status.mode}`)
      console.log(`path:    ${status.strategy}`)
      console.log(`update unsupported: ${status.reason}`)
      return
    }
    console.log(`mode:    ${status.mode}`)
    console.log(`path:    ${status.strategy}`)
    console.log(`root:    ${status.root}`)
    console.log(`remote:  ${status.remote}`)
    console.log(`branch:  ${status.branch}`)
    console.log(`current: ${status.current}`)
    console.log(`ahead:   ${status.ahead}`)
    console.log(`behind:  ${status.behind}`)
    console.log(`clean:   ${status.clean}`)
  })

update
  .command('apply')
  .description('Pull the latest git changes, rebuild, and restart the daemon')
  .action(async () => {
    try {
      const result = await applyUpdate()
      if (!result.updated) {
        console.log(`already up to date (${result.version})`)
        return
      }
      console.log(`updated successfully (${result.version})`)
    } catch (error) {
      console.error(`update failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  })

const audit = program
  .command('audit')
  .description('Inspect local tamper-evident audit state')

audit
  .command('verify')
  .description('Verify the local audit hash chain')
  .action(() => {
    const result = verifyAuditChain()
    if (!result.ok) {
      console.error(`audit chain invalid: ${result.error}`)
      if (result.lastHash) console.error(`last good hash: ${result.lastHash}`)
      process.exit(1)
    }
    console.log(`audit chain OK (${result.entries} entries)`)
    if (result.lastHash) console.log(`last hash: ${result.lastHash}`)
  })

if (argvRequestsRemoteNoScreen()) {
  void startRemoteNoScreenCapture()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
} else {
  void program.parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
