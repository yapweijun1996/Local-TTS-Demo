# HTTP API Reference

Base URL (default): `http://localhost:3000`. No authentication in MVP. No API keys.
All errors return JSON in the [error format](#error-format).

## `POST /api/tts`
Generate speech from text. Returns an audio file (binary).

**Request body**
```json
{
  "text": "Hello, welcome to the system.",
  "voice": "default",
  "engine": "kokoro",
  "format": "wav"
}
```
| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| `text` | yes | — | trimmed; rejected if empty or > `TTS_MAX_TEXT_LENGTH` |
| `voice` | no | `TTS_DEFAULT_VOICE` | must exist in the engine's voice list |
| `engine` | no | `TTS_ENGINE` | must be a registered, available engine |
| `format` | no | `wav` | MVP supports `wav` only |

**Response** — `200 OK`, `Content-Type: audio/wav`, body = WAV bytes.

**Errors:** `EMPTY_TEXT`, `TEXT_TOO_LONG`, `ENGINE_NOT_FOUND`, `VOICE_NOT_FOUND`,
`MODEL_LOAD_FAILED`, `GENERATION_FAILED`, `UNSUPPORTED_FORMAT`.

```bash
curl -X POST http://localhost:3000/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","voice":"default","engine":"kokoro","format":"wav"}' \
  --output out.wav
```

## `GET /api/voices`
```json
{ "voices": [ { "id": "default", "name": "Default Voice", "language": "en", "engine": "kokoro" } ] }
```
Optional query: `?engine=kokoro` to filter by engine.

## `GET /api/engines`
```json
{ "engines": [ { "id": "kokoro", "name": "Kokoro ONNX", "status": "available", "license": "Apache-2.0", "commercialUse": true } ] }
```
`status` is `available` | `unavailable` | `loading`. License fields come from each
engine's metadata file (see [LICENSING.md](LICENSING.md)).

## `GET /health`
```json
{ "status": "ok", "engine": "kokoro", "modelLoaded": true }
```
Used by the Docker `HEALTHCHECK`. Returns `status: "ok"` once the default engine
has loaded; `degraded` if the model failed to load.

## Error format
```json
{
  "error": {
    "code": "TEXT_TOO_LONG",
    "message": "Text exceeds maximum allowed length.",
    "details": { "maxLength": 3000 }
  }
}
```
| Code | HTTP | Meaning |
|------|------|---------|
| `EMPTY_TEXT` | 400 | text missing or blank after trim |
| `TEXT_TOO_LONG` | 400 | exceeds `TTS_MAX_TEXT_LENGTH` |
| `UNSUPPORTED_FORMAT` | 400 | requested format not in MVP |
| `ENGINE_NOT_FOUND` | 404 | engine id not registered |
| `VOICE_NOT_FOUND` | 404 | voice id not in engine |
| `MODEL_LOAD_FAILED` | 503 | engine model could not load |
| `GENERATION_FAILED` | 500 / 503 | inference error or queue saturated |

Errors must **never** include filesystem paths or `TTS_MODEL_PATH` (see
[ARCHITECTURE.md §7](ARCHITECTURE.md#7-security-posture-mvp-no-auth)).
