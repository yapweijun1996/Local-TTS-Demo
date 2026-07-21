#!/bin/bash
# Stop and remove the launchd services installed by install.sh.
set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
UID_NUM=$(id -u)

for label in com.local-tts.voxcpm-sidecar com.local-tts.api; do
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  rm -f "$LAUNCH_AGENTS_DIR/$label.plist"
  echo "Removed $label"
done

echo "Done. Logs are left in ~/Library/Logs/local-tts-demo if you want to inspect them."
