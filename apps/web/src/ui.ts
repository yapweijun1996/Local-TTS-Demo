/**
 * UI layer — DOM refs, the app phase state machine, and pure render helpers.
 *
 * Design contract: the UI never invents state. Every visible label is derived
 * from an explicit `Phase` value, so "downloading" can never render as
 * "generating". Engine modules report progress; only `renderPhase` decides how
 * that looks.
 *
 * All DOM queries run at module evaluation time (module scripts are deferred,
 * so the DOM is parsed). `mustEl` turns a renamed/dropped id into a loud,
 * named error instead of a silent `null` that explodes later — the id set here
 * is a hard contract with index.html.
 */

// ── Element lookup ────────────────────────────────────────────────────
function mustEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`[ui] Missing element #${id} — index.html and ui.ts are out of sync.`);
  }
  return el as T;
}

/** Maximum input length. Mirrored in ttsWorker.ts, which re-validates. */
export const MAX_TEXT_LENGTH = 20000;

// ── DOM refs ──────────────────────────────────────────────────────────
// Header
export const themeLightBtn = mustEl<HTMLButtonElement>("theme-light-btn");
export const themeDarkBtn = mustEl<HTMLButtonElement>("theme-dark-btn");
export const settingsBtn = mustEl<HTMLButtonElement>("settings-btn");

// Compose
export const textInput = mustEl<HTMLTextAreaElement>("text-input");
export const charCount = mustEl<HTMLSpanElement>("char-count");
export const sampleEnBtn = mustEl<HTMLButtonElement>("sample-en-btn");
export const sampleZhBtn = mustEl<HTMLButtonElement>("sample-zh-btn");
export const clearTextBtn = mustEl<HTMLButtonElement>("clear-text-btn");
export const languageSelect = mustEl<HTMLSelectElement>("language-select");
export const voiceSelect = mustEl<HTMLSelectElement>("voice-select");
export const previewBtn = mustEl<HTMLButtonElement>("preview-btn");
export const previewLabel = mustEl<HTMLSpanElement>("preview-label");
export const zhVoiceRow = mustEl<HTMLDivElement>("zh-voice-row");
export const zhVoiceSelect = mustEl<HTMLSelectElement>("zh-voice-select");
export const engineSelect = mustEl<HTMLSelectElement>("engine-select");
export const engineHint = mustEl<HTMLSpanElement>("engine-hint");
export const generateBtn = mustEl<HTMLButtonElement>("generate-btn");
export const generateIcon = mustEl<SVGSVGElement & HTMLElement>("generate-icon");
export const generateLabel = mustEl<HTMLSpanElement>("generate-label");
export const cancelBtn = mustEl<HTMLButtonElement>("cancel-btn");

// Error
const errorEl = mustEl<HTMLDivElement>("error");
const errorTitle = mustEl<HTMLDivElement>("error-title");
const errorHint = mustEl<HTMLDivElement>("error-hint");
export const errorDetailsBtn = mustEl<HTMLButtonElement>("error-details-btn");

// Engine status
const engineBadge = mustEl<HTMLSpanElement>("engine-badge");
const engineBadgeText = mustEl<HTMLSpanElement>("engine-badge-text");
const engineNameEl = mustEl<HTMLParagraphElement>("engine-name");
const engineSubEl = mustEl<HTMLParagraphElement>("engine-sub");
const progressBlock = mustEl<HTMLDivElement>("engine-progress-block");
const progressLabel = mustEl<HTMLSpanElement>("progress-label");
const progressPct = mustEl<HTMLSpanElement>("progress-pct");
const progressBytes = mustEl<HTMLSpanElement>("progress-bytes");
const progressSpeed = mustEl<HTMLSpanElement>("progress-speed");
const progressBar = mustEl<HTMLDivElement>("progress-bar");
const progressFill = mustEl<HTMLDivElement>("progress-fill");
const engineNote = mustEl<HTMLDivElement>("engine-note");
const engineNoteText = mustEl<HTMLSpanElement>("engine-note-text");
const liveStatus = mustEl<HTMLParagraphElement>("live-status");

// Result
const resultBadge = mustEl<HTMLSpanElement>("result-badge");
const resultBadgeText = mustEl<HTMLSpanElement>("result-badge-text");
const resultEmpty = mustEl<HTMLDivElement>("result-empty");
const resultReady = mustEl<HTMLDivElement>("result-ready");
export const audioPlayer = mustEl<HTMLAudioElement>("audio-player");
const resultVoice = mustEl<HTMLElement>("result-voice");
const resultLanguage = mustEl<HTMLElement>("result-language");
const resultDuration = mustEl<HTMLElement>("result-duration");
const resultElapsed = mustEl<HTMLElement>("result-elapsed");
export const downloadBtn = mustEl<HTMLButtonElement>("download-btn");
export const regenerateBtn = mustEl<HTMLButtonElement>("regenerate-btn");

// History
export const historyList = mustEl<HTMLDivElement>("history-list");
export const historyEmpty = mustEl<HTMLDivElement>("history-empty");
export const historyClearBtn = mustEl<HTMLButtonElement>("history-clear-btn");
export const historyStorageUsed = mustEl<HTMLSpanElement>("history-storage-used");

// Advanced
export const advancedPanel = mustEl<HTMLElement>("advanced-panel");
export const advPerformance = mustEl<HTMLDetailsElement>("adv-performance");
export const advCache = mustEl<HTMLDetailsElement>("adv-cache");
export const advLogs = mustEl<HTMLDetailsElement>("adv-logs");
export const perfMeta = mustEl<HTMLSpanElement>("perf-meta");
export const perfEngine = mustEl<HTMLElement>("perf-engine");
export const perfDevice = mustEl<HTMLElement>("perf-device");
export const perfThreads = mustEl<HTMLElement>("perf-threads");
export const perfCoi = mustEl<HTMLElement>("perf-coi");
export const perfRate = mustEl<HTMLElement>("perf-rate");
export const cacheMeta = mustEl<HTMLSpanElement>("cache-meta");
export const cacheUsed = mustEl<HTMLElement>("cache-used");
export const cacheHistory = mustEl<HTMLElement>("cache-history");
export const resetPiperBtn = mustEl<HTMLButtonElement>("reset-piper-btn");
export const kbdGenerate = mustEl<HTMLElement>("kbd-generate");
export const debugLogEl = mustEl<HTMLPreElement>("debug-log");
export const debugStatusEl = mustEl<HTMLSpanElement>("debug-status");
export const copyDebugLogBtn = mustEl<HTMLButtonElement>("copy-debug-log-btn");
export const clearDebugLogBtn = mustEl<HTMLButtonElement>("clear-debug-log-btn");

// ── Formatters ────────────────────────────────────────────────────────
export function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  if (sec < 60) return `${sec.toFixed(1)} sec`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  if (total <= 0) return "1s";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m <= 0 ? `${s}s` : `${m}m ${s.toString().padStart(2, "0")}s`;
}

// ── Theme ─────────────────────────────────────────────────────────────
export type Theme = "light" | "dark";
const THEME_KEY = "local-tts-theme";

const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");

function systemTheme(): Theme {
  return darkQuery?.matches ? "dark" : "light";
}

function syncThemeButtons(theme: Theme): void {
  themeLightBtn.setAttribute("aria-checked", String(theme === "light"));
  themeDarkBtn.setAttribute("aria-checked", String(theme === "dark"));
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  syncThemeButtons(theme);
}

/**
 * With no stored choice, `data-theme` is left UNSET on purpose: the CSS media
 * query then owns the palette and the page keeps following the OS live.
 * Stamping the attribute at boot would pin the theme to whatever the OS said
 * at load time and silently break `prefers-color-scheme`.
 */
export function initTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") {
    applyTheme(stored);
    return;
  }
  delete document.documentElement.dataset.theme;
  syncThemeButtons(systemTheme());
  darkQuery?.addEventListener("change", () => {
    if (!document.documentElement.dataset.theme) syncThemeButtons(systemTheme());
  });
}

// ── Phase state machine ───────────────────────────────────────────────
/** Aggregate byte counters reported while model files download. */
export interface ProgressDetail {
  loadedBytes: number;
  /** Sum of the file sizes discovered SO FAR — it may rise as files are found. */
  totalBytes: number;
  bytesPerSec: number;
  /** True while the total is still growing (more files may yet be discovered). */
  estimating: boolean;
}

/**
 * Shared progress channel for every engine adapter. Declared here so the
 * engines, the worker and the controller all agree on one signature —
 * type-only, so importing it never pulls DOM code into the worker.
 */
export type ProgressReporter = (
  message: string,
  pct?: number | null,
  detail?: ProgressDetail,
) => void;

export type Phase =
  | { kind: "boot" }
  | {
      kind: "engine-loading";
      /** What is actually happening right now, e.g. "Downloading model files". */
      step: string;
      pct: number | null;
      detail?: ProgressDetail;
    }
  // No `fromCache` flag: a cached read still streams through the same progress
  // events as a network fetch, and cross-origin `transferSize` is 0 with or
  // without Timing-Allow-Origin. Provenance is not knowable here, so the UI
  // does not claim it.
  | { kind: "engine-ready" }
  | { kind: "engine-failed" }
  | { kind: "generating"; step: string; pct: number | null; etaMs?: number }
  | { kind: "done"; elapsedMs: number }
  | { kind: "cancelled" };

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** Engine label shown in the status card — set once per engine switch. */
let engineLabel = "—";
let engineDetail = "";
let currentPhase: Phase = { kind: "boot" };

export function setEngineIdentity(label: string, detail: string): void {
  engineLabel = label;
  engineDetail = detail;
  engineNameEl.textContent = label;
  engineSubEl.textContent = detail;
}

export function getPhase(): Phase {
  return currentPhase;
}

function setBadge(el: HTMLElement, textEl: HTMLElement, tone: Tone, text: string): void {
  el.dataset.tone = tone;
  textEl.textContent = text;
}

function setProgress(
  visible: boolean,
  label = "",
  pct: number | null = null,
  detail?: ProgressDetail,
): void {
  progressBlock.hidden = !visible;
  if (!visible) return;

  progressLabel.textContent = label;

  const indeterminate = pct === null;
  progressBar.classList.toggle("is-indeterminate", indeterminate);
  if (indeterminate) {
    progressPct.textContent = "";
    progressBar.removeAttribute("aria-valuenow");
    progressFill.style.width = "";
  } else {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    progressPct.textContent = `${clamped}%`;
    progressBar.setAttribute("aria-valuenow", String(clamped));
    progressFill.style.width = `${clamped}%`;
  }

  if (detail && detail.totalBytes > 0) {
    // An "of N MB" that keeps growing reads as a bug, so say so while files
    // are still being discovered rather than quoting a number we do not know.
    progressBytes.textContent = detail.estimating
      ? `${formatMB(detail.loadedBytes)} downloaded`
      : `${formatMB(detail.loadedBytes)} of ${formatMB(detail.totalBytes)}`;
    progressSpeed.textContent =
      detail.bytesPerSec > 0 ? `${formatMB(detail.bytesPerSec)}/s` : "";
  } else {
    progressBytes.textContent = "";
    progressSpeed.textContent = "";
  }
}

function setNote(tone: Tone, text: string, visible = true): void {
  engineNote.hidden = !visible;
  engineNote.dataset.tone = tone;
  engineNoteText.textContent = text;
}

function setGenerateButton(
  label: string,
  opts: { disabled?: boolean; loading?: boolean } = {},
): void {
  const { disabled = false, loading = false } = opts;
  generateLabel.textContent = label;
  generateBtn.disabled = disabled || loading;
  generateBtn.classList.toggle("is-loading", loading);
  generateBtn.setAttribute("aria-busy", String(loading));

  // Swap the waveform glyph for a spinner while work is in flight.
  const existing = generateBtn.querySelector(".spinner");
  if (loading && !existing) {
    generateIcon.hidden = true;
    const sp = document.createElement("span");
    sp.className = "spinner";
    generateBtn.insertBefore(sp, generateLabel);
  } else if (!loading && existing) {
    existing.remove();
    generateIcon.hidden = false;
  }
}

/** Preview runs its own short synthesis; it must not look like a real run. */
let previewBusy = false;

function phaseAllowsPreview(): boolean {
  const k = currentPhase.kind;
  return k === "engine-ready" || k === "done" || k === "cancelled";
}

/**
 * Preview needs a loaded engine. Disable it *with a reason* rather than
 * leaving an inert control the user cannot explain.
 */
function setPreviewAvailable(): void {
  const ready = phaseAllowsPreview();
  previewBtn.disabled = !ready || previewBusy;
  previewBtn.title = ready
    ? "Play a short sample of this voice"
    : "Available once the engine has finished loading";
}

/**
 * Preview owns only its own button. It deliberately does NOT go through
 * `renderPhase`: a voice sample is not a generation run, and letting it drive
 * the phase machine would make the main button claim "Generating audio…" and
 * strand the result badge on "Generating" after the sample finished.
 */
export function setPreviewBusy(busy: boolean): void {
  previewBusy = busy;
  previewLabel.textContent = busy ? "Previewing…" : "Preview";
  setPreviewAvailable();
}

/**
 * Single source of truth for what the app looks like in each phase.
 *
 * Loading is deliberately NOT styled like disabled: the primary button keeps
 * its brand colour and shows a spinner, so "busy" never reads as "broken".
 */
export function renderPhase(phase: Phase): void {
  currentPhase = phase;
  setPreviewAvailable();

  switch (phase.kind) {
    case "boot":
      setBadge(engineBadge, engineBadgeText, "info", "Starting");
      setProgress(false);
      setNote("info", "Checking browser support…");
      setGenerateButton("Preparing engine…", { loading: true });
      cancelBtn.hidden = true;
      announce("Starting the local speech engine.");
      break;

    case "engine-loading": {
      setBadge(engineBadge, engineBadgeText, "info", "Preparing");
      setProgress(true, phase.step, phase.pct, phase.detail);
      setNote(
        "info",
        "Model files are fetched once and kept in your browser cache — later runs start instantly and work offline.",
      );
      setGenerateButton("Preparing engine…", { loading: true });
      cancelBtn.hidden = true;
      const pctText = phase.pct === null ? "" : ` ${Math.round(phase.pct)} percent.`;
      announce(`${phase.step}.${pctText}`);
      break;
    }

    case "engine-ready":
      setBadge(engineBadge, engineBadgeText, "success", "Ready");
      setProgress(false);
      // "Ready" means the voice list is loaded. The worker keeps its own model
      // instance, so the first generation still finishes a one-time warm-up —
      // say so rather than letting that delay look like a stall.
      setNote(
        "success",
        "Ready — model files stay cached. The first generation also finishes a one-time warm-up.",
      );
      setGenerateButton("Generate Speech");
      cancelBtn.hidden = true;
      announce(`${engineLabel} is ready.`);
      break;

    case "engine-failed":
      setBadge(engineBadge, engineBadgeText, "danger", "Failed");
      setProgress(false);
      setNote("warning", "The engine could not be loaded. See the message on the left.");
      setGenerateButton("Try Again");
      cancelBtn.hidden = true;
      announce("Engine failed to load.");
      break;

    case "generating": {
      setBadge(engineBadge, engineBadgeText, "info", "Generating");
      const eta = phase.etaMs ? formatEta(phase.etaMs) : "";
      setProgress(true, phase.step, phase.pct);
      progressSpeed.textContent = eta ? `about ${eta} left` : "";
      setNote("neutral", "Audio is being synthesised on this device.");
      setGenerateButton("Generating audio…", { loading: true });
      cancelBtn.hidden = false;
      setBadge(resultBadge, resultBadgeText, "info", "Generating");
      announce(phase.step);
      break;
    }

    case "done":
      setBadge(engineBadge, engineBadgeText, "success", "Ready");
      setProgress(false);
      setNote("success", `${engineLabel} is loaded and ready for the next run.`);
      setGenerateButton("Generate Again");
      cancelBtn.hidden = true;
      announce(`Audio ready in ${(phase.elapsedMs / 1000).toFixed(1)} seconds.`);
      break;

    case "cancelled":
      setBadge(engineBadge, engineBadgeText, "success", "Ready");
      setProgress(false);
      setNote("neutral", "Generation cancelled. The engine is still loaded.");
      setGenerateButton("Generate Speech");
      cancelBtn.hidden = true;
      setBadge(resultBadge, resultBadgeText, "neutral", "Waiting");
      announce("Generation cancelled.");
      break;
  }
}

/** Push a message to the screen-reader-only live region. */
function announce(message: string): void {
  liveStatus.textContent = message;
}

/** Lock/unlock the configuration controls while a run is in flight. */
export function setControlsBusy(busy: boolean): void {
  textInput.disabled = busy;
  languageSelect.disabled = busy;
  voiceSelect.disabled = busy;
  zhVoiceSelect.disabled = busy;
  engineSelect.disabled = busy;
  sampleEnBtn.disabled = busy;
  sampleZhBtn.disabled = busy;
  clearTextBtn.disabled = busy;
}

// ── Errors ────────────────────────────────────────────────────────────
export interface UserError {
  /** Short, human-readable statement of what went wrong. */
  title: string;
  /** What the user can do about it. */
  hint?: string;
  /** Raw technical text — kept out of the main message, shown via Advanced. */
  technical?: string;
}

let lastTechnical = "";

export function showError(err: UserError): void {
  errorTitle.textContent = err.title;
  errorHint.textContent = err.hint ?? "";
  errorHint.hidden = !err.hint;
  lastTechnical = err.technical ?? "";
  errorDetailsBtn.hidden = !lastTechnical;
  errorEl.hidden = false;
}

export function clearError(): void {
  errorEl.hidden = true;
  errorTitle.textContent = "";
  errorHint.textContent = "";
  errorDetailsBtn.hidden = true;
  lastTechnical = "";
}

export function getLastTechnical(): string {
  return lastTechnical;
}

/**
 * Map a raw engine/runtime error to something a non-developer can act on.
 * The original message is preserved as `technical` for the debug panel.
 */
export function toUserError(e: unknown, context: "load" | "generate"): UserError {
  const raw = e instanceof Error ? e.message : String(e);
  const lower = raw.toLowerCase();

  if (lower.includes("webgpu") || lower.includes("no available adapter")) {
    return {
      title: "This browser cannot run the selected engine",
      hint: "Your browser lacks the required GPU support. Try a different engine, or use a recent Chrome or Edge.",
      technical: raw,
    };
  }
  if (lower.includes("quota") || lower.includes("storage") || lower.includes("disk")) {
    return {
      title: "Not enough browser storage",
      hint: "Free up space, or clear cached voices under Advanced → Cache Management.",
      technical: raw,
    };
  }
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("failed to load")) {
    return {
      title: "Download failed",
      hint: "Check your connection and try again. Files already downloaded are kept.",
      technical: raw,
    };
  }
  if (lower.includes("voice")) {
    return {
      title: "That voice could not be loaded",
      hint: "Pick a different voice, or clear the voice cache under Advanced.",
      technical: raw,
    };
  }
  return context === "load"
    ? { title: "The speech engine failed to load", hint: "Try again, or pick a different engine.", technical: raw }
    : { title: "Audio generation failed", hint: "Try again, or shorten the text.", technical: raw };
}

// ── Audio result ──────────────────────────────────────────────────────
export interface ResultInfo {
  voice: string;
  language: string;
  durationSec: number;
  elapsedMs: number;
}

export function showResult(url: string, info: ResultInfo): void {
  audioPlayer.src = url;
  resultVoice.textContent = info.voice;
  resultLanguage.textContent = info.language;
  resultDuration.textContent = formatSeconds(info.durationSec);
  resultElapsed.textContent = formatSeconds(info.elapsedMs / 1000);
  resultEmpty.hidden = true;
  resultReady.hidden = false;
  setBadge(resultBadge, resultBadgeText, "success", "Audio ready");
}

export function clearResult(): void {
  resultEmpty.hidden = false;
  resultReady.hidden = true;
  setBadge(resultBadge, resultBadgeText, "neutral", "Waiting");
}

// ── Character counter ─────────────────────────────────────────────────
export function updateCharCount(): void {
  const n = textInput.value.length;
  charCount.textContent = `${n.toLocaleString()} / ${MAX_TEXT_LENGTH.toLocaleString()}`;
  charCount.classList.toggle("is-over", n > MAX_TEXT_LENGTH);
}

// ── Debug log ─────────────────────────────────────────────────────────
const MAX_DEBUG_LINES = 300;
const debugLines: string[] = [];

function renderDebugLines(): void {
  debugLogEl.textContent = debugLines.join("\n");
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

export function appendDebugLog(line: string): void {
  debugLines.push(`${new Date().toISOString()} ${line}`);
  if (debugLines.length > MAX_DEBUG_LINES) {
    debugLines.splice(0, debugLines.length - MAX_DEBUG_LINES);
  }
  renderDebugLines();
}

export function clearDebugLog(): void {
  debugLines.length = 0;
  renderDebugLines();
  debugStatusEl.textContent = "";
}

export function setDebugStatus(message: string): void {
  debugStatusEl.textContent = message;
}

export async function copyDebugLog(): Promise<void> {
  const text = debugLines.join("\n");
  if (!text) return;
  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard API is not available in this browser.");
  }
  await navigator.clipboard.writeText(text);
  setDebugStatus("Copied.");
}

/** Open Advanced → Developer Logs and scroll it into view. */
export function revealDebugLog(): void {
  advLogs.open = true;
  advancedPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Voice dropdown ────────────────────────────────────────────────────
export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  /** Human-readable language name for optgroup labels (Piper). */
  languageLabel?: string;
  grade?: string;
}

/** Kokoro encodes accent + gender in the voice id prefix (af_, am_, bf_, bm_). */
const KOKORO_PREFIX: Record<string, string> = {
  af: "American English · Female",
  am: "American English · Male",
  bf: "British English · Female",
  bm: "British English · Male",
};

/** Build the human-readable descriptor shown next to a voice name. */
export function describeVoice(v: VoiceInfo): string {
  const prefix = KOKORO_PREFIX[v.id.slice(0, 2)];
  if (prefix) return prefix;
  const lang = v.languageLabel ?? v.language ?? "";
  return v.grade ? `${lang} · ${v.grade}` : lang;
}

/**
 * Placeholder shown while an engine loads. An empty, unexplained dropdown is
 * the single loudest "this app is broken" signal, so it always says why.
 */
export function setVoicesLoading(target: HTMLSelectElement = voiceSelect): void {
  target.innerHTML = "";
  const opt = document.createElement("option");
  opt.textContent = "Loading voices…";
  opt.value = "";
  target.appendChild(opt);
  target.disabled = true;
}

export function populateVoiceDropdown(
  voices: VoiceInfo[],
  target: HTMLSelectElement = voiceSelect,
): void {
  target.innerHTML = "";

  if (voices.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No voice available";
    opt.value = "";
    target.appendChild(opt);
    target.disabled = true;
    return;
  }
  target.disabled = false;

  const makeOption = (v: VoiceInfo): HTMLOptionElement => {
    const opt = document.createElement("option");
    opt.value = v.id;
    const desc = describeVoice(v);
    opt.textContent = desc ? `${v.name} · ${desc}` : v.name;
    return opt;
  };

  // Piper voices carry languageLabel → group by language. Kokoro is one
  // language, so it renders as a flat list.
  const useGroups = voices.some((v) => v.languageLabel);
  if (useGroups) {
    const groups = new Map<string, VoiceInfo[]>();
    for (const v of voices) {
      const label = v.languageLabel ?? v.language;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(v);
    }
    for (const [label, items] of groups) {
      const g = document.createElement("optgroup");
      g.label = label;
      for (const v of items) g.appendChild(makeOption(v));
      target.appendChild(g);
    }
  } else {
    for (const v of voices) target.appendChild(makeOption(v));
  }

  // Default to the most natural voice: Kokoro's af_heart (grade A), then a
  // high-quality English Piper voice, then any grade-A voice, then the first.
  const preferred =
    voices.find((v) => v.id === "af_heart") ??
    voices.find((v) => v.language?.startsWith("en") && v.id.includes("high")) ??
    voices.find((v) => v.grade === "A") ??
    voices[0];
  if (preferred) target.value = preferred.id;
}
