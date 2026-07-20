/**
 * Kokoro ONNX engine -- browser adapter via kokoro-js.
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
// Type-only import: erased at compile time, so this module stays DOM-free and
// remains safe to import from the worker.
import type { VoiceInfo, ProgressDetail, ProgressReporter } from "../ui.js";

export type { ProgressReporter };

// -- Types ------------------------------------------------------------------
export type KokoroDtype = "fp32" | "fp16" | "q4";

// -- Constants --------------------------------------------------------------
export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_SIZES: Record<KokoroDtype, string> = {
  fp32: "~326 MB",
  fp16: "~163 MB",
  q4: "~86 MB",
};

const noopProgress: ProgressReporter = () => {};

const kokoroCache = new Map<KokoroDtype, KokoroTTS>();

// -- Download aggregation ---------------------------------------------------
/**
 * transformers.js reports progress PER FILE, and discovers files lazily as the
 * load proceeds -- so there is no grand total available up front. The UI needs
 * one honest pair of numbers, which means summing per-file counters here.
 *
 * While new files are still being discovered the running total keeps climbing;
 * quoting it as "of N MB" would look like a bug, so `estimating` stays true
 * until the total has held steady for TOTAL_SETTLE_MS and the UI can safely
 * switch from "X MB downloaded" to "X MB of N MB".
 */
const TOTAL_SETTLE_MS = 1200;

class DownloadAggregator {
  private readonly files = new Map<string, { loaded: number; total: number }>();
  private readonly startedAt = Date.now();
  private knownTotal = 0;
  private totalChangedAt = Date.now();
  private lastLoaded = 0;
  private lastSampleAt = Date.now();
  private speed = 0;

  update(file: string, loaded: number, total: number): ProgressDetail {
    this.files.set(file, { loaded, total });

    let sumLoaded = 0;
    let sumTotal = 0;
    for (const f of this.files.values()) {
      sumLoaded += f.loaded;
      sumTotal += f.total;
    }

    const now = Date.now();
    if (sumTotal > this.knownTotal) {
      this.knownTotal = sumTotal;
      this.totalChangedAt = now;
    }

    // Smooth the rate over ~500ms windows so the readout does not jitter.
    const dt = now - this.lastSampleAt;
    if (dt >= 500) {
      const instant = ((sumLoaded - this.lastLoaded) * 1000) / dt;
      this.speed = this.speed > 0 ? this.speed * 0.6 + instant * 0.4 : instant;
      this.lastLoaded = sumLoaded;
      this.lastSampleAt = now;
    }

    return {
      loadedBytes: sumLoaded,
      totalBytes: sumTotal,
      bytesPerSec: Math.max(0, this.speed),
      // Give discovery a moment before trusting the denominator.
      estimating: now - this.totalChangedAt < TOTAL_SETTLE_MS && now - this.startedAt < 30_000,
    };
  }

  /** Overall percentage across every file discovered so far. */
  overallPct(detail: ProgressDetail): number | null {
    if (detail.totalBytes <= 0) return null;
    return Math.min(100, (detail.loadedBytes / detail.totalBytes) * 100);
  }
}

// -- Device probe -----------------------------------------------------------
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

// -- Load -------------------------------------------------------------------
export async function loadKokoro(
  dtype: KokoroDtype,
  onProgress: ProgressReporter = noopProgress,
): Promise<KokoroTTS> {
  if (kokoroCache.has(dtype)) return kokoroCache.get(dtype)!;
  const device = await safeDevice(dtype);
  const label = `Kokoro ${dtype.toUpperCase()} · ${device.toUpperCase()}`;
  onProgress("Checking browser cache", null);

  // transformers.js fires progress_callback per file: 'initiate' -> 'download' ->
  // 'progress' (with %, loaded/total bytes) -> 'done'. Aggregate across files so
  // the UI can show one honest total instead of a per-file percentage that
  // restarts at 0 several times.
  const agg = new DownloadAggregator();

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
      if (e.status === "progress" && typeof e.loaded === "number" && e.total) {
        const detail = agg.update(e.file ?? "model", e.loaded, e.total);
        onProgress("Downloading model files", agg.overallPct(detail), detail);
      } else if (e.status === "done") {
        // Weights are in; ONNX Runtime still has to compile the graph, and that
        // stall is long enough that calling it "downloading" would be a lie.
        onProgress(`Compiling model for ${device.toUpperCase()}`, null);
      }
    },
  });

  onProgress(`${label} ready`, 100);
  kokoroCache.set(dtype, tts);
  return tts;
}

// -- Voices -----------------------------------------------------------------
export function kokoroVoices(tts: KokoroTTS): VoiceInfo[] {
  const list = Object.entries(tts.voices).map(([id, info]) => ({
    id,
    name: info.name,
    language: info.language,
    grade: (info as Record<string, unknown>).overallGrade as string | undefined,
  }));
  // Best quality first: "A" before "A-" before "B"; unknown grades last.
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
  /** Number of retries needed because the first attempt produced all-zero PCM. */
  silentRetries: number;
};

type ChunkLogger = (stats: KokoroChunkStats) => void;

function measureMaxAmplitude(samples: Float32Array): number {
  let max = 0;
  for (const v of samples) {
    const abs = Math.abs(v);
    if (abs > max) max = abs;
  }
  return max;
}

// -- Generate ---------------------------------------------------------------
/**
 * Synthesize text chunks with Kokoro, returning a single WAV ArrayBuffer.
 *
 * Single chunk -> fast path via `raw.toWav()`.
 * Multiple chunks -> concat raw PCM with 60ms silence gaps between sentences
 * (better prosody than feeding one long block, avoids internal truncation).
 *
 * FP16/Q4 models occasionally emit all-zero PCM for a chunk due to quantization
 * instability on certain text inputs. Silent chunks are retried up to
 * SILENT_RETRY_LIMIT times; if still silent the chunk passes through as-is so
 * the output is not truncated, and silentRetries reflects the attempt count.
 */
const SILENT_RETRY_LIMIT = 2;

/** Generate one text segment, retrying up to SILENT_RETRY_LIMIT times on silence. */
export async function generateSegment(
  tts: KokoroTTS,
  voice: GenerateOptions["voice"],
  text: string,
): Promise<{ audio: Float32Array; sampleRate: number; retries: number }> {
  let raw = await tts.generate(text, { voice });
  let r = raw as unknown as { audio: Float32Array; sampling_rate?: number };
  let retries = 0;
  while (retries < SILENT_RETRY_LIMIT && measureMaxAmplitude(r.audio) <= 0) {
    retries++;
    raw = await tts.generate(text, { voice });
    r = raw as unknown as { audio: Float32Array; sampling_rate?: number };
  }
  return { audio: r.audio, sampleRate: r.sampling_rate ?? 24000, retries };
}

/**
 * Split text roughly in half on a word boundary and synthesize each half.
 * Used as a fallback when a full chunk stays silent after all retries --
 * isolates the problematic word(s) to the smallest possible segment so the
 * rest of the chunk still produces audible output.
 */
async function generateSplitFallback(
  tts: KokoroTTS,
  voice: GenerateOptions["voice"],
  text: string,
  sampleRate: number,
): Promise<Float32Array> {
  const mid = Math.floor(text.length / 2);
  const splitAt = text.lastIndexOf(" ", mid) > 0 ? text.lastIndexOf(" ", mid) : mid;
  const halves = [text.slice(0, splitAt).trim(), text.slice(splitAt).trim()].filter(Boolean);
  const audioParts: Float32Array[] = [];
  for (const half of halves) {
    const seg = await generateSegment(tts, voice, half);
    if (seg.audio.length > 0) audioParts.push(seg.audio);
  }
  if (audioParts.length === 0) return new Float32Array(Math.round(sampleRate * 0.1));
  return concatFloat32(audioParts);
}

export async function kokoroGenerate(
  tts: KokoroTTS,
  voice: GenerateOptions["voice"],
  chunks: string[],
  onChunk?: ChunkLogger,
  onProgress: ProgressReporter = noopProgress,
): Promise<ArrayBuffer> {
  if (chunks.length <= 1) {
    onProgress("Generating with Kokoro...");
    const raw = await tts.generate(chunks[0] ?? "", { voice });
    const r = raw as unknown as { audio: Float32Array; sampling_rate?: number };
    if (onChunk) {
      onChunk({
        chunkIndex: 1,
        totalChunks: 1,
        text: chunks[0] ?? "",
        sampleRate: r.sampling_rate ?? 24000,
        sampleCount: r.audio.length,
        maxAmplitude: measureMaxAmplitude(r.audio),
        silentRetries: 0,
      });
    }
    return raw.toWav();
  }

  const parts: Float32Array[] = [];
  let sampleRate = 24000;
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`Generating with Kokoro... sentence ${i + 1}/${chunks.length}`);

    const seg = await generateSegment(tts, voice, chunks[i]!);
    sampleRate = seg.sampleRate;

    let audio = seg.audio;
    // If still silent after retries, split the chunk in half and try each half.
    // This recovers audio when a specific word causes a deterministic G2P failure.
    if (measureMaxAmplitude(audio) <= 0) {
      audio = await generateSplitFallback(tts, voice, chunks[i]!, sampleRate);
    }

    if (onChunk) {
      onChunk({
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        text: chunks[i] ?? "",
        sampleRate,
        sampleCount: audio.length,
        maxAmplitude: measureMaxAmplitude(audio),
        silentRetries: seg.retries,
      });
    }
    parts.push(audio);
    // 60ms silence between sentences for natural pacing
    if (i < chunks.length - 1) {
      parts.push(new Float32Array(Math.round(sampleRate * 0.06)));
    }
  }
  return encodeWav(concatFloat32(parts), { sampleRate });
}
