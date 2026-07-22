/**
 * Shared TTS types — the engine adapter contract (PRD §11) plus the error model
 * (PRD §15). Browser and Node implementations both depend on these; neither the
 * runtime (onnxruntime-web vs -node) nor a concrete model is referenced here.
 */

export interface TtsVoice {
  id: string;
  name: string;
  language: string;
  gender?: string;
  engine: string;
}

export interface TtsInput {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
  format?: "wav";
  /** Durable server-job identity; ignored by in-browser engines. */
  jobId?: string;
  /** Zero-based durable chunk index, paired with jobId for idempotent sidecars. */
  chunkIndex?: number;
}

export interface TtsOutput {
  /** Encoded audio (e.g. a WAV container) ready to play or stream. */
  audioBuffer: ArrayBuffer;
  mimeType: string;
  durationMs?: number;
}

/**
 * The single contract every engine implements. Implemented twice — once over
 * onnxruntime-web (browser), once over onnxruntime-node (server) — sharing only
 * these types, never the runtime.
 */
export interface TtsEngine {
  readonly id: string;
  readonly name: string;
  /** Idempotent: safe to call at boot (server) or lazily (browser). */
  load(): Promise<void>;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(input: TtsInput): Promise<TtsOutput>;
}

/** License metadata surfaced by `GET /api/engines` (PRD §6 / §8.4). */
export interface EngineLicenseMeta {
  engine: string;
  modelName: string;
  license: string;
  commercialUse: boolean;
  requiresAttribution: boolean;
  sourceUrl: string;
  /** ISO date (YYYY-MM-DD) the license was last verified. */
  verifiedAt: string;
  notes: string;
}

/**
 * Stable error codes. The first seven mirror PRD §15 and map to HTTP statuses in
 * the API layer; `PHONEMIZER_NOT_FOUND` is an internal G2P-layer code.
 */
export type TtsErrorCode =
  | "EMPTY_TEXT"
  | "TEXT_TOO_LONG"
  | "ENGINE_NOT_FOUND"
  | "VOICE_NOT_FOUND"
  | "MODEL_LOAD_FAILED"
  | "GENERATION_FAILED"
  | "UNSUPPORTED_FORMAT"
  | "PHONEMIZER_NOT_FOUND";

/** JSON error envelope per PRD §15. */
export interface TtsErrorBody {
  error: {
    code: TtsErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Typed error carrying a stable code. `toJSON()` produces the exact PRD §15
 * envelope so the API can serialize it directly.
 */
export class TtsError extends Error {
  readonly code: TtsErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: TtsErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TtsError";
    this.code = code;
    this.details = details;
    // Preserve prototype chain when targeting ES2022 down-level helpers.
    Object.setPrototypeOf(this, TtsError.prototype);
  }

  toJSON(): TtsErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
