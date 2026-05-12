import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import * as child_process from 'child_process'
import { DATAMOAT_ROOT } from './config'
import { updateHealth, writeLog } from './logging'
import { launcherBinaryForScripts, launcherEnvForScripts } from './runtime'
import { isWindowsSystemContext, looksLikeWindowsMachineAccount, looksLikeWindowsSystemProfile } from './windows-context'
export { isWindowsSystemContext } from './windows-context'

const STARTUP_SCRIPT = 'DataMoat Background.vbs'
const STARTUP_CMD = 'start-datamoat-background.cmd'
const STARTUP_PS1 = 'start-datamoat-background.ps1'
const SCHEDULED_TASK_NAME = 'DataMoat Background Capture'
type LauncherMode = 'tray' | 'daemon' | 'remote-no-screen'

type WindowsAutostartOptions = {
  remoteNoScreen?: boolean
  startNow?: boolean
}

export type WindowsStartupTarget = {
  appData: string
  profilePath: string | null
  startupDir: string
  userName: string | null
  sid: string | null
  source: string
  systemContext: boolean
}

function startupDirFromAppData(appData: string): string {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
}

function resolveInteractiveStartupTarget(): WindowsStartupTarget | null {
  if (process.platform !== 'win32') return null

  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$userName = (Get-CimInstance Win32_ComputerSystem).UserName',
    'if (-not $userName) {',
    '  $explorer = Get-CimInstance Win32_Process -Filter "name = \'explorer.exe\'" | Select-Object -First 1',
    '  if ($explorer) {',
    '    $owner = Invoke-CimMethod -InputObject $explorer -MethodName GetOwner',
    '    if ($owner -and $owner.User) { $userName = "$($owner.Domain)\\$($owner.User)" }',
    '  }',
    '}',
    'if (-not $userName) { exit 2 }',
    '$sid = $null',
    'try { $sid = (New-Object System.Security.Principal.NTAccount($userName)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}',
    '$profilePath = $null',
    'if ($sid) {',
    '  $profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sid } | Select-Object -First 1',
    '  if ($profile) { $profilePath = $profile.LocalPath }',
    '}',
    'if (-not $profilePath) {',
    '  $plainUser = ($userName -split "\\\\")[-1]',
    '  $candidate = Join-Path $env:SystemDrive "Users\\$plainUser"',
    '  if (Test-Path -LiteralPath $candidate) { $profilePath = $candidate }',
    '}',
    'if (-not $profilePath) { exit 3 }',
    '$appData = Join-Path $profilePath "AppData\\Roaming"',
    '[pscustomobject]@{ userName = $userName; sid = $sid; profilePath = $profilePath; appData = $appData } | ConvertTo-Json -Compress',
  ].join('\n')

  try {
    const raw = child_process.execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      userName?: string
      sid?: string
      profilePath?: string
      appData?: string
    }
    const appData = parsed.appData?.trim()
    if (!appData || looksLikeWindowsSystemProfile(appData)) return null
    const profilePath = parsed.profilePath?.trim() || null
    return {
      appData,
      profilePath,
      startupDir: startupDirFromAppData(appData),
      userName: parsed.userName?.trim() || null,
      sid: parsed.sid?.trim() || null,
      source: 'interactive-user',
      systemContext: true,
    }
  } catch {
    return null
  }
}

function resolveStartupTarget(): WindowsStartupTarget {
  const systemContext = isWindowsSystemContext()
  if (systemContext) {
    const interactive = resolveInteractiveStartupTarget()
    if (interactive) return interactive
  }

  const envAppData = process.env.APPDATA?.trim()
  if (envAppData && !looksLikeWindowsSystemProfile(envAppData)) {
    const envUserName = process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME || null
    return {
      appData: envAppData,
      profilePath: process.env.USERPROFILE?.trim() || null,
      startupDir: startupDirFromAppData(envAppData),
      userName: systemContext && looksLikeWindowsMachineAccount(envUserName || undefined) ? null : envUserName,
      sid: null,
      source: systemContext ? 'env-appdata-system-fallback' : 'env-appdata',
      systemContext,
    }
  }

  const home = os.homedir()
  if (home && !looksLikeWindowsSystemProfile(home)) {
    const appData = path.join(home, 'AppData', 'Roaming')
    const envUserName = process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME || null
    return {
      appData,
      profilePath: home,
      startupDir: startupDirFromAppData(appData),
      userName: systemContext && looksLikeWindowsMachineAccount(envUserName || undefined) ? null : envUserName,
      sid: null,
      source: systemContext ? 'os-homedir-system-fallback' : 'os-homedir',
      systemContext,
    }
  }

  throw new Error('Could not resolve a non-SYSTEM Windows user Startup folder')
}

export function resolveWindowsStartupTarget(): WindowsStartupTarget {
  return resolveStartupTarget()
}

function startupDir(target?: WindowsStartupTarget): string {
  return (target || resolveStartupTarget()).startupDir
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

function launcherCmdPath(dataRoot = DATAMOAT_ROOT): string {
  return path.join(dataRoot, 'state', STARTUP_CMD)
}

function launcherPs1Path(dataRoot = DATAMOAT_ROOT): string {
  return path.join(dataRoot, 'state', STARTUP_PS1)
}

function startupScriptPath(target?: WindowsStartupTarget): string {
  return path.join(startupDir(target), STARTUP_SCRIPT)
}

function daemonScriptPath(): string {
  return path.join(__dirname, 'daemon.js')
}

function defaultDataRootForTarget(target: WindowsStartupTarget): string {
  const profilePath = target.profilePath?.trim()
    || process.env.USERPROFILE?.trim()
    || os.homedir()
  return path.resolve(profilePath, '.datamoat')
}

function explicitDataRoot(): boolean {
  return Boolean(process.env.DATAMOAT_HOME?.trim())
}

function launcherDataRootForTarget(target: WindowsStartupTarget): string {
  if (target.systemContext && !explicitDataRoot()) {
    return defaultDataRootForTarget(target)
  }
  return DATAMOAT_ROOT
}

function normalizeWinPathForCompare(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase()
}

function scheduledTaskNameForRoot(target: WindowsStartupTarget, dataRoot = DATAMOAT_ROOT): string {
  const override = process.env.DATAMOAT_WINDOWS_TASK_NAME?.trim()
  if (override) return override.slice(0, 238)

  const currentRoot = normalizeWinPathForCompare(dataRoot)
  const defaultRoot = normalizeWinPathForCompare(defaultDataRootForTarget(target))
  if (currentRoot === defaultRoot) return SCHEDULED_TASK_NAME

  const suffix = crypto.createHash('sha256').update(currentRoot).digest('hex').slice(0, 8)
  return `${SCHEDULED_TASK_NAME} ${suffix}`
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

function resolveLauncherMode(options: WindowsAutostartOptions = {}, dataRoot = DATAMOAT_ROOT): {
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
  const logPath = path.join(dataRoot, 'state', 'autostart.log')
  const mode: LauncherMode = options.remoteNoScreen && packagedExe
    ? 'remote-no-screen'
    : packagedExe ? 'tray' : 'daemon'
  return { mode, packagedExe, nodeBin, launcherEnv, daemonScript, appRoot, logPath }
}

function writeLauncherCmd(cmdPath: string, options: WindowsAutostartOptions = {}, dataRoot = DATAMOAT_ROOT): LauncherMode {
  const { mode, packagedExe, nodeBin, launcherEnv, daemonScript, appRoot, logPath } = resolveLauncherMode(options, dataRoot)

  const content = mode === 'remote-no-screen' && packagedExe
    ? [
      '@echo off',
      `set "DATAMOAT_HOME=${escapeCmdValue(dataRoot)}"`,
      `cd /d "${escapeCmdValue(path.dirname(packagedExe))}"`,
      `>> "${escapeCmdValue(logPath)}" echo [%DATE% %TIME%] DataMoat remote no-screen launcher starting`,
      `start "" "${escapeCmdValue(packagedExe)}" --datamoat-remote-no-screen`,
      '',
    ].join('\r\n')
    : packagedExe
    ? [
      '@echo off',
      `set "DATAMOAT_HOME=${escapeCmdValue(dataRoot)}"`,
      'set "DATAMOAT_TRAY_ONLY=1"',
      `cd /d "${escapeCmdValue(path.dirname(packagedExe))}"`,
      `>> "${escapeCmdValue(logPath)}" echo [%DATE% %TIME%] DataMoat tray launcher starting`,
      `start "" "${escapeCmdValue(packagedExe)}" --datamoat-tray-only`,
      '',
    ].join('\r\n')
    : [
      '@echo off',
      `set "DATAMOAT_HOME=${escapeCmdValue(dataRoot)}"`,
      'set "DATAMOAT_DAEMON=1"',
      ...(launcherEnv.ELECTRON_RUN_AS_NODE ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
      `cd /d "${escapeCmdValue(appRoot)}"`,
      `"${escapeCmdValue(nodeBin)}" "${escapeCmdValue(daemonScript)}" --datamoat-root="${escapeCmdValue(dataRoot)}" >> "${escapeCmdValue(logPath)}" 2>&1`,
      '',
    ].join('\r\n')

  fs.mkdirSync(path.dirname(cmdPath), { recursive: true })
  fs.writeFileSync(cmdPath, content, { encoding: 'utf8', mode: 0o600 })
  return mode
}

function writeLauncherPs1(ps1Path: string, options: WindowsAutostartOptions = {}, dataRoot = DATAMOAT_ROOT): LauncherMode {
  const { mode, packagedExe, nodeBin, launcherEnv, daemonScript, appRoot, logPath } = resolveLauncherMode(options, dataRoot)
  const common = [
    '$ErrorActionPreference = "Continue"',
    `$logPath = ${psString(logPath)}`,
  ]

  const content = mode === 'remote-no-screen' && packagedExe
    ? [
      ...common,
      `$env:DATAMOAT_HOME = ${psString(dataRoot)}`,
      `Set-Location -LiteralPath ${psString(path.dirname(packagedExe))}`,
      `& ${psString(packagedExe)} --datamoat-remote-no-screen *>> $logPath`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n')
    : packagedExe
    ? [
      ...common,
      `$env:DATAMOAT_HOME = ${psString(dataRoot)}`,
      '$env:DATAMOAT_TRAY_ONLY = "1"',
      `Set-Location -LiteralPath ${psString(path.dirname(packagedExe))}`,
      `& ${psString(packagedExe)} --datamoat-tray-only *>> $logPath`,
      'exit $LASTEXITCODE',
      '',
    ].join('\r\n')
    : [
      ...common,
      `$env:DATAMOAT_HOME = ${psString(dataRoot)}`,
      '$env:DATAMOAT_DAEMON = "1"',
      ...(launcherEnv.ELECTRON_RUN_AS_NODE ? ['$env:ELECTRON_RUN_AS_NODE = "1"'] : []),
      `Set-Location -LiteralPath ${psString(appRoot)}`,
      `& ${psString(nodeBin)} ${psString(daemonScript)} ${psString(`--datamoat-root=${dataRoot}`)} *>> $logPath`,
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

function registerScheduledTask(actionExecute: string, actionArgs: string, taskName: string, options: WindowsAutostartOptions = {}, target: WindowsStartupTarget): void {
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$taskName = ${psString(taskName)}`,
    `$action = New-ScheduledTaskAction -Execute ${psString(actionExecute)} -Argument ${psString(actionArgs)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn',
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    ...(target.systemContext && target.userName
      ? [
        `$principal = New-ScheduledTaskPrincipal -UserId ${psString(target.userName)} -LogonType Interactive -RunLevel Limited`,
        'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "DataMoat background capture and tray" -Force | Out-Null',
      ]
      : [
        'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "DataMoat background capture and tray" -Force | Out-Null',
      ]),
    ...(options.startNow === false ? [] : ['Start-ScheduledTask -TaskName $taskName | Out-Null']),
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

  let target: WindowsStartupTarget
  try {
    target = resolveStartupTarget()
  } catch (error) {
    updateHealth('autostart', {
      enabled: false,
      backend: 'windows-autostart',
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    })
    writeLog('warn', 'autostart', 'windows_startup_target_failed', { error })
    return false
  }

  let scheduledTaskError: unknown = null
  try {
    if (target.systemContext && !target.userName) {
      throw new Error('scheduled task skipped because no interactive Windows user SID was resolved')
    }
    const dataRoot = launcherDataRootForTarget(target)
    const taskName = scheduledTaskNameForRoot(target, dataRoot)
    const cmdPath = launcherCmdPath(dataRoot)
    let launcherMode = writeLauncherCmd(cmdPath, options, dataRoot)
    let launcher = cmdPath
    let actionExecute = 'cmd.exe'
    let actionArgs = `/c "${cmdPath}"`
    if (launcherMode === 'daemon') {
      const ps1Path = launcherPs1Path(dataRoot)
      launcherMode = writeLauncherPs1(ps1Path, options, dataRoot)
      launcher = ps1Path
      actionExecute = 'powershell.exe'
      actionArgs = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`
    }
    const restartOnFailure = launcherMode === 'daemon'
    registerScheduledTask(actionExecute, actionArgs, taskName, options, target)
    try { fs.rmSync(startupScriptPath(target), { force: true }) } catch { /* ignore */ }
    updateHealth('autostart', {
      enabled: true,
      backend: 'scheduled-task',
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      restartOnFailure,
      taskName,
      launcher,
      actionExecute,
      actionArgs,
      dataRoot,
      defaultDataRoot: defaultDataRootForTarget(target),
      isolatedDataRoot: normalizeWinPathForCompare(dataRoot) !== normalizeWinPathForCompare(defaultDataRootForTarget(target)),
      targetUser: target.userName,
      targetStartupDir: target.startupDir,
      targetSource: target.source,
      systemContext: target.systemContext,
      updatedAt: new Date().toISOString(),
    })
    writeLog('info', 'autostart', 'windows_autostart_ready', {
      backend: 'scheduled-task',
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      restartOnFailure,
      taskName,
      launcher,
      actionExecute,
      actionArgs,
      dataRoot,
      defaultDataRoot: defaultDataRootForTarget(target),
      isolatedDataRoot: normalizeWinPathForCompare(dataRoot) !== normalizeWinPathForCompare(defaultDataRootForTarget(target)),
      target,
    })
    return true
  } catch (error) {
    scheduledTaskError = error
    writeLog('warn', 'autostart', 'windows_scheduled_task_failed', { error })
  }

  try {
    const dataRoot = launcherDataRootForTarget(target)
    const cmdPath = launcherCmdPath(dataRoot)
    const scriptPath = startupScriptPath(target)
    const launcherMode = writeLauncherCmd(cmdPath, options, dataRoot)
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
      dataRoot,
      targetUser: target.userName,
      targetStartupDir: target.startupDir,
      targetSource: target.source,
      systemContext: target.systemContext,
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
      target,
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

export function ensureWindowsPackagedAutostart(): boolean {
  return ensureWindowsAutostartWithOptions({ startNow: false })
}

export function ensureWindowsRemoteNoScreenAutostart(): boolean {
  return ensureWindowsAutostartWithOptions({ remoteNoScreen: true, startNow: false })
}
