/**
 * Configuration loader — reads TTS_* env vars (PRD §12).
 *
 * All values have safe defaults so the server boots without any env set.
 * Paths and secrets must never leak into error responses (ARCHITECTURE §7).
 */

const TRUE_PATTERNS = /^(?:1|true|yes|on)$/i;

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number, min = 0): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return TRUE_PATTERNS.test(raw);
}

function envEnum<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const raw = process.env[key];
  return raw && (allowed as readonly string[]).includes(raw) ? raw as T : fallback;
}

export interface AppConfig {
  engine: string;
  fallbackEngine: string;
  /** Exclude engines whose model/voice terms do not permit commercial use. */
  commercialOnly: boolean;
  modelPath: string;
  defaultVoice: string;
  /** Whether the in-process Kokoro model includes Mandarin G2P/voices. */
  kokoroSupportsChinese: boolean;
  kokoroDtype: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  maxTextLength: number;
  outputFormat: string;
  enableCors: boolean;
  corsOrigin: string;
  logText: boolean;
  port: number;
  host: string;
  /** Qwen3-TTS sidecar base URL; empty string = engine disabled. */
  qwenSidecarUrl: string;
  /** Per-request Qwen sidecar timeout (generation on CPU can take minutes). */
  qwenSidecarTimeoutMs: number;
  /** VoxCPM2 sidecar base URL; empty string = engine disabled. */
  voxcpmSidecarUrl: string;
  /** Per-request VoxCPM2 sidecar timeout (generation on CPU can take minutes). */
  voxcpmSidecarTimeoutMs: number;
  /** Kokoro v1.1-zh Python sidecar base URL; empty string = disabled. */
  kokoroZhSidecarUrl: string;
  /** Per-request Kokoro v1.1-zh sidecar timeout. */
  kokoroZhSidecarTimeoutMs: number;
  /** Durable async-job metadata, chunks, and result directory. */
  jobDataDir: string;
  /** Retain terminal job results for this many milliseconds. */
  jobResultTtlMs: number;
  /** Maximum durable job storage before oldest terminal results are pruned. */
  jobMaxDiskBytes: number;
  /** Durable top-level text boundary; engines may apply their own safe split. */
  jobChunkSize: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    engine:       overrides.engine       ?? envStr("TTS_ENGINE",          "kokoro"),
    fallbackEngine: overrides.fallbackEngine ?? envStr("TTS_FALLBACK_ENGINE", "kokoro-zh,voxcpm2"),
    commercialOnly: overrides.commercialOnly ?? envBool("TTS_COMMERCIAL_ONLY", true),
    modelPath:    overrides.modelPath    ?? envStr("TTS_MODEL_PATH",      "onnx-community/Kokoro-82M-v1.0-ONNX"),
    defaultVoice: overrides.defaultVoice ?? envStr("TTS_DEFAULT_VOICE",   ""),
    kokoroSupportsChinese: overrides.kokoroSupportsChinese ?? envBool("TTS_KOKORO_SUPPORTS_CHINESE", false),
    kokoroDtype:  overrides.kokoroDtype  ?? envEnum("TTS_KOKORO_DTYPE", "q4f16", ["fp32", "fp16", "q8", "q4", "q4f16"] as const),
    maxTextLength:overrides.maxTextLength?? envInt("TTS_MAX_TEXT_LENGTH", 3000, 1),
    outputFormat: overrides.outputFormat ?? envStr("TTS_OUTPUT_FORMAT",   "wav"),
    enableCors:   overrides.enableCors   ?? envBool("TTS_ENABLE_CORS",   true),
    corsOrigin:   overrides.corsOrigin   ?? envStr("TTS_CORS_ORIGIN",    "*"),
    logText:      overrides.logText      ?? envBool("TTS_LOG_TEXT",      false),
    port:         overrides.port         ?? envInt("PORT",                6700, 1),
    host:         overrides.host         ?? envStr("HOST",               "0.0.0.0"),
    qwenSidecarUrl:   overrides.qwenSidecarUrl   ?? envStr("TTS_QWEN_SIDECAR_URL",    ""),
    qwenSidecarTimeoutMs: overrides.qwenSidecarTimeoutMs ?? envInt("TTS_QWEN_SIDECAR_TIMEOUT_MS", 120000, 1000),
    voxcpmSidecarUrl:   overrides.voxcpmSidecarUrl   ?? envStr("TTS_VOXCPM_SIDECAR_URL",    ""),
    voxcpmSidecarTimeoutMs: overrides.voxcpmSidecarTimeoutMs ?? envInt("TTS_VOXCPM_SIDECAR_TIMEOUT_MS", 180000, 1000),
    kokoroZhSidecarUrl: overrides.kokoroZhSidecarUrl ?? envStr("TTS_KOKORO_ZH_SIDECAR_URL", ""),
    kokoroZhSidecarTimeoutMs: overrides.kokoroZhSidecarTimeoutMs ?? envInt("TTS_KOKORO_ZH_SIDECAR_TIMEOUT_MS", 120000, 1000),
    jobDataDir: overrides.jobDataDir ?? envStr("TTS_JOB_DATA_DIR", "data/tts-jobs"),
    jobResultTtlMs: overrides.jobResultTtlMs ?? envInt("TTS_JOB_RESULT_TTL_MS", 3600000, 60000),
    jobMaxDiskBytes: overrides.jobMaxDiskBytes ?? envInt("TTS_JOB_MAX_DISK_BYTES", 2147483648, 1048576),
    jobChunkSize: overrides.jobChunkSize ?? envInt("TTS_JOB_CHUNK_SIZE", 480, 16),
  };
}

/** The singleton config — load once at startup. */
export const config = loadConfig();
