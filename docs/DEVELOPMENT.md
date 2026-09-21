# Development Guide

## Prerequisites
- Node.js 20+
- pnpm (monorepo uses workspaces; npm/yarn workspaces also work)
- ~1 GB free disk for model files
- Python 3.10–3.12 for the local Kokoro v1.1-zh / VoxCPM2 sidecars

## Repository layout (target)
```text
Local-TTS-Demo/
├── PRD.md                  product requirements (SSOT)
├── README.md
├── task.jsonl              build task list (machine-readable)
├── docs/                   this folder
├── package.json            workspace root
├── docker-compose.yml
├── Dockerfile
├── apps/
│   ├── web/                Vite + TS browser app          (Phase 1)
│   └── api/                Fastify + TS HTTP API          (Phase 2)
├── packages/core/          shared types + pure logic (incl. G2P abstraction)
├── models/                 local model files (.gitkeep; gitignored otherwise)
└── tests/                  unit + api + docker tests
```

> **Workspaces:** `apps/web` and `apps/api` share types from `packages/core`. Use
> pnpm workspaces (`pnpm-workspace.yaml`) so the shared package resolves without
> publishing. Not yet scaffolded — this is the first Phase 2 setup task.

## Environment variables
| Var | Default | Purpose |
|-----|---------|---------|
| `TTS_ENGINE` | `kokoro` | default engine id |
| `TTS_FALLBACK_ENGINE` | `kokoro-zh,voxcpm2` | comma-separated commercial-use fallback preference; Mandarin uses the Kokoro v1.1-zh sidecar first |
| `TTS_COMMERCIAL_ONLY` | `true` | register only engines whose model/voice terms permit Business use; set `false` only for local hobby/development use |
| `TTS_MODEL_PATH` | `onnx-community/Kokoro-82M-v1.0-ONNX` | Hugging Face model id or local model path for English in-process Kokoro |
| `TTS_KOKORO_DTYPE` | `q4f16` | Kokoro quantization (`fp32`, `fp16`, `q8`, `q4`, `q4f16`) |
| `TTS_DEFAULT_VOICE` | empty | omit to let each selected engine choose its own default voice |
| `TTS_KOKORO_SUPPORTS_CHINESE` | `false` | set `true` only when replacing the Node model with a native Mandarin-capable adapter |
| `TTS_KOKORO_ZH_SIDECAR_URL` | empty | loopback URL for the Python Kokoro v1.1-zh sidecar, e.g. `http://127.0.0.1:8201` |
| `TTS_KOKORO_ZH_SIDECAR_TIMEOUT_MS` | `120000` | per-chunk Mandarin sidecar timeout |
| `TTS_MAX_TEXT_LENGTH` | `3000` | max chars per request |
| `TTS_OUTPUT_FORMAT` | `wav` | MVP output format |
| `TTS_ENABLE_CORS` | `true` | toggle CORS |
| `TTS_CORS_ORIGIN` | `*` | allowed origin(s); tighten for exposed deploys |
| `TTS_LOG_TEXT` | `false` | never log full user text in prod |
| `TTS_JOB_DATA_DIR` | `data/tts-jobs` | durable async-job metadata, chunks, and results |
| `TTS_JOB_RESULT_TTL_MS` | `3600000` | retain terminal jobs/results for refresh recovery |
| `TTS_JOB_MAX_DISK_BYTES` | `2147483648` | prune oldest terminal results above this disk budget |
| `TTS_JOB_CHUNK_SIZE` | `480` | durable top-level text boundary; engine adapters may split further |
| `PORT` | `6700` | API listen port |

### Durable server TTS jobs

`POST /api/tts/jobs` returns a UUID and persists the request before generation.
Poll `GET /api/tts/jobs/:id` for `queued`/`running` status and chunk progress;
the same endpoint returns `audio/wav` when complete. `DELETE` explicitly
cancels a job. The API reloads queued/running records after restart and reuses
completed chunks. Browser clients store active UUIDs in IndexedDB and resume
polling after refresh.

## Common commands (target)
```bash
# Phase 1 — browser
cd apps/web && pnpm install && pnpm dev          # http://localhost:5173

# Phase 2 — API
cd apps/api && pnpm install && pnpm dev          # http://localhost:6700
curl http://localhost:6700/health

# Phase 3 — Docker
docker compose up --build
curl http://localhost:6700/health                # → { "status": "ok" }

# WebUI gateway
pnpm --filter @local-tts/web build
PORT=6702 TTS_API_ORIGIN=http://127.0.0.1:6700 node scripts/serve-web.mjs

# Tests
pnpm test            # unit + api
pnpm test:e2e        # browser (Playwright) — use a tiny test model, not 90MB
```

### Auto-recovery after terminal close or restart

`docker-compose.yml` sets the API container to `restart: always`. Docker
Desktop must also be configured to start when the user signs in; otherwise
Docker cannot restore containers after macOS boots. The Cloudflare Tunnel is
host-managed separately (PM2 on the production Mac Mini), so verify it with
`pm2 status` and persist its process list with `pm2 save`. A terminal session
must not be the process supervisor.

### WebUI deployment

The browser UI is served by the gateway on `6702`, while `/health` and
`/api/*` are proxied to the API on `6700`. For the production tunnel, point
`tts.yapweijun1996.com` at `127.0.0.1:6702` so the domain root serves the UI.

## Testing notes
- **Unit:** text validation, segmentation, adapter interface, error formatting,
  config loading (pure, fast).
- **API:** spin up the server, hit `/health`, `/api/voices`, `/api/engines`,
  `/api/tts`; assert empty-text / long-text / invalid-engine rejections.
- **Audio integrity:** durable jobs must reject an all-zero/low-amplitude WAV for
  speech-bearing text; Kokoro regression coverage must exercise the split-recovery
  path used by long Podcast chunks.
- **Browser e2e:** loading the real Kokoro model in CI is slow and flaky (Q4 ~86 MB,
  FP16 default ~163 MB) — mock the engine or use a tiny fixture model. Assert: app loads, input works,
  Generate toggles busy state, audio player appears, error appears on model fail.
- **Docker:** `docker compose up --build` then curl `/health`.

## Build order (follow task.jsonl)
1. **Phase 1** browser demo (proves model + G2P + audio in the browser, no backend).
2. **Phase 2** Node API + Kokoro adapter + validation + worker-thread inference.
3. **Phase 3** Dockerfile + compose + healthcheck + model volume.
4. **Phase 4** Piper adapter; optional Chatterbox sidecar; engine switching.

## Tip: validate models in Python first
Before porting to Node, confirm the model files / voices / audio quality with the
known-good Python path (KB-recorded, verified 2026-05-28). This de-risks the Node
port — you isolate "is the model good?" from "is my Node adapter correct?". See
[KB-MCP.md](KB-MCP.md).
