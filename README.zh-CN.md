# DataMoat

语言: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

官方网站: [https://datamoat.org](https://datamoat.org)
GitHub 仓库: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="导出并备份 Claude、Codex、Cursor、DeepSeek、Qwen 和 OpenClaw 的数据、技能和附件。" width="100%">

> **导出并备份你的 Claude / Codex / Cursor / DeepSeek / Qwen 数据、skills 和附件。**
> DataMoat 会把你的 AI 工作历史保存在本地加密记忆库中，保留原始记录，同时建立统一索引，方便搜索、导出、复用、交接和构建私有 AI 记忆。
>
> **你未来最有价值的 AI 数据，可能已经在慢慢消失。**
> 现在安装 DataMoat，看看还能捕获多少 Claude、Codex、Cursor、OpenClaw、DeepSeek 和 Qwen 的工作历史。

## DataMoat 保存什么

DataMoat 是一个本地加密的 AI work history memory archive，面向使用 Claude CLI、Claude Desktop、Codex CLI、Codex app、Cursor、OpenClaw，以及通过本地工作流使用 DeepSeek 和 Qwen 的个人和团队。

它会保存会话、提示词、回复、工具输出、元数据、附件、图片、受支持的文件/PDF、`SKILL.md` 文件夹，以及同一台机器上可访问的原始来源记录。

## 记忆库怎样存储

- **原始归档:** 尽量按原格式保存 JSONL、SQLite、日志、附件、元数据和 skills 文件夹快照。
- **统一索引:** 不同工具的记录会转换成共同结构，方便搜索、复查、导出、分析和复用。
- **本地控制:** 加密记忆库留在你的机器上，只能通过受控的解锁和恢复路径读取。

## 为什么要安装

- 换电脑、清理缓存、上下文压缩、环境丢失之后，仍然可以找回 AI 工作历史。
- 导出和复用过去的提示词、解决方案、决策过程、工具输出和附件。
- 把 skills、会话和上下文放进同一个加密记忆库。
- 让重要 AI 工作记录可以搜索、迁移、交接和审计。

## 目前支持

| 来源 | 状态 | DataMoat 保存内容 |
|---|---|---|
| Claude CLI | 支持 | 本地 transcript，以及来源写入磁盘时的思考/推理块 |
| Codex CLI / Codex app | 支持 | 本地会话、文本、工具输出、时间戳、元数据和稳定附件 |
| macOS Claude Desktop local-agent | 支持 | 存在时的本地 agent 会话记录 |
| DeepSeek / Qwen via Claude Code GUI | 支持 | 本地记录、skills、图片和受支持附件 |
| Cursor | 支持 | 可读取的本地 `agent-transcripts` |
| OpenClaw | 支持 | 本地 transcript 和元数据 |
| Skills 文件夹 | 支持 | `SKILL.md` 及辅助文件的完整快照 |

## 安装

macOS: [下载签名 DMG](https://datamoat.org/download/macos)
Windows x64: [下载 ZIP + EXE](https://datamoat.org/download/windows-x64)
Windows ARM64: [下载 ZIP + EXE](https://datamoat.org/download/windows-arm64)

源码安装:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## 安全

- 使用 AES-256-GCM 加密本地会话、skills、附件和状态。
- 密码以 `scrypt` verifier 保存，不保存明文。
- 支持 TOTP 和 24 词 BIP39 恢复短语。
- 本地 UI 绑定到 `127.0.0.1`，使用 `HttpOnly` 和 `SameSite=Strict` cookie。
- 本地审计日志使用 hash chain，可用 `datamoat audit verify` 验证。

## 命令

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## 许可证

DataMoat 使用 **Business Source License 1.1 (`BUSL-1.1`)**，并带有 **Additional Use Grant**。允许个人使用和公司内部使用；超出授权范围的使用可能需要商业许可。本项目是 **source-available**，不是 OSI 批准的开源软件。

完整条款见 [LICENSE.md](LICENSE.md)。
