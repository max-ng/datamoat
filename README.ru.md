# DataMoat

Язык: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

Официальный сайт: [https://datamoat.org](https://datamoat.org)
GitHub репозиторий: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Экспортируйте и создавайте резервные копии данных, skills и вложений Claude, Codex, Cursor, DeepSeek, Qwen и OpenClaw." width="100%">

> **Экспортируйте и создавайте резервные копии всех данных, skills и вложений Claude / Codex / Cursor / DeepSeek / Qwen.**
> DataMoat хранит вашу историю работы с AI локально и в зашифрованном виде, сохраняет исходные записи и создает единый индекс для поиска, экспорта, повторного использования, передачи работы и приватной AI memory.
>
> **Самые ценные AI-данные будущего уже могут исчезать.**
> Установите DataMoat, чтобы увидеть, сколько истории работы Claude, Codex, Cursor, OpenClaw, DeepSeek и Qwen еще можно сохранить.

## Что Сохраняет DataMoat

DataMoat — это локальный зашифрованный AI work history memory archive для людей и команд, которые используют Claude CLI, Claude Desktop, Codex CLI, Codex app, Cursor, OpenClaw, DeepSeek и Qwen.

Он сохраняет сессии, prompts, ответы, вывод инструментов, метаданные, вложения, изображения, поддерживаемые файлы/PDF, папки `SKILL.md` и исходные локальные записи на той же машине.

## Как Устроен Архив Памяти

- **Raw archive:** JSONL, SQLite, логи, вложения, метаданные и snapshots папок skills сохраняются как можно ближе к исходному формату.
- **Normalized index:** записи из разных инструментов переводятся в общую схему для поиска, просмотра, экспорта, анализа и повторного использования.
- **Local control:** зашифрованный архив остается на вашей машине и читается только через утвержденные пути unlock/recovery.

## Зачем Устанавливать

- Восстанавливать историю AI-работы после замены устройства, очистки, context compaction или потери окружения.
- Экспортировать и повторно использовать старые prompts, решения, решения по архитектуре, вывод инструментов и вложения.
- Хранить skills, сессии и рабочий контекст в одном зашифрованном архиве памяти.
- Делать важную AI work history доступной для поиска, миграции, передачи и аудита.

## Поддерживается Сейчас

| Источник | Статус | Что сохраняет DataMoat |
|---|---|---|
| Claude CLI | Поддерживается | Локальные transcripts и thinking/reasoning blocks, если источник пишет их на диск |
| Codex CLI / Codex app | Поддерживается | Локальные сессии, текст, вывод инструментов, timestamps, метаданные и стабильные вложения |
| macOS Claude Desktop local-agent | Поддерживается | Локальные agent-сессии, если они есть |
| DeepSeek / Qwen via Claude Code GUI | Поддерживается | Локальные записи, skills, изображения и поддерживаемые вложения |
| Cursor | Поддерживается | Читаемые локальные `agent-transcripts` |
| OpenClaw | Поддерживается | Локальные transcripts и метаданные |
| Skills folders | Поддерживается | Snapshots `SKILL.md` и вспомогательных файлов |

## Установка

macOS: [скачать подписанный DMG](https://datamoat.org/download/macos)
Windows x64: [скачать ZIP + EXE](https://datamoat.org/download/windows-x64)
Windows ARM64: [скачать ZIP + EXE](https://datamoat.org/download/windows-arm64)

Установка из исходников:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## Безопасность

- Локальное шифрование AES-256-GCM для сессий, skills, вложений и состояния.
- Пароли хранятся как `scrypt` verifiers, не в открытом виде.
- Поддерживаются TOTP и 24-word BIP39 recovery phrase.
- Локальный UI привязан к `127.0.0.1` и использует cookies `HttpOnly` + `SameSite=Strict`.
- Локальный audit log связан hash chain и проверяется командой `datamoat audit verify`.

## Команды

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## Лицензия

DataMoat распространяется по **Business Source License 1.1 (`BUSL-1.1`)** с **Additional Use Grant**. Личное использование и внутреннее использование в компании разрешены; другие сценарии могут требовать отдельной коммерческой лицензии. Проект является **source-available**, но не OSI-approved open source.

Полные условия см. в [LICENSE.md](LICENSE.md).
