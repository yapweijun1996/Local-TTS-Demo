"""Qwen3-TTS sidecar — FastAPI HTTP service wrapping the `qwen-tts` package.

Tier 2 engine (docs/ENGINES.md #10): PyTorch LM-based TTS cannot run inside the
Node process, so it runs here as a sidecar. The Node API talks to this service
via the thin HTTP contract below; the `TtsEngine` adapter lives in
apps/api/src/engines/qwenSidecar.ts.

Contract (mirrors PRD §15 error envelope so the Node adapter can pass codes through):
  GET  /health     -> { status: "ok"|"loading"|"error", model, model_loaded }
  GET  /voices     -> { voices: [{ id, name, language }] }
  POST /synthesize -> audio/wav bytes (X-Sample-Rate / X-Duration-Ms headers)
                      errors: { error: { code, message } }

Env:
  QWEN_TTS_MODEL            HF model id or local path (default 0.6B CustomVoice)
  QWEN_TTS_DEVICE           auto | cuda:0 | mps | cpu   (default auto)
  QWEN_TTS_MAX_TEXT_LENGTH  default 3000 (matches API TTS_MAX_TEXT_LENGTH)
"""

from __future__ import annotations

import io
import os
import threading
import wave
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

MODEL_ID = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
DEVICE = os.environ.get("QWEN_TTS_DEVICE", "auto")
MAX_TEXT_LENGTH = int(os.environ.get("QWEN_TTS_MAX_TEXT_LENGTH", "3000"))

# CustomVoice built-in speakers (README table, verified 2026-07-20). Used as the
# /voices fallback while the model is still loading; once loaded the live
# model.get_supported_speakers() list takes precedence.
BUILTIN_SPEAKERS = [
    {"id": "Vivian", "name": "Vivian (bright young female)", "language": "zh"},
    {"id": "Serena", "name": "Serena (warm gentle female)", "language": "zh"},
    {"id": "Uncle_Fu", "name": "Uncle Fu (low mellow male)", "language": "zh"},
    {"id": "Dylan", "name": "Dylan (Beijing dialect male)", "language": "zh"},
    {"id": "Eric", "name": "Eric (Sichuan dialect male)", "language": "zh"},
    {"id": "Ryan", "name": "Ryan (rhythmic male)", "language": "en"},
    {"id": "Aiden", "name": "Aiden (sunny American male)", "language": "en"},
    {"id": "Ono_Anna", "name": "Ono Anna (playful female)", "language": "ja"},
    {"id": "Sohee", "name": "Sohee (warm female)", "language": "ko"},
]

# TtsInput.language codes -> Qwen language names. Unknown values pass through
# untouched (the model also accepts full names like "Chinese" directly).
LANGUAGE_BY_CODE = {
    "zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean",
    "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese",
    "es": "Spanish", "it": "Italian", "auto": "Auto",
}

_state: dict[str, Any] = {"model": None, "error": None}
_load_lock = threading.Lock()
# One generation at a time: the model owns a single GPU/accelerator context.
_generate_lock = threading.Lock()


def _resolve_device() -> str:
    if DEVICE != "auto":
        return DEVICE
    import torch

    if torch.cuda.is_available():
        return "cuda:0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load_model() -> None:
    """Blocking model load — runs on a background thread at startup."""
    try:
        import torch
        from qwen_tts import Qwen3TTSModel

        device = _resolve_device()
        # bf16 halves VRAM on CUDA; fall back to fp32 elsewhere (MPS bf16 support
        # is inconsistent and CPU bf16 is slower than fp32 on most x86).
        dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
        _state["model"] = Qwen3TTSModel.from_pretrained(
            MODEL_ID, device_map=device, dtype=dtype
        )
    except Exception as e:  # surfaced via /health, never crashes the server
        _state["error"] = f"{type(e).__name__}: {e}"


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    threading.Thread(target=_load_model, daemon=True).start()
    yield


app = FastAPI(title="qwen-tts-sidecar", lifespan=_lifespan)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def _encode_wav(samples: Any, sample_rate: int) -> bytes:
    """float PCM [-1,1] -> 16-bit mono WAV via stdlib (no soundfile dependency)."""
    import numpy as np

    arr = np.clip(np.asarray(samples, dtype=np.float32).reshape(-1), -1.0, 1.0)
    pcm = (arr * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = "Vivian"
    language: str = "Auto"
    instruct: str = ""


@app.get("/health")
def health() -> dict[str, Any]:
    loaded = _state["model"] is not None
    status = "ok" if loaded else ("error" if _state["error"] else "loading")
    return {"status": status, "model": MODEL_ID, "model_loaded": loaded, "error": _state["error"]}


@app.get("/voices")
def voices() -> dict[str, Any]:
    model = _state["model"]
    if model is not None:
        try:
            supported = model.get_supported_speakers()
            known = {s["id"]: s for s in BUILTIN_SPEAKERS}
            return {
                "voices": [
                    known.get(spk, {"id": spk, "name": spk, "language": "auto"})
                    for spk in supported
                ]
            }
        except Exception:
            pass  # fall through to the static table
    return {"voices": BUILTIN_SPEAKERS}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):  # sync def -> FastAPI runs it in a worker thread
    model = _state["model"]
    if model is None:
        if _state["error"]:
            return _error(503, "MODEL_LOAD_FAILED", _state["error"])
        return _error(503, "MODEL_LOAD_FAILED", "Model is still loading; retry shortly.")

    text = req.text.strip()
    if not text:
        return _error(400, "EMPTY_TEXT", "Text is empty.")
    if len(text) > MAX_TEXT_LENGTH:
        return _error(400, "TEXT_TOO_LONG", f"Text exceeds maximum length ({MAX_TEXT_LENGTH}).")

    language = LANGUAGE_BY_CODE.get(req.language.lower(), req.language or "Auto")
    try:
        with _generate_lock:
            wavs, sr = model.generate_custom_voice(
                text=text,
                language=language,
                speaker=req.voice,
                **({"instruct": req.instruct} if req.instruct else {}),
            )
    except Exception as e:
        msg = str(e)
        if "speaker" in msg.lower():
            return _error(404, "VOICE_NOT_FOUND", msg)
        return _error(500, "GENERATION_FAILED", f"{type(e).__name__}: {msg}")

    wav_bytes = _encode_wav(wavs[0], int(sr))
    duration_ms = int((len(wav_bytes) - 44) / 2 / int(sr) * 1000)
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"X-Sample-Rate": str(int(sr)), "X-Duration-Ms": str(duration_ms)},
    )
