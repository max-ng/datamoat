import * as os from 'os'

export function looksLikeWindowsMachineAccount(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase()
  if (!normalized) return false
  const account = normalized.includes('\\') ? normalized.split('\\').pop() || '' : normalized
  return account.endsWith('$')
}

export function looksLikeWindowsSystemProfile(value: string | undefined): boolean {
  const normalized = (value || '').replace(/\//g, '\\').toLowerCase()
  return normalized.includes('\\windows\\system32\\config\\systemprofile')
    || normalized.includes('\\windows\\syswow64\\config\\systemprofile')
}

export function isWindowsSystemContext(): boolean {
  if (process.platform !== 'win32') return false

  const userName = (process.env.USERNAME || '').toLowerCase()
  const userInfoName = (() => {
    try { return os.userInfo().username.toLowerCase() } catch { return '' }
  })()
  return userName === 'system'
    || userInfoName === 'system'
    || looksLikeWindowsMachineAccount(userName)
    || looksLikeWindowsMachineAccount(userInfoName)
    || looksLikeWindowsSystemProfile(process.env.USERPROFILE)
    || looksLikeWindowsSystemProfile(process.env.APPDATA)
    || looksLikeWindowsSystemProfile(os.homedir())
}
