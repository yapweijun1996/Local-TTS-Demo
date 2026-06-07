/**
 * Piper ONNX engine — browser adapter via @zahid0/piper-tts-web.
 *
 * Piper: VITS-based, 22.05 kHz, 50+ languages, MIT (code).
 *   ~50–75 MB per voice (HuggingFace → OPFS cache).
 *   Phonemizer: espeak-ng WASM (GPLv3 — see docs/LICENSING.md).
 */

import * as PiperLib from "@zahid0/piper-tts-web";
import { showProgress, showBar } from "../ui.js";
import type { VoiceInfo } from "../ui.js";

// ── Types ─────────────────────────────────────────────────────────────
export interface PiperVoice {
  key: string;
  name: string;
  language: { code: string; name_english: string };
  quality: string;
}

// ── Thin typed wrapper ────────────────────────────────────────────────
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

// ── Voices ────────────────────────────────────────────────────────────
export async function loadPiperVoices(): Promise<VoiceInfo[]> {
  showProgress("Loading Piper voice list…");
  const all = await getPiper().voices();
  const en = all.filter(
    (v) => v.key.startsWith("en_US") || v.key.startsWith("en_GB"),
  );
  const rest = all.filter((v) => !en.includes(v));
  const sorted = [
    ...en.filter((v) => v.quality === "high"),
    ...en.filter((v) => v.quality === "medium"),
    ...rest.filter((v) => v.quality === "high"),
    ...rest.filter((v) => v.quality === "medium"),
  ];
  return sorted.map((v) => ({
    id: v.key,
    name: `${v.name} (${v.language.name_english})`,
    language: v.language.code,
  }));
}

// ── Cache reset ───────────────────────────────────────────────────────
/**
 * sessionStorage flag: a cache clear was blocked by OPFS locks; finish it
 * after the page reloads (clean load, no open SyncAccessHandle).
 */
export const PIPER_RESET_FLAG = "piper-reset-pending";

export async function resetPiperCache(): Promise<void> {
  showProgress("Clearing Piper model cache…");
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
      showProgress("Releasing model locks — reloading to finish clearing cache…");
      location.reload();
      return;
    }
    // Cache was empty or the API is unavailable — treat as already cleared.
    showProgress("Piper cache cleared (was already empty).");
  }
}

// ── Generate ──────────────────────────────────────────────────────────
/**
 * Synthesize with Piper.
 *
 * First call downloads the voice model → OPFS (cached for subsequent calls).
 * On ONNX protobuf / "No graph" errors the model is assumed corrupted — cache
 * is cleared and the download retried once.
 */
export async function piperGenerate(
  text: string,
  voiceId: string,
  isRetry = false,
): Promise<ArrayBuffer> {
  const P = getPiper();
  try {
    if (!isRetry) {
      showProgress("Downloading Piper voice model (first time only)…");
      await P.download(voiceId, (p) => {
        if (p.total > 0) {
          const pct = Math.round((p.loaded / p.total) * 100);
          showProgress(`Downloading voice… ${pct}%`);
          showBar(pct);
        }
      });
      showBar(null);
    }
    showProgress("Synthesizing with Piper…");
    const blob = await P.predict({ text, voiceId });
    return blob.arrayBuffer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    // ONNX protobuf error → model corrupted → clear cache & retry once
    if (!isRetry && (msg.includes("protobuf") || msg.includes("No graph"))) {
      showProgress("Piper model corrupted. Clearing cache & re-downloading…");
      await P.remove(voiceId).catch(() => {});
      return piperGenerate(text, voiceId, true);
    }
    throw e;
  }
}
