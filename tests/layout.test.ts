import { describe, expect, it } from "vitest";
import {
  findLayoutIssues,
  formatIssue,
  parseBoxes,
  type LayoutBox,
  type LayoutSample,
} from "../skills/motion-render/scripts/layout.ts";

const box = (
  key: number,
  [x = 0, y = 0, w = 0, h = 0]: number[],
  more: Partial<LayoutBox> = {}
): LayoutBox => ({
  key,
  label: `#b${key}`,
  x,
  y,
  w,
  h,
  cut: false,
  anc: [],
  ok: false,
  under: null,
  ...more,
});

// The same boxes at t = 0, 0.2, 0.4 ...
const held = (boxes: LayoutBox[], n = 3): LayoutSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i / 5, boxes }));

describe("findLayoutIssues", () => {
  it("reports two still boxes that partly overlap, once, with the span", () => {
    const issues = findLayoutIssues(held([box(1, [0, 0, 100, 50]), box(2, [80, 10, 100, 50])], 4));
    expect(issues).toEqual([
      { kind: "overlap", from: 0.2, to: 0.6, message: "#b1 and #b2 partly overlap" },
    ]);
    expect(formatIssue(issues[0]!)).toBe("0.2-0.6s: #b1 and #b2 partly overlap");
  });

  it("leaves alone a box inside another, boxes that only touch, and nested elements", () => {
    const boxes = [
      box(1, [0, 0, 400, 200]),
      box(2, [20, 20, 100, 50]), // drawn inside 1 without being its child
      box(3, [400, 0, 100, 50]), // touches 1's right edge
      box(4, [380, 150, 100, 100], { anc: [1] }), // a child sticking out is "outside", not overlap
    ];
    expect(findLayoutIssues(held(boxes)).map((i) => i.kind)).toEqual(["outside"]);
  });

  it("does not report a box while it moves, nor a pose held for a single sample", () => {
    const card = box(1, [0, 0, 400, 200]);
    const chip = (x: number) => box(2, [x, 50, 100, 40]);
    const samples = [0, 200, 340, 360, 380].map((x, i) => ({ t: i / 5, boxes: [card, chip(x)] }));
    expect(findLayoutIssues(samples)).toEqual([]);
    // Still for two samples in a row: reported.
    samples.push({ t: 1, boxes: [card, chip(380)] }, { t: 1.2, boxes: [card, chip(380)] });
    expect(findLayoutIssues(samples)).toHaveLength(1);
  });

  it("counts a box that drifts a couple of px per sample (push-in, breathing) as still", () => {
    const card = box(1, [0, 0, 100, 50]);
    const drift = (i: number) => box(2, [80 + 2 * i, 10, 100 + 2 * i, 50]);
    const samples = [0, 1, 2].map((i) => ({ t: i / 5, boxes: [card, drift(i)] }));
    expect(findLayoutIssues(samples).map((i) => i.kind)).toEqual(["overlap"]);
  });

  it("reports a box sticking out of its parent, out of the frame, or hidden under another", () => {
    const boxes = [
      box(1, [100, 100, 300, 200]),
      box(2, [350, 120, 100, 40], { anc: [1] }),
      box(3, [1880, 500, 100, 40], { cut: true }),
      box(4, [600, 600, 100, 60], { under: 5 }),
      box(5, [640, 580, 200, 120]),
    ];
    expect(findLayoutIssues(held(boxes)).map(formatIssue)).toEqual([
      "0.2-0.4s: #b2 sticks out of #b1",
      "0.2-0.4s: #b3 is cut off by the frame",
      "0.2-0.4s: #b4 is hidden under #b5",
    ]);
  });

  it("does not call a card hidden by a chip resting inside it", () => {
    const boxes = [box(1, [0, 0, 600, 120], { under: 2 }), box(2, [340, 30, 240, 64])];
    expect(findLayoutIssues(held(boxes))).toEqual([]);
  });

  it("skips boxes marked data-layout-ok", () => {
    const boxes = [box(1, [0, 0, 100, 50]), box(2, [80, 10, 100, 50], { ok: true })];
    expect(findLayoutIssues(held(boxes))).toEqual([]);
  });
});

describe("parseBoxes", () => {
  it("accepts the page's snapshot and rejects anything else", () => {
    const b = box(1, [0, 0, 10, 10], { anc: [0], under: 3 });
    expect(parseBoxes([b])).toEqual([b]);
    expect(() => parseBoxes({})).toThrow("malformed");
    expect(() => parseBoxes([{ ...b, x: "0" }])).toThrow("malformed");
    expect(() => parseBoxes([{ ...b, anc: ["1"] }])).toThrow("malformed");
  });
});
