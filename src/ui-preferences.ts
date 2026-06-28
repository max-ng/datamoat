import * as fs from 'fs'
import { execFileSync } from 'child_process'
import { STATE_DIR, UI_PREFERENCES_FILE } from './config'

export type UiLanguageCode = 'en' | 'zh-CN' | 'zh-TW' | 'ja'
export type UiTheme = 'dark' | 'light'
export type ChatExportFormat = 'pdf' | 'html'

export const SUPPORTED_UI_LANGUAGES: readonly { code: UiLanguageCode; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ja', label: '日本語' },
]

type UiPreferences = {
  schemaVersion: 1
  language: UiLanguageCode
  theme: UiTheme
  readableMessageFormatting: boolean
  chatExportFormat: ChatExportFormat
  configured: boolean
}

const DEFAULT_PREFERENCES: UiPreferences = {
  schemaVersion: 1,
  language: 'en',
  theme: 'dark',
  readableMessageFormatting: true,
  chatExportFormat: 'pdf',
  configured: false,
}

function parseSupportedUiLanguage(value: unknown): UiLanguageCode | null {
  if (typeof value !== 'string') return null

  const normalized = value.trim().replace('_', '-').toLowerCase()
  if (normalized.startsWith('zh') || normalized.startsWith('yue')) {
    if (/(^|-)hant($|-)|(^|-)tw($|-)|(^|-)hk($|-)|(^|-)mo($|-)/.test(normalized)) return 'zh-TW'
    if (/(^|-)hans($|-)|(^|-)cn($|-)|(^|-)sg($|-)/.test(normalized)) return 'zh-CN'
    return null
  }
  if (normalized === 'ja' || normalized.startsWith('ja-') || normalized === 'jp') return 'ja'
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  return null
}

export function normalizeUiLanguage(value: unknown): UiLanguageCode {
  return parseSupportedUiLanguage(value) || DEFAULT_PREFERENCES.language
}

export function normalizeUiTheme(value: unknown): UiTheme {
  return value === 'light' ? 'light' : 'dark'
}

export function normalizeChatExportFormat(value: unknown): ChatExportFormat {
  return value === 'html' ? 'html' : 'pdf'
}

function supportedLanguageOrNull(value: unknown): UiLanguageCode | null {
  return parseSupportedUiLanguage(value)
}

function candidateSystemLocales(): string[] {
  const locales: string[] = []
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed) locales.push(trimmed)
  }

  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      for (const match of output.matchAll(/"([^"]+)"/g)) add(match[1])
    } catch {
      // macOS language defaults are optional; keep the other candidates.
    }
  }

  add(process.env.LC_ALL)
  add(process.env.LC_MESSAGES)
  add(process.env.LANG)

  try {
    add(Intl.DateTimeFormat().resolvedOptions().locale)
  } catch {
    // Ignore locale detection failures; English remains the final fallback.
  }

  return locales
}

export function detectDefaultUiLanguage(): UiLanguageCode {
  const explicit = supportedLanguageOrNull(process.env.DATAMOAT_LANG || process.env.DATAMOAT_LANGUAGE)
  if (explicit) return explicit

  const locales = candidateSystemLocales()
  const first = locales[0] || ''
  const firstLanguage = supportedLanguageOrNull(first)
  const scriptLanguage = locales
    .map(locale => supportedLanguageOrNull(locale))
    .find((language): language is UiLanguageCode => !!language && language !== 'en')

  if (firstLanguage && firstLanguage !== 'en') return firstLanguage
  if (/^en[-_](hk|mo|tw)$/i.test(first) && scriptLanguage) return scriptLanguage
  if (firstLanguage) return firstLanguage

  for (const locale of locales) {
    const language = supportedLanguageOrNull(locale)
    if (language) return language
  }
  return DEFAULT_PREFERENCES.language
}

export function uiLanguageFromArgv(argv: readonly string[] = process.argv): UiLanguageCode | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--datamoat-lang=')) {
      const language = arg.slice('--datamoat-lang='.length)
      return supportedLanguageOrNull(language)
    }
    if (arg.startsWith('--datamoat-language=')) {
      const language = arg.slice('--datamoat-language='.length)
      return supportedLanguageOrNull(language)
    }
    if (arg === '--datamoat-lang' || arg === '--datamoat-language') {
      const language = argv[index + 1]
      return supportedLanguageOrNull(language)
    }
  }

  const envLanguage = process.env.DATAMOAT_LANG || process.env.DATAMOAT_LANGUAGE
  return supportedLanguageOrNull(envLanguage)
}

export function readUiPreferences(): UiPreferences {
  try {
    const raw = fs.readFileSync(UI_PREFERENCES_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Partial<UiPreferences>
    return {
      schemaVersion: 1,
      language: normalizeUiLanguage(parsed.language),
      theme: normalizeUiTheme(parsed.theme),
      readableMessageFormatting: parsed.readableMessageFormatting !== false,
      chatExportFormat: normalizeChatExportFormat(parsed.chatExportFormat),
      configured: true,
    }
  } catch {
    return { ...DEFAULT_PREFERENCES, language: detectDefaultUiLanguage() }
  }
}

export function saveUiPreferences(input: { language?: unknown; theme?: unknown; readableMessageFormatting?: unknown; chatExportFormat?: unknown }): UiPreferences {
  const current = readUiPreferences()
  const preferences: UiPreferences = {
    schemaVersion: 1,
    language: input.language === undefined ? current.language : normalizeUiLanguage(input.language),
    theme: input.theme === undefined ? current.theme : normalizeUiTheme(input.theme),
    readableMessageFormatting: input.readableMessageFormatting === undefined
      ? current.readableMessageFormatting
      : input.readableMessageFormatting !== false,
    chatExportFormat: input.chatExportFormat === undefined
      ? current.chatExportFormat
      : normalizeChatExportFormat(input.chatExportFormat),
    configured: true,
  }

  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.writeFileSync(
    UI_PREFERENCES_FILE,
    JSON.stringify({
      schemaVersion: preferences.schemaVersion,
      language: preferences.language,
      theme: preferences.theme,
      readableMessageFormatting: preferences.readableMessageFormatting,
      chatExportFormat: preferences.chatExportFormat,
    }, null, 2),
    { mode: 0o600 },
  )
  try {
    fs.chmodSync(UI_PREFERENCES_FILE, 0o600)
  } catch {
    // chmod can fail on some Windows filesystems; the file still only contains a UI preference.
  }
  return preferences
}
