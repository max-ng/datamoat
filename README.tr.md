# DataMoat

Dil: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

Resmi site: [https://datamoat.org](https://datamoat.org)
GitHub deposu: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Claude, Codex, Cursor, DeepSeek, Qwen ve OpenClaw verilerinizi, skills klasörlerinizi ve eklerinizi dışa aktarın ve yedekleyin." width="100%">

> **Claude / Codex / Cursor / DeepSeek / Qwen verilerinizi, skills klasörlerinizi ve eklerinizi dışa aktarın ve yedekleyin.**
> DataMoat, AI çalışma geçmişinizi yerel ve şifreli tutar; ham kaynak kayıtlarını korur ve arama, dışa aktarma, yeniden kullanım, devir ve özel AI hafızası için normalleştirilmiş bir indeks oluşturur.
>
> **Gelecekte en değerli olacak AI verileriniz şimdiden kayboluyor olabilir.**
> DataMoat'ı kurarak Claude, Codex, Cursor, OpenClaw, DeepSeek ve Qwen çalışma geçmişinizin ne kadarını hâlâ yakalayabileceğinizi görün.

## DataMoat Ne Saklar

DataMoat; Claude CLI, Claude Desktop, Codex CLI, Codex app, Cursor, OpenClaw, DeepSeek ve Qwen kullanan kişiler ve ekipler için yerel, şifreli bir AI work history memory archive'dır.

Oturumları, promptları, yanıtları, araç çıktısını, metadataları, ekleri, görselleri, desteklenen dosya/PDF bloklarını, `SKILL.md` klasörlerini ve aynı makinedeki orijinal yerel kayıtları saklar.

## Hafıza Arşivi Nasıl Çalışır

- **Ham arşiv:** JSONL, SQLite, loglar, ekler, metadata ve skills klasörü snapshotları kaynağa yakın formatta korunur.
- **Normalleştirilmiş indeks:** Farklı araçlardan gelen kayıtlar ortak bir şemaya çevrilir; arama, inceleme, dışa aktarma, analiz ve yeniden kullanım kolaylaşır.
- **Yerel kontrol:** Şifreli hafıza arşivi kendi makinenizde kalır ve yalnızca onaylı unlock/recovery yollarıyla okunur.

## Neden Kurmalısınız

- Bilgisayar değişimi, temizlik, context compaction veya ortam kaybından sonra AI çalışma geçmişini geri alabilirsiniz.
- Eski promptları, çözümleri, kararları, araç çıktılarını ve ekleri dışa aktarıp yeniden kullanabilirsiniz.
- Skills, oturumlar ve çalışma bağlamını aynı şifreli hafıza arşivinde saklayabilirsiniz.
- Önemli AI work history kayıtlarını aranabilir, taşınabilir, devredilebilir ve denetlenebilir tutabilirsiniz.

## Bugün Desteklenenler

| Kaynak | Durum | DataMoat'ın sakladıkları |
|---|---|---|
| Claude CLI | Desteklenir | Yerel transcript ve kaynak diske yazdığında thinking/reasoning blocks |
| Codex CLI / Codex app | Desteklenir | Yerel oturumlar, metin, araç çıktısı, zaman damgaları, metadata ve stabil ekler |
| macOS Claude Desktop local-agent | Desteklenir | Varsa yerel agent oturumları |
| DeepSeek / Qwen via Claude Code GUI | Desteklenir | Yerel kayıtlar, skills, görseller ve desteklenen ekler |
| Cursor | Desteklenir | Okunabilir yerel `agent-transcripts` |
| OpenClaw | Desteklenir | Yerel transcript ve metadata |
| Skills folders | Desteklenir | `SKILL.md` ve yardımcı dosyaların snapshotları |

## Kurulum

macOS: [imzalı DMG indir](https://datamoat.org/download/macos)
Windows x64: [ZIP + EXE indir](https://datamoat.org/download/windows-x64)
Windows ARM64: [ZIP + EXE indir](https://datamoat.org/download/windows-arm64)

Kaynak koddan kurulum:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## Güvenlik

- Oturumlar, skills, ekler ve durum AES-256-GCM ile yerel olarak şifrelenir.
- Parolalar düz metin değil, `scrypt` verifier olarak saklanır.
- TOTP ve 24 kelimelik BIP39 recovery phrase desteği vardır.
- Yerel UI `127.0.0.1` adresine bağlanır ve `HttpOnly` + `SameSite=Strict` cookie kullanır.
- Yerel audit log hash chain ile tutulur ve `datamoat audit verify` ile doğrulanabilir.

## Komutlar

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## Lisans

DataMoat, **Business Source License 1.1 (`BUSL-1.1`)** ve **Additional Use Grant** ile dağıtılır. Kişisel kullanım ve şirket içi kullanım izinlidir; bu kapsam dışındaki kullanımlar ayrı bir ticari lisans gerektirebilir. Bu proje **source-available** durumundadır; OSI onaylı open source değildir.

Tam şartlar için [LICENSE.md](LICENSE.md) dosyasına bakın.
