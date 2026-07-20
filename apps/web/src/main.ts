/**
 * Browser TTS — controller.
 *
 * Wires UI events → engine adapters (Kokoro / Piper) → audio output.
 * Validation and text segmentation are delegated to @local-tts/core so the
 * browser app and the future Node API share identical text-handling behavior.
 *
 * Control model: Language is the primary choice and constrains Engine, because
 * the engines genuinely differ in what they can speak — Kokoro has no Mandarin
 * G2P, so offering "Kokoro + 中文" would be a dead option. Picking a language
 * rebuilds the engine list to exactly what can serve it.
 */

import { validateText, TtsError } from "@local-tts/core";
import {
  saveHistoryEntry,
  listHistory,
  deleteHistoryEntry,
  clearHistory,
  totalStorageBytes,
  relativeTime,
  formatBytes,
  MAX_DB_BYTES,
  type HistoryEntry,
} from "./ttsHistory.js";
// Type-only: erased at build time, so neither engine library is pulled into
// the main bundle. All model loading now happens inside the worker.
import type { KokoroChunkStats } from "./engines/kokoro.js";
import type { PiperChunkStats } from "./engines/piper.js";
import * as ui from "./ui.js";
import type { VoiceInfo, ProgressDetail, Phase } from "./ui.js";

// ── Engine + language catalogue ───────────────────────────────────────
type EngineId = "kokoro-fp32" | "kokoro-fp16" | "kokoro-q4" | "piper" | "mixed";
type LanguageId = "en" | "zh" | "auto";
type ChunkStats = KokoroChunkStats | PiperChunkStats;

/**
 * sessionStorage flag: a Piper cache clear was blocked by open OPFS handles,
 * so it is retried after the next reload. Lives here rather than in the engine
 * because the engine now runs in a worker, which has no sessionStorage.
 */
const PIPER_RESET_FLAG = "piper-reset-pending";

interface EngineMeta {
  id: EngineId;
  /** Shown in the dropdown. */
  label: string;
  /** One line under the dropdown explaining the trade-off in plain words. */
  hint: string;
  /** Output sample rate, for the Advanced panel. */
  sampleRate: number;
}

const ENGINE_META: Record<EngineId, EngineMeta> = {
  "kokoro-q4": {
    id: "kokoro-q4",
    label: "Kokoro Q4 (Fast) · Recommended",
    hint: "Optimised for speed and lower memory usage. About 86 MB of model weights.",
    sampleRate: 24000,
  },
  "kokoro-fp16": {
    id: "kokoro-fp16",
    label: "Kokoro FP16 (Balanced)",
    hint: "Higher quality, more memory. About 163 MB of model weights.",
    sampleRate: 24000,
  },
  "kokoro-fp32": {
    id: "kokoro-fp32",
    label: "Kokoro FP32 (Studio)",
    hint: "Best quality and the slowest to load. About 326 MB of model weights.",
    sampleRate: 24000,
  },
  piper: {
    id: "piper",
    label: "Piper (50+ languages)",
    hint: "MIT-licensed voices, roughly 50–75 MB per voice, downloaded on demand.",
    sampleRate: 22050,
  },
  mixed: {
    id: "mixed",
    label: "Mixed 中英文 (Kokoro EN + Piper ZH)",
    hint: "Detects English and Mandarin per sentence and routes each to the engine that speaks it.",
    sampleRate: 24000,
  },
};

interface LanguageMeta {
  id: LanguageId;
  label: string;
  /** Engines able to serve this language, best default first. */
  engines: EngineId[];
}

const LANGUAGES: LanguageMeta[] = [
  { id: "en", label: "English", engines: ["kokoro-q4", "kokoro-fp16", "kokoro-fp32", "piper"] },
  { id: "zh", label: "中文 (Mandarin)", engines: ["piper"] },
  { id: "auto", label: "Auto Detect (English + 中文)", engines: ["mixed"] },
];

const SAMPLES: Record<"en" | "zh", string> = {
  en: "Hello, welcome to the Local TTS Demo. This is running entirely in your browser — no server, no API keys, no cloud.",
  zh: "你好，欢迎使用本地语音合成演示。所有运算都在你的浏览器里完成，不会上传任何文字。",
};

// ── State ─────────────────────────────────────────────────────────────
interface EngineState {
  ready: boolean;
  voices: VoiceInfo[];
  /** Mandarin (Piper) voice list — only populated for the "mixed" engine. */
  zhVoices?: VoiceInfo[];
  /** Compute device the worker actually chose, reported back on prepare. */
  device?: string;
  sampleRate?: number;
}

const engineStates = new Map<EngineId, EngineState>();
function stateOf(id: EngineId): EngineState {
  let s = engineStates.get(id);
  if (!s) {
    s = { ready: false, voices: [] };
    engineStates.set(id, s);
  }
  return s;
}

let currentLanguage: LanguageId = "en";
let currentEngine: EngineId = "kokoro-q4";
let currentWav: Blob | null = null;
let generationRunId = 0;
let activeRunId = 0;

// ── Small helpers ─────────────────────────────────────────────────────
function summarizeText(input: string, maxLen = 140): string {
  const flat = input.replace(/\s+/g, " ").trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}...`;
}

function logChunkStats(engine: string, stats: ChunkStats): void {
  const amp = Number.isFinite(stats.maxAmplitude) ? stats.maxAmplitude : 0;
  const ampLabel = amp <= 0 ? "SILENT" : `maxAmp=${amp.toFixed(6)}`;
  const retryLabel =
    "silentRetries" in stats && stats.silentRetries > 0 ? ` retries=${stats.silentRetries}` : "";
  ui.appendDebugLog(
    `[${engine}] chunk ${stats.chunkIndex}/${stats.totalChunks} textLen=${stats.text.length} sampleRate=${stats.sampleRate} samples=${stats.sampleCount} ${ampLabel}${retryLabel} text="${summarizeText(stats.text)}"`,
  );
}

/**
 * Duration in seconds from a canonical PCM WAV buffer.
 * Reads the fmt/data chunk headers instead of decoding the samples, so it stays
 * cheap for multi-megabyte output. Returns 0 if the layout is unexpected.
 */
function wavDurationSec(buffer: ArrayBuffer): number {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return 0; // "RIFF"
    let offset = 12;
    let sampleRate = 0;
    let channels = 1;
    let bitsPerSample = 16;
    let dataBytes = 0;
    while (offset + 8 <= view.byteLength) {
      const id = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      if (id === 0x666d7420) {
        // "fmt "
        channels = view.getUint16(offset + 10, true) || 1;
        sampleRate = view.getUint32(offset + 12, true);
        bitsPerSample = view.getUint16(offset + 22, true) || 16;
      } else if (id === 0x64617461) {
        // "data"
        dataBytes = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    const bytesPerFrame = channels * (bitsPerSample / 8);
    if (!sampleRate || !bytesPerFrame) return 0;
    return dataBytes / bytesPerFrame / sampleRate;
  } catch {
    return 0;
  }
}

function voiceLabelFor(select: HTMLSelectElement): string {
  const opt = select.selectedOptions[0];
  return opt ? opt.textContent ?? opt.value : "—";
}

function languageLabel(): string {
  return LANGUAGES.find((l) => l.id === currentLanguage)?.label ?? "—";
}

function engineIdentityDetail(): string {
  const s = stateOf(currentEngine);
  if (!s.ready) return "First-time setup · this only happens once.";
  return "Ready to generate on this device.";
}

// ── Worker plumbing ───────────────────────────────────────────────────
type WorkerRequestMessage = {
  type: "generate";
  runId: number;
  engine: EngineId;
  text: string;
  voice: string;
  zhVoice?: string;
};

type WorkerResponseMessage =
  | { type: "progress"; runId: number; message: string; pct?: number | null; detail?: ProgressDetail }
  | {
      type: "prepared";
      runId: number;
      voices: VoiceInfo[];
      zhVoices?: VoiceInfo[];
      device: string;
      sampleRate: number;
    }
  | { type: "reset-piper-done"; runId: number; locked: boolean }
  | { type: "log"; runId: number; message: string }
  | { type: "chunk"; runId: number; engine: EngineId; stats: ChunkStats }
  | { type: "done"; runId: number; wavBuffer: ArrayBuffer }
  | { type: "error"; runId: number; message: string }
  | { type: "aborted"; runId: number };

interface WorkerGenerationJob {
  resolve: (wav: ArrayBuffer) => void;
  reject: (reason: unknown) => void;
  onChunk: (stats: ChunkStats) => void;
}

interface PrepareResult {
  voices: VoiceInfo[];
  zhVoices?: VoiceInfo[];
  device: string;
  sampleRate: number;
}

interface PendingJob<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

let ttsWorker: Worker | null = null;
const workerJobs = new Map<number, WorkerGenerationJob>();
const prepareJobs = new Map<number, PendingJob<PrepareResult>>();
const resetJobs = new Map<number, PendingJob<boolean>>();
const CANCELLED_ERROR = "Generation cancelled.";

function getWorker(): Worker {
  if (ttsWorker) return ttsWorker;
  ttsWorker = new Worker(new URL("./ttsWorker.ts", import.meta.url), { type: "module" });
  ttsWorker.addEventListener("message", onTtsWorkerMessage);
  ttsWorker.addEventListener("error", onTtsWorkerError);
  return ttsWorker;
}

/**
 * Translate an engine progress message into a phase.
 *
 * The engines report what they are actually doing ("Downloading model files",
 * "Compiling model", "Generating…"). Anything that is not synthesis is a load
 * step, so the UI can never label a download as generation.
 */
function progressToPhase(message: string, pct?: number | null, detail?: ProgressDetail): Phase {
  const isSynthesis = /generat|synthesi/i.test(message);
  if (isSynthesis) {
    return { kind: "generating", step: message, pct: pct ?? null };
  }
  return { kind: "engine-loading", step: message, pct: pct ?? null, detail };
}

function reportProgress(runId: number, message: string, pct?: number | null, detail?: ProgressDetail): void {
  // A voice preview is not a generation run. Routing its progress into the
  // phase machine would make the main button read "Generating audio…" and leave
  // the result badge stuck on "Generating" once the sample finished.
  if (runId === previewRunId) return;
  if (runId !== generationRunId) return;
  ui.renderPhase(progressToPhase(message, pct, detail));
}

function onTtsWorkerMessage(event: MessageEvent<WorkerResponseMessage>): void {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  const job = workerJobs.get(msg.runId);

  switch (msg.type) {
    case "progress":
      reportProgress(msg.runId, msg.message, msg.pct, msg.detail);
      break;
    case "prepared": {
      const p = prepareJobs.get(msg.runId);
      prepareJobs.delete(msg.runId);
      p?.resolve({
        voices: msg.voices,
        zhVoices: msg.zhVoices,
        device: msg.device,
        sampleRate: msg.sampleRate,
      });
      break;
    }
    case "reset-piper-done": {
      const r = resetJobs.get(msg.runId);
      resetJobs.delete(msg.runId);
      r?.resolve(msg.locked);
      break;
    }
    case "log":
      ui.appendDebugLog(`[worker] ${msg.message}`);
      break;
    case "chunk":
      if (msg.runId === generationRunId && job) job.onChunk(msg.stats);
      break;
    case "done":
      workerJobs.delete(msg.runId);
      if (job && msg.runId === generationRunId) job.resolve(msg.wavBuffer);
      break;
    case "error": {
      // One error channel serves every request kind, so route it to whichever
      // job is actually waiting on this runId.
      const err = new Error(msg.message || "Worker request failed");
      const p = prepareJobs.get(msg.runId);
      if (p) {
        prepareJobs.delete(msg.runId);
        p.reject(err);
        break;
      }
      const r = resetJobs.get(msg.runId);
      if (r) {
        resetJobs.delete(msg.runId);
        r.reject(err);
        break;
      }
      workerJobs.delete(msg.runId);
      if (job && msg.runId === generationRunId) job.reject(err);
      break;
    }
    case "aborted":
      workerJobs.delete(msg.runId);
      if (job && msg.runId === generationRunId) job.reject(new Error(CANCELLED_ERROR));
      break;
  }
}

function onTtsWorkerError(event: ErrorEvent): void {
  ui.appendDebugLog(`[worker] runtime error: ${event.message}`);
  const err = new Error(event.message || "Worker runtime error");
  // Every pending request must fail, or the UI hangs on a promise that can
  // never settle now that the worker is dead.
  for (const [runId, job] of workerJobs) {
    job.reject(err);
    workerJobs.delete(runId);
  }
  for (const [runId, job] of prepareJobs) {
    job.reject(err);
    prepareJobs.delete(runId);
  }
  for (const [runId, job] of resetJobs) {
    job.reject(err);
    resetJobs.delete(runId);
  }
}

function startWorkerGenerate(
  runId: number,
  engine: EngineId,
  text: string,
  voice: string,
  onChunk: (stats: ChunkStats) => void,
  zhVoice?: string,
): Promise<ArrayBuffer> {
  const worker = getWorker();
  return new Promise((resolve, reject) => {
    workerJobs.set(runId, { resolve, reject, onChunk });
    try {
      worker.postMessage({
        type: "generate",
        runId,
        engine,
        text,
        voice,
        zhVoice,
      } satisfies WorkerRequestMessage);
    } catch (e) {
      workerJobs.delete(runId);
      reject(e);
    }
  });
}

function startWorkerPrepare(runId: number, engine: EngineId): Promise<PrepareResult> {
  const worker = getWorker();
  return new Promise((resolve, reject) => {
    prepareJobs.set(runId, { resolve, reject });
    try {
      worker.postMessage({ type: "prepare", runId, engine });
    } catch (e) {
      prepareJobs.delete(runId);
      reject(e);
    }
  });
}

function startWorkerResetPiper(runId: number): Promise<boolean> {
  const worker = getWorker();
  return new Promise((resolve, reject) => {
    resetJobs.set(runId, { resolve, reject });
    try {
      worker.postMessage({ type: "reset-piper", runId });
    } catch (e) {
      resetJobs.delete(runId);
      reject(e);
    }
  });
}

function cancelWorkerRun(runId: number): void {
  if (runId <= 0) return;
  const job = workerJobs.get(runId);
  if (job) {
    workerJobs.delete(runId);
    job.reject(new Error(CANCELLED_ERROR));
  }
  ttsWorker?.postMessage({ type: "cancel", runId });
}

// ── Language → Engine → Voice ─────────────────────────────────────────
function populateLanguageDropdown(): void {
  ui.languageSelect.innerHTML = "";
  for (const lang of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = lang.id;
    opt.textContent = lang.label;
    ui.languageSelect.appendChild(opt);
  }
  ui.languageSelect.value = currentLanguage;
}

/** Rebuild the engine list to exactly the engines that can speak the language. */
function populateEngineDropdown(): void {
  const lang = LANGUAGES.find((l) => l.id === currentLanguage)!;
  ui.engineSelect.innerHTML = "";
  for (const id of lang.engines) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = ENGINE_META[id].label;
    ui.engineSelect.appendChild(opt);
  }
  if (!lang.engines.includes(currentEngine)) {
    currentEngine = lang.engines[0]!;
  }
  ui.engineSelect.value = currentEngine;
  ui.engineHint.textContent = ENGINE_META[currentEngine].hint;
}

function engineTitle(meta: EngineMeta): string {
  return meta.label.replace(" · Recommended", "");
}

/**
 * Repopulate a voice dropdown without discarding the user's pick.
 * Engine switches re-send the whole list, and silently resetting the voice
 * every time would undo a deliberate choice.
 */
function populatePreservingSelection(select: HTMLSelectElement, voices: VoiceInfo[]): void {
  const previous = select.value;
  ui.populateVoiceDropdown(voices, select);
  if (previous && voices.some((v) => v.id === previous)) select.value = previous;
}

/** Voices the current engine can offer for the current language. */
function voicesForCurrent(all: VoiceInfo[]): VoiceInfo[] {
  if (currentEngine !== "piper") return all;
  const prefix = currentLanguage === "zh" ? "zh" : "en";
  const filtered = all.filter((v) => v.language?.toLowerCase().startsWith(prefix));
  return filtered.length > 0 ? filtered : all;
}

async function onLanguageChange(): Promise<void> {
  currentLanguage = ui.languageSelect.value as LanguageId;
  populateEngineDropdown();
  await onEngineSwitch();
}

async function onEngineSwitch(): Promise<void> {
  currentEngine = ui.engineSelect.value as EngineId;
  const meta = ENGINE_META[currentEngine];
  const state = stateOf(currentEngine);

  ui.clearError();
  ui.engineHint.textContent = meta.hint;
  ui.setControlsBusy(true);
  ui.zhVoiceRow.hidden = currentEngine !== "mixed";

  // Say why the dropdown is empty instead of rendering a blank, broken-looking control.
  if (!state.ready) {
    ui.setVoicesLoading();
    if (currentEngine === "mixed") ui.setVoicesLoading(ui.zhVoiceSelect);
  }

  ui.setEngineIdentity(meta.label.replace(" · Recommended", ""), engineIdentityDetail());
  ui.renderPhase({ kind: "engine-loading", step: "Checking browser cache", pct: null });

  // A newer switch supersedes this one; the runId gate below drops stale replies.
  const runId = ++generationRunId;
  try {
    const prepared = await startWorkerPrepare(runId, currentEngine);
    if (runId !== generationRunId) return;

    state.voices = prepared.voices;
    state.zhVoices = prepared.zhVoices;
    state.device = prepared.device;
    state.sampleRate = prepared.sampleRate;
    state.ready = true;

    populatePreservingSelection(ui.voiceSelect, voicesForCurrent(state.voices));
    if (currentEngine === "mixed") {
      populatePreservingSelection(ui.zhVoiceSelect, state.zhVoices ?? []);
      if ((state.zhVoices ?? []).length === 0) {
        ui.showError({
          title: "No Mandarin voice is available",
          hint: "The Piper voice list returned no zh voice. Switch to English, or clear the voice cache under Advanced.",
        });
      }
    }

    ui.setEngineIdentity(engineTitle(meta), "Ready to generate on this device.");
    ui.renderPhase({ kind: "engine-ready" });
    ui.appendDebugLog(
      `[engine-switch] ${currentEngine} ready (lang=${currentLanguage}, device=${prepared.device})`,
    );
  } catch (e) {
    if (runId !== generationRunId) return;
    ui.showError(ui.toUserError(e, "load"));
    ui.renderPhase({ kind: "engine-failed" });
    ui.appendDebugLog(
      `[engine-switch] failed ${currentEngine} => ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // A superseded switch must not re-enable controls the newer one locked.
    if (runId === generationRunId) {
      ui.setControlsBusy(false);
      void refreshAdvancedPanel();
    }
  }
}

// ── Generate ──────────────────────────────────────────────────────────
const CHUNK_SIZE = 480;

async function onGenerate(): Promise<void> {
  // Retry from a failed engine load re-runs the load instead of generating.
  if (ui.getPhase().kind === "engine-failed") {
    await onEngineSwitch();
    return;
  }
  if (generationRunId > 0) cancelWorkerRun(generationRunId);

  ui.clearError();
  const runId = ++generationRunId;
  activeRunId = runId;
  ui.setControlsBusy(true);
  ui.setDebugStatus("");
  ui.clearDebugLog();
  clearCurrentWav();

  const generationStart = performance.now();
  const engine = currentEngine;
  let totalChunkEstimate = 0;

  const onChunk = (stats: ChunkStats): void => {
    if (runId !== generationRunId) return;
    totalChunkEstimate = stats.totalChunks;
    logChunkStats(engine, stats);
    const elapsed = performance.now() - generationStart;
    const avg = elapsed / Math.max(1, stats.chunkIndex);
    const etaMs = avg * Math.max(0, totalChunkEstimate - stats.chunkIndex);
    const pct = Math.max(0, Math.min(100, (stats.chunkIndex / totalChunkEstimate) * 100));
    ui.renderPhase({
      kind: "generating",
      step: `Generating sentence ${stats.chunkIndex} of ${totalChunkEstimate}`,
      pct,
      etaMs,
    });
  };

  try {
    const text = validateText(ui.textInput.value, { maxLength: ui.MAX_TEXT_LENGTH });
    ui.renderPhase({ kind: "generating", step: "Preparing text", pct: null });
    ui.appendDebugLog(`[${engine}] generate start len=${text.length}`);
    totalChunkEstimate = Math.max(1, Math.ceil(text.length / CHUNK_SIZE));

    const wavBuffer = await startWorkerGenerate(
      runId,
      engine,
      text,
      ui.voiceSelect.value || "",
      onChunk,
      engine === "mixed" ? ui.zhVoiceSelect.value || "" : undefined,
    );
    if (runId !== generationRunId) return;

    const elapsedMs = performance.now() - generationStart;
    const durationSec = wavDurationSec(wavBuffer);
    ui.appendDebugLog(`generate done. wavBytes=${wavBuffer.byteLength} duration=${durationSec.toFixed(2)}s`);

    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    currentWav = blob;
    if (ui.audioPlayer.src) URL.revokeObjectURL(ui.audioPlayer.src);
    ui.showResult(URL.createObjectURL(blob), {
      voice: voiceLabelFor(ui.voiceSelect),
      language: languageLabel(),
      durationSec,
      elapsedMs,
    });
    ui.renderPhase({ kind: "done", elapsedMs });
    ui.setDebugStatus("Done. Download ready.");

    // Persist to IndexedDB history (fire-and-forget; full text saved).
    saveHistoryEntry({
      text,
      engine,
      voice:
        engine === "mixed"
          ? `${ui.voiceSelect.value}+${ui.zhVoiceSelect.value}`
          : ui.voiceSelect.value || "",
      wavBlob: blob,
      byteLength: wavBuffer.byteLength,
      durationSec,
      createdAt: Date.now(),
    })
      .then(() => refreshHistoryPanel())
      .catch(() => {});
  } catch (e) {
    if (runId !== generationRunId) return;
    if (e instanceof Error && e.message === CANCELLED_ERROR) {
      ui.setDebugStatus("Generation cancelled.");
      ui.renderPhase({ kind: "cancelled" });
      return;
    }
    ui.setDebugStatus("Generation failed. See log.");
    ui.showError(
      e instanceof TtsError
        ? { title: e.message, hint: "Adjust the text and try again." }
        : ui.toUserError(e, "generate"),
    );
    ui.renderPhase({ kind: "engine-ready" });
    ui.appendDebugLog(
      `[${engine}] generate failed => ${e instanceof Error ? e.message : "Unknown error"}`,
    );
  } finally {
    if (runId === generationRunId) {
      ui.setControlsBusy(false);
      if (activeRunId === runId) activeRunId = 0;
    }
  }
}

function onCancelGenerate(): void {
  if (activeRunId) cancelWorkerRun(activeRunId);
}

function clearCurrentWav(): void {
  if (!ui.audioPlayer.paused) ui.audioPlayer.pause();
  if (ui.audioPlayer.src) {
    URL.revokeObjectURL(ui.audioPlayer.src);
    ui.audioPlayer.removeAttribute("src");
    ui.audioPlayer.load();
  }
  ui.clearResult();
  currentWav = null;
}

// ── Voice preview ─────────────────────────────────────────────────────
const PREVIEW_TEXT: Record<"en" | "zh", string> = {
  en: "Hello, this is how I sound.",
  zh: "你好，这是我的声音。",
};
const previewAudio = new Audio();
let previewRunning = false;
/** Run id of an in-flight preview, so its progress bypasses the phase machine. */
let previewRunId: number | null = null;

async function onPreviewVoice(): Promise<void> {
  if (previewRunning) return;
  const phase = ui.getPhase().kind;
  if (phase !== "engine-ready" && phase !== "done" && phase !== "cancelled") return;

  previewRunning = true;
  ui.setPreviewBusy(true);
  const runId = ++generationRunId;
  previewRunId = runId;
  try {
    const text = currentLanguage === "zh" ? PREVIEW_TEXT.zh : PREVIEW_TEXT.en;
    const buffer = await startWorkerGenerate(
      runId,
      currentEngine,
      text,
      ui.voiceSelect.value || "",
      () => {},
      currentEngine === "mixed" ? ui.zhVoiceSelect.value || "" : undefined,
    );
    if (previewAudio.src) URL.revokeObjectURL(previewAudio.src);
    previewAudio.src = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    await previewAudio.play().catch(() => {});
  } catch (e) {
    ui.showError(ui.toUserError(e, "generate"));
  } finally {
    // Leave the phase exactly as it was — a preview must not overwrite a
    // result the user already generated.
    previewRunId = null;
    previewRunning = false;
    ui.setPreviewBusy(false);
  }
}

// ── Download ──────────────────────────────────────────────────────────
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function onDownload(): void {
  if (currentWav) triggerDownload(currentWav, "tts-output.wav");
}

// ── History ───────────────────────────────────────────────────────────
/** Active object URLs for history playback — revoked on delete / clear. */
const historyUrls = new Map<number, string>();

function iconSvg(name: string, cls = "icon icon-sm"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${name}`);
  svg.appendChild(use);
  return svg;
}

function iconButton(icon: string, label: string, danger = false): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = danger ? "icon-btn is-danger" : "icon-btn";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.appendChild(iconSvg(icon));
  return btn;
}

/** Built with DOM APIs, not innerHTML — user text can never become markup. */
function renderHistoryEntry(entry: HistoryEntry): HTMLElement {
  const id = entry.id!;
  const item = document.createElement("div");
  item.className = "history-item";
  item.setAttribute("role", "listitem");
  item.dataset.id = String(id);

  const play = iconButton("i-play", "Play this generation");
  play.classList.add("is-round");

  const text = document.createElement("div");
  text.className = "history-text";
  text.textContent = summarizeText(entry.text, 120);
  text.title = entry.text;

  const facts = document.createElement("div");
  facts.className = "history-facts";
  const parts = [
    entry.voice || entry.engine,
    entry.durationSec ? ui.formatSeconds(entry.durationSec) : formatBytes(entry.byteLength),
    relativeTime(entry.createdAt),
  ];
  for (const p of parts) {
    const span = document.createElement("span");
    span.className = "num";
    span.textContent = p;
    facts.appendChild(span);
  }

  const actions = document.createElement("div");
  actions.className = "history-actions";
  const dl = iconButton("i-download", "Download this generation");
  const del = iconButton("i-trash", "Delete this generation", true);
  actions.append(dl, del);

  item.append(play, text, facts, actions);

  play.addEventListener("click", () => {
    let url = historyUrls.get(id);
    if (!url) {
      url = URL.createObjectURL(entry.wavBlob);
      historyUrls.set(id, url);
    }
    if (ui.audioPlayer.src) URL.revokeObjectURL(ui.audioPlayer.src);
    ui.showResult(url, {
      voice: entry.voice || entry.engine,
      language: entry.engine === "mixed" ? "English + 中文" : "—",
      durationSec: entry.durationSec ?? 0,
      elapsedMs: 0,
    });
    void ui.audioPlayer.play().catch(() => {});
  });

  dl.addEventListener("click", () => {
    const ts = new Date(entry.createdAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    triggerDownload(entry.wavBlob, `tts-${ts}.wav`);
  });

  del.addEventListener("click", async () => {
    const url = historyUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      historyUrls.delete(id);
    }
    await deleteHistoryEntry(id);
    await refreshHistoryPanel();
  });

  return item;
}

async function refreshHistoryPanel(): Promise<void> {
  const [entries, usedBytes] = await Promise.all([listHistory(), totalStorageBytes()]);

  const limitMB = MAX_DB_BYTES / (1024 * 1024);
  ui.historyStorageUsed.textContent = entries.length
    ? `${formatBytes(usedBytes)} of ${limitMB} MB used`
    : "";

  historyUrls.forEach((url) => URL.revokeObjectURL(url));
  historyUrls.clear();
  ui.historyList.innerHTML = "";

  const hasEntries = entries.length > 0;
  ui.historyEmpty.hidden = hasEntries;
  // No "Clear All" when there is nothing to clear.
  ui.historyClearBtn.hidden = !hasEntries;
  for (const entry of entries) ui.historyList.appendChild(renderHistoryEntry(entry));

  ui.cacheHistory.textContent = formatBytes(usedBytes);
}

async function onHistoryClear(): Promise<void> {
  historyUrls.forEach((url) => URL.revokeObjectURL(url));
  historyUrls.clear();
  await clearHistory();
  await refreshHistoryPanel();
}

// ── Advanced panel ────────────────────────────────────────────────────
async function refreshAdvancedPanel(): Promise<void> {
  const meta = ENGINE_META[currentEngine];
  const state = stateOf(currentEngine);
  ui.perfEngine.textContent = engineTitle(meta);
  // Prefer what the worker actually resolved over the catalogue's expectation.
  const rate = state.sampleRate ?? meta.sampleRate;
  ui.perfRate.textContent = `${(rate / 1000).toFixed(2).replace(/\.?0+$/, "")} kHz`;
  ui.perfThreads.textContent = String(navigator.hardwareConcurrency || "unknown");
  ui.perfCoi.textContent = self.crossOriginIsolated ? "Yes" : "No";

  const device = state.device ?? "—";
  ui.perfDevice.textContent = device;
  ui.perfMeta.textContent = state.device ?? "";

  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) {
      ui.cacheUsed.textContent = formatBytes(est.usage);
      ui.cacheMeta.textContent = formatBytes(est.usage);
    } else {
      ui.cacheUsed.textContent = "unavailable";
    }
  } catch {
    ui.cacheUsed.textContent = "unavailable";
  }
}

async function onResetPiperCache(): Promise<void> {
  // The clear runs in the worker (it owns the OPFS handles), so restore
  // whatever phase we were in once its progress messages stop.
  const priorPhase = ui.getPhase();
  try {
    const locked = await startWorkerResetPiper(++generationRunId);
    if (locked) {
      // OPFS refused while a SyncAccessHandle was open. A reload drops every
      // handle; init() retries the clear on the next clean load.
      sessionStorage.setItem(PIPER_RESET_FLAG, "1");
      ui.showError({
        title: "Reload to finish clearing the voice cache",
        hint: "The voice files are still open. Reload this page and the cache is cleared automatically.",
      });
    } else {
      ui.setDebugStatus("Piper voice cache cleared.");
      // Voice lists came from files that no longer exist — force a re-prepare.
      stateOf("piper").ready = false;
      stateOf("mixed").ready = false;
    }
    await refreshAdvancedPanel();
  } catch (e) {
    ui.showError(ui.toUserError(e, "load"));
  } finally {
    ui.renderPhase(priorPhase);
  }
}

async function onCopyDebugLog(): Promise<void> {
  try {
    await ui.copyDebugLog();
  } catch (e) {
    ui.setDebugStatus(`Copy failed: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

// ── Input assistance ──────────────────────────────────────────────────
function setText(value: string): void {
  ui.textInput.value = value;
  ui.updateCharCount();
  ui.textInput.focus();
}

const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);

function applyShortcutLabels(): void {
  const label = isMac ? "⌘ Enter" : "Ctrl Enter";
  ui.kbdGenerate.textContent = label;
  const btnKbd = ui.generateBtn.querySelector(".kbd");
  if (btnKbd) btnKbd.textContent = label;
}

function onKeydown(e: KeyboardEvent): void {
  if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (!ui.generateBtn.disabled) void onGenerate();
    return;
  }
  if (e.key === "Escape" && !ui.cancelBtn.hidden) {
    e.preventDefault();
    onCancelGenerate();
  }
}

// ── Service worker: COOP/COEP isolation + app-shell cache ─────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      if (!self.crossOriginIsolated && reg.active && !navigator.serviceWorker.controller) {
        window.location.reload();
      }
    })
    .catch(() => {});
}

// ── Init ──────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  ui.initTheme();
  applyShortcutLabels();
  ui.updateCharCount();
  ui.clearResult();
  ui.renderPhase({ kind: "boot" });

  // A previous clear was blocked by open OPFS handles. This load is clean, so
  // retry it before anything touches the Piper cache again.
  if (sessionStorage.getItem(PIPER_RESET_FLAG)) {
    sessionStorage.removeItem(PIPER_RESET_FLAG);
    try {
      await startWorkerResetPiper(++generationRunId);
      ui.setDebugStatus("Piper voice cache cleared.");
    } catch {
      // Already released or empty — nothing to report.
    }
  }

  populateLanguageDropdown();
  populateEngineDropdown();

  try {
    await onEngineSwitch();
  } catch (e) {
    ui.showError(ui.toUserError(e, "load"));
    ui.renderPhase({ kind: "engine-failed" });
  }

  void refreshHistoryPanel();
  void refreshAdvancedPanel();
}

// ── Listeners ─────────────────────────────────────────────────────────
ui.languageSelect.addEventListener("change", () => {
  void onLanguageChange();
});
ui.engineSelect.addEventListener("change", () => {
  void onEngineSwitch();
});
ui.generateBtn.addEventListener("click", () => {
  void onGenerate();
});
ui.cancelBtn.addEventListener("click", onCancelGenerate);
ui.regenerateBtn.addEventListener("click", () => {
  void onGenerate();
});
ui.previewBtn.addEventListener("click", () => void onPreviewVoice());
ui.downloadBtn.addEventListener("click", onDownload);

ui.textInput.addEventListener("input", ui.updateCharCount);
ui.sampleEnBtn.addEventListener("click", () => setText(SAMPLES.en));
ui.sampleZhBtn.addEventListener("click", () => setText(SAMPLES.zh));
ui.clearTextBtn.addEventListener("click", () => setText(""));

ui.historyClearBtn.addEventListener("click", () => void onHistoryClear());
ui.resetPiperBtn.addEventListener("click", () => void onResetPiperCache());
ui.copyDebugLogBtn.addEventListener("click", () => void onCopyDebugLog());
ui.clearDebugLogBtn.addEventListener("click", () => {
  ui.clearDebugLog();
  ui.setDebugStatus("Debug log cleared.");
});
ui.errorDetailsBtn.addEventListener("click", () => {
  ui.appendDebugLog(`[error-details] ${ui.getLastTechnical()}`);
  ui.revealDebugLog();
});

ui.themeLightBtn.addEventListener("click", () => ui.applyTheme("light"));
ui.themeDarkBtn.addEventListener("click", () => ui.applyTheme("dark"));
ui.settingsBtn.addEventListener("click", () => {
  ui.advPerformance.open = true;
  ui.advCache.open = true;
  ui.advancedPanel.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.addEventListener("keydown", onKeydown);

void init();
