import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as child_process from 'child_process'
import { DATAMOAT_ROOT, STATE_DIR } from './config'
import { updateHealth, writeLog } from './logging'
import { launcherBinaryForScripts, launcherEnvForScripts } from './runtime'

const STARTUP_SCRIPT = 'DataMoat Background.vbs'
const STARTUP_CMD = 'start-datamoat-background.cmd'
const STARTUP_PS1 = 'start-datamoat-background.ps1'
const SCHEDULED_TASK_NAME = 'DataMoat Background Capture'
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

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function launcherCmdPath(): string {
  return path.join(STATE_DIR, STARTUP_CMD)
}

function launcherPs1Path(): string {
  return path.join(STATE_DIR, STARTUP_PS1)
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

function resolveLauncherMode(options: WindowsAutostartOptions = {}): {
  mode: LauncherMode
  packagedExe: string | null
  nodeBin: string
  launcherEnv: NodeJS.ProcessEnv
  daemonScript: string
  appRoot: string
  logPath: string
} {
  const packagedExe = packagedElectronPath()
  const nodeBin = launcherBinaryForScripts()
  const launcherEnv = launcherEnvForScripts()
  const daemonScript = daemonScriptPath()
  const appRoot = path.resolve(path.join(__dirname, '..'))
  const logPath = path.join(STATE_DIR, 'autostart.log')
  const mode: LauncherMode = options.remoteNoScreen && packagedExe
    ? 'remote-no-screen'
    : packagedExe ? 'tray' : 'daemon'
  return { mode, packagedExe, nodeBin, launcherEnv, daemonScript, appRoot, logPath }
}

function writeLauncherCmd(cmdPath: string, options: WindowsAutostartOptions = {}): LauncherMode {
  const { mode, packagedExe, nodeBin, launcherEnv, daemonScript, appRoot, logPath } = resolveLauncherMode(options)

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

function writeLauncherPs1(ps1Path: string, options: WindowsAutostartOptions = {}): LauncherMode {
  const { mode, packagedExe, nodeBin, launcherEnv, daemonScript, appRoot, logPath } = resolveLauncherMode(options)
  const common = [
    '$ErrorActionPreference = "Continue"',
    `$logPath = ${psString(logPath)}`,
  ]

  const content = mode === 'remote-no-screen' && packagedExe
    ? [
      ...common,
      `Set-Location -LiteralPath ${psString(path.dirname(packagedExe))}`,
      `& ${psString(packagedExe)} --datamoat-remote-no-screen *>> $logPath`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n')
    : packagedExe
    ? [
      ...common,
      `$env:DATAMOAT_HOME = ${psString(DATAMOAT_ROOT)}`,
      '$env:DATAMOAT_TRAY_ONLY = "1"',
      `Set-Location -LiteralPath ${psString(path.dirname(packagedExe))}`,
      `& ${psString(packagedExe)} --datamoat-tray-only *>> $logPath`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n')
    : [
      ...common,
      `$env:DATAMOAT_HOME = ${psString(DATAMOAT_ROOT)}`,
      '$env:DATAMOAT_DAEMON = "1"',
      ...(launcherEnv.ELECTRON_RUN_AS_NODE ? ['$env:ELECTRON_RUN_AS_NODE = "1"'] : []),
      `Set-Location -LiteralPath ${psString(appRoot)}`,
      `& ${psString(nodeBin)} ${psString(daemonScript)} ${psString(`--datamoat-root=${DATAMOAT_ROOT}`)} *>> $logPath`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n')

  fs.mkdirSync(path.dirname(ps1Path), { recursive: true })
  fs.writeFileSync(ps1Path, content, { encoding: 'utf8', mode: 0o600 })
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

function registerScheduledTask(ps1Path: string): void {
  const actionArgs = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$taskName = ${psString(SCHEDULED_TASK_NAME)}`,
    `$action = New-ScheduledTaskAction -Execute ${psString('powershell.exe')} -Argument ${psString(actionArgs)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) -MultipleInstances IgnoreNew',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "DataMoat background capture and tray" -Force | Out-Null',
    'Start-ScheduledTask -TaskName $taskName | Out-Null',
  ].join('\n')

  child_process.execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function ensureWindowsAutostartWithOptions(options: WindowsAutostartOptions = {}): boolean {
  if (process.platform !== 'win32') return false

  let scheduledTaskError: unknown = null
  try {
    const ps1Path = launcherPs1Path()
    const launcherMode = writeLauncherPs1(ps1Path, options)
    registerScheduledTask(ps1Path)
    try { fs.rmSync(startupScriptPath(), { force: true }) } catch { /* ignore */ }
    updateHealth('autostart', {
      enabled: true,
      backend: 'scheduled-task',
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      restartOnFailure: true,
      taskName: SCHEDULED_TASK_NAME,
      launcher: ps1Path,
      updatedAt: new Date().toISOString(),
    })
    writeLog('info', 'autostart', 'windows_autostart_ready', {
      backend: 'scheduled-task',
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      restartOnFailure: true,
      taskName: SCHEDULED_TASK_NAME,
      launcher: ps1Path,
    })
    return true
  } catch (error) {
    scheduledTaskError = error
    writeLog('warn', 'autostart', 'windows_scheduled_task_failed', { error })
  }

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
      restartOnFailure: false,
      scheduledTaskError: scheduledTaskError instanceof Error ? scheduledTaskError.message : scheduledTaskError ? String(scheduledTaskError) : null,
      startupScript: scriptPath,
      launcher: cmdPath,
      updatedAt: new Date().toISOString(),
    })
    writeLog('info', 'autostart', 'windows_autostart_ready', {
      backend: 'startup-folder',
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      restartOnFailure: false,
      startupScript: scriptPath,
      launcher: cmdPath,
      scheduledTaskError,
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
