export type Source = 'claude-cli' | 'codex-cli' | 'claude-app' | 'openclaw' | 'cursor'

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

  // --- Phase 3 extensions (all optional) ---
  // Source-level provenance: the upstream CLI/app version active when this line
  // was emitted, and the original event type the extractor recognized.
  appVersion?: string
  sourceEventType?: string      // raw "type" from the source JSON: user / assistant / result / rate_limit_event / ...
  model?: string                // model name active for this specific turn (may differ from session-level)

  // Turn-level metrics (primarily surfaced from Claude `result` events).
  cost?: number                 // total_cost_usd for this turn
  durationMs?: number
  numTurns?: number
  stopReason?: string

  // Claude state-of-the-world fields at time of turn.
  fastModeState?: string
  activeSkills?: unknown
  activePlugins?: unknown
  activeAgents?: unknown
  toolsAvailable?: unknown
  mcpServers?: unknown
  permissionMode?: string
  permissionDenials?: unknown
  rateLimitInfo?: unknown
  outputStyle?: unknown
  slashCommands?: unknown

  // Catch-all for raw top-level fields we did not explicitly bind above.
  // Lets new upstream attributes surface in the UI without code changes.
  unknownAttrs?: Record<string, unknown>

  // Pointer back into raw store so re-extraction can find this message.
  rawRef?: { sessionUid: string; rawHash: string }
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

// Raw record — one per source line, persisted to vault/raw/<source>/<uid>.jsonl
// before the extractor runs. Base64 image payloads are replaced by attachment refs
// to avoid duplicating multi-MB blobs between raw/ and attachments/.
// Never mutated after write. Safe to re-extract from.
export interface RawRecord {
  v: 1                              // raw-record schema version
  source: Source
  sourcePath: string                // original file path the line came from
  sourceByteOffset: number          // byte offset of the line within the source file
  capturedAt: string                // ISO timestamp when the watcher read the line
  rawHash: string                   // sha256 of the original line bytes (pre base64-strip)
  raw: unknown                      // parsed object, or the original string if parse failed
  parseError?: string               // only set when raw was unparseable JSON
}
