/**
 * G2P (grapheme-to-phoneme) abstraction.
 *
 * This is the MANDATORY pipeline layer the PRD originally omitted (see
 * docs/ARCHITECTURE.md §1). Kokoro/Piper consume phonemes, not raw text.
 *
 * `packages/core` owns only the *abstraction* — concrete phonemizers (misaki,
 * HeadTTS CMU+NRL, or an opt-in espeak-ng plugin) are injected by the engine
 * layer so the GPL-sensitive espeak-ng is NEVER bundled into core
 * (see docs/LICENSING.md). `requiresEspeak` lets a host refuse GPL-encumbered
 * phonemizers at registration time.
 */

import { TtsError } from "../types.js";

export interface Phonemizer {
  /** Stable id, e.g. "misaki-en", "headtts-cmu", "espeak-es". */
  readonly id: string;
  /** BCP-47-ish language tag this phonemizer serves, e.g. "en", "zh". */
  readonly language: string;
  /** True if this phonemizer depends on the GPL-v3 espeak-ng runtime. */
  readonly requiresEspeak: boolean;
  /** Convert normalized text to a phoneme string for the target model. */
  phonemize(text: string): Promise<string>;
}

export interface RegisterOptions {
  /** Reject phonemizers that depend on espeak-ng (GPL-v3). Default: false. */
  allowEspeak?: boolean;
}

/**
 * Language-keyed registry of phonemizers. Pure and runtime-agnostic; holds no
 * model state. Resolution is case-insensitive on the language tag.
 */
export class PhonemizerRegistry {
  private readonly byLanguage = new Map<string, Phonemizer>();

  /**
   * Register a phonemizer for its language. Throws `PHONEMIZER_NOT_FOUND` is not
   * used here; instead a GPL guard throws `GENERATION_FAILED` when an espeak-ng
   * phonemizer is registered without `allowEspeak`.
   */
  register(phonemizer: Phonemizer, opts: RegisterOptions = {}): this {
    if (phonemizer.requiresEspeak && !opts.allowEspeak) {
      throw new TtsError(
        "GENERATION_FAILED",
        `Phonemizer "${phonemizer.id}" requires espeak-ng (GPL-v3). Pass { allowEspeak: true } to opt in.`,
        { phonemizer: phonemizer.id, language: phonemizer.language },
      );
    }
    this.byLanguage.set(phonemizer.language.toLowerCase(), phonemizer);
    return this;
  }

  has(language: string): boolean {
    return this.byLanguage.has(language.toLowerCase());
  }

  /** Resolve by language or throw `PHONEMIZER_NOT_FOUND`. */
  resolve(language: string): Phonemizer {
    const found = this.byLanguage.get(language.toLowerCase());
    if (!found) {
      throw new TtsError(
        "PHONEMIZER_NOT_FOUND",
        `No phonemizer registered for language "${language}".`,
        { language, available: this.languages() },
      );
    }
    return found;
  }

  /** List registered language tags. */
  languages(): string[] {
    return [...this.byLanguage.keys()];
  }
}
