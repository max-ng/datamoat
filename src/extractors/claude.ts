import * as path from 'path'
import { Message, ContentBlock, TokenUsage } from '../types'

export const CLAUDE_EXTRACTOR_VERSION = 3
export const CLAUDE_EXTRACTOR_COMPATIBILITY_VERSION = 3

export function claudeParserCompatibilityKey(source: 'claude-cli' | 'claude-app', appVersion: string | undefined): string {
  const family = source === 'claude-app' ? 'audit-jsonl' : 'project-jsonl'
  return `${source}:${family}:${CLAUDE_EXTRACTOR_COMPATIBILITY_VERSION}`
}

export function isClaudeSyntheticModel(model: string | undefined): boolean {
  return typeof model === 'string' && model.trim() === '<synthetic>'
}

export interface RawImageData {
  blockIndex: number   // outer content array index (always)
  innerIndex?: number  // if set: nested inside tool_result at this inner position
  base64Data: string
  mediaType: string
  blockType?: 'image' | 'file'
  attachmentName?: string
}

// Top-level fields the extractor binds explicitly to typed Message columns.
// Everything else captured on the line ends up in `unknownAttrs` so nothing
// is dropped silently.
const CLAUDE_KNOWN_FIELDS = new Set([
  'type', 'uuid', 'sessionId', 'session_id', 'version', 'claude_code_version',
  'timestamp', '_audit_timestamp', '_audit_hmac', 'message', 'content', 'model', 'cwd',
  'aiTitle',
  'parent_tool_use_id', 'client_platform',
  // result-event fields we map to typed columns
  'subtype', 'duration_ms', 'duration_api_ms', 'num_turns', 'result',
  'stop_reason', 'total_cost_usd', 'usage', 'is_error', 'api_error_status',
  'error', 'error_status', 'attempt', 'max_retries', 'retry_delay_ms',
  'terminal_reason',
  // rate-limit-event field
  'rate_limit_info',
  // state-of-the-world fields we map to typed columns
  'fast_mode_state', 'skills', 'plugins', 'agents', 'tools', 'mcp_servers',
  'permissionMode', 'permission_denials', 'output_style', 'slash_commands',
  'apiKeySource', 'modelUsage', 'isReplay', 'status',
])

function collectUnknownAttrs(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {}
  let any = false
  for (const [key, value] of Object.entries(obj)) {
    if (CLAUDE_KNOWN_FIELDS.has(key)) continue
    extras[key] = value
    any = true
  }
  return any ? extras : undefined
}

function readClaudeStateOfWorld(obj: Record<string, unknown>, msg: Message): void {
  if (obj.fast_mode_state !== undefined) msg.fastModeState = obj.fast_mode_state as string
  if (obj.skills !== undefined) msg.activeSkills = obj.skills
  if (obj.plugins !== undefined) msg.activePlugins = obj.plugins
  if (obj.agents !== undefined) msg.activeAgents = obj.agents
  if (obj.tools !== undefined) msg.toolsAvailable = obj.tools
  if (obj.mcp_servers !== undefined) msg.mcpServers = obj.mcp_servers
  if (obj.permissionMode !== undefined) msg.permissionMode = obj.permissionMode as string
  if (obj.permission_denials !== undefined) msg.permissionDenials = obj.permission_denials
  if (obj.output_style !== undefined) msg.outputStyle = obj.output_style
  if (obj.slash_commands !== undefined) msg.slashCommands = obj.slash_commands
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

    const message: Message = {
      id: (obj.uuid as string) || crypto.randomUUID(),
      role: 'assistant',
      timestamp,
      content,
      usage,
      hasThinking: hasNonEmptyThinking(content),
      appVersion: appVersion || undefined,
      sourceEventType: type,
      model: (msg.model as string) || undefined,
    }
    readClaudeStateOfWorld(obj, message)
    const extras = collectUnknownAttrs(obj)
    if (extras) message.unknownAttrs = extras

    return { sessionId, appVersion, rawImages, message }
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

    const message: Message = {
      id: (obj.uuid as string) || crypto.randomUUID(),
      role: 'user',
      timestamp,
      content,
      hasThinking: false,
      appVersion: appVersion || undefined,
      sourceEventType: type,
    }
    readClaudeStateOfWorld(obj, message)
    const extras = collectUnknownAttrs(obj)
    if (extras) message.unknownAttrs = extras

    return { sessionId, appVersion, rawImages, message }
  }

  if (type === 'system') {
    const parsedContent = parseClaudeSystemContent(obj)
    if (parsedContent.blocks.length === 0) return null

    const message: Message = {
      id: (obj.uuid as string) || crypto.randomUUID(),
      role: 'system',
      timestamp,
      content: parsedContent.blocks,
      hasThinking: hasNonEmptyThinking(parsedContent.blocks),
      appVersion: appVersion || undefined,
      sourceEventType: typeof obj.subtype === 'string' && obj.subtype ? `${type}.${obj.subtype}` : type,
    }
    readClaudeStateOfWorld(obj, message)
    const extras = collectUnknownAttrs(obj)
    if (extras) message.unknownAttrs = extras
    return { sessionId, appVersion, rawImages: parsedContent.images, message }
  }

  // `result` events — previously dropped. Carry per-turn cost, duration, stop
  // reason, full usage breakdown. Surfaced as a synthetic system message so
  // the UI can render them alongside user/assistant turns.
  if (type === 'result') {
    const usage = parseClaudeUsage(obj.usage as Record<string, number> | undefined)
    const resultText = typeof obj.result === 'string' ? (obj.result as string) : ''
    const content: ContentBlock[] = resultText ? [{ type: 'text', text: resultText }] : []
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'system',
      timestamp,
      content,
      usage,
      hasThinking: false,
      appVersion: appVersion || undefined,
      sourceEventType: type,
      cost: typeof obj.total_cost_usd === 'number' ? (obj.total_cost_usd as number) : undefined,
      durationMs: typeof obj.duration_ms === 'number' ? (obj.duration_ms as number) : undefined,
      numTurns: typeof obj.num_turns === 'number' ? (obj.num_turns as number) : undefined,
      stopReason: typeof obj.stop_reason === 'string' ? (obj.stop_reason as string) : undefined,
    }
    const extras = collectUnknownAttrs(obj)
    if (extras) message.unknownAttrs = extras
    return { sessionId, appVersion, rawImages: [], message }
  }

  // `rate_limit_event` — previously dropped. Carries rate-limit state and reset time.
  if (type === 'rate_limit_event') {
    const message: Message = {
      id: (obj.uuid as string) || crypto.randomUUID(),
      role: 'system',
      timestamp,
      content: [],
      hasThinking: false,
      appVersion: appVersion || undefined,
      sourceEventType: type,
      rateLimitInfo: obj.rate_limit_info,
    }
    const extras = collectUnknownAttrs(obj)
    if (extras) message.unknownAttrs = extras
    return { sessionId, appVersion, rawImages: [], message }
  }

  // Claude CLI may emit repeated title metadata. It does not carry a turn body,
  // and the raw record remains backed up for provenance.
  if (type === 'ai-title') return null

  return null
}

export function extractClaudeModel(raw: string): { model: string; cwd: string; appVersion: string } | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) } catch { return null }

  // CLI: model is in message.model on assistant events
  const msg = obj.message as Record<string, unknown> | undefined
  if (msg?.model) {
    const model = msg.model as string
    if (isClaudeSyntheticModel(model)) return null
    return { model, cwd: (obj.cwd as string) || '', appVersion: '' }
  }

  // audit.jsonl: model is on the `system` event directly
  if (obj.type === 'system' && obj.model) {
    const model = obj.model as string
    if (isClaudeSyntheticModel(model)) return null
    return {
      model,
      cwd: (obj.cwd as string) || '',
      appVersion: (obj.claude_code_version as string) || '',
    }
  }
  return null
}

function parseClaudeContent(rawContent: unknown[]): { blocks: ContentBlock[]; images: RawImageData[] } {
  if (!Array.isArray(rawContent)) return { blocks: [], images: [] }
  const images: RawImageData[] = []
  const blocks: ContentBlock[] = []
  for (const block of rawContent) {
    const blockIndex = blocks.length
    if (typeof block !== 'object' || !block) {
      blocks.push({ type: 'other' as const })
      continue
    }
    const b = block as Record<string, unknown>
    if (b.type === 'thinking') {
      const thinking = typeof b.thinking === 'string' ? b.thinking.trim() : ''
      if (thinking) blocks.push({ type: 'thinking' as const, thinking })
      continue
    }
    if (b.type === 'text') {
      blocks.push({ type: 'text' as const, text: b.text as string || '' })
      continue
    }
    if (b.type === 'tool_use') {
      blocks.push({ type: 'tool_use' as const, name: b.name as string, input: b.input })
      continue
    }
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
                blockIndex,
                innerIndex: iidx,
                base64Data: src.data,
                mediaType: (src.media_type as string) || 'image/png',
                blockType: 'image',
              })
            }
          }
        })
      }
      blocks.push({ type: 'tool_result' as const, content: b.content })
      continue
    }
    if (b.type === 'image') {
      const src = b.source as Record<string, unknown> | undefined
      if (src?.type === 'base64' && typeof src.data === 'string') {
        images.push({
          blockIndex,
          base64Data: src.data,
          mediaType: (src.media_type as string) || 'image/png',
          blockType: 'image',
        })
      }
      blocks.push({ type: 'image' as const, mediaType: (src?.media_type as string) || 'image/png' })
      continue
    }
    if (b.type === 'document') {
      const src = b.source as Record<string, unknown> | undefined
      const mediaType = (src?.media_type as string) || 'application/octet-stream'
      const attachmentName = (b.title as string) || (b.name as string) || undefined
      if (src?.type === 'base64' && typeof src.data === 'string') {
        images.push({
          blockIndex,
          base64Data: src.data,
          mediaType,
          blockType: 'file',
          attachmentName,
        })
      }
      blocks.push({
        type: 'file' as const,
        mediaType,
        attachmentName,
      })
      continue
    }
    blocks.push({ type: 'other' as const })
  }
  return { blocks, images }
}

function parseClaudeSystemContent(obj: Record<string, unknown>): { blocks: ContentBlock[]; images: RawImageData[] } {
  const content = obj.content
  if (typeof content === 'string') {
    const text = content.trim()
    if (text) return { blocks: [{ type: 'text', text }], images: [] }
  }
  if (Array.isArray(content)) {
    const parsed = parseClaudeContent(content)
    if (parsed.blocks.length > 0) return parsed
  } else if (content && typeof content === 'object') {
    return { blocks: [{ type: 'other', content }], images: [] }
  }

  const error = typeof obj.error === 'string' ? obj.error.trim() : ''
  if (error) return { blocks: [{ type: 'text', text: error }], images: [] }
  return { blocks: [], images: [] }
}

function hasNonEmptyThinking(content: ContentBlock[]): boolean {
  return content.some(block => block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length > 0)
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
