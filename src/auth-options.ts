import type { AuthConfig } from './auth'
import type { InstallMode } from './install-context'

export function authConfigHasTouchId(config: Pick<AuthConfig, 'touchIdEnabled' | 'touchIdWrappedVaultKey'>): boolean {
  return !!(config.touchIdEnabled || config.touchIdWrappedVaultKey)
}

export function shouldExposeTouchIdUnlock(
  config: Pick<AuthConfig, 'touchIdEnabled' | 'touchIdWrappedVaultKey'>,
  installMode: InstallMode,
  _secureEnclaveAvailable: boolean,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false
  return installMode === 'packaged' && authConfigHasTouchId(config)
}
