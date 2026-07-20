/**
 * Fastify HTTP API server (Phase 2).
 *
 * Boot sequence: load config → create server → register engines → load models
 * → start listening. Engine load is async but the server starts immediately so
 * /health can report "degraded" during warm-up.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { validateText, TtsError, type TtsErrorCode } from "@local-tts/core";
import { config } from "./config.js";
import { registry } from "./engines/registry.js";
import { createKokoroAdapter, KOKORO_LICENSE } from "./engines/kokoro.js";
import { createQwenSidecarAdapter, QWEN3_TTS_LICENSE } from "./engines/qwenSidecar.js";

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

// Qwen3-TTS sidecar (Tier 2, docs/ENGINES.md #10) — opt-in via TTS_SIDECAR_URL.
if (config.sidecarUrl) {
  registry.register(
    createQwenSidecarAdapter({
      baseUrl: config.sidecarUrl,
      timeoutMs: config.sidecarTimeoutMs,
    }),
    QWEN3_TTS_LICENSE,
  );
}

// Fire-and-forget: load engines in the background so the server starts fast.
// /health reports "degraded" until the default engine is available.
const loadPromise = registry.loadAll((msg) => server.log.info(msg));

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
