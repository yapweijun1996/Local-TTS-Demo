# Development Guide

## Prerequisites
- Node.js 20+
- pnpm (monorepo uses workspaces; npm/yarn workspaces also work)
- ~1 GB free disk for model files
- Optional (prior-art validation): Python 3.13 venv — see [KB-MCP.md](KB-MCP.md)

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
| `TTS_MODEL_PATH` | `/app/models/kokoro` | model file directory |
| `TTS_DEFAULT_VOICE` | `default` | default voice id |
| `TTS_MAX_TEXT_LENGTH` | `3000` | max chars per request |
| `TTS_OUTPUT_FORMAT` | `wav` | MVP output format |
| `TTS_ENABLE_CORS` | `true` | toggle CORS |
| `TTS_CORS_ORIGIN` | `*` | allowed origin(s); tighten for exposed deploys |
| `TTS_LOG_TEXT` | `false` | never log full user text in prod |

## Common commands (target)
```bash
# Phase 1 — browser
cd apps/web && pnpm install && pnpm dev          # http://localhost:5173

# Phase 2 — API
cd apps/api && pnpm install && pnpm dev          # http://localhost:3000
curl http://localhost:3000/health

# Phase 3 — Docker
docker compose up --build
curl http://localhost:3000/health                # → { "status": "ok" }

# Tests
pnpm test            # unit + api
pnpm test:e2e        # browser (Playwright) — use a tiny test model, not 90MB
```

## Testing notes
- **Unit:** text validation, segmentation, adapter interface, error formatting,
  config loading (pure, fast).
- **API:** spin up the server, hit `/health`, `/api/voices`, `/api/engines`,
  `/api/tts`; assert empty-text / long-text / invalid-engine rejections.
- **Browser e2e:** loading the real ~90 MB Kokoro model in CI is slow and flaky —
  mock the engine or use a tiny fixture model. Assert: app loads, input works,
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
