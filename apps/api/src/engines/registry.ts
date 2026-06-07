/**
 * Engine registry — single source of truth for available TTS engines.
 *
 * Each entry pairs a `TtsEngine` implementation with its `EngineLicenseMeta`
 * so `GET /api/engines` can surface license data without the adapter knowing
 * about HTTP.
 */

import type { TtsEngine, TtsVoice, EngineLicenseMeta } from "@local-tts/core";

export interface EngineEntry {
  engine: TtsEngine;
  license: EngineLicenseMeta;
  /** "available" once load() succeeds; "unavailable" if it fails. */
  status: "loading" | "available" | "unavailable";
}

export class EngineRegistry {
  private readonly engines = new Map<string, EngineEntry>();

  register(engine: TtsEngine, license: EngineLicenseMeta): this {
    this.engines.set(engine.id, { engine, license, status: "loading" });
    return this;
  }

  get(id: string): EngineEntry | undefined {
    return this.engines.get(id);
  }

  has(id: string): boolean {
    return this.engines.has(id);
  }

  /** Lightweight summary for `GET /api/engines` (PRD §8.4). */
  listEngines() {
    return [...this.engines.entries()].map(([id, entry]) => ({
      id,
      name: entry.engine.name,
      status: entry.status,
      license: entry.license.license,
      commercialUse: entry.license.commercialUse,
    }));
  }

  /** All voices from a loaded engine. Throws if engine not found or not loaded. */
  async listVoices(id: string): Promise<TtsVoice[]> {
    const entry = this.engines.get(id);
    if (!entry) throw new Error(`Engine "${id}" not registered.`);
    if (entry.status !== "available") throw new Error(`Engine "${id}" is not available.`);
    return entry.engine.listVoices();
  }

  /** Load all registered engines (idempotent). */
  async loadAll(log: (msg: string) => void): Promise<void> {
    for (const [id, entry] of this.engines) {
      try {
        await entry.engine.load();
        entry.status = "available";
        log(`Engine "${id}" loaded.`);
      } catch (e) {
        entry.status = "unavailable";
        log(`Engine "${id}" failed: ${e instanceof Error ? e.message : "Unknown"}`);
      }
    }
  }
}

/** Singleton — one registry per process. */
export const registry = new EngineRegistry();
