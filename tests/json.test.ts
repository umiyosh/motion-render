import { describe, expect, it } from "vitest";
import { errorMessage, field, isRecord } from "../skills/motion-render/scripts/json.ts";

describe("json helpers", () => {
  it("treats only plain objects as records", () => {
    expect([isRecord({}), isRecord([]), isRecord(null), isRecord("x")]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("reads a field without trusting the shape", () => {
    expect(field({ a: 1 }, "a")).toBe(1);
    expect(field([1], "0")).toBeUndefined();
    expect(field(undefined, "a")).toBeUndefined();
  });

  it("turns anything thrown into a message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});
