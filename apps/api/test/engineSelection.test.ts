import { describe, expect, it } from "vitest";
import { selectEngine, needsChineseFallback } from "../src/engineSelection.js";

function entries(statuses: Record<string, "available" | "loading" | "unavailable">) {
  return (id: string) => statuses[id] ? ({ engine: { id, name: id } as never, license: {} as never, status: statuses[id] }) : undefined;
}

describe("selectEngine", () => {
  it("keeps Mandarin on the multilingual Kokoro model", () => {
    const selected = selectEngine({
      requestedEngine: "kokoro",
      fallbackEngine: "voxcpm2",
      supportsChinese: true,
      text: "这是中文 Podcast。",
      getEntry: entries({ kokoro: "available", voxcpm2: "available" }),
    });
    expect(selected).toMatchObject({ engineId: "kokoro", requestedEngine: "kokoro" });
  });

  it("routes Mandarin to the configured fallback for an English-only Kokoro model", () => {
    const selected = selectEngine({
      requestedEngine: "kokoro",
      fallbackEngine: "voxcpm2",
      supportsChinese: false,
      text: "这是中文 Podcast。",
      getEntry: entries({ kokoro: "available", voxcpm2: "available" }),
    });
    expect(selected).toMatchObject({ engineId: "voxcpm2", fallbackFrom: "kokoro", fallbackReason: "cjk_not_supported_by_kokoro" });
  });

  it("uses Kokoro for English when it is loaded", () => {
    expect(selectEngine({ requestedEngine: "kokoro", fallbackEngine: "voxcpm2", text: "Hello", getEntry: entries({ kokoro: "available", voxcpm2: "available" }) }).engineId).toBe("kokoro");
  });

  it("falls back when the requested model is unavailable", () => {
    const selected = selectEngine({ requestedEngine: "kokoro", fallbackEngine: "voxcpm2", getEntry: entries({ kokoro: "unavailable", voxcpm2: "available" }) });
    expect(selected).toMatchObject({ engineId: "voxcpm2", fallbackReason: "requested_engine_unavailable" });
  });

  it("does not claim Mandarin support without a fallback", () => {
    expect(needsChineseFallback("你好", "")).toBe(true);
    expect(() => selectEngine({ requestedEngine: "kokoro", supportsChinese: false, getEntry: entries({ kokoro: "available" }), text: "你好" })).toThrow(/fallback engine is unavailable/);
  });

  it("uses the first available fallback in a comma-separated preference", () => {
    const selected = selectEngine({
      requestedEngine: "kokoro",
      fallbackEngine: "macos-say,voxcpm2",
      text: "你好",
      getEntry: entries({ kokoro: "available", "macos-say": "unavailable", voxcpm2: "available" }),
    });
    expect(selected.engineId).toBe("voxcpm2");
  });
});
