import { describe, expect, it } from "vitest";
import { decodeWav } from "@local-tts/core";
import { createMacosSayAdapter } from "../src/engines/macosSay.js";

describe("macOS system voice adapter", () => {
  it("renders a short Mandarin WAV on Darwin", async () => {
    if (process.platform !== "darwin") return;
    const adapter = createMacosSayAdapter();
    await adapter.load();
    const voices = await adapter.listVoices();
    expect(voices.some((voice) => voice.id === "Tingting")).toBe(true);
    const output = await adapter.synthesize({ text: "这是本地中文语音测试。", language: "zh-CN" });
    const decoded = decodeWav(output.audioBuffer);
    expect(output.mimeType).toBe("audio/wav");
    expect(decoded.sampleRate).toBe(24000);
    expect(decoded.samples.length).toBeGreaterThan(1000);
    expect(output.durationMs).toBeGreaterThan(100);
  }, 120_000);
});
