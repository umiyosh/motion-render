// The bar before a drop, where the music may stop: how the voice before it ends against it, and the
// scene with "stop" that keeps it free of voice whatever the take (#91, #111).
import { describe, expect, it } from "vitest";
import { loadScript, writeTiming } from "../skills/motion-render/scripts/work.ts";
import { stopBarLines } from "../skills/motion-render/scripts/beatcli.ts";
import { workDir } from "./helpers.ts";

const BEAT_SCRIPT = { bgm: "jazz drum and bass", bpm: 120 };

describe("the bar before a drop", () => {
  // The #87 trial: "critic" ended 0.13 s into the bar before the drop "marks" at 124 BPM.
  const timing = (speech: number) => ({
    total: 40,
    bpm: 124,
    end: 35,
    scenes: [
      { id: "critic", name: "critic", start: 21.29, dur: 5.807, speech },
      {
        id: "marks",
        name: "marks",
        start: 27.097,
        dur: 7.742,
        speech: 7,
        section: "drop" as const,
      },
    ],
  });
  const script = { lead: 0.25 };

  it("says how far the voice before a drop runs into the bar before it, and how to keep it clear", () => {
    expect(stopBarLines(timing(3.75), script)).toEqual([
      'bar before drop "marks" (0:25.16-0:27.10): the voice of "critic" runs 0.13 s into it; to stop the music there, give "marks" "stop": true (a shorter line would move the drop a bar earlier with it)',
    ]);
  });

  it("says how much room is left when the voice ends before the bar", () => {
    expect(stopBarLines(timing(3.5), script)).toEqual([
      'bar before drop "marks" (0:25.16-0:27.10): the voice of "critic" ends 0.12 s before it',
    ]);
  });

  // #111: cutting the line moved the drop a bar earlier, and a new take spoke at its own pace, so
  // the voice ran into the stop again. A scene with "stop" keeps the bar before it free whatever the
  // take's length.
  const STOP_SCRIPT = {
    ...BEAT_SCRIPT,
    scenes: [
      { id: "intro", narration: "はじめに", section: "intro" },
      { id: "rise", narration: "高まる" },
      { id: "drop", narration: "全開", section: "drop", stop: true },
    ],
  };

  it("keeps the bar before a scene with stop free of voice for a take of any length", () => {
    const bar = 2;
    for (let rise = 1; rise <= 6; rise += 0.05) {
      const work = workDir(STOP_SCRIPT, { intro: 1.3, rise, drop: 1.0 });
      const s = loadScript(work);
      const t = writeTiming(work, s);
      const [, before, drop] = t.scenes;
      expect(drop!.start % bar).toBeCloseTo(0, 6);
      expect(before!.start + s.lead + before!.speech + s.tail).toBeLessThanOrEqual(
        drop!.start - bar + 1e-6
      );
      expect(stopBarLines(t, s)[0]).toMatch(/ends [\d.]+ s before it; the music stops there$/);
    }
  });

  it("refuses a stop it cannot keep", () => {
    const bad = (scenes: object[]) => () => loadScript(workDir({ ...BEAT_SCRIPT, scenes }));
    const rise = { id: "rise", narration: "高まる" };
    expect(bad([{ id: "a", narration: "x", section: "drop", stop: true }])).toThrow(
      /scenes\[0\]\.stop/
    );
    expect(bad([rise, { id: "b", narration: "x", stop: true }])).toThrow(/needs a "section"/);
    expect(bad([rise, { id: "b", narration: "x", section: "drop", stop: "yes" }])).toThrow(
      /stop must be true/
    );
    expect(
      bad([
        rise,
        { id: "b", narration: "x", section: "drop", stop: true },
        { id: "c", narration: "y", section: "drop", stop: true },
      ])
    ).toThrow(/one stop per film/);
  });
});
