/**
 * Fastify HTTP API server (Phase 2).
 *
 * Boot sequence: load config → create server → register engines → load models
 * → start listening. Engine load is async but the server starts immediately so
 * /health can report "degraded" during warm-up.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateText, TtsError, type TtsErrorCode } from "@local-tts/core";
import { config } from "./config.js";
import { registry } from "./engines/registry.js";
import { createKokoroAdapter, KOKORO_LICENSE } from "./engines/kokoro.js";
import { createQwenSidecarAdapter, QWEN3_TTS_LICENSE } from "./engines/qwenSidecar.js";
import { createVoxcpmSidecarAdapter, VOXCPM2_LICENSE } from "./engines/voxcpmSidecar.js";
import { TtsJobStore } from "./jobs/jobStore.js";
import { TtsJobManager } from "./jobs/jobManager.js";

const server = Fastify({
  logger: config.logText ? { level: "info" } : { level: "warn" },
});

// ── CORS ──────────────────────────────────────────────────────────────
if (config.enableCors) {
  await server.register(cors, { origin: config.corsOrigin });
}

// ── Engine registry ───────────────────────────────────────────────────
registry.register(
  createKokoroAdapter({ model: config.modelPath }),
  KOKORO_LICENSE,
);

// Qwen3-TTS sidecar (Tier 2, docs/ENGINES.md #10) — opt-in via TTS_QWEN_SIDECAR_URL.
// Rejected on 2026-07-21 listening tests for zh/en code-switch quality; kept
// registered (not removed) in case a future model swap on the same sidecar
// warrants re-testing. See memory: tts_voice_evaluation_findings.md.
if (config.qwenSidecarUrl) {
  registry.register(
    createQwenSidecarAdapter({
      baseUrl: config.qwenSidecarUrl,
      timeoutMs: config.qwenSidecarTimeoutMs,
    }),
    QWEN3_TTS_LICENSE,
  );
}

// VoxCPM2 sidecar (Tier 2) — opt-in via TTS_VOXCPM_SIDECAR_URL.
// Approved 2026-07-21: accepted zh/en code-switch quality in one call, no
// per-language routing needed. Default engine for the paid tier.
if (config.voxcpmSidecarUrl) {
  registry.register(
    createVoxcpmSidecarAdapter({
      baseUrl: config.voxcpmSidecarUrl,
      timeoutMs: config.voxcpmSidecarTimeoutMs,
      chunkSize: 120,
    }),
    VOXCPM2_LICENSE,
  );
}

// Fire-and-forget: load engines in the background so the server starts fast.
// /health reports "degraded" until the default engine is available.
const loadPromise = registry.loadAll((msg) => server.log.info(msg));
const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const jobStore = new TtsJobStore(resolve(projectRoot, config.jobDataDir));
const jobManager = new TtsJobManager({
  store: jobStore,
  resolveEngine: (id) => registry.get(id)?.engine,
  chunkSize: 120,
  resultTtlMs: config.jobResultTtlMs,
  maxDiskBytes: config.jobMaxDiskBytes,
});
await jobManager.init();
loadPromise.then(() => jobManager.start()).catch((err) => server.log.error(err, "Job worker start failed"));
const jobCleanupTimer = setInterval(() => void jobManager.cleanup(), 60_000);
jobCleanupTimer.unref();

// ── GET /health ───────────────────────────────────────────────────────
server.get("/health", async (_request, reply) => {
  const entry = registry.get(config.engine);
  const modelLoaded = entry?.status === "available";
  return reply.send({
    status: modelLoaded ? "ok" : "degraded",
    engine: config.engine,
    modelLoaded,
  });
});

// ── GET /api/engines ──────────────────────────────────────────────────
server.get("/api/engines", async (_request, reply) => {
  return reply.send({ engines: registry.listEngines() });
});

// ── GET /api/voices ───────────────────────────────────────────────────
server.get("/api/voices", async (request, reply) => {
  const engineId = (request.query as Record<string, string>).engine ?? config.engine;

  if (!registry.has(engineId)) {
    return reply.status(404).send({
      error: {
        code: "ENGINE_NOT_FOUND",
        message: `Engine "${engineId}" is not registered.`,
      },
    });
  }

  try {
    const voices = await registry.listVoices(engineId);
    return reply.send({ voices });
  } catch (e) {
    return reply.status(503).send({
      error: {
        code: "MODEL_LOAD_FAILED",
        message: e instanceof Error ? e.message : "Engine not available.",
      },
    });
  }
});

// ── POST /api/tts ─────────────────────────────────────────────────────
/** PRD §15 error-code → HTTP status mapping. */
const STATUS_BY_CODE: Record<TtsErrorCode, number> = {
  EMPTY_TEXT: 400,
  TEXT_TOO_LONG: 400,
  UNSUPPORTED_FORMAT: 400,
  ENGINE_NOT_FOUND: 404,
  VOICE_NOT_FOUND: 404,
  MODEL_LOAD_FAILED: 503,
  GENERATION_FAILED: 500,
  PHONEMIZER_NOT_FOUND: 500,
};

interface TtsRequestBody {
  text?: string;
  engine?: string;
  voice?: string;
  language?: string;
}

function jobError(e: unknown): ReturnType<TtsError["toJSON"]> {
  if (e instanceof TtsError) return e.toJSON();
  return new TtsError(
    "GENERATION_FAILED",
    e instanceof Error ? e.message : "Synthesis failed.",
  ).toJSON();
}

// Long-running server TTS must not stay inside one Cloudflare request. Submit
// quickly, poll this resource, then receive the WAV from a short final GET.
server.post("/api/tts/jobs", async (request, reply) => {
  const body = (request.body ?? {}) as TtsRequestBody;
  const engineId = body.engine ?? config.engine;
  const entry = registry.get(engineId);
  if (!entry) return reply.status(404).send(new TtsError("ENGINE_NOT_FOUND", `Engine "${engineId}" is not registered.`).toJSON());
  if (entry.status !== "available") return reply.status(503).send(new TtsError("MODEL_LOAD_FAILED", `Engine "${engineId}" is not available yet.`).toJSON());
  try {
    validateText(body.text ?? "", { maxLength: config.maxTextLength });
  } catch (e) {
    const error = jobError(e);
    const code = error.error.code as TtsErrorCode;
    return reply.status(STATUS_BY_CODE[code] ?? 400).send(error);
  }

  const job = await jobManager.submit({
    text: body.text!.trim(),
    engine: engineId,
    ...(body.voice ? { voice: body.voice } : {}),
    ...(body.language ? { language: body.language } : {}),
  });
  return reply.status(202).send(job);
});

server.get<{ Params: { id: string } }>("/api/tts/jobs/:id", async (request, reply) => {
  const job = jobManager.get(request.params.id);
  if (!job) return reply.status(404).send({ error: { code: "JOB_NOT_FOUND", message: "TTS job not found or expired." } });
  if (job.status !== "done") return reply.send(jobManager.getPublic(job.id));
  if (job.durationMs !== undefined) reply.header("X-Duration-Ms", String(Math.round(job.durationMs)));
  return reply.header("Content-Type", job.mimeType ?? "audio/wav").send(await jobManager.result(job.id));
});

server.delete<{ Params: { id: string } }>("/api/tts/jobs/:id", async (request, reply) => {
  await jobManager.cancel(request.params.id);
  return reply.status(204).send();
});

server.post("/api/tts", async (request, reply) => {
  const body = (request.body ?? {}) as TtsRequestBody;
  const engineId = body.engine ?? config.engine;

  const entry = registry.get(engineId);
  if (!entry) {
    return reply.status(404).send(
      new TtsError("ENGINE_NOT_FOUND", `Engine "${engineId}" is not registered.`).toJSON(),
    );
  }
  if (entry.status !== "available") {
    return reply.status(503).send(
      new TtsError("MODEL_LOAD_FAILED", `Engine "${engineId}" is not available yet.`).toJSON(),
    );
  }

  try {
    const text = validateText(body.text ?? "", { maxLength: config.maxTextLength });
    const out = await entry.engine.synthesize({
      text,
      voice: body.voice,
      language: body.language,
    });
    if (out.durationMs !== undefined) {
      reply.header("X-Duration-Ms", String(Math.round(out.durationMs)));
    }
    return reply.header("Content-Type", out.mimeType).send(Buffer.from(out.audioBuffer));
  } catch (e) {
    if (e instanceof TtsError) {
      return reply.status(STATUS_BY_CODE[e.code] ?? 500).send(e.toJSON());
    }
    const message = e instanceof Error ? e.message : "Synthesis failed.";
    return reply.status(500).send(new TtsError("GENERATION_FAILED", message).toJSON());
  }
});

// ── Start ─────────────────────────────────────────────────────────────
try {
  await server.listen({ port: config.port, host: config.host });
  const addr = server.server.address();
  const url =
    addr && typeof addr === "object"
      ? `http://${addr.address}:${addr.port}`
      : `http://${config.host}:${config.port}`;
  server.log.info(`TTS API listening at ${url}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

// Await engine load so the process doesn't exit before models are ready
// (useful in Docker — keeps the container alive during warm-up).
loadPromise.catch((err) => server.log.error(err, "Engine load failed"));

export { server };
