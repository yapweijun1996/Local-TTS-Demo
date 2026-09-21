/**
 * Kokoro v1.1-zh engine — Node adapter over the official Python pipeline.
 *
 * The current kokoro-js package has a fixed English voice catalog and does
 * not expose the v1.1-zh `zf_*` voices. The sidecar keeps the HTTP contract
 * small while using `kokoro` + `misaki[zh]` for correct Mandarin G2P.
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
import { deriveSubchunkCacheJobId } from "./sidecarCacheIdentity.js";

export const KOKORO_ZH_LICENSE: EngineLicenseMeta = {
  engine: "kokoro-zh",
  modelName: "Kokoro-82M-v1.1-zh",
  license: "Apache-2.0",
  commercialUse: true,
  requiresAttribution: false,
  sourceUrl: "https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh",
  verifiedAt: "2026-08-06",
  notes: "Apache-2.0 English + Mandarin weights; Python pipeline uses misaki[zh], zf_* Mandarin voices, and dictionary-only embedded-English G2P with the eSpeak fallback disabled.",
};

export interface KokoroZhSidecarOptions {
  /** Sidecar base URL, e.g. http://127.0.0.1:8201. */
  baseUrl: string;
  /** Per-request timeout; the sidecar itself is warm after boot. */
  timeoutMs?: number;
  /** Max chars per sidecar call before the adapter joins WAV chunks. */
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

const EDGE_SILENCE_THRESHOLD = 1e-3;
const EDGE_SILENCE_PADDING_MS = 80;

/**
 * Kokoro's Python pipeline includes generous leading/trailing padding around
 * each request. That padding is useful when a clip is played alone, but it
 * becomes a 1s+ pause when adjacent sidecar chunks are stitched together.
 * Trim only the edges, keep a short natural breathing pad, and leave all
 * pauses inside the spoken text untouched.
 */
function trimEdgeSilence(output: TtsOutput): TtsOutput {
  let decoded;
  try {
    decoded = decodeWav(output.audioBuffer);
  } catch {
    // Keep the adapter's error handling unchanged for malformed test doubles
    // and let the caller's normal WAV validation report the bad output.
    return output;
  }

  const { samples, sampleRate } = decoded;
  const firstSignal = samples.findIndex((sample) => Math.abs(sample) > EDGE_SILENCE_THRESHOLD);
  if (firstSignal < 0) return output;

  let lastSignalExclusive = samples.length;
  while (lastSignalExclusive > firstSignal
    && Math.abs(samples[lastSignalExclusive - 1]!) <= EDGE_SILENCE_THRESHOLD) {
    lastSignalExclusive -= 1;
  }

  const paddingSamples = Math.round(sampleRate * EDGE_SILENCE_PADDING_MS / 1000);
  const start = Math.max(0, firstSignal - paddingSamples);
  const end = Math.min(samples.length, lastSignalExclusive + paddingSamples);
  if (start === 0 && end === samples.length) return output;

  const trimmed = samples.slice(start, end);
  return {
    audioBuffer: encodeWav(trimmed, { sampleRate }),
    mimeType: "audio/wav",
    durationMs: (trimmed.length / sampleRate) * 1000,
  };
}

function toTtsError(status: number, body: SidecarErrorBody | null): TtsError {
  const rawCode = body?.error?.code ?? "";
  const message = body?.error?.message ?? `Kokoro v1.1-zh sidecar responded with HTTP ${status}.`;
  const code: TtsErrorCode = KNOWN_CODES.has(rawCode as TtsErrorCode)
    ? rawCode as TtsErrorCode
    : status === 503 ? "MODEL_LOAD_FAILED" : "GENERATION_FAILED";
  return new TtsError(code, message, { httpStatus: status });
}

export function createKokoroZhSidecarAdapter(opts: KokoroZhSidecarOptions): TtsEngine {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const chunkSize = opts.chunkSize ?? 360;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "unknown network error";
      throw new TtsError("GENERATION_FAILED", `Kokoro v1.1-zh sidecar unreachable: ${reason}`, { baseUrl });
    }
  }

  return {
    id: "kokoro-zh",
    name: "Kokoro v1.1-zh (Mandarin sidecar)",

    async load(): Promise<void> {
      const res = await request("/health");
      if (!res.ok) throw new Error(`Kokoro v1.1-zh sidecar /health returned HTTP ${res.status}.`);
      const body = (await res.json().catch(() => null)) as { model_loaded?: boolean; error?: string } | null;
      if (body?.model_loaded !== true) {
        throw new Error(body?.error || "Kokoro v1.1-zh sidecar model is still loading.");
      }
    },

    async listVoices(): Promise<TtsVoice[]> {
      const res = await request("/voices");
      if (!res.ok) throw toTtsError(res.status, (await res.json().catch(() => null)) as SidecarErrorBody | null);
      const body = (await res.json()) as { voices: SidecarVoice[] };
      return body.voices.map((voice) => ({ ...voice, engine: "kokoro-zh" }));
    },

    async synthesize(input: TtsInput): Promise<TtsOutput> {
      const chunks = chunkSize > 0 && input.text.length > chunkSize
        ? segmentText(input.text, chunkSize)
        : [input.text];
      if (chunks.length <= 1) return synthesizeOneChunk(input.text, input);

      const parts: Float32Array[] = [];
      let sampleRate = 24_000;
      const cacheJobId = deriveSubchunkCacheJobId(input.jobId, input.chunkIndex);
      for (let i = 0; i < chunks.length; i++) {
        const output = await synthesizeOneChunk(chunks[i]!, {
          ...input,
          jobId: cacheJobId,
          chunkIndex: input.chunkIndex === undefined ? undefined : i,
        });
        const decoded = decodeWav(output.audioBuffer);
        sampleRate = decoded.sampleRate || sampleRate;
        parts.push(decoded.samples);
        if (i < chunks.length - 1) parts.push(new Float32Array(Math.round(sampleRate * 0.06)));
      }
      const pcm = concatFloat32(parts);
      return {
        audioBuffer: encodeWav(pcm, { sampleRate }),
        mimeType: "audio/wav",
        durationMs: (pcm.length / sampleRate) * 1000,
      };
    },
  };

  async function synthesizeOneChunk(text: string, input: TtsInput): Promise<TtsOutput> {
    const res = await request("/synthesize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(input.voice ? { voice: input.voice } : {}),
        ...(input.speed ? { speed: input.speed } : {}),
        ...(input.jobId ? { job_id: input.jobId } : {}),
        ...(input.chunkIndex !== undefined ? { chunk_index: input.chunkIndex } : {}),
      }),
    });
    if (!res.ok) throw toTtsError(res.status, (await res.json().catch(() => null)) as SidecarErrorBody | null);
    const audioBuffer = await res.arrayBuffer();
    const durationHeader = Number(res.headers.get("x-duration-ms"));
    return trimEdgeSilence({
      audioBuffer,
      mimeType: res.headers.get("content-type") ?? "audio/wav",
      ...(Number.isFinite(durationHeader) && durationHeader > 0 ? { durationMs: durationHeader } : {}),
    });
  }
}
