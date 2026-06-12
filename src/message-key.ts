import type { ContentBlock, Message } from './types'

// Content-identity key for a parsed message. Used both by live capture (to skip
// replayed messages when a resumed/forked Claude session file is routed into its
// canonical session) and by vault maintenance (to dedupe and merge duplicates).
// Keying on content rather than uuid keeps the two in lockstep and is robust to
// forks that re-emit the same turn.

export function stableStringify(value: unknown): string {
  if (value === undefined) return '"__undefined__"'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

function normalizedBlock(block: ContentBlock): unknown {
  return {
    ...block,
    attachmentId: block.attachmentId || undefined,
    attachmentIds: block.attachmentIds || undefined,
  }
}

export function normalizedMessageKey(message: Message): string {
  return stableStringify({
    role: message.role,
    timestamp: message.timestamp,
    model: message.model || '',
    sourceEventType: message.sourceEventType || '',
    content: message.content.map(normalizedBlock),
    usage: message.usage || null,
    hasThinking: message.hasThinking,
  })
}
