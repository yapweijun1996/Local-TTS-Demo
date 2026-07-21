#!/bin/bash
# Quick health check + log tail for the installed launchd services.
set -uo pipefail

UID_NUM=$(id -u)
LOG_DIR="$HOME/Library/Logs/local-tts-demo"

echo "== launchd job status =="
for label in com.local-tts.voxcpm-sidecar com.local-tts.api; do
  launchctl print "gui/$UID_NUM/$label" 2>/dev/null | grep -E "state = |pid = " | sed "s/^/[$label] /" \
    || echo "[$label] not loaded"
done

echo ""
echo "== /health =="
echo -n "VoxCPM2 sidecar (8200): "; curl -sf http://127.0.0.1:8200/health 2>/dev/null || echo "unreachable"
echo
echo -n "API (3000): "; curl -sf http://127.0.0.1:3000/health 2>/dev/null || echo "unreachable"
echo

echo ""
echo "== last 10 log lines (errors) =="
for f in "$LOG_DIR/voxcpm-sidecar.error.log" "$LOG_DIR/api.error.log"; do
  [ -f "$f" ] && { echo "--- $f ---"; tail -10 "$f"; }
done
