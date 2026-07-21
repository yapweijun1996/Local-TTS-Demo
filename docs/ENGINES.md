# Engine & Model Catalog

Which TTS models we support, could add, and must avoid — organised by the two
constraints that actually matter for this project: **commercial license** (hard
gate) and **runtime tier** (cost gate). Naturalness is only compared *within*
those gates. License details: [`LICENSING.md`](LICENSING.md).

> **Research date:** 2026-06-09. Sources: 30 primary reads across Hugging Face
> model cards, GitHub repos, npm, and community benchmarks. Confidence notes
> are recorded per engine.

## The core reality: naturalness ≈ model capacity
> An 82M-parameter model is the **ceiling** for in-browser / CPU TTS. Kokoro is
> already #1 among open models on TTS Arena. Adding *another small model* will not
> remove "robotic" feel — the jump to human-level requires a large GPU LLM-TTS
> running server-side. This is a quality-vs-deployment trade, not a model-picking
> problem.

The roadmap splits into two tiers.

---

## ✅ Tier 1 — Browser / CPU (no new infra)

Runs in `apps/web` (onnxruntime-web + transformers.js) or a CPU Node process.

### Currently integrated

| # | Engine | npm package | License | Size (best) | Quality | Languages | Voices |
|---|--------|-------------|---------|-------------|---------|-----------|--------|
| 1 | **Kokoro-82M v1.0** | `kokoro-js` | Apache-2.0 | **86 MB** (q4f16) | ★★★★★ MOS 4.5 | 9 | 54+ |
| 2 | **Piper TTS** | `piper-plus` | MIT | ~75 MB | ★★★ MOS ~3.5 | 30+ | 900+ |

#### 1. Kokoro-82M v1.0 (default engine)

**Runtime:** `@huggingface/transformers` v4.x (wraps `onnxruntime-web`).
**WebGPU:** ✅ with WASM fallback.

Dtype guide:

| dtype | Size | Recommendation |
|-------|------|----------------|
| q4f16 | 86 MB | ✅ **Use this** — perceptibly identical to fp32 in blind tests |
| q8 | 92 MB | Alternative if q4f16 shows artefacts |
| fp16 | 163 MB | Overkill for browser; large download for no audible gain over q4f16 |
| fp32 | 326 MB | WebGPU-safe only; impractical for most users |

Languages: American English, British English, Japanese, Mandarin Chinese,
French, Spanish, Hindi, Italian, Brazilian Portuguese.

**G2P notes:** EN/JP/ZH/KO/VI use misaki (MIT, GPL-free). ES/FR/HI/IT/PT
require espeak-ng fallback (GPL-v3 risk) — see [`LICENSING.md`](LICENSING.md).

**Known issues in browser:**
- 510-token hard limit per call → use `TextSplitterStream` (kokoro-js v1.2.0+)
- FP16/Q4 silent-chunk G2P failure on certain inputs — split-fallback workaround
  implemented in `apps/web/src/engines/kokoro.ts`
- Peak RAM 330–520 MB (Chrome task manager)

**Latency (warm, 100 chars):**

| Hardware | Backend | RTF |
|----------|---------|-----|
| RTX 4070 | WebGPU | ~6.5× RT |
| M3 Pro | WebGPU | ~3.2× RT |
| 8-core CPU | WASM | ~0.5–1× RT |
| Mid-range mobile | WASM | ~0.3× RT |

---

#### 2. Piper TTS (multilingual fallback)

**Runtime:** `onnxruntime-web` (WASM only — no WebGPU path).
**npm:** `piper-plus` (MIT, no eSpeak-ng GPL dependency, 8 languages, 27 ms P50).
Also: `@mintplex-labs/piper-tts-web` (full 900+ voice library).

> ⚠️ **Upstream `rhasspy/piper` was archived October 2025** — now read-only.
> Migrate to `piper-plus` (MIT-clean) or `@mintplex-labs/piper-tts-web`.
> Do **not** take new dependencies on the archived repo.

Latency: 30–50 ms first-audio on modern laptop WASM. Fastest CPU throughput of
all evaluated engines.

**G2P notes:** eSpeak-ng is GPL-v3. `piper-plus` replaces it with a custom
MIT G2P for its 8 supported languages — preferred for commercial use.
Full 900+ voice library still requires eSpeak-ng; isolate behind G2P abstraction
as an opt-in plugin (never bundle in core SDK).

---

### Can add (integration work needed)

| # | Engine | Integration path | License | Size | Quality | Languages | Voices |
|---|--------|-----------------|---------|------|---------|-----------|--------|
| 3 | **Supertonic v3** | `onnxruntime-web` direct | ⚠️ OpenRAIL-M | 404 MB | ★★★★ B-grade | **31** | 10 + cloning |
| 4 | **KittenTTS nano** | community browser port | Apache-2.0 | **25 MB** | ★★★ C+ | 1 (EN) | 8 |
| 5 | **Sherpa-ONNX / MATCHA-TTS** | CDN WASM bundle | Apache-2.0 | **<10 MB** | ★★★ 1 spk | 2 (EN/ZH) | 1/lang |

#### 3. Supertonic v3 (Supertone, released 2026-04-29)

**Best choice for multilingual browser TTS beyond Kokoro's 9 languages.**

- 3 ONNX components: `text_encoder`, `latent_denoiser`, `voice_decoder` (flow-matching architecture, 99M params)
- 31 languages: Arabic, Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Latvian, Lithuanian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Turkish, Ukrainian, Vietnamese + `na` (language-agnostic)
- 10 preset voices (M1–M5, F1–F5); zero-shot voice cloning via Voice Builder
- Built-in text normalisation (dates, currency, phone numbers)
- Expression tags: `<laugh>`, `<breath>`, `<sigh>`
- GitHub: [`supertone-inc/supertonic`](https://github.com/supertone-inc/supertonic)

**WebGPU:** ✅ Latency on M4 Pro: 1,263 chars/sec (WASM) → 2,509 chars/sec (WebGPU).

**Integration:** No npm package. Vite integration via `onnxruntime-web` directly,
based on the browser examples in `/browser` of the supertonic repo. A PR for
transformers.js support exists (`transformers.js #1459`).

> ⚠️ **License flag:** OpenRAIL-M (Model) allows commercial use but carries
> use-based behavioural restrictions (no harmful content, no non-consensual
> deepfakes, etc.). This goes beyond MIT/Apache-2.0. Review against project's
> commercial-use policy in [`LICENSING.md`](LICENSING.md) before integrating.

---

#### 4. KittenTTS nano (KittenML)

- 15M parameters, 25 MB (int8) / 56 MB (fp16)
- 8 English voices: Bella, Jasper, Luna, Bruno, Rosie, Hugo, Kiki, Leo
- Ideal for: IoT displays, offline PWAs, sub-50 MB hard requirements
- GitHub: [`KittenML/KittenTTS`](https://github.com/KittenML/KittenTTS)
- No official npm; community browser port: [`LuanLima2907/kitten-tts-web`](https://github.com/LuanLima2907/kitten-tts-web)
- WASM latency (100 chars): 3–5 s (Chrome) — slower than Kokoro due to architecture
- v0.8 introduced ONNX2 format; verify sherpa-onnx compatibility if using that runtime

---

#### 5. Sherpa-ONNX / MATCHA-TTS (k2-fsa)

- MATCHA-TTS models: English (LJSpeech) and Chinese (Baker) — **under 10 MB each**
- Smallest viable neural TTS for browser; single speaker per language
- Sherpa-ONNX v1.13.2 (May 2026) — WASM bundle from GitHub Releases, CDN-served
- No npm; integrate via Vite `assetsInclude` + Web Worker loading
- Also bundles: Piper-VITS (full voice library), MeloTTS, Kokoro, KittenTTS under one WASM runtime

---

## 🔮 Tier 2 — GPU server-side sidecar (human-level quality)

PyTorch LLM-TTS models. **Cannot** run in `onnxruntime-node` — run each as a
separate Python sidecar service with a thin Node HTTP adapter.
All licenses verified commercial-friendly (2026-06-09):

| # | Engine | License | Quality | Best for |
|---|--------|---------|---------|----------|
| 6 | **Chatterbox** ⭐ | MIT | ★★★★★ | First GPU engine. Beats ElevenLabs in blind tests; emotion/exaggeration control |
| 7 | **Orpheus TTS** ⭐ | Apache-2.0 | ★★★★★ | Llama-3B, empathetic; inline emotion tags (`<laugh>`, `<sigh>`). Real-time streaming |
| 8 | **Higgs Audio V2** | ⚠️ custom (not Apache-2.0) | ★★★★ | Multi-speaker, expressive — see license flag below |
| 9 | **Dia 1.6B** | Apache-2.0 | ★★★★ | Dialogue / multi-turn scripts |
| 10 | **Qwen3-TTS** | Apache-2.0 | ★★★★★ (monolingual) | ⛔ **Rejected for zh/en code-switch** — see below |
| 11 | **VoxCPM2** ⭐ | Apache-2.0 | ★★★★★ | **Approved 2026-07-21** — native zh/en code-switch, one call, no routing |

**Recommended order:** VoxCPM2 (approved, use this) → Chatterbox/Orpheus (English-only use cases).

#### 10. Qwen3-TTS (Alibaba Qwen, open-sourced 2026-01) — ⛔ rejected for code-switch, 2026-07-21

- 0.6B–1.7B parameters; weights + inference code Apache-2.0
  ([repo](https://github.com/QwenLM/Qwen3-TTS), [LICENSE](https://github.com/QwenLM/Qwen3-TTS/blob/main/LICENSE), verified 2026-07-20)
- 10 languages: zh, en, ja, ko, de, fr, ru, pt, es, it. Streaming generation
  (~97 ms first-audio), free-form voice design, voice cloning
- Serving: HuggingFace transformers + vLLM. **No ONNX export** — LM-based
  autoregressive + codec decoder, so not Tier 1 viable
- VRAM: ~3.4 GB for 1.7B fp16 — runs on entry-level GPUs
- ⛔ **Rejected on live listening tests (2026-07-21):** every built-in speaker
  is bound to one dominant training language — a Mandarin-native persona
  (e.g. `vivian`) speaking English carries a heavy accent, and an
  English-native persona (`ryan`) speaking Chinese does the same in reverse,
  even when each language segment is synthesized in its own isolated call
  (per-language routing does NOT fix this — the persona itself is the
  problem, not in-call mixing). `vivian` specifically is **banned** — see
  memory: `tts_voice_evaluation_findings.md`. Superseded by VoxCPM2 (#11).
- ⚠️ Voice cloning needs abuse safeguards + ToS coverage before any hosted deployment (moot while rejected)

#### 11. VoxCPM2 (Tsinghua OpenBMB, released 2026-04) — ⭐ approved 2026-07-21

- 2B parameters, 2M+ hours training data, tokenizer-free diffusion-autoregressive
  architecture (not a discrete-codebook LM like Qwen3-TTS/CosyVoice) — this
  architectural difference is likely *why* its code-switch quality held up
  where the other two failed
  ([repo](https://github.com/OpenBMB/VoxCPM), [LICENSE](https://github.com/OpenBMB/VoxCPM/blob/main/LICENSE),
  HF card `license: apache-2.0` confirmed, verified 2026-07-21 — both code and weights clean, no scale-trigger caveats)
- 30 languages including zh/en + 9 Chinese dialects; 48kHz studio-quality output
- **Voice Design**: generate a voice from a natural-language description alone,
  no reference audio needed — format `"(description)text..."`. Also supports
  Controllable/Ultimate Cloning from a reference clip
- **Accepted on live listening tests feeding mixed zh/en text in ONE call** —
  no per-language segment routing needed, unlike Qwen3-TTS/CosyVoice 3
- Approved default voice (do not change without a new listening-test round):
  `"一位年长男性，声音浑厚低沉，语速缓慢沉稳，像一位经验丰富的长辈在耐心讲解"`
  (older male, deep/mellow, slow steady pace) with `cfg_value=2.0, inference_timesteps=10`.
  Female voices and fast-paced male voices were explicitly rejected in the same round.
- Install: clean `pip install voxcpm` (Python 3.10–3.12) — no git submodules,
  no manual model-download scripts, no C++ build toolchain needed. Notably
  smoother to stand up than CosyVoice 3 or GLM-TTS
- Sidecar: `services/voxcpm-sidecar/` (Tier 2, same HTTP contract pattern as Qwen's sidecar)
- See memory: `tts_voice_evaluation_findings.md` for the full evaluation trail

#### License flag: Higgs Audio V2 is NOT Apache-2.0 (correction, 2026-07-21)

Widely repeated as Apache-2.0 (including in this doc, until now) — **wrong**.
Primary-source check: the HF model card (`bosonai/higgs-audio-v2-generation-3B-base`)
declares `license: other`, and the actual text is the **"Boson Higgs Audio 2
Community License Agreement"** (Meta Llama 3 Community License terms
incorporated by reference, since the model is Llama-3-derived). Key
restriction: if annual active users exceed 100,000, a separate commercial
license must be requested from Boson AI — the same "custom RAIL-style license
with a scale trigger" pattern as IndexTTS-2 (`docs/LICENSING.md`). Not
blocked outright, but does not meet the clean Apache-2.0/MIT bar (PRD §6) —
treat like Supertonic v3's OpenRAIL-M flag: review before integrating, don't
assume it's a no-strings-attached engine.

**Same trap, different model:** IndexTTS-2 (bilibili) was also researched
2026-07-21 and is **not Apache-2.0** despite what search-engine summaries
claim — it's a custom "bilibili Model Use License Agreement" with a
100-million-MAU / ¥1B-revenue commercial trigger and PRC arbitration
jurisdiction. Not added to the "Cannot use" table below since it's not
outright non-commercial-blocked (small-scale use is permitted), but it fails
the clean-license bar the same way Higgs Audio V2 does — verify the primary
LICENSE file yourself before trusting any "Apache-2.0" claim about a
bilibili/Boson/Meta-Llama-derived audio model.

---

## ⛔ Cannot use — license blocked

| Model | License | Reason blocked |
|-------|---------|----------------|
| XTTS-v2 (Coqui) | CPML | Non-commercial without paid license |
| F5-TTS | CC-BY-NC 4.0 | Non-commercial (weights + Emilia dataset) |
| Fish Speech / OpenAudio | Fish Audio Research License | Non-commercial; commercial = hosted API only |
| **Meta MMS-TTS / VITS** | CC-BY-NC 4.0 | Non-commercial — 1,100+ languages but blocked |
| **OuteTTS-0.2-500M** | CC-BY-NC 4.0 | Non-commercial + 798 MB at q4 |

> MMS-TTS and OuteTTS were evaluated in the 2026-06-09 research sweep. Both fail the
> commercial gate despite strong language coverage (MMS) or voice-cloning capability
> (OuteTTS). Do not add.

---

## ❌ Not browser-viable (as of 2026-06-09)

| Model | Reason |
|-------|--------|
| Parler-TTS Mini (880M) | No ONNX conversion; ~3.5 GB fp32 |
| Orpheus-TTS | Llama-3B; no ONNX; GPU-only server |
| Qwen3-TTS (0.6B–1.7B) | No ONNX export; autoregressive LM + codec decoder — 7–20× Kokoro size, WASM-hostile. Tier 2 only |
| SpeechT5 | Outclassed by Kokoro on all dimensions; deprecated for this project |

> Monitor Parler-TTS and Orpheus compact variants (150M, 400M) — ONNX conversions
> may land in late 2026 and make them viable for Tier 1.

---

## Naturalness improvement without new models (do this first)

1. **Default to Kokoro q4f16** (86 MB) — already done.
2. **Expose best voices first:** `af_heart`, `af_bella`, `am_michael` for Kokoro;
   `en_US-lessac-medium` over `en_US-amy-low` for Piper.
3. **Feed sentence-segmented text** via `segmentText` from `@local-tts/core` with
   punctuation preserved — prosody improves with proper chunking.

---

## How a new engine plugs in

- **Tier 1 (ONNX browser):** implement `TtsEngine` (`@local-tts/core`) over
  `onnxruntime-web`, register in the engine registry with a `license.json`
  (PRD §6, task `DOC-3`). Ship voice loading in a Web Worker.
- **Tier 2 (GPU sidecar):** stand up the Python service; implement a `TtsEngine`
  adapter whose `synthesize()` does an HTTP `POST` to the sidecar. The registry
  entry still carries license metadata for `GET /api/engines`.

Either way: never hardcode a model in UI/API logic (PRD §24 rules 1–2).
Run the 7-layer license check ([`LICENSING.md`](LICENSING.md)) before any engine
reaches the registry.
