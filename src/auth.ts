import * as fs from 'fs'
import * as crypto from 'crypto'
import * as os from 'os'
import * as path from 'path'
import speakeasy from 'speakeasy'
import * as bip39 from 'bip39'
import { AUTH_FILE } from './config'
export { generateVaultKey } from './crypto'

export const AUTH_SCHEMA_VERSION = 3

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
  touchIdEnabled?: boolean
  touchIdWrappedVaultKey?: string
  totpSecret?: string       // legacy plaintext fallback only
  totpWrappedSecret?: string
  totpEnrolled: boolean
  vaultKey?: string         // legacy fallback only
  mnemonicHash: string      // SHA-256 of mnemonic — for mnemonic login only
  mnemonicWrappedVaultKey?: string
  mnemonicWrapSalt?: string
  recoveryCodes: string[]   // 8 SHA-256 hashes of one-time recovery codes
  recoveryWrappedVaultKeys?: string[]
  recoveryWrapSalts?: string[]
  setupAt: string
}

// ── Password hashing (scrypt, no extra package) ────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex')
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err)
      else resolve(`${salt}:${key.toString('hex')}`)
    })
  })
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, key] = stored.split(':')
  if (!salt || !key) return false
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err)
      else resolve(crypto.timingSafeEqual(Buffer.from(key, 'hex'), derived))
    })
  })
}

async function deriveWrapKey(secret: string, saltHex: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, Buffer.from(saltHex, 'hex'), 32, (err, key) => {
      if (err) reject(err)
      else resolve(key as Buffer)
    })
  })
}

export async function wrapVaultKey(secret: string, vaultKeyHex: string): Promise<{ salt: string; blob: string }> {
  const salt = crypto.randomBytes(16).toString('hex')
  const key = await deriveWrapKey(secret, salt)
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(vaultKeyHex, 'hex')), cipher.final()])
  const tag = cipher.getAuthTag()
  return { salt, blob: Buffer.concat([nonce, tag, ciphertext]).toString('base64') }
}

export async function unwrapVaultKey(secret: string, saltHex: string, blob: string): Promise<string> {
  const key = await deriveWrapKey(secret, saltHex)
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

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-F0-9-]/g, '')
}

export function generateRecoveryCodes(): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: 8 }, () =>
    crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{4}/g)!.join('-')
  )
  return { plain, hashed: plain.map(sha256) }
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

export function verifyRecoveryCode(config: AuthConfig, code: string): boolean {
  return findRecoveryCodeIndex(config, code) !== -1
}

export function findRecoveryCodeIndex(config: AuthConfig, code: string): number {
  const hash = sha256(normalizeRecoveryCode(code))
  return config.recoveryCodes.indexOf(hash)
}

export function consumeRecoveryCode(config: AuthConfig, idx: number): void {
  if (idx < 0 || idx >= config.recoveryCodes.length) return
  config.recoveryCodes.splice(idx, 1)
  if (config.recoveryWrappedVaultKeys) config.recoveryWrappedVaultKeys.splice(idx, 1)
  if (config.recoveryWrapSalts) config.recoveryWrapSalts.splice(idx, 1)
  saveAuthConfig(config)
}
