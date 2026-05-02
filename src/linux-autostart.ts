import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { updateHealth, writeLog } from './logging'

const REMOTE_AUTOSTART_FILE = 'datamoat-remote-no-screen.desktop'

function autostartDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config')
  return path.join(configHome, 'autostart')
}

function desktopExecQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function remoteNoScreenLauncher(): string | null {
  if (process.versions.electron && fs.existsSync(process.execPath)) {
    return process.execPath
  }

  const cliPath = path.join(os.homedir(), '.local', 'bin', 'datamoat')
  if (fs.existsSync(cliPath)) return cliPath

  return null
}

export function ensureLinuxRemoteNoScreenAutostart(): boolean {
  if (process.platform !== 'linux') return false

  const launcher = remoteNoScreenLauncher()
  if (!launcher) return false

  const desktopPath = path.join(autostartDir(), REMOTE_AUTOSTART_FILE)
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DataMoat Remote No-Screen Capture',
    'Comment=Start DataMoat pre-setup capture',
    `Exec=${desktopExecQuote(launcher)} --datamoat-remote-no-screen`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Categories=Utility;Security;',
    '',
  ].join('\n')

  try {
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true })
    fs.writeFileSync(desktopPath, content, { encoding: 'utf8', mode: 0o644 })
    updateHealth('autostart', {
      enabled: true,
      backend: 'linux-desktop-autostart',
      launcherMode: 'remote-no-screen',
      remoteNoScreen: true,
      startupScript: desktopPath,
      launcher,
      updatedAt: new Date().toISOString(),
    })
    writeLog('info', 'autostart', 'linux_remote_no_screen_autostart_ready', {
      backend: 'linux-desktop-autostart',
      startupScript: desktopPath,
      launcher,
    })
    return true
  } catch (error) {
    updateHealth('autostart', {
      enabled: false,
      backend: 'linux-desktop-autostart',
      lastErrorAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    })
    writeLog('warn', 'autostart', 'linux_remote_no_screen_autostart_failed', { error })
    return false
  }
}
