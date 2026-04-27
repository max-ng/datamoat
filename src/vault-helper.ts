import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { ChildProcessWithoutNullStreams, spawn } from 'child_process'

const SWIFT_HELPER_BUNDLE_EXECUTABLE = path.join('DataMoatTouchID.app', 'Contents', 'MacOS', 'DataMoatTouchID')
const JS_HELPER_BIN = path.join(__dirname, 'helpers', 'session-helper.js')

type PendingRequest = {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

let helper: ChildProcessWithoutNullStreams | null = null
let helperReady = false
let nextRequestId = 1
const pending = new Map<number, PendingRequest>()
let stderrTail = ''
const MAX_HELPER_LINE_PAYLOAD_BYTES = 128 * 1024
const CHUNKED_LINE_PREFIX = 'dmchunk1:'

function ensureHelper(): ChildProcessWithoutNullStreams {
  if (helper && !helper.killed && helper.exitCode === null) return helper

  const swiftHelperBin = resolveSwiftHelperPath()
  const useSwiftHelper = process.platform === 'darwin' && !!swiftHelperBin
  helper = useSwiftHelper
    ? spawn(swiftHelperBin!, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(process.execPath, [JS_HELPER_BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
  helperReady = false
  stderrTail = ''

  const rl = readline.createInterface({ input: helper.stdout })
  rl.on('line', line => {
    let payload: any
    try {
      payload = JSON.parse(line)
    } catch {
      return
    }
    if (payload.ready) {
      helperReady = true
      return
    }
    const request = pending.get(payload.id)
    if (!request) return
    pending.delete(payload.id)
    if (payload.ok) request.resolve(payload)
    else request.reject(new Error(payload.error || 'vault helper request failed'))
  })

  helper.stderr.on('data', chunk => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000)
  })

  helper.on('exit', () => {
    const err = new Error(stderrTail.trim() || 'vault helper exited unexpectedly')
    helper = null
    helperReady = false
    for (const request of pending.values()) request.reject(err)
    pending.clear()
  })

  return helper
}

function resolveSwiftHelperPath(): string | null {
  const packagedCandidate = process.resourcesPath
    ? path.join(process.resourcesPath, '..', 'Helpers', SWIFT_HELPER_BUNDLE_EXECUTABLE)
    : ''
  const bundledContentsCandidate = path.resolve(__dirname, '..', '..', '..', 'Helpers', SWIFT_HELPER_BUNDLE_EXECUTABLE)
  const localBundleCandidate = path.join(__dirname, '..', 'Helpers', SWIFT_HELPER_BUNDLE_EXECUTABLE)
  const localDistBundleCandidate = path.join(__dirname, 'helpers', SWIFT_HELPER_BUNDLE_EXECUTABLE)
  const bareCandidate = path.join(__dirname, 'helpers', 'touchid')
  for (const candidate of [packagedCandidate, bundledContentsCandidate, localBundleCandidate, localDistBundleCandidate, bareCandidate]) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

async function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (helperReady) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(stderrTail.trim() || 'vault helper did not become ready'))
    }, 5000)
    const tick = () => {
      if (proc.exitCode !== null || proc.killed) {
        clearTimeout(timeout)
        reject(new Error(stderrTail.trim() || 'vault helper failed to start'))
        return
      }
      if (helperReady) {
        clearTimeout(timeout)
        resolve()
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

async function request<T>(cmd: string, payload: Record<string, unknown> = {}): Promise<T> {
  const proc = ensureHelper()
  await waitForReady(proc)

  const id = nextRequestId++
  const body = JSON.stringify({ id, cmd, ...payload })

  return await new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.stdin.write(`${body}\n`, err => {
      if (!err) return
      pending.delete(id)
      reject(err)
    })
  })
}

export async function createVaultSession(): Promise<string> {
  const res = await request<{ sessionId: string }>('create_session')
  return res.sessionId
}

export async function createSessionFromSecret(secret: string): Promise<string> {
  const res = await request<{ sessionId: string }>('create_session_from_secret', { secret })
  return res.sessionId
}

export async function wrapSecretForSession(sessionId: string, secret: string): Promise<{ salt: string; blob: string; iterations: number }> {
  const res = await request<{ salt: string; blob: string; iterations: number }>('wrap_secret', { sessionId, secret })
  return res
}

export async function unwrapSecretToSession(secret: string, salt: string, blob: string, iterations?: number): Promise<string> {
  const res = await request<{ sessionId: string }>('unwrap_secret', { secret, salt, blob, iterations })
  return res.sessionId
}

export async function unwrapSecretToCaptureSession(secret: string, salt: string, blob: string, iterations?: number): Promise<string> {
  const res = await request<{ sessionId: string }>('unwrap_secret_capture', { secret, salt, blob, iterations })
  return res.sessionId
}

export async function wrapTouchIdForSession(sessionId: string): Promise<string> {
  const res = await request<{ blob: string }>('wrap_touchid', { sessionId })
  return res.blob
}

export async function unwrapTouchIdToSession(blob: string): Promise<string> {
  const res = await request<{ sessionId: string }>('unwrap_touchid', { blob })
  return res.sessionId
}

export async function lockVaultSession(sessionId: string): Promise<void> {
  await request('lock_session', { sessionId })
}

export async function encryptLinesForSession(sessionId: string, lines: string[]): Promise<string[]> {
  const out = new Array<string>(lines.length)
  await processNormalLineChunks(lines, line => Buffer.byteLength(line, 'utf8') > MAX_HELPER_LINE_PAYLOAD_BYTES, async (chunk, indexes) => {
    const res = await request<{ lines: string[] }>('encrypt_lines', { sessionId, lines: chunk })
    res.lines.forEach((line, index) => {
      out[indexes[index]] = line
    })
  }, async (line, index) => {
    out[index] = await encryptChunkedLine(sessionId, line)
  })
  return out
}

export async function decryptLinesForSession(sessionId: string, lines: string[]): Promise<string[]> {
  const out = new Array<string>(lines.length)
  await processNormalLineChunks(lines, isChunkedEncryptedLine, async (chunk, indexes) => {
    const res = await request<{ lines: string[] }>('decrypt_lines', { sessionId, lines: chunk })
    res.lines.forEach((line, index) => {
      out[indexes[index]] = line
    })
  }, async (line, index) => {
    out[index] = await decryptChunkedLine(sessionId, line)
  })
  return out
}

async function processNormalLineChunks(
  lines: string[],
  shouldProcessLargeLine: (line: string) => boolean,
  processChunk: (chunk: string[], indexes: number[]) => Promise<void>,
  processLargeLine: (line: string, index: number) => Promise<void>,
): Promise<void> {
  let current: string[] = []
  let currentIndexes: number[] = []
  let currentBytes = 0

  const flush = async (): Promise<void> => {
    if (current.length === 0) return
    const chunk = current
    const indexes = currentIndexes
    current = []
    currentIndexes = []
    currentBytes = 0
    await processChunk(chunk, indexes)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (shouldProcessLargeLine(line)) {
      await flush()
      await processLargeLine(line, index)
      continue
    }
    if (current.length > 0 && currentBytes + lineBytes > MAX_HELPER_LINE_PAYLOAD_BYTES) {
      await flush()
    }
    current.push(line)
    currentIndexes.push(index)
    currentBytes += lineBytes
  }
  await flush()
}

function isChunkedEncryptedLine(line: string): boolean {
  return line.startsWith(CHUNKED_LINE_PREFIX)
}

async function encryptChunkedLine(sessionId: string, line: string): Promise<string> {
  const data = Buffer.from(line, 'utf8')
  const chunks: string[] = []
  for (let offset = 0; offset < data.length; offset += MAX_HELPER_LINE_PAYLOAD_BYTES) {
    chunks.push(await encryptBytesForSession(sessionId, data.subarray(offset, offset + MAX_HELPER_LINE_PAYLOAD_BYTES)).then(buffer => buffer.toString('base64')))
  }
  const payload = Buffer.from(JSON.stringify({ v: 1, chunks }), 'utf8').toString('base64')
  return `${CHUNKED_LINE_PREFIX}${payload}`
}

async function decryptChunkedLine(sessionId: string, line: string): Promise<string> {
  const encoded = line.slice(CHUNKED_LINE_PREFIX.length)
  const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { v?: number; chunks?: unknown }
  if (envelope.v !== 1 || !Array.isArray(envelope.chunks)) {
    throw new Error('invalid chunked encrypted line')
  }
  const chunks: Buffer[] = []
  for (const chunk of envelope.chunks) {
    if (typeof chunk !== 'string') throw new Error('invalid chunked encrypted line chunk')
    chunks.push(await decryptBytesForSession(sessionId, Buffer.from(chunk, 'base64')))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function encryptBytesForSession(sessionId: string, data: Buffer): Promise<Buffer> {
  const res = await request<{ data: string }>('encrypt_bytes', { sessionId, data: data.toString('base64') })
  return Buffer.from(res.data, 'base64')
}

export async function decryptBytesForSession(sessionId: string, data: Buffer): Promise<Buffer> {
  const res = await request<{ data: string }>('decrypt_bytes', { sessionId, data: data.toString('base64') })
  return Buffer.from(res.data, 'base64')
}

export async function encryptStateForSession(sessionId: string, line: string): Promise<string> {
  const res = await request<{ line: string }>('encrypt_state', { sessionId, line })
  return res.line
}

export async function decryptStateForSession(sessionId: string, line: string): Promise<string> {
  const res = await request<{ line: string }>('decrypt_state', { sessionId, line })
  return res.line
}

export async function stopVaultHelper(): Promise<void> {
  if (!helper || helper.exitCode !== null || helper.killed) return
  try {
    await request('shutdown')
  } catch {
    helper.kill()
  } finally {
    helper = null
    helperReady = false
  }
}
