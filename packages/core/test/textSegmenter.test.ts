import { describe, it, expect } from "vitest";
import { normalizeText, validateText, segmentText } from "../src/textSegmenter.js";
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
