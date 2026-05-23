import * as fs from 'fs'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'
import speakeasy from 'speakeasy'
import * as bip39 from 'bip39'
import { AUTH_FILE } from './config'
export { generateVaultKey } from './crypto'

export const AUTH_SCHEMA_VERSION = 4

export const SCRYPT_V2_OPTS = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024,
} as const

const SCRYPT_V2_PREFIX = 'scrypt:v2'
const AUTH_MIGRATION_BACKUP_FILE = path.join(path.dirname(AUTH_FILE), 'state', 'auth-migration-1.1.0-backup.json')

export interface AuthConfig {
  schemaVersion?: number
  setupComplete?: boolean
  passwordEnabled?: boolean
  passwordHash?: string     // scrypt hash of master password
  passwordWrappedVaultKey?: string
  passwordWrapSalt?: string
  backgroundWrappedVaultKey?: string
  backgroundWrapSalt?: string
  backgroundKeychainAccount?: string
  backgroundKeychainRequester?: string
  backgroundKeychainRequesterIdentity?: string
  touchIdEnabled?: boolean
  touchIdWrappedVaultKey?: string
  touchIdRefreshRequired?: boolean
  touchIdRefreshRequiredAt?: string
  totpSecret?: string       // legacy plaintext fallback only
  totpWrappedSecret?: string
  totpEnrolled: boolean
  vaultKey?: string         // legacy fallback only
  mnemonicHash: string      // SHA-256 of mnemonic — for mnemonic login only
  mnemonicWrappedVaultKey?: string
  mnemonicWrapSalt?: string
  recoveryCodes?: string[]  // retired in 1.1.0; kept only so old auth.json can be sanitized
  recoveryWrappedVaultKeys?: string[]
  recoveryWrapSalts?: string[]
  setupAt: string
}

// ── Password hashing (scrypt, no extra package) ────────────────────────────

type ParsedScryptV2 = {
  N: number
  r: number
  p: number
  saltHex: string
  hashHex: string
}

function scryptAsync(secret: string, salt: string | Buffer, keyLength: number, opts?: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, keyLength, opts ?? {}, (err, key) => {
      if (err) reject(err)
      else resolve(key as Buffer)
    })
  })
}

function parsePositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function parseScryptV2(stored: string | undefined): ParsedScryptV2 | null {
  if (!stored) return null
  const parts = stored.split(':')
  if (parts.length !== 7 || `${parts[0]}:${parts[1]}` !== SCRYPT_V2_PREFIX) return null
  const N = parsePositiveInt(parts[2])
  const r = parsePositiveInt(parts[3])
  const p = parsePositiveInt(parts[4])
  const saltHex = parts[5]
  const hashHex = parts[6]
  if (!N || !r || !p) return null
  if (!/^[a-f0-9]{32,}$/i.test(saltHex) || !/^[a-f0-9]+$/i.test(hashHex)) return null
  return { N, r, p, saltHex, hashHex }
}

function timingSafeHexEqual(expectedHex: string, actual: Buffer): boolean {
  const expected = Buffer.from(expectedHex, 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex')
  const key = await scryptAsync(password, Buffer.from(salt, 'hex'), 64, SCRYPT_V2_OPTS)
  return `${SCRYPT_V2_PREFIX}:${SCRYPT_V2_OPTS.N}:${SCRYPT_V2_OPTS.r}:${SCRYPT_V2_OPTS.p}:${salt}:${key.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsedV2 = parseScryptV2(stored)
  if (parsedV2) {
    const derived = await scryptAsync(password, Buffer.from(parsedV2.saltHex, 'hex'), 64, {
      N: parsedV2.N,
      r: parsedV2.r,
      p: parsedV2.p,
      maxmem: Math.max(SCRYPT_V2_OPTS.maxmem, 128 * parsedV2.N * parsedV2.r + 1024 * 1024),
    })
    return timingSafeHexEqual(parsedV2.hashHex, derived)
  }

  const [salt, key, extra] = stored.split(':')
  if (!salt || !key || extra) return false
  const derived = await scryptAsync(password, salt, 64)
  return timingSafeHexEqual(key, derived)
}

export function passwordHashNeedsMigration(stored: string | undefined): boolean {
  return !parseScryptV2(stored)
}

async function deriveWrapKey(secret: string, saltDescriptor: string): Promise<Buffer> {
  const parsedV2 = parseScryptV2(`${saltDescriptor}:00`)
  if (parsedV2) {
    return scryptAsync(secret, Buffer.from(parsedV2.saltHex, 'hex'), 32, {
      N: parsedV2.N,
      r: parsedV2.r,
      p: parsedV2.p,
      maxmem: Math.max(SCRYPT_V2_OPTS.maxmem, 128 * parsedV2.N * parsedV2.r + 1024 * 1024),
    })
  }
  return scryptAsync(secret, Buffer.from(saltDescriptor, 'hex'), 32)
}

export async function wrapVaultKey(secret: string, vaultKeyHex: string): Promise<{ salt: string; blob: string }> {
  const saltHex = crypto.randomBytes(16).toString('hex')
  const salt = `${SCRYPT_V2_PREFIX}:${SCRYPT_V2_OPTS.N}:${SCRYPT_V2_OPTS.r}:${SCRYPT_V2_OPTS.p}:${saltHex}`
  const key = await deriveWrapKey(secret, salt)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(vaultKeyHex, 'hex')), cipher.final()])
  const tag = cipher.getAuthTag()
  return { salt, blob: Buffer.concat([nonce, tag, ciphertext]).toString('base64') }
}

export async function unwrapVaultKey(secret: string, saltDescriptor: string, blob: string): Promise<string> {
  const key = await deriveWrapKey(secret, saltDescriptor)
  const buf = Buffer.from(blob, 'base64')
  const nonce = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('hex')
}

export function isSetupDone(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as AuthConfig
    return parsed.setupComplete !== false
  } catch {
    return false
  }
}

export function loadAuthConfig(): AuthConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as AuthConfig
    return {
      ...parsed,
      schemaVersion: parsed.schemaVersion ?? AUTH_SCHEMA_VERSION,
      setupComplete: parsed.setupComplete ?? true,
    }
  } catch {
    return null
  }
}

function writePrivateTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 })
  const fd = fs.openSync(tmpPath, 'r')
  try {
    fs.fsyncSync(fd)
  } catch {
    /* non-fatal on filesystems that do not allow fsync on read handles */
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmpPath, filePath)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    /* non-fatal */
  }
}

export function saveAuthConfig(config: AuthConfig): void {
  writePrivateTextAtomic(
    AUTH_FILE,
    JSON.stringify({ ...config, schemaVersion: AUTH_SCHEMA_VERSION }, null, 2),
  )
}

export function backupAuthConfigForMigration(): void {
  try {
    if (!fs.existsSync(AUTH_FILE) || fs.existsSync(AUTH_MIGRATION_BACKUP_FILE)) return
    fs.mkdirSync(path.dirname(AUTH_MIGRATION_BACKUP_FILE), { recursive: true, mode: 0o700 })
    fs.copyFileSync(AUTH_FILE, AUTH_MIGRATION_BACKUP_FILE)
    try { fs.chmodSync(AUTH_MIGRATION_BACKUP_FILE, 0o600) } catch { /* non-fatal */ }
  } catch {
    /* best-effort backup; migration can still continue */
  }
}

export function retireRecoveryCodeFields(config: AuthConfig): string[] {
  const retired: string[] = []
  if (Array.isArray(config.recoveryCodes) && config.recoveryCodes.length > 0) {
    retired.push('recoveryCodes')
  }
  if (config.recoveryWrappedVaultKeys?.length) retired.push('recoveryWrappedVaultKeys')
  if (config.recoveryWrapSalts?.length) retired.push('recoveryWrapSalts')
  delete config.recoveryCodes
  delete config.recoveryWrappedVaultKeys
  delete config.recoveryWrapSalts
  return retired
}

export function deleteAuthConfig(): void {
  try {
    fs.unlinkSync(AUTH_FILE)
  } catch {
    /* ignore */
  }
}

export function generateTOTPSecret(): string {
  const s = speakeasy.generateSecret({ length: 20 })
  return s.base32
}

export function verifyTOTP(secret: string, token: string): boolean {
  try {
    return speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: token.trim(),
      window: 1,  // allow ±30s clock drift
    })
  } catch {
    return false
  }
}

export function generateMnemonic(): string {
  return bip39.generateMnemonic(256)  // 24 words
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function totpURL(secret: string): string {
  const hostname = os.hostname().split('.')[0]
  return speakeasy.otpauthURL({
    secret,
    label: `DataMoat:${hostname}`,
    issuer: 'DataMoat',
    encoding: 'base32',
  })
}
