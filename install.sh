#!/usr/bin/env bash
set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}  DataMoat installer${RESET}"
echo -e "  ${CYAN}automatically backs up Claude, Codex, and OpenClaw conversations${RESET}"
echo ""

SOURCE_DIR="$(pwd -P)"
BOOTSTRAP_CAPTURE=0
BOOTSTRAP_REQUESTED_BY=""

for arg in "$@"; do
  case "$arg" in
    --capture-before-setup|--openclaw-remote|--remote-no-screen)
      BOOTSTRAP_CAPTURE=1
      BOOTSTRAP_REQUESTED_BY="remote-no-screen"
      ;;
  esac
done

# Check Node
if ! command -v node &>/dev/null; then
  echo "  ✗ Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi

if [ -n "${NODE_BIN:-}" ] && [ ! -x "${NODE_BIN}" ]; then
  NODE_BIN=""
fi
if [ -z "${NODE_BIN:-}" ]; then
  NODE_BIN=$(command -v node)
fi

NODE_VER=$("$NODE_BIN" -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_VER" -lt 18 ]; then
  echo "  ✗ Node.js v18+ required (found v${NODE_VER})"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} Node.js $("$NODE_BIN" --version)"

if [ -f "$HOME/.datamoat/auth.json" ] || [ -d "$HOME/.datamoat/vault" ]; then
  echo -e "  ${GREEN}✓${RESET} existing DataMoat data found at ~/.datamoat"
  echo "    this install will reuse your current vault, settings, and captured records in place"
fi

# Stop any existing install first so the new build actually takes effect.
if [ -x "$HOME/.local/bin/datamoat" ]; then
  "$HOME/.local/bin/datamoat" stop >/dev/null 2>&1 || true
fi

# Install
INSTALL_DIR="$HOME/.datamoat/app"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude "release" \
  --exclude "artifacts" \
  --exclude ".DS_Store" \
  ./ "$INSTALL_DIR/"
cd "$INSTALL_DIR"
rm -rf node_modules dist
npm install --include=dev --silent
npm run build

APP_ARCH=$("$NODE_BIN" -p "process.arch")
SOURCE_APP_BIN="$INSTALL_DIR/release/DataMoat-darwin-${APP_ARCH}/DataMoat.app/Contents/MacOS/DataMoat"

LINUX_SANDBOX_HELPER=""
if [[ "$(uname)" == "Linux" ]]; then
  LOCAL_CHROME_SANDBOX="$INSTALL_DIR/node_modules/electron/dist/chrome-sandbox"
  DISABLED_CHROME_SANDBOX="$INSTALL_DIR/node_modules/electron/dist/chrome-sandbox.datamoat-disabled"
  if [ -f "$LOCAL_CHROME_SANDBOX" ] && [ ! -f "$DISABLED_CHROME_SANDBOX" ]; then
    mv "$LOCAL_CHROME_SANDBOX" "$DISABLED_CHROME_SANDBOX"
  fi
  if [ -f "$DISABLED_CHROME_SANDBOX" ]; then
    LINUX_SANDBOX_HELPER="/usr/local/share/datamoat/chrome-devel-sandbox"
    if [ "$(id -u)" -eq 0 ]; then
      install -D -o root -g root -m 4755 "$DISABLED_CHROME_SANDBOX" "$LINUX_SANDBOX_HELPER"
    elif command -v sudo >/dev/null 2>&1; then
      if [ -t 0 ]; then
        sudo -p "  DataMoat Linux tray/UI needs a one-time sandbox helper install. Password: " \
          install -D -o root -g root -m 4755 "$DISABLED_CHROME_SANDBOX" "$LINUX_SANDBOX_HELPER" || true
      else
        sudo -n install -D -o root -g root -m 4755 "$DISABLED_CHROME_SANDBOX" "$LINUX_SANDBOX_HELPER" >/dev/null 2>&1 || true
      fi
    fi
    if [ ! -u "$LINUX_SANDBOX_HELPER" ]; then
      LINUX_SANDBOX_HELPER=""
    fi
  fi
fi

mkdir -p "$HOME/.datamoat/state"

if [ "$BOOTSTRAP_CAPTURE" -eq 1 ]; then
  if ! "$NODE_BIN" -e "const m=require('$INSTALL_DIR/dist/bootstrap-capture.js'); Promise.resolve(m.preflightBootstrapCapture()).then(ok=>process.exit(ok?0:1)).catch(()=>process.exit(1))"; then
    echo ""
    echo "  ✗ remote no-screen capture could not start securely on this install"
    echo "    DataMoat needs a working local OS secret store before it can begin pre-setup background capture."
    echo "    Fix the local keychain / secret-service first, then rerun:"
    echo -e "    ${CYAN}bash install.sh --remote-no-screen${RESET}"
    exit 1
  fi
fi

cat > "$HOME/.datamoat/state/install-source.json" << EOF
{
  "schemaVersion": 1,
  "sourceRoot": "${SOURCE_DIR}",
  "nodeBin": "${NODE_BIN}",
  "scriptLauncherBin": "${SOURCE_APP_BIN}",
  "installedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "mode": "source-copy"
}
EOF

if [ "$BOOTSTRAP_CAPTURE" -eq 1 ]; then
  cat > "$HOME/.datamoat/state/bootstrap-capture.json" << EOF
{
  "schemaVersion": 1,
  "enabled": true,
  "mode": "capture_only",
  "requestedBy": "${BOOTSTRAP_REQUESTED_BY}",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
  chmod 600 "$HOME/.datamoat/state/bootstrap-capture.json"
fi

# Link binary
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/datamoat" << EOF
#!/usr/bin/env bash
if [ -u /usr/local/share/datamoat/chrome-devel-sandbox ]; then
  export CHROME_DEVEL_SANDBOX=/usr/local/share/datamoat/chrome-devel-sandbox
fi
exec "${NODE_BIN}" "$HOME/.datamoat/app/dist/cli.js" "\$@"
EOF
chmod +x "$HOME/.local/bin/datamoat"
echo -e "  ${GREEN}✓${RESET} installed to ~/.datamoat/app"
echo -e "  ${GREEN}✓${RESET} binary at ~/.local/bin/datamoat"

# LaunchAgent (macOS auto-start on login)
if [[ "$(uname)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.datamoat.daemon.plist"
  TRAY_PLIST="$HOME/Library/LaunchAgents/com.datamoat.tray.plist"
  APP_BIN="$HOME/.datamoat/app/release/DataMoat-darwin-${APP_ARCH}/DataMoat.app/Contents/MacOS/DataMoat"
  if [ -x "$APP_BIN" ]; then
    cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.datamoat.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP_BIN}</string>
    <string>${HOME}/.datamoat/app/dist/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATAMOAT_DAEMON</key><string>1</string>
    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
PLIST
  else
    cat > "$PLIST" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.datamoat.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${HOME}/.datamoat/app/dist/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>DATAMOAT_DAEMON</key><string>1</string></dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
PLIST
  fi
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || true
  if [ "$BOOTSTRAP_CAPTURE" -eq 1 ]; then
    launchctl kickstart -k "gui/$(id -u)/com.datamoat.daemon" 2>/dev/null || true
  fi
  if [ -x "$APP_BIN" ]; then
    cat > "$TRAY_PLIST" << TRAYPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.datamoat.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APP_BIN}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATAMOAT_TRAY_ONLY</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict>
</plist>
TRAYPLIST
    launchctl unload "$TRAY_PLIST" 2>/dev/null || true
    launchctl load "$TRAY_PLIST" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/com.datamoat.tray" 2>/dev/null || true
    echo -e "  ${GREEN}✓${RESET} Menu bar indicator installed (auto-starts on login)"
  fi
  echo -e "  ${GREEN}✓${RESET} LaunchAgent installed (auto-starts on login)"
elif [[ "$(uname)" == "Linux" ]]; then
  SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SYSTEMD_USER_DIR/datamoat-daemon.service"
  AUTOSTART_DIR="$HOME/.config/autostart"
  AUTOSTART_FILE="$AUTOSTART_DIR/datamoat-tray.desktop"
  mkdir -p "$SYSTEMD_USER_DIR"
  cat > "$SERVICE_FILE" << SERVICE
[Unit]
Description=DataMoat daemon
After=default.target

[Service]
Type=simple
Environment=DATAMOAT_DAEMON=1
ExecStart=${NODE_BIN} ${HOME}/.datamoat/app/dist/daemon.js
WorkingDirectory=${HOME}/.datamoat/app
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
SERVICE

  if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
    systemctl --user enable --now datamoat-daemon.service >/dev/null 2>&1 || true
    echo -e "  ${GREEN}✓${RESET} systemd --user service installed (auto-starts on login)"
  else
    DATAMOAT_DAEMON=1 nohup "${NODE_BIN}" "$HOME/.datamoat/app/dist/daemon.js" >/dev/null 2>&1 &
    echo "  ! systemd --user unavailable; started DataMoat for this session only"
  fi
  mkdir -p "$AUTOSTART_DIR"
  cat > "$AUTOSTART_FILE" << DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=DataMoat Tray
Comment=DataMoat background status indicator
Exec=env DATAMOAT_TRAY_ONLY=1 ${HOME}/.local/bin/datamoat
Terminal=false
X-GNOME-Autostart-enabled=true
Categories=Utility;Security;
DESKTOP
  chmod 644 "$AUTOSTART_FILE"
  echo -e "  ${GREEN}✓${RESET} Tray autostart installed for graphical logins"
  if [ -n "$LINUX_SANDBOX_HELPER" ]; then
    echo -e "  ${GREEN}✓${RESET} Linux Electron sandbox helper installed"
  else
    echo "  ! Linux tray/UI needs a one-time sudo sandbox helper install on Ubuntu 24.04+"
  fi
  echo "  ! Linux tray icon visibility still depends on your desktop's status-notifier support (e.g. XFCE indicator plugin / GNOME appindicator extension)."
elif [ "$BOOTSTRAP_CAPTURE" -eq 1 ]; then
  DATAMOAT_DAEMON=1 nohup node "$HOME/.datamoat/app/dist/daemon.js" >/dev/null 2>&1 &
fi

# Add to PATH if needed
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo ""
  echo "  Add to your shell profile:"
  echo -e "  ${CYAN}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
fi

echo ""
echo -e "  ${BOLD}done.${RESET} run ${CYAN}datamoat${RESET} to open the UI"
if [ "$BOOTSTRAP_CAPTURE" -eq 1 ]; then
  echo -e "  ${GREEN}✓${RESET} remote no-screen capture mode enabled"
  echo "  DataMoat is already collecting supported local records now with pre-setup encrypted capture."
  echo "  This keeps the password, 24-word recovery phrase, and recovery codes out of remote chat channels and screenshots."
  echo "  Return to the protected desktop and run datamoat there to finish local encryption and unlock setup."
fi
echo ""
