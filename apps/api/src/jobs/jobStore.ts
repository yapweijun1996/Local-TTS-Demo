import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { TtsErrorBody } from "@local-tts/core";

export type TtsJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TtsJobRequest {
  text: string;
  engine: string;
  voice?: string;
  language?: string;
}

export interface StoredTtsJob {
  id: string;
  status: TtsJobStatus;
  request: TtsJobRequest;
  chunks: string[];
  completedChunks: number;
  totalChunks: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  mimeType?: string;
  durationMs?: number;
  error?: TtsErrorBody;
}

export interface PublicTtsJob {
  id: string;
  status: TtsJobStatus;
  completedChunks: number;
  totalChunks: number;
  progress: number;
  queuePosition: number | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: TtsErrorBody["error"];
}

export function publicJob(job: StoredTtsJob, queuePosition: number | null): PublicTtsJob {
  return {
    id: job.id,
    status: job.status,
    completedChunks: job.completedChunks,
    totalChunks: job.totalChunks,
    progress: job.totalChunks > 0 ? Math.round((job.completedChunks / job.totalChunks) * 100) : 0,
    queuePosition,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.durationMs ? { durationMs: job.durationMs } : {}),
    ...(job.error ? { error: job.error.error } : {}),
  };
}

export class TtsJobStore {
  readonly root: string;
  readonly jobsDir: string;
  readonly chunksDir: string;
  readonly resultsDir: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.jobsDir = join(this.root, "jobs");
    this.chunksDir = join(this.root, "chunks");
    this.resultsDir = join(this.root, "results");
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.jobsDir, { recursive: true }),
      mkdir(this.chunksDir, { recursive: true }),
      mkdir(this.resultsDir, { recursive: true }),
    ]);
  }

  private jobPath(id: string): string {
    return join(this.jobsDir, `${id}.json`);
  }

  chunkPath(id: string, index: number): string {
    return join(this.chunksDir, id, `${String(index).padStart(4, "0")}.wav`);
  }

  resultPath(id: string): string {
    return join(this.resultsDir, `${id}.wav`);
  }

  private async atomicWrite(path: string, data: string | Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, data);
    await rename(temp, path);
  }

  async save(job: StoredTtsJob): Promise<void> {
    job.updatedAt = Date.now();
    await this.atomicWrite(this.jobPath(job.id), `${JSON.stringify(job)}\n`);
  }

  async loadAll(): Promise<StoredTtsJob[]> {
    const names = await readdir(this.jobsDir).catch(() => [] as string[]);
    const jobs: StoredTtsJob[] = [];
    for (const name of names.filter((name) => name.endsWith(".json"))) {
      try {
        const parsed = JSON.parse(await readFile(join(this.jobsDir, name), "utf8")) as StoredTtsJob;
        if (parsed.id && Array.isArray(parsed.chunks)) jobs.push(parsed);
      } catch {
        // Ignore an unreadable record. Atomic writes prevent normal partial files.
      }
    }
    return jobs.sort((a, b) => a.createdAt - b.createdAt);
  }

  async hasChunk(id: string, index: number): Promise<boolean> {
    return stat(this.chunkPath(id, index)).then((s) => s.isFile()).catch(() => false);
  }

  async writeChunk(id: string, index: number, audio: Buffer): Promise<void> {
    await this.atomicWrite(this.chunkPath(id, index), audio);
  }

  async readChunk(id: string, index: number): Promise<Buffer> {
    return readFile(this.chunkPath(id, index));
  }

  async writeResult(id: string, audio: Buffer): Promise<void> {
    await this.atomicWrite(this.resultPath(id), audio);
  }

  async readResult(id: string): Promise<Buffer> {
    return readFile(this.resultPath(id));
  }

  async delete(job: StoredTtsJob): Promise<void> {
    await Promise.all([
      rm(this.jobPath(job.id), { force: true }),
      rm(join(this.chunksDir, job.id), { recursive: true, force: true }),
      rm(this.resultPath(job.id), { force: true }),
      rm(join(this.root, "sidecar-cache", job.id), { recursive: true, force: true }),
    ]);
  }

  async usageBytes(path = this.root): Promise<number> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    let total = 0;
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) total += await this.usageBytes(child);
      else if (entry.isFile()) total += await stat(child).then((value) => value.size).catch(() => 0);
    }
    return total;
  }
}
