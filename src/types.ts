export type Source = 'claude-cli' | 'codex-cli' | 'claude-app' | 'openclaw'

export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | 'file' | 'other'
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  content?: unknown
  // image / file attachments (stored separately, referenced by hash)
  attachmentId?: string    // sha256 hex — for top-level image blocks
  attachmentIds?: string[] // sha256 hashes — for images nested inside tool_result content
  mediaType?: string       // e.g. 'image/png', 'application/pdf'
  attachmentName?: string  // original filename if available
}

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
  cost?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  timestamp: string
  content: ContentBlock[]
  usage?: TokenUsage
  hasThinking: boolean
}

export interface Session {
  uid: string
  id: string
  source: Source
  sourceClient?: string
  sourceAccount?: string
  appVersion: string
  model: string
  modelProvider: string
  firstTimestamp: string
  lastTimestamp: string
  cwd: string
  messageCount: number
  hasThinking: boolean
  vaultPath: string        // relative path inside vault dir
  originalPath: string     // original source file path
}

export interface SessionsIndex {
  version: number
  updatedAt: string
  sessions: Session[]
}

export interface OffsetsIndex {
  version: number
  updatedAt: string
  offsets: OffsetState
}

export interface OffsetState {
  [filePath: string]: {
    offset: number
    sessionId: string
    source: Source
    lastMod: number
  }
}

export interface DaemonStatus {
  running: boolean
  pid: number
  startedAt: string
  sources: {
    [key in Source]: {
      watching: boolean
      sessionsCapured: number
      lastCapture: string | null
    }
  }
}

export interface AuditEntry {
  version: number
  ts: string
  component: string
  event: string
  fields: Record<string, unknown>
  prevHash: string | null
  hash: string
}
