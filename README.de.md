# DataMoat

Sprache: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

Offizielle Website: [https://datamoat.org](https://datamoat.org)
GitHub-Repository: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Exportieren und sichern Sie Claude-, Codex-, Cursor-, DeepSeek-, Qwen- und OpenClaw-Daten, Skills und Anhänge." width="100%">

> **Exportieren und sichern Sie alle Claude / Codex / Cursor / DeepSeek / Qwen Daten, Skills und Anhänge.**
> DataMoat hält Ihre AI-Arbeitshistorie lokal und verschlüsselt, bewahrt die ursprünglichen Quellaufzeichnungen und erstellt einen normalisierten Index für Suche, Export, Wiederverwendung, Übergabe und private AI memory.
>
> **Ihre wertvollsten zukünftigen AI-Daten könnten bereits verschwinden.**
> Installieren Sie DataMoat, um zu sehen, wie viel Claude-, Codex-, Cursor-, OpenClaw-, DeepSeek- und Qwen-Arbeitshistorie Sie noch erfassen können.

## Was DataMoat Speichert

DataMoat ist ein lokal verschlüsseltes AI work history memory archive für Personen und Teams, die mit Claude CLI, Claude Desktop, Codex CLI, Codex app, Cursor, OpenClaw, DeepSeek und Qwen arbeiten.

Es speichert Sessions, Prompts, Antworten, Tool-Ausgaben, Metadaten, Anhänge, Bilder, unterstützte Dateien/PDFs, `SKILL.md`-Ordner und ursprüngliche lokale Quellaufzeichnungen auf derselben Maschine.

## Wie Das Memory Archive Funktioniert

- **Raw archive:** JSONL, SQLite, Logs, Anhänge, Metadaten und Snapshots von Skills-Ordnern werden so nah wie möglich am Originalformat bewahrt.
- **Normalized index:** Aufzeichnungen aus verschiedenen Tools werden in ein gemeinsames Schema übertragen, damit Suche, Review, Export, Analyse und Wiederverwendung leichter werden.
- **Local control:** Das verschlüsselte Memory Archive bleibt auf Ihrer Maschine und kann nur über genehmigte Unlock-/Recovery-Pfade gelesen werden.

## Warum Installieren

- AI-Arbeitshistorie nach Gerätewechsel, Cleanup, Context Compaction oder Verlust einer Umgebung wiederherstellen.
- Frühere Prompts, Lösungen, Entscheidungen, Tool-Ausgaben und Anhänge exportieren und wiederverwenden.
- Skills, Sessions und Arbeitskontext im selben verschlüsselten Memory Archive sichern.
- Wichtige AI work history suchbar, migrierbar, übergabefähig und auditierbar halten.

## Heute Unterstützt

| Quelle | Status | Was DataMoat bewahrt |
|---|---|---|
| Claude CLI | Unterstützt | Lokale Transcripts und thinking/reasoning blocks, wenn die Quelle sie auf die Festplatte schreibt |
| Codex CLI / Codex app | Unterstützt | Lokale Sessions, Text, Tool-Ausgabe, Zeitstempel, Metadaten und stabile Anhänge |
| macOS Claude Desktop local-agent | Unterstützt | Lokale Agent-Sessions, wenn vorhanden |
| DeepSeek / Qwen via Claude Code GUI | Unterstützt | Lokale Aufzeichnungen, Skills, Bilder und unterstützte Anhänge |
| Cursor | Unterstützt | Lesbare lokale `agent-transcripts` |
| OpenClaw | Unterstützt | Lokale Transcripts und Metadaten |
| Skills folders | Unterstützt | Snapshots von `SKILL.md` und Hilfsdateien |

## Installation

macOS: [signiertes DMG herunterladen](https://datamoat.org/download/macos)
Windows x64: [ZIP + EXE herunterladen](https://datamoat.org/download/windows-x64)
Windows ARM64: [ZIP + EXE herunterladen](https://datamoat.org/download/windows-arm64)

Installation aus dem Quellcode:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## Sicherheit

- Lokale AES-256-GCM-Verschlüsselung für Sessions, Skills, Anhänge und State.
- Passwörter werden als `scrypt` verifier gespeichert, nicht im Klartext.
- Unterstützung für TOTP und eine 24-word BIP39 recovery phrase.
- Lokales UI bindet an `127.0.0.1` und nutzt `HttpOnly` + `SameSite=Strict` Cookies.
- Lokaler Audit-Log ist hash-chained und mit `datamoat audit verify` prüfbar.

## Befehle

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## Lizenz

DataMoat wird unter der **Business Source License 1.1 (`BUSL-1.1`)** mit einem **Additional Use Grant** verteilt. Persönliche Nutzung und interne Unternehmensnutzung sind erlaubt; andere Nutzungen können eine separate kommerzielle Lizenz erfordern. Dieses Projekt ist **source-available**, aber kein OSI-approved open source.

Die vollständigen Bedingungen stehen in [LICENSE.md](LICENSE.md).
