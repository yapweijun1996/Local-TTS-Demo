/**
 * Piper ONNX engine Ã¢â‚¬â€ browser adapter via @zahid0/piper-tts-web.
 *
 * Piper: VITS-based, 22.05 kHz, 50+ languages, MIT (code).
 *   ~50Ã¢â‚¬â€œ75 MB per voice (HuggingFace Ã¢â€ â€™ OPFS cache).
 *   Phonemizer: espeak-ng WASM (GPLv3 Ã¢â‚¬â€ see docs/LICENSING.md).
 */

import * as PiperLib from "@zahid0/piper-tts-web";
import { segmentText, decodeWav, concatFloat32, encodeWav } from "@local-tts/core";
import { showProgress, showBar } from "../ui.js";
import type { VoiceInfo } from "../ui.js";

// Same chunk size as Kokoro (main.ts). Keeps the espeak-ng Ã¢â€ â€™ VITS phoneme tensor
// per call bounded, so long input can't blow up memory in one synchronous run.
const PIPER_CHUNK_SIZE = 480;
/** Silence inserted between sentence chunks, in seconds (matches Kokoro pacing). */
const GAP_SECONDS = 0.06;

// Ã¢â€â‚¬Ã¢â€â‚¬ Types Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Thin typed wrapper Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Voices Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export async function loadPiperVoices(): Promise<VoiceInfo[]> {
  showProgress("Loading Piper voice list...");
  const all = await getPiper().voices();

  // Quality rank for in-language sorting: high Ã¢â€ â€™ medium Ã¢â€ â€™ low.
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

  // Flatten Ã¢â‚¬â€ each item carries its languageLabel for optgroup rendering.
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Cache reset Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
/**
 * sessionStorage flag: a cache clear was blocked by OPFS locks; finish it
 * after the page reloads (clean load, no open SyncAccessHandle).
 */
export const PIPER_RESET_FLAG = "piper-reset-pending";

export async function resetPiperCache(): Promise<void> {
  showProgress("Clearing Piper model cache...");
  try {
    await getPiper().flush();
    showProgress("Piper cache cleared. Select a voice and generate to re-download.");
  } catch (e) {
    // OPFS refuses to delete while Piper worker holds an open SyncAccessHandle
    // (NoModificationAllowedError / InvalidStateError). Reload drops every handle;
    // init() re-runs flush on the clean load.
    const name = e instanceof Error ? e.name : "";
    if (name === "NoModificationAllowedError" || name === "InvalidStateError") {
      sessionStorage.setItem(PIPER_RESET_FLAG, "1");
      showProgress("Releasing model locks - reloading to finish clearing cache...");
      showProgress("Releasing model locks - reloading to finish clearing cache...");
      return;
    }
    // Cache was empty or the API is unavailable Ã¢â‚¬â€ treat as already cleared.
    showProgress("Piper cache cleared (was already empty).");
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Generate Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
/**
 * Synthesize with Piper, returning a single WAV ArrayBuffer.
 *
 * First call downloads the voice model Ã¢â€ â€™ OPFS (cached for subsequent calls).
 * On ONNX protobuf / "No graph" errors the model is assumed corrupted Ã¢â‚¬â€ cache
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
): Promise<ArrayBuffer> {
  const P = getPiper();
  try {
    if (!isRetry) {
      showProgress("Downloading Piper voice model (first time only)...");
      await P.download(voiceId, (p) => {
        if (p.total > 0) {
          const pct = Math.round((p.loaded / p.total) * 100);
           showProgress(`Downloading voice... ${pct}%`);
          showBar(pct);
        }
      });
      showBar(null);
    }

    const chunks = segmentText(text, PIPER_CHUNK_SIZE);
    if (chunks.length <= 1) {
      showProgress("Synthesizing with PiperÃ¢â‚¬Â¦");
      showProgress("Synthesizing with Piper...");
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
      showProgress(`Synthesizing with PiperÃ¢â‚¬Â¦ sentence ${i + 1}/${chunks.length}`);
      showProgress(`Synthesizing with Piper... sentence ${i + 1}/${chunks.length}`);
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
    // ONNX protobuf error Ã¢â€ â€™ model corrupted Ã¢â€ â€™ clear cache & retry once
    if (!isRetry && (msg.includes("protobuf") || msg.includes("No graph"))) {
      showProgress("Piper model corrupted. Clearing cache & re-downloading...");
      showProgress("Piper model corrupted. Clearing cache & re-downloading...");
      return piperGenerate(text, voiceId, true, onChunk);
    }
    throw e;
  }
}
