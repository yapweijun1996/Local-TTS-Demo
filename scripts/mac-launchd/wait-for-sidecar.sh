#!/bin/sh
# Blocks until every comma-separated sidecar reports `model_loaded=true`, then
# execs the given command. The Node registry performs one readiness check at
# boot, so starting before a sidecar's model is loaded would permanently hide
# that commercial engine until the API is restarted.
#
# Usage: wait-for-sidecar.sh <sidecar-url> <timeout-seconds> -- <cmd> [args...]

set -eu

SIDECAR_URLS="$1"
TIMEOUT="$2"
shift 2
if [ "$1" = "--" ]; then shift; fi

elapsed=0
while :; do
  ready=1
  OLD_IFS="$IFS"
  IFS=,
  for sidecar_url in $SIDECAR_URLS; do
    if ! curl -sf "${sidecar_url}/health" 2>/dev/null | grep -q '"model_loaded":true'; then
      ready=0
      break
    fi
  done
  IFS="$OLD_IFS"
  [ "$ready" -eq 1 ] && break
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "wait-for-sidecar: sidecar models were not ready within ${TIMEOUT}s — starting API anyway; unavailable engines will be skipped" >&2
    break
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

exec "$@"
