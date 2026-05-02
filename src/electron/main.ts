import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Menu, Tray, dialog, nativeImage, screen, session, shell, ipcMain } from 'electron'
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { ensureDaemonRunning, findDaemonPids, stopDaemonPids } from '../runtime'
import { HEALTH_FILE, PUBLIC_STATUS_FILE } from '../config'
import { isSetupDone } from '../auth'
import { disableBootstrapCapture, enableBootstrapCapture, preflightBootstrapCapture } from '../bootstrap-capture'
import { detectInstallContext } from '../install-context'
import { installCrashHandlers, updateHealth, writeLog } from '../logging'
import { applyInstallPreference, clearInstallChoice, detectDualInstallState, saveInstallChoice, type DualInstallState, type InstallPreference } from '../packaged-handoff'
import { ensureLinuxRemoteNoScreenAutostart } from '../linux-autostart'
import { ensureWindowsRemoteNoScreenAutostart } from '../windows-autostart'
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

let mainWindow: BrowserWindow | null = null
let mainWindowCreation: Promise<void> | null = null
let revealAfterWindowCreation = false
let tray: Tray | null = null
let allowedOrigin: string | null = null
let quitRequested = false
let trayRefreshTimer: NodeJS.Timeout | null = null
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

const remoteNoScreenLaunch = argvRequestsRemoteNoScreen()
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
    if (pathname === '/setup' || pathname === '/unlock') {
      return { width: 760, height: 900, minWidth: 720, minHeight: 680, resizable: true }
    }
  } catch {
    // ignore
  }
  return { width: 1180, height: 860, minWidth: 980, minHeight: 760, resizable: true }
}

function applyWindowPreset(win: BrowserWindow, targetUrl: string): void {
  const preset = windowPresetForUrl(targetUrl)
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(preset.width, Math.max(720, workArea.width - 32))
  const height = Math.min(preset.height, Math.max(720, workArea.height - 32))
  win.setResizable(preset.resizable)
  win.setMinimumSize(Math.min(preset.minWidth, width), Math.min(preset.minHeight, height))
  win.setSize(width, height)
  win.center()
}

function ensureWindowUsable(win: BrowserWindow): void {
  const targetUrl = win.webContents.getURL() || allowedOrigin || 'http://localhost'
  const preset = windowPresetForUrl(targetUrl)
  const [width, height] = win.getSize()
  if (width < preset.minWidth || height < preset.minHeight) {
    applyWindowPreset(win, targetUrl)
  }
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
  if (await preflightBootstrapCapture()) {
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
    bootstrapCaptureError: 'bootstrap capture secret unavailable in OS keychain',
    bootstrapCaptureEnabledBy: reason,
  })
  writeLog('error', 'electron', 'remote_no_screen_capture_unavailable', { reason })
  console.error('DataMoat remote no-screen capture could not start securely.')
  console.error('A working local OS keychain is required before pre-setup capture can begin.')
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
  const daemonRunning = daemon.running === true
  const captureRunning = capture.running === true || daemon.captureRunning === true
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
  if (mainWindow.isDestroyed()) {
    mainWindow = null
    return null
  }
  return mainWindow
}

async function revealMainWindow(): Promise<void> {
  const win = usableWindow()
  if (!win) {
    trayOnlyLaunch = false
    setMacActivation('regular')
    await createMainWindow(true)
    return
  }

  setMacActivation('regular')
  setDockVisibility(true)
  ensureWindowUsable(win)
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
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(false)
      if (process.platform === 'linux') {
        win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true })
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
  if (showOnReady) revealAfterWindowCreation = true

  const existing = usableWindow()
  if (existing) {
    if (showOnReady) {
      setMacActivation('regular')
      setDockVisibility(true)
      ensureWindowUsable(existing)
      if (existing.isMinimized()) existing.restore()
      if (!existing.isVisible()) existing.show()
      existing.focus()
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
  const runtime = await ensureDaemonRunning()
  allowedOrigin = `http://localhost:${runtime.port}`
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
    if (showOnReady || revealAfterWindowCreation) {
      setDockVisibility(true)
      win.show()
      if (process.platform === 'linux') {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      }
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
      win.focus()
      app.focus({ steal: true })
      nudgeLinuxWindowToFront()
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.setAlwaysOnTop(false)
          if (process.platform === 'linux') {
            win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true })
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
    win.hide()
    setDockVisibility(false)
    updateTray()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  await win.loadURL(runtime.url)
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
    const phrase = mode === 'password-only' ? '' : requiredSmokeEnv('DATAMOAT_UI_RECOVERY_PHRASE')
    const recoveryCodes = String(process.env.DATAMOAT_UI_RECOVERY_CODES || '')
      .split(/[,\s]+/)
      .map(code => code.trim())
      .filter(Boolean)
    if (mode !== 'password-only' && recoveryCodes.length === 0) throw new Error('DATAMOAT_UI_RECOVERY_CODES must contain at least one code')

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
      await recoverAndResetSmokeWindow(win, baseUrl, 'recovery-code', recoveryCodes[0], password)
      await relockSmokeWindow(win, baseUrl)
      await recoverAndResetSmokeWindow(win, baseUrl, 'recovery-phrase', phrase, password)
      await relockSmokeWindow(win, baseUrl)
      await passwordUnlockSmokeWindow(win, baseUrl, password, arch)
      flow = { usedRecoveryCode: recoveryCodes[0], settings: await settingsSmokeWindow(win) }
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
  if (win.isVisible()) {
    win.hide()
    setDockVisibility(false)
    setMacActivation('accessory')
    updateTray()
    return
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
  const clicked = dialog.showMessageBoxSync({
    type: 'question',
    buttons: [packagedLabel, sourceLabel],
    defaultId,
    cancelId: defaultId,
    noLink: true,
    title: 'DataMoat: multiple installs detected',
    message: 'Two DataMoat installs found on this computer',
    detail: 'Pick which one to run. This choice is remembered; you will only be asked again if a different install appears or moves.',
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

  const storedChoiceIsCurrent =
    !!state.storedChoice
    && state.storedChoice.sourceRoot === state.sourceRoot
    && (state.storedChoice.sourceAppPath ?? null) === state.sourceAppPath
    && (state.storedChoice.packagedAppPath ?? null) === state.packagedAppPath

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
  })
  updateHealth('electron', {
    installChoicePromptedAt: new Date().toISOString(),
    installChoicePreference: chosen,
    installChoiceCurrentVariant: state.currentVariant,
  })
  return applyInstallPreferenceFromStartup(chosen)
}

function updateTray(): void {
  if (!tray) return
  const status = currentTrayStatus()
  const macIcon = macTrayTemplateIcon()
  if (macIcon) tray.setImage(macIcon)
  else if (process.platform === 'win32' && resolveWindowsTrayIcon(status.mode)) tray.setImage(resolveWindowsTrayIcon(status.mode)!)
  else if (process.platform === 'linux' && resolveLinuxTrayAsset(status.mode)) tray.setImage(resolveLinuxTrayAsset(status.mode)!)
  else tray.setImage(professionalFortressTrayIcon(status.mode))
  tray.setToolTip(
    status.mode === 'active'
      ? 'DataMoat: background capture active'
      : status.mode === 'idle'
        ? 'DataMoat: running, waiting for full capture'
        : 'DataMoat: daemon unavailable',
  )

  const win = usableWindow()
  const menu = Menu.buildFromTemplate([
    { label: status.mode === 'active' ? 'Background capture active' : status.mode === 'idle' ? 'Running, waiting for capture' : 'Daemon unavailable', enabled: false },
    { label: `Vault: ${status.locked === null ? 'unknown' : status.locked ? 'locked' : 'unlocked'}`, enabled: false },
    { label: `Sessions: ${status.sessionCount ?? 'unavailable'}`, enabled: false },
    { type: 'separator' },
    { label: win?.isVisible() ? 'Hide DataMoat' : 'Open DataMoat', click: () => toggleMainWindow() },
    { label: 'Quit DataMoat', click: () => { quitRequested = true; app.quit() } },
  ])
  tray.setContextMenu(menu)
  updateHealth('electron', {
    trayVisible: true,
    trayMode: status.mode,
    trayBounds: tray.getBounds(),
  })
}

function createTray(): void {
  if (tray) return
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
  updateHealth('electron', {
    trayCreatedAt: new Date().toISOString(),
    trayVisible: true,
    trayBounds: tray.getBounds(),
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
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  try { ensureDirs() } catch { /* non-fatal: whenReady will retry and crash logging stays defensive */ }
  app.enableSandbox()
  installDesktopIpc()

  app.on('second-instance', (_event, argv) => {
    if (argvRequestsRemoteNoScreen(argv)) {
      trayOnlyLaunch = true
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
    try { ensureDirs() } catch { /* non-fatal: crash handler is defensive */ }
    installCrashHandlers('electron')
    installSessionPolicy()
    if (remoteNoScreenLaunch && !await enableRemoteNoScreenCapture('startup-argv')) {
      app.exit(1)
      return
    }
    try {
      await initializePackagedUpdater()
    } catch (error) {
      writeLog('warn', 'electron', 'packaged_update_init_failed', { error })
    }
    try {
      if (detectInstallContext().mode === 'packaged') {
        ensurePackagedTrayLaunchAgent({ remoteNoScreen: remoteNoScreenLaunch })
      }
    } catch (error) {
      writeLog('warn', 'electron', 'packaged_launch_agent_init_failed', { error })
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
    updateHealth('electron', { running: false, stoppedAt: new Date().toISOString() })
  })
}
