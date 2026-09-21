import type { EngineEntry } from "./engines/registry.js";

export interface EngineSelection {
  engineId: string;
  requestedEngine: string;
  fallbackFrom?: string;
  fallbackReason?: string;
}

export interface EngineSelectionOptions {
  requestedEngine: string;
  /** Comma-separated fallback preference, e.g. "voxcpm2". */
  fallbackEngine?: string;
  text?: string;
  language?: string;
  /** True when the requested engine natively supports Mandarin/CJK text. */
  supportsChinese?: boolean;
  getEntry: (id: string) => EngineEntry | undefined;
}

/**
 * Keep the language-capability decision in one pure function so the
 * synchronous and durable-job endpoints cannot diverge when an operator
 * intentionally configures an English-only Kokoro model.
 */
export function containsHan(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(text || ""));
}

export function needsChineseFallback(text = "", language = ""): boolean {
  return /^zh(?:-|$)/iu.test(String(language || "")) || containsHan(text);
}

export function selectEngine({
  requestedEngine,
  fallbackEngine = "",
  text = "",
  language = "",
  supportsChinese = false,
  getEntry,
}: EngineSelectionOptions): EngineSelection {
  const requested = String(requestedEngine || "").trim();
  const fallbacks = String(fallbackEngine || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index && value !== requested);
  const requestedEntry = getEntry(requested);
  if (!requestedEntry) {
    const error = new Error(`Engine "${requested}" is not registered.`);
    (error as Error & { code?: string }).code = "ENGINE_NOT_FOUND";
    throw error;
  }

  const chinese = requested === "kokoro" && !supportsChinese && needsChineseFallback(text, language);
  const requestedAvailable = requestedEntry.status === "available";
  const fallback = fallbacks.find((id) => getEntry(id)?.status === "available");
  const fallbackAvailable = Boolean(fallback);

  if (!chinese && requestedAvailable) {
    return { engineId: requested, requestedEngine: requested };
  }

  if (fallbackAvailable) {
    return {
      engineId: fallback!,
      requestedEngine: requested,
      fallbackFrom: requested,
      fallbackReason: chinese ? "cjk_not_supported_by_kokoro" : "requested_engine_unavailable",
    };
  }

  if (requestedAvailable && !chinese) {
    return { engineId: requested, requestedEngine: requested };
  }

  const error = new Error(
    chinese
      ? `Engine "${requested}" does not support Mandarin and fallback engine is unavailable.`
      : `Engine "${requested}" is not available yet.`,
  );
  (error as Error & { code?: string }).code = "MODEL_LOAD_FAILED";
  throw error;
}
