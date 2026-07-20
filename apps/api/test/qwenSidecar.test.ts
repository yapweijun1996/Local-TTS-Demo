/**
 * Contract tests for the Qwen3-TTS sidecar adapter.
 *
 * A mock sidecar (node:http) plays the Python service's role so the adapter's
 * HTTP contract, error-code mapping, and header parsing are verified without
 * downloading the model. Real-model verification requires the actual sidecar
 * (services/qwen-tts-sidecar/README.md).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { TtsError } from "@local-tts/core";
import { createQwenSidecarAdapter } from "../src/engines/qwenSidecar.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const FAKE_WAV = Buffer.from("RIFFfakewavdata-not-a-real-container");

function startMock(handler: Handler): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

describe("createQwenSidecarAdapter", () => {
  let mock: { server: Server; url: string };
  let lastSynthesizeBody: unknown = null;
  let synthesizeStatus: "ok" | "warming" | "bad-voice" = "ok";

  beforeAll(async () => {
    mock = await startMock((req, res, body) => {
      if (req.url === "/health") {
        return json(res, 200, { status: "ok", model: "mock", model_loaded: true });
      }
      if (req.url === "/voices") {
        return json(res, 200, {
          voices: [
            { id: "Vivian", name: "Vivian (bright young female)", language: "zh" },
            { id: "Ryan", name: "Ryan (rhythmic male)", language: "en" },
          ],
        });
      }
      if (req.url === "/synthesize") {
        lastSynthesizeBody = JSON.parse(body);
        if (synthesizeStatus === "warming") {
          return json(res, 503, {
            error: { code: "MODEL_LOAD_FAILED", message: "Model is still loading." },
          });
        }
        if (synthesizeStatus === "bad-voice") {
          return json(res, 404, {
            error: { code: "VOICE_NOT_FOUND", message: "Unknown speaker: Nobody" },
          });
        }
        res.writeHead(200, {
          "content-type": "audio/wav",
          "x-sample-rate": "24000",
          "x-duration-ms": "1234",
        });
        return res.end(FAKE_WAV);
      }
      json(res, 404, { error: { code: "GENERATION_FAILED", message: "no route" } });
    });
  });

  afterAll(() => {
    mock.server.close();
  });

  it("load() succeeds when the sidecar is reachable", async () => {
    const engine = createQwenSidecarAdapter({ baseUrl: mock.url });
    await expect(engine.load()).resolves.toBeUndefined();
  });

  it("load() rejects when the sidecar is down", async () => {
    // Port from a server we immediately closed — connection refused.
    const dead = await startMock(() => {});
    await new Promise<void>((r) => dead.server.close(() => r()));
    const engine = createQwenSidecarAdapter({ baseUrl: dead.url, timeoutMs: 2000 });
    await expect(engine.load()).rejects.toThrow(/unreachable/i);
  });

  it("listVoices() maps sidecar voices onto TtsVoice", async () => {
    const engine = createQwenSidecarAdapter({ baseUrl: mock.url });
    const voices = await engine.listVoices();
    expect(voices).toHaveLength(2);
    expect(voices[0]).toEqual({
      id: "Vivian",
      name: "Vivian (bright young female)",
      language: "zh",
      engine: "qwen3-tts",
    });
  });

  it("synthesize() forwards text/voice/language and returns WAV + duration", async () => {
    synthesizeStatus = "ok";
    const engine = createQwenSidecarAdapter({ baseUrl: mock.url });
    const out = await engine.synthesize({
      text: "今天我们 review 一下 quarterly report。",
      voice: "Vivian",
      language: "zh",
    });
    expect(lastSynthesizeBody).toEqual({
      text: "今天我们 review 一下 quarterly report。",
      voice: "Vivian",
      language: "zh",
    });
    expect(out.mimeType).toBe("audio/wav");
    expect(out.durationMs).toBe(1234);
    expect(Buffer.from(out.audioBuffer).equals(FAKE_WAV)).toBe(true);
  });

  it("synthesize() omits voice/language keys when not provided", async () => {
    synthesizeStatus = "ok";
    const engine = createQwenSidecarAdapter({ baseUrl: mock.url });
    await engine.synthesize({ text: "hello" });
    expect(lastSynthesizeBody).toEqual({ text: "hello" });
  });

  it("maps sidecar 503 onto TtsError MODEL_LOAD_FAILED", async () => {
    synthesizeStatus = "warming";
    const engine = createQwenSidecarAdapter({ baseUrl: mock.url });
    const err = await engine.synthesize({ text: "hello" }).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).code).toBe("MODEL_LOAD_FAILED");
  });

  it("preserves the sidecar's specific error code (VOICE_NOT_FOUND)", async () => {
    synthesizeStatus = "bad-voice";
    const engine = createQwenSidecarAdapter({ baseUrl: mock.url });
    const err = await engine.synthesize({ text: "hello", voice: "Nobody" }).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).code).toBe("VOICE_NOT_FOUND");
    expect((err as TtsError).message).toMatch(/Nobody/);
  });
});
