import { describe, expect, it } from "vitest";
import {
  hasAudibleSamples,
  hasSpeechBearingText,
  splitSilentAudioText,
} from "../src/engines/kokoro.js";

describe("Kokoro silent-audio recovery helpers", () => {
  it("detects an all-zero PCM buffer without rejecting a low-level speech signal", () => {
    expect(hasAudibleSamples(new Float32Array(32))).toBe(false);
    expect(hasAudibleSamples(Float32Array.from([0, 0.00001, 0]))).toBe(false);
    expect(hasAudibleSamples(Float32Array.from([0, 0.0002, 0]))).toBe(true);
  });

  it("splits a silent-prone sentence into smaller retryable pieces", () => {
    const text = "For tool-using agents, every tool is a capability with a side-effect boundary.";
    const pieces = splitSilentAudioText(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(" ")).toBe(text);
    expect(Math.max(...pieces.map((piece) => piece.length))).toBeLessThan(text.length);
  });

  it("does not treat punctuation-only fragments as speech", () => {
    expect(hasSpeechBearingText("”")).toBe(false);
    expect(hasSpeechBearingText("Prompt engineering")).toBe(true);
  });
});
