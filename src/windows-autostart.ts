import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DATAMOAT_ROOT, STATE_DIR } from './config'
import { updateHealth, writeLog } from './logging'
import { launcherBinaryForScripts, launcherEnvForScripts } from './runtime'

const STARTUP_SCRIPT = 'DataMoat Background.vbs'
const STARTUP_CMD = 'start-datamoat-background.cmd'
type LauncherMode = 'tray' | 'daemon' | 'remote-no-screen'

type WindowsAutostartOptions = {
  remoteNoScreen?: boolean
}

function startupDir(): string {
  const appData = process.env.APPDATA?.trim()
    || path.join(os.homedir(), 'AppData', 'Roaming')
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

function escapeCmdValue(value: string): string {
  return value.replace(/"/g, '')
}

function vbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function launcherCmdPath(): string {
  return path.join(STATE_DIR, STARTUP_CMD)
}

function startupScriptPath(): string {
  return path.join(startupDir(), STARTUP_SCRIPT)
}

function daemonScriptPath(): string {
  return path.join(__dirname, 'daemon.js')
}

function packagedElectronPath(): string | null {
  if (process.platform !== 'win32') return null

  const candidates = new Set<string>()
  if (process.execPath.toLowerCase().endsWith('.exe')) {
    candidates.add(path.resolve(process.execPath))
  }
  candidates.add(path.resolve(path.join(__dirname, '..', '..', '..', 'DataMoat.exe')))

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && path.basename(candidate).toLowerCase() === 'datamoat.exe') {
      return candidate
    }
  }
  return null
}

function writeLauncherCmd(cmdPath: string, options: WindowsAutostartOptions = {}): LauncherMode {
  const packagedExe = packagedElectronPath()
  const nodeBin = launcherBinaryForScripts()
  const launcherEnv = launcherEnvForScripts()
  const daemonScript = daemonScriptPath()
  const appRoot = path.resolve(path.join(__dirname, '..'))
  const logPath = path.join(STATE_DIR, 'autostart.log')
  const mode: LauncherMode = options.remoteNoScreen && packagedExe
    ? 'remote-no-screen'
    : packagedExe ? 'tray' : 'daemon'

  const content = mode === 'remote-no-screen' && packagedExe
    ? [
      '@echo off',
      `cd /d "${escapeCmdValue(path.dirname(packagedExe))}"`,
      `"${escapeCmdValue(packagedExe)}" --datamoat-remote-no-screen >> "${escapeCmdValue(logPath)}" 2>&1`,
      '',
    ].join('\r\n')
    : packagedExe
    ? [
      '@echo off',
      `set "DATAMOAT_HOME=${escapeCmdValue(DATAMOAT_ROOT)}"`,
      'set "DATAMOAT_TRAY_ONLY=1"',
      `cd /d "${escapeCmdValue(path.dirname(packagedExe))}"`,
      `"${escapeCmdValue(packagedExe)}" --datamoat-tray-only >> "${escapeCmdValue(logPath)}" 2>&1`,
      '',
    ].join('\r\n')
    : [
      '@echo off',
      `set "DATAMOAT_HOME=${escapeCmdValue(DATAMOAT_ROOT)}"`,
      'set "DATAMOAT_DAEMON=1"',
      ...(launcherEnv.ELECTRON_RUN_AS_NODE ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
      `cd /d "${escapeCmdValue(appRoot)}"`,
      `"${escapeCmdValue(nodeBin)}" "${escapeCmdValue(daemonScript)}" --datamoat-root="${escapeCmdValue(DATAMOAT_ROOT)}" >> "${escapeCmdValue(logPath)}" 2>&1`,
      '',
    ].join('\r\n')

  fs.mkdirSync(path.dirname(cmdPath), { recursive: true })
  fs.writeFileSync(cmdPath, content, { encoding: 'utf8', mode: 0o600 })
  return mode
}

function writeStartupVbs(scriptPath: string, cmdPath: string): void {
  const content = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${vbsString(cmdPath)}, 0, False`,
    '',
  ].join('\r\n')

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.writeFileSync(scriptPath, content, { encoding: 'utf8', mode: 0o600 })
}

function ensureWindowsAutostartWithOptions(options: WindowsAutostartOptions = {}): boolean {
  if (process.platform !== 'win32') return false

  try {
    const cmdPath = launcherCmdPath()
    const scriptPath = startupScriptPath()
    const launcherMode = writeLauncherCmd(cmdPath, options)
    writeStartupVbs(scriptPath, cmdPath)
    updateHealth('autostart', {
      enabled: true,
      backend: 'startup-folder',
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      startupScript: scriptPath,
      launcher: cmdPath,
      updatedAt: new Date().toISOString(),
    })
    writeLog('info', 'autostart', 'windows_autostart_ready', {
      backend: 'startup-folder',
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      startupScript: scriptPath,
      launcher: cmdPath,
    })
    return true
  } catch (error) {
    updateHealth('autostart', {
      enabled: false,
      backend: 'startup-folder',
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    })
    writeLog('warn', 'autostart', 'windows_autostart_failed', { error })
    return false
  }
}

export function ensureWindowsAutostart(): boolean {
  return ensureWindowsAutostartWithOptions()
}

export function ensureWindowsRemoteNoScreenAutostart(): boolean {
  return ensureWindowsAutostartWithOptions({ remoteNoScreen: true })
}
