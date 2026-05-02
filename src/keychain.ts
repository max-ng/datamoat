import { platform } from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execFile, execFileSync } from 'child_process'
import { detectInstallContext } from './install-context'
import { STATE_DIR } from './config'

const SERVICE = process.env.DATAMOAT_KEYCHAIN_SERVICE?.trim() || 'DataMoat'
const VAULT_KEY_ACCOUNT = 'vaultKey'
const BACKGROUND_CAPTURE_SECRET_ACCOUNT = 'backgroundCaptureSecret'
const BOOTSTRAP_CAPTURE_SECRET_ACCOUNT = 'bootstrapCaptureSecret'
const LINUX_BACKGROUND_SECRET_DIR = path.join(STATE_DIR, 'background-capture-secrets')
const LINUX_BOOTSTRAP_SECRET_FILE = path.join(STATE_DIR, 'bootstrap-capture-secret')

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

function linuxShouldUseBootstrapFileSecret(): boolean {
  return platform() === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS?.trim()
}

function linuxSecretFileForAccount(account: string): string {
  return path.join(
    LINUX_BACKGROUND_SECRET_DIR,
    Buffer.from(account, 'utf8').toString('base64url'),
  )
}

function linuxStoreBackgroundFileSecret(account: string, secret: string): void {
  fs.mkdirSync(LINUX_BACKGROUND_SECRET_DIR, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(LINUX_BACKGROUND_SECRET_DIR, 0o700) } catch { /* non-fatal */ }
  fs.writeFileSync(linuxSecretFileForAccount(account), secret, { encoding: 'utf8', mode: 0o600 })
}

function linuxLoadBackgroundFileSecret(account: string): string | null {
  try {
    return fs.readFileSync(linuxSecretFileForAccount(account), 'utf8').trim() || null
  } catch {
    return null
  }
}

function linuxDeleteBackgroundFileSecret(account: string): void {
  try { fs.rmSync(linuxSecretFileForAccount(account), { force: true }) } catch { /* ignore */ }
}

function linuxStoreBootstrapFileSecret(secret: string): void {
  fs.mkdirSync(path.dirname(LINUX_BOOTSTRAP_SECRET_FILE), { recursive: true })
  fs.writeFileSync(LINUX_BOOTSTRAP_SECRET_FILE, secret, { encoding: 'utf8', mode: 0o600 })
}

function linuxLoadBootstrapFileSecret(): string | null {
  try {
    return fs.readFileSync(LINUX_BOOTSTRAP_SECRET_FILE, 'utf8').trim() || null
  } catch {
    return null
  }
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
  try {
    await secretStore(account, secret)
  } catch (error) {
    if (platform() !== 'linux') throw error
    linuxStoreBackgroundFileSecret(account, secret)
  }
}

export async function backgroundCaptureSecretLoad(account = BACKGROUND_CAPTURE_SECRET_ACCOUNT): Promise<string | null> {
  const stored = await secretLoad(account)
  if (stored) return stored
  if (platform() !== 'linux') return null
  return linuxLoadBackgroundFileSecret(account)
}

export async function backgroundCaptureSecretDelete(account = BACKGROUND_CAPTURE_SECRET_ACCOUNT): Promise<void> {
  await secretDelete(account)
  if (platform() === 'linux') linuxDeleteBackgroundFileSecret(account)
}

export async function bootstrapCaptureSecretStore(secret: string): Promise<void> {
  if (linuxShouldUseBootstrapFileSecret()) {
    linuxStoreBootstrapFileSecret(secret)
    return
  }

  try {
    await secretStore(BOOTSTRAP_CAPTURE_SECRET_ACCOUNT, secret)
  } catch (error) {
    if (platform() !== 'linux') throw error
    linuxStoreBootstrapFileSecret(secret)
  }
}

export async function bootstrapCaptureSecretLoad(): Promise<string | null> {
  if (linuxShouldUseBootstrapFileSecret()) return linuxLoadBootstrapFileSecret()

  const stored = await secretLoad(BOOTSTRAP_CAPTURE_SECRET_ACCOUNT)
  if (stored) return stored
  if (platform() !== 'linux') return null
  return linuxLoadBootstrapFileSecret()
}

export async function bootstrapCaptureSecretDelete(): Promise<void> {
  await secretDelete(BOOTSTRAP_CAPTURE_SECRET_ACCOUNT)
  if (platform() === 'linux') {
    try { fs.rmSync(LINUX_BOOTSTRAP_SECRET_FILE, { force: true }) } catch { /* ignore */ }
  }
}

function execTouchId(args: string[]): Promise<string> {
  const helperPath = resolveTouchIdHelperPath()
  return new Promise((resolve, reject) => {
    execFile(helperPath, args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr?.trim()
          || [err.message, (err as NodeJS.ErrnoException & { signal?: string }).signal ? `signal ${(err as NodeJS.ErrnoException & { signal?: string }).signal}` : '']
            .filter(Boolean)
            .join(' · ')
          || 'touchid helper failed'
        const wrapped = Object.assign(new Error(detail), { cause: err })
        reject(wrapped)
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  let lastError: unknown = null
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await execTouchId(['--check'])
        return { available: true }
      } catch (error) {
        lastError = error
        if (attempt < 2) await delay(250 * (attempt + 1))
      }
    }
    throw lastError
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error && error.message
        ? error.message
        : 'Touch ID + Secure Enclave is unavailable in this build.',
    }
  }
}
