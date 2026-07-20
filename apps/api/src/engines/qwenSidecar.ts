/**
 * Qwen3-TTS engine — Node adapter over the Python sidecar HTTP contract.
 *
 * The model itself (PyTorch LM + codec decoder, 0.6B–1.7B params) cannot run
 * in-process (docs/ENGINES.md #10), so `synthesize()` POSTs to the sidecar in
 * services/qwen-tts-sidecar. The sidecar mirrors the PRD §15 error envelope,
 * so its error codes map 1:1 onto TtsError.
 *
 * Model: Qwen/Qwen3-TTS-12Hz-*-CustomVoice — native zh/en code-switch,
 * 10 languages, streaming-capable. License: Apache-2.0.
 */

import type {
  TtsEngine,
  TtsInput,
  TtsOutput,
  TtsVoice,
  EngineLicenseMeta,
  TtsErrorCode,
} from "@local-tts/core";
import { TtsError } from "@local-tts/core";

export const QWEN3_TTS_LICENSE: EngineLicenseMeta = {
  engine: "qwen3-tts",
  modelName: "Qwen3-TTS-12Hz-0.6B-CustomVoice",
  license: "Apache-2.0",
  commercialUse: true,
  requiresAttribution: false,
  sourceUrl: "https://github.com/QwenLM/Qwen3-TTS",
  verifiedAt: "2026-07-20",
  notes:
    "Weights + inference code Apache-2.0. Runs as a Python sidecar (PyTorch, not ONNX). " +
    "Native Mandarin/English code-switch in one model. Voice cloning excluded from this adapter.",
};

export interface QwenSidecarOptions {
  /** Sidecar base URL, e.g. http://localhost:8100 (TTS_SIDECAR_URL). */
  baseUrl: string;
  /** Per-request timeout. Generation on CPU can be slow — default 120 s. */
  timeoutMs?: number;
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

export function createQwenSidecarAdapter(opts: QwenSidecarOptions): TtsEngine {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Network failure / timeout — the sidecar never saw the request.
      const reason = e instanceof Error ? e.message : "unknown network error";
      throw new TtsError("GENERATION_FAILED", `Qwen sidecar unreachable: ${reason}`, {
        baseUrl,
      });
    }
  }

  return {
    id: "qwen3-tts",
    name: "Qwen3-TTS (sidecar)",

    /**
     * "Loaded" = sidecar reachable. Model warm-up continues inside the sidecar;
     * synthesize() surfaces MODEL_LOAD_FAILED (503) until it finishes, which
     * keeps registry status accurate without blocking boot for a multi-minute
     * model download.
     */
    async load(): Promise<void> {
      const res = await request("/health");
      if (!res.ok) {
        throw new Error(`Qwen sidecar /health returned HTTP ${res.status}.`);
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
        engine: "qwen3-tts",
      }));
    },

    async synthesize(input: TtsInput): Promise<TtsOutput> {
      const res = await request("/synthesize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: input.text,
          ...(input.voice ? { voice: input.voice } : {}),
          ...(input.language ? { language: input.language } : {}),
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
    },
  };
}
