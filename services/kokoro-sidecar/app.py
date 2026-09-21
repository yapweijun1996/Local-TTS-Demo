"""Kokoro v1.1-zh sidecar for the Local-TTS API.

The Node `kokoro-js` package currently exposes a fixed English voice catalog.
This service uses the official Python `KPipeline` with `misaki[zh]`, so the
commercial-safe Mandarin voices (`zf_*`) and Chinese G2P are used correctly.
"""

from __future__ import annotations

import io
import os
import re
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

MODEL_ID = os.environ.get("KOKORO_MODEL", "hexgrad/Kokoro-82M-v1.1-zh")
MAX_TEXT_LENGTH = int(os.environ.get("KOKORO_MAX_TEXT_LENGTH", "3000"))
DEVICE = os.environ.get("KOKORO_DEVICE", "cpu").strip() or "cpu"
DEFAULT_VOICE_ID = os.environ.get("KOKORO_DEFAULT_VOICE", "zf_001").strip() or "zf_001"
JOB_CACHE_DIR = os.environ.get(
    "KOKORO_JOB_CACHE_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "../../data/tts-jobs/kokoro-sidecar-cache")),
)
JOB_ID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")
VOICE_ID_RE = re.compile(r"^z[fm]_[0-9]{3}$")
SAMPLE_RATE = 24_000

VOICE_CATALOG: dict[str, dict[str, str]] = {
    "zf_001": {"name": "Kokoro Mandarin female 001", "language": "zh-CN"},
    "zf_002": {"name": "Kokoro Mandarin female 002", "language": "zh-CN"},
    "zf_003": {"name": "Kokoro Mandarin female 003", "language": "zh-CN"},
    "zf_004": {"name": "Kokoro Mandarin female 004", "language": "zh-CN"},
}

_state: dict[str, Any] = {
    "pipeline": None,
    "error": None,
    "last_generation_ms": None,
}
_generate_lock = threading.Lock()

# KPipeline 0.9.x's non-English path first limits each internal grapheme
# segment to 400 characters and then the model refuses phoneme strings longer
# than 510.  Keep these dependency limits in one place, while measuring the
# actual phoneme length with the loaded pipeline below instead of estimating it
# from a character count.
KOKORO_MAX_PHONEMES = 510
KOKORO_MAX_GRAPHEME_CHARS = 400
_SENTENCE_BOUNDARY_CHARS = frozenset("。！？!?；;.\n…")
EDGE_SILENCE_THRESHOLD = 1e-3
EDGE_SILENCE_PADDING_MS = 80


def _trim_edge_silence(audio: Any):
    """Remove model padding from one result while preserving internal pauses."""

    import numpy as np

    if audio.size == 0:
        return audio
    signal_indexes = np.flatnonzero(np.abs(audio) > EDGE_SILENCE_THRESHOLD)
    if signal_indexes.size == 0:
        return audio[:0]

    padding_samples = round(SAMPLE_RATE * EDGE_SILENCE_PADDING_MS / 1000)
    start = max(0, int(signal_indexes[0]) - padding_samples)
    end = min(audio.size, int(signal_indexes[-1]) + padding_samples + 1)
    return audio[start:end]


def _sentence_preferred_units(text: str):
    """Yield text pieces ending at sentence-like boundaries without dropping text."""

    start = 0
    for index, char in enumerate(text):
        if char in _SENTENCE_BOUNDARY_CHARS:
            yield text[start : index + 1]
            start = index + 1
    if start < len(text):
        yield text[start:]


def _g2p_phoneme_length(pipeline: Any, text: str, cache: dict[str, int]) -> int:
    """Return the loaded pipeline's phoneme length for one candidate string."""

    if text not in cache:
        result = pipeline.g2p(text)
        phonemes = result[0] if isinstance(result, (tuple, list)) else result
        cache[text] = len(phonemes or "")
    return cache[text]


def _safe_grapheme_chunks(pipeline: Any, text: str) -> list[str]:
    """Split text into KPipeline-safe chunks while preserving every character.

    The installed KPipeline has its own 400-character non-English split and
    truncates any resulting phoneme string over 510 characters.  This helper
    performs the same safety check before KPipeline sees the input.  Sentence
    boundaries are packed together when safe; an oversized sentence is then
    split at a G2P-verified prefix rather than at an article-specific character
    count.
    """

    if not text:
        return []

    phoneme_cache: dict[str, int] = {}

    def fits(candidate: str) -> bool:
        return (
            len(candidate) <= KOKORO_MAX_GRAPHEME_CHARS
            and _g2p_phoneme_length(pipeline, candidate, phoneme_cache) <= KOKORO_MAX_PHONEMES
        )

    def safe_prefix_length(remaining: str, max_chars: int) -> int:
        """Find a safe prefix, with a defensive fallback for non-monotonic G2P."""

        low = 1
        high = max_chars
        best = 0
        while low <= high:
            middle = (low + high) // 2
            if fits(remaining[:middle]):
                best = middle
                low = middle + 1
            else:
                high = middle - 1

        if best:
            return best

        # G2P implementations normally grow with the input, but do not rely
        # on that property to decide whether it is safe to send text.  If the
        # binary search found no safe prefix, inspect every prefix before
        # refusing the request.
        for length in range(1, max_chars + 1):
            if fits(remaining[:length]):
                return length
        return 0

    def split_unit(unit: str) -> list[str]:
        pieces: list[str] = []
        remaining = unit
        while remaining:
            candidate = remaining[:KOKORO_MAX_GRAPHEME_CHARS]
            if fits(candidate):
                pieces.append(candidate)
                break

            prefix_length = safe_prefix_length(
                remaining,
                min(KOKORO_MAX_GRAPHEME_CHARS, len(remaining)),
            )
            if prefix_length == 0:
                raise ValueError(
                    "Kokoro G2P cannot fit a single-character chunk within "
                    f"{KOKORO_MAX_PHONEMES} phonemes; refusing to truncate text."
                )
            pieces.append(remaining[:prefix_length])
            remaining = remaining[prefix_length:]
        return pieces

    chunks: list[str] = []
    current = ""
    for unit in _sentence_preferred_units(text):
        for piece in split_unit(unit):
            candidate = current + piece
            if current and fits(candidate):
                current = candidate
            else:
                if current:
                    chunks.append(current)
                current = piece
    if current:
        chunks.append(current)

    if "".join(chunks) != text:
        raise RuntimeError("Kokoro chunking invariant failed: input text was not preserved.")
    if not all(fits(chunk) for chunk in chunks):
        raise RuntimeError("Kokoro chunking invariant failed: an unsafe chunk was produced.")
    return chunks


def _load_model() -> None:
    try:
        from kokoro import KPipeline
        from misaki import en

        # The v1.1 Chinese frontend can preserve embedded English when it is
        # given a callable that returns English phonemes. Use Misaki's
        # dictionary/rule G2P with fallback=None instead of constructing the
        # English KPipeline: that keeps the normal Podcast path from invoking
        # the optional eSpeak OOD fallback. The Chinese frontend itself is
        # native and uses misaki[zh].
        english_g2p_engine = en.G2P(trf=False, british=False, fallback=None, unk="")

        def english_g2p(text: str) -> str:
            return english_g2p_engine(text, preprocess=True)[0]

        _state["pipeline"] = KPipeline(
            lang_code="z",
            repo_id=MODEL_ID,
            en_callable=english_g2p,
            device=DEVICE,
        )
    except Exception as exc:  # surfaced through /health; keep HTTP server alive
        _state["error"] = f"{type(exc).__name__}: {exc}"


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    threading.Thread(target=_load_model, daemon=True).start()
    yield


app = FastAPI(title="kokoro-zh-sidecar", lifespan=_lifespan)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


class SynthesizeRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE_ID
    speed: float = 1.0
    job_id: Optional[str] = None
    chunk_index: Optional[int] = None


def _cached_chunk_path(req: SynthesizeRequest) -> Optional[str]:
    if req.job_id is None or req.chunk_index is None:
        return None
    if not JOB_ID_RE.fullmatch(req.job_id) or req.chunk_index < 0:
        return None
    return os.path.join(JOB_CACHE_DIR, req.job_id, f"{req.chunk_index:04d}.wav")


def _wav_response(wav_bytes: bytes, duration_ms: int) -> Response:
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"X-Sample-Rate": str(SAMPLE_RATE), "X-Duration-Ms": str(duration_ms)},
    )


@app.get("/health")
def health() -> dict[str, Any]:
    loaded = _state["pipeline"] is not None
    return {
        "status": "ok" if loaded else ("error" if _state["error"] else "loading"),
        "model": MODEL_ID,
        "model_loaded": loaded,
        "device": DEVICE,
        "last_generation_ms": _state["last_generation_ms"],
        "error": _state["error"],
    }


@app.get("/voices")
def voices() -> dict[str, Any]:
    return {
        "voices": [
            {"id": voice_id, "name": info["name"], "language": info["language"]}
            for voice_id, info in VOICE_CATALOG.items()
        ]
    }


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    pipeline = _state["pipeline"]
    if pipeline is None:
        if _state["error"]:
            return _error(503, "MODEL_LOAD_FAILED", _state["error"])
        return _error(503, "MODEL_LOAD_FAILED", "Model is still loading; retry shortly.")

    text = req.text.strip()
    if not text:
        return _error(400, "EMPTY_TEXT", "Text is empty.")
    if len(text) > MAX_TEXT_LENGTH:
        return _error(400, "TEXT_TOO_LONG", f"Text exceeds maximum length ({MAX_TEXT_LENGTH}).")
    if not VOICE_ID_RE.fullmatch(req.voice):
        return _error(404, "VOICE_NOT_FOUND", f"Voice {req.voice!r} is not a Kokoro Mandarin voice.")
    if req.speed < 0.5 or req.speed > 2.0:
        return _error(400, "GENERATION_FAILED", "Speed must be between 0.5 and 2.0.")

    cache_path = _cached_chunk_path(req)
    started = time.monotonic()
    try:
        with _generate_lock:
            if cache_path and os.path.isfile(cache_path):
                with open(cache_path, "rb") as cached_file:
                    wav_bytes = cached_file.read()
                import soundfile as sf

                with sf.SoundFile(io.BytesIO(wav_bytes)) as cached:
                    duration_ms = int(cached.frames / cached.samplerate * 1000)
                return _wav_response(wav_bytes, duration_ms)

            import numpy as np
            import soundfile as sf

            pieces: list[np.ndarray] = []
            grapheme_chunks = _safe_grapheme_chunks(pipeline, text)
            for result in pipeline(grapheme_chunks, voice=req.voice, speed=req.speed):
                if result.audio is not None:
                    audio = result.audio.detach().cpu().numpy().astype("float32", copy=False)
                    audio = _trim_edge_silence(audio)
                    if audio.size:
                        pieces.append(audio)
            if not pieces:
                return _error(500, "GENERATION_FAILED", "Kokoro produced no audio for the supplied text.")

            silence = np.zeros(round(SAMPLE_RATE * 0.06), dtype="float32")
            audio = np.concatenate(
                [piece if index == len(pieces) - 1 else np.concatenate((piece, silence)) for index, piece in enumerate(pieces)]
            )
            output = io.BytesIO()
            sf.write(output, audio, SAMPLE_RATE, format="WAV")
            wav_bytes = output.getvalue()
            duration_ms = int(len(audio) / SAMPLE_RATE * 1000)

            if cache_path:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                temp_path = f"{cache_path}.{os.getpid()}.tmp"
                with open(temp_path, "wb") as cached_file:
                    cached_file.write(wav_bytes)
                os.replace(temp_path, cache_path)

            _state["last_generation_ms"] = int((time.monotonic() - started) * 1000)
            return _wav_response(wav_bytes, duration_ms)
    except Exception as exc:
        _state["last_generation_ms"] = int((time.monotonic() - started) * 1000)
        return _error(500, "GENERATION_FAILED", f"{type(exc).__name__}: {exc}")
