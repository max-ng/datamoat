import * as path from 'path'
import { Message, ContentBlock, TokenUsage } from '../types'
import type { RawImageData } from './claude'

// Parses one line from ~/.codex/sessions/YYYY/MM/DD/*.jsonl
// Event types: session_meta, turn_context, response_item, event_msg
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
        message: {
          id: crypto.randomUUID(),
          role: normalizeRole(role),
          timestamp,
          content,
          hasThinking: content.some(block => block.type === 'thinking'),
        },
      }
    }

    if (ptype === 'reasoning') {
      const thinking = parseReasoningSummary(payload.summary)
      if (!thinking) return null
      return {
        rawImages: [],
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          timestamp,
          content: [{ type: 'thinking', thinking }],
          hasThinking: true,
        },
      }
    }

    if (ptype === 'function_call') {
      const rawArgs = (payload.arguments as string) || ''
      const parsedArgs = parseMaybeJson(rawArgs)
      return {
        rawImages: [],
        message: {
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
        },
      }
    }

    if (ptype === 'custom_tool_call') {
      const rawInput = (payload.input as string) || ''
      return {
        rawImages: [],
        message: {
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
        },
      }
    }

    if (ptype === 'function_call_output') {
      const output = payload.output
      return {
        rawImages: [],
        message: {
          id: crypto.randomUUID(),
          role: 'tool',
          timestamp,
          content: [{
            type: 'tool_result',
            name: (payload.call_id as string) || 'tool-output',
            content: output,
            text: stringifyUnknown(output),
          }],
          hasThinking: false,
        },
      }
    }

    if (ptype === 'custom_tool_call_output') {
      const output = payload.output
      return {
        rawImages: [],
        message: {
          id: crypto.randomUUID(),
          role: 'tool',
          timestamp,
          content: [{
            type: 'tool_result',
            name: (payload.call_id as string) || 'custom-tool-output',
            content: output,
            text: stringifyUnknown(output),
          }],
          hasThinking: false,
        },
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
        message: {
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
        },
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
  const blocks = rawContent.flatMap<ContentBlock>((block, index) => {
    if (typeof block !== 'object' || !block) return []
    const b = block as Record<string, unknown>
    if (b.type === 'input_text' || b.type === 'output_text') {
      return [{ type: 'text' as const, text: b.text as string || '' }]
    }
    if (b.type === 'input_image') {
      const data = parseInlineImageData(b.image_url)
      if (!data) return [{ type: 'image' as const, mediaType: 'image/png' }]
      images.push({
        blockIndex: index,
        base64Data: data.base64Data,
        mediaType: data.mediaType,
        blockType: 'image',
      })
      return [{ type: 'image' as const, mediaType: data.mediaType }]
    }
    if (b.type === 'reasoning') {
      const thinking = parseReasoningSummary(b.summary)
      return thinking ? [{ type: 'thinking' as const, thinking }] : []
    }
    return []
  })
  return { blocks, images }
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
