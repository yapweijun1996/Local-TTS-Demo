import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.js";

describe("loadConfig", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("TTS_") || k === "PORT" || k === "HOST") {
        delete process.env[k];
      }
    }
  });

  afterEach(() => {
    process.env = saved;
  });

  it("returns safe defaults when no env is set", () => {
    const c = loadConfig();
    expect(c.engine).toBe("kokoro");
    expect(c.modelPath).toBe("/app/models/kokoro");
    expect(c.defaultVoice).toBe("default");
    expect(c.maxTextLength).toBe(3000);
    expect(c.outputFormat).toBe("wav");
    expect(c.enableCors).toBe(true);
    expect(c.corsOrigin).toBe("*");
    expect(c.logText).toBe(false);
    expect(c.port).toBe(3000);
    expect(c.host).toBe("0.0.0.0");
    expect(c.qwenSidecarUrl).toBe("");
    expect(c.qwenSidecarTimeoutMs).toBe(120000);
    expect(c.voxcpmSidecarUrl).toBe("");
    expect(c.voxcpmSidecarTimeoutMs).toBe(180000);
  });

  it("reads independent sidecar URLs for Qwen and VoxCPM2", () => {
    process.env.TTS_QWEN_SIDECAR_URL = "http://localhost:8100";
    process.env.TTS_VOXCPM_SIDECAR_URL = "http://localhost:8200";
    process.env.TTS_VOXCPM_SIDECAR_TIMEOUT_MS = "60000";
    const c = loadConfig();
    expect(c.qwenSidecarUrl).toBe("http://localhost:8100");
    expect(c.voxcpmSidecarUrl).toBe("http://localhost:8200");
    expect(c.voxcpmSidecarTimeoutMs).toBe(60000);
    expect(c.qwenSidecarTimeoutMs).toBe(120000); // untouched, still default
  });

  it("reads TTS_* env vars", () => {
    process.env.TTS_ENGINE = "piper";
    process.env.TTS_DEFAULT_VOICE = "en_US-lessac-medium";
    process.env.TTS_MAX_TEXT_LENGTH = "500";
    const c = loadConfig();
    expect(c.engine).toBe("piper");
    expect(c.defaultVoice).toBe("en_US-lessac-medium");
    expect(c.maxTextLength).toBe(500);
  });

  it("coerces TTS_MAX_TEXT_LENGTH to integer and enforces min 1", () => {
    process.env.TTS_MAX_TEXT_LENGTH = "0";
    expect(loadConfig().maxTextLength).toBe(3000); // fallback
    process.env.TTS_MAX_TEXT_LENGTH = "42.7";
    expect(loadConfig().maxTextLength).toBe(42);
    process.env.TTS_MAX_TEXT_LENGTH = "not-a-number";
    expect(loadConfig().maxTextLength).toBe(3000);
  });

  it("parses boolean-ish values correctly", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE", "YES"]) {
      process.env.TTS_ENABLE_CORS = v;
      expect(loadConfig().enableCors).toBe(true);
    }
    process.env.TTS_ENABLE_CORS = "0";
    expect(loadConfig().enableCors).toBe(false);
    delete process.env.TTS_ENABLE_CORS;
    expect(loadConfig().enableCors).toBe(true); // default
  });

  it("reads PORT and HOST", () => {
    process.env.PORT = "8080";
    process.env.HOST = "127.0.0.1";
    const c = loadConfig();
    expect(c.port).toBe(8080);
    expect(c.host).toBe("127.0.0.1");
  });

  it("allows partial overrides via the overrides argument", () => {
    const c = loadConfig({ engine: "piper", maxTextLength: 100 });
    expect(c.engine).toBe("piper");
    expect(c.maxTextLength).toBe(100);
    expect(c.port).toBe(3000); // still default
  });
});
