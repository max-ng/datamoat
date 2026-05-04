# DataMoat

[![Version](https://img.shields.io/badge/version-0.1.14-0F766E?style=flat-square)](#)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](#install)
[![License](https://img.shields.io/badge/license-BUSL--1.1-7C3AED?style=flat-square)](./LICENSE.md)
[![macOS](https://img.shields.io/badge/macOS-supported-111827?style=flat-square&logo=apple)](#supported-today)
[![Linux](https://img.shields.io/badge/Linux-supported-F59E0B?style=flat-square&logo=linux&logoColor=white)](#supported-today)
[![Packaged macOS App](https://img.shields.io/badge/packaged%20macOS%20app-available-0F766E?style=flat-square)](#install)
[![Windows](https://img.shields.io/badge/Windows-ZIP%20%2B%20EXE%20preview-2563EB?style=flat-square&logo=windows&logoColor=white)](#install)
[![Claude CLI](https://img.shields.io/badge/Claude%20CLI-supported-16A34A?style=flat-square)](#supported-today)
[![Claude Desktop Agent](https://img.shields.io/badge/Claude%20Desktop%20agent-supported-0F766E?style=flat-square)](#supported-today)
[![Codex CLI](https://img.shields.io/badge/Codex%20CLI-supported-2563EB?style=flat-square)](#supported-today)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-supported-9333EA?style=flat-square)](#supported-today)
[![Cursor](https://img.shields.io/badge/Cursor-supported-D8B640?style=flat-square)](#supported-today)

> **Turn every supported local Claude, Codex, Cursor, OpenClaw, and agent session into encrypted training-data assets for future AI employees.**
>
> DataMoat is a local encrypted vault for AI-assisted work. It captures supported local AI session records before they disappear, seals transcripts and attachments, normalizes sessions for review and search, and keeps your AI work traces under your control.
>
> **On-device by design:** your vault lives on your machine. There is no DataMoat cloud account or server-side vault, and your transcripts, attachments, and vault keys are not sent to DataMoat.

**Your AI work history is not just history. It is the work-process data your future agents will need.**

DataMoat preserves the supported local working record: locally stored thinking tokens and reasoning blocks when present, prompts, responses, tool output, files, attachments, metadata, and original source records on the same machine, so your work stays reviewable, protected, reusable, and useful for future AI employees.

## Why DataMoat Exists

AI work is becoming real work.

Future private AI employees — for individuals and companies — will not learn from documentation alone. They will need the real work process: the prompts, context, tool calls, outputs, corrections, and decisions that show how work actually gets done.

People now ask Claude, Codex, Cursor, OpenClaw, and other agents to investigate bugs, edit code, inspect files, run commands, reason through problems, generate fixes, explain tradeoffs, and recover context across projects. The valuable record is not only the final answer. The valuable record is the work trace:

- what the human asked for
- what context the agent saw
- what the agent tried
- what tools were called
- what files, logs, outputs, and attachments appeared
- what the human corrected
- what eventually worked
- what should be remembered next time

Those traces are private training-data assets for future AI employees. They can be protected and searched today before they disappear, then later become private memory, evaluation sets, handoff packs, workflow analytics, or company-specific model-improvement data when the right permissions, policies, cleaning, labeling, and export paths are in place.

DataMoat starts with the most important step: **capture and protect the private AI work data asset while it still exists on your machine.**

## What DataMoat Does Today

DataMoat currently provides a real local capture, vault, and review foundation:

- captures supported local records from Claude CLI, Codex CLI, Codex app local sessions, Claude Desktop local-agent sessions on macOS, supported OpenClaw session records, and supported Cursor agent transcripts
- runs on-device: captured content stays on your machine and is not sent to a DataMoat cloud service
- stores normalized `Session` and `Message` records with prompts, responses, tool use and results, usage, model, timestamps, metadata, and parsed thinking or reasoning blocks when the source writes them locally
- stores supported image, document, and file attachments as encrypted attachment blobs when the source provides attachment data
- writes source records into the protected vault before normalized persistence and before advancing capture offsets
- provides a local UI for browsing and searching captured sessions after unlock
- keeps protected content local as encrypted vault files instead of plaintext transcript dumps
- protects vault access with password-based unlock, optional authenticator support, recovery material, local auditability, and platform-specific hardening

## Private by Design

DataMoat is on-device by design. Your AI work vault lives on your machine, encrypted at rest. There is no DataMoat cloud vault, and DataMoat does not receive your transcripts, attachments, vault database, or vault keys.

The local app can only read protected content after you unlock your vault. Your AI work data is captured for you, not for DataMoat.

DataMoat protects the training-data asset first. You decide how your protected work traces are later used.



## How DataMoat Stores Your Work

DataMoat keeps two layers:

- **Raw source archive:** supported local JSONL, SQLite records, logs, attachments, metadata, and any locally stored thinking tokens or reasoning blocks are sealed in the encrypted vault as close to the source format as practical.
- **Normalized session records:** records from different tools are converted into a common schema so you can search, review, compare, reuse, and hand off AI work across tools.

**Supported sources today:** Claude CLI, Codex CLI, Codex app local sessions, Claude Desktop local-agent sessions on macOS, supported local OpenClaw session records, and supported local Cursor agent transcripts.

## Why Install DataMoat

- **Create encrypted training-data assets from real AI work.** Future AI employees will need the prompts, context, tool calls, outputs, corrections, and decisions that show how work actually gets done.
- **Keep your full AI work history recoverable.** Local records can become harder to revisit after compaction, cleanup, retention changes, account downgrades, device replacement, or environment loss.
- **Preserve the fullest local version while it is still available.** DataMoat saves the locally written transcript, including locally stored thinking tokens and reasoning blocks when the source stores them on disk.
- **Search past prompts, solutions, tool output, and thinking-token context.** Find previous fixes, workflows, timestamps, and attachments without depending on a live service view.
- **Protect continuity for individuals and teams.** Each protected machine can keep its own encrypted local archive for later review, handoff, and audit.
- **Keep records encrypted, private, and under local control.** Your vault stays on-device; DataMoat does not receive your transcripts, attachments, or vault keys, and only approved unlock and recovery paths can decrypt it.

## Highlights

- **On-device by design:** capture, encryption, vault storage, browse, and search run locally.
- **No DataMoat cloud vault:** transcripts, attachments, vault databases, and vault keys are not sent to DataMoat.
- **Encrypted local vault** for transcripts, attachments, and state using AES-256-GCM.
- **Saved content stays local** as encrypted vault files, not plaintext transcript dumps.
- **Strong local auth** with password, optional TOTP, a 24-word recovery phrase, and 8 one-time recovery codes.
- **Secure Enclave-backed unlock path on supported Macs** for hardware-assisted daily unlock. See Apple's overview of the [Secure Enclave](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web). Touch ID is part of the packaged macOS app path.
- **Helper-owned key custody** so the main UI process does not keep the active vault key.
- **Tamper-evident local audit chain**: current local audit entries are hash-chained and verifiable with `datamoat audit verify`.
- **Versioned local state** so protected storage can migrate safely over time.
- **Electron shell by default** to reduce general-purpose browser and browser-extension exposure, with local-only UI binding to `127.0.0.1`.
- **No third-party font or CDN dependency** in the UI.

## Supported Today

### Platforms

| Platform | Status | Notes |
|---|---|---|
| **macOS** | Supported today | Source install and signed packaged DMG are available now |
| **Linux** | Supported today | Source install available now |
| **Packaged macOS DMG** | [Download DMG](https://github.com/max-ng/datamoat/releases/latest/download/DataMoat-0.1.14-macos-arm64.dmg) (recommended) | Signed / notarized Apple Silicon DMG with Secure Enclave + Touch ID unlock on supported Macs |
| **Windows x64 / ARM64** | ZIP + `DataMoat.exe` | Unsigned manual packages for Windows 11 x64 and Windows 11 on Arm; x64 has passed GitHub Actions packaged runtime smoke, ARM64 has passed real VM UI/background capture smoke; signed installer still in progress |

### Sources

| Source | Status | What DataMoat preserves |
|---|---|---|
| **Claude CLI** | ✅ | Full local transcript, including locally written thinking blocks when present |
| **Codex CLI** | ✅ | Captures supported local Codex CLI session records; transcript text, tool output, timestamps, metadata, and stable image attachments are preserved |
| **Codex app** | ✅ | Captures supported local Codex app session records; transcript text, tool output, timestamps, metadata, and stable image attachments are preserved |
| **Claude Desktop local-agent sessions (macOS)** | ✅ | Supported local Claude Desktop agent session records when present |
| **OpenClaw** | ✅ | Supported local OpenClaw session transcripts and metadata |
| **Cursor** | ✅ | Captures readable local Cursor `agent-transcripts` JSONL records, including text and tool blocks when present |
| **Claude CLI attachments** | ✅ | Encrypted image and supported file/PDF blocks |

## Security At A Glance

- **Vault encryption**: transcripts, attachments, and local state are encrypted at rest with AES-256-GCM.
- **No server-side data access**: DataMoat does not receive your transcripts, attachments, vault database, or vault keys.
- **Owner-only local file permissions**: protected vault files, attachment blobs, and state files are written with restrictive local filesystem modes.
- **Password handling**: passwords are stored as `scrypt` verifiers, not plaintext.
- **Authenticator support**: TOTP works with standard authenticator apps such as Google Authenticator, 1Password, and Authy.
- **Recovery design**: every vault gets a 24-word BIP39 recovery phrase and 8 one-time recovery codes.
- **Local-only UI**: the UI binds to `127.0.0.1` and uses `HttpOnly` + `SameSite=Strict` cookies.
- **Reduced browser attack surface**: the default Electron shell avoids the normal general-purpose browser path; browser fallback remains available when needed.
- **Local API write protection**: mutating requests must come from the same origin and include a CSRF token.
- **Unlock retry hardening**: password, Touch ID, and recovery failures back off instead of allowing unlimited rapid retries.
- **Trusted source updates only**: in-place git updates are allowed only for allow-listed remotes / branches on a clean working tree.
- **Redacted diagnostics**: health, crash, log, and audit artifacts scrub secrets before they are written.
- **Key isolation**: the Electron renderer or browser fallback does not receive the raw vault key.
- **Auditability**: security-relevant local events are written to a hash-chained audit log. `datamoat audit verify` detects changed or broken entries in the current local log; it is not a remote notarization service or deletion-proof ledger.
- **Backup integrity**: the viewer reads the sealed vault copy as the source of truth, not a mutable live source transcript.

### Why 24 Words Instead of 12?

DataMoat uses a 24-word BIP39 phrase because it is long-lived recovery material for a high-value encrypted archive. A 12-word BIP39 phrase carries 128 bits of entropy, while a 24-word phrase carries 256 bits. Twelve words are still strong, but for recovery material that may need to protect access for many years, DataMoat chooses the larger security margin.

### How The Vault Is Protected

```mermaid
flowchart TD
    A["Supported local transcripts"] --> B["Realtime watcher"]
    B --> C["Random vault key"]
    C --> D["AES-256-GCM encrypted vault / attachments / state"]

    P["Password"] --> P2["scrypt verifier + wrapped release"]
    T["Packaged macOS app on supported Macs"] --> T2["Secure Enclave-backed release + Touch ID"]
    G["TOTP authenticator"] --> G2["second-factor gate"]
    R["24-word phrase + 8 one-time recovery codes"] --> R2["recovery release path"]

    P2 --> H["Helper-owned active key session"]
    T2 --> H
    G2 --> H
    R2 --> H

    H --> D
    H --> U["Local UI / Electron shell"]
```

## Install

The signed / notarized macOS DMG is the recommended install path for Mac users. Source install remains available for Linux, development, and fallback cases. The macOS DMG is available from [GitHub Releases](https://github.com/max-ng/datamoat/releases) and includes Secure Enclave + Touch ID unlock on supported Macs, menu-bar auto-start at login, and packaged auto-update through GitHub Releases. Windows x64 and ARM64 are available as unsigned ZIP + `DataMoat.exe` packages while the signed installer is completed.

Windows ZIP + `DataMoat.exe` downloads:

[![Download Windows x64 ZIP + EXE](https://img.shields.io/badge/Download-Windows%20x64%20ZIP%20%2B%20EXE-2563EB?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/max-ng/datamoat/releases/latest/download/DataMoat-0.1.14-win32-x64.zip)
[![Download Windows ARM64 ZIP + EXE](https://img.shields.io/badge/Download-Windows%20ARM64%20ZIP%20%2B%20EXE-2563EB?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/max-ng/datamoat/releases/latest/download/DataMoat-0.1.14-win32-arm64.zip)

Each Windows ZIP includes `DataMoat.exe` plus the required app files. Unzip the Windows package and run `DataMoat.exe` from inside the extracted folder. Keep the folder contents together; this is not a standalone single-file `.exe` installer yet.

### AI-Assisted Install

For Mac users, use the signed and notarized packaged DMG first: [Download DMG](https://github.com/max-ng/datamoat/releases/latest/download/DataMoat-0.1.14-macos-arm64.dmg). Do not start with `git clone` on macOS unless the user explicitly wants source install or the packaged release is unavailable.

You can ask Claude CLI, Codex CLI, or OpenClaw to install DataMoat when you are looking at the target desktop.

Typical prompt:

```text
Install DataMoat on this Mac using the latest signed macOS DMG from GitHub Releases. Copy DataMoat.app to Applications, launch it, and tell me when the local setup UI appears so I can complete the password, authenticator, Touch ID, and recovery steps myself on the protected desktop.
```

Important:

- an AI agent can start the install and prepare the app
- the final recovery and unlock setup should still be completed by the human user on the protected machine
- if you are using OpenClaw, Telegram, WhatsApp, or another remote chat relay without seeing the target desktop, use the dedicated remote no-screen flow below instead of the normal AI-assisted flow

### Remote No-Screen Install

If the install is being started through OpenClaw, Codex, or any remote chat relay while you cannot see the protected desktop, use the packaged macOS DMG or Windows ZIP first and launch the installed app with the single no-screen flag.

macOS remote prompt:

```text
Install DataMoat on this Mac using the latest signed and notarized macOS DMG.

Do not use git clone or source install unless the DMG install fails.

Steps:
1. Download the latest macOS DMG:
   https://github.com/max-ng/datamoat/releases/latest/download/DataMoat-0.1.14-macos-arm64.dmg
2. Mount the DMG.
3. Copy DataMoat.app to ~/Applications.
4. Launch exactly:
   ~/Applications/DataMoat.app/Contents/MacOS/DataMoat --datamoat-remote-no-screen

Use only --datamoat-remote-no-screen for remote no-screen pre-setup capture.
Do not complete password, authenticator, Touch ID, recovery phrase, or recovery-code setup in this chat.

After launch, tell me:
DataMoat was installed from the DMG and remote no-screen capture was started. I must finish setup later on the protected desktop GUI.
```

Windows remote prompt:

```text
Install DataMoat on this Windows machine using the latest Windows ZIP and DataMoat.exe.

Do not use git clone or source install.

Steps:
1. Download the correct latest Windows ZIP from GitHub Releases:
   x64: https://github.com/max-ng/datamoat/releases/latest/download/DataMoat-0.1.14-win32-x64.zip
   ARM64: https://github.com/max-ng/datamoat/releases/latest/download/DataMoat-0.1.14-win32-arm64.zip
2. Extract the ZIP into Downloads.
3. Launch exactly:
   %USERPROFILE%\Downloads\DataMoat-win32-<arch>\DataMoat.exe --datamoat-remote-no-screen

Use DataMoat-win32-x64 for x64 or DataMoat-win32-arm64 for ARM64.
Use only --datamoat-remote-no-screen for remote no-screen pre-setup capture.
Do not complete password, authenticator, recovery phrase, or recovery-code setup in this chat.

After launch, tell me:
DataMoat was installed from the Windows ZIP and remote no-screen capture was started. I must finish setup later on the protected desktop GUI.
```

Manual macOS launch command after installing the DMG:

```bash
"$HOME/Applications/DataMoat.app/Contents/MacOS/DataMoat" --datamoat-remote-no-screen
```

Use this mode to prevent the password, authenticator enrollment secret, Touch ID prompt, 24-word recovery phrase, and recovery codes from ever appearing in Telegram, WhatsApp, OpenClaw chat, screenshots, or any other remote relay. DataMoat starts collecting supported local records immediately with pre-setup encrypted capture, but the full unlock setup must still be completed later on the protected desktop.

After the remote install finishes, the agent should report that DataMoat was installed successfully and is already capturing supported local records. When you return to the protected desktop, open DataMoat there and complete setup locally. Do not complete password, authenticator, Touch ID, or recovery setup inside the bot conversation.

Linux fallback when no DMG exists:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh --remote-no-screen
```

### Manual Install

Recommended for source installs: use `git clone`.

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

Requirements:

- `Node.js 18+`
- `macOS` or `Linux`
- `macOS`: Xcode Command Line Tools for local native builds
- `Linux`: a normal Node build environment for your distro

The first setup flow shows recovery material locally:

- password
- authenticator enrollment secret / QR
- 24-word recovery phrase
- 8 one-time recovery codes

Final vault setup should be completed on the actual desktop screen of the machine being protected, not relayed through chat apps, screenshots, or remote messaging channels.

## Commands

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

Audit verification checks the integrity of the audit log that is present on disk. Without an external checkpoint, it cannot by itself prove that a local audit file was never deleted, truncated, or fully rewritten by someone with write access.

Live git source installs support in-place source updates. Packaged macOS installs use GitHub Releases as the packaged update source: the DMG is for first install, and later packaged updates download a signed ZIP payload and apply it through the macOS app updater instead of asking users to mount a new DMG for every release.

## Source Service Boundaries

DataMoat backs up supported local transcript files that are already present on your device and already accessible to you. Your vault is stored on-device; DataMoat does not operate a server-side copy of your AI work history and does not receive your vault keys.

It does not grant additional rights to content or source services. You remain responsible for complying with the terms, policies, plan restrictions, and internal rules that apply to Claude, Codex, OpenClaw, Cursor, and any other source service you use.

## Enterprise

Enterprise deployment and management features are on the roadmap. More enterprise-focused capabilities are coming; star and watch this repository to follow updates.

**The people and companies that own their AI data will win the future.**

## Consultation and Support

Questions or deployment help: `maxnghello at gmail.com`.

## License

DataMoat is distributed under **Business Source License 1.1 (`BUSL-1.1`)** with an **Additional Use Grant**.

This means:

- personal use is allowed
- internal company use is allowed
- uses outside that grant require a separate commercial license from the licensor

This is **source-available**, not OSI-approved open source.

See [LICENSE.md](LICENSE.md) for the full terms.

---

## Official Website

Official DataMoat website: [https://datamoat.org](https://datamoat.org)
