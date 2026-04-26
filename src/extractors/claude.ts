import * as path from 'path'
import { Message, ContentBlock, TokenUsage } from '../types'

export interface RawImageData {
  blockIndex: number   // outer content array index (always)
  innerIndex?: number  // if set: nested inside tool_result at this inner position
  base64Data: string
  mediaType: string
  blockType?: 'image' | 'file'
  attachmentName?: string
}

// Parses one line from ~/.claude/projects/**/*.jsonl  (CLI format)
// OR ~/Library/.../local-agent-mode-sessions/**/audit.jsonl (Desktop App format)
// The two formats differ: audit.jsonl uses `session_id`, `_audit_timestamp`, `claude_code_version`
export function extractClaudeLine(raw: string): { sessionId: string; appVersion: string; message: Message; rawImages: RawImageData[] } | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) } catch { return null }

  const type = obj.type as string
  // CLI uses camelCase `sessionId`; audit.jsonl uses snake_case `session_id`
  const sessionId = (obj.sessionId as string) || (obj.session_id as string) || ''
  // CLI uses `version`; audit.jsonl uses `claude_code_version` (on system events)
  const appVersion = (obj.version as string) || (obj.claude_code_version as string) || ''
  // CLI uses `timestamp`; audit.jsonl uses `_audit_timestamp`
  const timestamp = (obj.timestamp as string) || (obj._audit_timestamp as string) || new Date().toISOString()

  if (type === 'assistant') {
    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'assistant') return null

    const rawContent = msg.content as unknown[]
    const { blocks: content, images: rawImages } = parseClaudeContent(rawContent)
    const usage = parseClaudeUsage(msg.usage as Record<string, number> | undefined)

    return {
      sessionId,
      appVersion,
      rawImages,
      message: {
        id: (obj.uuid as string) || crypto.randomUUID(),
        role: 'assistant',
        timestamp,
        content,
        usage,
        hasThinking: content.some(b => b.type === 'thinking'),
      },
    }
  }

  if (type === 'user') {
    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'user') return null

    const rawContent = msg.content
    let content: ContentBlock[]
    let rawImages: RawImageData[] = []
    if (typeof rawContent === 'string') {
      content = [{ type: 'text', text: rawContent }]
    } else {
      const parsed = parseClaudeContent(rawContent as unknown[])
      content = parsed.blocks
      rawImages = parsed.images
    }

    return {
      sessionId,
      appVersion,
      rawImages,
      message: {
        id: (obj.uuid as string) || crypto.randomUUID(),
        role: 'user',
        timestamp,
        content,
        hasThinking: false,
      },
    }
  }

  return null
}

export function extractClaudeModel(raw: string): { model: string; cwd: string; appVersion: string } | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) } catch { return null }

  // CLI: model is in message.model on assistant events
  const msg = obj.message as Record<string, unknown> | undefined
  if (msg?.model) {
    return { model: msg.model as string, cwd: (obj.cwd as string) || '', appVersion: '' }
  }

  // audit.jsonl: model is on the `system` event directly
  if (obj.type === 'system' && obj.model) {
    return {
      model: obj.model as string,
      cwd: (obj.cwd as string) || '',
      appVersion: (obj.claude_code_version as string) || '',
    }
  }
  return null
}

function parseClaudeContent(rawContent: unknown[]): { blocks: ContentBlock[]; images: RawImageData[] } {
  if (!Array.isArray(rawContent)) return { blocks: [], images: [] }
  const images: RawImageData[] = []
  const blocks: ContentBlock[] = rawContent.map((block, idx) => {
    if (typeof block !== 'object' || !block) return { type: 'other' as const }
    const b = block as Record<string, unknown>
    if (b.type === 'thinking') return { type: 'thinking' as const, thinking: b.thinking as string || '' }
    if (b.type === 'text') return { type: 'text' as const, text: b.text as string || '' }
    if (b.type === 'tool_use') return { type: 'tool_use' as const, name: b.name as string, input: b.input }
    if (b.type === 'tool_result') {
      // tool_result content may itself contain image blocks — extract them
      const inner = b.content
      if (Array.isArray(inner)) {
        inner.forEach((ib, iidx) => {
          const iblock = ib as Record<string, unknown>
          if (iblock.type === 'image') {
            const src = iblock.source as Record<string, unknown> | undefined
            if (src?.type === 'base64' && typeof src.data === 'string') {
              images.push({
                blockIndex: idx,
                innerIndex: iidx,
                base64Data: src.data,
                mediaType: (src.media_type as string) || 'image/png',
                blockType: 'image',
              })
            }
          }
        })
      }
      return { type: 'tool_result' as const, content: b.content }
    }
    if (b.type === 'image') {
      const src = b.source as Record<string, unknown> | undefined
      if (src?.type === 'base64' && typeof src.data === 'string') {
        images.push({
          blockIndex: idx,
          base64Data: src.data,
          mediaType: (src.media_type as string) || 'image/png',
          blockType: 'image',
        })
      }
      return { type: 'image' as const, mediaType: (src?.media_type as string) || 'image/png' }
    }
    if (b.type === 'document') {
      const src = b.source as Record<string, unknown> | undefined
      const mediaType = (src?.media_type as string) || 'application/octet-stream'
      const attachmentName = (b.title as string) || (b.name as string) || undefined
      if (src?.type === 'base64' && typeof src.data === 'string') {
        images.push({
          blockIndex: idx,
          base64Data: src.data,
          mediaType,
          blockType: 'file',
          attachmentName,
        })
      }
      return {
        type: 'file' as const,
        mediaType,
        attachmentName,
      }
    }
    return { type: 'other' as const }
  })
  return { blocks, images }
}

function parseClaudeUsage(raw: Record<string, number> | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  return {
    inputTokens: raw.input_tokens,
    outputTokens: raw.output_tokens,
    cacheReadTokens: raw.cache_read_input_tokens,
    cacheWriteTokens: raw.cache_creation_input_tokens,
  }
}

export function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, '.jsonl')
}
