// The first draft of score.bars: sections on runs of fitting bars, drop heads full with a hit on
// beat 1, the final hit followed by quieter bars, and few joins.
import { describe, expect, it } from "vitest";
import { draftScores } from "../skills/motion-render/scripts/draft.ts";
import type { Take, TakeBar } from "../skills/motion-render/scripts/score.ts";
import type { Timing } from "../skills/motion-render/scripts/work.ts";

const quiet: TakeBar = { t: 0, lvl: -20, kick: 0, snare: 0, hat: 0, row: ".... .... .... ...." };
const drums: TakeBar = { t: 0, lvl: -8, kick: 2, snare: 0, hat: 4, row: "K.-. ..-. K.-. ..-." };
const full: TakeBar = { t: 0, lvl: -1, kick: 4, snare: 4, hat: 4, row: "X.-. X.-. X.-. X.-." };
const hitThenFade: TakeBar = { ...full, row: "X... .... .... ...." };
const fade: TakeBar = { ...quiet, lvl: -12 };

// 4 quiet bars, 4 drum bars, 8 full bars, a final hit and its ring.
const TAKE: Take = {
  take: 7,
  file: "audio/bgm/take7.mp3",
  measured: 120,
  filter: "anull",
  beat: 0.5,
  votes: { kick: [1, 0, 0, 0], change: [1, 0, 0, 0] },
  bars: [
    ...Array<TakeBar>(4).fill(quiet),
    ...Array<TakeBar>(4).fill(drums),
    ...Array<TakeBar>(8).fill(full),
    hitThenFade,
    fade,
  ].map((b, i) => ({ ...b, t: i * 2 })),
};

// At 120 BPM a bar is 2 s: intro bars 0-1, build 2-3, drop 4-7, final hit on bar 8, end at 9.
const TIMING: Timing = {
  total: 18,
  bpm: 120,
  end: 16,
  scenes: [
    { id: "a", name: "a", start: 0, dur: 4, speech: 3 },
    { id: "b", name: "b", start: 4, dur: 4, speech: 3, section: "build" },
    { id: "c", name: "c", start: 8, dur: 10, speech: 6, section: "drop" },
  ],
};

describe("draftScores", () => {
  it("lays quiet, drum and full bars on the sections and ends on the final hit", () => {
    const [d] = draftScores([TAKE], TIMING, 120);
    expect(d!.take).toBe(7);
    expect(d!.misses).toEqual([]);
    // intro on quiet bars, the build on drum bars running straight into the full drop, the final hit
    expect(d!.bars).toBe("0-1,6-11,16");
  });

  it("says when a take has no bar for the final hit", () => {
    const flat = { ...TAKE, bars: TAKE.bars.map((b) => ({ ...b, row: ".... .... .... ...." })) };
    const [d] = draftScores([flat], TIMING, 120);
    expect(d!.misses.join(" ")).toMatch(/final hit/);
  });
});
