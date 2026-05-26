# DataMoat

언어: [English](./README.md) | [Português (Brasil)](./README.pt-BR.md) | [简体中文](./README.zh-CN.md) | [繁體中文](./README.zh-HK.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Türkçe](./README.tr.md) | [Русский](./README.ru.md) | [Tiếng Việt](./README.vi.md) | [ไทย](./README.th.md) | [Deutsch](./README.de.md)

공식 웹사이트: [https://datamoat.org](https://datamoat.org)
GitHub 저장소: [https://github.com/max-ng/datamoat](https://github.com/max-ng/datamoat)

<img src=".github/assets/readme-brand-hero.svg" alt="Claude, Codex, Cursor, DeepSeek, Qwen, OpenClaw 데이터, skills, 첨부 파일을 내보내고 백업합니다." width="100%">

> **Claude / Codex / Cursor / DeepSeek / Qwen 데이터, skills, 첨부 파일을 모두 export하고 backup합니다.**
> DataMoat는 AI 작업 기록을 로컬에서 암호화해 보관하고, 원본 기록을 보존하면서 검색, export, 재사용, 인수인계, 개인 AI memory를 위한 통합 인덱스를 만듭니다.
>
> **앞으로 가장 가치 있는 AI 데이터는 이미 사라지고 있을 수 있습니다.**
> DataMoat를 설치해 Claude, Codex, Cursor, OpenClaw, DeepSeek, Qwen 작업 기록을 얼마나 더 캡처할 수 있는지 확인하세요.

## DataMoat가 저장하는 것

DataMoat는 Claude CLI, Claude Desktop, Codex CLI, Codex app, Cursor, OpenClaw, DeepSeek, Qwen을 사용하는 개인과 팀을 위한 로컬 암호화 AI work history memory archive입니다.

세션, 프롬프트, 응답, 도구 출력, 메타데이터, 첨부 파일, 이미지, 지원되는 파일/PDF, `SKILL.md` 폴더, 같은 컴퓨터에 있는 원본 로컬 기록을 저장합니다.

## 메모리 아카이브 구조

- **Raw archive:** JSONL, SQLite, 로그, 첨부 파일, 메타데이터, skills 폴더 스냅샷을 가능한 한 원본 형식에 가깝게 보존합니다.
- **Normalized index:** 여러 도구의 기록을 공통 스키마로 변환해 검색, 검토, export, 분석, 재사용을 쉽게 합니다.
- **Local control:** 암호화된 메모리 아카이브는 내 컴퓨터에 남고, 승인된 unlock/recovery 경로로만 읽을 수 있습니다.

## 설치해야 하는 이유

- 기기 교체, 정리, context compaction, 환경 손실 이후에도 AI 작업 기록을 복구할 수 있습니다.
- 과거 프롬프트, 해결책, 판단 과정, 도구 출력, 첨부 파일을 export하고 재사용할 수 있습니다.
- skills, 세션, 작업 맥락을 같은 암호화 메모리 아카이브에 보관할 수 있습니다.
- 중요한 AI work history를 검색, 이동, 인수인계, 감사 가능한 형태로 남길 수 있습니다.

## 현재 지원

| 소스 | 상태 | DataMoat가 보존하는 내용 |
|---|---|---|
| Claude CLI | 지원 | 로컬 transcript 및 소스가 저장하는 thinking/reasoning blocks |
| Codex CLI / Codex app | 지원 | 로컬 세션, 텍스트, 도구 출력, 타임스탬프, 메타데이터, 안정적인 첨부 파일 |
| macOS Claude Desktop local-agent | 지원 | 존재하는 경우 로컬 agent 세션 |
| DeepSeek / Qwen via Claude Code GUI | 지원 | 로컬 기록, skills, 이미지, 지원 첨부 파일 |
| Cursor | 지원 | 읽을 수 있는 로컬 `agent-transcripts` |
| OpenClaw | 지원 | 로컬 transcript 및 메타데이터 |
| Skills folders | 지원 | `SKILL.md` 및 보조 파일 스냅샷 |

## 설치

macOS: [서명된 DMG 다운로드](https://datamoat.org/download/macos)
Windows x64: [ZIP + EXE 다운로드](https://datamoat.org/download/windows-x64)
Windows ARM64: [ZIP + EXE 다운로드](https://datamoat.org/download/windows-arm64)

소스 설치:

```bash
git clone <repository-url> datamoat
cd datamoat
bash install.sh
datamoat
```

## 보안

- 세션, skills, 첨부 파일, 상태를 AES-256-GCM으로 로컬 암호화합니다.
- 비밀번호는 평문이 아니라 `scrypt` verifier로 저장됩니다.
- TOTP와 24단어 BIP39 recovery phrase를 지원합니다.
- 로컬 UI는 `127.0.0.1`에 바인딩되고 `HttpOnly` + `SameSite=Strict` cookie를 사용합니다.
- 로컬 감사 로그는 hash chain으로 연결되며 `datamoat audit verify`로 검증할 수 있습니다.

## 명령어

```bash
datamoat
datamoat status
datamoat stop
datamoat scan
datamoat audit verify
datamoat update check
```

## 라이선스

DataMoat는 **Business Source License 1.1 (`BUSL-1.1`)** 및 **Additional Use Grant**에 따라 배포됩니다. 개인 사용과 회사 내부 사용은 허용됩니다. 그 외 사용은 별도 상용 라이선스가 필요할 수 있습니다. 이 프로젝트는 **source-available**이며 OSI 승인 open source가 아닙니다.

전체 조건은 [LICENSE.md](LICENSE.md)를 확인하세요.
