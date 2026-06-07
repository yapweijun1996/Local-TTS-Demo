# Local TTS Demo

Browser-first, Node.js-compatible, Docker-deployable **Text-to-Speech platform**
built on open-source / open-weight models (Kokoro ONNX default, Piper ONNX
fallback). No paid cloud TTS, no API keys, private by default.

> **Status:** 📋 Specification + planning. No application code yet — this repo
> currently holds the PRD, architecture docs, and the build task list. Start
> implementation from [`task.jsonl`](task.jsonl) Phase 1.

## Why
Most TTS is cloud-based, paid, and key-dependent — that means privacy, cost, and
vendor lock-in. This runs in the browser, runs in Node.js, and deploys with one
Docker command, under permissive (MIT / Apache-2.0) licenses.

## Three layers
```text
Browser-first TTS   →   Node.js TTS API   →   Docker self-hosted deployment
(Phase 1)               (Phase 2)             (Phase 3)
```

## Documentation
| Doc | What it covers |
|-----|----------------|
| [PRD.md](PRD.md) | Product requirements (SSOT) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, the G2P pipeline, concurrency model, eng-review decisions |
| [docs/ENGINES.md](docs/ENGINES.md) | Engine/model catalog by naturalness tier + license; what to add, what to avoid |
| [docs/API.md](docs/API.md) | HTTP API reference (endpoints, request/response, error codes) |
| [docs/LICENSING.md](docs/LICENSING.md) | Commercial-license verification, the espeak-ng GPL caveat, per-model metadata |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, build, test, env vars, project layout |
| [docs/KB-MCP.md](docs/KB-MCP.md) | How project knowledge is persisted to KB MCP + prior proven demos |
| [task.jsonl](task.jsonl) | Machine-readable build task list (one JSON object per line) |

## Quick start (target — not yet implemented)
```bash
# Browser demo (Phase 1)
cd apps/web && npm install && npm run dev

# Node API (Phase 2)
cd apps/api && npm install && npm run dev
curl http://localhost:3000/health

# Docker (Phase 3)
docker compose up --build
curl http://localhost:3000/health   # → { "status": "ok" }
```

## Engines
| Engine | Role | License | Runtime |
|--------|------|---------|---------|
| Kokoro ONNX | Default (browser + Node) | Apache-2.0 | onnxruntime-web / -node |
| Piper ONNX | CPU fallback | MIT (voices vary) | onnxruntime / piper |
| Chatterbox | Future high-quality | MIT | **PyTorch sidecar** (not in-process) |

Browser Kokoro can run via [`kokoro-js`](https://www.npmjs.com/package/kokoro-js)
(Apache-2.0) or [`@met4citizen/headtts`](https://www.npmjs.com/package/@met4citizen/headtts)
(MIT, GPL-free G2P) — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#g2p--phonemizer--two-browser-paths).

See [docs/LICENSING.md](docs/LICENSING.md) before adding any engine — the runtime
**phonemizer** (espeak-ng, GPL-v3) is a commercial-license trap the model licenses
do not cover. The **English MVP avoids it entirely**: use HeadTTS (CMU dict + NRL
rules) or `kokoro-js` with misaki `fallback=None`. espeak-ng is only needed for some
non-English languages and is kept as an opt-in plugin, never bundled in core.

## Project conventions
- TypeScript everywhere; browser and API share types via `packages/core`.
- Pluggable [`TtsEngine`](PRD.md#11-engine-adapter-design) adapter — never hardcode a model in UI/API logic.
- No user-text logging by default (`TTS_LOG_TEXT=false`).
- Configurable model path (`TTS_MODEL_PATH`).

## License
Application code: see `LICENSE` (to be added — target MIT). Model/voice/phonemizer
licenses are tracked individually in [docs/LICENSING.md](docs/LICENSING.md).
