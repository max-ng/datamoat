import { app, Notification, shell } from 'electron'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { detectInstallContext } from '../install-context'
import { writeLog } from '../logging'
import { loadAppConfig, loadUpdateState, saveAppConfig, writeUpdateState, type UpdateState } from '../update-config'
import { packagedUpdateFeedOptions, updateReleasesUrl } from '../update-channel'

type PackagedUpdateSettingsResponse = {
  autoUpdateEnabled: boolean
  autoUpdateIntervalHours: number
  appVersion: string
  state: UpdateState
  releasesUrl: string
}

let initialized = false
let packagedUpdateTimer: NodeJS.Timeout | null = null
let packagedUpdateInterval: NodeJS.Timeout | null = null
let packagedUpdateDownloadVersion: string | null = null
let downloadedNotificationVersion: string | null = null
let updatedNotificationVersion: string | null = null

function packagedUpdateLogger() {
  return {
    info(message: string) {
      writeLog('info', 'packaged-update', 'electron_updater_info', { message })
    },
    warn(message: string) {
      writeLog('warn', 'packaged-update', 'electron_updater_warn', { message })
    },
    error(message: string) {
      writeLog('error', 'packaged-update', 'electron_updater_error', { message })
    },
    debug(message: string) {
      writeLog('info', 'packaged-update', 'electron_updater_debug', { message })
    },
  }
}

function isPackagedUpdateInstall(): boolean {
  return detectInstallContext().updateStrategy === 'packaged-auto-update'
}

function packagedUpdateUnsupportedState(reason: string): UpdateState {
  return writeUpdateState({
    running: false,
    supported: false,
    currentVersion: app.getVersion(),
    availableVersion: null,
    downloadedVersion: null,
    downloadProgressPercent: null,
    lastResult: 'unsupported',
    message: reason,
  })
}

function packagedUpdateSupport(): { supported: boolean; reason: string | null } {
  if (!isPackagedUpdateInstall()) {
    return { supported: false, reason: 'automatic packaged updates are not enabled for this install' }
  }
  if (process.platform !== 'darwin') {
    return { supported: false, reason: 'automatic packaged updates are only implemented on macOS' }
  }
  const exePath = app.getPath('exe')
  if (exePath.includes('/Volumes/')) {
    return { supported: false, reason: 'move DataMoat into Applications before using automatic updates' }
  }
  return { supported: true, reason: null }
}

function packagedUpdateStatePatch(patch: Partial<UpdateState>): UpdateState {
  return writeUpdateState({
    currentVersion: app.getVersion(),
    ...patch,
  })
}

function showPackagedUpdateNotification(version: string, kind: 'downloaded' | 'updated'): void {
  if (!Notification.isSupported()) return

  const title = kind === 'downloaded' ? 'Update Ready' : 'Update Complete'
  const body = kind === 'downloaded'
    ? `DataMoat ${version} has been downloaded. Open the app to install it.`
    : `DataMoat has been updated to version ${version}.`

  const notification = new Notification({
    title,
    body,
    silent: false,
  })

  notification.on('click', () => {
    app.focus({ steal: true })
    app.emit('activate')
  })

  notification.show()
}

function reconcileInstalledPackagedUpdate(): void {
  const currentVersion = app.getVersion()
  const previous = loadUpdateState()
  if (
    previous.downloadedVersion
    && previous.downloadedVersion === currentVersion
    && ['downloaded', 'installing', 'updating'].includes(previous.lastResult)
  ) {
    packagedUpdateDownloadVersion = null
    packagedUpdateStatePatch({
      running: false,
      supported: true,
      lastAppliedAt: new Date().toISOString(),
      lastResult: 'updated',
      availableVersion: null,
      downloadedVersion: null,
      downloadProgressPercent: null,
      message: `updated to version ${currentVersion}`,
    })
    if (updatedNotificationVersion !== currentVersion) {
      updatedNotificationVersion = currentVersion
      showPackagedUpdateNotification(currentVersion, 'updated')
    }
    return
  }

  if (previous.currentVersion !== currentVersion) {
    packagedUpdateStatePatch({
      running: false,
      supported: true,
      currentVersion,
    })
  }
}

function restartPackagedUpdateLoop(): void {
  if (packagedUpdateTimer) clearTimeout(packagedUpdateTimer)
  if (packagedUpdateInterval) clearInterval(packagedUpdateInterval)

  const support = packagedUpdateSupport()
  const config = loadAppConfig()
  if (!support.supported || !config.autoUpdateEnabled) return

  const scheduleRun = () => {
    const latestConfig = loadAppConfig()
    const latestSupport = packagedUpdateSupport()
    if (!latestSupport.supported || !latestConfig.autoUpdateEnabled) return
    void checkForPackagedUpdates('auto').catch(error => {
      writeLog('warn', 'packaged-update', 'auto_check_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  packagedUpdateTimer = setTimeout(scheduleRun, 15000)
  packagedUpdateInterval = setInterval(scheduleRun, config.autoUpdateIntervalHours * 60 * 60 * 1000)
}

function onCheckingForUpdate(): void {
  packagedUpdateStatePatch({
    running: true,
    supported: true,
    lastCheckedAt: new Date().toISOString(),
    lastResult: 'checking',
    message: 'checking for packaged updates',
    availableVersion: null,
    downloadProgressPercent: null,
  })
}

function onUpdateAvailable(info: UpdateInfo): void {
  packagedUpdateDownloadVersion = info.version
  packagedUpdateStatePatch({
    running: true,
    supported: true,
    lastResult: 'downloading',
    availableVersion: info.version,
    downloadedVersion: null,
    downloadProgressPercent: 0,
    message: `downloading version ${info.version}`,
  })
}

function onUpdateNotAvailable(info: UpdateInfo): void {
  packagedUpdateDownloadVersion = null
  packagedUpdateStatePatch({
    running: false,
    supported: true,
    lastCheckedAt: new Date().toISOString(),
    lastResult: 'up-to-date',
    availableVersion: info.version || app.getVersion(),
    downloadedVersion: null,
    downloadProgressPercent: null,
    message: 'already up to date',
  })
}

function onDownloadProgress(progress: ProgressInfo): void {
  packagedUpdateStatePatch({
    running: true,
    supported: true,
    lastResult: 'downloading',
    availableVersion: packagedUpdateDownloadVersion,
    downloadedVersion: null,
    downloadProgressPercent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    message: `downloading version ${packagedUpdateDownloadVersion || 'update'} (${Math.round(Number(progress.percent) || 0)}%)`,
  })
}

function onUpdateDownloaded(event: UpdateDownloadedEvent): void {
  packagedUpdateDownloadVersion = event.version
  packagedUpdateStatePatch({
    running: false,
    supported: true,
    lastResult: 'downloaded',
    availableVersion: event.version,
    downloadedVersion: event.version,
    downloadProgressPercent: 100,
    message: `version ${event.version} is ready to install`,
  })
  if (downloadedNotificationVersion !== event.version) {
    downloadedNotificationVersion = event.version
    showPackagedUpdateNotification(event.version, 'downloaded')
  }
}

function onUpdaterError(error: Error, message?: string): void {
  writeLog('error', 'packaged-update', 'packaged_update_failed', {
    error: error.message,
    detail: message || null,
  })
  packagedUpdateStatePatch({
    running: false,
    supported: true,
    lastResult: 'error',
    message: message || error.message,
  })
}

function configureAutoUpdater(): void {
  autoUpdater.logger = packagedUpdateLogger()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL(packagedUpdateFeedOptions())
}

function installAutoUpdaterEventHandlers(): void {
  autoUpdater.on('checking-for-update', onCheckingForUpdate)
  autoUpdater.on('update-available', onUpdateAvailable)
  autoUpdater.on('update-not-available', onUpdateNotAvailable)
  autoUpdater.on('download-progress', onDownloadProgress)
  autoUpdater.on('update-downloaded', onUpdateDownloaded)
  autoUpdater.on('error', onUpdaterError)
}

export async function initializePackagedUpdater(): Promise<void> {
  if (initialized) {
    restartPackagedUpdateLoop()
    return
  }
  initialized = true

  const support = packagedUpdateSupport()
  if (!support.supported) {
    packagedUpdateUnsupportedState(support.reason || 'automatic packaged updates are unavailable')
    return
  }

  configureAutoUpdater()
  installAutoUpdaterEventHandlers()
  reconcileInstalledPackagedUpdate()
  packagedUpdateStatePatch({
    running: false,
    supported: true,
    currentVersion: app.getVersion(),
  })
  restartPackagedUpdateLoop()
}

export function getPackagedUpdateSettings(): PackagedUpdateSettingsResponse {
  const support = packagedUpdateSupport()
  if (!support.supported) {
    packagedUpdateUnsupportedState(support.reason || 'automatic packaged updates are unavailable')
  }
  return {
    ...loadAppConfig(),
    appVersion: app.getVersion(),
    state: loadUpdateState(),
    releasesUrl: updateReleasesUrl(),
  }
}

export function savePackagedUpdateSettings(autoUpdateEnabled: boolean): PackagedUpdateSettingsResponse {
  const config = saveAppConfig({ autoUpdateEnabled })
  restartPackagedUpdateLoop()
  return {
    ...config,
    appVersion: app.getVersion(),
    state: loadUpdateState(),
    releasesUrl: updateReleasesUrl(),
  }
}

export async function checkForPackagedUpdates(mode: 'auto' | 'manual' = 'manual'): Promise<UpdateState> {
  const support = packagedUpdateSupport()
  if (!support.supported) {
    return packagedUpdateUnsupportedState(support.reason || 'automatic packaged updates are unavailable')
  }

  const config = loadAppConfig()
  if (mode === 'auto' && !config.autoUpdateEnabled) {
    return loadUpdateState()
  }

  await autoUpdater.checkForUpdates()
  return loadUpdateState()
}

export async function applyPackagedUpdate(): Promise<UpdateState> {
  const support = packagedUpdateSupport()
  if (!support.supported) {
    return packagedUpdateUnsupportedState(support.reason || 'automatic packaged updates are unavailable')
  }

  const state = loadUpdateState()
  if (state.lastResult !== 'downloaded' || !state.downloadedVersion) {
    throw new Error('No downloaded packaged update is ready to install yet')
  }

  packagedUpdateStatePatch({
    running: true,
    supported: true,
    lastResult: 'installing',
    message: `closing DataMoat to install version ${state.downloadedVersion}`,
  })
  setTimeout(() => {
    autoUpdater.quitAndInstall()
  }, 150)
  return loadUpdateState()
}

export async function openPackagedReleasePage(): Promise<string> {
  const url = updateReleasesUrl()
  await shell.openExternal(url)
  return url
}
