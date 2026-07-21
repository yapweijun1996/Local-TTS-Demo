/**
 * VoxCPM2 engine — Node adapter over the Python sidecar HTTP contract.
 *
 * Approved 2026-07-21 after Qwen3-TTS and CosyVoice 3 were both rejected on
 * live listening tests for zh/en code-switched content (accent bleed).
 * VoxCPM2's in-call code-switch quality was accepted directly — no
 * per-language segment routing needed. See memory:
 * tts_voice_evaluation_findings.md for the full evaluation trail.
 *
 * The model (2B params, PyTorch) cannot run in-process, so `synthesize()`
 * POSTs to the sidecar in services/voxcpm-sidecar. The sidecar mirrors the
 * PRD §15 error envelope, so its error codes map 1:1 onto TtsError.
 *
 * Model: openbmb/VoxCPM2. License: Apache-2.0 (code + weights, verified
 * 2026-07-21 against GitHub LICENSE and the HF model card frontmatter).
 */

import type {
  TtsEngine,
  TtsInput,
  TtsOutput,
  TtsVoice,
  EngineLicenseMeta,
  TtsErrorCode,
} from "@local-tts/core";
import { TtsError, segmentText, decodeWav, concatFloat32, encodeWav } from "@local-tts/core";

export const VOXCPM2_LICENSE: EngineLicenseMeta = {
  engine: "voxcpm2",
  modelName: "VoxCPM2",
  license: "Apache-2.0",
  commercialUse: true,
  requiresAttribution: false,
  sourceUrl: "https://github.com/OpenBMB/VoxCPM",
  verifiedAt: "2026-07-21",
  notes:
    "Weights + code Apache-2.0 (no scale-trigger caveats, unlike Higgs Audio V2 or IndexTTS-2 — " +
    "both looked Apache-2.0 from search summaries but carry custom RAIL-style licenses on primary-source check). " +
    "Runs as a Python sidecar (PyTorch, tokenizer-free diffusion architecture, not ONNX). " +
    "Native zh/en code-switch accepted in listening tests without per-language routing.",
};

export interface VoxcpmSidecarOptions {
  /** Sidecar base URL, e.g. http://localhost:8200 (TTS_VOXCPM_SIDECAR_URL). */
  baseUrl: string;
  /** Per-request (per-chunk, once chunked) timeout. CPU/MPS generation can be slow — default 180 s. */
  timeoutMs?: number;
  /**
   * Max chars per sidecar call before splitting (0 = never split). VoxCPM2
   * synthesizes a whole call as one continuous pass — no internal chunking
   * like Kokoro/Piper — so a long single call both risks the per-request
   * timeout (confirmed: a 1294-char request took >180s and got aborted) and
   * has no bounded latency. Default matches the Kokoro/Piper chunk size for
   * consistency. Splitting is by sentence/length only, never by language —
   * VoxCPM2's accepted in-call zh/en mixing is untouched per chunk.
   */
  chunkSize?: number;
}

interface SidecarVoice {
  id: string;
  name: string;
  language: string;
}

interface SidecarErrorBody {
  error?: { code?: string; message?: string };
}

const KNOWN_CODES = new Set<TtsErrorCode>([
  "EMPTY_TEXT",
  "TEXT_TOO_LONG",
  "ENGINE_NOT_FOUND",
  "VOICE_NOT_FOUND",
  "MODEL_LOAD_FAILED",
  "GENERATION_FAILED",
  "UNSUPPORTED_FORMAT",
]);

/** Map a sidecar error response onto TtsError, preserving known codes. */
function toTtsError(status: number, body: SidecarErrorBody | null): TtsError {
  const rawCode = body?.error?.code ?? "";
  const message = body?.error?.message ?? `Sidecar responded with HTTP ${status}.`;
  const code: TtsErrorCode = KNOWN_CODES.has(rawCode as TtsErrorCode)
    ? (rawCode as TtsErrorCode)
    : status === 503
      ? "MODEL_LOAD_FAILED"
      : "GENERATION_FAILED";
  return new TtsError(code, message, { httpStatus: status });
}

export function createVoxcpmSidecarAdapter(opts: VoxcpmSidecarOptions): TtsEngine {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const chunkSize = opts.chunkSize ?? 480;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "unknown network error";
      throw new TtsError("GENERATION_FAILED", `VoxCPM2 sidecar unreachable: ${reason}`, {
        baseUrl,
      });
    }
  }

  return {
    id: "voxcpm2",
    name: "VoxCPM2 (sidecar)",

    /**
     * "Loaded" = sidecar reachable. Model warm-up continues inside the
     * sidecar; synthesize() surfaces MODEL_LOAD_FAILED (503) until it
     * finishes, which keeps registry status accurate without blocking boot
     * for a multi-minute model download.
     */
    async load(): Promise<void> {
      const res = await request("/health");
      if (!res.ok) {
        throw new Error(`VoxCPM2 sidecar /health returned HTTP ${res.status}.`);
      }
    },

    async listVoices(): Promise<TtsVoice[]> {
      const res = await request("/voices");
      if (!res.ok) {
        throw toTtsError(res.status, (await res.json().catch(() => null)) as SidecarErrorBody | null);
      }
      const body = (await res.json()) as { voices: SidecarVoice[] };
      return body.voices.map((v) => ({
        id: v.id,
        name: v.name,
        language: v.language,
        engine: "voxcpm2",
      }));
    },

    async synthesize(input: TtsInput): Promise<TtsOutput> {
      const chunks =
        chunkSize > 0 && input.text.length > chunkSize
          ? segmentText(input.text, chunkSize)
          : [input.text];

      if (chunks.length <= 1) {
        return synthesizeOneChunk(input.text, input.voice);
      }

      // Multi-chunk: one sidecar call per chunk (each still speaks mixed
      // zh/en internally — only the split points are language-agnostic),
      // decode each WAV back to PCM, and re-encode as one file. Same
      // decode/concat/encode pattern the browser's Piper adapter uses for
      // engines that only ever return a finished WAV per call.
      const parts: Float32Array[] = [];
      let sampleRate = 48000;
      for (let i = 0; i < chunks.length; i++) {
        const { audioBuffer } = await synthesizeOneChunk(chunks[i]!, input.voice);
        const decoded = decodeWav(audioBuffer);
        sampleRate = decoded.sampleRate || sampleRate;
        parts.push(decoded.samples);
        if (i < chunks.length - 1) {
          parts.push(new Float32Array(Math.round(sampleRate * 0.06))); // 60ms gap, matches Kokoro/Piper
        }
      }
      const pcm = concatFloat32(parts);
      return {
        audioBuffer: encodeWav(pcm, { sampleRate }),
        mimeType: "audio/wav",
        durationMs: (pcm.length / sampleRate) * 1000,
      };
    },
  };

  async function synthesizeOneChunk(text: string, voice?: string): Promise<TtsOutput> {
    const res = await request("/synthesize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(voice ? { voice } : {}),
      }),
    });
    if (!res.ok) {
      throw toTtsError(res.status, (await res.json().catch(() => null)) as SidecarErrorBody | null);
    }
    const audioBuffer = await res.arrayBuffer();
    const durationHeader = Number(res.headers.get("x-duration-ms"));
    return {
      audioBuffer,
      mimeType: res.headers.get("content-type") ?? "audio/wav",
      ...(Number.isFinite(durationHeader) && durationHeader > 0
        ? { durationMs: durationHeader }
        : {}),
    };
  }
}
