/// <reference lib="webworker" />

import { segmentText, segmentByLanguage, validateText, resampleLinear, concatFloat32, encodeWav } from "@local-tts/core";
import type { ProgressDetail, ProgressReporter, VoiceInfo } from "./ui.js";
import type { KokoroDtype } from "./engines/kokoro.js";
import {
  loadKokoro,
  kokoroVoices,
  safeDevice,
  generateSegment,
  kokoroGenerate,
  type KokoroChunkStats,
} from "./engines/kokoro.js";
import {
  piperGenerate,
  loadPiperVoices,
  flushPiperCache,
  ensurePiperVoice,
  piperGenerateSegment,
  type PiperChunkStats,
} from "./engines/piper.js";

type EngineId = "kokoro-fp32" | "kokoro-fp16" | "kokoro-q4" | "piper" | "mixed";
type ChunkStats = KokoroChunkStats | PiperChunkStats;

interface GenerateMessage {
  type: "generate";
  runId: number;
  engine: EngineId;
  text: string;
  voice: string;
  /** Piper voice id for Mandarin runs. Only used when `engine === "mixed"`. */
  zhVoice?: string;
}

interface CancelMessage {
  type: "cancel";
  runId: number;
}

/**
 * Load an engine and hand back its voice list.
 *
 * The worker is the ONLY place a model is loaded. The main thread used to call
 * loadKokoro() itself just to read the voice list, which -- because a worker is
 * a separate module realm with its own caches -- downloaded, compiled and
 * retained the model a second time. Voices now come back over this message.
 */
interface PrepareMessage {
  type: "prepare";
  runId: number;
  engine: EngineId;
}

/** Clear cached Piper voices from OPFS. The worker holds the OPFS handles. */
interface ResetPiperMessage {
  type: "reset-piper";
  runId: number;
}

type WorkerMessage = GenerateMessage | CancelMessage | PrepareMessage | ResetPiperMessage;

type WorkerResponse =
  | { type: "progress"; runId: number; message: string; pct?: number | null; detail?: ProgressDetail }
  | {
      type: "prepared";
      runId: number;
      voices: VoiceInfo[];
      zhVoices?: VoiceInfo[];
      /** Actual compute device chosen for this engine, e.g. "WASM" / "WEBGPU". */
      device: string;
      sampleRate: number;
    }
  | { type: "reset-piper-done"; runId: number; locked: boolean }
  | { type: "log"; runId: number; message: string }
  | { type: "chunk"; runId: number; engine: EngineId; stats: ChunkStats }
  | { type: "done"; runId: number; wavBuffer: ArrayBuffer }
  | { type: "error"; runId: number; message: string }
  | { type: "aborted"; runId: number };

const MAX_TEXT_LENGTH = 20000;
const CHUNK_SIZE = 480;
const activeRuns = new Set<number>();

function isActive(runId: number): boolean {
  return activeRuns.has(runId);
}

function assertActive(runId: number): void {
  if (!isActive(runId)) {
    throw new Error("Generation cancelled.");
  }
}

function summarizeText(input: string, maxLen = 140): string {
  const flat = input.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen)}...`;
}

function postResponse(msg: WorkerResponse): void {
  const payload = msg;
  if (msg.type === "done") {
    (self as DedicatedWorkerGlobalScope).postMessage(payload, [msg.wavBuffer]);
    return;
  }
  (self as DedicatedWorkerGlobalScope).postMessage(payload);
}

function postProgress(
  runId: number,
  message: string,
  pct?: number | null,
  detail?: ProgressDetail,
): void {
  postResponse({ type: "progress", runId, message, pct, detail });
}

function postLog(runId: number, message: string): void {
  postResponse({ type: "log", runId, message });
}

function postChunk(runId: number, engine: EngineId, stats: ChunkStats): void {
  postResponse({ type: "chunk", runId, engine, stats });
}

function postDone(runId: number, wavBuffer: ArrayBuffer): void {
  postResponse({ type: "done", runId, wavBuffer });
}

function postError(runId: number, message: string): void {
  postResponse({ type: "error", runId, message });
}

function postAborted(runId: number): void {
  postResponse({ type: "aborted", runId });
}

/**
 * Load an engine and report its voices. Idempotent: the engine adapters cache
 * their loaded models, so re-preparing an already-loaded engine is a near
 * no-op and safe to call on every engine switch.
 */
async function prepareEngine(runId: number, engine: EngineId): Promise<void> {
  const report: ProgressReporter = (message, pct, detail) =>
    postProgress(runId, message, pct, detail);

  let voices: VoiceInfo[] = [];
  let zhVoices: VoiceInfo[] | undefined;
  let device = "WASM";
  let sampleRate = 24000;

  if (engine.startsWith("kokoro-")) {
    const dtype = engine.replace("kokoro-", "") as KokoroDtype;
    device = (await safeDevice(dtype)).toUpperCase();
    voices = kokoroVoices(await loadKokoro(dtype, report));
  } else if (engine === "piper") {
    voices = await loadPiperVoices(report);
    sampleRate = 22050;
  } else if (engine === "mixed") {
    device = (await safeDevice(MIXED_KOKORO_DTYPE)).toUpperCase();
    voices = kokoroVoices(await loadKokoro(MIXED_KOKORO_DTYPE, report));
    const allPiper = await loadPiperVoices(report);
    zhVoices = allPiper.filter((v) => v.language?.toLowerCase().startsWith("zh"));
    sampleRate = MIXED_OUTPUT_RATE;
  } else {
    throw new Error(`Unsupported engine: ${engine}`);
  }

  postResponse({ type: "prepared", runId, voices, zhVoices, device, sampleRate });
}

async function generateWithKokoro(
  runId: number,
  payload: GenerateMessage,
  text: string,
): Promise<void> {
  assertActive(runId);
  const dtype = payload.engine.replace("kokoro-", "") as KokoroDtype;
  const voice = payload.voice || undefined;
  postProgress(runId, `engine selected=${payload.engine}`);
  const tts = await loadKokoro(dtype, (message, pct, detail) => postProgress(runId, message, pct, detail));
  assertActive(runId);
  const chunks = text.length > CHUNK_SIZE ? segmentText(text, CHUNK_SIZE) : [text];
  postLog(runId, `prepared ${chunks.length} chunk(s).`);
  chunks.forEach((chunk, i) => {
    postLog(
      runId,
      `input chunk ${i + 1}/${chunks.length} len=${chunk.length} text="${summarizeText(chunk)}"`,
    );
  });
  const wavBuffer = await kokoroGenerate(
    tts,
    voice as Parameters<typeof kokoroGenerate>[1],
    chunks,
    (stats) => {
      assertActive(runId);
      postChunk(runId, payload.engine, stats);
    },
    (message, pct, detail) => postProgress(runId, message, pct, detail),
  );
  assertActive(runId);
  postDone(runId, wavBuffer);
}

async function generateWithPiper(runId: number, payload: GenerateMessage, text: string): Promise<void> {
  assertActive(runId);
  const voiceId = payload.voice || "";
  if (!voiceId) {
    throw new Error("Please select a Piper voice.");
  }
  const wavBuffer = await piperGenerate(
    text,
    voiceId,
    false,
    (stats) => {
      assertActive(runId);
      postChunk(runId, payload.engine, stats);
    },
    (message, pct, detail) => postProgress(runId, message, pct, detail),
  );
  assertActive(runId);
  postDone(runId, wavBuffer);
}

// -- Mixed Mandarin/English ---------------------------------------------
// Kokoro has no Mandarin G2P, so the English half always runs on Kokoro and
// the Mandarin half always runs on Piper. Q4 is the fastest Kokoro dtype and
// is CPU-safe at every dtype (see engines/kokoro.ts safeDevice), so it's the
// fixed choice for the mixed English voice -- there is no dtype selector in
// mixed mode. Output is standardized on Kokoro's 24 kHz rate; Piper segments
// (22.05 kHz) are upsampled via resampleLinear before concatenation, since a
// WAV has exactly one sample rate for its whole data chunk.
const MIXED_KOKORO_DTYPE: KokoroDtype = "q4";
const MIXED_OUTPUT_RATE = 24000;

function peakAmplitude(samples: Float32Array): number {
  let max = 0;
  for (const v of samples) {
    const abs = Math.abs(v);
    if (abs > max) max = abs;
  }
  return max;
}

async function generateWithMixed(runId: number, payload: GenerateMessage, text: string): Promise<void> {
  assertActive(runId);
  const enVoice = payload.voice || undefined;
  const zhVoiceId = payload.zhVoice || "";
  if (!zhVoiceId) {
    throw new Error("Please select a Mandarin (Piper) voice for mixed mode.");
  }

  postProgress(runId, "engine selected=mixed (Kokoro EN + Piper ZH)");
  const tts = await loadKokoro(MIXED_KOKORO_DTYPE, (message, pct, detail) => postProgress(runId, message, pct, detail));
  assertActive(runId);
  await ensurePiperVoice(zhVoiceId, (message, pct, detail) => postProgress(runId, message, pct, detail));
  assertActive(runId);

  // Route each script run through the right engine, sub-chunking long runs
  // the same way single-engine generation does (CHUNK_SIZE bound per call).
  const languageSegments = segmentByLanguage(text);
  const routed: Array<{ lang: "en" | "zh"; text: string }> = [];
  for (const seg of languageSegments) {
    const pieces = seg.text.length > CHUNK_SIZE ? segmentText(seg.text, CHUNK_SIZE) : [seg.text];
    for (const piece of pieces) {
      if (piece.trim().length > 0) routed.push({ lang: seg.lang, text: piece });
    }
  }
  if (routed.length === 0) {
    throw new Error("No speakable text after language segmentation.");
  }
  postLog(runId, `mixed: ${routed.length} routed segment(s) from ${languageSegments.length} language run(s).`);

  const parts: Float32Array[] = [];
  for (let i = 0; i < routed.length; i++) {
    assertActive(runId);
    const piece = routed[i]!;
    postProgress(runId, `Generating mixed [${piece.lang}] sentence ${i + 1}/${routed.length}...`);

    let audio: Float32Array;
    let sourceRate: number;
    if (piece.lang === "en") {
      const seg = await generateSegment(tts, enVoice as Parameters<typeof kokoroGenerate>[1], piece.text);
      audio = seg.audio;
      sourceRate = seg.sampleRate;
    } else {
      const seg = await piperGenerateSegment(piece.text, zhVoiceId);
      audio = seg.samples;
      sourceRate = seg.sampleRate;
    }
    assertActive(runId);

    const resampled = resampleLinear(audio, sourceRate, MIXED_OUTPUT_RATE);
    postChunk(runId, payload.engine, {
      chunkIndex: i + 1,
      totalChunks: routed.length,
      text: `[${piece.lang}] ${piece.text}`,
      sampleRate: MIXED_OUTPUT_RATE,
      sampleCount: resampled.length,
      maxAmplitude: peakAmplitude(resampled),
    });
    parts.push(resampled);
    if (i < routed.length - 1) {
      parts.push(new Float32Array(Math.round(MIXED_OUTPUT_RATE * 0.06)));
    }
  }

  const wavBuffer = encodeWav(concatFloat32(parts), { sampleRate: MIXED_OUTPUT_RATE });
  assertActive(runId);
  postDone(runId, wavBuffer);
}

(self as DedicatedWorkerGlobalScope).onmessage = async (event: MessageEvent<WorkerMessage>): Promise<void> => {
  const message = event.data;
  if (!message) return;

  if (message.type === "cancel") {
    const wasActive = activeRuns.delete(message.runId);
    if (wasActive) {
      postAborted(message.runId);
    }
    return;
  }

  if (message.type === "prepare") {
    try {
      await prepareEngine(message.runId, message.engine);
    } catch (e) {
      postError(message.runId, e instanceof Error ? e.message : "Unknown error");
    }
    return;
  }

  if (message.type === "reset-piper") {
    try {
      const { locked } = await flushPiperCache((m, p, d) =>
        postProgress(message.runId, m, p, d),
      );
      postResponse({ type: "reset-piper-done", runId: message.runId, locked });
    } catch (e) {
      postError(message.runId, e instanceof Error ? e.message : "Unknown error");
    }
    return;
  }

  if (message.type !== "generate") return;

  activeRuns.add(message.runId);
  try {
    const text = validateText(message.text, { maxLength: MAX_TEXT_LENGTH });
    if (message.engine.startsWith("kokoro-")) {
      await generateWithKokoro(message.runId, message, text);
    } else if (message.engine === "piper") {
      postLog(message.runId, "Preparing Piper chunks (chunk size is 480 inside engine).");
      await generateWithPiper(message.runId, message, text);
    } else if (message.engine === "mixed") {
      await generateWithMixed(message.runId, message, text);
    } else {
      throw new Error(`Unsupported engine: ${message.engine}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message === "Generation cancelled.") {
      postAborted(message.runId);
    } else {
      const msg = e instanceof Error ? e.message : "Unknown error";
      postError(message.runId, msg);
    }
  } finally {
    activeRuns.delete(message.runId);
  }
};
