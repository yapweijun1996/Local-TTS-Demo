/**
 * Fastify HTTP API server (Phase 2, skeleton).
 *
 * Currently serves GET /health only — returns engine status per PRD §8.5.
 * CORS is configurable via TTS_ENABLE_CORS / TTS_CORS_ORIGIN.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";

const server = Fastify({ logger: config.logText ? { level: "info" } : { level: "warn" } });

// ── CORS ──────────────────────────────────────────────────────────────
if (config.enableCors) {
  await server.register(cors, { origin: config.corsOrigin });
}

// ── Health ────────────────────────────────────────────────────────────
server.get("/health", async (_request, reply) => {
  return reply.send({
    status: "ok",
    engine: config.engine,
    modelLoaded: false, // until engine adapter is wired
  });
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

export { server };
