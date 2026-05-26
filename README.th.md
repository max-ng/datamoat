# DataMoat

ภาษา: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

เว็บไซต์ทางการ: [https://datamoat.org](https://datamoat.org)
GitHub repo: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Export และ backup ข้อมูล skills และไฟล์แนบของ Claude, Codex, Cursor, DeepSeek, Qwen และ OpenClaw." width="100%">

> **Export และ backup ข้อมูล, skills และไฟล์แนบทั้งหมดของ Claude / Codex / Cursor / DeepSeek / Qwen.**
> DataMoat เก็บประวัติการทำงานกับ AI ไว้ในเครื่องแบบเข้ารหัส รักษาบันทึกต้นฉบับ และสร้างดัชนีรวมสำหรับค้นหา export ใช้ซ้ำ ส่งต่องาน และทำเป็น AI memory ส่วนตัว
>
> **ข้อมูล AI ที่มีค่าที่สุดในอนาคตของคุณอาจกำลังหายไปแล้ว**
> ติดตั้ง DataMoat เพื่อดูว่ายัง capture ประวัติการทำงานจาก Claude, Codex, Cursor, OpenClaw, DeepSeek และ Qwen ได้มากแค่ไหน

## DataMoat เก็บอะไรบ้าง

DataMoat คือ AI work history memory archive แบบ local และเข้ารหัส สำหรับคนและทีมที่ใช้ Claude CLI, Claude Desktop, Codex CLI, Codex app, Cursor, OpenClaw, DeepSeek และ Qwen

มันเก็บ session, prompt, คำตอบ, tool output, metadata, ไฟล์แนบ, รูปภาพ, ไฟล์/PDF ที่รองรับ, โฟลเดอร์ `SKILL.md` และบันทึกต้นฉบับที่อยู่บนเครื่องเดียวกัน

## Memory Archive ทำงานอย่างไร

- **Raw archive:** เก็บ JSONL, SQLite, log, ไฟล์แนบ, metadata และ snapshot ของ skills folder ให้ใกล้เคียง format ต้นฉบับที่สุด
- **Normalized index:** แปลงบันทึกจากหลายเครื่องมือให้เป็น schema เดียวกัน เพื่อค้นหา ตรวจทาน export วิเคราะห์ และใช้ซ้ำได้ง่าย
- **Local control:** archive ที่เข้ารหัสอยู่บนเครื่องของคุณ และอ่านได้ผ่านทาง unlock/recovery ที่ได้รับอนุญาตเท่านั้น

## ทำไมควรติดตั้ง

- กู้คืนประวัติการทำงาน AI หลังเปลี่ยนเครื่อง ล้างข้อมูล context compaction หรือสูญเสีย environment
- Export และใช้ซ้ำ prompt เก่า วิธีแก้ปัญหา การตัดสินใจ tool output และไฟล์แนบ
- เก็บ skills, session และบริบทงานไว้ใน memory archive เข้ารหัสเดียวกัน
- ทำให้ AI work history สำคัญค้นหา ย้ายเครื่อง ส่งต่อ และ audit ได้

## รองรับตอนนี้

| แหล่งข้อมูล | สถานะ | DataMoat เก็บอะไร |
|---|---|---|
| Claude CLI | รองรับ | Local transcript และ thinking/reasoning blocks เมื่อ source เขียนลง disk |
| Codex CLI / Codex app | รองรับ | Local session, text, tool output, timestamp, metadata และ attachment ที่เสถียร |
| macOS Claude Desktop local-agent | รองรับ | Local agent session เมื่อมีอยู่ |
| DeepSeek / Qwen via Claude Code GUI | รองรับ | Local records, skills, รูปภาพ และ attachment ที่รองรับ |
| Cursor | รองรับ | Local `agent-transcripts` ที่อ่านได้ |
| OpenClaw | รองรับ | Local transcript และ metadata |
| Skills folders | รองรับ | Snapshot ของ `SKILL.md` และไฟล์ช่วยเหลือ |

## ติดตั้ง

macOS: [ดาวน์โหลด DMG ที่ signed แล้ว](https://datamoat.org/download/macos)
Windows x64: [ดาวน์โหลด ZIP + EXE](https://datamoat.org/download/windows-x64)
Windows ARM64: [ดาวน์โหลด ZIP + EXE](https://datamoat.org/download/windows-arm64)

ติดตั้งจาก source:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## ความปลอดภัย

- เข้ารหัส local ด้วย AES-256-GCM สำหรับ session, skills, attachment และ state
- รหัสผ่านถูกเก็บเป็น `scrypt` verifier ไม่ใช่ plaintext
- รองรับ TOTP และ 24-word BIP39 recovery phrase
- UI local bind กับ `127.0.0.1` และใช้ cookie `HttpOnly` + `SameSite=Strict`
- Audit log local ใช้ hash chain และตรวจได้ด้วย `datamoat audit verify`

## คำสั่ง

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## License

DataMoat เผยแพร่ภายใต้ **Business Source License 1.1 (`BUSL-1.1`)** พร้อม **Additional Use Grant** อนุญาตให้ใช้ส่วนตัวและใช้ภายในบริษัทได้ กรณีอื่นอาจต้องใช้ commercial license แยกต่างหาก โปรเจกต์นี้เป็น **source-available** ไม่ใช่ open source ที่ OSI อนุมัติ

ดูเงื่อนไขทั้งหมดที่ [LICENSE.md](LICENSE.md)
