const OFFICIAL_UPDATE_REMOTES = [
  'https://github.com/max-ng/datamoat',
]
const OFFICIAL_UPDATE_BRANCHES = [
  'main',
]

const UPDATE_REMOTE_ALLOWLIST_ENV = 'DATAMOAT_UPDATE_REMOTE_ALLOWLIST'
const UPDATE_BRANCH_ALLOWLIST_ENV = 'DATAMOAT_UPDATE_BRANCH_ALLOWLIST'

function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/\/+$/, '')
    .replace(/\.git$/i, '')
}

function canonicalRemote(raw: string): string | null {
  const trimmed = raw.trim()
  const normalized = trimmed.replace(/^git\+/i, '')
  if (!trimmed) return null

  try {
    if (normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('ssh://')) {
      const parsed = new URL(normalized)
      if (!parsed.host) return null
      if (!parsed.hostname) return null
      return `${parsed.hostname.toLowerCase()}/${normalizePath(parsed.pathname)}`
    }
  } catch {
    // not an URL form
  }

  const scpMatch = normalized.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
  if (scpMatch) {
    const [, host, repoPath] = scpMatch
    if (!host || !repoPath) return null
    return `${host.toLowerCase()}/${normalizePath(repoPath)}`
  }

  if (/^[^:\s]+\/.+$/.test(normalized)) {
    return normalizePath(normalized).toLowerCase()
  }

  return null
}

function loadAdditionalRemoteAllowlist(): string[] {
  const raw = process.env[UPDATE_REMOTE_ALLOWLIST_ENV]
  if (!raw) return []
  return raw
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => canonicalRemote(entry))
    .filter((entry): entry is string => entry !== null)
}

function loadAdditionalBranchAllowlist(): string[] {
  const raw = process.env[UPDATE_BRANCH_ALLOWLIST_ENV]
  if (!raw) return []
  return raw
    .split(/[\n,]/)
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
}

export function allowedUpdateRemotes(): string[] {
  const defaults = OFFICIAL_UPDATE_REMOTES
    .map(remote => canonicalRemote(remote))
    .filter((remote): remote is string => remote !== null)

  const extras = loadAdditionalRemoteAllowlist()
  return Array.from(new Set([...defaults, ...extras]))
}

export function allowedUpdateBranches(): string[] {
  const defaults = OFFICIAL_UPDATE_BRANCHES.map(branch => branch.toLowerCase())
  const extras = loadAdditionalBranchAllowlist()
  return Array.from(new Set([...defaults, ...extras]))
}

export function isRemoteAllowed(rawRemote: string): boolean {
  const normalized = canonicalRemote(rawRemote)
  if (!normalized) return false
  const normalizedLower = normalized.toLowerCase()
  return allowedUpdateRemotes().some(allowed => normalizedLower === allowed.toLowerCase())
}

export function isBranchNameSafe(branch: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/.test(branch)
}

export function isBranchAllowed(branch: string): boolean {
  const normalized = branch.trim().toLowerCase()
  if (!normalized) return false
  return allowedUpdateBranches().includes(normalized)
}

export function remoteToDisplay(rawRemote: string): string {
  const normalized = canonicalRemote(rawRemote)
  return normalized ?? rawRemote
}
