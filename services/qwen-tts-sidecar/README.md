# Qwen3-TTS sidecar

Python sidecar serving [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
(Apache-2.0) over the HTTP contract consumed by
`apps/api/src/engines/qwenSidecar.ts`. See docs/ENGINES.md #10 for why this is
a Tier 2 sidecar and not an in-process engine.

## Run locally

```bash
cd services/qwen-tts-sidecar
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --port 8100
```

First start downloads the model (~1.5 GB for 0.6B). Watch progress:

```bash
curl http://localhost:8100/health
# { "status": "loading", ... }  ->  { "status": "ok", "model_loaded": true }
```

Synthesize (native zh/en code-switch in one call — no segment routing needed):

```bash
curl -X POST http://localhost:8100/synthesize \
  -H 'content-type: application/json' \
  -d '{"text": "今天我们 review 一下 quarterly report。", "voice": "vivian"}' \
  -o out.wav
```

## Wire into the Node API

```bash
TTS_SIDECAR_URL=http://localhost:8100 pnpm --filter @local-tts/api dev
curl -X POST http://localhost:3000/api/tts \
  -H 'content-type: application/json' \
  -d '{"engine": "qwen3-tts", "text": "Hello 你好", "voice": "serena"}' -o out.wav
```

## Env vars

| Var | Default | Notes |
|-----|---------|-------|
| `QWEN_TTS_MODEL` | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | 1.7B-CustomVoice for quality (needs ~3.4 GB VRAM bf16) |
| `QWEN_TTS_DEVICE` | `auto` | `cuda:0` / `mps` / `cpu` |
| `QWEN_TTS_MAX_TEXT_LENGTH` | `3000` | Keep in sync with API `TTS_MAX_TEXT_LENGTH` |

## Docker

```bash
docker build -t qwen-tts-sidecar .
docker run -p 8100:8100 -v qwen-models:/models qwen-tts-sidecar          # CPU
docker run --gpus all -p 8100:8100 -v qwen-models:/models qwen-tts-sidecar  # GPU
```

## Scaling note (not needed for the prototype)

The `qwen-tts` package serves one request at a time (`_generate_lock`). For
production throughput, replace the in-process model with vLLM serving
(`vLLM Usage` section of the upstream README) behind the same HTTP contract —
the Node adapter does not change.
