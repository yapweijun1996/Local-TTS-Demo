/**
 * Audio utilities — the final pipeline stage (PCM -> WAV container).
 *
 * Kokoro emits raw float32 PCM (24 kHz mono). Models return samples in [-1, 1];
 * these helpers pack them into a standard 16-bit PCM WAV so both the browser
 * (ArrayBuffer -> Blob) and the API (`audio/wav` response) share one encoder.
 */

/** WAV header is always 44 bytes for 16-bit PCM (canonical RIFF layout). */
export const WAV_HEADER_BYTES = 44;

export interface WavOptions {
  sampleRate: number;
  /** Default 1 (mono). */
  numChannels?: number;
}

/**
 * Encode float32 PCM samples ([-1, 1]) into a 16-bit PCM WAV ArrayBuffer.
 * Out-of-range samples are clamped to avoid wraparound clicks.
 */
export function encodeWav(samples: Float32Array, options: WavOptions): ArrayBuffer {
  const sampleRate = options.sampleRate;
  const numChannels = options.numChannels ?? 1;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate must be a positive number, got ${sampleRate}`);
  }
  if (!Number.isInteger(numChannels) || numChannels <= 0) {
    throw new RangeError(`numChannels must be a positive integer, got ${numChannels}`);
  }

  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  let offset = 0;
  const writeAscii = (s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
  };

  writeAscii("RIFF");
  view.setUint32(offset, 36 + dataSize, true);
  offset += 4;
  writeAscii("WAVE");

  writeAscii("fmt ");
  view.setUint32(offset, 16, true); // PCM fmt chunk size
  offset += 4;
  view.setUint16(offset, 1, true); // audio format: PCM
  offset += 2;
  view.setUint16(offset, numChannels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, byteRate, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true); // bits per sample
  offset += 2;

  writeAscii("data");
  view.setUint32(offset, dataSize, true);
  offset += 4;

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const intSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return buffer;
}

export interface DecodedWav {
  /** Decoded float32 PCM samples in [-1, 1]. Interleaved if numChannels > 1. */
  samples: Float32Array;
  sampleRate: number;
  numChannels: number;
}

/**
 * Decode a 16-bit PCM WAV (canonical RIFF/WAVE) back into float32 samples — the
 * inverse of {@link encodeWav}. Scans RIFF subchunks for `fmt ` and `data`, so a
 * non-canonical header (extra chunks before `data`) still decodes. Used to
 * re-extract PCM from engines that only return a finished WAV per call (e.g.
 * Piper), so multiple chunks can be concatenated into one output.
 *
 * Throws {@link RangeError} on a non-RIFF buffer or unsupported (non-PCM /
 * non-16-bit) format — those would silently produce noise otherwise.
 */
export function decodeWav(buffer: ArrayBuffer): DecodedWav {
  const view = new DataView(buffer);
  const ascii = (offset: number): string =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );

  if (buffer.byteLength < WAV_HEADER_BYTES || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    throw new RangeError("Not a RIFF/WAVE buffer.");
  }

  let numChannels = 1;
  let sampleRate = 0;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  // Walk subchunks starting after the 12-byte RIFF/WAVE header.
  let offset = 12;
  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      dataOffset = body;
      dataSize = Math.min(size, buffer.byteLength - body);
      break;
    }
    offset = body + size + (size & 1); // chunks are word-aligned (pad odd sizes)
  }

  if (dataOffset < 0) throw new RangeError("WAV has no data chunk.");
  if (bitsPerSample !== 16) {
    throw new RangeError(`Only 16-bit PCM is supported, got ${bitsPerSample}-bit.`);
  }

  const count = Math.floor(dataSize / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s = view.getInt16(dataOffset + i * 2, true);
    samples[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return { samples, sampleRate, numChannels: numChannels || 1 };
}

/** Duration in milliseconds for a sample count at a given rate. */
export function wavDurationMs(numSamples: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return (numSamples / sampleRate) * 1000;
}

/**
 * Resample float32 PCM to a different sample rate via linear interpolation.
 *
 * Needed when concatenating chunks from engines with different native rates
 * (e.g. Kokoro 24 kHz + Piper 22.05 kHz for mixed-language synthesis) — a WAV
 * has exactly one sample rate for its whole data chunk, so every source
 * segment must be brought to a common rate before {@link concatFloat32}.
 * Linear interpolation is not broadcast-quality resampling, but it is cheap,
 * dependency-free, and sufficient for short TTS segments. No-op if the rates
 * already match.
 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = toRate / fromRate;
  const newLength = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(newLength);
  const lastIndex = samples.length - 1;
  for (let i = 0; i < newLength; i++) {
    const srcPos = i / ratio;
    const idx0 = Math.min(lastIndex, Math.floor(srcPos));
    const idx1 = Math.min(lastIndex, idx0 + 1);
    const frac = srcPos - idx0;
    out[i] = samples[idx0]! * (1 - frac) + samples[idx1]! * frac;
  }
  return out;
}

/** Concatenate float32 chunks (e.g. per-segment PCM) into one buffer. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
