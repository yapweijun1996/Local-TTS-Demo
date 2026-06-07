import { describe, it, expect } from "vitest";
import {
  encodeWav,
  wavDurationMs,
  concatFloat32,
  WAV_HEADER_BYTES,
} from "../src/audioUtils.js";

const ascii = (view: DataView, offset: number, length: number): string => {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
};

describe("encodeWav", () => {
  it("writes a valid 44-byte RIFF/WAVE header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buffer = encodeWav(samples, { sampleRate: 24000 });
    const view = new DataView(buffer);

    expect(buffer.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");

    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2); // RIFF chunk size
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(samples.length * 2); // data size
  });

  it("encodes peak samples to full-scale int16 and clamps overflow", () => {
    const samples = new Float32Array([1, -1, 2, -2]); // 2/-2 should clamp
    const buffer = encodeWav(samples, { sampleRate: 8000 });
    const view = new DataView(buffer);
    expect(view.getInt16(WAV_HEADER_BYTES + 0, true)).toBe(32767); // +1 -> 0x7fff
    expect(view.getInt16(WAV_HEADER_BYTES + 2, true)).toBe(-32768); // -1 -> -0x8000
    expect(view.getInt16(WAV_HEADER_BYTES + 4, true)).toBe(32767); // clamp +2
    expect(view.getInt16(WAV_HEADER_BYTES + 6, true)).toBe(-32768); // clamp -2
  });

  it("respects channel count in header math", () => {
    const buffer = encodeWav(new Float32Array([0, 0]), { sampleRate: 16000, numChannels: 2 });
    const view = new DataView(buffer);
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint16(32, true)).toBe(4); // blockAlign = 2ch * 2 bytes
    expect(view.getUint32(28, true)).toBe(16000 * 4); // byteRate
  });

  it("rejects invalid sampleRate / numChannels", () => {
    expect(() => encodeWav(new Float32Array([0]), { sampleRate: 0 })).toThrow(RangeError);
    expect(() =>
      encodeWav(new Float32Array([0]), { sampleRate: 24000, numChannels: 0 }),
    ).toThrow(RangeError);
  });
});

describe("wavDurationMs", () => {
  it("computes duration from samples and rate", () => {
    expect(wavDurationMs(24000, 24000)).toBe(1000);
    expect(wavDurationMs(12000, 24000)).toBe(500);
  });
  it("returns 0 for non-positive rate", () => {
    expect(wavDurationMs(100, 0)).toBe(0);
  });
});

describe("concatFloat32", () => {
  it("concatenates chunks in order", () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
  it("returns empty for no chunks", () => {
    expect(concatFloat32([]).length).toBe(0);
  });
});
