# DataMoat

Idioma: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

Site oficial: [https://datamoat.org](https://datamoat.org)
Repositório GitHub: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Exporte e faça backup dos seus dados, habilidades e anexos do Claude, Codex, Cursor, DeepSeek, Qwen e OpenClaw." width="100%">

> **Exporte e faça backup de todos os seus dados, skills e anexos do Claude / Codex / Cursor / DeepSeek / Qwen.**
> O DataMoat mantém seu histórico de trabalho com IA local e criptografado, preserva os registros originais e cria um índice normalizado para busca, exportação, reutilização, handoff e memória privada de IA.
>
> **Seus dados de IA mais valiosos já podem estar desaparecendo.**
> Instale o DataMoat para ver quanto histórico do Claude, Codex, Cursor, OpenClaw, DeepSeek e Qwen ainda pode ser capturado.

## O Que O DataMoat Salva

O DataMoat cria um arquivo de memória local e criptografado para pessoas e equipes que trabalham com Claude CLI, Claude Desktop, Codex CLI, Codex app, Cursor, OpenClaw, DeepSeek e Qwen por meio de fluxos locais compatíveis.

Ele preserva sessões, prompts, respostas, saída de ferramentas, metadados, anexos, imagens, arquivos/PDFs compatíveis, pastas `SKILL.md` e registros originais gravados na máquina.

## Como A Memória É Guardada

- **Arquivo bruto:** JSONL, SQLite, logs, anexos, metadados e snapshots de skills são preservados o mais próximo possível do formato original.
- **Índice normalizado:** registros de ferramentas diferentes entram em um esquema comum para busca, revisão, exportação, análise e reutilização.
- **Controle local:** o arquivo criptografado fica na sua máquina. A interface local desbloqueia a memória apenas pelos caminhos aprovados.

## Por Que Instalar

- Recuperar o histórico de trabalho com IA depois de troca de computador, limpeza, compactação ou perda de ambiente.
- Exportar e reutilizar prompts, soluções, decisões, saídas de ferramentas e anexos.
- Guardar skills e contexto de trabalho junto com as sessões.
- Manter um arquivo criptografado que pode ser revisado, migrado e entregue para outra pessoa depois.

## Compatível Hoje

| Fonte | Status | O que é preservado |
|---|---|---|
| Claude CLI | Suportado | Transcrições locais e blocos gravados localmente quando existem |
| Codex CLI / Codex app | Suportado | Sessões locais, texto, ferramentas, timestamps, metadados e anexos estáveis |
| Claude Desktop local-agent no macOS | Suportado | Sessões locais compatíveis quando presentes |
| DeepSeek / Qwen via Claude Code GUI | Suportado | Registros locais, skills, imagens e anexos compatíveis |
| Cursor | Suportado | `agent-transcripts` locais legíveis |
| OpenClaw | Suportado | Transcrições locais e metadados |
| Pastas de skills | Suportado | Snapshots de `SKILL.md` e arquivos auxiliares |

## Instalação

macOS: [baixar DMG assinado](https://datamoat.org/download/macos)
Windows x64: [baixar ZIP + EXE](https://datamoat.org/download/windows-x64)
Windows ARM64: [baixar ZIP + EXE](https://datamoat.org/download/windows-arm64)

Instalação por código-fonte:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## Segurança

- Criptografia local AES-256-GCM para sessões, skills, anexos e estado.
- Senhas armazenadas como verificadores `scrypt`, não em texto puro.
- Suporte a TOTP e frase de recuperação BIP39 de 24 palavras.
- UI local em `127.0.0.1` com cookies `HttpOnly` e `SameSite=Strict`.
- Log de auditoria local encadeado por hash e verificável com `datamoat audit verify`.

## Comandos

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## Licença

O DataMoat é distribuído sob a **Business Source License 1.1 (`BUSL-1.1`)** com uma **Additional Use Grant**. Uso pessoal e uso interno em empresas são permitidos; outros usos podem exigir licença comercial. Este projeto é **source-available**, não open source aprovado pela OSI.

Veja [LICENSE.md](LICENSE.md) para os termos completos.
