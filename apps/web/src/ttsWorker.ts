/// <reference lib="webworker" />

import { segmentText, validateText } from "@local-tts/core";
import type { KokoroDtype } from "./engines/kokoro.js";
import {
  loadKokoro,
  kokoroGenerate,
  type KokoroChunkStats,
} from "./engines/kokoro.js";
import { piperGenerate, type PiperChunkStats } from "./engines/piper.js";

type EngineId = "kokoro-fp32" | "kokoro-fp16" | "kokoro-q4" | "piper";
type ChunkStats = KokoroChunkStats | PiperChunkStats;

interface GenerateMessage {
  type: "generate";
  runId: number;
  engine: EngineId;
  text: string;
  voice: string;
}

interface CancelMessage {
  type: "cancel";
  runId: number;
}

type WorkerMessage = GenerateMessage | CancelMessage;

type WorkerResponse =
  | { type: "progress"; runId: number; message: string; pct?: number | null }
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

function postProgress(runId: number, message: string, pct?: number | null): void {
  postResponse({ type: "progress", runId, message, pct });
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

async function generateWithKokoro(
  runId: number,
  payload: GenerateMessage,
  text: string,
): Promise<void> {
  assertActive(runId);
  const dtype = payload.engine.replace("kokoro-", "") as KokoroDtype;
  const voice = payload.voice || undefined;
  postProgress(runId, `engine selected=${payload.engine}`);
  const tts = await loadKokoro(dtype, (message, pct) => postProgress(runId, message, pct));
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
    (message, pct) => postProgress(runId, message, pct),
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
    (message, pct) => postProgress(runId, message, pct),
  );
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

  if (message.type !== "generate") return;

  activeRuns.add(message.runId);
  try {
    const text = validateText(message.text, { maxLength: MAX_TEXT_LENGTH });
    if (message.engine.startsWith("kokoro-")) {
      await generateWithKokoro(message.runId, message, text);
    } else if (message.engine === "piper") {
      postLog(message.runId, "Preparing Piper chunks (chunk size is 480 inside engine).");
      await generateWithPiper(message.runId, message, text);
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
