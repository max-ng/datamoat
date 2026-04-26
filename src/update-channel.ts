import type { GenericServerOptions, GithubOptions } from 'builder-util-runtime'

function envTrimmed(name: string): string | null {
  const value = process.env[name]?.trim()
  return value ? value : null
}

export const UPDATE_GITHUB_OWNER = envTrimmed('DATAMOAT_UPDATE_GITHUB_OWNER') || 'max-ng'
export const UPDATE_GITHUB_REPO = envTrimmed('DATAMOAT_UPDATE_GITHUB_REPO') || 'datamoat'
export const UPDATE_GITHUB_HOST = envTrimmed('DATAMOAT_UPDATE_GITHUB_HOST') || 'github.com'
export const UPDATE_GITHUB_PRIVATE = ['1', 'true', 'yes'].includes((envTrimmed('DATAMOAT_UPDATE_GITHUB_PRIVATE') || '').toLowerCase())
export const UPDATE_GENERIC_URL = envTrimmed('DATAMOAT_UPDATE_GENERIC_URL')
export const UPDATE_RELEASES_URL_OVERRIDE = envTrimmed('DATAMOAT_UPDATE_RELEASES_URL')
export const UPDATE_CHANNEL = envTrimmed('DATAMOAT_UPDATE_CHANNEL') || 'latest'

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
  if (UPDATE_GENERIC_URL) {
    return {
      provider: 'generic',
      url: UPDATE_GENERIC_URL,
      channel: UPDATE_CHANNEL,
    }
  }

  return {
    provider: 'github',
    owner: UPDATE_GITHUB_OWNER,
    repo: UPDATE_GITHUB_REPO,
    host: UPDATE_GITHUB_HOST,
    private: UPDATE_GITHUB_PRIVATE,
    channel: UPDATE_CHANNEL,
  }
}
