# Kokoro v1.1-zh sidecar

This small FastAPI service runs the official Python Kokoro pipeline with
`misaki[zh]`. It exists because the current `kokoro-js` package exposes the
older English-only voice catalog and cannot load `zf_*` Mandarin voices.

The model `hexgrad/Kokoro-82M-v1.1-zh` is Apache-2.0. The default voice is
`zf_001`; the service is intended for the commercial-only Local-TTS route.
Embedded English uses Misaki's dictionary/rule G2P with its optional eSpeak
fallback disabled; do not enable that fallback or add other eSpeak-backed
languages without a separate license review.

It shares the VoxCPM sidecar virtual environment because both services use
PyTorch. The PM2 preset starts it on `127.0.0.1:8201`.

The shared environment should also contain spaCy's `en_core_web_sm` package;
the launchd installer provisions it. Without that package the first warm-up may
attempt a network download before `/health` becomes ready.

The sidecar protects Kokoro's non-English 510-phoneme model limit at the API
boundary. It measures the loaded `pipeline.g2p` output, prefers Chinese sentence
boundaries, splits oversized sentences only when necessary, and verifies that
the concatenated chunks preserve every input character. Model-result edge
padding is trimmed to a short 80ms breathing space before chunks are joined;
pauses inside a spoken result are preserved.

```bash
cd services/kokoro-sidecar
../voxcpm-sidecar/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8201
```

```bash
curl http://127.0.0.1:8201/health
curl -X POST http://127.0.0.1:8201/synthesize \
  -H 'content-type: application/json' \
  -d '{"text":"这是商业用途的中文语音测试。","voice":"zf_001"}' \
  -o out.wav
```
