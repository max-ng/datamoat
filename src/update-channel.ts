import type { GenericServerOptions, GithubOptions } from 'builder-util-runtime'

function envTrimmed(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

export const UPDATE_GITHUB_OWNER = envTrimmed('DATAMOAT_UPDATE_GITHUB_OWNER') || 'max-ng'
export const UPDATE_GITHUB_REPO = envTrimmed('DATAMOAT_UPDATE_GITHUB_REPO') || 'datamoat'
export const UPDATE_GITHUB_HOST = envTrimmed('DATAMOAT_UPDATE_GITHUB_HOST') || 'github.com'
export const UPDATE_GITHUB_PRIVATE = ['1', 'true', 'yes'].includes((envTrimmed('DATAMOAT_UPDATE_GITHUB_PRIVATE') || '').toLowerCase())
export const DOWNLOAD_BASE_URL = (envTrimmed('DATAMOAT_DOWNLOAD_BASE_URL') || 'https://downloads.datamoat.org').replace(/\/+$/, '')
export const UPDATE_GENERIC_URL = ensureTrailingSlash(envTrimmed('DATAMOAT_UPDATE_GENERIC_URL') || `${DOWNLOAD_BASE_URL}/releases/latest/`)
export const WINDOWS_UPDATE_MANIFEST_URL = envTrimmed('DATAMOAT_WINDOWS_UPDATE_MANIFEST_URL') || `${DOWNLOAD_BASE_URL}/releases/latest/manifest.json`
export const UPDATE_RELEASES_URL_OVERRIDE = envTrimmed('DATAMOAT_UPDATE_RELEASES_URL')
export const UPDATE_CHANNEL = envTrimmed('DATAMOAT_UPDATE_CHANNEL') || 'latest'

// Optional download/update relay (passive server-side stats; no IP, no ID).
// Default ON. Set DATAMOAT_DL_RELAY_URL='' to disable, or point it elsewhere.
const DL_RELAY_RAW = process.env.DATAMOAT_DL_RELAY_URL
export const DL_RELAY_BASE = (DL_RELAY_RAW === undefined ? 'https://dl.datamoat.org' : DL_RELAY_RAW.trim()).replace(/\/+$/, '')

// The base actually used for the update feed + Windows manifest. Defaults to the
// direct downloads origin and is only switched to the relay at runtime if its
// health check passes (see selectUpdateFeedBase). Updates never block on it.
let effectiveDownloadBase = DOWNLOAD_BASE_URL

export function setEffectiveDownloadBase(base: string): void {
  effectiveDownloadBase = base.replace(/\/+$/, '')
}

export function effectiveGenericFeedUrl(): string {
  return ensureTrailingSlash(envTrimmed('DATAMOAT_UPDATE_GENERIC_URL') || `${effectiveDownloadBase}/releases/latest/`)
}

export function effectiveWindowsManifestUrl(): string {
  return envTrimmed('DATAMOAT_WINDOWS_UPDATE_MANIFEST_URL') || `${effectiveDownloadBase}/releases/latest/manifest.json`
}

// Probe the relay once; use it only if healthy. Falls back to the direct
// downloads origin on any failure, so the update lifeline never depends on it.
export async function selectUpdateFeedBase(timeoutMs = 1500): Promise<string> {
  setEffectiveDownloadBase(DOWNLOAD_BASE_URL)
  // Respect explicit feed overrides and the disable switch.
  if (!DL_RELAY_BASE || envTrimmed('DATAMOAT_UPDATE_GENERIC_URL')) return effectiveDownloadBase
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`${DL_RELAY_BASE}/health`, { signal: controller.signal })
    clearTimeout(timer)
    if (response.ok) setEffectiveDownloadBase(DL_RELAY_BASE)
  } catch {
    // relay unreachable -> keep the direct downloads origin
  }
  return effectiveDownloadBase
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function githubBaseUrl(): string {
  return `https://${UPDATE_GITHUB_HOST.replace(/^https?:\/\//, '')}`
}

export function updateRepositoryUrl(): string {
  return `${githubBaseUrl()}/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}`
}

export function updateReleasesUrl(): string {
  return UPDATE_RELEASES_URL_OVERRIDE || `${updateRepositoryUrl()}/releases`
}

export function packagedUpdateFeedOptions(): GithubOptions | GenericServerOptions {
  return {
    provider: 'generic',
    url: effectiveGenericFeedUrl(),
    channel: UPDATE_CHANNEL,
  }
}
