import { describe, it, expect } from "vitest";
import { PhonemizerRegistry, type Phonemizer } from "../src/g2p/index.js";
import { TtsError } from "../src/types.js";

const makePhonemizer = (over: Partial<Phonemizer> = {}): Phonemizer => ({
  id: "misaki-en",
  language: "en",
  requiresEspeak: false,
  phonemize: async (t) => `/${t}/`,
  ...over,
});

describe("PhonemizerRegistry", () => {
  it("registers and resolves case-insensitively", () => {
    const reg = new PhonemizerRegistry().register(makePhonemizer({ language: "EN" }));
    expect(reg.has("en")).toBe(true);
    expect(reg.resolve("en").id).toBe("misaki-en");
    expect(reg.languages()).toEqual(["en"]);
  });

  it("throws PHONEMIZER_NOT_FOUND for unknown language", () => {
    const reg = new PhonemizerRegistry();
    try {
      reg.resolve("zz");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TtsError);
      expect((e as TtsError).code).toBe("PHONEMIZER_NOT_FOUND");
    }
  });

  it("blocks espeak-ng phonemizers by default (GPL guard)", () => {
    const reg = new PhonemizerRegistry();
    const espeak = makePhonemizer({ id: "espeak-es", language: "es", requiresEspeak: true });
    expect(() => reg.register(espeak)).toThrowError(TtsError);
    expect(reg.has("es")).toBe(false);
  });

  it("allows espeak-ng when explicitly opted in", () => {
    const reg = new PhonemizerRegistry();
    const espeak = makePhonemizer({ id: "espeak-es", language: "es", requiresEspeak: true });
    reg.register(espeak, { allowEspeak: true });
    expect(reg.resolve("es").id).toBe("espeak-es");
  });

  it("produces phonemes via the injected impl", async () => {
    const reg = new PhonemizerRegistry().register(makePhonemizer());
    await expect(reg.resolve("en").phonemize("hi")).resolves.toBe("/hi/");
  });
});
