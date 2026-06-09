/**
 * Browser TTS — controller.
 *
 * Wires UI events → engine adapters (Kokoro / Piper) → audio output.
 * Validation and text segmentation are delegated to @local-tts/core so the
 * browser app and the future Node API share identical text-handling behavior.
 */

import { validateText, segmentText, TtsError } from "@local-tts/core";
import type { KokoroDtype } from "./engines/kokoro.js";
import {
  loadKokoro,
  kokoroGenerate,
  kokoroVoices,
  type KokoroChunkStats,
} from "./engines/kokoro.js";
import {
  getPiper,
  loadPiperVoices,
  resetPiperCache,
  piperGenerate,
  PIPER_RESET_FLAG,
  type PiperChunkStats,
} from "./engines/piper.js";
import {
  textInput,
  voiceSelect,
  engineSelect,
  generateBtn,
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

// State
let currentWav: Blob | null = null;
let currentEngine: EngineId = "kokoro-fp16";
let generationRunId = 0;

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

// Engine switch.
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
      if (!state.ready) {
        state.voices = kokoroVoices(tts);
        state.ready = true;
      }
      populateVoiceDropdown(state.voices);
    } else if (id === "piper") {
      if (!state.ready) {
        state.voices = await loadPiperVoices();
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
  }
}

// Generate.
// ~20k chars covers ~3000 English words (avg ~6 chars/word incl. space) with
// headroom. Both engines chunk internally (segmentText → per-chunk synth →
// concat), so length is bounded by patience/RAM, not a single-call truncation.
const MAX_TEXT_LENGTH = 20000;
const CHUNK_SIZE = 480;

async function onGenerate(): Promise<void> {
  clearError();
  const runId = ++generationRunId;
  setBusy(true);
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

    let wavBuffer: ArrayBuffer;
    if (id.startsWith("kokoro-")) {
      const dtype = id.replace("kokoro-", "") as KokoroDtype;
      const tts = await loadKokoro(dtype);
      const voice = voiceSelect.value || undefined;
      const chunks = text.length > CHUNK_SIZE ? segmentText(text, CHUNK_SIZE) : [text];
      appendDebugLog(`prepared ${chunks.length} chunk(s).`);
      chunks.forEach((chunk, i) => {
        appendDebugLog(
          `input chunk ${i + 1}/${chunks.length} len=${chunk.length} text="${summarizeText(chunk)}"`,
        );
      });
      totalChunkEstimate = chunks.length;
      appendDebugLog(`engine selected=${id}`);
      wavBuffer = await kokoroGenerate(
        tts,
        voice as Parameters<typeof kokoroGenerate>[1],
        chunks,
        (stats) => {
          onChunk(stats);
        },
      );
    } else {
      appendDebugLog("Preparing Piper chunks (chunk size is 480 inside engine).");
      wavBuffer = await piperGenerate(
        text,
        voiceSelect.value,
        false,
        (stats) => {
          onChunk(stats);
        },
      );
    }

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
  } catch (e) {
    if (runId !== generationRunId) return;
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
    showBar(null);
  }
}

// Download
function onDownload(): void {
  if (!currentWav) return;
  const url = URL.createObjectURL(currentWav);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tts-output.wav";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  for (const [id, state] of engines) {
    const opt = document.createElement("option");
    opt.value = id;
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
}

engineSelect.addEventListener("change", onEngineSwitch);
generateBtn.addEventListener("click", onGenerate);
downloadBtn.addEventListener("click", onDownload);
resetPiperBtn.addEventListener("click", resetPiperCache);
copyDebugLogBtn.addEventListener("click", onCopyDebugLog);
clearDebugLogBtn.addEventListener("click", () => {
  clearDebugLog();
  setDebugStatus("Debug log cleared.");
});

init();
