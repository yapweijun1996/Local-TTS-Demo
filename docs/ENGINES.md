# Engine & Model Catalog

Which TTS models we support, could add, and must avoid — organized by the two
constraints that actually matter for this project: **commercial license** (hard
gate) and **runtime tier** (cost gate). Naturalness is only compared *within*
those gates. License details: [`LICENSING.md`](LICENSING.md).

## The core reality: naturalness ≈ model capacity
> An 82M-parameter model is the **ceiling** for in-browser / CPU TTS. Kokoro is
> already #1 among open models on TTS Arena. Adding *another small model* will not
> remove "robotic" feel — the jump to human-level requires a large GPU LLM-TTS
> running server-side. This is a quality-vs-deployment trade, not a model-picking
> problem.

So the roadmap splits into two tiers.

## Tier 1 — Browser / CPU (no new infra)
Runs in `apps/web` (onnxruntime-web) or a CPU Node process. Ships today.

| Engine | License | Naturalness | Notes |
|--------|---------|-------------|-------|
| **Kokoro ONNX** (default) | Apache-2.0 | ★★★★ (best small) | 82M, 24 kHz. Model supports ~10 langs (EN/JP/ZH/ES/FR/HI/IT/PT). **kokoro-js v1.2.1 only bundles EN voices** (20 US + 8 GB). ZH/JP voices need a kokoro-js update or manual voice-pack loading. GPL-free EN/ZH/JP/KO via misaki. **Use FP16 (163 MB), not Q4, for quality.** |
| **Piper ONNX** (fallback) | MIT (voices vary) | ★★ (robotic) | VITS, 50+ langs, 100+ voices incl. `zh_CN-huayan-medium`. espeak-ng WASM (GPL-v3). Keep for multilingual breadth, not naturalness. **ZH path carries GPLv3 risk — prefer Kokoro ZH or Tier 2 for commercial use.** |
| Kitten TTS | Apache-2.0 | ★★ | 15–25 MB, ultra-light CPU/browser. For extreme low-resource, **not** for naturalness. |
| MeloTTS | MIT | ★★★ | VITS, CPU real-time, EN/ZH/ES/FR/JA/KO. Slightly below Kokoro; needs Python or ONNX export. |

**To reduce "robotic" feel without new models (do this first):**
1. Default to **Kokoro FP16**, never Q4, for the quality-sensitive path.
2. Expose Kokoro's most natural voices: `af_heart`, `af_bella`, `am_michael`
   (Piper: prefer `en_US-lessac-medium` over `amy-low`).
3. Feed sentence-segmented text (`@local-tts/core` `segmentText`) with punctuation
   preserved — prosody improves with proper chunking.

### Mandarin / Chinese support (2026-06-07 audit)

| Path | Quality | License | Ready? |
|------|---------|---------|--------|
| **Kokoro ZH** (native model) | ★★★★ | Apache-2.0 (misaki[zh], GPL-free) | ❌ kokoro-js v1.2.1 doesn't bundle ZH voices (8 voices: `zf_*`). Model supports them — need JS package update. |
| **Piper ZH** (`zh_CN-huayan-medium`) | ★★ | MIT (code), **GPLv3 (espeak-ng)** | ✅ Works today. But naturalness is robotic + GPLv3 phonemizer is a commercial dead-end. |
| **MeloTTS ZH** | ★★★ | MIT | ⚠️ Needs Python or ONNX export. No browser adapter yet. |
| **Tier 2 ZH** (Chatterbox / Orpheus) | ★★★★★ | MIT / Apache-2.0 | 🔮 Future. Solves both quality + license in one move. |

**Action plan:**
1. **Short-term:** Improve Piper ZH UI discoverability (voice dropdown groups by language, not English-first). zh_CN voices work today — let users find them.
2. **Mid-term:** Track `kokoro-js` releases for ZH voice-pack support. When it lands, switch ZH default to Kokoro (GPL-free, 4★ quality).
3. **Long-term:** Tier 2 GPU sidecar obsoletes Piper ZH entirely — Chatterbox/Orpheus give 5★ Mandarin with MIT/Apache-2.0.

## Tier 2 — GPU server-side (sidecar) for human-level voice
PyTorch LLM-TTS models. **Cannot** load in `onnxruntime-node` — run each as a
separate Python sidecar service with a thin Node HTTP adapter (the
"Chatterbox-as-sidecar" pattern, see [`ARCHITECTURE.md`](ARCHITECTURE.md#chatterbox-is-not-an-in-process-adapter--decided)).
All commercial-friendly (licenses verified 2026-06-07):

| Engine | License | Naturalness | Best for |
|--------|---------|-------------|----------|
| **Chatterbox** ⭐ | MIT | ★★★★★ | First GPU engine. Beats ElevenLabs in blind tests; emotion/exaggeration control. |
| **Orpheus TTS** ⭐ | Apache-2.0 | ★★★★★ | Llama-based, empathetic; inline emotion tags (`<laugh>`, `<sigh>`). Real-time streaming. |
| Higgs Audio V2 | Apache-2.0 | ★★★★ | Multi-speaker, expressive. |
| Dia 1.6B | Apache-2.0 | ★★★★ | Dialogue / multi-turn scripts. |

**Recommended order:** Chatterbox (most stable quality) → Orpheus (emotive). Both
reuse one sidecar contract; adding the second engine is config + adapter, not new
infra.

## ⛔ Avoid — commercially incompatible (quality is good, license is not)
Do **not** add these despite strong quality. See
[`LICENSING.md`](LICENSING.md#-commercially-incompatible-models-do-not-use).

| Model | License | Why blocked |
|-------|---------|-------------|
| XTTS-v2 (Coqui) | CPML | Non-commercial without separate paid license |
| F5-TTS | CC-BY-NC 4.0 | Non-commercial (weights + Emilia dataset) |
| Fish Speech / OpenAudio | Fish Audio Research License | Non-commercial; commercial only via their API |
| Meta MMS / some VITS | CC-BY-NC 4.0 | Non-commercial |

## How a new engine plugs in
- **Tier 1 (ONNX):** implement `TtsEngine` (`@local-tts/core`) over onnxruntime,
  register in the engine registry with a `license.json` (PRD §6, task `DOC-3`).
- **Tier 2 (sidecar):** stand up the Python service; implement a `TtsEngine`
  adapter whose `synthesize()` does an HTTP `POST` to the sidecar. The registry
  entry still carries license metadata for `GET /api/engines`.

Either way: never hardcode a model in UI/API logic (PRD §24 rule 1–2).
