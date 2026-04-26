import * as child_process from 'child_process'
import * as path from 'path'
import { detectInstallContext } from './install-context'
import { launcherBinaryForScripts, launcherEnvForScripts } from './runtime'
import { loadAppConfig } from './update-config'

type UpdateTriggerMode = 'auto' | 'manual'

let autoUpdateTimer: NodeJS.Timeout | null = null
let autoUpdateInterval: NodeJS.Timeout | null = null

export function triggerDetachedUpdate(mode: UpdateTriggerMode): boolean {
  try {
    child_process.spawn(
      launcherBinaryForScripts(),
      [path.join(__dirname, 'update-worker.js'), mode],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...launcherEnvForScripts(), DATAMOAT_UPDATE_MODE: mode },
      },
    ).unref()
    return true
  } catch {
    return false
  }
}

export function startAutoUpdateLoop(isSessionActive: () => boolean): void {
  const scheduleRun = () => {
    const config = loadAppConfig()
    const install = detectInstallContext()
    if (install.updateStrategy !== 'source-git-pull') return
    if (!config.autoUpdateEnabled || isSessionActive()) return
    triggerDetachedUpdate('auto')
  }

  if (autoUpdateTimer) clearTimeout(autoUpdateTimer)
  if (autoUpdateInterval) clearInterval(autoUpdateInterval)

  const { autoUpdateIntervalHours } = loadAppConfig()
  autoUpdateTimer = setTimeout(scheduleRun, 15000)
  autoUpdateInterval = setInterval(scheduleRun, autoUpdateIntervalHours * 60 * 60 * 1000)
}
