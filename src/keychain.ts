import { platform } from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execFile, execFileSync } from 'child_process'
import { detectInstallContext } from './install-context'

const SERVICE = process.env.DATAMOAT_KEYCHAIN_SERVICE?.trim() || 'DataMoat'
const VAULT_KEY_ACCOUNT = 'vaultKey'
const BACKGROUND_CAPTURE_SECRET_ACCOUNT = 'backgroundCaptureSecret'
const BOOTSTRAP_CAPTURE_SECRET_ACCOUNT = 'bootstrapCaptureSecret'

export const IS_MAC = platform() === 'darwin'
const TOUCHID_HELPER_BUNDLE_EXECUTABLE = path.join('DataMoatTouchID.app', 'Contents', 'MacOS', 'DataMoatTouchID')
const TOUCHID_DMG_ONLY_REASON = 'Touch ID + Secure Enclave is only available in the packaged DMG app.'
const KEYCHAIN_UNAVAILABLE_REASON = 'macOS login keychain is unavailable'

export type SecureEnclaveStatus = {
  available: boolean
  reason?: string
}

async function secretStore(account: string, value: string): Promise<void> {
  assertDefaultKeychainAvailable()
  const keytar = await import('keytar')
  await keytar.setPassword(SERVICE, account, value)
}

async function secretLoad(account: string): Promise<string | null> {
  try {
    assertDefaultKeychainAvailable()
    const keytar = await import('keytar')
    return await keytar.getPassword(SERVICE, account)
  } catch {
    return null
  }
}

async function secretDelete(account: string): Promise<void> {
  try {
    assertDefaultKeychainAvailable()
    const keytar = await import('keytar')
    await keytar.deletePassword(SERVICE, account)
  } catch { /* ignore */ }
}

function assertDefaultKeychainAvailable(): void {
  if (!IS_MAC) return

  let keychainPath = ''
  try {
    keychainPath = execFileSync('/usr/bin/security', ['default-keychain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
  } catch {
    throw new Error(KEYCHAIN_UNAVAILABLE_REASON)
  }

  const normalized = keychainPath.replace(/^"|"$/g, '')
  if (!normalized || !fs.existsSync(normalized)) {
    throw new Error(KEYCHAIN_UNAVAILABLE_REASON)
  }
}

export async function keychainStore(key: string): Promise<void> {
  await secretStore(VAULT_KEY_ACCOUNT, key)
}

export async function keychainLoad(): Promise<string | null> {
  return await secretLoad(VAULT_KEY_ACCOUNT)
}

export async function keychainDelete(): Promise<void> {
  await secretDelete(VAULT_KEY_ACCOUNT)
}

export async function backgroundCaptureSecretStore(secret: string, account = BACKGROUND_CAPTURE_SECRET_ACCOUNT): Promise<void> {
  await secretStore(account, secret)
}

export async function backgroundCaptureSecretLoad(account = BACKGROUND_CAPTURE_SECRET_ACCOUNT): Promise<string | null> {
  return await secretLoad(account)
}

export async function backgroundCaptureSecretDelete(account = BACKGROUND_CAPTURE_SECRET_ACCOUNT): Promise<void> {
  await secretDelete(account)
}

export async function bootstrapCaptureSecretStore(secret: string): Promise<void> {
  await secretStore(BOOTSTRAP_CAPTURE_SECRET_ACCOUNT, secret)
}

export async function bootstrapCaptureSecretLoad(): Promise<string | null> {
  return await secretLoad(BOOTSTRAP_CAPTURE_SECRET_ACCOUNT)
}

export async function bootstrapCaptureSecretDelete(): Promise<void> {
  await secretDelete(BOOTSTRAP_CAPTURE_SECRET_ACCOUNT)
}

function execTouchId(args: string[]): Promise<string> {
  const helperPath = resolveTouchIdHelperPath()
  return new Promise((resolve, reject) => {
    execFile(helperPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const wrapped = Object.assign(new Error(stderr?.trim() || 'touchid helper failed'), { cause: err })
        reject(wrapped)
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

function resolveTouchIdHelperPath(): string {
  const packagedCandidate = process.resourcesPath
    ? path.join(process.resourcesPath, '..', 'Helpers', TOUCHID_HELPER_BUNDLE_EXECUTABLE)
    : ''
  const bundledContentsCandidate = path.resolve(__dirname, '..', '..', '..', 'Helpers', TOUCHID_HELPER_BUNDLE_EXECUTABLE)
  const localBundleCandidate = path.join(__dirname, '..', 'Helpers', TOUCHID_HELPER_BUNDLE_EXECUTABLE)
  const localDistBundleCandidate = path.join(__dirname, 'helpers', TOUCHID_HELPER_BUNDLE_EXECUTABLE)
  const bareCandidate = path.join(__dirname, 'helpers', 'touchid')
  for (const candidate of [packagedCandidate, bundledContentsCandidate, localBundleCandidate, localDistBundleCandidate, bareCandidate]) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return bareCandidate
}

export async function secureEnclaveAvailable(): Promise<boolean> {
  return (await secureEnclaveStatus()).available
}

export async function secureEnclaveStatus(): Promise<SecureEnclaveStatus> {
  if (!IS_MAC) return { available: false, reason: 'Touch ID requires macOS.' }
  if (detectInstallContext().mode !== 'packaged') {
    return { available: false, reason: TOUCHID_DMG_ONLY_REASON }
  }
  try {
    await execTouchId(['--check'])
    return { available: true }
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error && error.message
        ? error.message
        : 'Touch ID + Secure Enclave is unavailable in this build.',
    }
  }
}
