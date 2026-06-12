# DataMoat

Ngôn ngữ: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-Hant.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

[![Version](https://img.shields.io/badge/version-2.0.8-0F766E?style=flat-square)](#)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js&logoColor=white)](#install)
[![License](https://img.shields.io/badge/license-BUSL--1.1-7C3AED?style=flat-square)](./LICENSE.md)
[![macOS](https://img.shields.io/badge/macOS-supported-111827?style=flat-square&logo=apple)](#supported-today)
[![Linux](https://img.shields.io/badge/Linux-supported-F59E0B?style=flat-square&logo=linux&logoColor=white)](#supported-today)
[![Packaged macOS App](https://img.shields.io/badge/packaged%20macOS%20app-available-0F766E?style=flat-square)](#install)
[![Windows](https://img.shields.io/badge/Windows-ZIP%20%2B%20EXE%20preview-2563EB?style=flat-square&logo=windows&logoColor=white)](#install)
[![Claude CLI](https://img.shields.io/badge/Claude%20CLI-supported-16A34A?style=flat-square)](#supported-today)
[![Claude Desktop Agent](https://img.shields.io/badge/Claude%20Desktop%20agent-supported-0F766E?style=flat-square)](#supported-today)
[![DeepSeek](https://img.shields.io/badge/DeepSeek-supported-4F7CFF?style=flat-square)](#supported-today)
[![Qwen](https://img.shields.io/badge/Qwen-supported-5B4BDB?style=flat-square)](#supported-today)
[![Codex CLI](https://img.shields.io/badge/Codex%20CLI-supported-2563EB?style=flat-square)](#supported-today)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-supported-9333EA?style=flat-square)](#supported-today)
[![Cursor](https://img.shields.io/badge/Cursor-supported-D8B640?style=flat-square)](#supported-today)
[![ChatGPT export](https://img.shields.io/badge/ChatGPT%20export-ZIP%2Ffolder%20import-10B981?style=flat-square)](#supported-today)

Website chính thức: [https://datamoat.org](https://datamoat.org)
GitHub repo: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

## Bảo vệ, export, backup, phân tích, tìm kiếm và tái sử dụng mọi thứ bạn tạo với ChatGPT, Claude, Codex, Cursor, DeepSeek, Qwen và OpenClaw

Local encrypted backup archive cho sessions, images, files/PDFs và folders `SKILL.md`.

> **Bảo vệ, export, backup, phân tích, tìm kiếm và tái sử dụng mọi thứ bạn tạo với ChatGPT, Claude, Codex, Cursor, DeepSeek, Qwen và OpenClaw.**
> DataMoat giữ AI work history của bạn ở local và được mã hóa, bảo toàn raw source records nguyên vẹn và tạo normalized layer cho analysis, search, export, reuse, handoff và private AI memory.
>
> **Dữ liệu AI quý giá nhất trong tương lai của bạn đang biến mất rồi.**
> Tải DataMoat ngay để xem bạn còn có thể capture được bao nhiêu work history từ ChatGPT, Claude, Codex, Cursor, DeepSeek, Qwen và OpenClaw.

**Phạm vi backup cốt lõi:** DataMoat backup **skills + sessions + attachments** được hỗ trợ vào cùng một encrypted local memory archive. Skills được lưu như full folder snapshots, không chỉ là tên.

**Những người và công ty sở hữu dữ liệu AI của họ sẽ thắng trong tương lai.**

DataMoat là AI work history memory archive cho cá nhân và đội nhóm làm việc với ChatGPT exports, Claude CLI, Claude Desktop, DeepSeek và Qwen qua Claude Code GUI workflows, Codex CLI, Codex app, Cursor, OpenClaw và các AI tools khác. Nó bảo toàn full working record: sessions, locally stored thinking tokens và reasoning blocks khi có, prompts, responses, tool output, files, attachments, metadata, skills folder contents và original source records trên cùng máy, để công việc của bạn vẫn reviewable, protected, reusable và dễ handoff hơn về sau.

![DataMoat sessions, skills backup và encrypted local memory archive UI](.github/assets/screenshot.png)

## DataMoat Lưu Công Việc Của Bạn Như Thế Nào

DataMoat giữ hai lớp:

- **Raw archive:** original session JSONL, SQLite records, logs, attachments, metadata, skills folder snapshots và mọi locally stored thinking tokens hoặc reasoning blocks được giữ gần với source format nhất có thể.
- **Normalized index:** records từ các tools khác nhau được chuyển thành common schema để bạn có thể analyze, search, review, export, reuse và handoff work xuyên tools.

**Sources được hỗ trợ hôm nay:** ChatGPT export ZIP/folder imports, Claude CLI, Codex CLI, Codex app local sessions, Claude Desktop local-agent sessions trên macOS, DeepSeek và Qwen sessions khi được Claude Code GUI workflows ghi local, supported local OpenClaw session records và supported local Cursor agent transcripts.
**Nhiều data sources và platform releases khác nằm trên roadmap:** star và watch repository này để theo dõi capture integrations và platform updates mới khi chúng ship.

## 2.0.8 Mới: Chú thích, nhập ChatGPT Export và chuyển máy an toàn hơn

DataMoat nay nhập các file ChatGPT export ZIP hoặc thư mục export đã giải nén được hỗ trợ vào cùng encrypted local memory archive dùng cho Claude, Codex, Cursor, DeepSeek, Qwen, OpenClaw, skills và attachments.

- **Restore, view, search và backup ChatGPT exports.** Conversations, alternate branches, attachments, assets và raw export files được hỗ trợ sẽ được import vào encrypted vault.
- **Đánh dấu ngữ cảnh quan trọng.** Bookmark sessions và từng message, vote câu trả lời hữu ích hoặc yếu, rồi filter review views để tìm reusable context dễ hơn.
- **Giữ raw export mà không lãng phí disk.** DataMoat bảo toàn original source records và có thể lưu raw backup data lặp lại trong compressed encrypted archives; source-record tests thật cho thấy raw archive storage khoảng 60% original source bytes.
- **Di chuyển work giữa computers.** Copy DataMoat folder sang máy khác và restore xuyên macOS, Windows, Linux, bao gồm Mac to Windows và Linux to Mac.
- **Mang theo backup thứ hai.** Lưu encrypted DataMoat folder vào USB hoặc external drive để AI work history có thể đi riêng khỏi source computer.

## Vì Sao Nên Cài DataMoat

- **Giữ full AI work history có thể recover.** Local records có thể khó xem lại hơn sau compaction, cleanup, retention changes, account downgrades, device replacement hoặc environment loss.
- **Bảo toàn local version đầy đủ nhất khi nó vẫn còn.** DataMoat lưu locally written transcript, bao gồm locally stored thinking tokens và reasoning blocks khi source lưu chúng vào disk.
- **Backup work context xung quanh.** DataMoat bảo vệ supported sessions, attachments và `SKILL.md`-based skills folder contents trong cùng encrypted memory archive.
- **Search prompts cũ, solutions, tool output và thinking-token context.** Tìm lại fixes, workflows, timestamps và attachments trước đây mà không phụ thuộc vào live service view.
- **Bảo vệ continuity cho cá nhân và đội nhóm.** Mỗi protected machine có thể giữ encrypted local archive riêng cho review, handoff và audit sau này.
- **Giữ records encrypted và dưới local control.** Software hoặc services khác không thể đọc memory archive trực tiếp; chỉ approved unlock và recovery paths mới decrypt được.

## Highlights

- **Encrypted local memory archive** cho transcripts, skills, attachments và state bằng AES-256-GCM.
- **Saved content stays local** dưới dạng encrypted memory archive files, không phải plaintext transcript dumps.
- **Strong local auth** với password, optional TOTP và 24-word recovery phrase.
- **Secure Enclave-backed unlock path trên Macs được hỗ trợ** cho daily unlock có hardware assist. Xem tổng quan của Apple về [Secure Enclave](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web). Touch ID là một phần của packaged macOS app path.
- **Helper-owned key custody** để main UI process không giữ active memory encryption key.
- **Tamper-evident local audit chain**: current local audit entries được hash-chained và verify bằng `datamoat audit verify`.
- **Versioned local state** để protected storage có thể migrate an toàn theo thời gian.
- **Electron shell by default** để giảm general-purpose browser và browser-extension exposure, với local-only UI binding tới `127.0.0.1`.
- **Không có third-party font hoặc CDN dependency** trong UI.

## Hỗ Trợ Hiện Tại

### Platforms

| Platform | Status | Notes |
|---|---|---|
| **macOS** | Hỗ trợ hôm nay | Source install và signed packaged DMG đã có |
| **Linux** | Hỗ trợ hôm nay | Source install đã có |
| **Packaged macOS DMG** | [Tải DMG](https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-macos-arm64.dmg?s=gh-vi) (khuyến nghị) | Signed / notarized Apple Silicon DMG với Secure Enclave + Touch ID unlock trên Macs được hỗ trợ |
| **Windows x64 / ARM64** | ZIP + `DataMoat.exe` | Unsigned manual packages cho Windows 11 x64 và Windows 11 on Arm; x64 đã pass GitHub Actions packaged runtime smoke, ARM64 đã pass real VM UI/background capture smoke; signed installer vẫn đang làm |

### Sources

| Source | Status | DataMoat bảo toàn gì |
|---|---|---|
| **Claude CLI** | ✅ | Full local transcript, bao gồm locally written thinking blocks khi có |
| **Codex CLI** | ✅ | Captures supported local Codex CLI session records; transcript text, tool output, timestamps, metadata và stable image attachments được bảo toàn |
| **Codex app** | ✅ | Captures supported local Codex app session records; transcript text, tool output, timestamps, metadata và stable image attachments được bảo toàn |
| **Claude Desktop local-agent sessions (macOS)** | ✅ | Supported local Claude Desktop agent session records khi có |
| **DeepSeek via Claude Code GUI** | ✅ | Khi Claude Code GUI ghi local records cho DeepSeek-backed sessions, transcript text, tool output, timestamps, metadata, skills folder snapshots, images và supported attachments được bảo toàn |
| **Qwen via Claude Code GUI** | ✅ | Khi Claude Code GUI ghi local records cho Qwen-backed sessions, transcript text, tool output, timestamps, metadata, skills folder snapshots, images và supported attachments được bảo toàn |
| **OpenClaw** | ✅ | Supported local OpenClaw session transcripts và metadata |
| **Cursor** | ✅ | Captures readable local Cursor `agent-transcripts` JSONL records, bao gồm text và tool blocks khi có |
| **Attachments** | ✅ | Encrypted image và supported file/PDF blocks, linked back về source sessions |
| **Skills folders** | ✅ | Global và project `SKILL.md` folder snapshots, gồm `SKILL.md` và included helper files, không chỉ skill name |

## Security At A Glance

- **Memory archive encryption**: transcripts, skills, attachments và local state được encrypted at rest bằng AES-256-GCM.
- **Owner-only local file permissions**: protected memory archive files, attachment blobs và state files được ghi với restrictive local filesystem modes.
- **Password handling**: passwords được lưu như `scrypt` verifiers, không phải plaintext.
- **Authenticator support**: TOTP hoạt động với standard authenticator apps như Google Authenticator, 1Password và Authy.
- **Recovery design**: mỗi memory archive có 24-word BIP39 recovery phrase.
- **Local-only UI**: UI bind tới `127.0.0.1` và dùng `HttpOnly` + `SameSite=Strict` cookies.
- **Reduced browser attack surface**: default Electron shell tránh normal general-purpose browser path; browser fallback vẫn có khi cần.
- **Local API write protection**: mutating requests phải đến từ same origin và có CSRF token.
- **Unlock retry hardening**: password, Touch ID và recovery failures back off thay vì cho phép unlimited rapid retries.
- **Trusted source updates only**: in-place git updates chỉ được cho allow-listed remotes / branches trên clean working tree.
- **Redacted diagnostics**: health, crash, log và audit artifacts scrub secrets trước khi ghi.
- **Key isolation**: Electron renderer hoặc browser fallback không nhận raw memory encryption key.
- **Auditability**: security-relevant local events được ghi vào hash-chained audit log. `datamoat audit verify` phát hiện changed hoặc broken entries trong current local log; nó không phải remote notarization service hay deletion-proof ledger.
- **Backup integrity**: viewer đọc sealed memory archive copy làm source of truth, không phải mutable live source transcript.

### Vì Sao 24 Words Thay Vì 12?

DataMoat dùng 24-word BIP39 phrase vì đó là long-lived recovery material cho high-value encrypted memory archive. 12-word BIP39 phrase có 128 bits of entropy, còn 24-word phrase có 256 bits. Twelve words vẫn mạnh, nhưng với recovery material có thể cần bảo vệ access nhiều năm, DataMoat chọn security margin lớn hơn.

### Memory Archive Được Bảo Vệ Như Thế Nào

```mermaid
flowchart TD
    A["Supported local transcripts"] --> B["Realtime watcher"]
    B --> C["Random memory encryption key"]
    C --> D["AES-256-GCM encrypted memory archive / attachments / state"]

    P["Password"] --> P2["scrypt verifier + wrapped release"]
    T["Packaged macOS app trên Macs được hỗ trợ"] --> T2["Secure Enclave-backed release + Touch ID"]
    G["TOTP authenticator"] --> G2["second-factor gate"]
    R["24-word phrase"] --> R2["recovery release path"]

    P2 --> H["Helper-owned active key session"]
    T2 --> H
    G2 --> H
    R2 --> H

    H --> D
    H --> U["Local UI / Electron shell"]
```

## Install

Signed / notarized macOS DMG là install path được khuyến nghị cho Mac users. Source install vẫn có cho Linux, development và fallback cases. macOS DMG có trong DataMoat release downloads tại [https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-macos-arm64.dmg](https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-macos-arm64.dmg) và gồm Secure Enclave + Touch ID unlock trên Macs được hỗ trợ, menu-bar auto-start at login, và packaged auto-update qua DataMoat R2 release feed. Windows x64 và ARM64 có dưới dạng unsigned ZIP + `DataMoat.exe` packages trong khi signed installer được hoàn thiện.

Release downloads:

[![Download macOS DMG](https://img.shields.io/badge/Download-macOS%20DMG-111827?style=for-the-badge&logo=apple&logoColor=white)](https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-macos-arm64.dmg?s=gh-vi)
[![Download Windows x64 ZIP + EXE](https://img.shields.io/badge/Download-Windows%20x64%20ZIP%20%2B%20EXE-2563EB?style=for-the-badge&logo=windows&logoColor=white)](https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-win32-x64.zip?s=gh-vi)
[![Download Windows ARM64 ZIP + EXE](https://img.shields.io/badge/Download-Windows%20ARM64%20ZIP%20%2B%20EXE-2563EB?style=for-the-badge&logo=windows&logoColor=white)](https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-win32-arm64.zip?s=gh-vi)

Mỗi Windows ZIP gồm `DataMoat.exe` và app files cần thiết. Unzip Windows package, giữ folder contents cùng nhau, và chạy `Install DataMoat.cmd` một lần. Việc đó launch DataMoat và register startup cho current Windows user để tray/background app quay lại sau login hoặc restart. Đây vẫn là portable ZIP package, chưa phải signed single-file installer.

### AI-Assisted Install

Với Mac users, dùng signed và notarized packaged DMG trước: [Download DMG](https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-macos-arm64.dmg?s=gh-vi). Đừng bắt đầu bằng `git clone` trên macOS trừ khi user rõ ràng muốn source install hoặc packaged release không khả dụng.

Bạn có thể nhờ ChatGPT export ZIP/folder imports, Claude CLI, Codex CLI hoặc OpenClaw cài DataMoat khi bạn đang nhìn target desktop.

Typical prompt:

```text
Cài DataMoat trên Mac này bằng latest signed macOS DMG từ DataMoat release downloads. Copy DataMoat.app vào Applications, launch nó, và báo tôi khi local setup UI xuất hiện để tôi tự hoàn tất password, authenticator, Touch ID và recovery steps trên protected desktop.
```

Important:

- AI agent có thể bắt đầu install và chuẩn bị app
- final recovery và unlock setup vẫn nên được human user hoàn tất trên protected machine
- nếu bạn dùng OpenClaw, Telegram, WhatsApp hoặc remote chat relay khác mà không thấy target desktop, hãy dùng dedicated remote no-screen flow bên dưới thay vì normal AI-assisted flow

### Remote No-Screen Install

Nếu install được bắt đầu qua OpenClaw, Codex hoặc remote chat relay trong khi bạn không thấy protected desktop, hãy dùng packaged macOS DMG hoặc Windows ZIP trước và launch installed app với single no-screen flag.

macOS remote prompt:

```text
Cài DataMoat trên Mac này bằng latest signed and notarized macOS DMG.

Không dùng git clone hoặc source install trừ khi DMG install fails.

Steps:
1. Download latest macOS DMG:
   https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-macos-arm64.dmg
2. Mount the DMG.
3. Copy DataMoat.app to ~/Applications.
4. Launch exactly:
   ~/Applications/DataMoat.app/Contents/MacOS/DataMoat --datamoat-remote-no-screen

Use only --datamoat-remote-no-screen for remote no-screen pre-setup capture.
Do not complete password, authenticator, Touch ID, or recovery phrase setup in this chat.

After launch, tell me:
DataMoat was installed from the DMG and remote no-screen capture was started. I must finish setup later on the protected desktop GUI.
```

Windows remote prompt:

```text
Cài DataMoat trên Windows machine này bằng latest Windows ZIP và DataMoat.exe.

Không dùng git clone hoặc source install.

Steps:
1. Download đúng latest Windows ZIP từ DataMoat release downloads:
   x64: https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-win32-x64.zip
   ARM64: https://downloads.datamoat.org/releases/v2.0.8/DataMoat-2.0.8-win32-arm64.zip
2. Extract ZIP vào Downloads.
3. Launch exactly:
   %USERPROFILE%\Downloads\DataMoat-win32-<arch>\DataMoat.exe --datamoat-remote-no-screen

Use DataMoat-win32-x64 for x64 or DataMoat-win32-arm64 for ARM64.
Use only --datamoat-remote-no-screen for remote no-screen pre-setup capture.
Do not complete password, authenticator, or recovery phrase setup in this chat.

After launch, tell me:
DataMoat was installed from the Windows ZIP and remote no-screen capture was started. I must finish setup later on the protected desktop GUI.
```

Manual macOS launch command after installing the DMG:

```bash
"$HOME/Applications/DataMoat.app/Contents/MacOS/DataMoat" --datamoat-remote-no-screen
```

Dùng mode này để ngăn password, authenticator enrollment secret, Touch ID prompt và 24-word recovery phrase xuất hiện trong Telegram, WhatsApp, OpenClaw chat, screenshots hoặc remote relay khác. DataMoat bắt đầu thu supported local records ngay bằng pre-setup encrypted capture, nhưng full unlock setup vẫn phải được hoàn tất sau trên protected desktop.

Sau khi remote install xong, agent nên báo DataMoat đã được cài thành công và đang capture supported local records. Khi bạn quay lại protected desktop, mở DataMoat ở đó và hoàn tất setup locally. Đừng hoàn tất password, authenticator, Touch ID hoặc recovery setup trong bot conversation.

Linux fallback when no DMG exists:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh --remote-no-screen
```

### Manual Install

Khuyến nghị cho source installs: dùng `git clone`.

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

Requirements:

- `Node.js 18+`
- `macOS` hoặc `Linux`
- `macOS`: Xcode Command Line Tools for local native builds
- `Linux`: normal Node build environment cho distro của bạn

First setup flow hiển thị recovery material locally:

- password
- authenticator enrollment secret / QR
- 24-word recovery phrase

Final memory setup nên được hoàn tất trên actual desktop screen của machine được bảo vệ, không relay qua chat apps, screenshots hoặc remote messaging channels.

## Commands

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

Audit verification kiểm tra integrity của audit log đang có trên disk. Nếu không có external checkpoint, nó không thể tự chứng minh local audit file chưa từng bị delete, truncate hoặc rewrite hoàn toàn bởi người có write access.

Live git source installs hỗ trợ in-place source updates. Packaged macOS installs dùng DataMoat R2 release downloads làm packaged update source: DMG dành cho first install, còn packaged updates sau đó download signed ZIP payload và apply qua macOS app updater thay vì yêu cầu users mount DMG mới cho mỗi release.

## Source Service Boundaries

DataMoat backup supported local transcript files đã có trên device của bạn và bạn đã có quyền truy cập.

Nó không cấp thêm quyền với content hoặc source services. Bạn vẫn chịu trách nhiệm tuân thủ terms, policies, plan restrictions và internal rules áp dụng cho ChatGPT, Claude, Codex, DeepSeek, Qwen, OpenClaw, Cursor và bất kỳ source service nào bạn dùng.

DataMoat được thiết kế để protect AI records đã tồn tại trên chính machine của bạn. Thay vì để sessions, skills, attachments và memory files rải rác ở known local paths hoặc phụ thuộc vào opaque memory plugins, nó thêm user-controlled local encryption, backup scope, recovery và auditability.

DataMoat cũng có thể preserve và move over images, files/PDFs, generated assets và attachments qua captured versions hoặc alternate conversation branches khi các records đó đã tồn tại locally. Nhiều AI memory plugins và simple export tools dừng ở text; DataMoat giữ surrounding files cùng với work history đã tạo ra chúng.

DataMoat does not create new access tới AI work history của bạn. Nó protect local records đã tồn tại trên computer của bạn trong source-tool folders, exports, logs, attachments hoặc session stores, những nơi có thể vẫn scattered, readable và unencrypted.

Nhiều AI tools đã store work history như ordinary local files trên computer. Bất kỳ người hoặc process nào có access tới user account, disk, backups hoặc source-tool folders đó đều có thể read các records này trước khi DataMoat protect chúng. DataMoat không làm data này exposed hơn; nó move selected already-present records vào encrypted archive do user kiểm soát.

DataMoat backup scope được control bởi user và bởi source records đã available trên protected machine. Nó không bypass account permissions, không unlock remote services và không grant rights vượt quá những gì user đã có trên computer đó.

## Threat model: why installing can reduce local exposure

### Vì sao không làm gì cũng có thể rủi ro

DataMoat không yêu cầu bạn tạo một sensitive dataset mới từ con số không. Với nhiều AI tools, dataset đó đã tồn tại trên computer của bạn dưới dạng local transcripts, logs, exports, SQLite records, JSONL files, attachments và skills folders.

Nếu không có dedicated archive, những records này có thể vẫn nằm rải rác trong predictable local paths như ordinary files chỉ được kiểm soát bởi OS account permissions thông thường. Việc của DataMoat là giúp bạn nhận diện những records đó, copy selected supported records vào local encrypted vault, và giữ một recoverable, searchable, auditable archive dưới control của bạn.

### Trước DataMoat

Nhiều AI tools đã lưu transcripts, tool output, attachments, project context, và đôi khi reasoning-related blocks như ordinary local files. Các files này có thể nằm trong known application folders, exports, logs, SQLite databases, JSONL transcripts và attachment caches. Bất kỳ process nào chạy với cùng OS user đều có thể đã đọc được một phần trong số đó.

### DataMoat làm gì

DataMoat không tạo new access tới remote AI services và không bypass OS permissions. Nó chỉ đọc records đã available cho current local user, rồi lưu selected supported records vào user-controlled local encrypted archive. Supported local read paths và capture reasons đều visible trong public application code để review; DataMoat không dùng hidden cloud collection hay undisclosed remote capture.

### DataMoat không tự động giải quyết điều gì

DataMoat không tự động xóa original source files. Trừ khi user chọn cleanup/export workflow, original records vẫn có thể còn trong folders của source apps. DataMoat giảm scattered plaintext exposure bằng cách tạo protected encrypted copy; nó không thay thế endpoint security, disk encryption hay source-app retention policy.

### Tradeoff chính

Cài DataMoat sẽ thêm một local watcher/importer process có access tới selected AI record locations. Đổi lại, users có searchable encrypted archive, recovery path, audit log và portable backup thay vì để AI work quan trọng nằm rải rác trong unencrypted local files.

Windows packages hiện là unsigned manual builds trong khi signed installer đang được thực hiện. Codebase là public for review; teams cần signed hoặc managed builds có thể contact us.

Bạn không cần là power user để bắt đầu owning your AI work history. DataMoat cho phép bạn bắt đầu với một local archive nhỏ hôm nay, rồi thấy value của nó compound khi conversations, files, prompts và project context tăng lên.

## Enterprise

Enterprise deployment và management features nằm trên roadmap. Nhiều enterprise-focused capabilities khác sẽ đến; star và watch repository này để theo dõi updates.

## Consultation and Support

Câu hỏi hoặc deployment help:

<img src=".github/assets/contact-email.png" alt="Contact email" width="360">

## License

DataMoat được open-sourced theo **Business Source License 1.1 (`BUSL-1.1`)** với **Additional Use Grant**.

Điều này nghĩa là:

- personal use được phép
- internal company use được phép
- uses ngoài grant này cần separate commercial license từ licensor

Chúng tôi chọn **BUSL-1.1** để giữ code auditable trong khi giảm rủi ro từ misleading repackaged builds, malware clones và unsupported commercial forks của một security-sensitive local archive tool. Toàn bộ application code là public for review.

Xem [LICENSE.md](LICENSE.md) để biết đầy đủ điều khoản.

---

## Official Website

Website DataMoat chính thức: [https://datamoat.org](https://datamoat.org)
