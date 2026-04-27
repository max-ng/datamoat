import * as fs from 'fs'
import * as path from 'path'
import { Message, ContentBlock, TokenUsage } from '../types'
import type { RawImageData } from './claude'

// Codex top-level keys the extractor binds to typed columns. Anything else
// is preserved as unknownAttrs so the UI can still render it.
const CODEX_KNOWN_FIELDS = new Set(['type', 'timestamp', 'payload'])

function codexUnknownAttrs(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {}
  let any = false
  for (const [key, value] of Object.entries(obj)) {
    if (CODEX_KNOWN_FIELDS.has(key)) continue
    extras[key] = value
    any = true
  }
  return any ? extras : undefined
}

function codexEventName(topType: string, payload: Record<string, unknown> | undefined): string {
  const sub = typeof payload?.type === 'string' ? (payload!.type as string) : ''
  return sub ? `${topType}.${sub}` : topType
}

// Parses one line from ~/.codex/sessions/YYYY/MM/DD/*.jsonl
// Event types: session_meta, turn_context, response_item, event_msg, compacted
export function extractCodexLine(raw: string): {
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

  const type = obj.type as string
  const timestamp = (obj.timestamp as string) || new Date().toISOString()
  const payload = obj.payload as Record<string, unknown> | undefined
  const eventName = codexEventName(type, payload)
  const unknownAttrs = codexUnknownAttrs(obj)

  function decorate(msg: Message): Message {
    msg.sourceEventType = eventName
    if (unknownAttrs) msg.unknownAttrs = unknownAttrs
    return msg
  }

  // Session metadata — gives us version and session ID
  if (type === 'session_meta' && payload) {
    return {
      sessionId: payload.id as string,
      appVersion: payload.cli_version as string,
      cwd: payload.cwd as string,
      sourceClient: codexSourceClient(payload),
      rawImages: [],
    }
  }

  // Turn context — gives us the model
  if (type === 'turn_context' && payload) {
    return {
      model: payload.model as string,
      cwd: payload.cwd as string,
      rawImages: [],
    }
  }

  // Response items — actual messages
  if (type === 'response_item' && payload) {
    const role = payload.role as string
    const ptype = payload.type as string

    if (ptype === 'message' && isMessageRole(role)) {
      const rawContent = payload.content as unknown[]
      const { blocks: content, images: rawImages } = parseCodexContent(rawContent)

      return {
        rawImages,
        message: decorate({
          id: crypto.randomUUID(),
          role: normalizeRole(role),
          timestamp,
          content,
          hasThinking: content.some(block => block.type === 'thinking'),
        }),
      }
    }

    if (ptype === 'reasoning') {
      const thinking = parseReasoningSummary(payload.summary)
      return {
        rawImages: [],
        message: decorate({
          id: crypto.randomUUID(),
          role: 'assistant',
          timestamp,
          content: [{ type: 'thinking', thinking }],
          hasThinking: true,
        }),
      }
    }

    if (ptype === 'function_call') {
      const rawArgs = (payload.arguments as string) || ''
      const parsedArgs = parseMaybeJson(rawArgs)
      return {
        rawImages: [],
        message: decorate({
          id: crypto.randomUUID(),
          role: 'assistant',
          timestamp,
          content: [{
            type: 'tool_use',
            name: (payload.name as string) || 'tool',
            input: parsedArgs,
            text: rawArgs,
          }],
          hasThinking: false,
        }),
      }
    }

    if (ptype === 'custom_tool_call') {
      const rawInput = (payload.input as string) || ''
      return {
        rawImages: [],
        message: decorate({
          id: crypto.randomUUID(),
          role: 'assistant',
          timestamp,
          content: [{
            type: 'tool_use',
            name: (payload.name as string) || 'custom_tool',
            input: parseMaybeJson(rawInput),
            text: rawInput,
          }],
          hasThinking: false,
        }),
      }
    }

    if (ptype === 'function_call_output') {
      const output = payload.output
      const text = stringifyUnknown(output)
      return {
        rawImages: localImagesFromText(text, 0, 0),
        message: decorate({
          id: crypto.randomUUID(),
          role: 'tool',
          timestamp,
          content: [{
            type: 'tool_result',
            name: (payload.call_id as string) || 'tool-output',
            content: output,
            text,
          }],
          hasThinking: false,
        }),
      }
    }

    if (ptype === 'custom_tool_call_output') {
      const output = payload.output
      const text = stringifyUnknown(output)
      return {
        rawImages: localImagesFromText(text, 0, 0),
        message: decorate({
          id: crypto.randomUUID(),
          role: 'tool',
          timestamp,
          content: [{
            type: 'tool_result',
            name: (payload.call_id as string) || 'custom-tool-output',
            content: output,
            text,
          }],
          hasThinking: false,
        }),
      }
    }

    if (ptype === 'web_search_call') {
      const action = payload.action
      const input = {
        status: payload.status,
        ...(typeof action === 'object' && action ? action as Record<string, unknown> : {}),
      }
      const text = typeof (action as Record<string, unknown> | undefined)?.query === 'string'
        ? String((action as Record<string, unknown>).query)
        : stringifyUnknown(input)
      return {
        rawImages: [],
        message: decorate({
          id: crypto.randomUUID(),
          role: 'assistant',
          timestamp,
          content: [{
            type: 'tool_use',
            name: 'web_search',
            input,
            text,
          }],
          hasThinking: false,
        }),
      }
    }
  }

  return null
}

function codexSourceClient(payload: Record<string, unknown>): string | undefined {
  const originator = typeof payload.originator === 'string' ? payload.originator : ''
  const source = typeof payload.source === 'string' ? payload.source : ''

  if (originator === 'Codex Desktop') return 'Codex Desktop'
  if (originator === 'codex_exec') return 'Codex Exec'
  if (originator === 'codex-tui' || originator === 'codex_cli_rs') return 'Codex CLI'

  if (source === 'vscode') return 'Codex Desktop'
  if (source === 'exec') return 'Codex Exec'
  if (source === 'cli') return 'Codex CLI'

  if (originator || source) return 'Codex'
  return undefined
}

function parseCodexContent(rawContent: unknown[]): { blocks: ContentBlock[]; images: RawImageData[] } {
  if (!Array.isArray(rawContent)) return { blocks: [], images: [] }
  const images: RawImageData[] = []
  const blocks: ContentBlock[] = []

  for (const block of rawContent) {
    if (typeof block !== 'object' || !block) continue
    const b = block as Record<string, unknown>
    if (b.type === 'input_text' || b.type === 'output_text') {
      const text = b.text as string || ''
      blocks.push({ type: 'text' as const, text })
      const linkedImages = localImagesFromText(text, 0)
      for (const img of linkedImages) {
        const blockIndex = blocks.length
        blocks.push({
          type: 'image',
          mediaType: img.mediaType,
          attachmentName: img.attachmentName,
        })
        images.push({ ...img, blockIndex })
      }
      continue
    }
    if (b.type === 'input_image') {
      const data = parseInlineImageData(b.image_url)
      const blockIndex = blocks.length
      if (!data) {
        blocks.push({ type: 'image' as const, mediaType: 'image/png' })
        continue
      }
      images.push({
        blockIndex,
        base64Data: data.base64Data,
        mediaType: data.mediaType,
        blockType: 'image',
      })
      blocks.push({ type: 'image' as const, mediaType: data.mediaType })
      continue
    }
    if (b.type === 'reasoning') {
      const thinking = parseReasoningSummary(b.summary)
      blocks.push({ type: 'thinking' as const, thinking })
      continue
    }
  }
  return { blocks, images }
}

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

function localImagesFromText(text: string, blockIndex: number, innerIndex?: number): RawImageData[] {
  // Do not read arbitrary local paths mentioned inside transcripts by default.
  // On macOS, reading Downloads/Desktop/Documents can trigger privacy prompts
  // that make a signed app look unsafe. The transcript text is still captured;
  // inline/base64 images are still captured by parseInlineImageData().
  if (!CAPTURE_LOCAL_FILE_ATTACHMENTS) return []
  if (!text) return []
  if (text.length > MAX_LOCAL_IMAGE_SCAN_CHARS) return []
  const out: RawImageData[] = []
  const seen = new Set<string>()

  for (const candidate of localImagePathCandidates(scanWindowForLocalImages(text))) {
    if (seen.size >= MAX_LOCAL_IMAGE_CANDIDATES) break
    const filePath = normalizeLocalImagePath(candidate)
    if (!filePath || seen.has(filePath)) continue
    seen.add(filePath)

    const ext = path.extname(filePath).toLowerCase()
    const mediaType = LOCAL_IMAGE_MEDIA[ext]
    if (!mediaType) continue

    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOCAL_IMAGE_BYTES) continue
      const base64Data = fs.readFileSync(filePath).toString('base64')
      out.push({
        blockIndex,
        innerIndex,
        base64Data,
        mediaType,
        blockType: 'image',
        attachmentName: path.basename(filePath),
      })
    } catch {
      // Local file links are best-effort. The transcript is still captured.
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

function parseInlineImageData(value: unknown): { mediaType: string; base64Data: string } | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=]+)$/)
  if (!match) return null
  return { mediaType: match[1], base64Data: match[2] }
}

function isMessageRole(role: string): boolean {
  return role === 'user' || role === 'assistant' || role === 'system' || role === 'developer'
}

function normalizeRole(role: string): Message['role'] {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'system'
}

function parseReasoningSummary(rawSummary: unknown): string {
  if (!Array.isArray(rawSummary)) return ''
  const parts = rawSummary.flatMap(item => {
    if (typeof item !== 'object' || !item) return []
    const record = item as Record<string, unknown>
    if (record.type === 'summary_text' && typeof record.text === 'string') {
      return [record.text]
    }
    return []
  })
  return parts.join('\n\n').trim()
}

function parseMaybeJson(raw: string): unknown {
  if (!raw.trim()) return ''
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function sessionIdFromPath(filePath: string): string {
  // Format: rollout-2026-04-18T13-25-09-019d9f43-b9b0-79a3-b80e-98b192cdd81c.jsonl
  const base = path.basename(filePath, '.jsonl')
  const parts = base.split('-')
  // UUID is last 5 parts (8-4-4-4-12)
  return parts.slice(-5).join('-')
}
