# Architecture

This document is the engineering interpretation of [`../PRD.md`](../PRD.md). Where
the PRD treats TTS as a black box, this doc expands the real runtime pipeline and
records decisions the PRD left open.

## 1. The real TTS pipeline (not text → audio)
Open-source TTS models are **not** end-to-end. They consume **phonemes**, not raw
text. The mandatory pipeline is:

```text
raw text
  → text normalization      (trim, collapse spaces, reject empty / too-long)
  → segmentation            (split long text into sentence-ish chunks)
  → G2P / phonemization     (grapheme-to-phoneme)  ← MANDATORY, easy to forget
  → ONNX inference          (Kokoro / Piper)        → raw PCM (float32, 24kHz Kokoro)
  → audio encoding          (PCM → WAV container)
  → ArrayBuffer (browser)  /  audio/wav response (API)
```

> ⚠️ **G2P is the #1 omission risk.** Kokoro needs `misaki` (English) or
> `espeak-ng` (multilingual fallback); Piper needs `espeak-ng`. The browser path
> (`kokoro-js`) bundles phonemization — this is exactly where browser bugs and
> bundle-size pain appear. Treat G2P as a first-class component in `packages/core`,
> not an implementation detail. License implications: see
> [`LICENSING.md`](LICENSING.md).

## 2. Component layout
```text
packages/core         shared TypeScript types + pure logic (no runtime deps)
  ├── types.ts         TtsEngine / TtsInput / TtsOutput / TtsVoice
  ├── textSegmenter.ts normalization + chunking
  ├── g2p/             phonemizer abstraction (engine-specific impls injected)
  └── audioUtils.ts    PCM → WAV encoder, duration calc

apps/web              browser-first app (Vite + TS)
  └── tts/             onnxruntime-web adapter (kokoro-js)

apps/api              Node.js HTTP API (Fastify)
  └── engines/         onnxruntime-node adapters (kokoro, piper)
```

The same `TtsEngine` interface is implemented twice — once for `onnxruntime-web`
(browser) and once for `onnxruntime-node` (server). They share **types and pure
logic** from `packages/core`, never the runtime.

### G2P / phonemizer — two browser paths
- **Path A (kokoro-js):** misaki English G2P (183k dict, Apache 2.0) with espeak-ng
  WASM fallback bundled but not loaded for English. Set `fallback=None`.
- **Path B (HeadTTS, MIT):** CMU Pronouncing Dictionary (134k words, BSD-like) +
  NRL Report 7948 rule-based algorithm (public domain). **Zero GPL dependency.**
  Preferred for clean licensing. npm: `@met4citizen/headtts`.

## 3. Concurrency model (server) — decided
ONNX inference is CPU-bound and effectively synchronous; Node is single-threaded.
A naive `await engine.synthesize()` in the request handler **blocks the event
loop**, freezing `/health` and every other request during a long synthesis.

**Decision:** run inference in a `worker_threads` pool. The main thread only does
HTTP, validation, and queue scheduling.
- Pool size default: `min(cpuCount, 4)`, configurable.
- Bounded queue; reject with `503` / `GENERATION_FAILED` when saturated (ties to
  PRD 9.2 "queued or rejected based on configuration").
- Each worker loads the model once and is reused.

## 4. Performance targets — made measurable
The PRD's "acceptable interactive time" is not testable. Concrete targets:
| Metric | Target |
|--------|--------|
| Server RTF (real-time factor, CPU) | < 1.0 (synthesize 1s audio in < 1s) |
| Browser first model load (Q4, 86 MB) | < 10s on broadband; show progress < 500ms |
| Browser model size (quantized) | ≤ ~90 MB (Kokoro Q4) |
| Max single request text | `TTS_MAX_TEXT_LENGTH` (default 3000 chars) |
| API p95 latency (short text, warm) | < 1.5s |

### Kokoro ONNX quantization options (onnx-community/Kokoro-82M-v1.0-ONNX)
| Quantization | Size | Quality | Best For |
|---|---|---|---|
| FP32 | ~326 MB | Highest | WebGPU desktop |
| FP16 | ~163 MB | Recommended default | Best quality/size balance |
| Q8 | ~163 MB | High | Balanced |
| Q4 | **~86 MB** | Still very good (minimal difference) | Mobile / low bandwidth |
| Q8f16 | ~86 MB | High (smallest) | Mobile high-quality |

Kokoro is "extremely resilient to quantization" — Q4 at 86 MB has no noticeable
quality difference vs FP32. Browser first-load is 86 MB, not 500 MB.

### Browser compatibility (actual, 2025–2026)
| Browser | WebGPU | WASM | Recommended |
|---------|--------|------|-------------|
| Chrome 113+ | ✅ | ✅ | WebGPU |
| Edge 113+ | ✅ | ✅ | WebGPU |
| Firefox 130+ | ❌ (nightly only) | ✅ | WASM |
| Safari 18+ (macOS) | ⚠️ experimental | ✅ | WASM |
| iOS Safari | ❌ | ✅ | WASM |

WebGPU is ~3–10× faster than WASM. WASM works universally as fallback.

### Browser deployment: COOP/COEP headers required
`kokoro-js` / Transformers.js need `SharedArrayBuffer` (multithreaded WASM).
The server MUST return:
```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```
Vite dev: use `vite-plugin-cross-origin-isolation`. Production: configure at
reverse-proxy / CDN level. Without these headers, Web Worker mode will fail.

## 5. Engine adapter contract
See [`../PRD.md`](../PRD.md#11-engine-adapter-design). Notes:
- `load()` is idempotent and may be called at boot (server) or lazily (browser).
- `synthesize()` returns an `ArrayBuffer` so both runtimes share the API shape.
- Adapters register in an **engine registry** keyed by id; the registry also holds
  license metadata surfaced by `GET /api/engines`.

### Chatterbox is NOT an in-process adapter — decided
Chatterbox is a **PyTorch** model (GPU-friendly), not ONNX. It cannot load inside
`onnxruntime-node`. It must run as a **separate Python sidecar service**; the Node
adapter for it is a thin HTTP client (`chatterbox` adapter → `POST` to sidecar).
This is a Phase 4 deployment-shape change, not "just another adapter."

## 6. Privacy & storage — decided
- API returns audio **in the HTTP response body**; it does **not** persist
  generated audio by default. The `./output` volume in `docker-compose.yml` is
  **optional / disabled by default** (only for future batch jobs). Persisting audio
  by default contradicts PRD §9.1 / §20 privacy stance and risks disk fill.
- No user text logging by default (`TTS_LOG_TEXT=false`). Logs carry text *length*,
  not text content.

## 7. Security posture (MVP, no auth)
- Validate body size and `text` length before inference (cheap reject first).
- Never echo `TTS_MODEL_PATH` or filesystem paths in error responses.
- CORS configurable; default `*` is convenient but means any site can spend your
  compute. For internet-exposed deploys, set `TTS_CORS_ORIGIN` and add a rate limit
  (compute-DoS is a real risk the PRD risk list omits).
- No hardcoded secrets.

## 8. Prior art (from KB MCP) — reference, not contradiction
WeiJun has working **Python** local demos for both engines (verified 2026-05-28):
Kokoro via `kokoro-onnx` + `misaki[zh]` (Chinese support, `is_phonemes=True` for
`zf_001`), and Piper via `piper-tts==1.4.2` + `rhasspy/piper-voices`. This PRD
chooses the **Node.js / onnxruntime** path instead. The Python demos are the
fastest way to validate model files, voices, and audio quality *before* committing
to the Node port. See [`KB-MCP.md`](KB-MCP.md).
