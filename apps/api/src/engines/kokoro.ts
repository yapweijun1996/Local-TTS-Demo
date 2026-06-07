/**
 * Kokoro ONNX engine — Node adapter via kokoro-js + onnxruntime-node.
 *
 * Implements the `TtsEngine` contract from `@local-tts/core`. The browser app
 * has its own adapter (apps/web/src/engines/kokoro.ts) over onnxruntime-web;
 * this one targets onnxruntime-node and runs inside the Fastify process.
 *
 * Model: onnx-community/Kokoro-82M-v1.0-ONNX (~326 MB fp32, ~163 MB fp16)
 * License: Apache-2.0
 * G2P: misaki English dict (Apache 2.0) — no espeak-ng, no GPL risk.
 */

import { KokoroTTS, type GenerateOptions } from "kokoro-js";
import type { TtsEngine, TtsInput, TtsOutput, TtsVoice, EngineLicenseMeta } from "@local-tts/core";
import { validateText, segmentText, concatFloat32, encodeWav } from "@local-tts/core";

// ── License metadata ──────────────────────────────────────────────────
export const KOKORO_LICENSE: EngineLicenseMeta = {
  engine: "kokoro",
  modelName: "Kokoro-82M-v1.0-ONNX",
  license: "Apache-2.0",
  commercialUse: true,
  requiresAttribution: false,
  sourceUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX",
  verifiedAt: "2026-06-07",
  notes: "Weights Apache-2.0. G2P via misaki (MIT) for EN; espeak-ng only if multilingual fallback enabled.",
};

// ── Options ───────────────────────────────────────────────────────────
export interface KokoroAdapterOptions {
  /** HuggingFace model id or local path. */
  model: string;
  /** "fp32" | "fp16" | "q4" — fp32 recommended for server quality. */
  dtype?: "fp32" | "fp16" | "q4";
  /** Max chars per request (after normalization). */
  maxTextLength?: number;
  /** Sentence-chunk size for segmentation (0 = disable). */
  chunkSize?: number;
}

/**
 * Create a Kokoro TtsEngine adapter backed by onnxruntime-node.
 *
 * `load()` is idempotent — safe to call at boot and on health re-check.
 */
export function createKokoroAdapter(opts: KokoroAdapterOptions): TtsEngine {
  const model = opts.model;
  const dtype = opts.dtype ?? "fp32";
  const maxTextLength = opts.maxTextLength ?? 3000;
  const chunkSize = opts.chunkSize ?? 480;

  let tts: KokoroTTS | null = null;

  return {
    id: "kokoro",
    name: "Kokoro ONNX",

    async load() {
      if (tts) return;
      tts = await KokoroTTS.from_pretrained(model, {
        dtype,
        device: "cpu", // Node → onnxruntime-node CPU backend
      });
    },

    async listVoices(): Promise<TtsVoice[]> {
      if (!tts) throw new Error("Kokoro engine not loaded.");
      return Object.entries(tts.voices).map(([id, info]) => ({
        id,
        name: info.name,
        language: info.language,
        engine: "kokoro",
      }));
    },

    async synthesize(input: TtsInput): Promise<TtsOutput> {
      if (!tts) throw new Error("Kokoro engine not loaded.");

      // 1. Validate via shared core (identical behaviour to browser app)
      const text = validateText(input.text, { maxLength: maxTextLength });

      // 2. Segment long text (same @local-tts/core pipeline as browser)
      const chunks = chunkSize > 0 && text.length > chunkSize
        ? segmentText(text, chunkSize)
        : [text];

      // 3. Synthesize
      const voice = input.voice as string | undefined;
      if (chunks.length === 1) {
        const raw = await tts.generate(chunks[0]!, { voice: voice as GenerateOptions["voice"] });
        return {
          audioBuffer: raw.toWav(),
          mimeType: "audio/wav",
          durationMs: (raw.audio.length / raw.sampling_rate) * 1000,
        };
      }

      // Multi-chunk: concat PCM with 60ms silence gaps
      const parts: Float32Array[] = [];
      let sampleRate = 24000;
      for (let i = 0; i < chunks.length; i++) {
        const raw = await tts.generate(chunks[i]!, { voice: voice as GenerateOptions["voice"] });
        sampleRate = raw.sampling_rate;
        parts.push(raw.audio);
        if (i < chunks.length - 1) {
          parts.push(new Float32Array(Math.round(sampleRate * 0.06)));
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
}
