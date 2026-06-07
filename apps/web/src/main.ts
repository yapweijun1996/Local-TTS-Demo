/**
 * Browser TTS — Kokoro ONNX (FP32/FP16/Q4) + Piper ONNX.
 *
 * Kokoro: 82M params, 24 kHz, 28 voices, Apache 2.0.
 *   FP32 ~326 MB (studio), FP16 ~163 MB (default), Q4 ~86 MB (mobile).
 *   G2P: misaki English dict (Apache 2.0, GPL-free; no espeak-ng triggered).
 *
 * Piper: VITS-based, 22.05 kHz, 50+ languages, MIT.
 *   ~50–75 MB per voice (HuggingFace → OPFS cache).
 *   Phonemizer: espeak-ng WASM (GPLv3 — see docs/LICENSING.md).
 */

import { KokoroTTS, type GenerateOptions } from "kokoro-js";
import * as Piper from "@zahid0/piper-tts-web";

// ── DOM refs ────────────────────────────────────────────────────────
const textInput = document.getElementById("text-input") as HTMLTextAreaElement;
const voiceSelect = document.getElementById("voice-select") as HTMLSelectElement;
const engineSelect = document.getElementById("engine-select") as HTMLSelectElement;
const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
const progressEl = document.getElementById("progress") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const playerRow = document.getElementById("player-row") as HTMLDivElement;
const audioPlayer = document.getElementById("audio-player") as HTMLAudioElement;
const downloadRow = document.getElementById("download-row") as HTMLDivElement;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const resetPiperBtn = document.getElementById("reset-piper-btn") as HTMLButtonElement;

// ── Types ───────────────────────────────────────────────────────────
type EngineId = "kokoro-fp32" | "kokoro-fp16" | "kokoro-q4" | "piper";
type KokoroDtype = "fp32" | "fp16" | "q4";
type VoiceInfo = { id: string; name: string; language: string };

interface EngineState {
  id: EngineId;
  label: string;
  ready: boolean;
  voices: VoiceInfo[];
}

// ── State ───────────────────────────────────────────────────────────
const kokoroCache = new Map<KokoroDtype, KokoroTTS>();
let currentWav: Blob | null = null;
let currentEngine: EngineId = "kokoro-fp16";
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

const engines = new Map<EngineId, EngineState>([
  ["kokoro-fp32", { id: "kokoro-fp32", label: "Kokoro FP32 (326 MB · studio quality)", ready: false, voices: [] }],
  ["kokoro-fp16", { id: "kokoro-fp16", label: "Kokoro FP16 (163 MB · best balance)", ready: false, voices: [] }],
  ["kokoro-q4",  { id: "kokoro-q4",  label: "Kokoro Q4 (86 MB · fast)",           ready: false, voices: [] }],
  ["piper",       { id: "piper",      label: "Piper (50+ langs · MIT license)",     ready: false, voices: [] }],
]);

// ── Helpers ─────────────────────────────────────────────────────────
function showProgress(msg: string): void { progressEl.textContent = msg; }
function showError(msg: string): void { errorEl.textContent = msg; errorEl.classList.add("visible"); }
function clearError(): void { errorEl.textContent = ""; errorEl.classList.remove("visible"); }
function setBusy(busy: boolean): void {
  generateBtn.disabled = busy;
  textInput.disabled = busy;
  voiceSelect.disabled = busy;
  engineSelect.disabled = busy;
  generateBtn.textContent = busy ? "⏳ Generating…" : "⚡ Generate Speech";
}

// ── WebGPU probe ────────────────────────────────────────────────────
async function probeDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const gpu = (navigator as unknown as Record<string, unknown>).gpu as
      | { requestAdapter?: () => Promise<unknown> } | undefined;
    return (await gpu?.requestAdapter?.()) ? "webgpu" : "wasm";
  } catch { return "wasm"; }
}

// ── Kokoro ──────────────────────────────────────────────────────────
const KOKORO_SIZES: Record<KokoroDtype, string> = { fp32: "≈326 MB", fp16: "≈163 MB", q4: "≈86 MB" };

/**
 * Pick a SAFE device for the requested dtype.
 *
 * Known kokoro-js / transformers.js bug: WebGPU produces corrupted/static audio
 * for every dtype except fp32 (and even fp32 is dicey on some mobile GPUs).
 * WASM produces clean audio for all dtypes. So: only fp32 may use WebGPU; every
 * other dtype is forced onto WASM. Refs: transformers.js#1320, hexgrad/kokoro#98.
 */
async function safeDevice(dtype: KokoroDtype): Promise<"webgpu" | "wasm"> {
  if (dtype !== "fp32") return "wasm";
  return probeDevice(); // fp32 is the only WebGPU-safe dtype
}

function fmtMB(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadKokoro(dtype: KokoroDtype): Promise<KokoroTTS> {
  if (kokoroCache.has(dtype)) return kokoroCache.get(dtype)!;
  const device = await safeDevice(dtype);
  const label = `Kokoro ${dtype.toUpperCase()} (${KOKORO_SIZES[dtype]}) · ${device.toUpperCase()}`;
  showProgress(`Loading ${label}…`);

  // transformers.js fires progress_callback per file: 'initiate' → 'download' →
  // 'progress' (with progress %, loaded/total bytes) → 'done'. Surface a % bar so
  // the (86–326 MB) first-load download isn't a silent wait.
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype,
    device,
    progress_callback: (raw) => {
      const e = raw as unknown as {
        status?: string; file?: string; progress?: number; loaded?: number; total?: number;
      };
      if (e.status === "progress" && typeof e.progress === "number") {
        const pct = Math.min(100, Math.round(e.progress));
        const size = e.total ? ` (${fmtMB(e.loaded)} / ${fmtMB(e.total)})` : "";
        showProgress(`Downloading ${label} — ${pct}%${size}`);
      } else if (e.status === "done") {
        showProgress(`Preparing ${label}… (compiling model)`);
      }
    },
  });

  kokoroCache.set(dtype, tts);
  return tts;
}

function kokoroVoices(tts: KokoroTTS): VoiceInfo[] {
  return Object.entries(tts.voices).map(([id, info]) => ({
    id, name: info.name, language: info.language,
  }));
}

// ── Piper ───────────────────────────────────────────────────────────
interface PiperVoice {
  key: string; name: string; language: { code: string; name_english: string };
  quality: string;
}

function getPiper(): { voices: () => Promise<PiperVoice[]>; download: (id: string, cb?: (p: { total: number; loaded: number }) => void) => Promise<void>; predict: (cfg: { text: string; voiceId: string }) => Promise<Blob>; remove: (id: string) => Promise<void>; flush: () => Promise<void> } {
  return Piper as unknown as ReturnType<typeof getPiper>;
}

async function loadPiperVoices(): Promise<VoiceInfo[]> {
  showProgress("Loading Piper voice list…");
  const all = await getPiper().voices();
  const en = all.filter((v) => v.key.startsWith("en_US") || v.key.startsWith("en_GB"));
  const rest = all.filter((v) => !en.includes(v));
  const sorted = [
    ...en.filter((v) => v.quality === "high"),
    ...en.filter((v) => v.quality === "medium"),
    ...rest.filter((v) => v.quality === "high"),
    ...rest.filter((v) => v.quality === "medium"),
  ];
  return sorted.map((v) => ({
    id: v.key, name: `${v.name} (${v.language.name_english})`, language: v.language.code,
  }));
}

/** sessionStorage flag: a cache clear was blocked by OPFS locks; finish it after reload. */
const PIPER_RESET_FLAG = "piper-reset-pending";

async function resetPiperCache(): Promise<void> {
  showProgress("Clearing Piper model cache…");
  try {
    await getPiper().flush();
    const state = engines.get("piper")!;
    state.ready = false;
    state.voices = [];
    showProgress("Piper cache cleared. Select a voice and generate to re-download.");
  } catch (e) {
    // OPFS refuses to delete a model file while the Piper worker still holds an
    // open SyncAccessHandle (NoModificationAllowedError / InvalidStateError).
    // Reloading drops every OPFS handle; init() re-runs flush on the clean load.
    const name = e instanceof Error ? e.name : "";
    if (name === "NoModificationAllowedError" || name === "InvalidStateError") {
      sessionStorage.setItem(PIPER_RESET_FLAG, "1");
      showProgress("Releasing model locks — reloading to finish clearing cache…");
      location.reload();
      return;
    }
    // Cache was empty or the API is unavailable — treat as already cleared.
    const state = engines.get("piper")!;
    state.ready = false;
    state.voices = [];
    showProgress("Piper cache cleared (was already empty).");
  }
}

// ── UI population ───────────────────────────────────────────────────
function populateVoiceDropdown(voices: VoiceInfo[]): void {
  voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = `${v.name} (${v.language})`;
    voiceSelect.appendChild(opt);
  }
  const enHigh = voices.find((v) => v.language?.startsWith("en") && v.id.includes("high"));
  if (enHigh) voiceSelect.value = enHigh.id;
  else if (voices.length > 0) voiceSelect.value = voices[0]!.id;
}

async function onEngineSwitch(): Promise<void> {
  const id = engineSelect.value as EngineId;
  currentEngine = id;
  const state = engines.get(id)!;
  clearError();
  setBusy(true);
  resetPiperBtn.style.display = id === "piper" ? "inline-block" : "none";

  try {
    if (id.startsWith("kokoro-")) {
      const dtype = id.replace("kokoro-", "") as KokoroDtype;
      const tts = await loadKokoro(dtype);
      if (!state.ready) { state.voices = kokoroVoices(tts); state.ready = true; }
      populateVoiceDropdown(state.voices);
    } else if (id === "piper") {
      if (!state.ready) { state.voices = await loadPiperVoices(); state.ready = true; }
      populateVoiceDropdown(state.voices);
    }
    showProgress("Ready. Type text and click Generate.");
  } catch (e) {
    showError(`Engine load failed: ${e instanceof Error ? e.message : "Unknown error"}`);
  } finally { setBusy(false); }
}

// ── Generate ────────────────────────────────────────────────────────
async function onGenerate(): Promise<void> {
  clearError();
  const text = textInput.value.trim();
  if (!text) { showError("Please enter some text."); return; }

  setBusy(true);

  try {
    let wavBuffer: ArrayBuffer;
    const id = currentEngine;

    if (id.startsWith("kokoro-")) {
      const dtype = id.replace("kokoro-", "") as KokoroDtype;
      const tts = await loadKokoro(dtype);
      const voice = (voiceSelect.value || undefined) as GenerateOptions["voice"];
      showProgress("Generating with Kokoro…");
      const raw = await tts.generate(text, { voice });
      wavBuffer = raw.toWav();
    } else {
      // Piper — with auto-retry on corrupted model
      const P = getPiper();
      const voiceId = voiceSelect.value;
      wavBuffer = await piperGenerate(P, text, voiceId, false);
    }

    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    if (audioPlayer.src) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = url;
    playerRow.style.display = "block";
    currentWav = blob;
    downloadRow.classList.add("visible");
    showProgress("✅ Done!");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error.";
    showError(msg);
    showProgress("");
  } finally { setBusy(false); }
}

async function piperGenerate(
  P: ReturnType<typeof getPiper>, text: string, voiceId: string, isRetry: boolean,
): Promise<ArrayBuffer> {
  try {
    if (!isRetry) {
      showProgress("Downloading Piper voice model (first time only)…");
      await P.download(voiceId, (p) => {
        if (p.total > 0) showProgress(`Downloading voice… ${Math.round((p.loaded / p.total) * 100)}%`);
      });
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
      return piperGenerate(P, text, voiceId, true);
    }
    throw e;
  }
}

// ── Download ────────────────────────────────────────────────────────
function onDownload(): void {
  if (!currentWav) return;
  const url = URL.createObjectURL(currentWav);
  const a = document.createElement("a");
  a.href = url; a.download = "tts-output.wav";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Service worker: COOP/COEP (cross-origin isolation) + app-shell cache ────
// On a static host (GitHub Pages) we cannot set COOP/COEP headers, so the SW
// injects them. The very first page load is NOT yet isolated; once the SW takes
// control we reload once so SharedArrayBuffer / multithreaded WASM become
// available. Relative path → correct scope under any base.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      // SW is active but not yet controlling this page → reload once to isolate.
      if (!self.crossOriginIsolated && reg.active && !navigator.serviceWorker.controller) {
        window.location.reload();
      }
    })
    .catch(() => {});
}

// ── Init ────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  // If a previous cache clear was blocked by OPFS locks, the page reloaded with
  // this flag set. Now (clean load, no Piper handle open yet) flush succeeds.
  if (sessionStorage.getItem(PIPER_RESET_FLAG)) {
    sessionStorage.removeItem(PIPER_RESET_FLAG);
    try { await getPiper().flush(); showProgress("Piper cache cleared."); } catch { /* already released/empty */ }
  }

  engineSelect.innerHTML = "";
  for (const [id, state] of engines) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = state.label;
    engineSelect.appendChild(opt);
  }
  engineSelect.value = "kokoro-fp16";
  resetPiperBtn.style.display = "none";

  try { await onEngineSwitch(); } catch (e) {
    showError(`Startup failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    generateBtn.disabled = true;
  }
}

// ── Events ──────────────────────────────────────────────────────────
engineSelect.addEventListener("change", onEngineSwitch);
generateBtn.addEventListener("click", onGenerate);
downloadBtn.addEventListener("click", onDownload);
resetPiperBtn.addEventListener("click", resetPiperCache);
init();
