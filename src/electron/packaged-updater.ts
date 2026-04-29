import { app, Notification, shell } from 'electron'
import * as child_process from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import { autoUpdater, type ProgressInfo, type UpdateDownloadedEvent, type UpdateInfo } from 'electron-updater'
import { detectInstallContext } from '../install-context'
import { writeLog } from '../logging'
import { loadAppConfig, loadUpdateState, saveAppConfig, writeUpdateState, type UpdateState } from '../update-config'
import { UPDATE_GITHUB_HOST, UPDATE_GITHUB_OWNER, UPDATE_GITHUB_REPO, packagedUpdateFeedOptions, updateReleasesUrl } from '../update-channel'

type PackagedUpdateSettingsResponse = {
  autoUpdateEnabled: boolean
  autoUpdateIntervalHours: number
  appVersion: string
  state: UpdateState
  releasesUrl: string
}

type ReleaseAsset = {
  name: string
  browser_download_url?: string
  url?: string
  size?: number
}

type GithubRelease = {
  tag_name?: string
  name?: string
  html_url?: string
  assets?: ReleaseAsset[]
}

type WindowsManualManifest = {
  version?: string
  platform?: string
  architecture?: string
  artifacts?: {
    zip?: {
      path?: string
      url?: string
      sha256?: string
      size?: number
    }
  }
}

type OpenLatestResult = {
  ok: boolean
  url: string
  state?: UpdateState
  manualUpdateStarted?: boolean
  version?: string
  assetName?: string
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

function isWindowsManualPackagedUpdateInstall(): boolean {
  const context = detectInstallContext()
  return process.platform === 'win32' && context.mode === 'packaged' && context.updateStrategy === 'packaged-manual-update'
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

  reconcileInstalledPackagedUpdate()
  const support = packagedUpdateSupport()
  if (!support.supported) {
    if (isWindowsManualPackagedUpdateInstall()) return
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
  if (!support.supported && !isWindowsManualPackagedUpdateInstall()) {
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

function currentWindowsPackageArch(): string {
  return process.env.DATAMOAT_PACKAGE_ARCH || process.arch
}

function githubLatestReleaseApiUrl(): string {
  const host = UPDATE_GITHUB_HOST.replace(/^https?:\/\//, '')
  if (host === 'github.com') {
    return `https://api.github.com/repos/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest`
  }
  return `https://${host}/api/v3/repos/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/releases/latest`
}

function requestBuffer(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const client = parsed.protocol === 'http:' ? http : https
    const req = client.get(parsed, {
      headers: {
        'User-Agent': 'DataMoat updater',
        'Accept': 'application/octet-stream, application/json',
      },
    }, res => {
      const status = res.statusCode || 0
      const location = res.headers.location
      if (status >= 300 && status < 400 && location) {
        res.resume()
        if (redirects >= 5) {
          reject(new Error(`too many redirects while downloading ${url}`))
          return
        }
        requestBuffer(new URL(location, parsed).toString(), redirects + 1).then(resolve, reject)
        return
      }
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`download failed with HTTP ${status}: ${url}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.setTimeout(120000, () => req.destroy(new Error(`download timeout: ${url}`)))
  })
}

async function requestJson<T>(url: string): Promise<T> {
  return JSON.parse((await requestBuffer(url)).toString('utf8').replace(/^\uFEFF/, '')) as T
}

function normalizeVersion(version: string | null | undefined): string {
  return String(version || '').trim().replace(/^v/i, '')
}

function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split(/[.-]/).map(part => Number(part))
  const right = normalizeVersion(b).split(/[.-]/).map(part => Number(part))
  const max = Math.max(left.length, right.length)
  for (let i = 0; i < max; i += 1) {
    const diff = (Number.isFinite(left[i]) ? left[i] : 0) - (Number.isFinite(right[i]) ? right[i] : 0)
    if (diff !== 0) return diff
  }
  return 0
}

function assetUrl(asset: ReleaseAsset): string | null {
  return asset.browser_download_url || asset.url || null
}

function findWindowsAsset(assets: ReleaseAsset[], kind: 'manifest' | 'zip', arch: string): ReleaseAsset | null {
  const suffix = kind === 'manifest' ? 'release-manifest.json' : '.zip'
  const candidates = assets.filter(asset => {
    const name = asset.name.toLowerCase()
    return name.includes('datamoat')
      && name.includes('win32')
      && name.includes(arch.toLowerCase())
      && name.endsWith(suffix)
  })
  return candidates[0] || null
}

async function resolveWindowsManualUpdate(): Promise<{
  version: string
  zipUrl: string
  manifestUrl: string | null
  sha256: string | null
  assetName: string
  releaseUrl: string
}> {
  const arch = currentWindowsPackageArch()
  const manifestOverride = process.env.DATAMOAT_WINDOWS_UPDATE_MANIFEST_URL?.trim()
  if (manifestOverride) {
    const manifest = await requestJson<WindowsManualManifest>(manifestOverride)
    const zip = manifest.artifacts?.zip
    const zipPath = zip?.url || zip?.path
    if (!zipPath) throw new Error('Windows update manifest does not include artifacts.zip.url/path')
    return {
      version: normalizeVersion(manifest.version),
      zipUrl: new URL(zipPath, manifestOverride).toString(),
      manifestUrl: manifestOverride,
      sha256: zip.sha256 || null,
      assetName: path.basename(zipPath),
      releaseUrl: updateReleasesUrl(),
    }
  }

  const latest = await requestJson<GithubRelease>(githubLatestReleaseApiUrl())
  const assets = latest.assets || []
  const manifestAsset = findWindowsAsset(assets, 'manifest', arch)
  const zipAsset = findWindowsAsset(assets, 'zip', arch)
  if (!manifestAsset && !zipAsset) {
    throw new Error(`latest release does not include a Windows ${arch} zip asset yet`)
  }

  if (manifestAsset) {
    const manifestUrl = assetUrl(manifestAsset)
    if (!manifestUrl) throw new Error(`release manifest asset has no download URL: ${manifestAsset.name}`)
    const manifest = await requestJson<WindowsManualManifest>(manifestUrl)
    const zipPath = manifest.artifacts?.zip?.url || manifest.artifacts?.zip?.path || zipAsset?.browser_download_url
    if (!zipPath) throw new Error('Windows update manifest does not include artifacts.zip.url/path')
    return {
      version: normalizeVersion(manifest.version || latest.tag_name),
      zipUrl: new URL(zipPath, manifestUrl).toString(),
      manifestUrl,
      sha256: manifest.artifacts?.zip?.sha256 || null,
      assetName: path.basename(zipPath),
      releaseUrl: latest.html_url || updateReleasesUrl(),
    }
  }

  const directZipUrl = zipAsset ? assetUrl(zipAsset) : null
  if (!zipAsset || !directZipUrl) throw new Error('Windows update zip asset has no download URL')
  return {
    version: normalizeVersion(latest.tag_name || latest.name),
    zipUrl: directZipUrl,
    manifestUrl: null,
    sha256: null,
    assetName: zipAsset.name,
    releaseUrl: latest.html_url || updateReleasesUrl(),
  }
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function cmdValue(value: string): string {
  return value.replace(/"/g, '')
}

function writeWindowsManualUpdateScript(params: {
  zipPath: string
  version: string
  arch: string
}): string {
  const updateRoot = path.dirname(params.zipPath)
  const scriptPath = path.join(updateRoot, 'apply-datamoat-update.cmd')
  const appRoot = path.dirname(app.getPath('exe'))
  const staging = path.join(updateRoot, 'staging')
  const logFile = path.join(updateRoot, 'apply-datamoat-update.log')
  const script = [
    '@echo off',
    'setlocal EnableExtensions',
    `set "APP_ROOT=${cmdValue(appRoot)}"`,
    `set "ZIP_PATH=${cmdValue(params.zipPath)}"`,
    `set "STAGING=${cmdValue(staging)}"`,
    `set "ARCH=${cmdValue(params.arch)}"`,
    `set "LOG_FILE=${cmdValue(logFile)}"`,
    'echo DataMoat update started > "%LOG_FILE%"',
    'timeout /t 2 /nobreak >> "%LOG_FILE%" 2>&1',
    'taskkill /F /IM DataMoat.exe >> "%LOG_FILE%" 2>&1',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$app=$env:APP_ROOT; Get-CimInstance Win32_Process | Where-Object { ($_.Name -ieq \'node.exe\' -or $_.Name -ieq \'DataMoat.exe\') -and $_.CommandLine -and $_.CommandLine.Contains($app) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >> "%LOG_FILE%" 2>&1',
    'timeout /t 2 /nobreak >> "%LOG_FILE%" 2>&1',
    'rmdir /s /q "%STAGING%" >> "%LOG_FILE%" 2>&1',
    'mkdir "%STAGING%" >> "%LOG_FILE%" 2>&1',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $env:ZIP_PATH -DestinationPath $env:STAGING -Force" >> "%LOG_FILE%" 2>&1',
    'if errorlevel 1 exit /b 20',
    'set "SRC=%STAGING%"',
    'if exist "%STAGING%\\DataMoat-win32-%ARCH%\\DataMoat.exe" set "SRC=%STAGING%\\DataMoat-win32-%ARCH%"',
    'if not exist "%SRC%\\DataMoat.exe" (',
    '  echo DataMoat.exe missing from update zip >> "%LOG_FILE%"',
    '  exit /b 21',
    ')',
    'robocopy "%SRC%" "%APP_ROOT%" /MIR /R:5 /W:2 /NFL /NDL /NP >> "%LOG_FILE%" 2>&1',
    'set "ROBOCOPY_RC=%ERRORLEVEL%"',
    'if %ROBOCOPY_RC% GEQ 8 exit /b %ROBOCOPY_RC%',
    'echo DataMoat update copied successfully >> "%LOG_FILE%"',
    'start "" "%APP_ROOT%\\DataMoat.exe"',
    'exit /b 0',
    '',
  ].join('\r\n')
  fs.writeFileSync(scriptPath, script, 'utf8')
  return scriptPath
}

function startDetachedCmd(scriptPath: string): void {
  child_process.spawn('cmd.exe', ['/c', 'start', '', scriptPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  }).unref()
}

async function installLatestWindowsManualUpdate(): Promise<OpenLatestResult> {
  const resolved = await resolveWindowsManualUpdate()
  const currentVersion = app.getVersion()
  const allowSameVersion = process.env.DATAMOAT_WINDOWS_UPDATE_ALLOW_SAME_VERSION === '1'
  if (!resolved.version) throw new Error('latest Windows update does not include a version')
  if (!allowSameVersion && compareVersions(resolved.version, currentVersion) <= 0) {
    const state = packagedUpdateStatePatch({
      running: false,
      supported: true,
      lastCheckedAt: new Date().toISOString(),
      lastResult: 'up-to-date',
      availableVersion: resolved.version,
      message: `already on version ${currentVersion}`,
    })
    return { ok: true, url: resolved.releaseUrl, state, manualUpdateStarted: false, version: resolved.version, assetName: resolved.assetName }
  }

  const updateRoot = path.join(os.tmpdir(), `datamoat-windows-update-${Date.now()}`)
  fs.mkdirSync(updateRoot, { recursive: true })
  const zipPath = path.join(updateRoot, resolved.assetName || `DataMoat-${resolved.version}-win32-${currentWindowsPackageArch()}.zip`)

  packagedUpdateStatePatch({
    running: true,
    supported: true,
    lastCheckedAt: new Date().toISOString(),
    lastResult: 'downloading',
    availableVersion: resolved.version,
    downloadedVersion: null,
    downloadProgressPercent: null,
    message: `downloading Windows version ${resolved.version}`,
  })

  fs.writeFileSync(zipPath, await requestBuffer(resolved.zipUrl))
  if (resolved.sha256) {
    const actual = sha256File(zipPath)
    if (actual.toLowerCase() !== resolved.sha256.toLowerCase()) {
      throw new Error(`Windows update checksum mismatch for ${resolved.assetName}`)
    }
  }

  const scriptPath = writeWindowsManualUpdateScript({
    zipPath,
    version: resolved.version,
    arch: currentWindowsPackageArch(),
  })
  const state = packagedUpdateStatePatch({
    running: true,
    supported: true,
    lastResult: 'installing',
    availableVersion: resolved.version,
    downloadedVersion: resolved.version,
    downloadProgressPercent: 100,
    message: `installing Windows version ${resolved.version}`,
  })
  startDetachedCmd(scriptPath)
  setTimeout(() => {
    app.quit()
  }, 1000)
  return { ok: true, url: resolved.releaseUrl, state, manualUpdateStarted: true, version: resolved.version, assetName: resolved.assetName }
}

export async function openPackagedReleasePage(): Promise<OpenLatestResult> {
  const url = updateReleasesUrl()
  if (isWindowsManualPackagedUpdateInstall()) {
    return await installLatestWindowsManualUpdate()
  }
  await shell.openExternal(url)
  return { ok: true, url, manualUpdateStarted: false }
}
