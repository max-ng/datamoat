# DataMoat

言語: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

公式サイト: [https://datamoat.org](https://datamoat.org)
GitHub リポジトリ: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Claude、Codex、Cursor、DeepSeek、Qwen、OpenClaw のデータ、スキル、添付ファイルをエクスポートしてバックアップします。" width="100%">

> **Claude / Codex / Cursor / DeepSeek / Qwen のデータ、skills、添付ファイルをまとめてエクスポートし、バックアップします。**
> DataMoat は AI 作業履歴をローカルで暗号化して保存し、元の記録を保ったまま検索、エクスポート、再利用、引き継ぎ、プライベート AI メモリのための統一インデックスを作ります。
>
> **将来いちばん価値を持つ AI データは、すでに消え始めているかもしれません。**
> DataMoat をインストールして、Claude、Codex、Cursor、OpenClaw、DeepSeek、Qwen の作業履歴をどれだけまだ保存できるか確認してください。

## DataMoat が保存するもの

DataMoat は、Claude CLI、Claude Desktop、Codex CLI、Codex app、Cursor、OpenClaw、DeepSeek、Qwen を使う個人とチームのための、ローカル暗号化 AI work history memory archive です。

セッション、プロンプト、回答、ツール出力、メタデータ、添付ファイル、画像、対応するファイル/PDF、`SKILL.md` フォルダ、同じマシン上にある元のローカル記録を保存します。

## メモリアーカイブの仕組み

- **Raw archive:** JSONL、SQLite、ログ、添付ファイル、メタデータ、skills フォルダのスナップショットを、できるだけ元の形式に近い形で保存します。
- **Normalized index:** さまざまなツールの記録を共通スキーマに変換し、検索、確認、エクスポート、分析、再利用をしやすくします。
- **Local control:** 暗号化されたメモリアーカイブは自分のマシンに残り、承認された解除/復旧経路からだけ読めます。

## インストールする理由

- PC 交換、クリーンアップ、コンテキスト圧縮、環境消失の後でも AI 作業履歴を取り戻せます。
- 過去のプロンプト、解決策、判断、ツール出力、添付ファイルをエクスポートして再利用できます。
- skills、セッション、作業コンテキストを同じ暗号化メモリアーカイブに保存できます。
- 重要な AI work history を検索、移行、引き継ぎ、監査できる形で残せます。

## 現在対応しているもの

| ソース | 状態 | DataMoat が保存する内容 |
|---|---|---|
| Claude CLI | 対応 | ローカル transcript と、ソースが保存する場合の thinking/reasoning blocks |
| Codex CLI / Codex app | 対応 | ローカルセッション、テキスト、ツール出力、時刻、メタデータ、安定した添付ファイル |
| macOS Claude Desktop local-agent | 対応 | 存在する場合のローカル agent セッション |
| DeepSeek / Qwen via Claude Code GUI | 対応 | ローカル記録、skills、画像、対応添付ファイル |
| Cursor | 対応 | 読み取り可能なローカル `agent-transcripts` |
| OpenClaw | 対応 | ローカル transcript とメタデータ |
| Skills folders | 対応 | `SKILL.md` と補助ファイルのスナップショット |

## インストール

macOS: [署名済み DMG をダウンロード](https://datamoat.org/download/macos)
Windows x64: [ZIP + EXE をダウンロード](https://datamoat.org/download/windows-x64)
Windows ARM64: [ZIP + EXE をダウンロード](https://datamoat.org/download/windows-arm64)

ソースからインストール:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## セキュリティ

- セッション、skills、添付ファイル、状態を AES-256-GCM でローカル暗号化。
- パスワードは平文ではなく `scrypt` verifier として保存。
- TOTP と 24 語の BIP39 recovery phrase に対応。
- ローカル UI は `127.0.0.1` にバインドし、`HttpOnly` + `SameSite=Strict` cookie を使用。
- ローカル監査ログは hash chain で、`datamoat audit verify` で検証できます。

## コマンド

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## ライセンス

DataMoat は **Business Source License 1.1 (`BUSL-1.1`)** と **Additional Use Grant** のもとで配布されています。個人利用と社内利用は許可されています。それ以外の利用には商用ライセンスが必要になる場合があります。このプロジェクトは **source-available** であり、OSI 承認の open source ではありません。

詳細は [LICENSE.md](LICENSE.md) を参照してください。
