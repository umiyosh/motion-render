// When each character of the narration is said (#59): measured on each scene's WAV, given to the
// page for film.word, and checked against the film's stops.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  charTimes,
  pageWords,
  voiceInStops,
  writeWords,
} from "../skills/motion-render/scripts/words.ts";
import { loadScript, writeTiming } from "../skills/motion-render/scripts/work.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { pcmWav, spoken, workDir } from "./helpers.ts";

const near = (t: number, want: number): void => expect(Math.abs(t - want)).toBeLessThan(0.05);

describe("charTimes", () => {
  it("starts each phrase where its voice rises and spreads its characters evenly", () => {
    // はじめに from 0.20 to 1.00 s, a pause, 動く from 1.25 to 2.05 s
    const t = charTimes(spoken([0.2, 0.8, 0.25, 0.8]), "はじめに、動く。");
    near(t[0]![0], 0.2);
    near(t[3]![0], 0.2 + (3 / 4) * 0.8); // に, the 4th of 4
    near(t[5]![0], 1.25); // 動, after the pause
    near(t[6]![0], 1.25 + 0.4); // く
    // the 、 sits between に and 動, the 。 after く
    expect(t[4]![0]).toBeGreaterThanOrEqual(t[3]![1] - 1e-9);
    expect(t[4]![1]).toBeLessThanOrEqual(t[5]![0] + 1e-9);
    expect(t[7]![0]).toBeGreaterThanOrEqual(t[6]![1] - 1e-9);
  });

  it("joins a pause the text does not mark into its phrase", () => {
    // a breath of 0.12 s inside はじめに: three runs of voice for two phrases
    const t = charTimes(spoken([0.2, 0.4, 0.12, 0.4, 0.3, 0.6]), "はじめに、動く。");
    near(t[0]![0], 0.2);
    near(t[5]![0], 1.42);
  });

  it("spreads the whole voice when it ran on through a pause the text marks", () => {
    const t = charTimes(spoken([0.3, 1.2]), "はじめに、動く。");
    near(t[0]![0], 0.3);
    near(t[5]![0], 0.3 + (4 / 6) * 1.2); // 動 after 4 of the 6 voiced characters
  });
});

const SCRIPT = {
  bgm: "x",
  bpm: 120,
  scenes: [
    { id: "intro", narration: "はじめに、動く。", section: "intro" },
    { id: "drop", narration: "一打で着く。", section: "drop" },
  ],
};

// A work whose intro says はじめに at 0.2-1.0 s and 動く at 1.25-2.05 s into its WAV (by default).
function work(intro = [0.2, 0.8, 0.25, 0.8]): string {
  const w = workDir(SCRIPT);
  writeFileSync(join(w, "audio", "intro.wav"), pcmWav(spoken(intro)));
  writeFileSync(join(w, "audio", "drop.wav"), pcmWav(spoken([0.2, 0.7], 5)));
  return w;
}

describe("word times of a work", () => {
  it("writes words.json and gives a page each character's time from its scene's start", () => {
    const w = work();
    const script = loadScript(w);
    const timing = writeTiming(w, script);
    expect(writeWords(w, script)).toBe(2);
    const saved = JSON.parse(readFileSync(join(w, "words.json"), "utf8"));
    near(saved.scenes.intro.chars[5][0], 1.25);
    const p = pageWords(w, script, timing);
    // lead 0.25 s, then the WAV's time at 1.1x
    expect(p.intro!.at![5]).toBeCloseTo(0.25 + saved.scenes.intro.chars[5][0] / 1.1, 2);
    expect(p.intro!.text).toBe("はじめに、動く。");
  });
});

describe("the narration against the stops", () => {
  // 120 BPM: bars of 2 s. The stop is bar 2 (4-6 s); the drop starts at 6 s.
  const timing = {
    total: 10,
    bpm: 120,
    end: 8,
    scenes: [
      { id: "intro", name: "intro", start: 0, dur: 6, speech: 2, section: "intro" as const },
      { id: "drop", name: "drop", start: 6, dur: 4, speech: 0.8, section: "drop" as const },
    ],
  };
  const scored = (w: string, bars: string) => ({ ...loadScript(w), score: { take: 1, bars } });

  it("passes a film whose narration rests in the stop", () => {
    const w = work();
    const r = voiceInStops(w, scored(w, "0-1,-1,2-4"), timing);
    expect(r).toEqual({ lines: ["stop 0:04.00-0:06.00: no voice in it"], problems: [] });
  });

  it("names the words said in the stop", () => {
    // 動く said 4.3-5.1 s into the WAV: 4.2-4.9 s into the film at 1.1x, inside the stop
    const w = work([0.2, 0.8, 3.3, 0.8]);
    const r = voiceInStops(w, scored(w, "0-1,-1,2-4"), timing);
    expect(r.problems[0]).toMatch(/speaks in the stop at 0:04\.00-0:06\.00 \("動く" of "intro"\)/);
    expect(r.lines).toEqual(["stop 0:04.00-0:06.00: voice in it"]);
  });

  it("checks nothing without a score or a stop", () => {
    const w = work();
    expect(voiceInStops(w, loadScript(w), timing)).toEqual({ lines: [], problems: [] });
    expect(voiceInStops(w, scored(w, "0-4"), timing).lines).toEqual([]);
  });
});

const WORD_PAGE = (word: string) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>body { background: #0b1622; color: #e9f0f7; } #t { position:absolute; left:200px; top:200px; font-size:60px; }</style>
</head><body><div id="root">
  <section class="scene" id="intro"><p id="t">-</p></section>
  <section class="scene" id="drop"></section>
</div>
<script>
  film.build(function () {
    document.getElementById("t").textContent = "at " + film.word("intro", "${word}").toFixed(3);
  });
</script></body></html>`;

describe("film.word", () => {
  async function pageText(w: string, word: string): Promise<string> {
    const dir = writeKit(w);
    writeFileSync(join(dir, "index.html"), WORD_PAGE(word));
    const film = await openFilm(dir);
    try {
      const boxes = (await film.inspect?.(0.5)) ?? [];
      return boxes.find((b) => b.label.startsWith("#t"))?.label ?? "";
    } finally {
      await film.close();
    }
  }

  it("returns when the word starts, in seconds from its scene's start", async () => {
    const w = work();
    const script = loadScript(w);
    const timing = writeTiming(w, script);
    const at = pageWords(w, script, timing).intro!.at![5]!;
    expect(await pageText(w, "動く")).toContain(`at ${at.toFixed(3)}`);
  });

  it("stops the page on a word the narration does not say", async () => {
    const w = work();
    writeTiming(w, loadScript(w));
    await expect(pageText(w, "止まる")).rejects.toThrow(/does not say "止まる"/);
  });
});
