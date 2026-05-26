# DataMoat

Ngôn ngữ: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

Website chính thức: [https://datamoat.org](https://datamoat.org)
Kho GitHub: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Export và backup dữ liệu, skills và tệp đính kèm của Claude, Codex, Cursor, DeepSeek, Qwen và OpenClaw." width="100%">

> **Export và backup toàn bộ dữ liệu, skills và tệp đính kèm của Claude / Codex / Cursor / DeepSeek / Qwen.**
> DataMoat giữ lịch sử làm việc AI của bạn ở local và được mã hóa, bảo toàn bản ghi gốc và tạo một chỉ mục thống nhất để tìm kiếm, export, tái sử dụng, bàn giao và dùng làm AI memory riêng tư.
>
> **Dữ liệu AI quý nhất trong tương lai của bạn có thể đang biến mất.**
> Cài DataMoat để xem còn có thể capture được bao nhiêu lịch sử làm việc từ Claude, Codex, Cursor, OpenClaw, DeepSeek và Qwen.

## DataMoat Lưu Những Gì

DataMoat là một AI work history memory archive được mã hóa tại local cho cá nhân và đội nhóm dùng Claude CLI, Claude Desktop, Codex CLI, Codex app, Cursor, OpenClaw, DeepSeek và Qwen.

Nó lưu session, prompt, câu trả lời, output của công cụ, metadata, tệp đính kèm, ảnh, file/PDF được hỗ trợ, thư mục `SKILL.md` và bản ghi nguồn local trên cùng máy.

## Cách Memory Archive Hoạt Động

- **Raw archive:** JSONL, SQLite, log, tệp đính kèm, metadata và snapshot thư mục skills được giữ gần với định dạng gốc nhất có thể.
- **Normalized index:** bản ghi từ nhiều công cụ được chuyển thành schema chung để tìm kiếm, xem lại, export, phân tích và tái sử dụng.
- **Local control:** archive mã hóa nằm trên máy của bạn và chỉ được đọc qua các đường unlock/recovery được chấp thuận.

## Vì Sao Nên Cài

- Khôi phục lịch sử làm việc AI sau khi đổi máy, dọn cache, context compaction hoặc mất môi trường.
- Export và tái sử dụng prompt cũ, giải pháp, quyết định, output công cụ và tệp đính kèm.
- Lưu skills, session và ngữ cảnh làm việc trong cùng một memory archive mã hóa.
- Giữ AI work history quan trọng ở dạng có thể tìm kiếm, di chuyển, bàn giao và audit.

## Hỗ Trợ Hiện Tại

| Nguồn | Trạng thái | DataMoat lưu gì |
|---|---|---|
| Claude CLI | Hỗ trợ | Local transcript và thinking/reasoning blocks nếu nguồn ghi ra ổ đĩa |
| Codex CLI / Codex app | Hỗ trợ | Local session, text, tool output, timestamp, metadata và attachment ổn định |
| macOS Claude Desktop local-agent | Hỗ trợ | Local agent session nếu có |
| DeepSeek / Qwen via Claude Code GUI | Hỗ trợ | Local record, skills, ảnh và attachment được hỗ trợ |
| Cursor | Hỗ trợ | Local `agent-transcripts` có thể đọc |
| OpenClaw | Hỗ trợ | Local transcript và metadata |
| Skills folders | Hỗ trợ | Snapshot của `SKILL.md` và file hỗ trợ |

## Cài Đặt

macOS: [tải DMG đã ký](https://datamoat.org/download/macos)
Windows x64: [tải ZIP + EXE](https://datamoat.org/download/windows-x64)
Windows ARM64: [tải ZIP + EXE](https://datamoat.org/download/windows-arm64)

Cài từ source:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## Bảo Mật

- Mã hóa local AES-256-GCM cho session, skills, attachment và state.
- Mật khẩu được lưu dưới dạng `scrypt` verifier, không phải plaintext.
- Hỗ trợ TOTP và 24-word BIP39 recovery phrase.
- UI local bind vào `127.0.0.1` và dùng cookie `HttpOnly` + `SameSite=Strict`.
- Audit log local dùng hash chain và có thể kiểm tra bằng `datamoat audit verify`.

## Lệnh

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## Giấy Phép

DataMoat được phát hành theo **Business Source License 1.1 (`BUSL-1.1`)** cùng **Additional Use Grant**. Cho phép sử dụng cá nhân và sử dụng nội bộ công ty; các trường hợp khác có thể cần giấy phép thương mại riêng. Dự án này là **source-available**, không phải open source được OSI phê duyệt.

Xem [LICENSE.md](LICENSE.md) để biết đầy đủ điều khoản.
