import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { STATE_DIR } from '../config'
import { updateHealth, writeLog } from '../logging'

export const PACKAGED_TRAY_LAUNCH_AGENT_LABEL = 'com.datamoat.app.tray'

type PackagedLaunchAgentOptions = {
  remoteNoScreen?: boolean
}

const HOME = os.homedir()
const LAUNCH_AGENT_ENV_KEY = 'DATAMOAT_MAC_LAUNCH_AGENT'
const SMOKE_ONLY_LAUNCH_AGENT_LABEL = process.env.DATAMOAT_ELECTRON_SMOKE === '1'
  ? process.env.DATAMOAT_MAC_LAUNCH_AGENT_LABEL?.trim()
  : ''
const LAUNCH_AGENTS_DIR = process.env.DATAMOAT_ELECTRON_SMOKE === '1'
  && process.env.DATAMOAT_MAC_LAUNCH_AGENTS_DIR?.trim()
  ? path.resolve(process.env.DATAMOAT_MAC_LAUNCH_AGENTS_DIR.trim())
  : path.join(HOME, 'Library', 'LaunchAgents')
const PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE = SMOKE_ONLY_LAUNCH_AGENT_LABEL || PACKAGED_TRAY_LAUNCH_AGENT_LABEL
const PACKAGED_TRAY_LAUNCH_AGENT_PATH = path.join(
  LAUNCH_AGENTS_DIR,
  `${PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE}.plist`,
)
const PACKAGED_TRAY_STDOUT_LOG = path.join(STATE_DIR, 'tray-launch-agent.out.log')
const PACKAGED_TRAY_STDERR_LOG = path.join(STATE_DIR, 'tray-launch-agent.err.log')
const PASSTHROUGH_ENV_KEYS = [
  'DATAMOAT_HOME',
  'DATAMOAT_CLAUDE_CLI_ROOTS',
  'DATAMOAT_CODEX_CLI_ROOTS',
  'DATAMOAT_CLAUDE_APP_ROOTS',
  'DATAMOAT_CURSOR_ROOTS',
  'DATAMOAT_OPENCLAW_ROOTS',
  'DATAMOAT_DAEMON_START_TIMEOUT_MS',
  'DATAMOAT_DEBUG_LOGS',
]

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function launchctl(args: string[]): void {
  child_process.execFileSync('launchctl', args, { stdio: 'ignore' })
}

function launchctlOutput(args: string[]): string {
  return child_process.execFileSync('launchctl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function userDomain(): string {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`
}

function serviceTarget(): string {
  return `${userDomain()}/${PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE}`
}

function launchAgentLoaded(): boolean {
  try {
    launchctl(['print', serviceTarget()])
    return true
  } catch {
    return false
  }
}

function launchAgentRunning(): boolean {
  try {
    const output = launchctlOutput(['print', serviceTarget()])
    return /\n\s*state = running\b/.test(output) || /\n\s*pid = \d+\b/.test(output)
  } catch {
    return false
  }
}

function kickstartLaunchAgent(): void {
  launchctl(['kickstart', '-k', serviceTarget()])
}

function loadLaunchAgent(): void {
  try {
    launchctl(['bootstrap', userDomain(), PACKAGED_TRAY_LAUNCH_AGENT_PATH])
  } catch {
    // Older macOS still supports load.
    launchctl(['load', PACKAGED_TRAY_LAUNCH_AGENT_PATH])
  }
}

function currentAppPathFromExecutable(executable: string): string | null {
  const marker = '.app/Contents/MacOS/'
  const index = executable.indexOf(marker)
  if (index === -1) return null
  return executable.slice(0, index + 4)
}

function sourceRootFromReleaseAppPath(appPath: string | null): string | null {
  if (!appPath) return null
  const resolved = path.resolve(appPath)
  const releaseDir = path.dirname(path.dirname(resolved))
  if (path.basename(releaseDir) !== 'release') return null
  const sourceRoot = path.dirname(releaseDir)
  if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) return null
  if (!fs.existsSync(path.join(sourceRoot, 'src'))) return null
  return sourceRoot
}

function launchAgentPlist(executable: string, options: PackagedLaunchAgentOptions = {}): string {
  const escapedExecutable = xmlEscape(executable)
  const escapedStdoutLog = xmlEscape(PACKAGED_TRAY_STDOUT_LOG)
  const escapedStderrLog = xmlEscape(PACKAGED_TRAY_STDERR_LOG)
  const args = [
    `    <string>${escapedExecutable}</string>`,
    ...(options.remoteNoScreen ? ['    <string>--datamoat-remote-no-screen</string>'] : []),
  ].join('\n')
  const environment = launchAgentEnvironmentPlist(options)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
${environment}  <key>StandardOutPath</key><string>${escapedStdoutLog}</string>
  <key>StandardErrorPath</key><string>${escapedStderrLog}</string>
</dict>
</plist>
`
}

function launchAgentEnvironmentPlist(options: PackagedLaunchAgentOptions = {}): string {
  const entries = new Map<string, string>()
  entries.set(LAUNCH_AGENT_ENV_KEY, options.remoteNoScreen ? 'remote-no-screen' : 'tray')
  if (!options.remoteNoScreen) entries.set('DATAMOAT_TRAY_ONLY', '1')
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) entries.set(key, value)
  }
  const body = [...entries]
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('\n')
  return `  <key>EnvironmentVariables</key>
  <dict>
${body}
  </dict>
`
}

export function removePackagedTrayLaunchAgent(): boolean {
  if (process.platform !== 'darwin') return false
  let changed = false
  try {
    launchctl(['bootout', serviceTarget()])
    changed = true
  } catch {
    // Not loaded.
  }
  try {
    if (fs.existsSync(PACKAGED_TRAY_LAUNCH_AGENT_PATH)) {
      fs.rmSync(PACKAGED_TRAY_LAUNCH_AGENT_PATH, { force: true })
      changed = true
    }
  } catch (error) {
    writeLog('warn', 'electron', 'packaged_tray_launch_agent_remove_failed', { error })
  }
  return changed
}

export function ensurePackagedTrayLaunchAgent(options: PackagedLaunchAgentOptions = {}, executable = process.execPath): void {
  if (process.platform !== 'darwin') return
  const appPath = currentAppPathFromExecutable(executable)
  if (!appPath || !fs.existsSync(executable)) return
  const sourceRoot = sourceRootFromReleaseAppPath(appPath)
  if (sourceRoot) {
    const removed = removePackagedTrayLaunchAgent()
    updateHealth('electron', {
      launchAtLogin: false,
      launchAgentLabel: PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE,
      launchAgentAppPath: appPath,
      launchAgentSkippedAt: new Date().toISOString(),
      launchAgentSkippedReason: 'source_release_app_not_packaged',
      launchAgentRemoved: removed,
    })
    writeLog('warn', 'electron', 'packaged_tray_launch_agent_skipped_source_release_app', {
      executable,
      appPath,
      sourceRoot,
      removed,
    })
    return
  }

  const plist = launchAgentPlist(executable, options)
  const previous = fs.existsSync(PACKAGED_TRAY_LAUNCH_AGENT_PATH)
    ? fs.readFileSync(PACKAGED_TRAY_LAUNCH_AGENT_PATH, 'utf8')
    : null
  const changed = previous !== plist
  const launcherMode = options.remoteNoScreen ? 'remote-no-screen' : 'tray'
  let kickstarted = false

  try {
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true })
    fs.mkdirSync(STATE_DIR, { recursive: true })
    if (changed) {
      fs.writeFileSync(PACKAGED_TRAY_LAUNCH_AGENT_PATH, plist, { mode: 0o644 })
      try {
        launchctl(['bootout', serviceTarget()])
      } catch {
        // Not loaded yet.
      }
      loadLaunchAgent()
    } else if (!launchAgentLoaded()) {
      loadLaunchAgent()
    }
    if (!launchAgentRunning()) {
      kickstartLaunchAgent()
      kickstarted = true
    }
    const running = launchAgentRunning()
    updateHealth('electron', {
      launchAtLogin: true,
      launchAgentLabel: PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE,
      launchAgentPath: PACKAGED_TRAY_LAUNCH_AGENT_PATH,
      launchAgentAppPath: appPath,
      launchAgentMode: launcherMode,
      launchAgentRunning: running,
      launchAgentKickstartedAt: kickstarted ? new Date().toISOString() : undefined,
      remoteNoScreen: options.remoteNoScreen === true,
      launchAgentUpdatedAt: changed ? new Date().toISOString() : undefined,
    })
    writeLog('info', 'electron', 'packaged_tray_launch_agent_ready', {
      label: PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE,
      path: PACKAGED_TRAY_LAUNCH_AGENT_PATH,
      executable,
      launcherMode,
      remoteNoScreen: options.remoteNoScreen === true,
      changed,
      kickstarted,
      running,
    })
  } catch (error) {
    updateHealth('electron', {
      launchAtLogin: false,
      launchAgentLabel: PACKAGED_TRAY_LAUNCH_AGENT_LABEL_ACTIVE,
      launchAgentPath: PACKAGED_TRAY_LAUNCH_AGENT_PATH,
      launchAgentErrorAt: new Date().toISOString(),
    })
    writeLog('warn', 'electron', 'packaged_tray_launch_agent_failed', { error })
  }
}

export function ensureMacRemoteNoScreenLaunchAgent(executable = process.execPath): void {
  ensurePackagedTrayLaunchAgent({ remoteNoScreen: true }, executable)
}
