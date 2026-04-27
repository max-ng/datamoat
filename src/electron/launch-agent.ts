import * as child_process from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { updateHealth, writeLog } from '../logging'

export const PACKAGED_TRAY_LAUNCH_AGENT_LABEL = 'com.datamoat.app.tray'

const HOME = os.homedir()
const LAUNCH_AGENTS_DIR = path.join(HOME, 'Library', 'LaunchAgents')
const PACKAGED_TRAY_LAUNCH_AGENT_PATH = path.join(
  LAUNCH_AGENTS_DIR,
  `${PACKAGED_TRAY_LAUNCH_AGENT_LABEL}.plist`,
)

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

function userDomain(): string {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`
}

function serviceTarget(): string {
  return `${userDomain()}/${PACKAGED_TRAY_LAUNCH_AGENT_LABEL}`
}

function launchAgentLoaded(): boolean {
  try {
    launchctl(['print', serviceTarget()])
    return true
  } catch {
    return false
  }
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

function launchAgentPlist(executable: string): string {
  const escapedExecutable = xmlEscape(executable)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PACKAGED_TRAY_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapedExecutable}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATAMOAT_TRAY_ONLY</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
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

export function ensurePackagedTrayLaunchAgent(executable = process.execPath): void {
  if (process.platform !== 'darwin') return
  const appPath = currentAppPathFromExecutable(executable)
  if (!appPath || !fs.existsSync(executable)) return

  const plist = launchAgentPlist(executable)
  const previous = fs.existsSync(PACKAGED_TRAY_LAUNCH_AGENT_PATH)
    ? fs.readFileSync(PACKAGED_TRAY_LAUNCH_AGENT_PATH, 'utf8')
    : null
  const changed = previous !== plist

  try {
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true })
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
    updateHealth('electron', {
      launchAtLogin: true,
      launchAgentLabel: PACKAGED_TRAY_LAUNCH_AGENT_LABEL,
      launchAgentPath: PACKAGED_TRAY_LAUNCH_AGENT_PATH,
      launchAgentAppPath: appPath,
      launchAgentUpdatedAt: changed ? new Date().toISOString() : undefined,
    })
    writeLog('info', 'electron', 'packaged_tray_launch_agent_ready', {
      label: PACKAGED_TRAY_LAUNCH_AGENT_LABEL,
      path: PACKAGED_TRAY_LAUNCH_AGENT_PATH,
      executable,
      changed,
    })
  } catch (error) {
    updateHealth('electron', {
      launchAtLogin: false,
      launchAgentLabel: PACKAGED_TRAY_LAUNCH_AGENT_LABEL,
      launchAgentPath: PACKAGED_TRAY_LAUNCH_AGENT_PATH,
      launchAgentErrorAt: new Date().toISOString(),
    })
    writeLog('warn', 'electron', 'packaged_tray_launch_agent_failed', { error })
  }
}
