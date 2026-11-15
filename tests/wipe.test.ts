// film.wipe (#65): the next scene shows inside a shape of the scene before, which grows from its own
// size until it fills the frame on the next scene's first frame; the frames are the same after
// seeking back, and the layout check does not take the two scenes for things on top of each other.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { checkLayout, formatIssue } from "../skills/motion-render/scripts/layout.ts";
import { repeatIssues } from "../skills/motion-render/scripts/repeat.ts";
import { findFfmpeg } from "../skills/motion-render/scripts/audio.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const TIMING = {
  total: 4,
  scenes: [
    { id: "dot", name: "Dot", start: 0, dur: 2, speech: 1 },
    { id: "red", name: "Red", start: 2, dur: 2, speech: 1 },
  ],
};

// A blue dot on dark ground; the next scene is red all over, with a word on it.
function film(): string {
  const work = tempDir("mr-wipe-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
  const dir = writeKit(work);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script>
<script src="kit/player.js"></script>
<style>body { background: #101418; color: #f2efe8; }
#ground { position: absolute; inset: 0; background: #d03030; }
#word { position: absolute; left: 144px; top: 120px; margin: 0; font-size: 72px; }</style></head>
<body><div id="root">
  <section class="scene" id="dot"><svg class="layer-card" width="1920" height="1080" style="position:absolute;left:0;top:0">
    <circle id="sun" cx="400" cy="540" r="60" fill="#3a8ee8"/></svg></section>
  <section class="scene" id="red"><div id="ground" class="layer-bg"></div><p id="word" class="layer-caption">赤い場面</p></section>
</div>
<script>film.build(function () { film.wipe("#sun", "red", { dur: 0.6 }); });</script>
</body></html>`
  );
  return dir;
}

// The colour at (x, y) of a PNG frame.
function pixel(png: Buffer, x: number, y: number): [number, number, number] {
  const r = spawnSync(
    findFfmpeg(),
    ["-v", "error", "-i", "-", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    {
      input: png,
      maxBuffer: 1 << 24,
    }
  );
  const i = (y * 1920 + x) * 3;
  return [r.stdout[i]!, r.stdout[i + 1]!, r.stdout[i + 2]!];
}
const red = ([r, g, b]: [number, number, number]) => r > 180 && g < 80 && b < 80;
const blue = ([r, , b]: [number, number, number]) => b > 180 && r < 100;

describe("film.wipe", () => {
  it("grows the shape until the next scene fills the frame on its first frame", async () => {
    const f = await openFilm(film());
    try {
      const before = await f.frame(1.2);
      expect(blue(pixel(before, 400, 540))).toBe(true);
      expect(red(pixel(before, 1600, 540))).toBe(false);
      // halfway: the next scene shows inside the grown dot, the far corner is still the scene before
      const mid = await f.frame(1.7);
      expect(red(pixel(mid, 400, 540))).toBe(true);
      expect(red(pixel(mid, 1900, 1060))).toBe(false);
      // a frame before the next scene, the far corner is still the scene before: the rest of the
      // frame turns on the next scene's first frame, so the change lands on its beat
      const last = await f.frame(2 - 1 / 60);
      expect(red(pixel(last, 1919, 0))).toBe(false);
      expect(red(pixel(last, 400, 540))).toBe(true);
      // on the next scene's first frame it fills the frame
      const at = await f.frame(2);
      for (const [x, y] of [
        [0, 0],
        [1919, 1079],
        [1919, 0],
        [0, 1079],
      ] as const)
        expect(red(pixel(at, x, y))).toBe(true);
      // the same frame after seeking back
      await f.frame(3.5);
      expect((await f.frame(1.7)).equals(mid)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("passes the layout check and the seek-back check", async () => {
    const dir = film();
    const f = await openFilm(dir, { pages: 2 });
    try {
      expect(((await checkLayout(f)) ?? []).map(formatIssue)).toEqual([]);
      expect(await repeatIssues(f, dir, [])).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
