# Licensing & Commercial-Use Verification

This project is **commercial-use only**: every model, voice asset, library, and
**runtime phonemizer** must permit commercial use. This doc records the
verification rule and the known traps.

## Allowed vs not allowed
- **Allowed:** MIT, Apache-2.0, BSD, MPL-2.0 (if compatible).
- **Not allowed:** non-commercial, research-only, unknown, unclear-commercial, or
  model weights whose license differs from the code and is not commercially usable.

## Verification checklist (7 layers)
Before adding any engine/voice to the registry, verify and record:
1. Code license
2. Model weight license
3. Voice asset license
4. Dataset-related restriction (if stated)
5. Commercial use permission
6. Attribution requirement
7. **Runtime phonemizer license** ← added by eng review; the PRD's original 6-point
   list missed this and it is the most common real-world trap.

## ⚠️ The phonemizer trap (read this)
Kokoro and Piper both depend on a grapheme-to-phoneme (G2P) step at runtime.

### Kokoro per-language G2P dependency (researched 2026-06-07)

| Language | Kokoro code | G2P Engine | Needs espeak-ng? | GPL risk |
|----------|------------|------------|------------------|----------|
| US English | `a` | misaki.en.G2P (183k dict + BERT) | ❌ `fallback=None` works | **NONE** |
| UK English | `b` | misaki.en.G2P | ❌ `fallback=None` works | **NONE** |
| Japanese | `j` | misaki.ja.JAG2P | ❌ native | **NONE** |
| Mandarin Chinese | `z` | misaki.zh.ZHG2P | ❌ native | **NONE** |
| Korean | `k` | misaki g2pK | ❌ native | **NONE** |
| Vietnamese | `v` | misaki Viphoneme | ❌ native | **NONE** |
| **Spanish** | `e` | **espeak.EspeakG2P** | ✅ MANDATORY | ⚠️ YES |
| **French** | `f` | **espeak.EspeakG2P** | ✅ MANDATORY | ⚠️ YES |
| **Hindi** | `h` | **espeak.EspeakG2P** | ✅ MANDATORY | ⚠️ YES |
| **Italian** | `i` | **espeak.EspeakG2P** | ✅ MANDATORY | ⚠️ YES |
| **Portuguese** | `p` | **espeak.EspeakG2P** | ✅ MANDATORY | ⚠️ YES |

### English MVP — two GPL-free paths

1. **`kokoro-js` with `fallback=None`:** misaki's 183k-word dictionary handles
   English. The espeak-ng WASM binary is bundled in the npm package but NOT called
   for English when fallback is disabled. Rare OOV words get no phonemes
   (negligible impact for business English).
2. **[`@met4citizen/headtts`](https://github.com/met4citizen/HeadTTS) (MIT):**
   CMU Pronouncing Dictionary (134k words, BSD-like license) + NRL Report 7948
   rule-based algorithm (public domain) for OOV. **Zero espeak dependency.**
   Preferred path for clean licensing.

### GPL conveyance risk (espeak-ng WASM)

`kokoro-js` bundles espeak-ng as WASM (~2–5 MB) distributed via npm/jsdelivr CDN.
Under GPLv3 §0, distribution via CDN = "conveying". This means:
- espeak-ng WASM source code must be made available
- If WASM and kokoro-js constitute a "combined work", the entire project could
  be subject to GPLv3 (FSF position: dynamic linking = combined work; legally
  untested in court)

**Decision for MVP:** English only → GPL-free. Use HeadTTS (MIT + CMU dict) or
kokoro-js with espeak WASM not loaded for English. Multi-language expansion
(Phase 4) → espeak-ng WASM as SEPARATE user-installed plugin, not bundled in
core SDK. Similar to FFmpeg's codec model.

### Piper G2P

| Phonemizer | License | Risk |
|-----------|---------|------|
| `misaki` (Kokoro English) | MIT | ✅ clean |
| CMU dict + NRL rules (HeadTTS) | BSD-like + Public Domain | ✅ clean |
| `espeak-ng` (Piper; Kokoro multilingual fallback) | **GPL-v3** | ⚠️ evaluate |

`espeak-ng` is GPL-v3. *Using* it as a separate invoked process/library for a
self-hosted service is generally fine, but **bundling, statically linking, or
distributing a derivative** (e.g. a wasm build embedding espeak data) can impose
copyleft obligations on your distribution. **Decision for MVP:** use HeadTTS
(CMU dict + NRL rules) or kokoro-js with English misaki only to avoid espeak-ng
entirely; if espeak-ng is required for a language, isolate it behind the G2P
abstraction as a user-installed plugin — never bundle it into the core SDK.

## Per-model metadata file
Every engine ships `engines/<id>/license.json`:
```json
{
  "engine": "kokoro",
  "modelName": "Kokoro ONNX",
  "license": "Apache-2.0",
  "commercialUse": true,
  "requiresAttribution": false,
  "sourceUrl": "https://huggingface.co/hexgrad/Kokoro-82M",
  "verifiedAt": "2026-06-07",
  "notes": "Weights Apache-2.0. G2P via misaki (MIT) for EN; espeak-ng (GPL-v3) only if multilingual fallback is enabled — see LICENSING.md."
}
```

## Current engine status
| Engine | Code | Weights | Voices | Commercial | Notes |
|--------|------|---------|--------|-----------|-------|
| Kokoro ONNX | Apache-2.0 | Apache-2.0 | bundled | ✅ | default; verify misaki vs espeak-ng per language |
| Piper ONNX | MIT | MIT | **per-voice varies** | ✅ (code) | each voice in `rhasspy/piper-voices` has its own license (CC0 / CC BY / etc.) — build one metadata entry **per voice** |
| Chatterbox | MIT | MIT | — | ✅ | future; PyTorch sidecar, not in-process |

> Piper **voices** are the catch: the Piper code is MIT, but individual voices
> carry different licenses (some require attribution). Verify and record each voice
> you ship, not just the engine.

## Risk (PRD §22.1 expanded)
Code license ≠ weight license ≠ voice license ≠ phonemizer license. All four must
clear commercial use independently before an engine reaches the registry.
