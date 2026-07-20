import { describe, it, expect } from "vitest";
import {
  encodeWav,
  decodeWav,
  wavDurationMs,
  concatFloat32,
  resampleLinear,
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

describe("decodeWav", () => {
  it("round-trips encodeWav samples (within 16-bit quantization)", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25, -0.75]);
    const decoded = decodeWav(encodeWav(samples, { sampleRate: 22050 }));
    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.numChannels).toBe(1);
    expect(decoded.samples.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(decoded.samples[i]).toBeCloseTo(samples[i]!, 3);
    }
  });

  it("decodes data even when a non-canonical chunk precedes 'data'", () => {
    // Build RIFF: fmt + a junk 'LIST' chunk + data, to exercise the chunk walk.
    const pcm = new Int16Array([100, -200, 32767, -32768]);
    const junk = 6; // odd-padded to 6 → word-aligned at +6
    const dataBytes = pcm.length * 2;
    const total = 12 + 24 + (8 + junk) + (8 + dataBytes);
    const buf = new ArrayBuffer(total);
    const v = new DataView(buf);
    const w = (o: number, s: string): void => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    w(0, "RIFF"); v.setUint32(4, total - 8, true); w(8, "WAVE");
    w(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "LIST"); v.setUint32(40, junk, true);
    const dataChunk = 36 + 8 + junk;
    w(dataChunk, "data"); v.setUint32(dataChunk + 4, dataBytes, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(dataChunk + 8 + i * 2, pcm[i]!, true);

    const decoded = decodeWav(buf);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.samples.length).toBe(pcm.length);
    expect(decoded.samples[2]).toBeCloseTo(1, 4); // 32767 → +1
    expect(decoded.samples[3]).toBeCloseTo(-1, 4); // -32768 → -1
  });

  it("rejects non-RIFF and non-16-bit input", () => {
    expect(() => decodeWav(new ArrayBuffer(8))).toThrow(RangeError);
    const eightBit = encodeWav(new Float32Array([0]), { sampleRate: 8000 });
    new DataView(eightBit).setUint16(34, 8, true); // corrupt bits-per-sample → 8
    expect(() => decodeWav(eightBit)).toThrow(RangeError);
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

describe("resampleLinear", () => {
  it("is a no-op when rates already match", () => {
    const samples = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(samples, 24000, 24000)).toBe(samples);
  });

  it("returns empty input unchanged", () => {
    const empty = new Float32Array(0);
    expect(resampleLinear(empty, 22050, 24000)).toBe(empty);
  });

  it("upsamples to a longer buffer proportional to the rate ratio", () => {
    const samples = new Float32Array(2205).fill(0.5); // 0.1s @ 22050Hz
    const out = resampleLinear(samples, 22050, 24000);
    const expectedLength = Math.round(2205 * (24000 / 22050));
    expect(out.length).toBe(expectedLength);
  });

  it("downsamples to a shorter buffer proportional to the rate ratio", () => {
    const samples = new Float32Array(2400).fill(0.5); // 0.1s @ 24000Hz
    const out = resampleLinear(samples, 24000, 22050);
    const expectedLength = Math.round(2400 * (22050 / 24000));
    expect(out.length).toBe(expectedLength);
  });

  it("preserves a constant signal's amplitude", () => {
    const samples = new Float32Array(1000).fill(0.75);
    const out = resampleLinear(samples, 24000, 22050);
    expect(out.every((v) => Math.abs(v - 0.75) < 1e-9)).toBe(true);
  });

  it("linearly interpolates between two known points", () => {
    // 5 samples ramping 0 -> 1 at rate 5; upsample to rate 10 should land ~0.5 offset.
    const samples = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
    const out = resampleLinear(samples, 5, 10);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[out.length - 1]).toBeCloseTo(1, 1);
  });
});
