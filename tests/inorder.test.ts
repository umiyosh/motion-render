import { describe, expect, it } from "vitest";
import { inOrder, inParallel } from "../skills/motion-render/scripts/inorder.ts";

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe("inOrder", () => {
  it("yields results in order, with no more than `ahead` in flight", async () => {
    let running = 0,
      most = 0;
    const get = async (i: number) => {
      running++;
      most = Math.max(most, running);
      await wait((5 - i) * 5); // later ones finish first
      running--;
      return i;
    };
    const out: number[] = [];
    for await (const v of inOrder(6, 3, get)) out.push(v);
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
    expect(most).toBe(3);
  });

  it("passes on the first failure in order", async () => {
    const get = (i: number) =>
      i === 2 ? Promise.reject(new Error("frame 2 failed")) : Promise.resolve(i);
    const out: number[] = [];
    await expect(
      (async () => {
        for await (const v of inOrder(5, 4, get)) out.push(v);
      })()
    ).rejects.toThrow("frame 2 failed");
    expect(out).toEqual([0, 1]);
  });
});

describe("inParallel", () => {
  it("runs every item with no more than `n` at once", async () => {
    let running = 0,
      most = 0;
    const done: number[] = [];
    await inParallel([1, 2, 3, 4, 5], 2, async (i) => {
      most = Math.max(most, ++running);
      await wait(5);
      running--;
      done.push(i);
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(most).toBe(2);
  });

  it("starts nothing new after a failure, lets the running ones finish and throws the first error", async () => {
    const started: number[] = [];
    await expect(
      inParallel([1, 2, 3, 4, 5], 2, async (i) => {
        started.push(i);
        await wait(i === 1 ? 1 : 10);
        if (i === 1) throw new Error("item 1 failed");
      })
    ).rejects.toThrow("item 1 failed");
    expect(started).toEqual([1, 2]);
  });
});
