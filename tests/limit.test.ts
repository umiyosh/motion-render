import { describe, expect, it, vi } from "vitest";
import { limit } from "../skills/motion-render/scripts/limit.ts";

describe("limit", () => {
  it("passes through a result or an error that comes in time", async () => {
    await expect(limit(Promise.resolve(3), 1000, "x")).resolves.toBe(3);
    await expect(limit(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow("boom");
  });

  it("stops what is stuck and fails with its name when time runs out", async () => {
    const stop = vi.fn();
    await expect(
      limit(new Promise(() => {}), 20, "the film page's __film.seek(1)", stop)
    ).rejects.toThrow("the film page's __film.seek(1) did not finish in 0.02s");
    expect(stop).toHaveBeenCalledOnce();
  });
});
