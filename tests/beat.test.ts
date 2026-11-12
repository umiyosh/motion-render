// The score of a beat-synced film, on a synthetic drum track whose every hit is known: tempo and
// downbeat, the hits, the take's bar table, and the chosen bars rendered onto the film's bars.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeMono } from "../skills/motion-render/scripts/signal.ts";
import { measureTempo } from "../skills/motion-render/scripts/tempo.ts";
import { detectHits, pattern } from "../skills/motion-render/scripts/hits.ts";
import {
  filmTable,
  loadTakes,
  measureTake,
  parseBars,
  renderScore,
  takeTable,
  writeWav,
} from "../skills/motion-render/scripts/score.ts";
import { loadScript, type Timing } from "../skills/motion-render/scripts/work.ts";
import { drumTrack, tempDir } from "./helpers.ts";

const BPM = 120;
const START = 0.3; // s before the first downbeat

// 16 bars: 4 of a quiet pad, 4 of drums, 1 silent, 7 of louder drums.
const PLAN = ["pad", "pad", "pad", "pad", "drums", "drums", "drums", "drums", "silent"].concat(
  new Array(7).fill("loud")
) as ("pad" | "drums" | "silent" | "loud")[];

function takeDir(bpm = BPM): string {
  const work = tempDir("mr-beat-");
  mkdirSync(join(work, "audio", "bgm"), { recursive: true });
  writeWav(drumTrack(bpm, START, PLAN), join(work, "audio", "bgm", "take1.wav"));
  return work;
}

describe("tempo and hits", () => {
  const work = takeDir();
  const x = decodeMono(join(work, "audio", "bgm", "take1.wav"));

  it("reads the tempo and the first downbeat", () => {
    const t = measureTempo(x, 118);
    expect(t.bpm).toBeCloseTo(BPM, 1);
    const bar = 240 / BPM;
    const off = (((t.first - START) % bar) + bar) % bar;
    expect(Math.min(off, bar - off)).toBeLessThan(0.02);
  });

  it("finds each kick, snare and hat on its 16th", () => {
    const hits = detectHits(x, BPM, START);
    expect(pattern(hits, 1)).toBe(".... .... .... ....");
    expect(pattern(hits, 5)).toBe("K.-. S.-. K.-. S.-.");
    expect(pattern(hits, 8)).toBe(".... .... .... ....");
    expect(pattern(hits, 9)).toBe("K.-. S.-. K.-. S.-.");
    const kick = hits.find((h) => h.slot === 9 * 16 && h.k === "kick");
    expect(kick?.t).toBeCloseTo(START + 9 * 2, 3);
  });
});

describe("takes", () => {
  it("measures a take bar by bar, locked to the film's tempo", () => {
    const work = takeDir(116);
    const take = measureTake(work, "audio/bgm/take1.wav", 1, BPM);
    expect(take.measured).toBeCloseTo(116, 0);
    expect(take.bars.length).toBeGreaterThanOrEqual(16);
    expect(take.bars[8]!.kick).toBe(0);
    expect(take.bars[9]!.kick).toBe(2);
    const table = takeTable(take, BPM);
    expect(table).toContain("played 3.4% faster to 120 BPM");
    expect(table).toMatch(/\n {4}9 .*full ▲/);
    expect(table).toMatch(/\n {4}0 .*no drums/);
    expect(table).toMatch(/\n {4}8 .*quiet/);
  });

  it("reads bar lists and refuses ones it cannot play", () => {
    expect(parseBars("0-2, -1, 5", 8)).toEqual([0, 1, 2, -1, 5]);
    expect(() => parseBars("3-1", 8)).toThrow(/backwards/);
    expect(() => parseBars("0-9", 8)).toThrow(/past the take's 8 bars/);
    expect(() => parseBars("x", 8)).toThrow(/not a bar/);
  });
});

function scoredWork(bars: string): { work: string; timing: Timing } {
  const work = takeDir();
  const take = measureTake(work, "audio/bgm/take1.wav", 1, BPM);
  writeFileSync(join(work, "audio", "bgm", "takes.json"), JSON.stringify([take]));
  const script = {
    bgm: "-",
    bpm: BPM,
    score: { take: 1, bars },
    scenes: [
      { id: "intro", narration: "a", section: "intro" },
      { id: "drop", narration: "b", section: "drop" },
    ],
  };
  writeFileSync(join(work, "script.json"), JSON.stringify(script));
  // 10 bars of 2 s: the drop at bar 5, the final hit at bar 9
  const timing: Timing = {
    total: 20,
    bpm: BPM,
    end: 18,
    scenes: [
      { id: "intro", name: "intro", start: 0, dur: 10, speech: 2, section: "intro" },
      { id: "drop", name: "drop", start: 10, dur: 10, speech: 2, section: "drop" },
    ],
  };
  return { work, timing };
}

describe("score", () => {
  it("plays the chosen bars on the film's bars and writes their hits", () => {
    const { work, timing } = scoredWork("0-3,8,10-13,9");
    const s = renderScore(work, loadScript(work), timing);
    expect(s.notes).toEqual([]);
    const hits = JSON.parse(readFileSync(join(work, "audio", "hits.json"), "utf8"));
    expect(hits.bpm).toBe(BPM);
    const kicks = s.hits.filter((h) => h.k === "kick");
    expect(kicks.some((h) => h.slot === 5 * 16)).toBe(true); // the drop lands on bar 5
    expect(kicks.every((h) => Math.abs(h.t - (h.slot * 2) / 16) < 1e-6)).toBe(true);
    expect(s.hits.filter((h) => h.slot >= 4 * 16 && h.slot < 5 * 16)).toEqual([]); // the silent bar
    expect(existsSync(join(work, "audio", "score.json"))).toBe(true);
    expect(loadTakes(work)[0]!.take).toBe(1);
    const table = filmTable(timing, s, BPM);
    expect(table).toMatch(/\n {4}5 .*drop \(drop\)/);
    expect(table).toMatch(/\n {4}9 .*final hit \(end\)/);
    // a scene start rounded to a hair before a bar line is still shown on that bar
    const early = filmTable(
      {
        ...timing,
        scenes: [timing.scenes[0]!, { ...timing.scenes[1]!, start: 7.995, section: undefined }],
      },
      s,
      BPM
    );
    expect(early).toMatch(/\n {4}4 .* drop\n/);
  });

  it("says when a drop does not slam in and the bar list does not fit the film", () => {
    const { work, timing } = scoredWork("0-3,4,0");
    const s = renderScore(work, loadScript(work), timing);
    expect(s.notes.join("\n")).toMatch(/score.bars has 6 bars, the film 10/);
    expect(s.notes.join("\n")).toMatch(/bar 5 \(drop, drop\): the music should slam in/);
    expect(s.notes.join("\n")).toMatch(/bar 9 \(final hit\)/);
  });

  it("says when the music stops dead more than once", () => {
    // full bars with a silent bar before the drop (bar 4) and another at bar 7
    const { work, timing } = scoredWork("9-12,8,9-10,8,9,-1");
    const s = renderScore(work, loadScript(work), timing);
    expect(s.notes.join("\n")).toMatch(
      /the music stops dead 2 times \(bar 4 at 0:08\.00, bar 7 at 0:14\.00\): keep one stop per film/
    );
    const once = renderScore(
      work,
      { ...loadScript(work), score: { take: 1, bars: "9-12,8,9-13" } },
      timing
    );
    expect(once.notes.join("\n")).not.toMatch(/stops dead/);
  });

  it("needs bpm, a score and measured takes", () => {
    const { work, timing } = scoredWork("0-9");
    const script = loadScript(work);
    expect(() => renderScore(work, { ...script, score: { take: 2, bars: "0" } }, timing)).toThrow(
      /take 2/
    );
    const { score: _drop, ...rest } = script;
    expect(() => renderScore(work, rest, timing)).toThrow(/needs "bpm" and "score"/);
    expect(() => loadTakes(tempDir())).toThrow(/no takes yet/);
  });
});
