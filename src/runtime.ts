import * as fs from 'fs'
import * as path from 'path'
import * as http from 'http'
import * as child_process from 'child_process'
import { PID_FILE, STATE_DIR, UI_PORT_RANGE } from './config'
import { ensureDirs } from './store'
import { isSetupDone } from './auth'
import { loadInstallInfo } from './install-context'

function linuxUserServiceFile(): string {
  return path.join(process.env.HOME || '', '.config', 'systemd', 'user', 'datamoat-daemon.service')
}

function canUseLinuxUserService(): boolean {
  if (process.platform !== 'linux') return false
  if (!fs.existsSync(linuxUserServiceFile())) return false
  try {
    child_process.execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function launcherBinaryForScripts(): string {
  const macLauncher = macScriptLauncherBinary()
  if (macLauncher) return macLauncher

  if (!process.versions.electron) return process.execPath

  return nodeBinaryForBuildTasks()
}

export function nodeBinaryForBuildTasks(): string {
  const installInfo = loadInstallInfo()
  const configured = installInfo?.nodeBin?.trim()
  if (configured && fs.existsSync(configured)) {
    return configured
  }

  try {
    const fromPath = child_process.execFileSync('which', ['node'], { encoding: 'utf8' }).trim()
    if (fromPath && fs.existsSync(fromPath)) return fromPath
  } catch {
    // ignore
  }

  return process.execPath
}

export function launcherEnvForScripts(): NodeJS.ProcessEnv {
  const launcher = launcherBinaryForScripts()
  const env = { ...process.env }
  if (launcherNeedsElectronNodeMode(launcher)) {
    env.ELECTRON_RUN_AS_NODE = '1'
  }
  return env
}

function launcherEnvForDaemon(): NodeJS.ProcessEnv {
  const env = launcherEnvForScripts()
  // LaunchAgent-only state must not leak into the detached daemon child. The
  // daemon is a Node-mode process, not another tray-only Electron instance.
  delete env.DATAMOAT_TRAY_ONLY
  delete env.XPC_SERVICE_NAME
  return {
    ...env,
    DATAMOAT_DAEMON: '1',
  }
}

function launcherNeedsElectronNodeMode(launcher: string): boolean {
  const resolvedLauncher = path.resolve(launcher)
  if (process.versions.electron && resolvedLauncher === path.resolve(process.execPath)) {
    return true
  }
  return process.platform === 'darwin' && /\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(resolvedLauncher)
}

function macScriptLauncherBinary(): string | null {
  if (process.platform !== 'darwin') return null

  const installInfo = loadInstallInfo()
  const candidates = new Set<string>()
  const configured = installInfo?.scriptLauncherBin?.trim()
  if (configured) candidates.add(path.resolve(configured))
  if (process.versions.electron) candidates.add(path.resolve(process.execPath))
  candidates.add(path.resolve(path.join(process.env.HOME || '', '.datamoat', 'app', 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app', 'Contents', 'MacOS', 'DataMoat')))
  if (installInfo?.sourceRoot) {
    candidates.add(path.resolve(path.join(installInfo.sourceRoot, 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app', 'Contents', 'MacOS', 'DataMoat')))
  }
  candidates.add(path.resolve(path.join(__dirname, '..', 'release', `DataMoat-darwin-${process.arch}`, 'DataMoat.app', 'Contents', 'MacOS', 'DataMoat')))

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function daemonScriptCandidates(): string[] {
  const candidates = new Set<string>([
    path.resolve(path.join(__dirname, 'daemon.js')),
    path.resolve(path.join(process.env.HOME || '', '.datamoat', 'app', 'dist', 'daemon.js')),
  ])
  const installInfo = loadInstallInfo()
  if (installInfo?.sourceRoot) {
    candidates.add(path.resolve(path.join(installInfo.sourceRoot, 'dist', 'daemon.js')))
  }
  return [...candidates]
}

function dataRootCommandMarker(): string | null {
  const dataRoot = process.env.DATAMOAT_HOME?.trim()
  return dataRoot ? path.resolve(dataRoot) : null
}

function positiveIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const DAEMON_START_TIMEOUT_MS = positiveIntegerFromEnv('DATAMOAT_DAEMON_START_TIMEOUT_MS', 20000)
const DAEMON_START_POLL_MS = positiveIntegerFromEnv('DATAMOAT_DAEMON_START_POLL_MS', 250)

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function commandForPid(pid: number): string | null {
  try {
    return child_process.execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function isKnownDaemonCommand(command: string): boolean {
  const matchesScript = daemonScriptCandidates().some(candidate => command.includes(candidate))
  if (!matchesScript) return false
  const marker = dataRootCommandMarker()
  return !marker || command.includes(marker)
}

export function isDaemonRunning(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim())
    process.kill(pid, 0)
    const command = commandForPid(pid)
    if (command && isKnownDaemonCommand(command)) return pid
  } catch {
    // ignore and fall through
  }
  const pids = findDaemonPids()
  if (pids.length === 1) {
    fs.writeFileSync(PID_FILE, String(pids[0]))
    return pids[0]
  }
  return null
}

export function getPort(): number | null {
  try {
    return parseInt(fs.readFileSync(path.join(STATE_DIR, 'port'), 'utf8').trim())
  } catch {
    return null
  }
}

export function findDaemonPids(): number[] {
  try {
    const candidates = daemonScriptCandidates()
    const out = child_process.execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    return out
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap(line => {
        const match = line.match(/^(\d+)\s+(.*)$/)
        if (!match) return []
        const pid = Number(match[1])
        const cmd = match[2]
        if (!Number.isFinite(pid) || pid === process.pid) return []
        const matchesScript = candidates.some(candidate => cmd.includes(candidate))
        if (!matchesScript) return []
        const marker = dataRootCommandMarker()
        if (marker && !cmd.includes(marker)) return []
        return [pid]
      })
  } catch {
    return []
  }
}

export function stopDaemonPids(pids: number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }
}

export function routePathForCurrentState(): string {
  return isSetupDone() ? '' : '/setup'
}

export function buildUiUrl(port: number): string {
  return `http://localhost:${port}${routePathForCurrentState()}`
}

export function probePort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 400 }, res => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

async function daemonMetaForPort(port: number): Promise<{ pid: number } | null> {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/meta', timeout: 500 }, res => {
      if (res.statusCode !== 200) {
        res.resume()
        resolve(null)
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { pid?: number }
          if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
            resolve({ pid: parsed.pid })
            return
          }
        } catch {
          // ignore
        }
        resolve(null)
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

export async function resolveActivePort(expectedPid?: number | null): Promise<number | null> {
  const filePort = getPort()
  if (filePort && await probePort(filePort)) {
    const meta = await daemonMetaForPort(filePort)
    if (meta && (!expectedPid || meta.pid === expectedPid)) return filePort
  }

  let fallbackPort: number | null = null
  for (let port = UI_PORT_RANGE.min; port <= UI_PORT_RANGE.max; port++) {
    const meta = await daemonMetaForPort(port)
    if (meta) {
      if (expectedPid && meta.pid === expectedPid) {
        fs.writeFileSync(path.join(STATE_DIR, 'port'), String(port))
        return port
      }
      if (!expectedPid && fallbackPort === null) {
        fallbackPort = port
      }
    }
  }
  if (fallbackPort !== null) {
    fs.writeFileSync(path.join(STATE_DIR, 'port'), String(fallbackPort))
  }
  return fallbackPort
}

async function waitForActivePort(expectedPid?: number | null, timeoutMs = DAEMON_START_TIMEOUT_MS): Promise<number | null> {
  const startedAt = Date.now()

  while (Date.now() - startedAt <= timeoutMs) {
    const activePid = expectedPid ?? isDaemonRunning()
    const port = await resolveActivePort(activePid)
    if (port) return port

    if (expectedPid) {
      const recoveredPid = isDaemonRunning()
      if (recoveredPid && recoveredPid !== expectedPid) {
        const recoveredPort = await resolveActivePort(recoveredPid)
        if (recoveredPort) return recoveredPort
      }
    }

    await sleep(DAEMON_START_POLL_MS)
  }

  return null
}

export async function ensureDaemonRunning(): Promise<{ pid: number | null; port: number; url: string }> {
  ensureDirs()
  let pid = isDaemonRunning()
  const duplicatePids = findDaemonPids()

  if (duplicatePids.length > 1) {
    stopDaemonPids(duplicatePids)
    try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(STATE_DIR, 'port')) } catch { /* ignore */ }
    let waited = 0
    while (findDaemonPids().length > 0 && waited < 3000) {
      await sleep(150)
      waited += 150
    }
    pid = null
  }

  if (!pid) {
    try { fs.unlinkSync(path.join(STATE_DIR, 'port')) } catch { /* ignore */ }
    if (canUseLinuxUserService()) {
      try {
        child_process.execFileSync('systemctl', ['--user', 'start', 'datamoat-daemon.service'], { stdio: 'ignore' })
      } catch {
        // fall back to detached spawn below
      }
    }

    pid = isDaemonRunning()
    if (!pid) {
      const daemonArgs = [
        path.join(__dirname, 'daemon.js'),
        ...(dataRootCommandMarker() ? [`--datamoat-root=${dataRootCommandMarker()}`] : []),
      ]
      const daemon = child_process.spawn(
        launcherBinaryForScripts(),
        daemonArgs,
        {
          detached: true,
          stdio: 'ignore',
          env: launcherEnvForDaemon(),
        },
      )
      daemon.unref()
      pid = daemon.pid ?? null
    }
  }

  const port = await waitForActivePort(pid)
  if (!port) throw new Error('daemon did not start in time')
  return { pid: isDaemonRunning() ?? pid, port, url: buildUiUrl(port) }
}
