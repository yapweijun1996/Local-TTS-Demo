/**
 * Contract tests for the VoxCPM2 sidecar adapter.
 *
 * A mock sidecar (node:http) plays the Python service's role so the adapter's
 * HTTP contract, error-code mapping, and header parsing are verified without
 * downloading the model. Real-model verification requires the actual sidecar
 * (services/voxcpm-sidecar/README.md).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { TtsError, encodeWav, decodeWav } from "@local-tts/core";
import { createVoxcpmSidecarAdapter } from "../src/engines/voxcpmSidecar.js";

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

describe("createVoxcpmSidecarAdapter", () => {
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
          voices: [{ id: "warm-elder-male", name: "Warm elder male (approved default)", language: "auto" }],
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
            error: { code: "VOICE_NOT_FOUND", message: "Unknown voice: nobody" },
          });
        }
        res.writeHead(200, {
          "content-type": "audio/wav",
          "x-sample-rate": "48000",
          "x-duration-ms": "5678",
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
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url });
    await expect(engine.load()).resolves.toBeUndefined();
  });

  it("load() rejects when the sidecar is down", async () => {
    const dead = await startMock(() => {});
    await new Promise<void>((r) => dead.server.close(() => r()));
    const engine = createVoxcpmSidecarAdapter({ baseUrl: dead.url, timeoutMs: 2000 });
    await expect(engine.load()).rejects.toThrow(/unreachable/i);
  });

  it("listVoices() maps the sidecar's single default voice onto TtsVoice", async () => {
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url });
    const voices = await engine.listVoices();
    expect(voices).toHaveLength(1);
    expect(voices[0]).toEqual({
      id: "warm-elder-male",
      name: "Warm elder male (approved default)",
      language: "auto",
      engine: "voxcpm2",
    });
  });

  it("synthesize() forwards text/voice (no language tag needed) and returns WAV + duration", async () => {
    synthesizeStatus = "ok";
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url });
    const out = await engine.synthesize({
      text: "今天我们 review 一下 quarterly report。",
      voice: "warm-elder-male",
    });
    expect(lastSynthesizeBody).toEqual({
      text: "今天我们 review 一下 quarterly report。",
      voice: "warm-elder-male",
    });
    expect(out.mimeType).toBe("audio/wav");
    expect(out.durationMs).toBe(5678);
    expect(Buffer.from(out.audioBuffer).equals(FAKE_WAV)).toBe(true);
  });

  it("synthesize() omits the voice key when not provided", async () => {
    synthesizeStatus = "ok";
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url });
    await engine.synthesize({ text: "hello" });
    expect(lastSynthesizeBody).toEqual({ text: "hello" });
  });

  it("forwards durable job identity for idempotent chunk retries", async () => {
    synthesizeStatus = "ok";
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url });
    await engine.synthesize({
      text: "durable chunk",
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      chunkIndex: 3,
    });
    expect(lastSynthesizeBody).toEqual({
      text: "durable chunk",
      job_id: "123e4567-e89b-12d3-a456-426614174000",
      chunk_index: 3,
    });
  });

  it("maps sidecar 503 onto TtsError MODEL_LOAD_FAILED", async () => {
    synthesizeStatus = "warming";
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url });
    const err = await engine.synthesize({ text: "hello" }).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).code).toBe("MODEL_LOAD_FAILED");
  });

  it("preserves the sidecar's specific error code (VOICE_NOT_FOUND)", async () => {
    synthesizeStatus = "bad-voice";
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url });
    const err = await engine.synthesize({ text: "hello", voice: "nobody" }).catch((e) => e);
    expect(err).toBeInstanceOf(TtsError);
    expect((err as TtsError).code).toBe("VOICE_NOT_FOUND");
    expect((err as TtsError).message).toMatch(/nobody/);
  });
});

describe("createVoxcpmSidecarAdapter — chunking long text", () => {
  // Regression test: a real 1294-char request took >180s in one continuous
  // sidecar call and got aborted by the client-side timeout ("VoxCPM2
  // sidecar unreachable: The operation was aborted due to timeout"), even
  // though the sidecar itself was healthy. Fix: split into <=chunkSize
  // pieces, one sidecar call each, decode+concat+re-encode the WAVs.
  let mock: { server: Server; url: string };
  let synthesizeCallCount = 0;
  const CHUNK_SAMPLES = 4800; // 0.1s at 48kHz per fake chunk

  beforeAll(async () => {
    mock = await startMock((req, res, _body) => {
      if (req.url === "/health") {
        return json(res, 200, { status: "ok", model: "mock", model_loaded: true });
      }
      if (req.url === "/synthesize") {
        synthesizeCallCount++;
        const wav = Buffer.from(
          encodeWav(new Float32Array(CHUNK_SAMPLES).fill(0.5), { sampleRate: 48000 }),
        );
        res.writeHead(200, { "content-type": "audio/wav", "x-sample-rate": "48000" });
        return res.end(wav);
      }
      json(res, 404, { error: { code: "GENERATION_FAILED", message: "no route" } });
    });
  });

  afterAll(() => {
    mock.server.close();
  });

  it("splits text over chunkSize into multiple sidecar calls and concatenates the audio", async () => {
    synthesizeCallCount = 0;
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url, chunkSize: 50 });
    // Plain repeated sentences -- long enough to force several >50-char chunks.
    const longText = "这是一句测试文本。".repeat(30); // ~270 chars, well over chunkSize=50
    const out = await engine.synthesize({ text: longText });

    expect(synthesizeCallCount).toBeGreaterThan(1);
    const decoded = decodeWav(out.audioBuffer);
    // Concatenated audio must be longer than any single chunk's samples --
    // proves chunks were actually stitched, not just the last one returned.
    expect(decoded.samples.length).toBeGreaterThan(CHUNK_SAMPLES * synthesizeCallCount * 0.9);
    expect(out.durationMs).toBeGreaterThan(0);
  });

  it("does not split text at or under chunkSize (single call)", async () => {
    synthesizeCallCount = 0;
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url, chunkSize: 480 });
    await engine.synthesize({ text: "短文本，不需要分段。" });
    expect(synthesizeCallCount).toBe(1);
  });

  it("chunkSize: 0 disables splitting even for long text", async () => {
    synthesizeCallCount = 0;
    const engine = createVoxcpmSidecarAdapter({ baseUrl: mock.url, chunkSize: 0 });
    await engine.synthesize({ text: "这是一句测试文本。".repeat(30) });
    expect(synthesizeCallCount).toBe(1);
  });
});
