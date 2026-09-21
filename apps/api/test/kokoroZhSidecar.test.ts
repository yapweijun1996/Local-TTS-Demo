import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWav, encodeWav } from "@local-tts/core";
import { createKokoroZhSidecarAdapter } from "../src/engines/kokoroZhSidecar.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Kokoro v1.1-zh sidecar adapter", () => {
  it("requires a loaded model and exposes Mandarin voices", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ model_loaded: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        voices: [{ id: "zf_001", name: "Kokoro Mandarin female 001", language: "zh-CN" }],
      }), { status: 200 });
    }) as typeof fetch;

    const adapter = createKokoroZhSidecarAdapter({ baseUrl: "http://127.0.0.1:8201" });
    await adapter.load();
    await expect(adapter.listVoices()).resolves.toEqual([
      { id: "zf_001", name: "Kokoro Mandarin female 001", language: "zh-CN", engine: "kokoro-zh" },
    ]);
  });

  it("forwards the selected Mandarin voice and returns audio metadata", async () => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { "content-type": "audio/wav", "x-duration-ms": "5625" },
      });
    }) as typeof fetch;

    const adapter = createKokoroZhSidecarAdapter({ baseUrl: "http://127.0.0.1:8201" });
    const output = await adapter.synthesize({
      text: "这是中文测试。",
      voice: "zf_001",
      jobId: "8d91bb67-5d9b-4f11-b5fd-1c8cb43e44ab",
      chunkIndex: 0,
    });

    expect(requestBody).toMatchObject({
      text: "这是中文测试。",
      voice: "zf_001",
      job_id: "8d91bb67-5d9b-4f11-b5fd-1c8cb43e44ab",
      chunk_index: 0,
    });
    expect(output.mimeType).toBe("audio/wav");
    expect(output.durationMs).toBe(5625);
  });

  it("isolates cached child chunks for each durable parent chunk", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const wav = encodeWav(new Float32Array(2_400).fill(0.1), { sampleRate: 24_000 });
    globalThis.fetch = vi.fn(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(wav, {
        status: 200,
        headers: { "content-type": "audio/wav", "x-duration-ms": "100" },
      });
    }) as typeof fetch;

    const adapter = createKokoroZhSidecarAdapter({
      baseUrl: "http://127.0.0.1:8201",
      chunkSize: 4,
    });
    const jobId = "8d91bb67-5d9b-4f11-b5fd-1c8cb43e44ab";
    await adapter.synthesize({
      text: "甲乙丙丁。戊己庚辛。",
      jobId,
      chunkIndex: 0,
    });
    const firstParent = requests.splice(0);

    await adapter.synthesize({
      text: "壬癸子丑。寅卯辰巳。",
      jobId,
      chunkIndex: 1,
    });
    const secondParent = requests.splice(0);

    expect(firstParent.length).toBeGreaterThan(1);
    expect(secondParent.length).toBe(firstParent.length);
    expect(new Set(firstParent.map((body) => body.job_id)).size).toBe(1);
    expect(new Set(secondParent.map((body) => body.job_id)).size).toBe(1);
    expect(firstParent[0]?.job_id).not.toBe(secondParent[0]?.job_id);
    expect(firstParent.map((body) => body.chunk_index)).toEqual(
      firstParent.map((_body, index) => index),
    );
    expect(secondParent.map((body) => body.chunk_index)).toEqual(
      secondParent.map((_body, index) => index),
    );
  });

  it("trims only excessive edge padding before stitching Mandarin chunks", async () => {
    const sampleRate = 24_000;
    const source = new Float32Array(sampleRate);
    source.fill(0.2, sampleRate * 0.3, sampleRate * 0.7);
    const wav = encodeWav(source, { sampleRate });
    globalThis.fetch = vi.fn(async () => new Response(wav, {
      status: 200,
      headers: { "content-type": "audio/wav", "x-duration-ms": "1000" },
    })) as typeof fetch;

    const adapter = createKokoroZhSidecarAdapter({ baseUrl: "http://127.0.0.1:8201" });
    const output = await adapter.synthesize({ text: "这是一个边缘静音测试。" });
    const decoded = decodeWav(output.audioBuffer);

    expect(decoded.samples.length).toBeLessThan(source.length);
    expect(output.durationMs).toBeLessThan(700);
    expect(output.durationMs).toBeGreaterThan(500);
  });
});
