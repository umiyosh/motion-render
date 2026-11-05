// The parts of kit/parts.css and the player's helpers for them: steps, cards, lanes, a ruler, a caption.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { checkLayout, formatIssue } from "../skills/motion-render/scripts/layout.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const TIMING = {
  total: 4,
  scenes: [
    { id: "steps", name: "Steps", start: 0, dur: 2, speech: 1.5 },
    { id: "lanes", name: "Lanes", start: 2, dur: 2, speech: 1.5 },
  ],
};

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/></svg>`;

const PARTS_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<link rel="stylesheet" href="kit/styles.css"><link rel="stylesheet" href="kit/parts.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>
  :root { --ground: #0b1622; --panel: #12233a; --line: #2a4466; --ink: #e9f0f7; --muted: #8aa0b8; --accent: #3ed6c4; --danger: #ff6b6b; }
  body { background: var(--ground); color: var(--ink); }
  #row { left: 300px; top: 160px; }
  #note { position: absolute; left: 300px; top: 420px; width: 700px; }
  #axis { left: 200px; top: 200px; width: 1400px; --to: 10; }
  #ruler { left: 400px; top: 600px; width: 1000px; --from: 0; --to: 10; }
</style></head>
<body><div id="root">
  <section class="scene" id="steps">
    <div id="row" class="steps layer-card">
      <div class="step" id="s1">${ICON}<span>原稿</span></div>
      <div class="step" id="s2">${ICON}<span>ナレーション</span></div>
      <div class="step" id="s3">${ICON}<span>映像</span></div>
    </div>
    <div id="note" class="card layer-card"><span class="card-title">絵コンテ</span><span class="card-body">見せ場を何秒目に置くかを先に決める</span></div>
    <p id="cap1" class="caption layer-caption">工程を順に進める</p>
  </section>
  <section class="scene" id="lanes">
    <div id="axis" class="lanes layer-card">
      <span class="lane-name">語り</span>
      <div class="track"><div class="seg" id="seg" style="--at: 2; --len: 3"><span>場面 1</span></div></div>
      <span class="lane-name">効果音</span>
      <div class="track"><i class="pin" id="pin" style="--at: 7"></i></div>
    </div>
    <div id="ruler" class="ruler layer-line"></div>
    <div id="mark" class="layer-chip" style="position: absolute; left: 300px; top: 820px; font-size: 24px; padding: 4px 10px">印</div>
  </section>
</div>
<script>
  film.build(function (tl) {
    film.light(tl, "#s2", film.at("steps", 0.5), { off: film.at("steps", 1.2) });
    film.light(tl, "#note", film.at("steps", 0.5));
    film.caption(tl, "#cap1", "steps", film.at("steps", 0.3));
    film.ticks("#ruler", { step: 2, label: "{v} 秒" });
    tl.to("#mark", { ...film.spot("#mark", "#ruler .tick:nth-child(3)", 0, -90), duration: 0.3 }, film.at("lanes", 0.2));
  });
</script>
</body></html>`;

function partsFilm(html = PARTS_PAGE): string {
  const work = tempDir("mr-parts-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
  const film = writeKit(work);
  writeFileSync(join(film, "index.html"), html);
  return film;
}

describe("kit parts", () => {
  it("lay out without layout issues, a lit card's body included, and place segments, pins and ticks on their axis", async () => {
    const film = await openFilm(partsFilm());
    try {
      expect((await checkLayout(film))?.map(formatIssue)).toEqual([]);
      const boxes = (await film.inspect?.(3)) ?? [];
      const box = (l: string) => boxes.find((b) => b.label.startsWith(l));
      const track = boxes.filter((b) => b.label.startsWith("div.track"))[0];
      const seg = box("#seg");
      const pin = box("#pin");
      if (!track || !seg || !pin) throw new Error("parts not found");
      // 2 s on a 0-10 s track starts a fifth of the way in (inside its 2px border); 3 s lasts 3 tenths.
      const inner = track.w - 4;
      expect(seg.x - (track.x + 2)).toBeCloseTo(inner * 0.2, 0);
      expect(seg.w).toBeCloseTo(inner * 0.3, 0);
      expect(pin.x + pin.w / 2 - (track.x + 2)).toBeCloseTo(inner * 0.7, 0);
      const labels = boxes.filter((b) => b.label.startsWith("i.tick")).map((b) => b.label);
      expect(labels).toHaveLength(6);
      expect(labels[5]).toContain("10 秒");
      // The 4 s tick sits at 4 tenths of the line, which runs 60px in from each end, and a chip
      // sent there with film.spot lands right above it.
      const tick = boxes.find((b) => b.label.startsWith('i.tick "4 秒"'));
      const mark = box("#mark");
      if (!tick || !mark) throw new Error("tick or mark not found");
      expect(tick.x + tick.w / 2).toBeCloseTo(400 + 60 + 0.4 * 880, 0);
      expect(mark.x + mark.w / 2).toBeCloseTo(tick.x + tick.w / 2, 0);
      expect(await film.warnings()).toEqual([]);
    } finally {
      await film.close();
    }
  });

  it("lights a step while it is on and shows the caption until just before the scene ends", async () => {
    const film = await openFilm(partsFilm());
    try {
      const off = await film.frame(0.2);
      const on = await film.frame(1.0);
      expect(on.equals(off)).toBe(false);
      expect((await film.frame(1.8)).equals(await film.frame(1.85))).toBe(true);
      const caption = async (t: number) =>
        ((await film.inspect?.(t)) ?? []).some((b) => b.label.startsWith("#cap1"));
      expect(await caption(1.0)).toBe(true);
      expect(await caption(1.9)).toBe(false);
    } finally {
      await film.close();
    }
  });
});
