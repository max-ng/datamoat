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
    url: UPDATE_GENERIC_URL,
    channel: UPDATE_CHANNEL,
  }
}
