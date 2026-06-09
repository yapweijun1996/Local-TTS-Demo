/**
 * Piper ONNX engine -- browser adapter via @zahid0/piper-tts-web.
 *
 * Piper: VITS-based, 22.05 kHz, 50+ languages, MIT (code).
 *   ~50-75 MB per voice (HuggingFace -> OPFS cache).
 *   Phonemizer: espeak-ng WASM (GPLv3 -- see docs/LICENSING.md).
 */

import * as PiperLib from "@zahid0/piper-tts-web";
import { segmentText, decodeWav, concatFloat32, encodeWav } from "@local-tts/core";
import type { VoiceInfo } from "../ui.js";

// Same chunk size as Kokoro (main.ts). Keeps the espeak-ng -> VITS phoneme tensor
// per call bounded, so long input can't blow up memory in one synchronous run.
const PIPER_CHUNK_SIZE = 480;
/** Silence inserted between sentence chunks, in seconds (matches Kokoro pacing). */
const GAP_SECONDS = 0.06;
export type ProgressReporter = (message: string, pct?: number | null) => void;
const noopProgress: ProgressReporter = () => {};

// -- Types ------------------------------------------------------------------
export interface PiperVoice {
  key: string;
  name: string;
  language: { code: string; name_english: string };
  quality: string;
}

export type PiperChunkStats = {
  chunkIndex: number;
  totalChunks: number;
  text: string;
  sampleRate: number;
  sampleCount: number;
  maxAmplitude: number;
};

type ChunkLogger = (stats: PiperChunkStats) => void;

function maxAmplitude(samples: Float32Array): number {
  let max = 0;
  for (const v of samples) {
    const abs = Math.abs(v);
    if (abs > max) max = abs;
  }
  return max;
}

// -- Thin typed wrapper -----------------------------------------------------
/** Typed wrapper around the untyped @zahid0/piper-tts-web default export. */
export function getPiper() {
  return PiperLib as unknown as {
    voices(): Promise<PiperVoice[]>;
    download(
      id: string,
      cb?: (p: { total: number; loaded: number }) => void,
    ): Promise<void>;
    predict(cfg: { text: string; voiceId: string }): Promise<Blob>;
    remove(id: string): Promise<void>;
    flush(): Promise<void>;
  };
}

// -- Voices -----------------------------------------------------------------
export async function loadPiperVoices(onProgress: ProgressReporter = noopProgress): Promise<VoiceInfo[]> {
  onProgress("Loading Piper voice list...");
  const all = await getPiper().voices();

  // Quality rank for in-language sorting: high -> medium -> low.
  const qualityRank = (q: string): number => {
    if (q === "high") return 0;
    if (q === "medium") return 1;
    return 2;
  };

  // Group voices by language (English name as label).
  const groups = new Map<string, { label: string; code: string; voices: typeof all }>();
  for (const v of all) {
    const key = v.language.name_english;
    if (!groups.has(key)) {
      groups.set(key, { label: key, code: v.language.code, voices: [] });
    }
    groups.get(key)!.voices.push(v);
  }

  // Sort each language group by quality.
  for (const [, g] of groups) {
    g.voices.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality));
  }

  // Language order: English first, then alphabetical by language name.
  const langOrder = [...groups.keys()].sort((a, b) => {
    if (a === "English") return -1;
    if (b === "English") return 1;
    return a.localeCompare(b);
  });

  // Flatten -- each item carries its languageLabel for optgroup rendering.
  const sorted: VoiceInfo[] = [];
  for (const lang of langOrder) {
    const g = groups.get(lang)!;
    for (const v of g.voices) {
      sorted.push({
        id: v.key,
        name: v.name,
        language: v.language.code,
        languageLabel: g.label,
      });
    }
  }
  return sorted;
}

// -- Cache reset ------------------------------------------------------------
/**
 * sessionStorage flag: a cache clear was blocked by OPFS locks; finish it
 * after the page reloads (clean load, no open SyncAccessHandle).
 */
export const PIPER_RESET_FLAG = "piper-reset-pending";

export async function resetPiperCache(onProgress: ProgressReporter = noopProgress): Promise<void> {
  onProgress("Clearing Piper model cache...");
  try {
    await getPiper().flush();
    onProgress("Piper cache cleared. Select a voice and generate to re-download.");
  } catch (e) {
    // OPFS refuses to delete while Piper worker holds an open SyncAccessHandle
    // (NoModificationAllowedError / InvalidStateError). Reload drops every handle;
    // init() re-runs flush on the clean load.
    const name = e instanceof Error ? e.name : "";
    if (name === "NoModificationAllowedError" || name === "InvalidStateError") {
      sessionStorage.setItem(PIPER_RESET_FLAG, "1");
      onProgress("Releasing model locks - reloading to finish clearing cache...");
      return;
    }
    // Cache was empty or the API is unavailable -- treat as already cleared.
    onProgress("Piper cache cleared (was already empty).");
  }
}

// -- Generate ---------------------------------------------------------------
/**
 * Synthesize with Piper, returning a single WAV ArrayBuffer.
 *
 * First call downloads the voice model -> OPFS (cached for subsequent calls).
 * On ONNX protobuf / "No graph" errors the model is assumed corrupted -- cache
 * is cleared and the download retried once.
 *
 * Long text is split into sentence chunks (like Kokoro): `predict()` phonemizes
 * and runs the whole input as ONE tensor, so feeding 3000 words at once risks a
 * huge allocation / frozen tab. Each chunk returns a finished WAV, so we decode
 * the PCM back out, splice in a short silence between sentences, and re-encode
 * one WAV. Single-chunk input keeps the original fast path (no decode/re-encode).
 */
export async function piperGenerate(
  text: string,
  voiceId: string,
  isRetry = false,
  onChunk?: ChunkLogger,
  onProgress: ProgressReporter = noopProgress,
): Promise<ArrayBuffer> {
  const P = getPiper();
  try {
    if (!isRetry) {
      onProgress("Downloading Piper voice model (first time only)...");
      await P.download(voiceId, (p) => {
        if (p.total > 0) {
          const pct = Math.round((p.loaded / p.total) * 100);
          onProgress(`Downloading voice... ${pct}%`, pct);
        }
      });
      onProgress("Downloading Piper voice model (first time only)...", null);
    }

    const chunks = segmentText(text, PIPER_CHUNK_SIZE);
    if (chunks.length <= 1) {
      onProgress("Synthesizing with Piper...");
      const blob = await P.predict({ text: chunks[0] ?? text, voiceId });
      const arrayBuffer = await blob.arrayBuffer();
      if (onChunk) {
        const decoded = decodeWav(arrayBuffer);
        onChunk({
          chunkIndex: 1,
          totalChunks: 1,
          text: chunks[0] ?? text,
          sampleRate: decoded.sampleRate || 22050,
          sampleCount: decoded.samples.length,
          maxAmplitude: maxAmplitude(decoded.samples),
        });
      }
      return arrayBuffer;
    }

    const parts: Float32Array[] = [];
    let sampleRate = 22050; // Piper default; overwritten from the decoded WAV
    for (let i = 0; i < chunks.length; i++) {
      onProgress(`Synthesizing with Piper... sentence ${i + 1}/${chunks.length}`);
      const blob = await P.predict({ text: chunks[i]!, voiceId });
      const decoded = decodeWav(await blob.arrayBuffer());
      sampleRate = decoded.sampleRate || sampleRate;
      if (onChunk) {
        onChunk({
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          text: chunks[i] ?? "",
          sampleRate,
          sampleCount: decoded.samples.length,
          maxAmplitude: maxAmplitude(decoded.samples),
        });
      }
      parts.push(decoded.samples);
      if (i < chunks.length - 1) {
        parts.push(new Float32Array(Math.round(sampleRate * GAP_SECONDS)));
      }
    }
    return encodeWav(concatFloat32(parts), { sampleRate });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // ONNX protobuf error -> model corrupted -> clear cache & retry once
    if (!isRetry && (msg.includes("protobuf") || msg.includes("No graph"))) {
      onProgress("Piper model corrupted. Clearing cache & re-downloading...");
      return piperGenerate(text, voiceId, true, onChunk, onProgress);
    }
    throw e;
  }
}
