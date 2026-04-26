import * as crypto from 'crypto'

const ALG = 'aes-256-gcm'

export function generateVaultKey(): string {
  return crypto.randomBytes(32).toString('hex')
}

// Encrypted line layout: nonce(12) || GCM-tag(16) || ciphertext → base64
export function encryptLine(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALG, key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ct]).toString('base64')
}

export function decryptLine(blob: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const buf = Buffer.from(blob, 'base64')
  const nonce = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = crypto.createDecipheriv(ALG, key, nonce)
  decipher.setAuthTag(tag)
  return decipher.update(ct).toString('utf8') + decipher.final('utf8')
}

export function encryptBytes(plaintext: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex')
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALG, key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ct])
}

export function decryptBytes(blob: Buffer, keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex')
  const nonce = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const ct = blob.subarray(28)
  const decipher = crypto.createDecipheriv(ALG, key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}
