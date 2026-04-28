import * as fs from 'fs'
import * as path from 'path'
import { ContentBlock, Message, TokenUsage } from '../types'
import type { RawImageData } from './claude'

// Cursor writes readable agent transcripts at:
// ~/.cursor/projects/<project>/agent-transcripts/<conversation-id>/<conversation-id>.jsonl
// Observed records are Anthropic-style message blocks:
// { "role": "user", "message": { "content": [{ "type": "text", "text": "..." }] } }

const CURSOR_KNOWN_FIELDS = new Set([
  'type',
  'id',
  'sessionId',
  'session_id',
  'conversationId',
  'composerId',
  'chatId',
  'role',
  'message',
  'content',
  'text',
  'timestamp',
  'createdAt',
  'updatedAt',
  'model',
  'usage',
  'cwd',
  'sourceClient',
  'appVersion',
  'cursorVersion',
])

const LOCAL_IMAGE_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const MAX_LOCAL_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_LOCAL_IMAGE_SCAN_CHARS = 64 * 1024
const MAX_LOCAL_IMAGE_CANDIDATE_CHARS = 4096
const MAX_LOCAL_IMAGE_CANDIDATES = 10
const CAPTURE_LOCAL_FILE_ATTACHMENTS = process.env.DATAMOAT_CAPTURE_LOCAL_FILE_ATTACHMENTS === '1'

export function extractCursorLine(raw: string, filePath?: string): {
  sessionId?: string
  appVersion?: string
  model?: string
  cwd?: string
  sourceClient?: string
  message?: Message
  rawImages: RawImageData[]
} | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) } catch { return null }

  const msg = recordValue(obj.message)
  const role = normalizeCursorRole(firstString(obj.role, msg?.role))
  const rawContent = msg?.content ?? msg?.text ?? obj.content ?? obj.text
  const sessionId = firstString(
    obj.sessionId,
    obj.session_id,
    obj.conversationId,
    obj.composerId,
    obj.chatId,
  ) || (filePath ? sessionIdFromPath(filePath) : undefined)
  const appVersion = firstString(obj.appVersion, obj.cursorVersion, msg?.appVersion, msg?.cursorVersion)
  const model = firstString(obj.model, msg?.model)
  const cwd = firstString(obj.cwd, msg?.cwd) || (filePath ? projectRootFromPath(filePath) : undefined)
  const sourceClient = firstString(obj.sourceClient) || 'Cursor'

  if (!role && rawContent === undefined) {
    return {
      sessionId,
      appVersion,
      model,
      cwd,
      sourceClient,
      rawImages: [],
    }
  }

  const { blocks: content, images: rawImages } = parseCursorContent(rawContent, filePath)
  const timestamp = firstTimestamp(
    obj.timestamp,
    msg?.timestamp,
    obj.createdAt,
    msg?.createdAt,
    timestampFromCursorContent(rawContent),
    filePath ? fileMtimeTimestamp(filePath) : undefined,
  ) || new Date().toISOString()
  const usage = parseCursorUsage(recordValue(obj.usage) ?? recordValue(msg?.usage))
  const unknownAttrs = cursorUnknownAttrs(obj)

  return {
    sessionId,
    appVersion,
    model,
    cwd,
    sourceClient,
    rawImages,
    message: {
      id: firstString(obj.id, msg?.id) || crypto.randomUUID(),
      role: role ?? 'system',
      timestamp,
      content,
      usage,
      hasThinking: content.some(block => block.type === 'thinking'),
      appVersion: appVersion || undefined,
      sourceEventType: cursorEventName(obj, role),
      model: model || undefined,
      unknownAttrs,
    },
  }
}

function parseCursorContent(rawContent: unknown, filePath?: string): { blocks: ContentBlock[]; images: RawImageData[] } {
  const blocks: ContentBlock[] = []
  const images: RawImageData[] = []

  function addText(text: string): void {
    blocks.push({ type: 'text', text })
    for (const img of localImagesFromText(text, filePath)) {
      const blockIndex = blocks.length
      blocks.push({
        type: 'image',
        mediaType: img.mediaType,
        attachmentName: img.attachmentName,
      })
      images.push({ ...img, blockIndex })
    }
  }

  function addBlock(block: unknown): void {
    if (typeof block === 'string') {
      addText(block)
      return
    }
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      blocks.push({ type: 'other', content: block })
      return
    }

    const b = block as Record<string, unknown>
    const type = typeof b.type === 'string' ? b.type : ''

    if (type === 'text' || type === 'input_text' || type === 'output_text' || (!type && typeof b.text === 'string')) {
      addText(firstString(b.text, b.content) || '')
      return
    }

    if (type === 'thinking' || type === 'reasoning') {
      blocks.push({ type: 'thinking', thinking: parseThinkingText(b.thinking ?? b.text ?? b.content ?? b.summary) })
      return
    }

    if (type === 'tool_use' || type === 'toolCall' || type === 'function_call') {
      const input = b.input ?? b.arguments ?? b.args
      blocks.push({
        type: 'tool_use',
        name: firstString(b.name, b.toolName, b.functionName) || 'tool',
        input: parseMaybeJson(input),
        text: typeof input === 'string' ? input : stringifyUnknown(input),
      })
      return
    }

    if (type === 'tool_result' || type === 'toolResult' || type === 'function_call_output') {
      const content = b.content ?? b.output ?? b.result
      const text = stringifyUnknown(content)
      blocks.push({
        type: 'tool_result',
        name: firstString(b.name, b.toolName, b.tool_use_id, b.toolUseId, b.call_id) || 'tool-result',
        content,
        text,
      })
      for (const img of localImagesFromText(text, filePath)) {
        images.push({ ...img, blockIndex: blocks.length - 1, innerIndex: 0 })
      }
      return
    }

    if (type === 'image' || type === 'input_image') {
      const data = parseInlineImageData(b.image_url ?? b.url ?? b.data ?? b.source)
      const blockIndex = blocks.length
      if (data) {
        images.push({
          blockIndex,
          base64Data: data.base64Data,
          mediaType: data.mediaType,
          blockType: 'image',
          attachmentName: firstString(b.name, b.filename),
        })
      }
      blocks.push({
        type: 'image',
        mediaType: data?.mediaType ?? firstString(b.mediaType, b.media_type) ?? 'image/png',
        attachmentName: firstString(b.name, b.filename),
      })
      return
    }

    if (type === 'file') {
      blocks.push({
        type: 'file',
        mediaType: firstString(b.mediaType, b.media_type),
        attachmentName: firstString(b.name, b.filename),
        content: b.content ?? b.path,
      })
      return
    }

    blocks.push({ type: 'other', content: b })
  }

  if (Array.isArray(rawContent)) {
    for (const block of rawContent) addBlock(block)
  } else if (rawContent !== undefined) {
    addBlock(rawContent)
  }

  return { blocks, images }
}

function normalizeCursorRole(role: string | undefined): Message['role'] | null {
  if (role === 'user' || role === 'human') return 'user'
  if (role === 'assistant' || role === 'ai') return 'assistant'
  if (role === 'system' || role === 'developer') return 'system'
  if (role === 'tool' || role === 'toolResult' || role === 'function') return 'tool'
  return null
}

function cursorEventName(obj: Record<string, unknown>, role: Message['role'] | null): string {
  const rawType = typeof obj.type === 'string' ? obj.type : ''
  if (rawType) return `cursor.${rawType}`
  return role ? `cursor.${role}` : 'cursor.message'
}

function cursorUnknownAttrs(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {}
  let any = false
  for (const [key, value] of Object.entries(obj)) {
    if (CURSOR_KNOWN_FIELDS.has(key)) continue
    extras[key] = value
    any = true
  }
  return any ? extras : undefined
}

function parseCursorUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  const usage: TokenUsage = {
    inputTokens: numberValue(raw.inputTokens, raw.input_tokens, raw.promptTokens, raw.prompt_tokens, raw.input),
    outputTokens: numberValue(raw.outputTokens, raw.output_tokens, raw.completionTokens, raw.completion_tokens, raw.output),
    cacheReadTokens: numberValue(raw.cacheReadTokens, raw.cache_read_tokens, raw.cacheRead),
    cacheWriteTokens: numberValue(raw.cacheWriteTokens, raw.cache_write_tokens, raw.cacheWrite),
    totalTokens: numberValue(raw.totalTokens, raw.total_tokens, raw.total),
    cost: numberValue(raw.cost, raw.totalCost, raw.total_cost),
  }
  return Object.values(usage).some(value => value !== undefined) ? usage : undefined
}

function parseThinkingText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return stringifyUnknown(value)
  return value.flatMap(item => {
    if (typeof item === 'string') return [item]
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    return firstString(record.text, record.thinking, record.summary) ? [firstString(record.text, record.thinking, record.summary) as string] : []
  }).join('\n\n').trim()
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (!value.trim()) return ''
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function firstTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = normalizeTimestamp(value)
    if (parsed) return parsed
  }
  return undefined
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(ms)
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const raw = value.trim()
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const parsed = Number(raw)
    return normalizeTimestamp(parsed)
  }
  const date = new Date(raw)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function timestampFromCursorContent(rawContent: unknown): string | undefined {
  const texts: string[] = []
  collectText(rawContent, texts, 12)
  for (const text of texts) {
    const match = text.match(/<timestamp>([^<]+)<\/timestamp>/i)
    if (!match) continue
    const parsed = normalizeTimestamp(match[1])
    if (parsed) return parsed
  }
  return undefined
}

function collectText(value: unknown, out: string[], limit: number): void {
  if (out.length >= limit) return
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, limit)
    return
  }
  const record = recordValue(value)
  if (!record) return
  collectText(record.text ?? record.content, out, limit)
}

function fileMtimeTimestamp(filePath: string): string | undefined {
  try {
    return fs.statSync(filePath).mtime.toISOString()
  } catch {
    return undefined
  }
}

function parseInlineImageData(value: unknown): { mediaType: string; base64Data: string } | null {
  if (typeof value === 'string') {
    const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/)
    return match ? { mediaType: match[1], base64Data: match[2] } : null
  }
  const record = recordValue(value)
  if (!record || record.type !== 'base64' || typeof record.data !== 'string') return null
  return {
    mediaType: firstString(record.mediaType, record.media_type) || 'image/png',
    base64Data: record.data,
  }
}

function localImagesFromText(text: string, filePath?: string): RawImageData[] {
  if (!text) return []
  if (text.length > MAX_LOCAL_IMAGE_SCAN_CHARS * 2) return []
  const out: RawImageData[] = []
  const seen = new Set<string>()
  const cursorAssetsDir = filePath ? cursorAssetsDirFromPath(filePath) : undefined

  for (const candidate of localImagePathCandidates(scanWindowForLocalImages(text))) {
    if (seen.size >= MAX_LOCAL_IMAGE_CANDIDATES) break
    const imagePath = normalizeLocalImagePath(candidate)
    if (!imagePath || seen.has(imagePath)) continue
    const cursorOwnedAsset = cursorAssetsDir ? isInsideDir(imagePath, cursorAssetsDir) : false
    if (!cursorOwnedAsset && !CAPTURE_LOCAL_FILE_ATTACHMENTS) continue
    seen.add(imagePath)

    const ext = path.extname(imagePath).toLowerCase()
    const mediaType = LOCAL_IMAGE_MEDIA[ext]
    if (!mediaType) continue

    try {
      const stat = fs.statSync(imagePath)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOCAL_IMAGE_BYTES) continue
      out.push({
        blockIndex: 0,
        base64Data: fs.readFileSync(imagePath).toString('base64'),
        mediaType,
        blockType: 'image',
        attachmentName: path.basename(imagePath),
      })
    } catch {
      // Best effort only. The raw transcript still contains the original path.
    }
  }

  return out
}

function scanWindowForLocalImages(text: string): string {
  if (text.length <= MAX_LOCAL_IMAGE_SCAN_CHARS * 2) return text
  return `${text.slice(0, MAX_LOCAL_IMAGE_SCAN_CHARS)}\n${text.slice(-MAX_LOCAL_IMAGE_SCAN_CHARS)}`
}

function localImagePathCandidates(text: string): string[] {
  const candidates: string[] = []
  const ext = '(?:png|jpe?g|gif|webp)'
  const patterns = [
    new RegExp(`\\[[^\\]\\n]{0,200}]\\((file:\\/\\/\\/[^)\\n]{1,${MAX_LOCAL_IMAGE_CANDIDATE_CHARS}}\\.${ext}|\\/[^)\\n]{1,${MAX_LOCAL_IMAGE_CANDIDATE_CHARS}}\\.${ext})\\)`, 'gi'),
    new RegExp(`[\\\`"'](file:\\/\\/\\/[^"'\\\`\\n]{1,${MAX_LOCAL_IMAGE_CANDIDATE_CHARS}}\\.${ext}|\\/[^"'\\\`\\n]{1,${MAX_LOCAL_IMAGE_CANDIDATE_CHARS}}\\.${ext})[\\\`"']`, 'gi'),
    new RegExp(`(?:^|[\\s:])(\\/[^\\s"'\\\`<>)\\]]{1,${MAX_LOCAL_IMAGE_CANDIDATE_CHARS}}\\.${ext})(?=$|[\\s"'\\\`<>)\\]])`, 'gi'),
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      candidates.push(match[1])
    }
  }
  return candidates
}

function normalizeLocalImagePath(candidate: string): string | null {
  let value = candidate.trim()
  if (value.startsWith('file://')) {
    try {
      value = decodeURI(new URL(value).pathname)
    } catch {
      value = value.slice('file://'.length)
    }
  } else {
    try { value = decodeURI(value) } catch {}
  }
  value = value.replace(/\\ /g, ' ')
  value = value.replace(/[.,;:!?]+$/g, '')
  if (!path.isAbsolute(value)) return null
  return path.normalize(value)
}

function cursorAssetsDirFromPath(filePath: string): string | undefined {
  const root = projectRootFromPath(filePath)
  return root ? path.join(root, 'assets') : undefined
}

function isInsideDir(filePath: string, dirPath: string): boolean {
  const rel = path.relative(dirPath, filePath)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

export function projectRootFromPath(filePath: string): string | undefined {
  const normalized = path.resolve(filePath)
  const marker = `${path.sep}.cursor${path.sep}projects${path.sep}`
  const markerIdx = normalized.indexOf(marker)
  if (markerIdx === -1) return undefined
  const start = markerIdx + marker.length
  const project = normalized.slice(start).split(path.sep).filter(Boolean)[0]
  return project ? normalized.slice(0, start + project.length) : undefined
}

export function sessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, '.jsonl')
  if (base) return base
  return path.basename(path.dirname(filePath))
}
