#!/bin/sh
# Blocks until the VoxCPM2 sidecar answers /health, then execs the given
# command. Used so the API's launchd job doesn't race the sidecar's — the
# sidecar can take a while to bind its port on a cold boot (Python/PyTorch
# import time), and the Node engine registry only calls TtsEngine.load() ONCE
# at boot (apps/api/src/engines/registry.ts): if the sidecar isn't even
# listening yet, load() throws and voxcpm2 is marked unavailable until the
# API process is restarted. Waiting here is simpler than adding retry logic
# to the registry.
#
# Usage: wait-for-sidecar.sh <sidecar-url> <timeout-seconds> -- <cmd> [args...]

set -eu

SIDECAR_URL="$1"
TIMEOUT="$2"
shift 2
if [ "$1" = "--" ]; then shift; fi

elapsed=0
while ! curl -sf "${SIDECAR_URL}/health" >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "wait-for-sidecar: ${SIDECAR_URL}/health did not respond within ${TIMEOUT}s — starting API anyway (voxcpm2 will be marked unavailable until restart)" >&2
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

exec "$@"
