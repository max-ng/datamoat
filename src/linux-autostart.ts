import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as child_process from 'child_process'
import { updateHealth, writeLog } from './logging'
import { launcherBinaryForScripts, launcherEnvForScripts } from './runtime'

const REMOTE_AUTOSTART_FILE = 'datamoat-remote-no-screen.desktop'
const DAEMON_SERVICE_FILE = 'datamoat-daemon.service'

function autostartDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config')
  return path.join(configHome, 'autostart')
}

function systemdUserDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim()
    || path.join(os.homedir(), '.config')
  return path.join(configHome, 'systemd', 'user')
}

function daemonServicePath(): string {
  return path.join(systemdUserDir(), DAEMON_SERVICE_FILE)
}

function desktopExecQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function remoteNoScreenCliLauncher(): string | null {
  const cliPath = path.join(os.homedir(), '.local', 'bin', 'datamoat')
  if (fs.existsSync(cliPath)) return cliPath

  if (process.versions.electron && fs.existsSync(process.execPath)) return process.execPath

  return null
}

function daemonScriptPath(): string {
  return path.join(__dirname, 'daemon.js')
}

function writeDaemonSystemdService(servicePath: string): void {
  const launcher = launcherBinaryForScripts()
  const launcherEnv = launcherEnvForScripts()
  const daemonScript = daemonScriptPath()
  const appRoot = path.resolve(path.join(__dirname, '..'))
  const content = [
    '[Unit]',
    'Description=DataMoat daemon',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=${systemdQuote(`HOME=${os.homedir()}`)}`,
    'Environment=DATAMOAT_DAEMON=1',
    ...(launcherEnv.ELECTRON_RUN_AS_NODE ? ['Environment=ELECTRON_RUN_AS_NODE=1'] : []),
    `ExecStart=${systemdQuote(launcher)} ${systemdQuote(daemonScript)}`,
    `WorkingDirectory=${systemdQuote(appRoot)}`,
    'Restart=on-failure',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')

  fs.mkdirSync(path.dirname(servicePath), { recursive: true })
  fs.writeFileSync(servicePath, content, { encoding: 'utf8', mode: 0o644 })
}

function runSystemctlUser(args: string[]): void {
  child_process.execFileSync('systemctl', ['--user', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function ensureLinuxSystemdDaemon(): boolean {
  const servicePath = daemonServicePath()
  writeDaemonSystemdService(servicePath)
  runSystemctlUser(['daemon-reload'])
  runSystemctlUser(['enable', '--now', DAEMON_SERVICE_FILE])
  return true
}

export function ensureLinuxRemoteNoScreenAutostart(): boolean {
  if (process.platform !== 'linux') return false

  try {
    ensureLinuxSystemdDaemon()
    const desktopPath = path.join(autostartDir(), REMOTE_AUTOSTART_FILE)
    try { fs.rmSync(desktopPath, { force: true }) } catch { /* ignore */ }
    updateHealth('autostart', {
      enabled: true,
      backend: 'linux-systemd-user',
      launcherMode: 'daemon',
      remoteNoScreen: true,
      restartOnFailure: true,
      service: DAEMON_SERVICE_FILE,
      startupScript: daemonServicePath(),
      launcher: launcherBinaryForScripts(),
      updatedAt: new Date().toISOString(),
    })
    writeLog('info', 'autostart', 'linux_remote_no_screen_autostart_ready', {
      backend: 'linux-systemd-user',
      service: DAEMON_SERVICE_FILE,
      startupScript: daemonServicePath(),
      restartOnFailure: true,
      launcher: launcherBinaryForScripts(),
    })
    return true
  } catch (error) {
    writeLog('warn', 'autostart', 'linux_systemd_autostart_failed', { error })
  }

  const launcher = remoteNoScreenCliLauncher()
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
      restartOnFailure: false,
      startupScript: desktopPath,
      launcher,
      updatedAt: new Date().toISOString(),
    })
    writeLog('info', 'autostart', 'linux_remote_no_screen_autostart_ready', {
      backend: 'linux-desktop-autostart',
      startupScript: desktopPath,
      launcher,
      restartOnFailure: false,
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
