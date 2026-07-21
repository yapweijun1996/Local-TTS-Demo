"""VoxCPM2 sidecar — FastAPI HTTP service wrapping the `voxcpm` package.

Tier 2 engine (docs/ENGINES.md): PyTorch model, cannot run inside the Node
process, so it runs here as a sidecar. The Node API talks to this service via
the thin HTTP contract below; the `TtsEngine` adapter lives in
apps/api/src/engines/voxcpmSidecar.ts.

VoxCPM2 itself has no fixed speaker catalog (unlike Qwen3-TTS) -- it uses
either Voice Design (a natural-language description, no reference audio) or
Controllable/Ultimate Cloning (a reference audio clip). This service pins a
small, listening-test-approved VOICE_CATALOG of Voice Design prompts so
callers pick a stable id instead of hand-rolling a fresh, unvalidated
description every time (see memory: tts_voice_evaluation_findings.md).

Contract (mirrors PRD §15 error envelope, same shape as qwen-tts-sidecar):
  GET  /health     -> { status: "ok"|"loading"|"error", model, model_loaded }
  GET  /voices     -> { voices: [{ id, name, language }] }  (VOICE_CATALOG entries)
  POST /synthesize -> audio/wav bytes (X-Sample-Rate / X-Duration-Ms headers)
                      errors: { error: { code, message } }

Env:
  VOXCPM_MODEL              HF model id (default openbmb/VoxCPM2)
  VOXCPM_MAX_TEXT_LENGTH    default 3000 (matches API TTS_MAX_TEXT_LENGTH)
  VOXCPM_DEFAULT_VOICE_DESC override the approved default Voice Design prompt
"""

from __future__ import annotations

import io
import os
import threading
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

MODEL_ID = os.environ.get("VOXCPM_MODEL", "openbmb/VoxCPM2")
MAX_TEXT_LENGTH = int(os.environ.get("VOXCPM_MAX_TEXT_LENGTH", "3000"))

# Approved 2026-07-21 (see memory: tts_voice_evaluation_findings.md) -- a
# senior-executive male voice, steady and measured, won a 4-way comparison
# on business-register content (the earlier "warm elder male" was the winner
# on a different, more casual script -- see CATALOG below for both). Do not
# change this default without a new listening-test round; female and
# fast-paced male voices were explicitly rejected in the same evaluation.
DEFAULT_VOICE_DESC = os.environ.get(
    "VOXCPM_DEFAULT_VOICE_DESC",
    "一位资深企业高管，声音沉稳有分量，语速适中偏慢，用词干脆，带着经验和权威感，但不生硬",
)

DEFAULT_VOICE_ID = "senior-executive-male"

# Fixed voice catalog -- both entries listening-test approved (2026-07-21).
# Extend this dict (and re-test) rather than hand-rolling ad-hoc descriptions
# per request; the whole point of a catalog is a caller picks an id, not a
# fresh unvalidated prompt each time.
VOICE_CATALOG: dict[str, dict[str, str]] = {
    DEFAULT_VOICE_ID: {
        "name": "Senior executive (default)",
        "language": "auto",
        "description": DEFAULT_VOICE_DESC,
    },
    "warm-elder-male": {
        "name": "Warm elder male",
        "language": "auto",
        "description": "一位年长男性，声音浑厚低沉，语速缓慢沉稳，像一位经验丰富的长辈在耐心讲解",
    },
}

_state: dict[str, Any] = {"model": None, "error": None}
_generate_lock = threading.Lock()  # one generation at a time (single GPU/MPS context)


def _load_model() -> None:
    try:
        from voxcpm import VoxCPM

        _state["model"] = VoxCPM.from_pretrained(MODEL_ID, load_denoiser=False)
    except Exception as e:  # surfaced via /health, never crashes the server
        _state["error"] = f"{type(e).__name__}: {e}"


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    threading.Thread(target=_load_model, daemon=True).start()
    yield


app = FastAPI(title="voxcpm-sidecar", lifespan=_lifespan)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE_ID
    # Advanced overrides -- optional, for experimentation only. Most callers
    # should just use `voice` and get the approved default.
    voice_description: Optional[str] = None
    reference_wav_path: Optional[str] = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10


@app.get("/health")
def health() -> dict[str, Any]:
    loaded = _state["model"] is not None
    status = "ok" if loaded else ("error" if _state["error"] else "loading")
    return {"status": status, "model": MODEL_ID, "model_loaded": loaded, "error": _state["error"]}


@app.get("/voices")
def voices() -> dict[str, Any]:
    return {
        "voices": [
            {"id": vid, "name": v["name"], "language": v["language"]}
            for vid, v in VOICE_CATALOG.items()
        ]
    }


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

    # Voice Design prefix format: "(description)text..." -- skipped when a
    # reference clip is supplied (Controllable/Ultimate Cloning uses the
    # reference's timbre, not a text description). Unknown `voice` ids fall
    # back to the default rather than erroring -- callers only ever see ids
    # this same /voices endpoint handed out, so this only bites hand-crafted
    # requests, and defaulting is friendlier than a hard VOICE_NOT_FOUND there.
    catalog_entry = VOICE_CATALOG.get(req.voice)
    desc = req.voice_description or (catalog_entry["description"] if catalog_entry else DEFAULT_VOICE_DESC)
    prompt_text = f"({desc}){text}" if desc and not req.reference_wav_path else text

    try:
        with _generate_lock:
            wav = model.generate(
                text=prompt_text,
                reference_wav_path=req.reference_wav_path,
                cfg_value=req.cfg_value,
                inference_timesteps=req.inference_timesteps,
            )
    except Exception as e:
        return _error(500, "GENERATION_FAILED", f"{type(e).__name__}: {e}")

    sample_rate = model.tts_model.sample_rate
    buf = io.BytesIO()
    import soundfile as sf

    sf.write(buf, wav, sample_rate, format="WAV")
    wav_bytes = buf.getvalue()
    duration_ms = int(len(wav) / sample_rate * 1000)
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"X-Sample-Rate": str(sample_rate), "X-Duration-Ms": str(duration_ms)},
    )
