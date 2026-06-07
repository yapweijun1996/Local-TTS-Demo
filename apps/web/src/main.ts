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
} from "./engines/kokoro.js";
import {
  getPiper,
  loadPiperVoices,
  resetPiperCache,
  piperGenerate,
  PIPER_RESET_FLAG,
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
} from "./ui.js";
import type { VoiceInfo } from "./ui.js";

// ── Types ─────────────────────────────────────────────────────────────
type EngineId = "kokoro-fp32" | "kokoro-fp16" | "kokoro-q4" | "piper";

interface EngineState {
  id: EngineId;
  label: string;
  ready: boolean;
  voices: VoiceInfo[];
}

// ── State ─────────────────────────────────────────────────────────────
let currentWav: Blob | null = null;
let currentEngine: EngineId = "kokoro-fp16";

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

// ── Engine switch ─────────────────────────────────────────────────────
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
  } catch (e) {
    showError(
      `Engine load failed: ${e instanceof Error ? e.message : "Unknown error"}`,
    );
  } finally {
    setBusy(false);
  }
}

// ── Generate ──────────────────────────────────────────────────────────
const MAX_TEXT_LENGTH = 3000;
const CHUNK_SIZE = 480;

async function onGenerate(): Promise<void> {
  clearError();
  setBusy(true);

  try {
    // 1. Validate via @local-tts/core (shared with future API)
    const text = validateText(textInput.value, { maxLength: MAX_TEXT_LENGTH });
    const id = currentEngine;

    // 2. Synthesize
    let wavBuffer: ArrayBuffer;
    if (id.startsWith("kokoro-")) {
      const dtype = id.replace("kokoro-", "") as KokoroDtype;
      const tts = await loadKokoro(dtype);
      const voice = voiceSelect.value || undefined;
      const chunks =
        text.length > CHUNK_SIZE ? segmentText(text, CHUNK_SIZE) : [text];
      wavBuffer = await kokoroGenerate(
        tts,
        voice as Parameters<typeof kokoroGenerate>[1],
        chunks,
      );
    } else {
      wavBuffer = await piperGenerate(text, voiceSelect.value, false);
    }

    // 3. Display audio
    const blob = new Blob([wavBuffer], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    if (audioPlayer.src) URL.revokeObjectURL(audioPlayer.src);
    audioPlayer.src = url;
    playerRow.style.display = "block";
    currentWav = blob;
    downloadRow.classList.add("visible");
    showProgress("✅ Done!");
  } catch (e) {
    if (e instanceof TtsError) {
      showError(e.message);
    } else {
      showError(
        `Generation failed: ${e instanceof Error ? e.message : "Unknown error."}`,
      );
    }
    showProgress("");
  } finally {
    setBusy(false);
    showBar(null);
  }
}

// ── Download ──────────────────────────────────────────────────────────
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

// ── Service worker: COOP/COEP (cross-origin isolation) + app-shell cache ────
// On a static host (GitHub Pages) we cannot set COOP/COEP headers, so the SW
// injects them. The very first page load is NOT yet isolated; once the SW takes
// control we reload once so SharedArrayBuffer / multithreaded WASM become
// available.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("sw.js")
    .then((reg) => {
      if (
        !self.crossOriginIsolated &&
        reg.active &&
        !navigator.serviceWorker.controller
      ) {
        window.location.reload();
      }
    })
    .catch(() => {});
}

// ── Init ──────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  // If a previous cache clear was blocked by OPFS locks, the page reloaded with
  // this flag set. Now (clean load, no Piper handle open yet) flush succeeds.
  if (sessionStorage.getItem(PIPER_RESET_FLAG)) {
    sessionStorage.removeItem(PIPER_RESET_FLAG);
    try {
      await getPiper().flush();
      showProgress("Piper cache cleared.");
    } catch {
      /* already released or empty */
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
    showError(
      `Startup failed: ${e instanceof Error ? e.message : "Unknown error"}`,
    );
    generateBtn.disabled = true;
  }
}

// ── Events ────────────────────────────────────────────────────────────
engineSelect.addEventListener("change", onEngineSwitch);
generateBtn.addEventListener("click", onGenerate);
downloadBtn.addEventListener("click", onDownload);
resetPiperBtn.addEventListener("click", resetPiperCache);
init();
