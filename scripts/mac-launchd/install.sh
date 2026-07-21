#!/bin/bash
# Install the VoxCPM2 sidecar + Node API as macOS launchd services.
#
# Run-at-login + auto-restart-on-crash, in the right start order (sidecar
# before API — see wait-for-sidecar.sh for why). Designed for the Mac Mini
# M4 production target: VoxCPM2 needs Apple Silicon GPU (MPS) access, which
# Docker Desktop on macOS cannot provide (it runs containers in a Linux VM
# with no Metal passthrough) — so these run as native launchd jobs, not
# containers. See memory: tts_voice_evaluation_findings.md for why VoxCPM2
# is the engine and docs/ENGINES.md for the architecture rationale.
#
# Usage: ./scripts/mac-launchd/install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/local-tts-demo"

VOXCPM_LABEL="com.local-tts.voxcpm-sidecar"
API_LABEL="com.local-tts.api"
VOXCPM_PORT="8200"
API_PORT="3000"

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

# ── VoxCPM2 sidecar venv ──────────────────────────────────────────────
SIDECAR_DIR="$PROJECT_ROOT/services/voxcpm-sidecar"
if [ ! -x "$SIDECAR_DIR/.venv/bin/uvicorn" ]; then
  echo "Setting up VoxCPM2 sidecar venv (this downloads torch + voxcpm, can take a few minutes)..."
  "$PYTHON_BIN" -m venv "$SIDECAR_DIR/.venv"
  "$SIDECAR_DIR/.venv/bin/pip" install -q --upgrade pip
  "$SIDECAR_DIR/.venv/bin/pip" install -q -r "$SIDECAR_DIR/requirements.txt"
else
  echo "VoxCPM2 sidecar venv already set up, skipping."
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

cat > "$LAUNCH_AGENTS_DIR/$API_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$API_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCRIPT_DIR/wait-for-sidecar.sh</string>
    <string>http://127.0.0.1:$VOXCPM_PORT</string>
    <string>60</string>
    <string>--</string>
    <string>$(command -v node)</string>
    <string>$PROJECT_ROOT/apps/api/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_ROOT/apps/api</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$API_PORT</string>
    <key>TTS_VOXCPM_SIDECAR_URL</key><string>http://127.0.0.1:$VOXCPM_PORT</string>
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
for label in "$VOXCPM_LABEL" "$API_LABEL"; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$LAUNCH_AGENTS_DIR/$label.plist"
done

echo "Started. Waiting for the sidecar to come up (model load can take a minute)..."
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$VOXCPM_PORT/health" 2>/dev/null | grep -q '"model_loaded":true'; then
    echo "VoxCPM2 sidecar: ready."
    break
  fi
  sleep 2
done
curl -sf "http://127.0.0.1:$API_PORT/health" 2>/dev/null && echo || echo "API not responding yet -- check logs at $LOG_DIR"

echo ""
echo "== Done =="
echo "Logs: $LOG_DIR"
echo "Uninstall: ./scripts/mac-launchd/uninstall.sh"
