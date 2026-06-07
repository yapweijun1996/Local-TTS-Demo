/**
 * Fastify HTTP API server (Phase 2).
 *
 * Boot sequence: load config → create server → register engines → load models
 * → start listening. Engine load is async but the server starts immediately so
 * /health can report "degraded" during warm-up.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { registry } from "./engines/registry.js";
import { createKokoroAdapter, KOKORO_LICENSE } from "./engines/kokoro.js";

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
