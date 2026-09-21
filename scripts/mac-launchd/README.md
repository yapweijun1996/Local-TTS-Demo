# Mac Mini production launcher (launchd)

Runs the commercial-only Kokoro v1.1-zh Mandarin sidecar, VoxCPM2 fallback,
and Node API as native macOS background services — auto-start on login,
auto-restart on crash. No Docker: VoxCPM2 needs Apple Silicon GPU (MPS)
access, which Docker Desktop cannot pass through to a container on macOS (it
runs containers in a Linux VM with no Metal bridge). See docs/ENGINES.md and
docs/LICENSING.md for the engine and license decisions.

## ⚠️ Required: project must NOT live under ~/Documents, ~/Desktop, ~/Downloads, or iCloud Drive

Confirmed by direct test (2026-07-21): macOS's TCC privacy protection on
these folders blocks launchd-spawned processes from reading/writing inside
them — even a bare `pwd` fails with `Operation not permitted`. Terminal or
your IDE may have access, but a launchd job is a different "responsible"
process and does not inherit that grant. `install.sh` checks for this and
refuses to run with a clear error, but plan around it upfront: clone/move
the repo to somewhere like `~/Projects/Local-TTS-Demo` or
`/usr/local/local-tts-demo` before setting up the Mac Mini.

## Install

```bash
./scripts/mac-launchd/install.sh
```

This will (idempotently):
1. Find a Python 3.10–3.12 (the shared PyTorch sidecars may not have wheels for 3.13+)
2. Set up/update `services/voxcpm-sidecar/.venv` with VoxCPM2 and Kokoro dependencies, including the `en_core_web_sm` G2P model used for embedded English
3. Build `@local-tts/core` + `@local-tts/api`
4. Write three launchd plists to `~/Library/LaunchAgents/`:
   - `com.local-tts.voxcpm-sidecar` — the Python sidecar, port 8200
   - `com.local-tts.kokoro-zh-sidecar` — the Python Mandarin sidecar, port 8201
   - `com.local-tts.api` — the Node API, port 6700, waits for both sidecars'
     `/health` before starting (`wait-for-sidecar.sh`) so it doesn't race a
     cold model load
5. Load all three via `launchctl bootstrap`, wait for health checks, report status

All three jobs have `RunAtLoad` (start on login) and `KeepAlive` (auto-restart
on crash/exit) set. The API uses `TTS_COMMERCIAL_ONLY=true`, English in-process
Kokoro, Mandarin Kokoro v1.1-zh, and VoxCPM2 only as a fallback.

## Check status / logs

```bash
./scripts/mac-launchd/status.sh
```

Logs live in `~/Library/Logs/local-tts-demo/` (`voxcpm-sidecar.log`,
`voxcpm-sidecar.error.log`, `kokoro-zh-sidecar.log`,
`kokoro-zh-sidecar.error.log`, `api.log`, `api.error.log`).

## Uninstall

```bash
./scripts/mac-launchd/uninstall.sh
```

## Known limits (be honest with yourself before shipping)

- **No concurrency**: the sidecar serializes generation to one request at a
  time (`_generate_lock` in `app.py`) — a single GPU/MPS context. Concurrent
  users queue, they are not served in parallel. Fine for low-traffic/internal
  use; needs a real queue + status UI before multi-user production traffic.
- **Measured on this dev machine (Apple M4, 32 GB RAM)**: idle sidecar RSS
  ~1.43 GB, peak during a ~52s generation ~1.50 GB — comfortable headroom on
  a 16 GB Mac Mini. Speed (RTF ~1–3×, i.e. slower than real-time) is the
  actual bottleneck, not memory — a base M4 Mac Mini should perform similarly
  since it's the same chip, just less RAM.
- **Web app**: this launcher only covers the API + sidecar. `apps/web` is
  either served separately (e.g. GitHub Pages, pointing its
  `VITE_API_BASE_URL` at this Mac Mini's address) or built and served by
  something else — not part of this launchd setup.
