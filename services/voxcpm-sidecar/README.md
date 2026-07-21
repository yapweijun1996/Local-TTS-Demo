# VoxCPM2 sidecar

Python sidecar serving [VoxCPM2](https://github.com/OpenBMB/VoxCPM) (OpenBMB,
Apache-2.0) over the HTTP contract consumed by
`apps/api/src/engines/voxcpmSidecar.ts`.

**Why this engine:** live listening tests (2026-07-21) rejected Qwen3-TTS and
CosyVoice 3 for zh/en code-switched content (accent bleed when a single
persona speaks both languages). VoxCPM2's in-call code-switch quality was
accepted directly — no per-language segment routing needed, unlike the other
two. See memory: `tts_voice_evaluation_findings.md` for the full trail.

The approved voice is **Voice Design** (a text description, no reference
audio) — see `DEFAULT_VOICE_DESC` in `app.py`. Do not change it without a new
listening-test round.

## Run locally

```bash
cd services/voxcpm-sidecar
python3.10 -m venv .venv && source .venv/bin/activate   # VoxCPM needs 3.10-3.12
pip install -r requirements.txt
uvicorn app:app --port 8200
```

First start downloads the model (~4GB, 2B params). Watch progress:

```bash
curl http://localhost:8200/health
# { "status": "loading", ... }  ->  { "status": "ok", "model_loaded": true }
```

Synthesize (mixed zh/en in one call — no segment routing needed):

```bash
curl -X POST http://localhost:8200/synthesize \
  -H 'content-type: application/json' \
  -d '{"text": "今天我们 review 一下 quarterly report。"}' \
  -o out.wav
```

## Wire into the Node API

```bash
TTS_VOXCPM_SIDECAR_URL=http://localhost:8200 pnpm --filter @local-tts/api dev
curl -X POST http://localhost:3000/api/tts \
  -H 'content-type: application/json' \
  -d '{"engine": "voxcpm2", "text": "Hello 你好"}' -o out.wav
```

## Env vars

| Var | Default | Notes |
|-----|---------|-------|
| `VOXCPM_MODEL` | `openbmb/VoxCPM2` | HF model id |
| `VOXCPM_MAX_TEXT_LENGTH` | `3000` | Keep in sync with API `TTS_MAX_TEXT_LENGTH` |
| `VOXCPM_DEFAULT_VOICE_DESC` | (approved elder-male prompt) | Override only for experimentation |

## Docker

```bash
docker build -t voxcpm-sidecar .
docker run -p 8200:8200 -v voxcpm-models:/models voxcpm-sidecar          # CPU
docker run --gpus all -p 8200:8200 -v voxcpm-models:/models voxcpm-sidecar  # GPU
```

## Advanced: custom voice / cloning

`POST /synthesize` accepts optional overrides for experimentation:
- `voice_description` — a different Voice Design prompt (Chinese or English)
- `reference_wav_path` — a reference audio clip for Controllable/Ultimate Cloning
  (path must be readable inside the sidecar's filesystem/container)
- `cfg_value` (default 2.0), `inference_timesteps` (default 10 — bumping to 30
  was tested and rejected as not worth the extra latency; see memory)
