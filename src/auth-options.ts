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

function touchIdErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase()
}

// Transient helper-lifecycle / timeout failures. A cold first Touch ID prompt
// can exceed the unwrap timeout (which then restarts the helper), or the helper
// may not have come ready yet. These are retryable — the next attempt usually
// succeeds against the now-warm helper — so they must keep Touch ID available
// and must NOT force the sticky password-refresh state. Only a genuine Secure
// Enclave key problem (missing / unwrap failed / CryptoTokenKit -3) is durable.
function touchIdFailureIsTransientHelper(message: string): boolean {
  return message.includes('unwrap_touchid did not respond')
    || message.includes('touch id helper did not respond')
    || message.includes('vault helper did not become ready')
    || message.includes('vault helper failed to start')
    || message.includes('vault helper exited')
    || message.includes('vault helper restarted')
}

export function touchIdFailureKeepsUnlockAvailable(error: unknown): boolean {
  const message = touchIdErrorMessage(error)
  return message.includes('user canceled')
    || message.includes('user cancelled')
    || message.includes('user fallback')
    || message.includes('authentication failed')
    || message.includes('authentication canceled')
    || message.includes('authentication cancelled')
    || message.includes('system canceled')
    || message.includes('system cancelled')
    || message.includes('app canceled')
    || message.includes('app cancelled')
    || message.includes('biometry lockout')
    || message.includes('biometry is locked')
    || message.includes('errsecusercanceled')
    || message.includes('secure enclave key load failed: -128')
    || touchIdFailureIsTransientHelper(message)
    || /localauthentication.*error\s*-(1|2|3|4|8|9|10|1004)\b/.test(message)
}

export function touchIdFailureNeedsPasswordRefresh(error: unknown): boolean {
  if (touchIdFailureKeepsUnlockAvailable(error)) return false
  const message = touchIdErrorMessage(error)
  return message.includes('secure enclave key missing')
    || message.includes('secure enclave unwrap failed')
    || message.includes('cryptotokenkit error -3')
}
