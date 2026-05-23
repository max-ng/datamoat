import { platform } from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { execFile, execFileSync, spawnSync } from 'child_process'
import { detectInstallContext } from './install-context'
import { STATE_DIR } from './config'

const SERVICE = process.env.DATAMOAT_KEYCHAIN_SERVICE?.trim() || 'DataMoat'
const MAC_HELPER_SECRET_SERVICE = process.env.DATAMOAT_MAC_HELPER_KEYCHAIN_SERVICE?.trim() || `${SERVICE}.helper-v2`
const VAULT_KEY_ACCOUNT = 'vaultKey'
const BACKGROUND_CAPTURE_SECRET_ACCOUNT = 'backgroundCaptureSecret'
const BOOTSTRAP_CAPTURE_SECRET_ACCOUNT = 'bootstrapCaptureSecret'
const LINUX_BACKGROUND_SECRET_DIR = path.join(STATE_DIR, 'background-capture-secrets')
const LINUX_BOOTSTRAP_SECRET_FILE = path.join(STATE_DIR, 'bootstrap-capture-secret')
const WINDOWS_SECRET_DIR = path.join(STATE_DIR, 'windows-secrets')

export const IS_MAC = platform() === 'darwin'
const TOUCHID_HELPER_BUNDLE_EXECUTABLE = path.join('DataMoatTouchID.app', 'Contents', 'MacOS', 'DataMoatTouchID')
const TOUCHID_DMG_ONLY_REASON = 'Touch ID + Secure Enclave is only available in the packaged DMG app.'
const KEYCHAIN_UNAVAILABLE_REASON = 'macOS login keychain is unavailable'
let cachedMacHelperSecretAccessIdentity: string | null | undefined

export type SecureEnclaveStatus = {
  available: boolean
  reason?: string
}

async function secretStore(account: string, value: string): Promise<void> {
  if (platform() === 'win32') {
    windowsStoreSecret(account, value)
    return
  }
  if (IS_MAC) {
    await macStoreSecret(account, value)
    return
  }
  assertDefaultKeychainAvailable()
  const keytar = await import('keytar')
  await keytar.setPassword(SERVICE, account, value)
}

async function secretLoad(account: string): Promise<string | null> {
  if (platform() === 'win32') return windowsLoadSecret(account)
  if (IS_MAC) {
    try {
      return await macLoadSecret(account)
    } catch {
      return null
    }
  }
  try {
    assertDefaultKeychainAvailable()
    const keytar = await import('keytar')
    return await keytar.getPassword(SERVICE, account)
  } catch {
    return null
  }
}

async function secretDelete(account: string): Promise<void> {
  if (platform() === 'win32') {
    windowsDeleteSecret(account)
    return
  }
  if (IS_MAC) {
    try { await macDeleteSecret(account) } catch { /* ignore */ }
    return
  }
  try {
    assertDefaultKeychainAvailable()
    const keytar = await import('keytar')
    await keytar.deletePassword(SERVICE, account)
  } catch { /* ignore */ }
}

function secretFileName(account: string): string {
  return Buffer.from(account, 'utf8').toString('base64url')
}

function windowsSecretFileForAccount(account: string): string {
  return path.join(WINDOWS_SECRET_DIR, `${secretFileName(account)}.dpapi`)
}

function runWindowsDpapi(script: string, input = ''): string {
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function windowsStoreSecret(account: string, secret: string): void {
  fs.mkdirSync(WINDOWS_SECRET_DIR, { recursive: true })
  const protectedText = runWindowsDpapi([
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$plain = [Console]::In.ReadToEnd()',
    '$bytes = [Text.Encoding]::UTF8.GetBytes($plain)',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)',
    '[Convert]::ToBase64String($protected)',
  ].join('; '), secret)
  fs.writeFileSync(windowsSecretFileForAccount(account), protectedText, { encoding: 'utf8', mode: 0o600 })
}

function windowsLoadSecret(account: string): string | null {
  try {
    const protectedText = fs.readFileSync(windowsSecretFileForAccount(account), 'utf8').trim()
    if (!protectedText) return null
    return runWindowsDpapi([
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      '$raw = [Console]::In.ReadToEnd().Trim()',
      '$bytes = [Convert]::FromBase64String($raw)',
      '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
      '$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
      '[Text.Encoding]::UTF8.GetString($plainBytes)',
    ].join('; '), protectedText)
  } catch {
    return null
  }
}

function windowsDeleteSecret(account: string): void {
  try { fs.rmSync(windowsSecretFileForAccount(account), { force: true }) } catch { /* ignore */ }
}

async function macStoreSecret(account: string, secret: string): Promise<void> {
  await execTouchId(['--secret-store', '--service', MAC_HELPER_SECRET_SERVICE, '--account', account], secret)
}

async function macLoadSecret(account: string): Promise<string | null> {
  try {
    const value = await execTouchId(['--secret-load', '--service', MAC_HELPER_SECRET_SERVICE, '--account', account])
    return value || null
  } catch {
    return null
  }
}

async function macDeleteSecret(account: string): Promise<void> {
  await execTouchId(['--secret-delete', '--service', MAC_HELPER_SECRET_SERVICE, '--account', account])
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

function touchIdHelperTimeoutMs(args: string[]): number {
  return args.includes('--secret-load') ? 5000 : 30000
}

function execTouchId(args: string[], input?: string): Promise<string> {
  const helperPath = resolveTouchIdHelperPath()
  return new Promise((resolve, reject) => {
    const child = execFile(helperPath, args, { timeout: touchIdHelperTimeoutMs(args) }, (err, stdout, stderr) => {
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
    if (input !== undefined) child.stdin?.end(input)
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

export function macHelperSecretAccessRequesterPath(): string | null {
  if (!IS_MAC) return null
  const helperPath = resolveTouchIdHelperPath()
  return fs.existsSync(helperPath) ? path.resolve(helperPath) : null
}

export function macHelperSecretAccessRequesterIdentity(): string | null {
  if (!IS_MAC) return null
  if (cachedMacHelperSecretAccessIdentity !== undefined) return cachedMacHelperSecretAccessIdentity

  const helperPath = macHelperSecretAccessRequesterPath()
  if (!helperPath) {
    cachedMacHelperSecretAccessIdentity = null
    return cachedMacHelperSecretAccessIdentity
  }

  try {
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', helperPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    const identifier = output.match(/^Identifier=(.+)$/m)?.[1]?.trim() || ''
    const teamId = output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || ''
    const cdHash = output.match(/^CDHash=(.+)$/m)?.[1]?.trim()
      || output.match(/^CandidateCDHash\w* sha256=(.+)$/m)?.[1]?.trim()
      || ''
    cachedMacHelperSecretAccessIdentity = identifier && teamId && teamId !== 'not set' && cdHash
      ? `darwin-touchid-helper-codesign-v1:${teamId}:${identifier}:${cdHash}`
      : null
  } catch {
    cachedMacHelperSecretAccessIdentity = null
  }
  return cachedMacHelperSecretAccessIdentity
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
