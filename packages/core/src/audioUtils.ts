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

/** Duration in milliseconds for a sample count at a given rate. */
export function wavDurationMs(numSamples: number, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return (numSamples / sampleRate) * 1000;
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
