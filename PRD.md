# Browser-First Open Source Text-to-Speech Platform

> Product Requirements Document (SSOT). Engineering interpretation, risks, and
> open questions are tracked in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
> and [`docs/LICENSING.md`](docs/LICENSING.md). Do not edit acceptance criteria
> here without updating [`task.jsonl`](task.jsonl).

## 1. Product Overview
This project is a browser-first, Node.js-compatible, Docker-deployable
Text-to-Speech platform using open-source / open-weight TTS models. The product
must allow users to convert text into speech locally or through a self-hosted
API without depending on paid cloud TTS providers. The system should start with
a browser-first implementation, then extend into a Node.js API service, and
finally become easy to deploy through Docker.

## 2. Core Goal
Build a commercial-friendly, open-source TTS system that supports:
1. Browser-first text-to-speech generation.
2. Node.js text-to-speech API.
3. Dockerized deployment.
4. Pluggable TTS engine architecture.
5. Commercial-use-compatible model licensing.
6. Easy setup for developers and internal business use.

## 3. Target Users
- **Primary:** developers needing local TTS; internal business tools; ERP / CRM /
  admin systems needing audio; AI agent apps needing speech; browser apps needing
  offline / local-first TTS.
- **Secondary:** small companies avoiding cloud TTS cost; privacy-sensitive apps;
  demo / prototype builders; self-hosting users.

## 4. Problem Statement
Most TTS services are cloud-based, paid, and API-key dependent, creating privacy,
cost, and vendor lock-in issues. The goal is a practical TTS system that runs in
the browser, runs in Node.js, and deploys through Docker with permissive
open-source licensing.

## 5. Recommended Model Strategy
Multi-engine architecture, not a hardcoded model.
- **Default engine — Kokoro ONNX:** browser-first + Node.js TTS, lightweight local
  inference, good first MVP model. npm: [`kokoro-js`](https://www.npmjs.com/package/kokoro-js)
  (Apache 2.0, by Xenova/Transformers.js) or
  [`@met4citizen/headtts`](https://www.npmjs.com/package/@met4citizen/headtts)
  (MIT, GPL-free — uses CMU Pronunciation Dictionary + NRL rules instead of
  espeak-ng). ONNX model sizes: FP32 ~326 MB, FP16 ~163 MB (recommended), Q8
  ~163 MB, Q4 **~86 MB** (mobile/low-bandwidth, quality nearly identical to FP32).
- **Fallback engine — Piper ONNX:** lightweight CPU fallback, low-resource, simple
  internal usage, Docker CPU deployment. ~50–75 MB per voice (ONNX), 50+ languages.
  npm: [`@zahid0/piper-tts-web`](https://www.npmjs.com/package/@zahid0/piper-tts-web)
  (ONNX Runtime Web WASM). License: MIT (code), per-voice varies (verify each voice).
- **Future high-quality engine — Chatterbox:** higher-quality voice, server-side
  Docker, possible GPU mode. Not required for browser-first MVP.
  See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Chatterbox is a PyTorch model
  and must run as a sidecar service, not an in-process Node adapter.

## 6. License Requirements
Only models, libraries, and voice assets compatible with commercial use.
- **Allowed:** MIT, Apache-2.0, BSD, MPL-2.0 (if compatible).
- **Not allowed:** non-commercial, research-only, unknown, unclear-commercial, or
  weights whose license differs from code and is not commercially usable.
- **Verification rule** — before adding a model to the registry, verify:
  1. Code license
  2. Model weight license
  3. Voice asset license
  4. Dataset-related restriction (if stated)
  5. Commercial use permission
  6. Attribution requirement
  7. **Runtime phonemizer license** (added by eng review — e.g. espeak-ng is
     GPL-v3; see [`docs/LICENSING.md`](docs/LICENSING.md)).

Each model must ship a metadata file:
```json
{
  "engine": "kokoro",
  "modelName": "Kokoro ONNX",
  "license": "Apache-2.0",
  "commercialUse": true,
  "requiresAttribution": false,
  "sourceUrl": "",
  "verifiedAt": "YYYY-MM-DD",
  "notes": ""
}
```

## 7. Product Scope
### 7.1 In Scope
**Browser App:** text input, voice selection, generate button, audio preview,
download, local model loading, WASM fallback, WebGPU when available, model loading
progress, error display, basic mobile responsive UI.

**Node.js API:** TTS generation from text, voice listing, engine listing, health
check, audio file response, JSON error response, configurable model path,
configurable default engine.

**Docker:** one-command startup, local model storage, env var config, exposed HTTP
API, health check, optional model preloading, volume mount for models (and
optionally output).

**Engine adapter:** pluggable engines `kokoro`, `piper`, `chatterbox_future`.
First version implements Kokoro only.

### 7.2 Out of Scope for MVP
Voice cloning, user accounts, payment, cloud hosting dashboard, fine-tuning,
custom training, multi-speaker conversation, enterprise auth, complex audio
editing.

> **Streaming TTS:** `kokoro-js` v1.2.0+ ships built-in streaming
> (`TextSplitterStream`). The foundational capability exists and the engine
> adapter will accept a streaming input shape, but the MVP UI will not expose
> streaming controls — the user clicks "Generate" and receives the full audio.
> Full real-time streaming UX (progressive playback while generating) is deferred
> to a future phase.

## 8. Functional Requirements
### 8.1 Browser TTS
User enters text in the browser and generates audio locally.
**Flow:** open app → load model → enter text → select voice → Generate → app
generates speech → preview → download.
**Acceptance:** generate without backend; show model loading state; show
generation/busy state; play audio; download audio; WASM fallback when WebGPU
absent; readable error on failure.

### 8.2 Node.js TTS API — `POST /api/tts`
```json
{ "text": "Hello, welcome to the system.", "voice": "default", "engine": "kokoro", "format": "wav" }
```
Returns an audio file. MVP format: `audio/wav`. Future: `audio/mp3`, `audio/ogg`.
**Acceptance:** accept text; validate empty text; validate max length; return audio;
return clear JSON errors; no external API keys.

### 8.3 Voice Listing — `GET /api/voices`
```json
{ "voices": [ { "id": "default", "name": "Default Voice", "language": "en", "engine": "kokoro" } ] }
```
**Acceptance:** retrieve voices with id, display name, language, engine.

### 8.4 Engine Listing — `GET /api/engines`
```json
{ "engines": [ { "id": "kokoro", "name": "Kokoro ONNX", "status": "available", "license": "Apache-2.0", "commercialUse": true } ] }
```
**Acceptance:** return engines with license metadata and availability.

### 8.5 Health Check — `GET /health`
```json
{ "status": "ok", "engine": "kokoro", "modelLoaded": true }
```
**Acceptance:** Docker health check callable; returns app status and model loading
status.

## 9. Non-Functional Requirements
- **9.1 Privacy:** local processing in browser mode; no external API calls in Node
  mode; no telemetry by default; no user text logging by default.
- **9.2 Performance:** browser short text within interactive time, never permanent
  freeze, large text chunked; Node supports basic concurrency, long text queued or
  rejected, no memory leaks. *(Eng review: set concrete targets — RTF < 1.0 CPU;
  see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).)*
- **9.3 Reliability:** handle model load failure, unsupported browser features,
  validate input, clean container restart.
- **9.4 Security:** validate request body size, prevent long-text abuse, no local
  filesystem path exposure, configurable CORS, no hardcoded secrets.
- **9.5 Accessibility:** keyboard nav, clear labels, visible loading state,
  screen-reader-friendly labels.

## 10. Technical Architecture
```text
Browser App  └── TTS Engine Adapter └── Kokoro ONNX Runtime (web)
Node.js API  └── TTS Engine Adapter └── Kokoro ONNX Runtime (node)
Docker       └── Node.js API        └── Local Model Files
```
**Stack** — Browser: TypeScript, Vite, Vanilla/React, ONNX Runtime Web,
[`kokoro-js`](https://www.npmjs.com/package/kokoro-js) (Apache 2.0) or
[`@met4citizen/headtts`](https://www.npmjs.com/package/@met4citizen/headtts)
(MIT, GPL-free). Node: Node 20+, TypeScript, Fastify/Express, ONNX Runtime Node,
local model files. Docker: node:20-slim, Compose, model volume, health check.

> ⚠️ **Deployment requirement — COOP/COEP headers:** `kokoro-js` needs
> `SharedArrayBuffer` (multithreaded WASM). The server (even Vite dev) must return:
> ```
> Cross-Origin-Embedder-Policy: require-corp
> Cross-Origin-Opener-Policy: same-origin
> ```
> Vite: use `vite-plugin-cross-origin-isolation`. For production, configure these
> headers at the reverse-proxy / CDN level.

**Browser compatibility (actual, 2025–2026):**
| Browser | WebGPU | WASM | Recommended |
|---------|--------|------|-------------|
| Chrome 113+ | ✅ | ✅ | WebGPU |
| Edge 113+ | ✅ | ✅ | WebGPU |
| Firefox 130+ | ❌ (nightly only) | ✅ | WASM |
| Safari 18+ (macOS) | ⚠️ experimental | ✅ | WASM |
| iOS Safari | ❌ | ✅ | WASM |

WebGPU is ~3–10× faster than WASM for inference; WASM works universally as
fallback. Desktop Chrome/Edge get the best experience.

## 11. Engine Adapter Design
Do not hardcode the model inside UI or API logic. Use an adapter interface.
```ts
export interface TtsEngine {
  id: string;
  name: string;
  load(): Promise<void>;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(input: TtsInput): Promise<TtsOutput>;
}
export interface TtsInput { text: string; voice?: string; speed?: number; language?: string; format?: "wav"; }
export interface TtsOutput { audioBuffer: ArrayBuffer; mimeType: string; durationMs?: number; }
export interface TtsVoice { id: string; name: string; language: string; gender?: string; engine: string; }
```

## 12. Configuration
```env
TTS_ENGINE=kokoro
TTS_MODEL_PATH=/app/models/kokoro
TTS_DEFAULT_VOICE=default
TTS_MAX_TEXT_LENGTH=3000
TTS_OUTPUT_FORMAT=wav
TTS_ENABLE_CORS=true
TTS_CORS_ORIGIN=*
TTS_LOG_TEXT=false
```

## 13. Text Handling Rules
**MVP:** trim whitespace; reject empty; reject over max length; normalize repeated
spaces; preserve punctuation; split long text into chunks.
**Future:** sentence segmentation; multi-language detection; SSML-like syntax;
pause / speed / pitch control.
*(Eng review: G2P / phonemization sits between text handling and the ONNX model and
is mandatory — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).)*

## 14. Browser UI Requirements
**Layout:** Header, text input, voice selector, engine selector, Generate button,
loading/progress status, audio player, download button, error display.
**Style:** clean, practical, mobile responsive, not over-decorated, easy to
understand, suitable for internal business tools.

## 15. API Error Format
```json
{ "error": { "code": "TEXT_TOO_LONG", "message": "Text exceeds maximum allowed length.", "details": { "maxLength": 3000 } } }
```
Codes: `EMPTY_TEXT`, `TEXT_TOO_LONG`, `ENGINE_NOT_FOUND`, `VOICE_NOT_FOUND`,
`MODEL_LOAD_FAILED`, `GENERATION_FAILED`, `UNSUPPORTED_FORMAT`.

## 16. Docker Requirements
**Dockerfile:** install deps, copy app, copy/mount models, expose port, health
check, start API.
**docker-compose.yml:**
```yaml
services:
  tts-api:
    build: .
    ports: [ "3000:3000" ]
    environment:
      TTS_ENGINE: kokoro
      TTS_MODEL_PATH: /app/models/kokoro
      TTS_MAX_TEXT_LENGTH: 3000
    volumes:
      - ./models:/app/models
      - ./output:/app/output   # optional; disabled by default for privacy
```

## 17. Suggested Project Structure
```text
tts-platform/
├── PRD.md
├── README.md
├── package.json
├── docker-compose.yml
├── Dockerfile
├── apps/
│   ├── web/   (index.html, src/main.ts, src/ui/, src/tts/, vite.config.ts)
│   └── api/   (src/server.ts, routes/, engines/{TtsEngine.ts,kokoro/,piper/}, config/, utils/)
├── packages/core/  (src/types.ts, textSegmenter.ts, audioUtils.ts)
├── models/   (.gitkeep)
└── tests/    (api.test.ts, engine.test.ts)
```

## 18. MVP Milestones
- **Phase 1 — Browser-First Demo:** browser UI, Kokoro ONNX load, text input, audio
  generation, preview, download, error handling. *Done when speech generates fully
  in browser, no backend needed.*
- **Phase 2 — Node.js API:** `/api/tts`, `/api/voices`, `/api/engines`, `/health`,
  Kokoro adapter, validation, audio response. *Done when speech generates over HTTP,
  no cloud.*
- **Phase 3 — Docker:** Dockerfile, docker-compose, env config, health check, model
  volume. *Done when `docker compose up` serves the API at `http://localhost:3000`.*
- **Phase 4 — Engine Expansion:** Piper adapter, optional Chatterbox sidecar, engine
  switching config. *Done when engine switches without rewriting API or UI.*

## 19. Testing Requirements
- **Unit:** text validation, segmentation, adapter interface, error formatting,
  config loading.
- **API:** `/health`, `/api/voices`, `/api/engines`, `/api/tts`, empty-text reject,
  long-text reject, invalid-engine reject.
- **Browser:** app loads, text input works, generate button state changes, audio
  player appears after generation, error appears when model fails.
- **Docker:** `docker compose up --build` then `curl http://localhost:3000/health`
  → `{ "status": "ok" }`.

## 20. Logging Rules
Default logging must not store user text.
- **Allowed:** request id, timestamp, engine, voice, text length, generation time,
  success/failure, error code.
- **Not allowed by default:** full input text, generated audio content, personal
  data, secrets, API keys.

## 21. Future Enhancements
Streaming TTS, MP3 output, multi-language voice selector, SSML, speed / pitch
control, batch generation, browser model cache management, Web Worker inference,
GPU server mode, admin dashboard, ERP integration, AI agent voice response, audio
history, subtitle generation, STT + TTS conversation loop.

## 22. Risks
- **License:** code license may differ from weight license; verify both (plus
  runtime phonemizer — see [`docs/LICENSING.md`](docs/LICENSING.md)).
  **G2P phonemizer trap:** espeak-ng is GPLv3. English/Japanese/Chinese/Korean
  are GPL-free (misaki native G2P or CMU dict + NRL rules). Spanish/French/
  Hindi/Italian/Portuguese require espeak-ng → isolate behind plugin architecture
  (user-installed, not bundled). English MVP = zero GPL risk.
- **Browser performance:** default model (FP16 ~163 MB) may be too heavy for
  mobile / slow connections. Mitigations: ship Q4 quantized model (~86 MB, quality
  nearly identical), WASM fallback when WebGPU absent, server-side API fallback,
  IndexedDB model caching (second load = instant). First-load target: <10s on
  broadband with Q4 model.
- **Audio quality:** lightweight models may not match premium cloud. Mitigate by
  starting with Kokoro and adding Chatterbox as future server engine.
- **Deployment:** model files large / slow to download. Mitigate with local model
  folder, preloaded Docker image, setup script.

## 23. Definition of Done
MVP complete when: browser app generates TTS locally; Node API generates TTS;
Docker Compose starts the service; engine adapter implemented; license metadata
exists for the selected model; input validation implemented; error handling
implemented; README has setup instructions; basic tests pass.

## 24. AI Agent Implementation Instruction
1. Do not hardcode a single TTS model inside business logic.
2. Use an engine adapter pattern.
3. Keep browser mode and API mode separate but share common types.
4. Use TypeScript.
5. Keep UI practical and clean.
6. No authentication in MVP.
7. No cloud TTS APIs.
8. No non-commercial models.
9. Do not log full user text by default.
10. Make Docker setup simple.
11. Clear README instructions.
12. Add tests for validation and API endpoints.
13. Prefer ONNX-compatible models for deployment.
14. Make model path configurable.
15. Keep MVP small and working before advanced features.

## 25. Final MVP Summary
Browser-first TTS → Node.js TTS API → Docker self-hosted deployment. Use Kokoro
ONNX as the first engine, Piper ONNX as lightweight fallback, reserve Chatterbox
for future high-quality server-side mode. Commercial-friendly, private by default,
easy to deploy, pluggable engine architecture.
