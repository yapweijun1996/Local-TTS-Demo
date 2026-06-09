/**
 * Browser TTS — controller.
 *
 * Wires UI events → engine adapters (Kokoro / Piper) → audio output.
 * Validation and text segmentation are delegated to @local-tts/core so the
 * browser app and the future Node API share identical text-handling behavior.
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
import type { KokoroDtype } from "./engines/kokoro.js";
import {
  loadKokoro,
  kokoroVoices,
  type KokoroChunkStats,
} from "./engines/kokoro.js";
import {
  getPiper,
  loadPiperVoices,
  resetPiperCache,
  PIPER_RESET_FLAG,
  type PiperChunkStats,
} from "./engines/piper.js";
import {
  textInput,
  voiceSelect,
  engineSelect,
  generateBtn,
  cancelBtn,
  audioPlayer,
  playerRow,
  downloadBtn,
  downloadRow,
  resetPiperBtn,
  showProgress,
  showError,
  clearError,
  setBusy,
  showBar,
  populateVoiceDropdown,
  appendDebugLog,
  clearDebugLog,
  setDebugStatus,
  copyDebugLog,
  copyDebugLogBtn,
  clearDebugLogBtn,
} from "./ui.js";
import type { VoiceInfo } from "./ui.js";

// Engine IDs and shared chunk logging types.
type EngineId = "kokoro-fp32" | "kokoro-fp16" | "kokoro-q4" | "piper";
type ChunkStats = KokoroChunkStats | PiperChunkStats;

interface EngineState {
  id: EngineId;
  label: string;
  ready: boolean;
  voices: VoiceInfo[];
}

function summarizeText(input: string, maxLen = 140): string {
  const flat = input.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen)}...`;
}

function logChunkStats(engine: string, stats: ChunkStats): void {
  const amp = Number.isFinite(stats.maxAmplitude) ? stats.maxAmplitude : 0;
  const ampLabel = amp <= 0 ? "SILENT" : `maxAmp=${amp.toFixed(6)}`;
  const retryLabel =
    "silentRetries" in stats && stats.silentRetries > 0
      ? ` retries=${stats.silentRetries}`
      : "";
  appendDebugLog(
    `[${engine}] chunk ${stats.chunkIndex}/${stats.totalChunks} textLen=${stats.text.length} sampleRate=${stats.sampleRate} samples=${stats.sampleCount} ${ampLabel}${retryLabel} text="${summarizeText(
      stats.text,
    )}"`,
  );
}

function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds <= 0) return "1s";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function clearCurrentWav(): void {
  if (!audioPlayer) return;
  if (!audioPlayer.paused) audioPlayer.pause();
  if (audioPlayer.src) {
    URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }
  playerRow.style.display = "none";
  downloadRow.classList.remove("visible");
  currentWav = null;
}

type WorkerRequestMessage =
  | {
      type: "generate";
      runId: number;
      engine: EngineId;
      text: string;
      voice: string;
    };

type WorkerProgressMessage = {
  type: "progress";
  runId: number;
  message: string;
  pct?: number | null;
};

type WorkerChunkMessage = {
  type: "chunk";
  runId: number;
  engine: EngineId;
  stats: ChunkStats;
};

type WorkerLogMessage = {
  type: "log";
  runId: number;
  message: string;
};

type WorkerDoneMessage = {
  type: "done";
  runId: number;
  wavBuffer: ArrayBuffer;
};

type WorkerErrorMessage = {
  type: "error";
  runId: number;
  message: string;
};

type WorkerAbortedMessage = {
  type: "aborted";
  runId: number;
};

type WorkerResponseMessage =
  | WorkerProgressMessage
  | WorkerChunkMessage
  | WorkerLogMessage
  | WorkerDoneMessage
  | WorkerErrorMessage
  | WorkerAbortedMessage;

interface WorkerGenerationJob {
  resolve: (wav: ArrayBuffer) => void;
  reject: (reason: unknown) => void;
  onChunk: (stats: ChunkStats) => void;
}

// State
let currentWav: Blob | null = null;
let currentEngine: EngineId = "kokoro-fp16";
let generationRunId = 0;
let activeRunId = 0;

const engines = new Map<EngineId, EngineState>([
  [
    "kokoro-fp32",
    {
      id: "kokoro-fp32",
      label: "Kokoro FP32 (326 MB · studio quality)",
      ready: false,
      voices: [],
    },
  ],
  [
    "kokoro-fp16",
    {
      id: "kokoro-fp16",
      label: "Kokoro FP16 (163 MB · best balance)",
      ready: false,
      voices: [],
    },
  ],
  [
    "kokoro-q4",
    {
      id: "kokoro-q4",
      label: "Kokoro Q4 (86 MB · fast)",
      ready: false,
      voices: [],
    },
  ],
  [
    "piper",
    {
      id: "piper",
      label: "Piper (50+ langs · MIT license)",
      ready: false,
      voices: [],
    },
  ],
]);

let ttsWorker: Worker | null = null;
const workerJobs = new Map<number, WorkerGenerationJob>();
const CANCELLED_ERROR = "Generation cancelled.";

function createProgressPoster(runId: number): (message: string, pct?: number | null) => void {
  return (message, pct) => {
    if (runId !== generationRunId) return;
    showProgress(message);
    if (pct === null) {
      showBar(null);
    } else if (typeof pct === "number") {
      showBar(pct);
    }
  };
}

function getWorker(): Worker {
  if (ttsWorker) return ttsWorker;
  ttsWorker = new Worker(new URL("./ttsWorker.ts", import.meta.url), { type: "module" });
  ttsWorker.addEventListener("message", onTtsWorkerMessage);
  ttsWorker.addEventListener("error", onTtsWorkerError);
  return ttsWorker;
}

function onTtsWorkerMessage(event: MessageEvent<WorkerResponseMessage>): void {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  const job = workerJobs.get(msg.runId);

  switch (msg.type) {
    case "progress": {
      if (msg.runId !== generationRunId) return;
      showProgress(msg.message);
      if (msg.pct === null) {
        showBar(null);
      } else if (typeof msg.pct === "number") {
        showBar(msg.pct);
      }
      break;
    }
    case "log":
      appendDebugLog(`[worker] ${msg.message}`);
      break;
    case "chunk": {
      if (msg.runId !== generationRunId) return;
      if (job) {
        job.onChunk(msg.stats);
      }
      break;
    }
    case "done": {
      workerJobs.delete(msg.runId);
      if (!job || msg.runId !== generationRunId) return;
      job.resolve(msg.wavBuffer);
      break;
    }
    case "error": {
      workerJobs.delete(msg.runId);
      if (!job || msg.runId !== generationRunId) return;
      job.reject(new Error(msg.message || "Generation failed in worker"));
      break;
    }
    case "aborted": {
      workerJobs.delete(msg.runId);
      if (!job || msg.runId !== generationRunId) return;
      job.reject(new Error(CANCELLED_ERROR));
      break;
    }
    default:
      break;
  }
}

function onTtsWorkerError(event: ErrorEvent): void {
  appendDebugLog(`[worker] runtime error: ${event.message}`);
  for (const [runId, job] of workerJobs) {
    job.reject(new Error(event.message || "Worker runtime error"));
    workerJobs.delete(runId);
  }
}

function setGeneratingState(active: boolean): void {
  cancelBtn.disabled = !active;
  cancelBtn.style.display = active ? "inline-block" : "none";
}

function startWorkerGenerate(
  runId: number,
  engine: EngineId,
  text: string,
  voice: string,
  onChunk: (stats: ChunkStats) => void,
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
      } satisfies WorkerRequestMessage);
    } catch (e) {
      workerJobs.delete(runId);
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
  if (ttsWorker) {
    ttsWorker.postMessage({ type: "cancel", runId });
  }
}

function onCancelGenerate(): void {
  if (!activeRunId) return;
  cancelWorkerRun(activeRunId);
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
      const tts = await loadKokoro(dtype, createProgressPoster(generationRunId));
      if (!state.ready) {
        state.voices = kokoroVoices(tts);
        state.ready = true;
      }
      populateVoiceDropdown(state.voices);
    } else if (id === "piper") {
      if (!state.ready) {
        state.voices = await loadPiperVoices(createProgressPoster(generationRunId));
        state.ready = true;
      }
      populateVoiceDropdown(state.voices);
    }
    showProgress("Ready. Type text and click Generate.");
    appendDebugLog(`[engine-switch] selected ${id}`);
  } catch (e) {
    showError(`Engine load failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    appendDebugLog(`[engine-switch] failed ${id} => ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setBusy(false);
    showBar(null);
  }
}

// Generate.
// ~20k chars covers ~3000 English words (avg ~6 chars/word incl. space) with
// headroom. Both engines chunk internally (segmentText → per-chunk synth →
// concat), so length is bounded by patience/RAM, not a single-call truncation.
const MAX_TEXT_LENGTH = 20000;
const CHUNK_SIZE = 480;

async function onGenerate(): Promise<void> {
  const prevRunId = generationRunId;
  if (prevRunId > 0) {
    cancelWorkerRun(prevRunId);
  }

  clearError();
  const runId = ++generationRunId;
  activeRunId = runId;
  setBusy(true);
  setGeneratingState(true);
  setDebugStatus("");
  clearDebugLog();
  clearCurrentWav();
  showProgress("Cleared previous output. Regenerating...");
  showBar(0);

  const generationStart = performance.now();
  const generationEngine = currentEngine;
  let totalChunkEstimate = 0;

  const onChunk = (stats: ChunkStats): void => {
    if (runId !== generationRunId) return;
    const chunkCount = stats.chunkIndex;
    totalChunkEstimate = stats.totalChunks;
    logChunkStats(generationEngine, stats);
    const elapsed = performance.now() - generationStart;
    const avg = elapsed / Math.max(1, chunkCount);
    const eta = avg * Math.max(0, totalChunkEstimate - chunkCount);
    const pct = Math.max(0, Math.min(100, Math.round((chunkCount / totalChunkEstimate) * 100)));
    const etaText = eta > 0 ? ` ETA ${formatEta(eta)}` : "";
    showProgress(
      `[${generationEngine}] generating ${chunkCount}/${totalChunkEstimate} chunks (${pct}%).${etaText}`,
    );
    showBar(pct);
  };

  try {
    const text = validateText(textInput.value, { maxLength: MAX_TEXT_LENGTH });
    const id = currentEngine;
    appendDebugLog(`[${id}] generate start len=${text.length}`);
    totalChunkEstimate = Math.max(1, Math.ceil(text.length / CHUNK_SIZE));

    const wavBuffer = await startWorkerGenerate(runId, id, text, voiceSelect.value || "", onChunk);

    if (runId !== generationRunId) return;
    appendDebugLog(`generate done. wavBytes=${wavBuffer.byteLength}`);

    const outputBlob = new Blob([wavBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(outputBlob);
    if (audioPlayer.src) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = url;
    playerRow.style.display = "block";
    currentWav = outputBlob;
    downloadRow.classList.add("visible");
    showBar(100);
    setDebugStatus("Done. Download ready.");
    showProgress(`Done (${Math.round((performance.now() - generationStart) / 1000)}s).`);

    // Persist to IndexedDB history (fire-and-forget; full text saved).
    saveHistoryEntry({
      text,
      engine: id,
      voice: voiceSelect.value || "",
      wavBlob: outputBlob,
      byteLength: wavBuffer.byteLength,
      createdAt: Date.now(),
    }).then(() => refreshHistoryPanel()).catch(() => {});
  } catch (e) {
    if (runId !== generationRunId) return;
    if (e instanceof Error && e.message === CANCELLED_ERROR) {
      setDebugStatus("Generation cancelled.");
      showProgress("Generation cancelled.");
      return;
    }
    setDebugStatus("Generation failed. See log.");
    if (e instanceof TtsError) {
      showError(e.message);
    } else {
      showError(`Generation failed: ${e instanceof Error ? e.message : "Unknown error."}`);
    }
    appendDebugLog(
      `[${currentEngine}] generate failed => ${e instanceof Error ? e.message : "Unknown error"}`,
    );
    showProgress("");
  } finally {
    if (runId !== generationRunId) return;
    setBusy(false);
    setGeneratingState(false);
    if (activeRunId === runId) {
      activeRunId = 0;
    }
    showBar(null);
  }
}

// Download
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
  if (!currentWav) return;
  triggerDownload(currentWav, "tts-output.wav");
}

// -- History panel ----------------------------------------------------------
const historyList = document.getElementById("history-list") as HTMLElement;
const historyClearBtn = document.getElementById("history-clear-btn") as HTMLButtonElement;
const historyEmpty = document.getElementById("history-empty") as HTMLElement;

/** Active object URLs for history playback -- revoked on delete / clear. */
const historyUrls = new Map<number, string>();

/** Escape unsafe HTML characters so user text is safe to embed via innerHTML. */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHistoryEntry(entry: HistoryEntry): HTMLElement {
  const id = entry.id!;
  const item = document.createElement("div");
  item.className = "history-item";
  item.dataset.id = String(id);

  const snippet = entry.text.slice(0, 80).replace(/\s+/g, " ").trim();
  const label = snippet.length < entry.text.length ? `${escHtml(snippet)}…` : escHtml(snippet);

  item.innerHTML = `
    <div class="history-meta">
      <span class="history-time">${escHtml(relativeTime(entry.createdAt))}</span>
      <span class="history-engine">${escHtml(entry.engine)}</span>
      <span class="history-size">${escHtml(formatBytes(entry.byteLength))}</span>
    </div>
    <div class="history-text" title="${escHtml(entry.text)}">${label}</div>
    <div class="history-actions">
      <button class="history-play-btn" aria-label="Play">&#9654; Play</button>
      <button class="history-dl-btn" aria-label="Download">&#8595; Save</button>
      <button class="history-del-btn" aria-label="Delete">&#10005;</button>
    </div>`;

  item.querySelector(".history-play-btn")!.addEventListener("click", () => {
    let url = historyUrls.get(id);
    if (!url) {
      url = URL.createObjectURL(entry.wavBlob);
      historyUrls.set(id, url);
    }
    if (audioPlayer.src) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = url;
    playerRow.style.display = "block";
    audioPlayer.play().catch(() => {});
  });

  item.querySelector(".history-dl-btn")!.addEventListener("click", () => {
    const ts = new Date(entry.createdAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    triggerDownload(entry.wavBlob, `tts-${ts}.wav`);
  });

  item.querySelector(".history-del-btn")!.addEventListener("click", async () => {
    const url = historyUrls.get(id);
    if (url) { URL.revokeObjectURL(url); historyUrls.delete(id); }
    await deleteHistoryEntry(id);
    item.remove();
    const remaining = historyList.querySelectorAll(".history-item").length;
    if (remaining === 0) historyEmpty.style.display = "block";
  });

  return item;
}

async function refreshHistoryPanel(): Promise<void> {
  const [entries, usedBytes] = await Promise.all([listHistory(), totalStorageBytes()]);

  // Update storage-used label.
  const storageEl = document.getElementById("history-storage-used");
  if (storageEl) {
    const limitMB = MAX_DB_BYTES / (1024 * 1024);
    storageEl.textContent = `${formatBytes(usedBytes)} / ${limitMB} MB`;
  }

  historyList.innerHTML = "";
  historyUrls.forEach((url) => URL.revokeObjectURL(url));
  historyUrls.clear();
  if (entries.length === 0) {
    historyEmpty.style.display = "block";
    return;
  }
  historyEmpty.style.display = "none";
  for (const entry of entries) {
    historyList.appendChild(renderHistoryEntry(entry));
  }
}

async function onHistoryClear(): Promise<void> {
  historyUrls.forEach((url) => URL.revokeObjectURL(url));
  historyUrls.clear();
  await clearHistory();
  historyList.innerHTML = "";
  historyEmpty.style.display = "block";
}

async function onCopyDebugLog(): Promise<void> {
  try {
    await copyDebugLog();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    showError(`Failed to copy debug log: ${msg}`);
    setDebugStatus("Copy failed.");
  }
}

async function onResetPiperCache(): Promise<void> {
  try {
    await resetPiperCache(createProgressPoster(generationRunId));
  } catch {
    // keep no-op: reset errors are already surfaced by resetPiperCache.
  }
}

// Service worker: COOP/COEP (cross-origin isolation) + app-shell cache
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

// Init
async function init(): Promise<void> {
  if (sessionStorage.getItem(PIPER_RESET_FLAG)) {
    sessionStorage.removeItem(PIPER_RESET_FLAG);
    try {
      await getPiper().flush();
      showProgress("Piper cache cleared.");
    } catch {
      // already released or empty
    }
  }

  engineSelect.innerHTML = "";
  for (const [, state] of engines) {
    const opt = document.createElement("option");
    opt.value = state.id;
    opt.textContent = state.label;
    engineSelect.appendChild(opt);
  }
  engineSelect.value = "kokoro-fp16";
  resetPiperBtn.style.display = "none";

  try {
    await onEngineSwitch();
  } catch (e) {
    showError(`Startup failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    generateBtn.disabled = true;
  }

  // Load persisted history into the panel (non-blocking).
  void refreshHistoryPanel();
}

engineSelect.addEventListener("change", onEngineSwitch);
generateBtn.addEventListener("click", onGenerate);
cancelBtn.addEventListener("click", onCancelGenerate);
downloadBtn.addEventListener("click", onDownload);
resetPiperBtn.addEventListener("click", onResetPiperCache);
copyDebugLogBtn.addEventListener("click", onCopyDebugLog);
clearDebugLogBtn.addEventListener("click", () => {
  clearDebugLog();
  setDebugStatus("Debug log cleared.");
});
historyClearBtn.addEventListener("click", onHistoryClear);

init();
