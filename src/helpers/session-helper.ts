import * as crypto from 'crypto'
import * as readline from 'readline'

type SessionMode = 'full' | 'capture'
type SessionState = {
  key: Buffer
  mode: SessionMode
}

const sessions = new Map<string, SessionState>()
const WRAP_ITERATIONS = 600_000
const STATE_KEY_LABEL = Buffer.from('datamoat-state-v1', 'utf8')

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex')
}

function createSession(key?: Buffer, mode: SessionMode = 'full'): string {
  const sessionId = randomHex(16)
  sessions.set(sessionId, { key: key ?? crypto.randomBytes(32), mode })
  return sessionId
}

function requireSession(sessionId: string): SessionState {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('vault session missing')
  return session
}

function requireFullSession(sessionId: string): Buffer {
  const session = requireSession(sessionId)
  if (session.mode !== 'full') throw new Error('vault session is capture-only')
  return session.key
}

function requireAnySession(sessionId: string): Buffer {
  return requireSession(sessionId).key
}

function stateKeyFor(key: Buffer): Buffer {
  return crypto.createHash('sha256').update(STATE_KEY_LABEL).update(key).digest()
}

function deriveWrapKey(secret: string, saltHex: string, iterations = WRAP_ITERATIONS): Buffer {
  return crypto.pbkdf2Sync(secret, Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256')
}

function encryptData(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ciphertext])
}

function decryptData(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < 28) throw new Error('ciphertext too short')
  const nonce = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const ciphertext = blob.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function handleRequest(payload: Record<string, unknown>): Record<string, unknown> {
  const id = typeof payload.id === 'number' ? payload.id : 0
  const cmd = typeof payload.cmd === 'string' ? payload.cmd : ''

  try {
    switch (cmd) {
      case 'create_session':
        return { id, ok: true, sessionId: createSession() }
      case 'create_session_from_secret': {
        const secret = String(payload.secret ?? '')
        if (!secret) throw new Error('create_session_from_secret missing secret')
        const key = Buffer.from(secret, 'hex')
        if (key.length !== 32) throw new Error('invalid bootstrap key length')
        return { id, ok: true, sessionId: createSession(key) }
      }
      case 'wrap_secret': {
        const sessionId = String(payload.sessionId ?? '')
        const secret = String(payload.secret ?? '')
        if (!sessionId || !secret) throw new Error('wrap_secret missing parameters')
        const salt = randomHex(16)
        const derived = deriveWrapKey(secret, salt)
        const blob = encryptData(requireFullSession(sessionId), derived).toString('base64')
        return { id, ok: true, salt, blob, iterations: WRAP_ITERATIONS }
      }
      case 'unwrap_secret': {
        const secret = String(payload.secret ?? '')
        const salt = String(payload.salt ?? '')
        const blob = String(payload.blob ?? '')
        const iterations = typeof payload.iterations === 'number' ? payload.iterations : WRAP_ITERATIONS
        if (!secret || !salt || !blob) throw new Error('unwrap_secret missing parameters')
        const derived = deriveWrapKey(secret, salt, iterations)
        const key = decryptData(Buffer.from(blob, 'base64'), derived)
        if (key.length !== 32) throw new Error('invalid vault key length')
        return { id, ok: true, sessionId: createSession(key) }
      }
      case 'unwrap_secret_capture': {
        const secret = String(payload.secret ?? '')
        const salt = String(payload.salt ?? '')
        const blob = String(payload.blob ?? '')
        const iterations = typeof payload.iterations === 'number' ? payload.iterations : WRAP_ITERATIONS
        if (!secret || !salt || !blob) throw new Error('unwrap_secret_capture missing parameters')
        const derived = deriveWrapKey(secret, salt, iterations)
        const key = decryptData(Buffer.from(blob, 'base64'), derived)
        if (key.length !== 32) throw new Error('invalid vault key length')
        return { id, ok: true, sessionId: createSession(key, 'capture') }
      }
      case 'wrap_touchid':
      case 'unwrap_touchid':
        throw new Error('touch id unavailable on this platform')
      case 'lock_session': {
        const sessionId = String(payload.sessionId ?? '')
        if (!sessionId) throw new Error('lock_session missing sessionId')
        sessions.delete(sessionId)
        return { id, ok: true }
      }
      case 'encrypt_lines': {
        const sessionId = String(payload.sessionId ?? '')
        const lines = Array.isArray(payload.lines) ? payload.lines.map(String) : null
        if (!sessionId || !lines) throw new Error('encrypt_lines missing parameters')
        const key = requireAnySession(sessionId)
        return {
          id,
          ok: true,
          lines: lines.map(line => encryptData(Buffer.from(line, 'utf8'), key).toString('base64')),
        }
      }
      case 'decrypt_lines': {
        const sessionId = String(payload.sessionId ?? '')
        const lines = Array.isArray(payload.lines) ? payload.lines.map(String) : null
        if (!sessionId || !lines) throw new Error('decrypt_lines missing parameters')
        const key = requireFullSession(sessionId)
        return {
          id,
          ok: true,
          lines: lines.map(line => decryptData(Buffer.from(line, 'base64'), key).toString('utf8')),
        }
      }
      case 'encrypt_bytes': {
        const sessionId = String(payload.sessionId ?? '')
        const data = String(payload.data ?? '')
        if (!sessionId || !data) throw new Error('encrypt_bytes missing parameters')
        return { id, ok: true, data: encryptData(Buffer.from(data, 'base64'), requireAnySession(sessionId)).toString('base64') }
      }
      case 'decrypt_bytes': {
        const sessionId = String(payload.sessionId ?? '')
        const data = String(payload.data ?? '')
        if (!sessionId || !data) throw new Error('decrypt_bytes missing parameters')
        return { id, ok: true, data: decryptData(Buffer.from(data, 'base64'), requireFullSession(sessionId)).toString('base64') }
      }
      case 'encrypt_state': {
        const sessionId = String(payload.sessionId ?? '')
        const line = String(payload.line ?? '')
        if (!sessionId || !line) throw new Error('encrypt_state missing parameters')
        const key = stateKeyFor(requireAnySession(sessionId))
        return { id, ok: true, line: encryptData(Buffer.from(line, 'utf8'), key).toString('base64') }
      }
      case 'decrypt_state': {
        const sessionId = String(payload.sessionId ?? '')
        const line = String(payload.line ?? '')
        if (!sessionId || !line) throw new Error('decrypt_state missing parameters')
        const key = stateKeyFor(requireAnySession(sessionId))
        return { id, ok: true, line: decryptData(Buffer.from(line, 'base64'), key).toString('utf8') }
      }
      case 'shutdown':
        process.nextTick(() => process.exit(0))
        return { id, ok: true }
      default:
        throw new Error(`unknown command: ${cmd}`)
    }
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function respond(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

respond({ ready: true })

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  try {
    const payload = JSON.parse(line) as Record<string, unknown>
    respond(handleRequest(payload))
  } catch {
    respond({ id: 0, ok: false, error: 'invalid json request' })
  }
})
