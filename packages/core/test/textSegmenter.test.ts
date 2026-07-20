import { describe, it, expect } from "vitest";
import { normalizeText, validateText, segmentText, segmentByLanguage } from "../src/textSegmenter.js";
import { TtsError } from "../src/types.js";

describe("normalizeText", () => {
  it("trims and collapses repeated spaces/tabs", () => {
    expect(normalizeText("  hello   world\t\tfoo  ")).toBe("hello world foo");
  });

  it("normalizes CRLF and trims around newlines", () => {
    expect(normalizeText("line1  \r\n  line2")).toBe("line1\nline2");
  });

  it("caps blank-line runs at one blank line", () => {
    expect(normalizeText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("preserves punctuation", () => {
    expect(normalizeText("Hello, world! Really?")).toBe("Hello, world! Really?");
  });
});

describe("validateText", () => {
  it("rejects empty text with EMPTY_TEXT", () => {
    expect(() => validateText("   ", { maxLength: 100 })).toThrowError(TtsError);
    try {
      validateText("", { maxLength: 100 });
    } catch (e) {
      expect((e as TtsError).code).toBe("EMPTY_TEXT");
    }
  });

  it("rejects over-long text with TEXT_TOO_LONG and details", () => {
    try {
      validateText("abcdef", { maxLength: 3 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TtsError);
      expect((e as TtsError).code).toBe("TEXT_TOO_LONG");
      expect((e as TtsError).details).toEqual({ maxLength: 3 });
    }
  });

  it("returns normalized text on success", () => {
    expect(validateText("  hi   there  ", { maxLength: 100 })).toBe("hi there");
  });

  it("counts length AFTER normalization (boundary)", () => {
    // 9 raw chars collapse to "hi there" (8) — under the limit of 8
    expect(validateText("hi   there", { maxLength: 8 })).toBe("hi there");
  });
});

describe("segmentText", () => {
  it("returns [] for empty input", () => {
    expect(segmentText("", 100)).toEqual([]);
    expect(segmentText("   ", 100)).toEqual([]);
  });

  it("returns a single chunk when under the limit", () => {
    expect(segmentText("Short sentence.", 100)).toEqual(["Short sentence."]);
  });

  it("splits on sentence boundaries and packs greedily", () => {
    const text = "One. Two. Three. Four.";
    const chunks = segmentText(text, 10);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
    expect(chunks.join(" ")).toBe("One. Two. Three. Four.");
  });

  it("hard-splits a single sentence longer than the limit", () => {
    const long = "wordA wordB wordC wordD wordE wordF";
    const chunks = segmentText(long, 12);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 12)).toBe(true);
  });

  it("hard-cuts CJK text without spaces", () => {
    const cjk = "你好世界这是一个测试句子非常长需要切分处理";
    const chunks = segmentText(cjk, 6);
    expect(chunks.every((c) => c.length <= 6)).toBe(true);
    expect(chunks.join("")).toBe(cjk);
  });

  it("throws on non-positive maxChunkChars", () => {
    expect(() => segmentText("hi there friend", 0)).toThrowError(TtsError);
  });
});

describe("segmentText — abbreviation & decimal safety (Q-1)", () => {
  it("does not split on known multi-letter abbreviations", () => {
    const text = "I spoke to Dr. Smith. He agreed with the plan.";
    // Force low max so genuine sentence boundary triggers split
    const chunks = segmentText(text, 30);
    // "Dr. Smith" must stay together; the split should be at "plan."
    expect(chunks.some((c) => c.includes("Dr. Smith"))).toBe(true);
    expect(chunks.every((c) => c.length <= 30)).toBe(true);
  });

  it("does not split on multi-initial abbreviations like U.S. and A.M.", () => {
    const text = "We live in the U.S. It is 10 A.M. now. Ready?";
    const chunks = segmentText(text, 25);
    // "U.S." and "A.M." must keep their dots
    expect(chunks.join(" ")).toContain("U.S.");
    expect(chunks.join(" ")).toContain("A.M.");
    expect(chunks.every((c) => c.length <= 25)).toBe(true);
  });

  it("does not split on decimal numbers like 3.14", () => {
    const text = "Pi is 3.14. That is the value. Good.";
    const chunks = segmentText(text, 20);
    // "3.14" must stay together
    const flat = chunks.join(" ");
    expect(flat).toContain("3.14");
    expect(chunks.every((c) => c.length <= 20)).toBe(true);
  });

  it("still splits on genuine sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third.";
    const chunks = segmentText(text, 20);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join(" ")).toBe("First sentence. Second sentence. Third.");
  });

  it("handles abbreviation at the very end of text", () => {
    const text = "He works for the dept.";
    const chunks = segmentText(text, 50);
    expect(chunks).toEqual(["He works for the dept."]);
  });

  it("handles common titles: Mr. Mrs. Ms. Prof. Sr. Jr.", () => {
    const text = "Mr. Jones met Mrs. Smith and Prof. Lee. Also Sr. and Jr. arrived.";
    const chunks = segmentText(text, 25);
    const flat = chunks.join(" ");
    expect(flat).toContain("Mr. Jones");
    expect(flat).toContain("Mrs. Smith");
    expect(flat).toContain("Prof. Lee");
    expect(chunks.every((c) => c.length <= 25)).toBe(true);
  });

  it("handles Latin abbreviations: etc. e.g. i.e. vs.", () => {
    const text = "Things like cats, dogs, etc. are common. I like fruit e.g. apples. Team A vs. Team B.";
    const chunks = segmentText(text, 25);
    const flat = chunks.join(" ");
    expect(flat).toContain("etc.");
    expect(flat).toContain("e.g.");
    expect(flat).toContain("vs.");
    expect(chunks.every((c) => c.length <= 25)).toBe(true);
  });

  it("handles months as abbreviations: Jan. Feb. Mar.", () => {
    const text = "The dates are Jan. 1, Feb. 2, and Mar. 3. That is all.";
    const chunks = segmentText(text, 25);
    const flat = chunks.join(" ");
    expect(flat).toContain("Jan.");
    expect(flat).toContain("Feb.");
    expect(flat).toContain("Mar.");
  });

  it("does NOT protect a genuine sentence-ending single letter", () => {
    const text = "This is option A. Next is option B.";
    const chunks = segmentText(text, 20);
    // "A." at sentence end should still split
    const flat = chunks.join(" ");
    expect(flat).toBe("This is option A. Next is option B.");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("segmentByLanguage", () => {
  it("returns [] for empty input", () => {
    expect(segmentByLanguage("")).toEqual([]);
    expect(segmentByLanguage("   ")).toEqual([]);
  });

  it("returns a single 'en' segment for pure English", () => {
    expect(segmentByLanguage("Hello world")).toEqual([{ lang: "en", text: "Hello world" }]);
  });

  it("returns a single 'zh' segment for pure Mandarin", () => {
    expect(segmentByLanguage("你好世界")).toEqual([{ lang: "zh", text: "你好世界" }]);
  });

  it("splits alternating zh/en runs and round-trips to the normalized input", () => {
    const input = "Hello 你好 world 世界";
    const segments = segmentByLanguage(input);
    expect(segments).toEqual([
      { lang: "en", text: "Hello " },
      { lang: "zh", text: "你好 " },
      { lang: "en", text: "world " },
      { lang: "zh", text: "世界" },
    ]);
    expect(segments.map((s) => s.text).join("")).toBe(normalizeText(input));
  });

  it("attaches shared punctuation to the preceding run instead of splitting on it", () => {
    const segments = segmentByLanguage("Hello, 世界!");
    expect(segments).toEqual([
      { lang: "en", text: "Hello, " },
      { lang: "zh", text: "世界!" },
    ]);
  });

  it("attaches digits to whichever run is active", () => {
    const segments = segmentByLanguage("temperature 25度");
    expect(segments).toEqual([
      { lang: "en", text: "temperature 25" },
      { lang: "zh", text: "度" },
    ]);
  });

  it("defaults digit/punctuation-only text to 'en'", () => {
    expect(segmentByLanguage("123 456!")).toEqual([{ lang: "en", text: "123 456!" }]);
  });

  it("handles Mandarin punctuation (，。！？) as part of the zh run", () => {
    const segments = segmentByLanguage("你好，世界！这是测试。");
    expect(segments).toEqual([{ lang: "zh", text: "你好，世界！这是测试。" }]);
  });
});
