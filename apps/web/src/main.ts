/**
 * Browser TTS — dual-engine: Kokoro ONNX (FP16/Q4) + Piper ONNX.
 *
 * Kokoro: 82M params, 24 kHz, ~8 languages, 28 voices, Apache 2.0.
 *   FP16 ~163 MB (recommended, better quality), Q4 ~86 MB (mobile).
 *   G2P: misaki English dict (Apache 2.0, GPL-free; no espeak-ng used).
 *
 * Piper: VITS-based, 22.05 kHz, 50+ languages, 100+ voices, MIT.
 *   ~50–75 MB per voice (downloaded on first use, cached in OPFS).
 *   Phonemizer: espeak-ng WASM bundled (GPLv3 — see docs/LICENSING.md).
 */

import { KokoroTTS, type GenerateOptions } from "kokoro-js";
// @ts-expect-error — @zahid0/piper-tts-web has mismatched types (d.ts exports from index, actual JS entry is piper-tts-web.js)
import Piper from "@zahid0/piper-tts-web";

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

// ── Types ───────────────────────────────────────────────────────────
type EngineId = "kokoro-fp16" | "kokoro-q4" | "piper";
type VoiceInfo = { id: string; name: string; language: string };

interface EngineState {
  id: EngineId;
  label: string;
  ready: boolean;
  voices: VoiceInfo[];
}

// ── State ───────────────────────────────────────────────────────────
let kokoroFP16: KokoroTTS | null = null;
let kokoroQ4: KokoroTTS | null = null;
let currentWav: Blob | null = null;
let currentEngine: EngineId = "kokoro-fp16";
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

const engines = new Map<EngineId, EngineState>([
  ["kokoro-fp16", { id: "kokoro-fp16", label: "Kokoro FP16 (163 MB · best quality)", ready: false, voices: [] }],
  ["kokoro-q4", { id: "kokoro-q4", label: "Kokoro Q4 (86 MB · fast)", ready: false, voices: [] }],
  ["piper", { id: "piper", label: "Piper (50+ langs · MIT license)", ready: false, voices: [] }],
]);

// ── Helpers ─────────────────────────────────────────────────────────
function showProgress(msg: string): void {
  progressEl.textContent = msg;
}
function showError(msg: string): void {
  errorEl.textContent = msg;
  errorEl.classList.add("visible");
}
function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.remove("visible");
}
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
      | { requestAdapter?: () => Promise<unknown> }
      | undefined;
    const adapter = gpu?.requestAdapter ? await gpu.requestAdapter() : null;
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

// ── Kokoro loader ───────────────────────────────────────────────────
async function loadKokoro(dtype: "fp16" | "q4"): Promise<KokoroTTS> {
  const cache = dtype === "fp16" ? kokoroFP16 : kokoroQ4;
  if (cache) return cache;

  const device = await probeDevice();
  const size = dtype === "fp16" ? "≈163 MB" : "≈86 MB";
  showProgress(`Loading Kokoro ${dtype.toUpperCase()} (${size}) via ${device.toUpperCase()}…`);

  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype, device });

  if (dtype === "fp16") kokoroFP16 = tts;
  else kokoroQ4 = tts;

  return tts;
}

function kokoroVoices(tts: KokoroTTS): VoiceInfo[] {
  return Object.entries(tts.voices).map(([id, info]) => ({
    id,
    name: info.name,
    language: info.language,
  }));
}

// ── Piper loader ────────────────────────────────────────────────────
interface PiperVoice {
  key: string;
  name: string;
  language: { code: string; name_english: string };
  quality: string;
}

async function loadPiper(): Promise<VoiceInfo[]> {
  showProgress("Loading Piper voice list…");
  const P = Piper as unknown as {
    voices: () => Promise<PiperVoice[]>;
    download: (id: string, cb?: (p: { total: number; loaded: number }) => void) => Promise<void>;
    predict: (cfg: { text: string; voiceId: string }) => Promise<Blob>;
  };
  const allVoices = await P.voices();
  // Prefer English high/medium quality
  const enVoices = allVoices.filter((v) => v.key.startsWith("en_US") || v.key.startsWith("en_GB"));
  const rest = allVoices.filter((v) => !enVoices.includes(v));
  const sorted = [
    ...enVoices.filter((v) => v.quality === "high"),
    ...enVoices.filter((v) => v.quality === "medium"),
    ...enVoices.filter((v) => v.quality === "low"),
    ...rest.filter((v) => v.quality === "high"),
    ...rest.filter((v) => v.quality === "medium"),
  ];
  return sorted.map((v) => ({
    id: v.key,
    name: `${v.name} (${v.language.name_english})`,
    language: v.language.code,
  }));
}

// ── Populate UI ─────────────────────────────────────────────────────
function populateVoiceDropdown(voices: VoiceInfo[]): void {
  voiceSelect.innerHTML = "";
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = `${v.name} (${v.language})`;
    voiceSelect.appendChild(opt);
  }
  // Prefer first "high" or first available
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

  try {
    if (id === "kokoro-fp16") {
      const tts = await loadKokoro("fp16");
      if (!state.ready) { state.voices = kokoroVoices(tts); state.ready = true; }
      populateVoiceDropdown(state.voices);
    } else if (id === "kokoro-q4") {
      const tts = await loadKokoro("q4");
      if (!state.ready) { state.voices = kokoroVoices(tts); state.ready = true; }
      populateVoiceDropdown(state.voices);
    } else if (id === "piper") {
      if (!state.ready) { state.voices = await loadPiper(); state.ready = true; }
      populateVoiceDropdown(state.voices);
    }
    showProgress("Ready. Type text and click Generate.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error.";
    showError(`Engine load failed: ${msg}`);
  } finally {
    setBusy(false);
  }
}

// ── Generate ────────────────────────────────────────────────────────
async function onGenerate(): Promise<void> {
  clearError();
  const text = textInput.value.trim();
  if (!text) { showError("Please enter some text."); return; }

  setBusy(true);
  showProgress("Generating…");

  try {
    let wavBuffer: ArrayBuffer;
    const id = currentEngine;

    if (id === "kokoro-fp16" || id === "kokoro-q4") {
      const dtype = id === "kokoro-fp16" ? "fp16" : "q4";
      const tts = await loadKokoro(dtype);
      const voice = (voiceSelect.value || undefined) as GenerateOptions["voice"];
      const rawAudio = await tts.generate(text, { voice });
      wavBuffer = rawAudio.toWav();
    } else {
      // Piper
      const P = Piper as unknown as {
        download: (id: string, cb?: (p: { total: number; loaded: number }) => void) => Promise<void>;
        predict: (cfg: { text: string; voiceId: string }) => Promise<Blob>;
      };
      const voiceId = voiceSelect.value;
      showProgress("Downloading Piper voice model (first time only)…");
      await P.download(voiceId, (p) => {
        if (p.total > 0) showProgress(`Downloading voice… ${Math.round((p.loaded / p.total) * 100)}%`);
      });
      showProgress("Synthesizing with Piper…");
      const blob = await P.predict({ text, voiceId });
      wavBuffer = await blob.arrayBuffer();
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
  } finally {
    setBusy(false);
  }
}

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

// ── Init ────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  engineSelect.innerHTML = "";
  for (const [id, state] of engines) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = state.label;
    engineSelect.appendChild(opt);
  }
  engineSelect.value = "kokoro-fp16";

  try {
    await onEngineSwitch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error.";
    showError(`Startup failed: ${msg}`);
    generateBtn.disabled = true;
  }
}

// ── Events ──────────────────────────────────────────────────────────
engineSelect.addEventListener("change", onEngineSwitch);
generateBtn.addEventListener("click", onGenerate);
downloadBtn.addEventListener("click", onDownload);

init();
