import type { Source } from './types'

export const TRANSFER_MANIFEST_FORMAT = 'datamoat-transfer-manifest-v1'
export const TRANSFER_JOB_VERSION = 1
export const TRANSFER_IMPORTS_VERSION = 1

export type TransferAuthMethod = 'password' | 'mnemonic'
export type TransferMode = 'adopt' | 'merge' | 'replace'
export type TransferPhase =
  | 'idle'
  | 'preflight'
  | 'unlocking-source'
  | 'validating-source'
  | 'backing-up-current-root'
  | 'copying-source-root'
  | 'cleaning-machine-bound-auth'
  | 'finalizing-transfer-root'
  | 'importing-sessions'
  | 'importing-attachments'
  | 'completed'
  | 'failed'
  | 'needs-reconnect'
  | 'cancelled'

export type TransferAuthSummary = {
  hasPassword: boolean
  hasMnemonic: boolean
  hasTouchId: boolean
  hasBackgroundUnlock: boolean
  totpEnrolled: boolean
}

export type TransferCounts = {
  sessions: number
  vaultFiles: number
  rawFiles: number
  attachments: number
  skillsFiles: number
  stateFiles: number
  totalBytes: number
}

export type TransferStorageCheck = {
  ok: boolean
  destinationRoot: string
  checkedPath: string
  sourceBytes: number
  safetyBytes: number
  requiredBytes: number
  availableBytes: number | null
  reason?: string
}

export type TransferBootstrapSummary = {
  present: boolean
  entries?: number
  portable: false
}

export type TransferManifest = {
  format: typeof TRANSFER_MANIFEST_FORMAT
  createdAt: string
  datamoatVersion: string
  platform: NodeJS.Platform
  arch: string
  rootFingerprint: string
  rootPath: string
  auth: TransferAuthSummary
  counts: TransferCounts
  warnings: string[]
  bootstrapCapture: TransferBootstrapSummary
}

export type TransferPreflightRequiredFiles = {
  authJson: boolean
  vault: boolean
  sessionsJson: boolean
}

export type TransferPreflightResult = {
  ok: boolean
  root: string
  status: 'ready' | 'checking' | 'unlock required' | 'needs repair' | 'failed'
  required: TransferPreflightRequiredFiles
  counts: TransferCounts
  auth: TransferAuthSummary | null
  manifest: TransferManifest | null
  storage?: TransferStorageCheck | null
  warnings: string[]
  errors: string[]
  rootFingerprint: string | null
}

export type TransferCredentials = {
  password?: string
  mnemonic?: string
}

export type TransferUnlockResult = {
  root: string
  helperSessionId: string
  method: TransferAuthMethod
  rootFingerprint: string
  auth: TransferAuthSummary
}

export type TransferImportedSessionRecord = {
  source: Source
  sourceUid: string
  destinationUid: string
  identity: string
  basicIdentity: string
  importedAt: string
}

export type TransferImportsState = {
  version: typeof TRANSFER_IMPORTS_VERSION
  updatedAt: string
  sourceFingerprints: Record<string, {
    root: string
    firstImportedAt: string
    lastImportedAt: string
    mode: TransferMode
  }>
  sessionIdentities: Record<string, TransferImportedSessionRecord>
  basicSessionIdentities: Record<string, TransferImportedSessionRecord>
  attachmentIds: Record<string, {
    importedAt: string
    sourceFingerprint: string
  }>
}

export type TransferImportJob = {
  version: typeof TRANSFER_JOB_VERSION
  id: string
  mode: TransferMode
  sourceRoot: string
  sourceVaultFingerprint: string | null
  phase: TransferPhase
  startedAt: string
  updatedAt: string
  completedAt?: string
  currentFile?: string
  currentSession?: string
  backupRoot?: string
  lastError?: string
  counts: TransferCounts
  imported: {
    sessions: number
    messages: number
    rawRecords: number
    attachments: number
  }
  skipped: {
    sessions: number
    messages: number
    rawRecords: number
    attachments: number
    duplicates: number
  }
  failed: {
    sessions: number
    attachments: number
  }
  cursor: {
    sessionIndex: number
    attachmentIndex: number
  }
  copy?: {
    files: number
    bytes: number
  }
  storage?: TransferStorageCheck | null
  done: boolean
}
