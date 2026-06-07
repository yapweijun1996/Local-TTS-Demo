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

export interface AppConfig {
  engine: string;
  modelPath: string;
  defaultVoice: string;
  maxTextLength: number;
  outputFormat: string;
  enableCors: boolean;
  corsOrigin: string;
  logText: boolean;
  port: number;
  host: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    engine:       overrides.engine       ?? envStr("TTS_ENGINE",          "kokoro"),
    modelPath:    overrides.modelPath    ?? envStr("TTS_MODEL_PATH",      "/app/models/kokoro"),
    defaultVoice: overrides.defaultVoice ?? envStr("TTS_DEFAULT_VOICE",   "default"),
    maxTextLength:overrides.maxTextLength?? envInt("TTS_MAX_TEXT_LENGTH", 3000, 1),
    outputFormat: overrides.outputFormat ?? envStr("TTS_OUTPUT_FORMAT",   "wav"),
    enableCors:   overrides.enableCors   ?? envBool("TTS_ENABLE_CORS",   true),
    corsOrigin:   overrides.corsOrigin   ?? envStr("TTS_CORS_ORIGIN",    "*"),
    logText:      overrides.logText      ?? envBool("TTS_LOG_TEXT",      false),
    port:         overrides.port         ?? envInt("PORT",                3000, 1),
    host:         overrides.host         ?? envStr("HOST",               "0.0.0.0"),
  };
}

/** The singleton config — load once at startup. */
export const config = loadConfig();
