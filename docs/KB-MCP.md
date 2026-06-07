# KB MCP — Project Knowledge Persistence

This project persists durable knowledge to the **KB MCP** server
(`https://kb.yapweijun1996.com`) so decisions survive across sessions and agents.

## Project KB
| Field | Value |
|-------|-------|
| KB name | `local-tts-demo` |
| KB id | `83b9ecff-e579-461c-8842-f23a379a1300` |
| Visibility | user |
| Purpose | PRD decisions, eng-review findings, licensing traps, build status |

## Write routing (per global SSOT rules)
- **Project-specific facts** (a Kokoro adapter decision, a Piper voice license, a
  Docker fix) → `kb_add_item` into `local-tts-demo` (id above). Do **not** also
  `kb_remember` the same fact — it pollutes cross-project recall.
- **Reusable cross-project patterns** (e.g. "how to validate ONNX TTS models in
  Python before a Node port") → `kb_remember` (auto-routed to brain memory).
- **Personal/infra facts** → `claude-persistent-memory` KB.

## Session start
At the start of a session touching this project, run:
```text
kb_recall  "Local TTS Demo Kokoro/Piper ONNX decisions and build status"
kb_search  against KB id 83b9ecff-… for project history
```
`kb_recall` alone can miss project facts — also search the project KB directly.

## Prior proven art (already in brain KB, verified 2026-05-28)
These pre-date this PRD and de-risk implementation. They used **Python**, while
this PRD targets **Node.js / onnxruntime** — use them to validate models/voices
and audio quality first, then port:

- **Kokoro (Python):** Python 3.13 (not 3.14) + `kokoro-onnx==0.5.0` + `soundfile`
  + `misaki[zh]`. Chinese (v1.1) needs `kokoro-v1.1-zh.onnx`, `voices-v1.1-zh.bin`,
  upstream `config.json` vocab; `Kokoro(model, voices, vocab_config=config)`,
  `zh.ZHG2P()` (no `version` arg in misaki 0.7.4), `is_phonemes=True` for Chinese
  voices like `zf_001`. Verified macOS, Chrome port 8777. Caveat: launching the
  venv Python via launchd/nohup can hang during interpreter init — run foreground.
- **Piper (Python):** `piper-tts==1.4.2` + HF `rhasspy/piper-voices` `.onnx` +
  matching `.onnx.json`. Invoke `piper -m <voice.onnx> -c <voice.onnx.json> -f out.wav`
  with text on stdin. Keep a server-side `voiceId → model/config` registry, validate
  ids, expose `/api/voices` with readiness. `en_US-lessac-medium` > `en_US-amy-low`
  for naturalness; `zh_CN-huayan-medium` for Chinese. Avoid reusing localhost ports
  that hosted PWAs (stale service workers serve the wrong app). Verified Chrome 8766.

## What to record as the project progresses
After each phase lands, `kb_add_item` into `local-tts-demo`:
- Which model files / quantization / voices were chosen and why.
- Real measured RTF / load time vs the targets in [ARCHITECTURE.md §4](ARCHITECTURE.md#4-performance-targets--made-measurable).
- Any license verification result (especially Piper per-voice and the espeak-ng
  G2P decision — see [LICENSING.md](LICENSING.md)).
- Bugs + root cause (e.g. WebGPU vs WASM fallback issues, worker-thread pool tuning).
