---
name: datamoat
description: Back up, analyze, and reuse ChatGPT | Claude | Codex | Cursor | DeepSeek | Qwen | Openclaw data + skills + attachments locally
---

# Data Moat Plugin

Data Moat Plugin installs and operates DataMoat, a local desktop app that
quietly backs up AI work history into an encrypted vault on the user's own
machine.

This root skill entry exists for Claude skill directories. The runnable skill
package is mirrored in `skills/datamoat`; plugin marketplace installs use
`plugins/datamoat`.

## Status

Run the bundled status check before installing or answering DataMoat questions:

```bash
bash skills/datamoat/scripts/datamoat-status.sh
```

## Install

Run the platform installer from the mirrored skill package:

```bash
bash skills/datamoat/scripts/install-datamoat-macos.sh
```

On Linux:

```bash
bash skills/datamoat/scripts/install-datamoat-linux.sh
```

On Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File skills/datamoat/scripts/install-datamoat-windows.ps1
```

Never ask for or handle DataMoat unlock passwords, recovery phrases, recovery
codes, or authenticator secrets in chat. The user completes unlock and recovery
setup locally in the DataMoat desktop UI.
