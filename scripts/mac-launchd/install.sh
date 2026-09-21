#!/bin/bash
# Install the commercial-only Kokoro/VoxCPM2 sidecars + Node API as macOS
# launchd services.
#
# Run-at-login + auto-restart-on-crash, in the right start order (sidecar
# before API — see wait-for-sidecar.sh for why). Kokoro v1.1-zh handles
# Mandarin locally; VoxCPM2 remains the configured fallback. Designed for the
# Mac Mini M4 production target: VoxCPM2 needs Apple Silicon GPU (MPS) access,
# which Docker Desktop on macOS cannot provide (it runs containers in a Linux
# VM with no Metal passthrough) — so these run as native launchd jobs, not
# containers. See docs/ENGINES.md and docs/LICENSING.md for the architecture
# and commercial-use rationale.
#
# Usage: ./scripts/mac-launchd/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/local-tts-demo"

VOXCPM_LABEL="com.local-tts.voxcpm-sidecar"
KOKORO_LABEL="com.local-tts.kokoro-zh-sidecar"
API_LABEL="com.local-tts.api"
VOXCPM_PORT="8200"
KOKORO_PORT="8201"
API_PORT="6700"

echo "== Local TTS Demo — launchd install =="
echo "Project root: $PROJECT_ROOT"

# ── Preflight: macOS TCC-protected folders ───────────────────────────
# Confirmed by direct test (2026-07-21): a launchd job whose WorkingDirectory
# or ProgramArguments touch anything under ~/Documents, ~/Desktop, ~/Downloads,
# or iCloud Drive fails with "Operation not permitted" / "getcwd: cannot
# access parent directories" -- even a bare `pwd`. This is macOS's per-app
# TCC privacy protection on those folders: Terminal/your IDE can have been
# granted access, but a launchd-spawned process is a DIFFERENT "responsible"
# executable and does not inherit that grant. There is no flag to fix this
# from inside the plist -- the only real fix is keeping the project outside
# those folders. Moving it is a one-time `mv`/re-clone, not a code change.
case "$PROJECT_ROOT" in
  "$HOME/Documents"/*|"$HOME/Desktop"/*|"$HOME/Downloads"/*|*"/Library/Mobile Documents/"*)
    echo ""
    echo "ERROR: this project lives under a macOS TCC-protected folder:"
    echo "  $PROJECT_ROOT"
    echo "launchd-spawned services (this script) cannot read/write inside"
    echo "~/Documents, ~/Desktop, ~/Downloads, or iCloud Drive -- confirmed by"
    echo "direct test, not a guess. launchctl will start the job but it will"
    echo "immediately fail with 'Operation not permitted'."
    echo ""
    echo "Fix: move (or re-clone) the repo somewhere NOT under those folders,"
    echo "e.g.:"
    echo "  mv \"$PROJECT_ROOT\" ~/Projects/Local-TTS-Demo"
    echo "then re-run this script from the new location."
    exit 1
    ;;
esac

# ── Preflight: tooling ────────────────────────────────────────────────
command -v node >/dev/null || { echo "ERROR: node not found. Install Node.js 20+ first."; exit 1; }
command -v pnpm >/dev/null || { echo "ERROR: pnpm not found. Install pnpm first (npm i -g pnpm)."; exit 1; }

PYTHON_BIN=""
for cand in python3.12 python3.11 python3.10; do
  if command -v "$cand" >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v "$cand")"
    break
  fi
  for prefix in /opt/homebrew/opt "/usr/local/opt"; do
    if [ -x "$prefix/${cand%%.*}@${cand#python}/bin/$cand" ]; then :; fi
  done
done
# Homebrew installs as python@3.10 etc. -- check those paths explicitly too.
if [ -z "$PYTHON_BIN" ]; then
  for ver in 3.12 3.11 3.10; do
    for prefix in /opt/homebrew/opt /usr/local/opt; do
      cand="$prefix/python@$ver/bin/python$ver"
      if [ -x "$cand" ]; then PYTHON_BIN="$cand"; break 2; fi
    done
  done
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "ERROR: no Python 3.10-3.12 found. VoxCPM2 needs one of these (not 3.13+ -- many deps lack wheels)."
  echo "  Install with: brew install python@3.10"
  exit 1
fi
echo "Using Python: $PYTHON_BIN ($($PYTHON_BIN --version))"

# ── Shared Python sidecar venv ────────────────────────────────────────
SIDECAR_DIR="$PROJECT_ROOT/services/voxcpm-sidecar"
if [ ! -x "$SIDECAR_DIR/.venv/bin/uvicorn" ]; then
  echo "Setting up TTS sidecar venv (this downloads torch + models, can take a few minutes)..."
  "$PYTHON_BIN" -m venv "$SIDECAR_DIR/.venv"
fi
"$SIDECAR_DIR/.venv/bin/pip" install -q --upgrade pip
"$SIDECAR_DIR/.venv/bin/pip" install -q -r "$SIDECAR_DIR/requirements.txt"
if ! "$SIDECAR_DIR/.venv/bin/python" -c 'import spacy; raise SystemExit(0 if spacy.util.is_package("en_core_web_sm") else 1)' 2>/dev/null; then
  echo "Installing the pinned English G2P model used for mixed zh/en Podcast text..."
  "$SIDECAR_DIR/.venv/bin/python" -m spacy download en_core_web_sm
fi

# ── API build ─────────────────────────────────────────────────────────
echo "Building @local-tts/core + @local-tts/api..."
(cd "$PROJECT_ROOT" && pnpm --filter @local-tts/core build && pnpm --filter @local-tts/api build)

# ── launchd plists ────────────────────────────────────────────────────
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
chmod +x "$SCRIPT_DIR/wait-for-sidecar.sh"

cat > "$LAUNCH_AGENTS_DIR/$VOXCPM_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$VOXCPM_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SIDECAR_DIR/.venv/bin/uvicorn</string>
    <string>app:app</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$VOXCPM_PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$SIDECAR_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/voxcpm-sidecar.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/voxcpm-sidecar.error.log</string>
</dict>
</plist>
PLIST

KOKORO_SIDECAR_DIR="$PROJECT_ROOT/services/kokoro-sidecar"
cat > "$LAUNCH_AGENTS_DIR/$KOKORO_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$KOKORO_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SIDECAR_DIR/.venv/bin/uvicorn</string>
    <string>app:app</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>$KOKORO_PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$KOKORO_SIDECAR_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HF_HOME</key><string>$HOME/.cache/tts-models</string>
    <key>KOKORO_MODEL</key><string>hexgrad/Kokoro-82M-v1.1-zh</string>
    <key>KOKORO_DEVICE</key><string>cpu</string>
    <key>KOKORO_DEFAULT_VOICE</key><string>zf_001</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/kokoro-zh-sidecar.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/kokoro-zh-sidecar.error.log</string>
</dict>
</plist>
PLIST

cat > "$LAUNCH_AGENTS_DIR/$API_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$API_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCRIPT_DIR/wait-for-sidecar.sh</string>
    <string>http://127.0.0.1:$VOXCPM_PORT,http://127.0.0.1:$KOKORO_PORT</string>
    <string>60</string>
    <string>--</string>
    <string>$(command -v node)</string>
    <string>$PROJECT_ROOT/apps/api/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_ROOT/apps/api</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$API_PORT</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>TTS_ENGINE</key><string>kokoro</string>
    <key>TTS_FALLBACK_ENGINE</key><string>kokoro-zh,voxcpm2</string>
    <key>TTS_COMMERCIAL_ONLY</key><string>true</string>
    <key>TTS_MODEL_PATH</key><string>onnx-community/Kokoro-82M-v1.0-ONNX</string>
    <key>TTS_KOKORO_DTYPE</key><string>q4f16</string>
    <key>TTS_KOKORO_SUPPORTS_CHINESE</key><string>false</string>
    <key>TTS_DEFAULT_VOICE</key><string></string>
    <key>TTS_KOKORO_ZH_SIDECAR_URL</key><string>http://127.0.0.1:$KOKORO_PORT</string>
    <key>TTS_KOKORO_ZH_SIDECAR_TIMEOUT_MS</key><string>120000</string>
    <key>TTS_VOXCPM_SIDECAR_URL</key><string>http://127.0.0.1:$VOXCPM_PORT</string>
    <key>TTS_VOXCPM_SIDECAR_TIMEOUT_MS</key><string>300000</string>
    <key>TTS_ENABLE_CORS</key><string>false</string>
    <key>HF_HOME</key><string>$HOME/.cache/tts-models</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/api.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/api.error.log</string>
</dict>
</plist>
PLIST

echo "Wrote plists to $LAUNCH_AGENTS_DIR"

# ── Load ──────────────────────────────────────────────────────────────
UID_NUM=$(id -u)
for label in "$VOXCPM_LABEL" "$KOKORO_LABEL" "$API_LABEL"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$LAUNCH_AGENTS_DIR/$label.plist"
done

echo "Started. Waiting for the sidecar to come up (model load can take a minute)..."
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$VOXCPM_PORT/health" 2>/dev/null | grep -q '"model_loaded":true' \
    && curl -sf "http://127.0.0.1:$KOKORO_PORT/health" 2>/dev/null | grep -q '"model_loaded":true'; then
    echo "VoxCPM2 sidecar: ready."
    echo "Kokoro v1.1-zh sidecar: ready."
    break
  fi
  sleep 2
done
curl -sf "http://127.0.0.1:$API_PORT/health" 2>/dev/null && echo || echo "API not responding yet -- check logs at $LOG_DIR"

echo ""
echo "== Done =="
echo "Logs: $LOG_DIR"
echo "Uninstall: ./scripts/mac-launchd/uninstall.sh"
