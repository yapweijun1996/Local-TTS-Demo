import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { encodeWav, type TtsEngine } from "@local-tts/core";
import { TtsJobManager } from "../src/jobs/jobManager.js";
import { TtsJobStore, type StoredTtsJob } from "../src/jobs/jobStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempStore(): Promise<TtsJobStore> {
  const root = await mkdtemp(join(tmpdir(), "local-tts-jobs-"));
  roots.push(root);
  return new TtsJobStore(root);
}

function wav(): ArrayBuffer {
  return encodeWav(new Float32Array(480), { sampleRate: 48_000 });
}

async function waitForDone(manager: TtsJobManager, id: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const status = manager.getPublic(id)?.status;
    if (status === "done") return;
    if (status === "failed") throw new Error("job failed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("job did not finish");
}

describe("durable TTS jobs", () => {
  it("persists progress and resumes a running job without regenerating completed chunks", async () => {
    const store = await tempStore();
    await store.init();
    const now = Date.now();
    const interrupted: StoredTtsJob = {
      id: crypto.randomUUID(),
      status: "running",
      request: { text: "第一段。第二段。", engine: "voxcpm2", voice: "test" },
      chunks: ["第一段。", "第二段。"],
      completedChunks: 1,
      totalChunks: 2,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    };
    await store.writeChunk(interrupted.id, 0, Buffer.from(wav()));
    await store.save(interrupted);

    const calls: string[] = [];
    const engine: TtsEngine = {
      id: "voxcpm2",
      name: "fake",
      async load() {},
      async listVoices() { return []; },
      async synthesize(input) {
        calls.push(input.text);
        return { audioBuffer: wav(), mimeType: "audio/wav", durationMs: 10 };
      },
    };
    const manager = new TtsJobManager({ store, resolveEngine: () => engine });
    await manager.init();
    expect(manager.getPublic(interrupted.id)?.status).toBe("queued");
    manager.start();
    await waitForDone(manager, interrupted.id);

    expect(calls).toEqual(["第二段。"]);
    expect(manager.getPublic(interrupted.id)).toMatchObject({
      status: "done",
      completedChunks: 2,
      totalChunks: 2,
      progress: 100,
    });
    expect((await manager.result(interrupted.id)).byteLength).toBeGreaterThan(44);
  });

  it("returns a unique persisted job id and queue metadata", async () => {
    const store = await tempStore();
    const engine: TtsEngine = {
      id: "voxcpm2",
      name: "fake",
      async load() {},
      async listVoices() { return []; },
      async synthesize() { return { audioBuffer: wav(), mimeType: "audio/wav" }; },
    };
    const manager = new TtsJobManager({ store, resolveEngine: () => engine, chunkSize: 5 });
    await manager.init();
    const submitted = await manager.submit({ text: "1234567890", engine: "voxcpm2" });
    expect(submitted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(submitted.status).toBe("queued");
    expect(submitted.queuePosition).toBe(1);
    expect((await store.loadAll()).map((job) => job.id)).toContain(submitted.id);
  });
});
