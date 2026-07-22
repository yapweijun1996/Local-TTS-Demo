import {
  TtsError,
  concatFloat32,
  decodeWav,
  encodeWav,
  segmentText,
  type TtsEngine,
  type TtsErrorBody,
} from "@local-tts/core";
import {
  TtsJobStore,
  publicJob,
  type PublicTtsJob,
  type StoredTtsJob,
  type TtsJobRequest,
} from "./jobStore.js";

export interface TtsJobManagerOptions {
  store: TtsJobStore;
  resolveEngine: (id: string) => TtsEngine | undefined;
  chunkSize?: number;
  resultTtlMs?: number;
  maxDiskBytes?: number;
}

export class TtsJobManager {
  private readonly jobs = new Map<string, StoredTtsJob>();
  private readonly queue: string[] = [];
  private readonly store: TtsJobStore;
  private readonly resolveEngine: (id: string) => TtsEngine | undefined;
  private readonly chunkSize: number;
  private readonly resultTtlMs: number;
  private readonly maxDiskBytes: number;
  private started = false;
  private workerRunning = false;

  constructor(opts: TtsJobManagerOptions) {
    this.store = opts.store;
    this.resolveEngine = opts.resolveEngine;
    this.chunkSize = opts.chunkSize ?? 120;
    this.resultTtlMs = opts.resultTtlMs ?? 60 * 60 * 1000;
    this.maxDiskBytes = opts.maxDiskBytes ?? 2 * 1024 * 1024 * 1024;
  }

  async init(): Promise<void> {
    await this.store.init();
    for (const job of await this.store.loadAll()) {
      if (job.status === "running") {
        job.status = "queued";
        job.startedAt = undefined;
        await this.store.save(job);
      }
      this.jobs.set(job.id, job);
      if (job.status === "queued") this.queue.push(job.id);
    }
  }

  start(): void {
    this.started = true;
    void this.pump();
  }

  async submit(request: TtsJobRequest): Promise<PublicTtsJob> {
    const now = Date.now();
    const chunks = segmentText(request.text, this.chunkSize);
    const job: StoredTtsJob = {
      id: crypto.randomUUID(),
      status: "queued",
      request,
      chunks: chunks.length > 0 ? chunks : [request.text],
      completedChunks: 0,
      totalChunks: Math.max(1, chunks.length),
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    await this.store.save(job);
    if (this.started) void this.pump();
    return this.getPublic(job.id)!;
  }

  get(id: string): StoredTtsJob | undefined {
    return this.jobs.get(id);
  }

  getPublic(id: string): PublicTtsJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const index = job.status === "queued" ? this.queue.indexOf(id) : -1;
    return publicJob(job, index >= 0 ? index + 1 : null);
  }

  async result(id: string): Promise<Buffer> {
    return this.store.readResult(id);
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === "done" || job.status === "failed") return true;
    job.status = "cancelled";
    job.completedAt = Date.now();
    await this.store.save(job);
    return true;
  }

  async cleanup(now = Date.now()): Promise<void> {
    for (const [id, job] of this.jobs) {
      const terminal = job.status === "done" || job.status === "failed" || job.status === "cancelled";
      if (terminal && now - (job.completedAt ?? job.updatedAt) > this.resultTtlMs) {
        this.jobs.delete(id);
        await this.store.delete(job);
      }
    }
    let usage = await this.store.usageBytes();
    if (usage <= this.maxDiskBytes) return;
    const terminal = [...this.jobs.values()]
      .filter((job) => job.status === "done" || job.status === "failed" || job.status === "cancelled")
      .sort((a, b) => (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt));
    for (const job of terminal) {
      this.jobs.delete(job.id);
      await this.store.delete(job);
      usage = await this.store.usageBytes();
      if (usage <= this.maxDiskBytes) break;
    }
  }

  private async pump(): Promise<void> {
    if (!this.started || this.workerRunning) return;
    this.workerRunning = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        const job = this.jobs.get(id);
        if (!job || job.status === "cancelled") continue;
        await this.run(job);
      }
    } finally {
      this.workerRunning = false;
    }
  }

  private async run(job: StoredTtsJob): Promise<void> {
    const engine = this.resolveEngine(job.request.engine);
    if (!engine) {
      await this.fail(job, new TtsError("ENGINE_NOT_FOUND", `Engine "${job.request.engine}" is not registered.`).toJSON());
      return;
    }
    job.status = "running";
    job.startedAt = Date.now();
    await this.store.save(job);
    try {
      for (let i = 0; i < job.chunks.length; i++) {
        if (this.jobs.get(job.id)?.status === "cancelled") return;
        if (!await this.store.hasChunk(job.id, i)) {
          const out = await engine.synthesize({
            text: job.chunks[i]!,
            voice: job.request.voice,
            language: job.request.language,
            jobId: job.id,
            chunkIndex: i,
          });
          if (this.jobs.get(job.id)?.status === "cancelled") return;
          await this.store.writeChunk(job.id, i, Buffer.from(out.audioBuffer));
        }
        job.completedChunks = i + 1;
        await this.store.save(job);
      }

      const parts: Float32Array[] = [];
      let sampleRate = 48_000;
      for (let i = 0; i < job.chunks.length; i++) {
        const chunk = await this.store.readChunk(job.id, i);
        const chunkBuffer = Uint8Array.from(chunk).buffer;
        const decoded = decodeWav(chunkBuffer);
        sampleRate = decoded.sampleRate || sampleRate;
        parts.push(decoded.samples);
        if (i < job.chunks.length - 1) parts.push(new Float32Array(Math.round(sampleRate * 0.06)));
      }
      const pcm = concatFloat32(parts);
      await this.store.writeResult(job.id, Buffer.from(encodeWav(pcm, { sampleRate })));
      job.status = "done";
      job.completedChunks = job.totalChunks;
      job.completedAt = Date.now();
      job.mimeType = "audio/wav";
      job.durationMs = Math.round((pcm.length / sampleRate) * 1000);
      await this.store.save(job);
    } catch (e) {
      if (this.jobs.get(job.id)?.status === "cancelled") return;
      const error = e instanceof TtsError
        ? e.toJSON()
        : new TtsError("GENERATION_FAILED", e instanceof Error ? e.message : "Synthesis failed.").toJSON();
      await this.fail(job, error);
    }
  }

  private async fail(job: StoredTtsJob, error: TtsErrorBody): Promise<void> {
    job.status = "failed";
    job.error = error;
    job.completedAt = Date.now();
    await this.store.save(job);
  }
}
