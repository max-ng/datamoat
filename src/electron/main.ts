import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Menu, Tray, dialog, nativeImage, screen, session, shell, ipcMain, type OpenDialogOptions } from 'electron'
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { diskRuntimeBuildId, currentRuntimeBuildId, ensureDaemonRunning, findDaemonPids, resolveActivePort, stopDaemonPids } from '../runtime'
import { HEALTH_FILE, PUBLIC_STATUS_FILE } from '../config'
import { isSetupDone } from '../auth'
import { disableBootstrapCapture, enableBootstrapCapture, isBootstrapCaptureEnabled, loadBootstrapCaptureState, preflightBootstrapCaptureDetailed } from '../bootstrap-capture'
import { detectInstallContext } from '../install-context'
import { installCrashHandlers, updateHealth, writeLog } from '../logging'
import { applyInstallPreference, clearInstallChoice, detectDualInstallState, installChoiceMatchesState, saveInstallChoice, type DualInstallState, type InstallPreference } from '../packaged-handoff'
import { ensureLinuxAutostart, ensureLinuxRemoteNoScreenAutostart } from '../linux-autostart'
import { ensureWindowsPackagedAutostart, ensureWindowsRemoteNoScreenAutostart, isWindowsSystemContext } from '../windows-autostart'
import { ensureDirs } from '../store'
import {
  applyPackagedUpdate,
  checkForPackagedUpdates,
  getPackagedUpdateSettings,
  initializePackagedUpdater,
  openPackagedReleasePage,
  savePackagedUpdateSettings,
} from './packaged-updater'
import { ensureMacRemoteNoScreenLaunchAgent, ensurePackagedTrayLaunchAgent } from './launch-agent'
import { saveUiPreferences, uiLanguageFromArgv } from '../ui-preferences'

let mainWindow: BrowserWindow | null = null
let mainWindowCreation: Promise<void> | null = null
let revealAfterWindowCreation = false
let tray: Tray | null = null
let allowedOrigin: string | null = null
let quitRequested = false
let trayRefreshTimer: NodeJS.Timeout | null = null
let daemonWatchdogTimer: NodeJS.Timeout | null = null
let runtimeRecoveryInFlight: Promise<{ pid: number | null; port: number; url: string; recovered: boolean }> | null = null
const REMOTE_NO_SCREEN_FLAGS = new Set([
  '--datamoat-remote-no-screen',
  '--datamoat-capture-before-setup',
  '--remote-no-screen',
  '--capture-before-setup',
  '--openclaw-remote',
])

function argvRequestsRemoteNoScreen(argv = process.argv): boolean {
  return argv.some(arg => REMOTE_NO_SCREEN_FLAGS.has(arg))
}

function applyUiLanguageOverrideFromArgv(argv = process.argv, reason = 'startup'): void {
  const language = uiLanguageFromArgv(argv)
  if (!language) return
  try {
    saveUiPreferences({ language })
    writeLog('info', 'electron', 'ui_language_override_saved', { language, reason })
  } catch (error) {
    writeLog('warn', 'electron', 'ui_language_override_failed', { language, reason, error })
  }
}

const remoteNoScreenLaunch = argvRequestsRemoteNoScreen()
applyUiLanguageOverrideFromArgv(process.argv, 'startup-argv')
let trayOnlyLaunch = process.env.DATAMOAT_TRAY_ONLY === '1'
  || process.argv.includes('--datamoat-tray-only')
  || remoteNoScreenLaunch
const runtimeIcon = resolveRuntimeIcon()
const trayTemplateAsset = process.platform === 'darwin' ? resolveTrayTemplateAsset() : null

const smokeRemoteDebugPort = process.env.DATAMOAT_ELECTRON_SMOKE === '1'
  ? (process.env.DATAMOAT_ELECTRON_REMOTE_DEBUG_PORT || process.argv.find(arg => arg.startsWith('--remote-debugging-port='))?.split('=')[1] || '')
  : ''
if (/^\d+$/.test(smokeRemoteDebugPort)) {
  app.commandLine.appendSwitch('remote-debugging-port', smokeRemoteDebugPort)
}

if (
  process.platform === 'darwin'
  && remoteNoScreenLaunch
  && process.env.DATAMOAT_MAC_LAUNCH_AGENT !== 'remote-no-screen'
  && detectInstallContext().mode === 'packaged'
) {
  try {
    ensureMacRemoteNoScreenLaunchAgent()
    console.log('DataMoat remote no-screen capture is enabled.')
    console.log('DataMoat is launching in the menu bar and collecting supported local records with pre-setup encrypted capture.')
    console.log('Complete password, authenticator, and recovery setup later on the protected desktop GUI, not in this chat.')
    app.exit(0)
  } catch (error) {
    console.error('DataMoat remote no-screen launch could not be handed off to the macOS LaunchAgent.')
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
  }
}

function allowWindowsSystemContextForTest(): boolean {
  return process.env.DATAMOAT_ALLOW_WINDOWS_SYSTEM_CONTEXT === '1'
    || process.env.DATAMOAT_ELECTRON_SMOKE === '1'
}

function rejectWindowsSystemLaunchIfNeeded(): boolean {
  if (process.platform !== 'win32') return false
  if (!isWindowsSystemContext()) return false
  if (allowWindowsSystemContextForTest()) return false

  console.error('DataMoat refused to start from the Windows SYSTEM/session-0 profile.')
  console.error('Start DataMoat from the real Windows desktop user so it can use that user vault, folders, and OS secrets.')
  app.exit(1)
  return true
}

function relaunchIfRunningFromReplacedBundle(reason: string): boolean {
  if (detectInstallContext().mode !== 'packaged') return false
  const processBuildId = currentRuntimeBuildId()
  const diskBuildId = diskRuntimeBuildId()
  if (processBuildId === diskBuildId) return false

  writeLog('warn', 'electron', 'packaged_bundle_replaced_relaunching', {
    reason,
    processBuildId,
    diskBuildId,
  })
  updateHealth('electron', {
    bundleReplacedDetectedAt: new Date().toISOString(),
    bundleReplacedReason: reason,
    processBuildId,
    diskBuildId,
  })
  quitRequested = true
  app.relaunch()
  app.exit(0)
  return true
}

// On login-item / LaunchAgent startup we want a true menu-bar-only app from the
// very beginning. Waiting until `whenReady()` is too late on macOS because the
// Dock icon can already be shown by then.
if (process.platform === 'darwin' && trayOnlyLaunch) {
  try {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  } catch {
    // Retry after Electron is ready.
  }
}

type IconPoint = {
  x: number
  y: number
}

function regularPolygonPoints(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotationDeg = -22.5,
): IconPoint[] {
  return Array.from({ length: sides }, (_, index) => {
    const angle = ((rotationDeg + (360 / sides) * index) * Math.PI) / 180
    return {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    }
  })
}

function pathFromPoints(points: IconPoint[]): string {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  return `M ${first.x.toFixed(2)} ${first.y.toFixed(2)} ${rest.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')} Z`
}

function towerNodes(points: IconPoint[], radius: number, fill: string, stroke: string, strokeWidth: number): string {
  return points.map((point) => `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`).join('')
}

function ringRipples(
  cx: number,
  cy: number,
  radius: number,
  count: number,
  rx: number,
  ry: number,
  stroke: string,
  strokeWidth: number,
  opacity: number,
): string {
  const y = cy - radius
  return Array.from({ length: count }, (_, index) => {
    const angle = (360 / count) * index
    return `<ellipse cx="${cx.toFixed(2)}" cy="${y.toFixed(2)}" rx="${rx.toFixed(2)}" ry="${ry.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-opacity="${opacity}" transform="rotate(${angle.toFixed(2)} ${cx} ${cy})"/>`
  }).join('')
}

function wallMerlons(
  cx: number,
  cy: number,
  radius: number,
  count: number,
  width: number,
  height: number,
  fill: string,
  stroke?: string,
  strokeWidth = 0,
): string {
  const x = cx - width / 2
  const y = cy - radius - height / 2
  const rx = Math.min(width, height) / 3
  const strokeAttrs = stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ''
  return Array.from({ length: count }, (_, index) => {
    const angle = (360 / count) * index
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="${rx.toFixed(2)}" fill="${fill}"${strokeAttrs} transform="rotate(${angle.toFixed(2)} ${cx} ${cy})"/>`
  }).join('')
}

function windowPresetForUrl(targetUrl: string): { width: number; height: number; minWidth: number; minHeight: number; resizable: boolean } {
  try {
    const pathname = new URL(targetUrl).pathname
    if (pathname === '/setup') {
      return { width: 1180, height: 860, minWidth: 980, minHeight: 760, resizable: true }
    }
    if (pathname === '/unlock') {
      return { width: 760, height: 900, minWidth: 720, minHeight: 680, resizable: true }
    }
  } catch {
    // ignore
  }
  return { width: 1180, height: 860, minWidth: 980, minHeight: 760, resizable: true }
}

function destroyedObjectMessage(error: unknown): boolean {
  return error instanceof Error && /Object has been destroyed/i.test(error.message)
}

function windowIsUsable(win: BrowserWindow | null | undefined): win is BrowserWindow {
  if (!win) return false
  try {
    return !win.isDestroyed() && !win.webContents.isDestroyed()
  } catch {
    return false
  }
}

function safeWindowUrl(win: BrowserWindow): string | null {
  if (!windowIsUsable(win)) return null
  try {
    return win.webContents.getURL()
  } catch (error) {
    if (destroyedObjectMessage(error)) return null
    throw error
  }
}

function applyWindowPreset(win: BrowserWindow, targetUrl: string): boolean {
  if (!windowIsUsable(win)) return false
  const preset = windowPresetForUrl(targetUrl)
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(preset.width, Math.max(720, workArea.width - 32))
  const height = Math.min(preset.height, Math.max(720, workArea.height - 32))
  try {
    win.setResizable(preset.resizable)
    win.setMinimumSize(Math.min(preset.minWidth, width), Math.min(preset.minHeight, height))
    win.setSize(width, height)
    win.center()
    return true
  } catch (error) {
    if (destroyedObjectMessage(error)) return false
    throw error
  }
}

function ensureWindowUsable(win: BrowserWindow): boolean {
  const targetUrl = safeWindowUrl(win) || allowedOrigin || 'http://localhost'
  if (!windowIsUsable(win)) return false
  const preset = windowPresetForUrl(targetUrl)
  try {
    const [width, height] = win.getSize()
    if (width < preset.minWidth || height < preset.minHeight) {
      return applyWindowPreset(win, targetUrl)
    }
    return true
  } catch (error) {
    if (destroyedObjectMessage(error)) return false
    throw error
  }
}

function recoverableRuntimeLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_FAILED|ERR_ABORTED/i.test(error.message)
}

async function waitForRuntimeHttpReady(targetUrl: string, reason: string, attempt: number): Promise<void> {
  const startedAt = Date.now()
  let lastError: unknown = null
  while (Date.now() - startedAt < 3000) {
    try {
      const response = await fetch(targetUrl, { redirect: 'manual' })
      if (response.status > 0 && response.status < 500) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(150)
  }
  writeLog('warn', 'electron', 'runtime_http_not_ready_before_window_load', {
    reason,
    attempt,
    targetUrl,
    error: lastError,
  })
  updateHealth('electron', {
    runtimeHttpNotReadyAt: new Date().toISOString(),
    runtimeHttpNotReadyReason: reason,
    runtimeHttpNotReadyAttempt: attempt,
  })
}

function revealWindowDuringLoadRecovery(win: BrowserWindow): void {
  if (!windowIsUsable(win)) return
  try {
    setDockVisibility(true)
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.moveTop()
    win.focus()
    app.focus({ steal: true })
  } catch (error) {
    if (!destroyedObjectMessage(error)) {
      writeLog('warn', 'electron', 'window_load_recovery_reveal_failed', { error })
    }
  }
}

async function loadRuntimeUrl(win: BrowserWindow, targetUrl: string, reason: string): Promise<boolean> {
  let nextUrl = targetUrl
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    if (!windowIsUsable(win)) return false
    try {
      await waitForRuntimeHttpReady(nextUrl, reason, attempt)
      await win.loadURL(nextUrl)
      updateHealth('electron', {
        windowLoadSucceededAt: new Date().toISOString(),
        windowLoadSucceededReason: reason,
        windowLoadFailedAt: null,
        windowLoadFailedReason: null,
        windowLoadFailedAttempt: null,
        windowLoadRecoverable: null,
        windowLoadError: null,
      })
      return true
    } catch (error) {
      if (destroyedObjectMessage(error)) return false
      const recoverable = recoverableRuntimeLoadError(error)
      writeLog(recoverable ? 'warn' : 'error', 'electron', 'window_load_failed', {
        reason,
        attempt,
        recoverable,
        targetUrl: nextUrl,
        error,
      })
      updateHealth('electron', {
        windowLoadFailedAt: new Date().toISOString(),
        windowLoadFailedReason: reason,
        windowLoadFailedAttempt: attempt,
        windowLoadRecoverable: recoverable,
        windowLoadError: error instanceof Error ? error.message : String(error),
      })
      if (recoverable) revealWindowDuringLoadRecovery(win)
      if (!recoverable || attempt === 8) {
        if (recoverable) return false
        throw error
      }
      await sleep(Math.min(1200, 350 * attempt))
      const runtime = await ensureHealthyRuntime(`${reason}:load-retry-${attempt}`)
      nextUrl = runtime.url
      applyWindowPreset(win, nextUrl)
    }
  }
  return false
}

function nudgeLinuxWindowToFront(): void {
  if (process.platform !== 'linux') return
  const commands: Array<{ command: string; args: string[] }> = [
    {
      command: 'bash',
      args: [
        '-lc',
        `wid=$(wmctrl -lp 2>/dev/null | awk '$3 == ${process.pid} { print $1; exit }'); if [ -n "$wid" ]; then wmctrl -i -a "$wid"; fi`,
      ],
    },
    { command: 'xdotool', args: ['search', '--name', '^DataMoat', 'windowactivate'] },
    { command: 'wmctrl', args: ['-a', 'DataMoat'] },
  ]
  for (const { command, args } of commands) {
    try {
      child_process.spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      }).unref()
    } catch {
      // try next helper if available
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function findSiblingMainAppPids(): number[] {
  const currentExec = path.resolve(process.execPath)
  if (process.platform === 'win32') {
    const escaped = currentExec.replace(/'/g, "''")
    const script = [
      'Get-CimInstance Win32_Process',
      `| Where-Object { $_.ProcessId -ne ${process.pid} -and $_.ExecutablePath -eq '${escaped}' }`,
      '| Select-Object -ExpandProperty ProcessId',
    ].join(' ')
    try {
      return child_process.execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
        .split(/\r?\n/)
        .map(line => Number(line.trim()))
        .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid)
    } catch {
      return []
    }
  }

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
        if (!Number.isFinite(pid) || pid === process.pid) return []
        if (!command.includes(currentExec)) return []
        if (command.includes('/dist/daemon.js') || command.includes('\\dist\\daemon.js')) return []
        return [pid]
      })
  } catch {
    return []
  }
}

async function terminatePids(pids: number[], graceMs = 1200): Promise<void> {
  const unique = [...new Set(pids)].filter(pid => pid > 0 && pid !== process.pid)
  if (unique.length === 0) return
  for (const pid of unique) {
    try { process.kill(pid, 'SIGTERM') } catch { /* ignore */ }
  }
  const startedAt = Date.now()
  while (Date.now() - startedAt < graceMs) {
    const alive = unique.filter(pid => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    if (alive.length === 0) return
    await sleep(100)
  }
  for (const pid of unique) {
    try { process.kill(pid, 'SIGKILL') } catch { /* ignore */ }
  }
}

async function takeOverStalePackagedInstanceAfterLockFailure(): Promise<void> {
  if (detectInstallContext().mode !== 'packaged') {
    app.quit()
    return
  }

  let activePort: number | null = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2200) {
    activePort = await resolveActivePort()
    if (activePort) break
    await sleep(250)
  }
  if (activePort) {
    app.quit()
    return
  }

  const daemonPids = findDaemonPids()
  const mainPids = findSiblingMainAppPids()
  writeLog('warn', 'electron', 'single_instance_lock_stale_takeover', {
    daemonPids,
    mainPids,
    buildId: currentRuntimeBuildId(),
  })
  updateHealth('electron', {
    staleInstanceTakeoverAt: new Date().toISOString(),
    staleInstanceTakeoverDaemonPids: daemonPids,
    staleInstanceTakeoverMainPids: mainPids,
    buildId: currentRuntimeBuildId(),
  })
  await terminatePids([...daemonPids, ...mainPids])
  quitRequested = true
  app.relaunch()
  app.exit(0)
}

function reportRemoteNoScreenDaemonFailure(error: unknown, reason: string): void {
  writeLog('error', 'electron', 'remote_no_screen_daemon_start_failed', { error, reason })
  updateHealth('electron', {
    running: true,
    trayOnly: true,
    daemonStartFailedAt: new Date().toISOString(),
    daemonStartError: error instanceof Error ? error.message : String(error),
    daemonStartErrorReason: reason,
  })
  console.error('DataMoat remote no-screen capture is enabled, but the daemon did not start yet.')
  console.error(error instanceof Error ? error.message : String(error))
}

async function ensureDaemonRunningForRemoteNoScreenWithRetry(reason: string): Promise<void> {
  try {
    const runtime = await ensureDaemonRunningForRemoteNoScreen()
    updateHealth('electron', {
      running: true,
      port: runtime.port,
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      trayOnly: true,
      daemonStartError: null,
      daemonStartFailedAt: null,
      daemonStartErrorReason: null,
    })
    return
  } catch (error) {
    reportRemoteNoScreenDaemonFailure(error, reason)
  }

  setTimeout(() => {
    void ensureDaemonRunningForRemoteNoScreenWithRetry('retry')
  }, 5000)
}

async function enableRemoteNoScreenCapture(reason: string): Promise<boolean> {
  if (isSetupDone()) {
    console.log('DataMoat is already set up. Launching the packaged app without opening a setup flow.')
    return true
  }

  const state = enableBootstrapCapture('remote-no-screen')
  const preflight = await preflightBootstrapCaptureDetailed()
  if (preflight.ok) {
    updateHealth('electron', {
      bootstrapCapture: true,
      bootstrapCaptureRequestedBy: state.requestedBy,
      bootstrapCaptureStartedAt: state.createdAt,
      bootstrapCaptureEnabledBy: reason,
    })
    writeLog('info', 'electron', 'remote_no_screen_capture_enabled', {
      requestedBy: state.requestedBy,
      startedAt: state.createdAt,
      reason,
    })
    ensureRemoteNoScreenAutostart()
    console.log('DataMoat remote no-screen capture is enabled.')
    console.log('DataMoat is already collecting supported local records with pre-setup encrypted capture.')
    console.log('Complete password, authenticator, and recovery setup later on the protected desktop GUI, not in this chat.')
    return true
  }

  disableBootstrapCapture()
  updateHealth('electron', {
    bootstrapCapture: false,
    bootstrapCaptureErrorAt: new Date().toISOString(),
    bootstrapCaptureError: preflight.error || 'bootstrap capture secret unavailable in OS keychain',
    bootstrapCaptureErrorStack: preflight.stack || null,
    bootstrapCaptureEnabledBy: reason,
  })
  writeLog('error', 'electron', 'remote_no_screen_capture_unavailable', {
    reason,
    error: preflight.error,
  })
  console.error('DataMoat remote no-screen capture could not start securely.')
  console.error(preflight.error || 'A working local OS keychain is required before pre-setup capture can begin.')
  return false
}

function ensureRemoteNoScreenAutostart(): void {
  if (process.platform === 'win32') {
    ensureWindowsRemoteNoScreenAutostart()
  } else if (process.platform === 'darwin') {
    ensureMacRemoteNoScreenLaunchAgent()
  } else if (process.platform === 'linux') {
    ensureLinuxRemoteNoScreenAutostart()
  }
}

function ensurePackagedAutostart(remoteNoScreen: boolean): void {
  // Autostart mode must match how the app was actually launched. A normal
  // interactive launch — even during first-run, before setup is complete — must
  // install the plain tray login agent, never the remote-no-screen agent.
  // Otherwise the RunAtLoad agent relaunches DataMoat headless with
  // --datamoat-remote-no-screen, the single-instance lock hands the user's GUI
  // click off to that no-screen instance, and the main window never appears.
  // Only keep the no-screen agent when this launch is itself remote-no-screen
  // or a genuine remote-no-screen pre-setup capture is already running.
  const activeRemoteNoScreenCapture = isBootstrapCaptureEnabled()
    && loadBootstrapCaptureState()?.requestedBy === 'remote-no-screen'
  const keepRemoteNoScreen = remoteNoScreen || activeRemoteNoScreenCapture
  if (process.platform === 'darwin') {
    ensurePackagedTrayLaunchAgent({ remoteNoScreen: keepRemoteNoScreen })
  } else if (process.platform === 'win32') {
    if (keepRemoteNoScreen) ensureWindowsRemoteNoScreenAutostart()
    else ensureWindowsPackagedAutostart()
  } else if (process.platform === 'linux') {
    if (keepRemoteNoScreen) ensureLinuxRemoteNoScreenAutostart()
    else ensureLinuxAutostart()
  }
}

async function ensureDaemonRunningForRemoteNoScreen(): Promise<Awaited<ReturnType<typeof ensureDaemonRunning>>> {
  if (!isSetupDone()) {
    const pids = Array.from(new Set(findDaemonPids()))
    if (pids.length > 0) {
      stopDaemonPids(pids)
      await sleep(800)
    }
  }
  return ensureDaemonRunning()
}

function dataMoatIcon(): Electron.NativeImage {
  const merlons = wallMerlons(128, 128, 97, 10, 18, 24, 'url(#wallFace)', 'rgba(255,255,255,0.10)', 1.5)
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#08131d"/>
          <stop offset="60%" stop-color="#12273c"/>
          <stop offset="100%" stop-color="#08131b"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="42%" r="62%">
          <stop offset="0%" stop-color="#6ec6ff" stop-opacity="0.55"/>
          <stop offset="65%" stop-color="#296dff" stop-opacity="0.20"/>
          <stop offset="100%" stop-color="#296dff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="wallFace" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#d7c19a"/>
          <stop offset="52%" stop-color="#b49266"/>
          <stop offset="100%" stop-color="#745538"/>
        </linearGradient>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#74ddff"/>
          <stop offset="55%" stop-color="#2f87ff"/>
          <stop offset="100%" stop-color="#1543ba"/>
        </linearGradient>
        <linearGradient id="moatRing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#5de0ff" stop-opacity="0.75"/>
          <stop offset="100%" stop-color="#3675ff" stop-opacity="0.22"/>
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="url(#bg)"/>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
      <circle cx="128" cy="128" r="108" fill="url(#glow)"/>
      <circle cx="128" cy="128" r="101" fill="none" stroke="url(#moatRing)" stroke-width="16"/>
      <circle cx="128" cy="128" r="83" fill="none" stroke="url(#wallFace)" stroke-width="24"/>
      <circle cx="128" cy="128" r="83" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2.5"/>
      ${merlons}
      <circle cx="128" cy="128" r="58" fill="url(#planet)" stroke="rgba(255,255,255,0.22)" stroke-width="3"/>
      <path d="M95 111c10-14 31-23 50-19 13 2 19 10 20 16 1 6-4 11-11 13-10 2-18 10-22 21-3 9-12 13-22 12-14-1-28-11-32-22-4-9-1-16 17-21z" fill="rgba(188,255,239,0.82)"/>
      <path d="M142 139c8-5 20-7 28-3 7 3 10 9 9 15-2 10-12 18-23 19-8 1-15-2-18-9-3-7-2-15 4-22z" fill="rgba(188,255,239,0.68)"/>
      <path d="M110 163c6-2 14-1 18 4 3 4 2 9-2 12-5 4-13 5-18 2-6-3-6-13 2-18z" fill="rgba(188,255,239,0.62)"/>
      <ellipse cx="128" cy="128" rx="20" ry="58" fill="none" stroke="rgba(255,255,255,0.24)" stroke-width="2.2"/>
      <ellipse cx="128" cy="128" rx="39" ry="58" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.8"/>
      <path d="M76 112c17 8 35 12 52 12s35-4 52-12" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2" stroke-linecap="round"/>
      <path d="M76 145c17-8 35-12 52-12s35 4 52 12" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2" stroke-linecap="round"/>
      <circle cx="128" cy="128" r="65" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1.4"/>
    </svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

function fortressAppIcon(): Electron.NativeImage {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#09131d"/>
          <stop offset="100%" stop-color="#122236"/>
        </linearGradient>
        <radialGradient id="planetGlow" cx="50%" cy="35%" r="50%">
          <stop offset="0%" stop-color="#b8edff" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="#4db1ff" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#7fe3ff"/>
          <stop offset="52%" stop-color="#2e8cff"/>
          <stop offset="100%" stop-color="#1742ba"/>
        </linearGradient>
        <linearGradient id="stoneLeft" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#cfd4db"/>
          <stop offset="100%" stop-color="#8f98a5"/>
        </linearGradient>
        <linearGradient id="stoneRight" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#aab3be"/>
          <stop offset="100%" stop-color="#6c7683"/>
        </linearGradient>
        <linearGradient id="stoneFront" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#b9c1cb"/>
          <stop offset="100%" stop-color="#757f8c"/>
        </linearGradient>
        <linearGradient id="towerStone" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#d6dbe2"/>
          <stop offset="100%" stop-color="#8c95a2"/>
        </linearGradient>
        <linearGradient id="moat" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7dd8ff"/>
          <stop offset="100%" stop-color="#1b63d7"/>
        </linearGradient>
        <linearGradient id="flag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff9aa3"/>
          <stop offset="100%" stop-color="#ff5b68"/>
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="url(#bg)"/>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
      <circle cx="128" cy="82" r="52" fill="url(#planetGlow)"/>
      <circle cx="128" cy="88" r="44" fill="url(#planet)" stroke="rgba(255,255,255,0.22)" stroke-width="3"/>
      <path d="M97 75c10-14 32-19 49-14 10 3 17 10 18 18 1 5-4 9-10 10-8 1-16 7-19 16-3 7-11 10-19 9-15-2-28-12-31-23-2-6 1-12 12-16z" fill="rgba(197,247,244,0.78)"/>
      <path d="M141 97c8-4 18-4 24-1 6 3 8 8 7 13-2 8-10 13-19 14-8 1-14-2-16-8-2-7-1-13 4-18z" fill="rgba(197,247,244,0.65)"/>
      <ellipse cx="128" cy="88" rx="14" ry="44" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2"/>
      <ellipse cx="128" cy="88" rx="29" ry="44" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="1.6"/>
      <path d="M86 78c13 6 27 9 42 9s29-3 42-9" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.8" stroke-linecap="round"/>
      <path d="M86 102c13-6 27-9 42-9s29 3 42 9" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="1.8" stroke-linecap="round"/>
      <ellipse cx="128" cy="112" rx="26" ry="9" fill="rgba(12,24,40,0.65)" stroke="url(#moat)" stroke-width="4"/>
      <rect x="54" y="84" width="20" height="78" rx="8" fill="url(#towerStone)" stroke="#485361" stroke-width="3"/>
      <rect x="182" y="84" width="20" height="78" rx="8" fill="url(#towerStone)" stroke="#485361" stroke-width="3"/>
      <path d="M60 82 L60 50" stroke="#141b23" stroke-width="4" stroke-linecap="round"/>
      <path d="M196 82 L196 50" stroke="#141b23" stroke-width="4" stroke-linecap="round"/>
      <path d="M60 52 L36 66 L60 72 Z" fill="url(#flag)" stroke="#141b23" stroke-width="3" stroke-linejoin="round"/>
      <path d="M196 52 L220 38 L196 34 Z" fill="url(#flag)" stroke="#141b23" stroke-width="3" stroke-linejoin="round"/>
      <path d="M74 100 L104 76 L128 94 L128 226 L74 196 Z" fill="url(#stoneLeft)" stroke="#414b58" stroke-width="5" stroke-linejoin="round"/>
      <path d="M128 94 L152 76 L182 100 L182 196 L128 226 Z" fill="url(#stoneRight)" stroke="#414b58" stroke-width="5" stroke-linejoin="round"/>
      <path d="M104 76 L152 76 L182 100 L128 122 L74 100 Z" fill="rgba(216,222,229,0.88)" stroke="#414b58" stroke-width="4.5" stroke-linejoin="round"/>
      <path d="M74 100 L128 122 L182 100" fill="none" stroke="#3a4550" stroke-width="4" stroke-linejoin="round"/>
      <path d="M128 122 L128 226" stroke="#3b4550" stroke-width="4"/>
      <path d="M88 108 L88 206 M104 88 L104 216 M152 88 L152 216 M168 108 L168 206" stroke="rgba(56,64,74,0.6)" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M81 128 C97 134 113 134 128 132 M81 154 C97 160 113 160 128 158 M81 182 C97 188 113 188 128 186" fill="none" stroke="rgba(56,64,74,0.55)" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M128 132 C143 134 159 134 175 128 M128 158 C143 160 159 160 175 154 M128 186 C143 188 159 188 175 182" fill="none" stroke="rgba(56,64,74,0.55)" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M109 76 L128 94 L147 76" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

function professionalFortressAppIcon(): Electron.NativeImage {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#09131d"/>
          <stop offset="100%" stop-color="#122236"/>
        </linearGradient>
        <radialGradient id="planetGlow" cx="50%" cy="39%" r="58%">
          <stop offset="0%" stop-color="#91ebff" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="#4db1ff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#8cecff"/>
          <stop offset="55%" stop-color="#399cff"/>
          <stop offset="100%" stop-color="#1d4ec9"/>
        </linearGradient>
        <linearGradient id="stoneLeft" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#d4d8df"/>
          <stop offset="100%" stop-color="#8a94a1"/>
        </linearGradient>
        <linearGradient id="stoneRight" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#bcc3cd"/>
          <stop offset="100%" stop-color="#707a88"/>
        </linearGradient>
        <linearGradient id="stoneTop" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#e4e8ee"/>
          <stop offset="100%" stop-color="#b1bac5"/>
        </linearGradient>
        <linearGradient id="moat" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#7fe9ff"/>
          <stop offset="100%" stop-color="#2368de"/>
        </linearGradient>
        <radialGradient id="moatGlow" cx="50%" cy="50%" r="66%">
          <stop offset="0%" stop-color="#58b9ff" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#58b9ff" stop-opacity="0"/>
        </radialGradient>
        <linearGradient id="flag" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#ff9aa3"/>
          <stop offset="100%" stop-color="#ff5b68"/>
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="url(#bg)"/>
      <rect x="18" y="18" width="220" height="220" rx="54" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="4"/>
      <ellipse cx="128" cy="190" rx="92" ry="36" fill="url(#moatGlow)"/>
      <ellipse cx="128" cy="186" rx="86" ry="28" fill="none" stroke="url(#moat)" stroke-width="12"/>
      <ellipse cx="128" cy="186" rx="68" ry="20" fill="none" stroke="rgba(203,243,255,0.72)" stroke-width="4.5"/>
      <path d="M90 111 L90 63" stroke="#1b2430" stroke-width="4" stroke-linecap="round"/>
      <path d="M166 111 L166 61" stroke="#1b2430" stroke-width="4" stroke-linecap="round"/>
      <path d="M90 67 L63 80 L90 87 Z" fill="url(#flag)" stroke="#1b2430" stroke-width="3" stroke-linejoin="round"/>
      <path d="M166 65 L193 52 L166 47 Z" fill="url(#flag)" stroke="#1b2430" stroke-width="3" stroke-linejoin="round"/>
      <path d="M68 120 L105 94 L128 109 L128 202 L68 171 Z" fill="url(#stoneLeft)" stroke="#404a56" stroke-width="5" stroke-linejoin="round"/>
      <path d="M128 109 L151 94 L188 120 L188 171 L128 202 Z" fill="url(#stoneRight)" stroke="#404a56" stroke-width="5" stroke-linejoin="round"/>
      <path d="M105 94 L151 94 L188 120 L128 145 L68 120 Z M88 120 L128 144 L168 120 L146 100 L110 100 Z" fill="url(#stoneTop)" fill-rule="evenodd" stroke="#404a56" stroke-width="4.4" stroke-linejoin="round"/>
      <path d="M88 120 L110 100 L146 100 L168 120 L128 144 Z" fill="rgba(9,18,29,0.54)"/>
      <ellipse cx="128" cy="136" rx="26" ry="9" fill="rgba(6,14,24,0.28)"/>
      <circle cx="128" cy="109" r="40" fill="url(#planetGlow)"/>
      <circle cx="128" cy="112" r="31" fill="url(#planet)" stroke="rgba(255,255,255,0.24)" stroke-width="2.6"/>
      <path d="M108 101c8-10 22-14 34-10 8 2 14 8 14 13 0 5-3 9-9 10-7 1-12 6-14 13-2 5-8 8-14 7-10-1-19-8-21-17-1-5 2-10 10-16z" fill="rgba(202,249,248,0.78)"/>
      <path d="M137 122c6-3 13-3 18 0 5 2 7 6 6 10-1 6-7 10-13 11-6 0-10-2-12-7-1-4-1-9 1-14z" fill="rgba(202,249,248,0.54)"/>
      <path d="M108 92c7-5 16-8 27-8 12 0 22 4 29 11" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M105 112c8 3 16 4 23 4 13 0 22-3 29-8" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="1.7" stroke-linecap="round"/>
      <path d="M128 119 L148 107 L171 121 L128 138 L85 121 Z" fill="rgba(8,18,28,0.34)"/>
      <path d="M68 120 L128 145 L188 120" fill="none" stroke="#3b4550" stroke-width="4" stroke-linejoin="round"/>
      <path d="M128 145 L128 202" stroke="#39424e" stroke-width="4"/>
      <path d="M90 128 L90 178 M108 103 L108 192 M148 103 L148 192 M166 128 L166 178" stroke="rgba(51,60,71,0.5)" stroke-width="2.3" stroke-linecap="round"/>
      <path d="M82 148 C98 154 114 154 128 152 M82 172 C98 178 114 178 128 176" fill="none" stroke="rgba(51,60,71,0.5)" stroke-width="2" stroke-linecap="round"/>
      <path d="M128 152 C142 154 158 154 174 148 M128 176 C142 178 158 178 174 172" fill="none" stroke="rgba(51,60,71,0.5)" stroke-width="2" stroke-linecap="round"/>
    </svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

type TrayMode = 'active' | 'idle' | 'error'

type TrayStatus = {
  mode: TrayMode
  daemonRunning: boolean
  captureRunning: boolean
  locked: boolean | null
  sessionCount: number | null
  port: number | null
}

function resolveTrayTemplateAsset(): string | null {
  const candidates = [
    path.join(process.resourcesPath, 'DataMoatStatusTemplate.png'),
    path.join(__dirname, '..', '..', 'release', 'DataMoatStatusTemplate.png'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

function macTrayTemplateIcon(): Electron.NativeImage | null {
  if (process.platform !== 'darwin' || !trayTemplateAsset) return null
  const image = nativeImage.createFromPath(trayTemplateAsset)
  if (image.isEmpty()) return null
  image.setTemplateImage(true)
  return image
}

function resolveLinuxTrayAsset(mode: TrayMode): string | null {
  if (process.platform !== 'linux') return null
  const candidate = path.join(__dirname, 'assets', `tray-${mode}.png`)
  return fs.existsSync(candidate) ? candidate : null
}

function nativeImageFromFirstExistingPath(candidates: string[]): Electron.NativeImage | null {
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return null
}

function resolveRuntimeIcon(): Electron.NativeImage {
  if (process.platform === 'win32') {
    const image = nativeImageFromFirstExistingPath([
      path.join(process.resourcesPath, 'DataMoat.ico'),
      path.join(__dirname, '..', '..', 'release', 'DataMoat.ico'),
    ])
    if (image) return image
  }
  return professionalFortressAppIcon()
}

function resolveWindowsTrayIcon(mode: TrayMode): Electron.NativeImage | null {
  if (process.platform !== 'win32') return null
  return nativeImageFromFirstExistingPath([
    path.join(process.resourcesPath, `DataMoatTray-${mode}.ico`),
    path.join(process.resourcesPath, 'DataMoat.ico'),
    path.join(__dirname, '..', '..', 'release', `DataMoatTray-${mode}.ico`),
    path.join(__dirname, '..', '..', 'release', 'DataMoat.ico'),
  ])
}

function trayIcon(mode: TrayMode): Electron.NativeImage {
  const accent = mode === 'active' ? '#3fd7a3' : mode === 'idle' ? '#f1b14d' : '#f06b78'
  const wall = '#d7c19a'
  const wallShadow = '#7a5b3f'
  const sea = '#4ba7ff'
  const seaDark = '#173aa3'
  const cloud = '#d3f4ff'
  const merlons = wallMerlons(32, 32, 23, 8, 4.8, 6.8, wall, wallShadow, 0.9)
  const size = process.platform === 'darwin' ? 20 : 22
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="26" fill="#08121a"/>
      <circle cx="32" cy="32" r="25" fill="none" stroke="${accent}" stroke-width="3.5"/>
      <circle cx="32" cy="32" r="20" fill="none" stroke="${wall}" stroke-width="5"/>
      ${merlons}
      <circle cx="32" cy="32" r="11.4" fill="url(#planet)"/>
      <path d="M25 30c3-4 9-6 14-4 3 1 5 3 5 5 0 2-2 4-5 4-3 0-5 2-6 5-1 2-4 3-6 3-4 0-7-3-8-6-1-3 2-5 6-7z" fill="${cloud}" opacity="0.86"/>
      <ellipse cx="32" cy="32" rx="4.2" ry="11.2" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.2"/>
      <path d="M22 28c3 1.8 6.5 2.6 10 2.6S39 29.8 42 28" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1.1" stroke-linecap="round"/>
      <defs>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="${sea}"/>
          <stop offset="100%" stop-color="${seaDark}"/>
        </linearGradient>
      </defs>
    </svg>`
  const image = nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: size, height: size })
  const raster = nativeImage.createFromBuffer(image.toPNG())
  raster.setTemplateImage(false)
  return raster
}

function fortressTrayIcon(mode: TrayMode): Electron.NativeImage {
  const size = process.platform === 'darwin' ? 20 : 22
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="27" fill="#07121b"/>
      <circle cx="32" cy="21" r="11" fill="url(#planet)" stroke="rgba(255,255,255,0.18)" stroke-width="1.4"/>
      <path d="M24 19c3-4 9-5 14-3 3 1 4 3 4 5 0 2-2 3-4 3-3 0-5 2-6 4-1 2-3 3-6 2-5-1-8-4-8-7 0-1 2-3 6-4z" fill="rgba(208,247,248,0.72)"/>
      <ellipse cx="32" cy="26.5" rx="6.8" ry="2.4" fill="rgba(9,23,39,0.72)" stroke="#63c8ff" stroke-width="1.2"/>
      <rect x="11.5" y="20" width="6" height="17" rx="2.2" fill="#9ca6b4" stroke="#44505d" stroke-width="1.8"/>
      <rect x="46.5" y="20" width="6" height="17" rx="2.2" fill="#9ca6b4" stroke="#44505d" stroke-width="1.8"/>
      <path d="M14.5 19 L14.5 11" stroke="#111822" stroke-width="2" stroke-linecap="round"/>
      <path d="M49.5 19 L49.5 11" stroke="#111822" stroke-width="2" stroke-linecap="round"/>
      <path d="M14.5 12 L8 15.5 L14.5 17 Z" fill="#ff7a84" stroke="#111822" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M49.5 12 L56 8 L49.5 6.5 Z" fill="#ff7a84" stroke="#111822" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M14 24 L25 17.5 L32 22 L32 52 L14 42 Z" fill="#b8c0cb" stroke="#44505d" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M32 22 L39 17.5 L50 24 L50 42 L32 52 Z" fill="#8c97a4" stroke="#44505d" stroke-width="2.2" stroke-linejoin="round"/>
      <path d="M25 17.5 L39 17.5 L50 24 L32 31 L14 24 Z" fill="#d4dae1" stroke="#44505d" stroke-width="2"/>
      <path d="M14 24 L32 31 L50 24" fill="none" stroke="#3b4551" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M32 31 L32 52" stroke="#3b4551" stroke-width="1.7"/>
      <path d="M19 27 L19 43 M24 21 L24 47 M40 21 L40 47 M45 27 L45 43" stroke="rgba(53,61,71,0.55)" stroke-width="1.2" stroke-linecap="round"/>
      <defs>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#7fe3ff"/>
          <stop offset="100%" stop-color="#1742ba"/>
        </linearGradient>
      </defs>
    </svg>`
  const image = nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: size, height: size })
  const raster = nativeImage.createFromBuffer(image.toPNG())
  raster.setTemplateImage(false)
  return raster
}

function professionalFortressTrayIcon(mode: TrayMode): Electron.NativeImage {
  const moatStroke = mode === 'active' ? '#66dcff' : mode === 'error' ? '#2f79d6' : '#4696ff'
  const size = process.platform === 'darwin' ? 20 : 22
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <ellipse cx="32" cy="47.5" rx="21" ry="7" fill="rgba(49,111,255,0.18)" stroke="${moatStroke}" stroke-width="2.8"/>
      <ellipse cx="32" cy="20.5" rx="10.2" ry="10.2" fill="url(#planet)" stroke="rgba(255,255,255,0.14)" stroke-width="1.1"/>
      <path d="M25.6 17.5c2.4-3.2 7-4.3 10.9-3.4 2.4.6 4.2 2.2 4.4 3.8.2 1.3-.9 2.4-2.4 2.7-2 .3-3.7 1.8-4.4 3.8-.7 1.5-2.5 2.4-4.4 2.3-3.6-.2-6.5-2.3-7.2-4.9-.3-1.3.4-2.8 3.1-4.3z" fill="rgba(203,248,246,0.72)"/>
      <ellipse cx="32" cy="20.5" rx="3.5" ry="10.2" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="0.8"/>
      <path d="M21.8 17.8c3.1 1.4 6.5 2.1 10.2 2.1s7.1-.7 10.2-2.1" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.9" stroke-linecap="round"/>
      <path d="M15.2 27 L25 20.4 L32 24.6 L32 50.5 L15.2 42.4 Z" fill="#b6bec8" stroke="#44505d" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M32 24.6 L39 20.4 L48.8 27 L48.8 42.4 L32 50.5 Z" fill="#8893a0" stroke="#44505d" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M25 20.4 L39 20.4 L48.8 27 L32 34.3 L15.2 27 Z" fill="#dde2e8" stroke="#44505d" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M19.6 25.2 L22.4 23.4 L25.2 24.9 L28 23.2 L30.8 24.6 L33.6 23.2 L36.4 24.6 L39.2 23.2 L42 24.9 L44.8 23.4 L47.6 25.2" fill="none" stroke="#44505d" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M32 34.3 L32 50.5" stroke="#3a4450" stroke-width="1.4"/>
      <path d="M20.8 28.5 L20.8 42.5 M25.6 21.6 L25.6 45.4 M38.4 21.6 L38.4 45.4 M43.2 28.5 L43.2 42.5" stroke="rgba(54,63,73,0.45)" stroke-width="1" stroke-linecap="round"/>
      <defs>
        <linearGradient id="planet" x1="0.15" y1="0.08" x2="0.85" y2="1">
          <stop offset="0%" stop-color="#8ae9ff"/>
          <stop offset="100%" stop-color="#1b49c7"/>
        </linearGradient>
      </defs>
    </svg>`
  const image = nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: size, height: size })
  const raster = nativeImage.createFromBuffer(image.toPNG())
  raster.setTemplateImage(false)
  return raster
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function currentTrayStatus(): TrayStatus {
  const health = readJsonFile<any>(HEALTH_FILE)
  const publicStatus = readJsonFile<any>(PUBLIC_STATUS_FILE)
  const daemon = health?.components?.daemon ?? {}
  const capture = health?.components?.capture ?? {}
  const daemonRunning = daemon.running === true && daemonProcessLooksAlive(daemon.pid)
  const captureRunning = daemonRunning && (capture.running === true || daemon.captureRunning === true)
  const locked = typeof daemon.locked === 'boolean' ? daemon.locked : null
  const sessionCount = typeof publicStatus?.totalSessions === 'number' ? publicStatus.totalSessions : null
  const port = typeof daemon.port === 'number' ? daemon.port : null
  return {
    mode: !daemonRunning ? 'error' : captureRunning ? 'active' : 'idle',
    daemonRunning,
    captureRunning,
    locked,
    sessionCount,
    port,
  }
}

function daemonProcessLooksAlive(pid: unknown): boolean {
  if (typeof pid === 'number' && Number.isFinite(pid)) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  return findDaemonPids().length > 0
}

function setDockVisibility(visible: boolean): void {
  if (process.platform !== 'darwin') return
  if (visible) app.dock?.show()
  else app.dock?.hide()
}

function setMacActivation(mode: 'regular' | 'accessory'): void {
  if (process.platform !== 'darwin') return
  app.setActivationPolicy(mode)
}

function enforceTrayOnlyPresentation(): void {
  if (process.platform !== 'darwin') return
  try {
    app.setActivationPolicy('accessory')
    app.dock?.hide()
  } catch {
    // Ignore; tray-only startup retries this again after ready.
  }
}

function usableWindow(): BrowserWindow | null {
  if (!mainWindow) return null
  if (!windowIsUsable(mainWindow)) {
    mainWindow = null
    return null
  }
  return mainWindow
}

function originPort(origin: string | null): number | null {
  if (!origin) return null
  try {
    const port = Number(new URL(origin).port)
    return Number.isFinite(port) && port > 0 ? port : null
  } catch {
    return null
  }
}

function urlOrigin(targetUrl: string): string | null {
  try {
    return new URL(targetUrl).origin
  } catch {
    return null
  }
}

async function ensureHealthyRuntime(reason: string): Promise<{ pid: number | null; port: number; url: string; recovered: boolean }> {
  if (runtimeRecoveryInFlight) return runtimeRecoveryInFlight

  runtimeRecoveryInFlight = (async () => {
    const previousOrigin = allowedOrigin
    const previousPort = originPort(previousOrigin)
    const activePortBefore = await resolveActivePort()
    const runtime = await ensureDaemonRunning()
    const nextOrigin = `http://localhost:${runtime.port}`
    const recovered = !activePortBefore || activePortBefore !== runtime.port || previousPort !== runtime.port
    allowedOrigin = nextOrigin
    updateHealth('electron', {
      running: true,
      port: runtime.port,
      lastDaemonEnsureAt: new Date().toISOString(),
      lastDaemonEnsureReason: reason,
      ...(recovered
        ? {
            daemonRecoveredAt: new Date().toISOString(),
            daemonRecoveredReason: reason,
            previousPort: previousPort ?? null,
            activePortBeforeRecovery: activePortBefore ?? null,
          }
        : {}),
    })
    return { ...runtime, recovered }
  })().finally(() => {
    runtimeRecoveryInFlight = null
  })

  return runtimeRecoveryInFlight
}

async function ensureExistingWindowRuntime(win: BrowserWindow, reason: string, forceReload = false): Promise<boolean> {
  const currentUrl = safeWindowUrl(win)
  if (!currentUrl && !windowIsUsable(win)) return false
  const currentOrigin = currentUrl ? urlOrigin(currentUrl) : null
  const runtime = await ensureHealthyRuntime(reason)
  if (!windowIsUsable(win)) {
    updateHealth('electron', {
      windowRuntimeSkippedAt: new Date().toISOString(),
      windowRuntimeSkippedReason: reason,
      windowRuntimeSkippedCause: 'window-destroyed-after-runtime',
    })
    return false
  }
  const nextOrigin = `http://localhost:${runtime.port}`
  const needsReload = forceReload || runtime.recovered || currentOrigin !== nextOrigin || !currentUrl || currentUrl === 'about:blank'
  if (!needsReload) return true

  if (!applyWindowPreset(win, runtime.url) || !windowIsUsable(win)) return false
  const loaded = await loadRuntimeUrl(win, runtime.url, reason)
  if (!loaded) {
    updateHealth('electron', {
      windowRuntimeSkippedAt: new Date().toISOString(),
      windowRuntimeSkippedReason: reason,
      windowRuntimeSkippedCause: windowIsUsable(win) ? 'runtime-load-failed' : 'window-destroyed-during-load',
    })
  }
  return loaded
}

function ensureDaemonRecoveredInBackground(reason: string): void {
  if (quitRequested) return
  void (async () => {
    try {
      const runtime = await ensureHealthyRuntime(reason)
      const win = usableWindow()
      if (win && runtime.recovered) {
        await ensureExistingWindowRuntime(win, `${reason}:reload`, true)
      }
    } catch (error) {
      writeLog('warn', 'electron', 'daemon_recovery_failed', { reason, error })
      updateHealth('electron', {
        daemonRecoveryFailedAt: new Date().toISOString(),
        daemonRecoveryFailedReason: reason,
        daemonRecoveryError: error instanceof Error ? error.message : String(error),
      })
    } finally {
      updateTray()
    }
  })()
}

async function revealMainWindow(): Promise<void> {
  if (mainWindowCreation) {
    revealAfterWindowCreation = true
    try {
      await mainWindowCreation
    } catch (error) {
      writeLog('warn', 'electron', 'window_creation_wait_before_reveal_failed', { error })
    }
  }

  const win = usableWindow()
  if (!win) {
    trayOnlyLaunch = false
    setMacActivation('regular')
    await createMainWindow(true)
    return
  }

  setMacActivation('regular')
  setDockVisibility(true)
  let runtimeLoaded = await ensureExistingWindowRuntime(win, 'reveal-main-window')
  if (!runtimeLoaded && windowIsUsable(win)) {
    await sleep(700)
    runtimeLoaded = await ensureExistingWindowRuntime(win, 'reveal-main-window-retry', true)
  }
  if (!windowIsUsable(win)) return
  ensureWindowUsable(win)
  if (!windowIsUsable(win)) return
  try {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    if (process.platform === 'linux') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    }
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
    win.focus()
    app.focus({ steal: true })
    nudgeLinuxWindowToFront()
  } catch (error) {
    if (destroyedObjectMessage(error)) return
    throw error
  }
  setTimeout(() => {
    if (windowIsUsable(win)) {
      try {
        win.setAlwaysOnTop(false)
        if (process.platform === 'linux') {
          win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true })
        }
      } catch (error) {
        if (!destroyedObjectMessage(error)) {
          writeLog('warn', 'electron', 'window_topmost_reset_failed', { error })
        }
      }
    }
  }, 250)
  updateTray()
}

function installSessionPolicy(): void {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    headers['X-Frame-Options'] = ['DENY']
    headers['X-Content-Type-Options'] = ['nosniff']
    headers['Referrer-Policy'] = ['no-referrer']
    callback({ responseHeaders: headers })
  })
}

function installWindowPolicy(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.webContents.on('will-navigate', (event, url) => {
    if (!allowedOrigin || !url.startsWith(allowedOrigin)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  win.webContents.on('will-attach-webview', event => {
    event.preventDefault()
  })
}

async function createMainWindow(showOnReady = true): Promise<void> {
  if (relaunchIfRunningFromReplacedBundle('create-window')) return
  if (showOnReady) revealAfterWindowCreation = true

  const existing = usableWindow()
  if (existing) {
    if (showOnReady) {
      setMacActivation('regular')
      setDockVisibility(true)
      let runtimeLoaded = await ensureExistingWindowRuntime(existing, 'create-window-existing')
      if (!runtimeLoaded && windowIsUsable(existing)) {
        await sleep(700)
        runtimeLoaded = await ensureExistingWindowRuntime(existing, 'create-window-existing-retry', true)
      }
      if (!windowIsUsable(existing)) return
      ensureWindowUsable(existing)
      if (!windowIsUsable(existing)) return
      try {
        if (existing.isMinimized()) existing.restore()
        if (!existing.isVisible()) existing.show()
        existing.focus()
      } catch (error) {
        if (destroyedObjectMessage(error)) return
        throw error
      }
    }
    return
  }

  if (mainWindowCreation) return mainWindowCreation

  mainWindowCreation = createMainWindowInner(showOnReady).finally(() => {
    mainWindowCreation = null
    revealAfterWindowCreation = false
  })
  return mainWindowCreation
}

async function createMainWindowInner(showOnReady = true): Promise<void> {
  const runtime = await ensureHealthyRuntime('create-window')
  updateHealth('electron', { running: true, port: runtime.port, startedAt: new Date().toISOString() })
  if (process.platform === 'darwin') {
    app.dock?.setIcon(runtimeIcon)
    app.setName('DataMoat')
  }

  const win = new BrowserWindow({
    ...windowPresetForUrl(runtime.url),
    backgroundColor: '#07090d',
    show: false,
    autoHideMenuBar: true,
    icon: runtimeIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  })
  mainWindow = win

  installWindowPolicy(win)
  applyWindowPreset(win, runtime.url)

  win.webContents.on('did-navigate', (_event, targetUrl) => {
    applyWindowPreset(win, targetUrl)
  })
  win.webContents.on('did-navigate-in-page', (_event, targetUrl) => {
    applyWindowPreset(win, targetUrl)
  })

  win.once('ready-to-show', () => {
    if (!windowIsUsable(win)) return
    if (showOnReady || revealAfterWindowCreation) {
      setDockVisibility(true)
      try {
        win.show()
        if (process.platform === 'linux') {
          win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        }
        win.setAlwaysOnTop(true, 'screen-saver')
        win.moveTop()
        win.focus()
        app.focus({ steal: true })
        nudgeLinuxWindowToFront()
      } catch (error) {
        if (!destroyedObjectMessage(error)) {
          writeLog('warn', 'electron', 'window_ready_show_failed', { error })
        }
      }
      setTimeout(() => {
        if (windowIsUsable(win)) {
          try {
            win.setAlwaysOnTop(false)
            if (process.platform === 'linux') {
              win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true })
            }
          } catch (error) {
            if (!destroyedObjectMessage(error)) {
              writeLog('warn', 'electron', 'window_ready_topmost_reset_failed', { error })
            }
          }
        }
      }, 250)
    } else {
      setDockVisibility(false)
    }
    updateTray()
  })
  win.on('close', event => {
    if (quitRequested) return
    event.preventDefault()
    if (windowIsUsable(win)) {
      try {
        win.hide()
      } catch (error) {
        if (!destroyedObjectMessage(error)) {
          writeLog('warn', 'electron', 'window_close_hide_failed', { error })
        }
      }
    }
    setDockVisibility(false)
    updateTray()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  const loaded = await loadRuntimeUrl(win, runtime.url, 'create-window')
  if (!loaded && (showOnReady || revealAfterWindowCreation)) {
    setTimeout(() => {
      if (!windowIsUsable(win)) return
      void ensureExistingWindowRuntime(win, 'create-window-retry', true)
        .then(() => revealMainWindow())
        .catch(error => {
          writeLog('warn', 'electron', 'window_create_retry_failed', { error })
        })
    }, 700)
  }
  if (electronRealUiSmokeEnabled()) {
    void runElectronRealUiSmoke(win, runtime.url)
  }
}

function electronRealUiSmokeEnabled(): boolean {
  return process.env.DATAMOAT_ELECTRON_REAL_UI_SMOKE === '1'
}

function requiredSmokeEnv(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) throw new Error(`${name} is required`)
  return value
}

function smokeTimeoutMs(): number {
  const parsed = Number(process.env.DATAMOAT_UI_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 90000
}

function smokeScreenshotDir(): string {
  return process.env.DATAMOAT_UI_SCREENSHOT_DIR?.trim()
    ? path.resolve(process.env.DATAMOAT_UI_SCREENSHOT_DIR.trim())
    : path.join(process.cwd(), 'datamoat-real-ui-proof')
}

function smokeResultFile(): string {
  return process.env.DATAMOAT_UI_RESULT_FILE?.trim()
    ? path.resolve(process.env.DATAMOAT_UI_RESULT_FILE.trim())
    : path.join(smokeScreenshotDir(), 'result.json')
}

function writeElectronRealUiSmokeResult(result: Record<string, unknown>): void {
  const file = smokeResultFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

async function evalInSmokeWindow<T = unknown>(win: BrowserWindow, expression: string): Promise<T> {
  return await win.webContents.executeJavaScript(expression, true) as T
}

async function waitForSmokeWindow(win: BrowserWindow, predicate: string, label: string, timeout = smokeTimeoutMs()): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    try {
      if (await evalInSmokeWindow<boolean>(win, `Boolean((${predicate})())`)) return
    } catch {
      // Renderer can be between navigations.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function loadSmokeUrl(win: BrowserWindow, url: string): Promise<void> {
  await win.loadURL(url)
  await waitForSmokeWindow(win, '() => document.readyState === "complete"', `load ${url}`)
}

async function fillSmokeInput(win: BrowserWindow, selector: string, value: string): Promise<void> {
  await waitForSmokeWindow(win, `() => !!document.querySelector(${JSON.stringify(selector)})`, selector)
  await evalInSmokeWindow(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('input not found');
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
}

async function clickSmokeSelector(win: BrowserWindow, selector: string): Promise<void> {
  await waitForSmokeWindow(win, `() => !!document.querySelector(${JSON.stringify(selector)})`, selector)
  await evalInSmokeWindow(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!(el instanceof HTMLElement)) throw new Error('click target not found');
    el.click();
    return true;
  })()`)
}

async function smokeScreenshot(win: BrowserWindow, name: string): Promise<string> {
  const dir = smokeScreenshotDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  const image = await win.webContents.capturePage()
  fs.writeFileSync(file, image.toPNG())
  return file
}

async function relockSmokeWindow(win: BrowserWindow, baseUrl: string): Promise<void> {
  await loadSmokeUrl(win, `${baseUrl}/`)
  win.webContents.reloadIgnoringCache()
  await waitForSmokeWindow(win, '() => location.pathname === "/unlock"', 'unlock page after reload')
}

async function recoverAndResetSmokeWindow(win: BrowserWindow, baseUrl: string, kind: string, secret: string, password: string): Promise<void> {
  await loadSmokeUrl(win, `${baseUrl}/unlock`)
  await waitForSmokeWindow(win, '() => document.querySelector("#password-section")', 'unlock form')
  await smokeScreenshot(win, `${kind}-01-unlock`)
  await clickSmokeSelector(win, '.recovery-link button')
  await waitForSmokeWindow(win, '() => document.querySelector("#recovery-section") && document.querySelector("#recovery-section").style.display !== "none"', 'recovery section')
  await fillSmokeInput(win, '#recovery-input', secret)
  await clickSmokeSelector(win, '#btn-recover')
  await waitForSmokeWindow(win, '() => location.pathname === "/" && document.querySelector("#recovery-reset-backdrop") && !document.querySelector("#recovery-reset-backdrop").hidden', `${kind} reset prompt`)
  await smokeScreenshot(win, `${kind}-02-reset-prompt`)
  await fillSmokeInput(win, '#recovery-reset-password', password)
  await fillSmokeInput(win, '#recovery-reset-confirm', password)
  await clickSmokeSelector(win, '#recovery-reset-save')
  await waitForSmokeWindow(win, '() => document.querySelector("#recovery-reset-backdrop") && document.querySelector("#recovery-reset-backdrop").hidden', `${kind} reset saved`)
  await smokeScreenshot(win, `${kind}-03-reset-success`)
}

async function passwordUnlockSmokeWindow(win: BrowserWindow, baseUrl: string, password: string, arch: string): Promise<void> {
  await loadSmokeUrl(win, `${baseUrl}/unlock`)
  await waitForSmokeWindow(win, '() => location.pathname === "/unlock" || document.querySelector("#pw-input")', 'unlock page')
  await fillSmokeInput(win, '#pw-input', password)
  await clickSmokeSelector(win, '#btn-unlock')
  await waitForSmokeWindow(win, '() => location.pathname === "/" && document.querySelector("#session-list")', 'main app after password unlock')
  await smokeScreenshot(win, `${arch}-password-unlock-success`)
}

async function settingsSmokeWindow(win: BrowserWindow): Promise<Record<string, string>> {
  await clickSmokeSelector(win, '#open-settings-btn')
  await waitForSmokeWindow(win, '() => document.querySelector("#settings-backdrop") && !document.querySelector("#settings-backdrop").hidden', 'settings panel')
  await waitForSmokeWindow(win, '() => !document.querySelector("#update-install-type").textContent.includes("detecting")', 'update settings loaded')
  await smokeScreenshot(win, 'settings-update-state')
  return await evalInSmokeWindow<Record<string, string>>(win, `(() => ({
    title: document.querySelector('#manual-update-title')?.textContent || document.querySelector('#update-toggle .switch-title')?.textContent || '',
    subtitle: document.querySelector('#manual-update-subtitle')?.textContent || document.querySelector('#update-toggle .switch-subtitle')?.textContent || '',
    toggleHidden: String(!!document.querySelector('#update-toggle')?.hidden),
    manualRowHidden: String(!!document.querySelector('#manual-update-row')?.hidden),
    install: document.querySelector('#update-install-type')?.textContent || '',
    method: document.querySelector('#update-path')?.textContent || '',
    version: document.querySelector('#update-app-version')?.textContent || ''
  }))()`)
}

async function clickManualUpdateSmokeWindow(win: BrowserWindow): Promise<Record<string, string>> {
  await clickSmokeSelector(win, '#update-install-latest-btn')
  await waitForSmokeWindow(win, `() => {
    const message = document.querySelector('#update-message')?.textContent || '';
    const state = document.querySelector('#update-state')?.textContent || '';
    return /Downloaded the latest packaged release|close, replace the app|downloading|installing/i.test(message)
      || /running|downloading|installing/i.test(state);
  }`, 'manual update download/install state', Math.max(smokeTimeoutMs(), 240000))
  await smokeScreenshot(win, 'manual-update-clicked')
  return await evalInSmokeWindow<Record<string, string>>(win, `(() => ({
    message: document.querySelector('#update-message')?.textContent || '',
    state: document.querySelector('#update-state')?.textContent || '',
    version: document.querySelector('#update-app-version')?.textContent || '',
    toggleHidden: String(!!document.querySelector('#update-toggle')?.hidden),
    manualRowHidden: String(!!document.querySelector('#manual-update-row')?.hidden)
  }))()`)
}

async function runElectronRealUiSmoke(win: BrowserWindow, baseUrl: string): Promise<void> {
  const startedAt = new Date().toISOString()
  const arch = process.env.DATAMOAT_PACKAGE_ARCH || process.arch
  const mode = process.env.DATAMOAT_UI_MODE || 'recovery-and-password'
  try {
    const password = requiredSmokeEnv('DATAMOAT_UI_PASSWORD')
    const phrase = mode === 'password-only' || mode === 'manual-update'
      ? ''
      : requiredSmokeEnv('DATAMOAT_UI_RECOVERY_PHRASE')

    let flow: Record<string, unknown>
    if (mode === 'password-only') {
      await passwordUnlockSmokeWindow(win, baseUrl, password, arch)
      flow = { settings: await settingsSmokeWindow(win) }
    } else if (mode === 'manual-update') {
      await passwordUnlockSmokeWindow(win, baseUrl, password, arch)
      const settings = await settingsSmokeWindow(win)
      const manualUpdate = await clickManualUpdateSmokeWindow(win)
      flow = { settings, manualUpdate }
    } else {
      await recoverAndResetSmokeWindow(win, baseUrl, 'recovery-phrase', phrase, password)
      await relockSmokeWindow(win, baseUrl)
      await passwordUnlockSmokeWindow(win, baseUrl, password, arch)
      flow = { settings: await settingsSmokeWindow(win) }
    }

    const screenshots = fs.readdirSync(smokeScreenshotDir())
      .filter(file => file.endsWith('.png'))
      .sort()
    writeElectronRealUiSmokeResult({
      ok: true,
      driver: 'electron-main',
      mode,
      arch,
      baseUrl,
      screenshotDir: smokeScreenshotDir(),
      screenshots,
      flow,
      startedAt,
      finishedAt: new Date().toISOString(),
    })
  } catch (error) {
    try { await smokeScreenshot(win, 'failure-state') } catch { /* ignore */ }
    writeElectronRealUiSmokeResult({
      ok: false,
      driver: 'electron-main',
      mode,
      arch,
      baseUrl,
      screenshotDir: smokeScreenshotDir(),
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: new Date().toISOString(),
    })
  } finally {
    quitRequested = true
    app.quit()
  }
}

function toggleMainWindow(): void {
  const win = usableWindow()
  if (!win) {
    if (trayOnlyLaunch) {
      trayOnlyLaunch = false
      if (resolveInstallChoiceOnStartup() === 'quit') {
        app.quit()
        return
      }
    }
    void revealMainWindow()
    return
  }
  try {
    if (win.isVisible()) {
      win.hide()
      setDockVisibility(false)
      setMacActivation('accessory')
      updateTray()
      return
    }
  } catch (error) {
    if (destroyedObjectMessage(error)) {
      if (mainWindow === win) mainWindow = null
      void revealMainWindow()
      return
    }
    throw error
  }
  if (trayOnlyLaunch) {
    trayOnlyLaunch = false
    if (resolveInstallChoiceOnStartup() === 'quit') {
      app.quit()
      return
    }
  }
  void revealMainWindow()
}

function launchAlternativeApp(targetAppPath: string): void {
  try {
    child_process.spawn('open', [targetAppPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    }).unref()
  } catch {
    // ignore
  }
}

function applyInstallPreferenceFromStartup(preference: InstallPreference): 'continue' | 'quit' {
  const state = detectDualInstallState()
  const result = applyInstallPreference(preference)
  writeLog('info', 'electron', 'install_preference_applied', {
    preference,
    state,
    result,
  })
  updateHealth('electron', {
    installPreference: preference,
    installPreferenceAppliedAt: new Date().toISOString(),
    installPreferenceResult: result,
  })

  if (result.targetAppPath && state.currentVariant !== preference) {
    launchAlternativeApp(result.targetAppPath)
    return 'quit'
  }

  return 'continue'
}

function promptInstallChoice(state: DualInstallState): InstallPreference {
  const packagedLabel = state.packagedAppPath
    ? `Use DMG install\n(${state.packagedAppPath})`
    : 'Use DMG install'
  const sourceLabel = state.sourceRoot
    ? `Use source install\n(${state.sourceRoot})`
    : 'Use source install'
  const defaultId = state.currentVariant === 'source' ? 1 : 0
  try {
    if (process.platform === 'darwin') {
      app.setActivationPolicy('regular')
      app.dock?.show()
      app.focus({ steal: true })
    }
  } catch {
    // The dialog itself is still safe to show; this only helps bring it front.
  }
  const clicked = dialog.showMessageBoxSync({
    type: 'question',
    buttons: [packagedLabel, sourceLabel],
    defaultId,
    cancelId: defaultId,
    noLink: true,
    title: 'DataMoat: multiple installs detected',
    message: 'Two DataMoat installs found on this computer',
    detail: 'Pick which one to run. This choice is remembered; you will be asked again when either install changes, moves, or is replaced by a new DMG.',
  })
  return clicked === 1 ? 'source' : 'packaged'
}

function resolveInstallChoiceOnStartup(): 'continue' | 'quit' {
  if (process.platform !== 'darwin') return 'continue'
  if (!app.isReady()) {
    updateHealth('electron', {
      installChoiceDeferredUntilReady: true,
      installChoiceDeferredAt: new Date().toISOString(),
    })
    return 'continue'
  }

  const state = detectDualInstallState()
  if (!state.eligible || !state.hasBoth) return 'continue'

  const storedChoiceIsCurrent = installChoiceMatchesState(state.storedChoice, state)

  if (state.storedChoice && !storedChoiceIsCurrent) {
    clearInstallChoice()
  }

  if (storedChoiceIsCurrent && state.storedChoice?.preferred === 'packaged') {
    return applyInstallPreferenceFromStartup('packaged')
  }
  if (storedChoiceIsCurrent && state.storedChoice?.preferred === 'source') {
    return applyInstallPreferenceFromStartup('source')
  }

  if (trayOnlyLaunch) {
    updateHealth('electron', {
      installChoicePending: true,
      installChoicePendingAt: new Date().toISOString(),
    })
    return 'continue'
  }

  const chosen = promptInstallChoice(state)
  saveInstallChoice(chosen, {
    sourceRoot: state.sourceRoot,
    sourceAppPath: state.sourceAppPath,
    packagedAppPath: state.packagedAppPath,
    sourceAppFingerprint: state.sourceAppFingerprint,
    packagedAppFingerprint: state.packagedAppFingerprint,
  })
  updateHealth('electron', {
    installChoicePromptedAt: new Date().toISOString(),
    installChoicePreference: chosen,
    installChoiceCurrentVariant: state.currentVariant,
  })
  return applyInstallPreferenceFromStartup(chosen)
}

function usableTray(): Tray | null {
  if (!tray) return null
  try {
    const isDestroyed = (tray as unknown as { isDestroyed?: () => boolean }).isDestroyed
    if (typeof isDestroyed === 'function' && isDestroyed.call(tray)) {
      tray = null
      return null
    }
    return tray
  } catch {
    tray = null
    return null
  }
}

function updateTray(): void {
  const activeTray = usableTray()
  if (!activeTray) return
  const status = currentTrayStatus()
  const macIcon = macTrayTemplateIcon()
  try {
    if (macIcon) activeTray.setImage(macIcon)
    else if (process.platform === 'win32' && resolveWindowsTrayIcon(status.mode)) activeTray.setImage(resolveWindowsTrayIcon(status.mode)!)
    else if (process.platform === 'linux' && resolveLinuxTrayAsset(status.mode)) activeTray.setImage(resolveLinuxTrayAsset(status.mode)!)
    else activeTray.setImage(professionalFortressTrayIcon(status.mode))
    activeTray.setToolTip(
      status.mode === 'active'
        ? 'DataMoat: background capture active'
        : status.mode === 'idle'
          ? 'DataMoat: running, waiting for full capture'
          : 'DataMoat: daemon unavailable',
    )
  } catch (error) {
    if (destroyedObjectMessage(error)) {
      tray = null
      return
    }
    throw error
  }

  const win = usableWindow()
  let windowVisible = false
  try {
    windowVisible = !!win?.isVisible()
  } catch (error) {
    if (!destroyedObjectMessage(error)) throw error
    if (mainWindow === win) mainWindow = null
  }
  const menu = Menu.buildFromTemplate([
    { label: status.mode === 'active' ? 'Background capture active' : status.mode === 'idle' ? 'Running, waiting for capture' : 'Daemon unavailable', enabled: false },
    { label: `Vault: ${status.locked === null ? 'unknown' : status.locked ? 'locked' : 'unlocked'}`, enabled: false },
    { label: `Sessions: ${status.sessionCount ?? 'unavailable'}`, enabled: false },
    { type: 'separator' },
    { label: windowVisible ? 'Hide DataMoat' : 'Open DataMoat', click: () => toggleMainWindow() },
    { label: 'Quit DataMoat', click: () => { quitRequested = true; app.quit() } },
  ])
  try {
    activeTray.setContextMenu(menu)
    updateHealth('electron', {
      trayVisible: true,
      trayMode: status.mode,
      trayBounds: activeTray.getBounds(),
    })
  } catch (error) {
    if (destroyedObjectMessage(error)) {
      tray = null
      return
    }
    throw error
  }
}

function createTray(): void {
  if (usableTray()) return
  const macIcon = macTrayTemplateIcon()
  const initialIcon =
    macIcon
      ? macIcon
      : process.platform === 'win32' && resolveWindowsTrayIcon('idle')
        ? resolveWindowsTrayIcon('idle')!
      : process.platform === 'linux' && resolveLinuxTrayAsset('idle')
        ? resolveLinuxTrayAsset('idle')!
      : professionalFortressTrayIcon('idle')
  tray = new Tray(initialIcon)
  tray.on('click', () => toggleMainWindow())
  tray.on('double-click', () => void revealMainWindow())
  updateTray()
  trayRefreshTimer = setInterval(() => updateTray(), 5000)
  daemonWatchdogTimer = setInterval(() => ensureDaemonRecoveredInBackground('tray-watchdog'), 15000)
  let trayBounds: Electron.Rectangle | null = null
  try {
    trayBounds = usableTray()?.getBounds() ?? null
  } catch (error) {
    if (!destroyedObjectMessage(error)) {
      writeLog('warn', 'electron', 'tray_bounds_failed', { error })
    }
  }
  updateHealth('electron', {
    trayCreatedAt: new Date().toISOString(),
    running: true,
    stoppedAt: null,
    trayVisible: true,
    trayBounds,
  })
}

function installDesktopIpc(): void {
  ipcMain.handle('datamoat:update:getSettings', async () => getPackagedUpdateSettings())
  ipcMain.handle('datamoat:update:saveSettings', async (_event, payload: { autoUpdateEnabled?: boolean } | undefined) => {
    return savePackagedUpdateSettings(payload?.autoUpdateEnabled === true)
  })
  ipcMain.handle('datamoat:update:check', async () => {
    return checkForPackagedUpdates('manual')
  })
  ipcMain.handle('datamoat:update:apply', async () => {
    return applyPackagedUpdate()
  })
  ipcMain.handle('datamoat:update:openLatest', async () => {
    return await openPackagedReleasePage()
  })
  ipcMain.handle('datamoat:transfer:selectFolder', async () => {
    const owner = usableWindow()
    const options: OpenDialogOptions = {
      title: 'Choose DataMoat data folder',
      buttonLabel: 'Choose Folder',
      properties: ['openDirectory'],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })
  ipcMain.handle('datamoat:chatgptExport:selectSource', async () => {
    const owner = usableWindow()
    const options: OpenDialogOptions = {
      title: 'Choose chatgpt-export zip or folder',
      buttonLabel: 'Choose Export',
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: 'chatgpt-export ZIP', extensions: ['zip'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    return { canceled: false, path: result.filePaths[0] }
  })
}

if (rejectWindowsSystemLaunchIfNeeded()) {
  // Do not create a systemprofile vault or bind the local UI port.
} else if (!app.requestSingleInstanceLock()) {
  void takeOverStalePackagedInstanceAfterLockFailure()
} else {
  try { ensureDirs() } catch { /* non-fatal: whenReady will retry and crash logging stays defensive */ }
  app.enableSandbox()
  installDesktopIpc()

  app.on('second-instance', (_event, argv) => {
    if (relaunchIfRunningFromReplacedBundle('second-instance')) return
    applyUiLanguageOverrideFromArgv(argv, 'second-instance')
    if (argvRequestsRemoteNoScreen(argv)) {
      if (!usableWindow() && !mainWindowCreation) {
        trayOnlyLaunch = true
      }
      void (async () => {
        if (!await enableRemoteNoScreenCapture('second-instance')) return
        await ensureDaemonRunningForRemoteNoScreenWithRetry('second-instance')
        updateTray()
      })()
      return
    }

    trayOnlyLaunch = false
    if (resolveInstallChoiceOnStartup() === 'quit') {
      app.quit()
      return
    }
    void revealMainWindow()
  })

  app.whenReady().then(async () => {
    if (relaunchIfRunningFromReplacedBundle('startup')) return
    try { ensureDirs() } catch { /* non-fatal: crash handler is defensive */ }
    installCrashHandlers('electron')
    installSessionPolicy()
    if (remoteNoScreenLaunch && !await enableRemoteNoScreenCapture('startup-argv')) {
      app.exit(1)
      return
    }
    try {
      if (resolveInstallChoiceOnStartup() === 'quit') {
        app.quit()
        return
      }
    } catch (error) {
      writeLog('warn', 'electron', 'install_choice_startup_failed', { error })
      updateHealth('electron', {
        installChoiceStartupFailedAt: new Date().toISOString(),
      })
    }
    try {
      await initializePackagedUpdater()
    } catch (error) {
      writeLog('warn', 'electron', 'packaged_update_init_failed', { error })
    }
    try {
      if (detectInstallContext().mode === 'packaged') {
        ensurePackagedAutostart(remoteNoScreenLaunch)
      }
    } catch (error) {
      writeLog('warn', 'electron', 'packaged_launch_agent_init_failed', { error })
    }
    if (trayOnlyLaunch) enforceTrayOnlyPresentation()
    createTray()
    if (process.platform === 'darwin') {
      app.setName('DataMoat')
      if (!trayOnlyLaunch) app.dock?.setIcon(runtimeIcon)
    }
    if (trayOnlyLaunch) {
      if (remoteNoScreenLaunch) {
        await ensureDaemonRunningForRemoteNoScreenWithRetry('startup-argv')
      } else {
        const runtime = await ensureDaemonRunning()
        updateHealth('electron', {
          running: true,
          port: runtime.port,
          startedAt: new Date().toISOString(),
          trayOnly: true,
        })
      }
      enforceTrayOnlyPresentation()
      setTimeout(() => enforceTrayOnlyPresentation(), 250)
      setTimeout(() => enforceTrayOnlyPresentation(), 1000)
      updateTray()
    } else {
      setMacActivation('regular')
      await revealMainWindow()
    }

    app.on('activate', async () => {
      if (relaunchIfRunningFromReplacedBundle('activate')) return
      trayOnlyLaunch = false
      if (resolveInstallChoiceOnStartup() === 'quit') {
        app.quit()
        return
      }
      await revealMainWindow()
    })
  }).catch(error => {
    writeLog('error', 'electron', 'startup_failed', { error })
    app.exit(1)
  })

  app.on('before-quit', () => {
    quitRequested = true
    setMacActivation('regular')
  })

  nativeAutoUpdater.on('before-quit-for-update', () => {
    quitRequested = true
    setMacActivation('regular')
  })

  app.on('window-all-closed', () => {
    if (!tray && process.platform !== 'darwin') app.quit()
  })

  app.on('quit', () => {
    if (trayRefreshTimer) clearInterval(trayRefreshTimer)
    if (daemonWatchdogTimer) clearInterval(daemonWatchdogTimer)
    updateHealth('electron', { running: false, trayVisible: false, stoppedAt: new Date().toISOString() })
  })
}
