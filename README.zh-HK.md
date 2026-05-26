# DataMoat

語言: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

官方網站: [https://datamoat.org](https://datamoat.org)
GitHub repo: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="匯出並備份 Claude、Codex、Cursor、DeepSeek、Qwen 同 OpenClaw 嘅資料、skills 同附件。" width="100%">

> **匯出並備份你所有 Claude / Codex / Cursor / DeepSeek / Qwen 資料、skills 同附件。**
> DataMoat 會將你嘅 AI 工作歷史保存在本地加密記憶庫，保留原始紀錄，同時建立統一索引，方便搜尋、匯出、重用、交接同私人 AI memory。
>
> **你未來最值錢嘅 AI 資料，可能已經慢慢消失緊。**
> 安裝 DataMoat，睇下仲可以捕捉到幾多 Claude、Codex、Cursor、OpenClaw、DeepSeek 同 Qwen 工作歷史。

## DataMoat 會保存啲乜

DataMoat 係一個本地加密 AI work history memory archive，俾用緊 Claude CLI、Claude Desktop、Codex CLI、Codex app、Cursor、OpenClaw，以及透過本地流程用 DeepSeek / Qwen 嘅個人同團隊。

佢會保存 session、prompt、回覆、工具輸出、metadata、附件、圖片、支援嘅文件/PDF、`SKILL.md` folders，同埋同一部機上面可讀嘅原始來源紀錄。

## 記憶庫點樣儲存

- **原始歸檔:** JSONL、SQLite、logs、附件、metadata 同 skills folder snapshot 會盡量保留原本格式。
- **統一索引:** 唔同工具嘅紀錄會轉成共同 schema，方便搜尋、檢查、匯出、分析同重用。
- **本地控制:** 加密記憶庫留喺你部機，只可以經受控 unlock / recovery path 解密。

## 點解要安裝

- 換機、清 cache、context compaction、環境消失之後，都可以搵返 AI 工作歷史。
- 匯出同重用以前嘅 prompt、方案、判斷過程、工具輸出同附件。
- 將 skills、session 同工作上下文放喺同一個加密記憶庫。
- 令重要 AI work history 可以搜尋、搬走、交接同審計。

## 目前支援

| 來源 | 狀態 | DataMoat 保存內容 |
|---|---|---|
| Claude CLI | 支援 | 本地 transcript，同來源有寫入磁碟時嘅 thinking / reasoning blocks |
| Codex CLI / Codex app | 支援 | 本地 session、文字、工具輸出、時間、metadata 同穩定附件 |
| macOS Claude Desktop local-agent | 支援 | 存在時嘅本地 agent session |
| DeepSeek / Qwen via Claude Code GUI | 支援 | 本地紀錄、skills、圖片同支援附件 |
| Cursor | 支援 | 可讀嘅本地 `agent-transcripts` |
| OpenClaw | 支援 | 本地 transcript 同 metadata |
| Skills folders | 支援 | `SKILL.md` 同輔助檔案嘅完整 snapshot |

## 安裝

macOS: [下載已簽名 DMG](https://datamoat.org/download/macos)
Windows x64: [下載 ZIP + EXE](https://datamoat.org/download/windows-x64)
Windows ARM64: [下載 ZIP + EXE](https://datamoat.org/download/windows-arm64)

Source install:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## 安全

- 使用 AES-256-GCM 加密本地 session、skills、附件同 state。
- 密碼用 `scrypt` verifier 保存，唔會存明文。
- 支援 TOTP 同 24-word BIP39 recovery phrase。
- 本地 UI 綁定 `127.0.0.1`，使用 `HttpOnly` + `SameSite=Strict` cookies。
- 本地 audit log 用 hash chain，可用 `datamoat audit verify` 驗證。

## 指令

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## License

DataMoat 使用 **Business Source License 1.1 (`BUSL-1.1`)**，並附有 **Additional Use Grant**。個人使用同公司內部使用允許；超出授權範圍可能需要商業 license。本項目係 **source-available**，唔係 OSI-approved open source。

完整條款見 [LICENSE.md](LICENSE.md)。
