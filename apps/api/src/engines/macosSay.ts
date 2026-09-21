/**
 * macOS system TTS adapter.
 *
 * This is a local, no-network safety fallback for CJK text on the Mac Mini
 * when an operator explicitly uses an English-only model or disables the
 * commercial-only gate. Production Kokoro v1.1-zh sidecar handles Mandarin and VoxCPM2 remains available as an optional higher-quality sidecar, but its
 * MPS latency can be unsuitable for a durable Podcast worker.  `say` gives
 * the API a bounded, dependable local path while keeping the same WAV
 * contract as the neural engines.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { EngineLicenseMeta, TtsEngine, TtsInput, TtsOutput, TtsVoice } from "@local-tts/core";
import { TtsError, decodeWav, validateText } from "@local-tts/core";

export const MACOS_SAY_LICENSE: EngineLicenseMeta = {
  engine: "macos-say",
  modelName: "macOS system voices",
  license: "System-provided / Apple OS terms",
  commercialUse: false,
  requiresAttribution: false,
  sourceUrl: "https://support.apple.com/guide/mac-help/change-voices-speak-text-mchlp2290/mac",
  verifiedAt: "2026-08-06",
  notes: "Offline macOS fallback. Commercial rights depend on the installed system voice and Apple OS terms; use a licensed neural engine when that matters.",
};

const VOICES: TtsVoice[] = [
  { id: "Tingting", name: "Tingting", language: "zh-CN", engine: "macos-say" },
  { id: "Meijia", name: "Meijia", language: "zh-TW", engine: "macos-say" },
  { id: "Samantha", name: "Samantha", language: "en-US", engine: "macos-say" },
];

function run(command: string, args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new TtsError("GENERATION_FAILED", `${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new TtsError("MODEL_LOAD_FAILED", `${command} is unavailable: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new TtsError("GENERATION_FAILED", `${command} failed${stderr ? `: ${stderr.trim()}` : "."}`));
    });
  });
}

function defaultVoice(language = "") {
  return /^zh-TW/i.test(language) ? "Meijia" : /^zh/i.test(language) ? "Tingting" : "Samantha";
}

export function createMacosSayAdapter(): TtsEngine {
  let loaded = false;

  return {
    id: "macos-say",
    name: "macOS system voice",

    async load() {
      if (process.platform !== "darwin") throw new Error("macOS system voice is only available on Darwin.");
      await run("say", ["-v", "?"]);
      loaded = true;
    },

    async listVoices(): Promise<TtsVoice[]> {
      if (!loaded) throw new Error("macOS system voice is not loaded.");
      return VOICES;
    },

    async synthesize(input: TtsInput): Promise<TtsOutput> {
      if (!loaded) throw new TtsError("MODEL_LOAD_FAILED", "macOS system voice is not loaded.");
      const text = validateText(input.text, { maxLength: 3000 });
      const voice = input.voice || defaultVoice(input.language);
      if (!VOICES.some((item) => item.id === voice)) {
        throw new TtsError("VOICE_NOT_FOUND", `Voice "${voice}" is not available in macOS system voice catalog.`);
      }
      const dir = await mkdtemp(join(tmpdir(), "local-tts-macos-say-"));
      const aiffPath = join(dir, "speech.aiff");
      const wavPath = join(dir, "speech.wav");
      try {
        await run("say", ["-v", voice, "-o", aiffPath, "--", text]);
        await run("ffmpeg", ["-y", "-i", aiffPath, "-ar", "24000", "-ac", "1", "-f", "wav", wavPath]);
        const audioBuffer = await readFile(wavPath);
        const decoded = decodeWav(Uint8Array.from(audioBuffer).buffer);
        return {
          audioBuffer: Uint8Array.from(audioBuffer).buffer,
          mimeType: "audio/wav",
          durationMs: (decoded.samples.length / decoded.sampleRate) * 1000,
        };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
