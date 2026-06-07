/**
 * UI helpers — DOM refs and pure-DOM utility functions.
 *
 * All DOM queries run at module evaluation time (deferred script = DOM ready).
 * Engine modules may import showProgress / showError / showBar to report status.
 */

// ── DOM refs ──────────────────────────────────────────────────────────
export const textInput = document.getElementById("text-input") as HTMLTextAreaElement;
export const voiceSelect = document.getElementById("voice-select") as HTMLSelectElement;
export const engineSelect = document.getElementById("engine-select") as HTMLSelectElement;
export const generateBtn = document.getElementById("generate-btn") as HTMLButtonElement;
export const progressEl = document.getElementById("progress") as HTMLDivElement;
export const progressBar = document.getElementById("dl-progress") as HTMLProgressElement;
export const errorEl = document.getElementById("error") as HTMLDivElement;
export const playerRow = document.getElementById("player-row") as HTMLDivElement;
export const audioPlayer = document.getElementById("audio-player") as HTMLAudioElement;
export const downloadRow = document.getElementById("download-row") as HTMLDivElement;
export const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
export const resetPiperBtn = document.getElementById("reset-piper-btn") as HTMLButtonElement;

// ── Text progress ─────────────────────────────────────────────────────
export function showProgress(msg: string): void {
  progressEl.textContent = msg;
}

// ── Download bar ──────────────────────────────────────────────────────
/** Show/update the download bar (0–100), or pass null to hide it. */
export function showBar(pct: number | null): void {
  if (pct === null) {
    progressBar.style.display = "none";
    return;
  }
  progressBar.style.display = "block";
  progressBar.value = Math.max(0, Math.min(100, pct));
}

// ── Errors ────────────────────────────────────────────────────────────
export function showError(msg: string): void {
  errorEl.textContent = msg;
  errorEl.classList.add("visible");
}

export function clearError(): void {
  errorEl.textContent = "";
  errorEl.classList.remove("visible");
}

// ── Busy state ────────────────────────────────────────────────────────
export function setBusy(busy: boolean): void {
  generateBtn.disabled = busy;
  textInput.disabled = busy;
  voiceSelect.disabled = busy;
  engineSelect.disabled = busy;
  generateBtn.textContent = busy ? "⏳ Generating…" : "⚡ Generate Speech";
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

export function populateVoiceDropdown(voices: VoiceInfo[]): void {
  voiceSelect.innerHTML = "";

  // When voices carry languageLabel (Piper), group by language with <optgroup>.
  // Kokoro only has one language → flat list, backward compatible.
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
      for (const v of items) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = `${v.name} (${v.language})${v.grade ? ` · ${v.grade}` : ""}`;
        g.appendChild(opt);
      }
      voiceSelect.appendChild(g);
    }
  } else {
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.language})${v.grade ? ` · ${v.grade}` : ""}`;
      voiceSelect.appendChild(opt);
    }
  }

  // Default to the most natural voice: Kokoro's af_heart (grade A), then a Piper
  // high-quality English voice, then any grade-A voice, then the first available.
  const preferred =
    voices.find((v) => v.id === "af_heart") ??
    voices.find((v) => v.language?.startsWith("en") && v.id.includes("high")) ??
    voices.find((v) => v.grade === "A") ??
    voices[0];
  if (preferred) voiceSelect.value = preferred.id;
}
