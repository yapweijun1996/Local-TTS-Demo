/**
 * Kokoro ONNX engine Ã¢â‚¬â€ browser adapter via kokoro-js.
 *
 * Kokoro: 82M params, 24 kHz, 28 voices, Apache 2.0.
 *   FP32 ~326 MB (studio), FP16 ~163 MB (default), Q4 ~86 MB (mobile).
 *   G2P: misaki English dict (Apache 2.0, GPL-free).
 *
 * WebGPU safety: only fp32 may use WebGPU; every other dtype is forced to WASM
 * because of a known transformers.js bug (static/crackle on non-fp32 dtypes).
 * Refs: transformers.js#1320, hexgrad/kokoro#98.
 */

import { KokoroTTS, type GenerateOptions } from "kokoro-js";
import { concatFloat32, encodeWav } from "@local-tts/core";
import { showProgress, showBar } from "../ui.js";
import type { VoiceInfo } from "../ui.js";

// Ã¢â€â‚¬Ã¢â€â‚¬ Types Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export type KokoroDtype = "fp32" | "fp16" | "q4";

// Ã¢â€â‚¬Ã¢â€â‚¬ Constants Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_SIZES: Record<KokoroDtype, string> = {
  fp32: "~326 MB",
  fp16: "~163 MB",
  q4: "~86 MB",
};

const kokoroCache = new Map<KokoroDtype, KokoroTTS>();

// Ã¢â€â‚¬Ã¢â€â‚¬ Helpers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function fmtMB(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Device probe Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
async function probeDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const gpu = (navigator as unknown as Record<string, unknown>).gpu as
      | { requestAdapter?: () => Promise<unknown> }
      | undefined;
    return (await gpu?.requestAdapter?.()) ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

/**
 * Pick a SAFE device for the requested dtype.
 * Only fp32 may use WebGPU; every other dtype is forced to WASM.
 */
export async function safeDevice(dtype: KokoroDtype): Promise<"webgpu" | "wasm"> {
  if (dtype !== "fp32") return "wasm";
  return probeDevice();
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Load Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export async function loadKokoro(dtype: KokoroDtype): Promise<KokoroTTS> {
  if (kokoroCache.has(dtype)) return kokoroCache.get(dtype)!;
  const device = await safeDevice(dtype);
  const label = `Kokoro ${dtype.toUpperCase()} (${KOKORO_SIZES[dtype]}) - ${device.toUpperCase()}`;
  showProgress(`Loading ${label}...`);

  // transformers.js fires progress_callback per file: 'initiate' Ã¢â€ â€™ 'download' Ã¢â€ â€™
  // 'progress' (with %, loaded/total bytes) Ã¢â€ â€™ 'done'. Surface a % bar so the
  // 86Ã¢â‚¬â€œ326 MB first-load download isn't a silent wait.
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype,
    device,
    progress_callback: (raw) => {
      const e = raw as unknown as {
        status?: string;
        file?: string;
        progress?: number;
        loaded?: number;
        total?: number;
      };
      if (e.status === "progress" && typeof e.progress === "number") {
        const pct = Math.min(100, Math.round(e.progress));
        const size = e.total ? ` (${fmtMB(e.loaded)} / ${fmtMB(e.total)})` : "";
        showProgress(`Downloading ${label} - ${pct}%${size}`);
        showBar(pct);
      } else if (e.status === "done") {
        showProgress(`Preparing ${label}... (compiling model)`);
        showBar(null);
      }
    },
  });

  showBar(null);
  kokoroCache.set(dtype, tts);
  return tts;
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Voices Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export function kokoroVoices(tts: KokoroTTS): VoiceInfo[] {
  const list = Object.entries(tts.voices).map(([id, info]) => ({
    id,
    name: info.name,
    language: info.language,
    grade: (info as Record<string, unknown>).overallGrade as string | undefined,
  }));
  // Best quality first: "A" before "A-" before "B"Ã¢â‚¬Â¦; unknown grades last.
  const rank = (g?: string): number =>
    g ? g.charCodeAt(0) * 10 + (g.includes("-") ? 5 : 0) : 9999;
  return list.sort((a, b) => rank(a.grade) - rank(b.grade));
}

export type KokoroChunkStats = {
  chunkIndex: number;
  totalChunks: number;
  text: string;
  sampleRate: number;
  sampleCount: number;
  maxAmplitude: number;
};

type ChunkLogger = (stats: KokoroChunkStats) => void;

function maxAmplitude(samples: Float32Array): number {
  let max = 0;
  for (const v of samples) {
    const abs = Math.abs(v);
    if (abs > max) max = abs;
  }
  return max;
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Generate Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â€Ã¢â‚¬â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
/**
 * Synthesize text chunks with Kokoro, returning a single WAV ArrayBuffer.
 *
 * Single chunk Ã¢â€ â€™ fast path via `raw.toWav()`.
 * Multiple chunks Ã¢â€ â€™ concat raw PCM with 60ms silence gaps between sentences
 * (better prosody than feeding one long block, avoids internal truncation).
 */
export async function kokoroGenerate(
  tts: KokoroTTS,
  voice: GenerateOptions["voice"],
  chunks: string[],
  onChunk?: ChunkLogger,
): Promise<ArrayBuffer> {
  if (chunks.length <= 1) {
    showProgress("Generating with Kokoro...");
    const raw = await tts.generate(chunks[0] ?? "", { voice });
    const r = raw as unknown as { audio: Float32Array; sampling_rate?: number };
    if (onChunk) {
      onChunk({
        chunkIndex: 1,
        totalChunks: 1,
        text: chunks[0] ?? "",
        sampleRate: r.sampling_rate ?? 24000,
        sampleCount: r.audio.length,
        maxAmplitude: maxAmplitude(r.audio),
      });
    }
    return raw.toWav();
  }

  const parts: Float32Array[] = [];
  let sampleRate = 24000;
  for (let i = 0; i < chunks.length; i++) {
    showProgress(`Generating with KokoroÃ¢â‚¬Â¦ sentence ${i + 1}/${chunks.length}`);
    showProgress(`Generating with Kokoro... sentence ${i + 1}/${chunks.length}`);
    const r = raw as unknown as { audio: Float32Array; sampling_rate?: number };
    sampleRate = r.sampling_rate ?? sampleRate;
    if (onChunk) {
      onChunk({
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        text: chunks[i] ?? "",
        sampleRate,
        sampleCount: r.audio.length,
        maxAmplitude: maxAmplitude(r.audio),
      });
    }
    parts.push(r.audio);
    // 60ms silence between sentences for natural pacing
    if (i < chunks.length - 1) {
      parts.push(new Float32Array(Math.round(sampleRate * 0.06)));
    }
  }
  return encodeWav(concatFloat32(parts), { sampleRate });
}
