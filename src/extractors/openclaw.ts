import * as path from 'path'
import { Message, ContentBlock, TokenUsage } from '../types'

// Parses one line from ~/.openclaw/agents/*/sessions/*.jsonl
// Event types: session, message, custom, thinking_level_change
export function extractOpenclawLine(raw: string): {
  sessionId?: string
  model?: string
  modelProvider?: string
  cwd?: string
  message?: Message
} | null {
  let obj: Record<string, unknown>
  try { obj = JSON.parse(raw) } catch { return null }

  const type = obj.type as string
  const timestamp = (obj.timestamp as string) || new Date().toISOString()

  // Session start — gives us session ID and cwd
  if (type === 'session') {
    return {
      sessionId: obj.id as string,
      cwd: obj.cwd as string,
    }
  }

  // Custom model-snapshot — resolves real model + provider
  if (type === 'custom') {
    const customType = obj.customType as string
    if (customType === 'model-snapshot') {
      const data = obj.data as Record<string, unknown> | undefined
      if (data) {
        return {
          model: data.modelId as string,
          modelProvider: data.provider as string,
        }
      }
    }
  }

  // Message events — actual conversation turns
  if (type === 'message') {
    const msg = obj.message as Record<string, unknown> | undefined
    if (!msg) return null

    const role = msg.role as string
    if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return null

    const rawContent = msg.content as unknown[]
    const content = role === 'toolResult'
      ? parseOpenclawToolResult(msg)
      : parseOpenclawContent(rawContent)
    const usage = parseOpenclawUsage(msg.usage as Record<string, unknown> | undefined)

    return {
      message: {
        id: (obj.id as string) || crypto.randomUUID(),
        role: normalizeOpenclawRole(role),
        timestamp,
        content,
        usage,
        hasThinking: content.some(b => b.type === 'thinking'),
      },
    }
  }

  return null
}

function parseOpenclawContent(rawContent: unknown[]): ContentBlock[] {
  if (!Array.isArray(rawContent)) return []
  return rawContent.map(block => {
    if (typeof block !== 'object' || !block) return { type: 'other' as const }
    const b = block as Record<string, unknown>
    if (b.type === 'thinking') return { type: 'thinking' as const, thinking: b.thinking as string || '' }
    if (b.type === 'text') return { type: 'text' as const, text: b.text as string || '' }
    if (b.type === 'tool_use') return { type: 'tool_use' as const, name: b.name as string, input: b.input }
    if (b.type === 'toolCall') {
      const input = b.arguments
      return {
        type: 'tool_use' as const,
        name: (b.toolName as string) || (b.name as string) || 'tool',
        input,
        text: stringifyUnknown(input),
      }
    }
    return { type: 'other' as const }
  })
}

function parseOpenclawToolResult(msg: Record<string, unknown>): ContentBlock[] {
  const name = (msg.toolName as string) || 'tool-result'
  const content = msg.content
  const text = stringifyUnknown(content)
  return [{
    type: 'tool_result',
    name,
    content,
    text,
  }]
}

function normalizeOpenclawRole(role: string): Message['role'] {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'tool'
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function parseOpenclawUsage(raw: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!raw) return undefined
  return {
    inputTokens: raw.input as number,
    outputTokens: raw.output as number,
    cacheReadTokens: raw.cacheRead as number,
    totalTokens: raw.totalTokens as number,
    cost: (raw.cost as Record<string, number>)?.total,
  }
}

export function sessionIdFromPath(filePath: string): string {
  return path.basename(filePath, '.jsonl')
}
