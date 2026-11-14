// Beat-synced html films in headless Chromium: kit/beat.js drawing from the time alone passes the
// layout and repeat checks; a film written with GSAP tweens that fight over one element changes
// after seeking back; a big word shown for half a second is too brief to read.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { checkLayout, formatIssue } from "../skills/motion-render/scripts/layout.ts";
import { repeatIssues } from "../skills/motion-render/scripts/repeat.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const TIMING = {
  total: 6,
  bpm: 120,
  end: 5,
  scenes: [
    { id: "intro", name: "Intro", start: 0, dur: 2, speech: 1, section: "intro" },
    { id: "drop", name: "Drop", start: 2, dur: 4, speech: 1, section: "drop" },
  ],
};
const HITS = {
  bpm: 120,
  bar: 2,
  hits: Array.from({ length: 12 }, (_, i) => ({ t: i * 0.5, slot: i * 4, k: "kick", v: 0.9 })),
};

function film(script: string): string {
  const work = tempDir("mr-beat-film-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
  mkdirSync(join(work, "audio"));
  writeFileSync(join(work, "audio", "hits.json"), JSON.stringify(HITS));
  const dir = writeKit(work);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script>
<script src="kit/player.js"></script><script src="kit/beat.js"></script>
<style>
  :root { --ground: #0b1622; --ink: #e9f0f7; }
  body { background: var(--ground); color: var(--ink); }
  #ball { position: absolute; left: 900px; top: 300px; width: 120px; height: 120px; border-radius: 50%; background: #3ed6c4; }
  .word { position: absolute; left: 144px; top: 800px; font-size: 110px; font-weight: 700; line-height: 1.1; white-space: nowrap; }
  .word b { display: block; height: 10px; background: #3ed6c4; margin-top: 6px; }
</style></head>
<body><div id="root">
  <div id="ball" class="layer-chip"></div>
  <div id="w1" class="word layer-caption"><span>点火</span><b></b></div>
  <div id="w2" class="word layer-caption">全開<b></b></div>
  <i id="flash" class="layer-caption" data-layout-ok style="position: absolute; inset: 0; background: #fff"></i>
  <section class="scene" id="drop"><p id="inside" class="layer-caption" style="position: absolute; left: 144px; top: 120px; font-size: 48px">全開の場面</p></section>
</div>
<script>${script}</script>
</body></html>`
  );
  return dir;
}

// Two words land on hits and stay (全開 written as bare text, which beat.words wraps itself); the ball beats on every kick; the drop flashes.
const DRAWN = `
  var kicks = beat.pick({ k: "kick" });
  var words = beat.words([{ el: "#w1", t: 1 }, { el: "#w2", t: 2 }]);
  film.draw(function (t) {
    beat.place("#ball", { s: 1 + 0.3 * beat.pulse(kicks, t, 0.2) });
    beat.alpha("#flash", beat.flash(t, beat.drops));
    words(t);
    beat.alpha("#inside", 1);
  });`;

// A film that keeps state between frames: what it shows depends on whether the page came back from
// a later time. (The first rocket film did the same through GSAP tweens that fought over one
// element; "motion-render check" found it in that film at PSNR 34-37 dB.)
const FOUGHT = `
  beat.alpha("#w2", 0);
  beat.alpha("#flash", 0);
  var last = 0;
  film.draw(function (t) {
    beat.alpha("#w1", t < last ? 0 : 1);
    last = t;
  });`;

const BRIEF = `
  beat.alpha("#w2", 0);
  beat.alpha("#flash", 0);
  film.draw(function (t) {
    beat.alpha("#w1", t >= 2.2 && t < 2.7 ? 1 : 0);
  });`;

describe("beat-synced html film", () => {
  it("draws from the time alone: hits, words that stack and stay, the drop's flash", async () => {
    const dir = film(DRAWN);
    expect(readFileSync(join(dir, "kit", "timing.js"), "utf8")).toMatch(
      /"bpm":120,"end":5.*"section":"drop".*\nwindow.__hits = \{"bpm":120/
    );
    expect(existsSync(join(dir, "kit", "beat.js"))).toBe(true);
    const f = await openFilm(dir, { pages: 2 });
    try {
      expect(await checkLayout(f)).toEqual([]);
      expect(await repeatIssues(f, dir, [])).toEqual([]);
      const boxes = async (t: number) => (await f.inspect?.(t)) ?? [];
      const word = async (t: number, text: string) =>
        (await boxes(t)).find((b) => b.label === `span "${text}"`);
      // 点火 is up on its own at 1.5 s, then sits small on the line above 全開 at 2.5 s
      const alone = await word(1.5, "点火");
      const above = await word(2.5, "点火"),
        under = await word(2.5, "全開");
      expect(alone && above && under).toBeTruthy();
      expect(above!.y + above!.h).toBeLessThanOrEqual(under!.y + 2);
      // smaller, yet still large enough to read
      expect(above!.h).toBeLessThan(alone!.h * 0.8);
      expect(above!.h).toBeGreaterThan(alone!.h * 0.55);
      // the drop flashes on its frame
      expect((await f.frame(2)).equals(await f.frame(2.4))).toBe(false);
      expect(await f.warnings()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("snaps a scene's own move to the nearest kick, or to the beat when no hit is near", async () => {
    // kicks every 0.5 s up to 5.5 s: 1.3 s goes to the kick at 1.5 s, 5.9 s (no kick near) to the beat at 6 s
    const dir = film(`
      beat.alpha("#w2", 0);
      beat.alpha("#flash", 0);
      document.querySelector("#w1 span").textContent =
        [beat.snap(1.3), beat.snap(5.9)].map(function (v) { return v.toFixed(3); }).join(" ");
      film.draw(function () { beat.alpha("#w1", 1); });`);
    const f = await openFilm(dir);
    try {
      const boxes = (await f.inspect?.(0.5)) ?? [];
      expect(boxes.map((b) => b.label)).toContain('span "1.492 5.992"');
    } finally {
      await f.close();
    }
  });

  it("keeps an element of a scene hidden outside its scene, though beat.alpha shows it", async () => {
    const f = await openFilm(film(DRAWN));
    try {
      const has = async (t: number) =>
        ((await f.inspect?.(t)) ?? []).some((b) => b.label.startsWith("#inside"));
      expect(await has(1)).toBe(false);
      expect(await has(3)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("finds frames that change after seeking back", async () => {
    const dir = film(FOUGHT);
    const f = await openFilm(dir, { pages: 2 });
    try {
      await checkLayout(f);
      const issues = await repeatIssues(f, dir, []);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.map(formatIssue).join("\n")).toMatch(
        /changes after seeking back \(PSNR \d+ dB\)/
      );
    } finally {
      await f.close();
    }
  });

  it("reports a big word on screen too briefly to read", async () => {
    const f = await openFilm(film(BRIEF));
    try {
      expect((await checkLayout(f))?.map(formatIssue)).toEqual([
        `2.2-2.7s: span "点火" is on screen for 0.5s, needs 2.0s (big text stays 2 s, and 1 s per 4 characters)`,
      ]);
    } finally {
      await f.close();
    }
  });
});
