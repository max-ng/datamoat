import * as fs from 'fs'
import * as path from 'path'
import chokidar from 'chokidar'
import { Source, Session, Message, OffsetState } from './types'
import { ALL_SOURCES, GLOB_PATTERNS, resolveWatchPaths } from './config'
import { loadOffsets, saveOffsets, upsertSession, appendMessages, makeVaultPath, saveAttachment, loadSessions } from './store'
import {
  appendBootstrapCapture,
  clearBootstrapCaptureData,
  disableBootstrapCapture,
  listBootstrapEntries,
  loadBootstrapOffsetState,
  markBootstrapEntryImported,
  readBootstrapCaptureLines,
} from './bootstrap-capture'
import { extractClaudeLine, extractClaudeModel } from './extractors/claude'
import { extractCodexLine, sessionIdFromPath as codexSessionIdFromPath } from './extractors/codex'
import { extractOpenclawLine } from './extractors/openclaw'
import { safeError, updateHealth, writeAuditEvent, writeLog } from './logging'
import { buildSessionUid, sourceAccountFromPath } from './session-identity'

function log(event: string, fields: Record<string, unknown> = {}): void {
  writeLog('info', 'watcher', event, fields)
}

// Per-file in-memory session state (accumulates metadata as we read lines)
interface FileState {
  sessionId: string
  source: Source
  sourceClient?: string
  appVersion: string
  model: string
  modelProvider: string
  cwd: string
  firstTimestamp: string
  lastTimestamp: string
  messageCount: number
  hasThinking: boolean
}

const fileStates = new Map<string, FileState>()
let watchersStarted = false
const activeWatchers: chokidar.FSWatcher[] = []
let offsetsPromise: Promise<OffsetState> | null = null
let processQueue = Promise.resolve()
type WatcherMode = 'vault' | 'bootstrap'
let watcherMode: WatcherMode = 'vault'

function isTransientFileError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: string }).code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

function defaultState(source: Source): FileState {
  return {
    sessionId: '',
    source,
    sourceClient: undefined,
    appVersion: '',
    model: 'unknown',
    modelProvider: source.startsWith('codex') ? 'openai' : source === 'openclaw' ? 'openai/anthropic' : 'anthropic',
    cwd: '',
    firstTimestamp: '',
    lastTimestamp: '',
    messageCount: 0,
    hasThinking: false,
  }
}

async function hydrateState(filePath: string, source: Source, offsets: OffsetState): Promise<FileState> {
  const state = defaultState(source)
  const saved = offsets[filePath]
  const guessedSessionId = source === 'codex-cli' ? codexSessionIdFromPath(filePath) : saved?.sessionId

  if (saved?.sessionId) state.sessionId = saved.sessionId
  if (guessedSessionId && !state.sessionId) state.sessionId = guessedSessionId

  try {
    const sessions = await loadSessions()
    const existing = sessions.find(session =>
      session.originalPath === filePath
      || (!!saved?.sessionId && session.id === saved.sessionId)
      || (!!guessedSessionId && session.id === guessedSessionId)
    )
    if (existing) {
      state.sessionId = existing.id
      state.sourceClient = existing.sourceClient
      state.appVersion = existing.appVersion
      state.model = existing.model
      state.modelProvider = existing.modelProvider
      state.cwd = existing.cwd
      state.firstTimestamp = existing.firstTimestamp
      state.lastTimestamp = existing.lastTimestamp
      state.messageCount = existing.messageCount
      state.hasThinking = existing.hasThinking
    }
  } catch {
    /* non-fatal */
  }

  if (source === 'codex-cli' && (!state.appVersion || state.model === 'unknown' || !state.cwd)) {
    hydrateCodexStateFromHeader(filePath, state)
  }

  return state
}

function hydrateCodexStateFromHeader(filePath: string, state: FileState): void {
  try {
    const stat = fs.statSync(filePath)
    const bytesToRead = Math.min(stat.size, 64 * 1024)
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(bytesToRead)
    fs.readSync(fd, buffer, 0, bytesToRead, 0)
    fs.closeSync(fd)
    const lines = buffer.toString('utf8').split('\n').filter(line => line.trim()).slice(0, 40)
    for (const line of lines) {
      const result = extractCodexLine(line)
      if (!result) continue
      if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
      if (result.sourceClient && !state.sourceClient) state.sourceClient = result.sourceClient
      if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
      if (result.model && state.model === 'unknown') state.model = result.model
      if (result.cwd && !state.cwd) state.cwd = result.cwd
      if (state.sessionId && state.sourceClient && state.appVersion && state.model !== 'unknown' && state.cwd) break
    }
  } catch {
    /* non-fatal */
  }
}

async function loadWatcherOffsets(mode: WatcherMode): Promise<OffsetState> {
  return mode === 'bootstrap' ? loadBootstrapOffsetState() : loadOffsets()
}

export async function startWatchers(mode: WatcherMode = 'vault'): Promise<void> {
  if (watchersStarted && watcherMode === mode) return
  if (watchersStarted && watcherMode !== mode) await stopWatchers()
  watcherMode = mode
  watchersStarted = true
  const offsets = await loadWatcherOffsets(mode)
  offsetsPromise = Promise.resolve(offsets)
  const watchPaths = resolveWatchPaths()
  const readyPromises: Promise<void>[] = []

  for (const [source, basePaths] of Object.entries(watchPaths)) {
    const src = source as Source
    const pattern = GLOB_PATTERNS[src]

    for (const basePath of basePaths) {
      if (!fs.existsSync(basePath)) {
        log('watch_path_missing', { source: src })
        continue
      }

      const watchPath = path.join(basePath, pattern)
      log('watching', { source: src })
      updateHealth(`watcher:${src}`, { watching: true, lastStartedAt: new Date().toISOString() })

      const watcher = chokidar.watch(watchPath, {
        persistent: true,
        ignoreInitial: false,   // process existing files on startup
        usePolling: false,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      })
      activeWatchers.push(watcher)

      readyPromises.push(new Promise<void>(resolve => {
        watcher.once('ready', () => resolve())
      }))

      watcher
        .on('add', filePath => queueProcessFile(filePath, src))
        .on('change', filePath => queueProcessFile(filePath, src))
        .on('error', err => {
          writeLog('error', 'watcher', 'watcher_error', { source: src, error: safeError(err) })
          updateHealth(`watcher:${src}`, { lastErrorAt: new Date().toISOString(), lastError: safeError(err) })
        })
    }
  }

  await Promise.all(readyPromises)
  await processQueue
  log('initial_scan_complete', { mode, watcherCount: activeWatchers.length })
}

export async function stopWatchers(): Promise<void> {
  if (!watchersStarted && activeWatchers.length === 0) return
  watchersStarted = false
  watcherMode = 'vault'
  fileStates.clear()
  offsetsPromise = null
  const watchers = activeWatchers.splice(0)
  await Promise.allSettled(watchers.map(watcher => watcher.close()))
  log('stopped')
  for (const source of ALL_SOURCES) {
    updateHealth(`watcher:${source}`, { watching: false, stoppedAt: new Date().toISOString() })
  }
}

function queueProcessFile(filePath: string, source: Source): void {
  processQueue = processQueue
    .then(async () => {
      const offsets = offsetsPromise ? await offsetsPromise : await loadOffsets()
      await processFile(filePath, source, offsets)
    })
    .catch(err => {
      writeLog('error', 'watcher', 'process_file_failed', {
        source,
        file: path.basename(filePath),
        error: safeError(err),
      })
    })
}

async function processFile(filePath: string, source: Source, offsets: Awaited<ReturnType<typeof loadOffsets>>): Promise<void> {
  try {
    const stat = fs.statSync(filePath)
    const offsetKey = filePath
    const savedOffset = offsets[offsetKey]?.offset ?? 0
    const fileSize = stat.size

    if (fileSize <= savedOffset) return  // nothing new

    // Read only new bytes since last position
    const fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.alloc(fileSize - savedOffset)
    fs.readSync(fd, buffer, 0, buffer.length, savedOffset)
    fs.closeSync(fd)

    const newContent = buffer.toString('utf8')
    const lines = newContent.split('\n').filter(l => l.trim())

    if (lines.length === 0) return

    const state = fileStates.get(filePath) ?? await hydrateState(filePath, source, offsets)
    const newMessages: Message[] = []
    let skippedLines = 0
    let wroteToVault = false

    for (let index = 0; index < lines.length; index += 1) {
      try {
        await processLine(lines[index], filePath, source, state, newMessages, watcherMode !== 'bootstrap')
      } catch (err) {
        skippedLines += 1
        writeLog('warn', 'watcher', 'line_skipped', {
          source,
          file: path.basename(filePath),
          line: index + 1,
          error: safeError(err),
        })
      }
    }

    if (watcherMode === 'bootstrap') {
      await appendBootstrapCapture({
        source,
        originalPath: filePath,
        lines,
        offset: fileSize,
        lastMod: stat.mtimeMs,
        sessionId: state.sessionId || undefined,
      })
      offsets[offsetKey] = {
        offset: fileSize,
        sessionId: state.sessionId,
        source,
        lastMod: stat.mtimeMs,
      }
      fileStates.set(filePath, state)
      log('messages_buffered_pre_setup', {
        source,
        lines: lines.length,
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
      })
      writeAuditEvent('watcher', 'messages_buffered_pre_setup', {
        source,
        lines: lines.length,
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
        file: path.basename(filePath),
      })
      updateHealth(`watcher:${source}`, {
        lastCaptureAt: new Date().toISOString(),
        lastSession: state.sessionId ? state.sessionId.slice(0, 8) : null,
        lastCaptureCount: lines.length,
        lastSkippedLines: skippedLines,
        mode: 'bootstrap',
      })
      if (skippedLines > 0) {
        updateHealth(`watcher:${source}`, {
          lastSkippedAt: new Date().toISOString(),
          lastSkippedFile: path.basename(filePath),
          lastSkippedLines: skippedLines,
        })
      }
      return
    }

    wroteToVault = await persistMessages(filePath, source, state, newMessages, skippedLines)

    if (newMessages.length > 0 && !wroteToVault) {
      writeLog('warn', 'watcher', 'messages_not_saved_missing_session', {
        source,
        file: path.basename(filePath),
      })
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
        lastSkippedReason: 'missing_session_metadata',
      })
      return
    }

    if (skippedLines > 0) {
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
        lastSkippedLines: skippedLines,
      })
    }

    // Advance offsets only after a successful vault write.
    offsets[offsetKey] = {
      offset: fileSize,
      sessionId: state.sessionId,
      source,
      lastMod: stat.mtimeMs,
    }
    await saveOffsets(offsets)
    fileStates.set(filePath, state)
  } catch (err) {
    if (isTransientFileError(err)) {
      writeLog('warn', 'watcher', 'process_file_skipped', {
        source,
        file: path.basename(filePath),
        error: safeError(err),
      })
      updateHealth(`watcher:${source}`, {
        lastSkippedAt: new Date().toISOString(),
        lastSkippedFile: path.basename(filePath),
      })
      return
    }
    writeLog('error', 'watcher', 'process_file_error', {
      source,
      file: path.basename(filePath),
      error: safeError(err),
    })
    updateHealth(`watcher:${source}`, {
      lastErrorAt: new Date().toISOString(),
      lastError: safeError(err),
    })
  }
}

async function persistMessages(
  filePath: string,
  source: Source,
  state: FileState,
  newMessages: Message[],
  skippedLines: number,
): Promise<boolean> {
  if (!state.sessionId || newMessages.length === 0) return false
  const sourceAccount = sourceAccountFromPath(source, filePath)
  const uid = buildSessionUid({
    source,
    sourceAccount,
    sessionId: state.sessionId,
    originalPath: filePath,
  })
  const session: Session = {
    uid,
    id: state.sessionId,
    source,
    sourceClient: state.sourceClient,
    sourceAccount,
    appVersion: state.appVersion,
    model: state.model,
    modelProvider: state.modelProvider,
    firstTimestamp: state.firstTimestamp,
    lastTimestamp: state.lastTimestamp,
    cwd: state.cwd,
    messageCount: state.messageCount,
    hasThinking: state.hasThinking,
    vaultPath: makeVaultPath(source, uid),
    originalPath: filePath,
  }
  await appendMessages(session, newMessages)
  await upsertSession(session)
  log('messages_saved', {
    source,
    count: newMessages.length,
    session: state.sessionId.slice(0, 8),
  })
  writeAuditEvent('watcher', 'messages_saved', {
    source,
    count: newMessages.length,
    session: state.sessionId.slice(0, 8),
    file: path.basename(filePath),
  })
  updateHealth(`watcher:${source}`, {
    lastCaptureAt: new Date().toISOString(),
    lastSession: state.sessionId.slice(0, 8),
    lastCaptureCount: newMessages.length,
    lastSkippedLines: skippedLines,
    mode: 'vault',
  })
  return true
}

async function processLine(
  line: string,
  filePath: string,
  source: Source,
  state: FileState,
  out: Message[],
  captureAttachments: boolean,
): Promise<void> {
  if (source === 'claude-cli' || source === 'claude-app') {
    const modelInfo = extractClaudeModel(line)
    if (modelInfo?.model) { state.model = modelInfo.model }
    if (modelInfo?.cwd && !state.cwd) { state.cwd = modelInfo.cwd }
    if (modelInfo?.appVersion && !state.appVersion) { state.appVersion = modelInfo.appVersion }

    const result = extractClaudeLine(line)
    if (result) {
      if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
      if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
      if (captureAttachments) {
        await attachRawImages(source, filePath, state, result.message, result.rawImages)
      }
      updateStateFromMessage(state, result.message)
      out.push(result.message)
    }
    return
  }

  if (source === 'codex-cli') {
    const result = extractCodexLine(line)
    if (!result) return
    if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
    if (result.sourceClient && !state.sourceClient) state.sourceClient = result.sourceClient
    if (result.appVersion && !state.appVersion) state.appVersion = result.appVersion
    if (result.model && state.model === 'unknown') state.model = result.model
    if (result.cwd && !state.cwd) state.cwd = result.cwd
    if (result.message) {
      if (captureAttachments) {
        await attachRawImages(source, filePath, state, result.message, result.rawImages)
      }
      updateStateFromMessage(state, result.message)
      out.push(result.message)
    }
    return
  }

  if (source === 'openclaw') {
    const result = extractOpenclawLine(line)
    if (!result) return
    if (result.sessionId && !state.sessionId) state.sessionId = result.sessionId
    if (result.model && state.model === 'unknown') state.model = result.model
    if (result.modelProvider) state.modelProvider = result.modelProvider
    if (result.cwd && !state.cwd) state.cwd = result.cwd
    if (result.message) {
      updateStateFromMessage(state, result.message)
      out.push(result.message)
    }
  }
}

async function attachRawImages(
  source: Source,
  filePath: string,
  state: FileState,
  message: Message,
  rawImages: Array<{
    blockIndex: number
    innerIndex?: number
    base64Data: string
    mediaType: string
    attachmentName?: string
  }>,
): Promise<void> {
  for (const img of rawImages) {
    try {
      const hash = await saveAttachment(img.base64Data, img.mediaType)
      if (img.innerIndex === undefined) {
        const block = message.content[img.blockIndex]
        if (block?.type === 'image' || block?.type === 'file') {
          block.attachmentId = hash
          if (img.attachmentName && block.type === 'file') {
            block.attachmentName = img.attachmentName
          }
        }
        continue
      }

      const outer = message.content[img.blockIndex]
      if (outer?.type === 'tool_result') {
        if (!outer.attachmentIds) outer.attachmentIds = []
        outer.attachmentIds.push(hash)
      }
    } catch (error) {
      writeLog('warn', 'watcher', 'attachment_save_failed', {
        source,
        file: path.basename(filePath),
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
        messageId: message.id,
        blockIndex: img.blockIndex,
        innerIndex: img.innerIndex,
        mediaType: img.mediaType,
        attachmentName: img.attachmentName,
        error: safeError(error),
      })
      writeAuditEvent('watcher', 'attachment_save_failed', {
        source,
        file: path.basename(filePath),
        session: state.sessionId ? state.sessionId.slice(0, 8) : null,
        blockIndex: img.blockIndex,
        innerIndex: img.innerIndex,
        mediaType: img.mediaType,
        attachmentName: img.attachmentName,
        error: safeError(error),
      })
      updateHealth(`watcher:${source}`, {
        lastAttachmentErrorAt: new Date().toISOString(),
        lastAttachmentErrorFile: path.basename(filePath),
        lastAttachmentErrorSession: state.sessionId ? state.sessionId.slice(0, 8) : null,
        lastAttachmentErrorBlock: img.blockIndex,
        lastAttachmentErrorInnerBlock: img.innerIndex ?? null,
        lastAttachmentErrorMediaType: img.mediaType,
        lastAttachmentError: safeError(error),
      })
    }
  }
}

function updateStateFromMessage(state: FileState, msg: Message): void {
  if (!state.firstTimestamp || msg.timestamp < state.firstTimestamp) {
    state.firstTimestamp = msg.timestamp
  }
  if (!state.lastTimestamp || msg.timestamp > state.lastTimestamp) {
    state.lastTimestamp = msg.timestamp
  }
  state.messageCount++
  if (msg.hasThinking) state.hasThinking = true
}

export async function importBootstrapCaptureIntoVault(): Promise<{ importedFiles: number; importedMessages: number; remainingFiles: number }> {
  const entries = await listBootstrapEntries()
  if (entries.length === 0) {
    await clearBootstrapCaptureData()
    disableBootstrapCapture()
    return { importedFiles: 0, importedMessages: 0, remainingFiles: 0 }
  }

  const offsets = await loadOffsets()
  let importedFiles = 0
  let importedMessages = 0

  for (const entry of entries) {
    try {
      if (!fs.existsSync(entry.spoolFile)) {
        offsets[entry.originalPath] = {
          offset: entry.offset,
          source: entry.source,
          lastMod: entry.lastMod,
          sessionId: entry.sessionId ?? '',
        }
        await saveOffsets(offsets)
        await markBootstrapEntryImported(entry.originalPath)
        importedFiles += 1
        continue
      }

      const lines = await readBootstrapCaptureLines(entry.spoolFile)
      const state = fileStates.get(entry.originalPath) ?? await hydrateState(entry.originalPath, entry.source, offsets)
      const newMessages: Message[] = []
      let skippedLines = 0

      for (let index = 0; index < lines.length; index += 1) {
        try {
          await processLine(lines[index], entry.originalPath, entry.source, state, newMessages, true)
        } catch (err) {
          skippedLines += 1
          writeLog('warn', 'watcher', 'bootstrap_line_skipped', {
            source: entry.source,
            file: path.basename(entry.originalPath),
            line: index + 1,
            error: safeError(err),
          })
        }
      }

      const wroteToVault = await persistMessages(entry.originalPath, entry.source, state, newMessages, skippedLines)
      if (newMessages.length > 0 && !wroteToVault) {
        writeLog('warn', 'watcher', 'bootstrap_messages_missing_session', {
          source: entry.source,
          file: path.basename(entry.originalPath),
        })
      }

      offsets[entry.originalPath] = {
        offset: entry.offset,
        source: entry.source,
        lastMod: entry.lastMod,
        sessionId: state.sessionId || entry.sessionId || '',
      }
      await saveOffsets(offsets)
      fileStates.set(entry.originalPath, state)
      await markBootstrapEntryImported(entry.originalPath)
      importedFiles += 1
      importedMessages += newMessages.length
    } catch (err) {
      writeLog('error', 'watcher', 'bootstrap_import_failed', {
        source: entry.source,
        file: path.basename(entry.originalPath),
        error: safeError(err),
      })
      updateHealth(`watcher:${entry.source}`, {
        lastErrorAt: new Date().toISOString(),
        lastError: safeError(err),
      })
    }
  }

  const remainingFiles = (await listBootstrapEntries()).length
  if (remainingFiles === 0) {
    await clearBootstrapCaptureData()
    disableBootstrapCapture()
  }
  writeAuditEvent('watcher', 'bootstrap_import_completed', {
    importedFiles,
    importedMessages,
    remainingFiles,
  })
  return { importedFiles, importedMessages, remainingFiles }
}
