/**
 * Text normalization, validation, and segmentation (PRD §13).
 *
 * Pipeline position: this is the FIRST stage, before G2P/phonemization. It only
 * touches characters — it never converts text to phonemes.
 */

import { TtsError } from "./types.js";

export interface ValidateOptions {
  /** Maximum allowed length after normalization (PRD §12 TTS_MAX_TEXT_LENGTH). */
  maxLength: number;
}

/**
 * Normalize whitespace while preserving punctuation and sentence structure:
 * - CRLF -> LF
 * - collapse runs of spaces/tabs to a single space
 * - trim spaces around newlines
 * - cap blank-line runs at one blank line
 * - trim leading/trailing whitespace
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Normalize then enforce PRD §13 rules. Throws {@link TtsError} with
 * `EMPTY_TEXT` or `TEXT_TOO_LONG`. Returns the normalized, validated text.
 */
export function validateText(raw: string, opts: ValidateOptions): string {
  const text = normalizeText(raw);
  if (text.length === 0) {
    throw new TtsError("EMPTY_TEXT", "Text is empty.");
  }
  if (text.length > opts.maxLength) {
    throw new TtsError("TEXT_TOO_LONG", "Text exceeds maximum allowed length.", {
      maxLength: opts.maxLength,
    });
  }
  return text;
}

/**
 * Split text into chunks no longer than `maxChunkChars`, preferring sentence
 * boundaries (Latin .!? and CJK 。！？, plus newlines). A single sentence longer
 * than the limit is hard-split on word boundaries (or mid-token for scripts
 * without spaces, e.g. Chinese). Returns `[]` for empty input.
 */
export function segmentText(text: string, maxChunkChars = 500): string[] {
  if (maxChunkChars <= 0) {
    throw new TtsError("GENERATION_FAILED", "maxChunkChars must be positive.", {
      maxChunkChars,
    });
  }
  const normalized = normalizeText(text);
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChunkChars) return [normalized];

  const sentences = splitSentences(normalized);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const sentence of sentences) {
    if (sentence.length > maxChunkChars) {
      flush();
      chunks.push(...hardSplit(sentence, maxChunkChars));
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChunkChars) {
      flush();
      current = sentence;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

/** Split into sentences keeping terminal punctuation attached. */
function splitSentences(text: string): string[] {
  const matches = text.match(/[^.!?。！？\n]+[.!?。！？]*\n*/g);
  if (!matches) return [text.trim()];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Hard-split an over-long sentence on the last space before the limit. */
function hardSplit(sentence: string, max: number): string[] {
  const out: string[] = [];
  let rest = sentence.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max; // no space (e.g. CJK) -> hard cut at the limit
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
