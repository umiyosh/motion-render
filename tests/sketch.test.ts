// kit/sketch.js (#97): helpers for a film drawn on one canvas.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { checkLayout } from "../skills/motion-render/scripts/layout.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const SKETCH = join(import.meta.dirname, "..", "skills", "motion-render", "kit", "sketch.js");

type View = { x: number; y: number; s: number };
type Shot = {
  t: number;
  dur?: number;
  x?: number;
  y?: number;
  s?: number;
  ease?: (p: number) => number;
};
type Sketch = { camera: (shots: Shot[]) => (t: number) => View };

function sketch(): Sketch {
  const window: { film: object; sketch?: Sketch } = { film: {} };
  runInNewContext(readFileSync(SKETCH, "utf8"), { window, Math });
  return window.sketch!;
}

describe("sketch.camera", () => {
  it("cuts on a shot of no length, on its own frame", () => {
    const view = sketch().camera([
      { t: 0, x: 960, y: 540, s: 1 },
      { t: 1, dur: 0, x: 100, y: 200, s: 4 },
    ]);
    expect(view(0.99)).toEqual({ x: 960, y: 540, s: 1 });
    expect(view(1)).toEqual({ x: 100, y: 200, s: 4 });
  });

  it("zooms by equal ratios and moves straight", () => {
    const view = sketch().camera([
      { t: 0, x: 0, y: 0, s: 1 },
      { t: 1, dur: 2, x: 100, y: 0, s: 4, ease: (p) => p },
    ]);
    const half = view(2);
    expect(half.s).toBeCloseTo(2, 6); // halfway in time, halfway in ratio: sqrt(4)
    expect(half.x).toBeCloseTo(50, 6);
    expect(view(5)).toEqual({ x: 100, y: 0, s: 4 });
  });
});

const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<script src="kit/fx.js"></script><script src="kit/sketch.js"></script>
<style>#cv { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }</style>
</head><body><div id="root"><canvas id="cv"></canvas></div>
<script>
  var ctx = fx.canvas("#cv");
  var cam = sketch.camera([
    { t: 0, x: 960, y: 540, s: 1 },
    { t: 1, dur: 0, x: 700, y: 500, s: 2 },
  ]);
  film.draw(function (t) {
    var v = cam(t);
    sketch.begin(ctx, "#f4f2ec");
    sketch.view(ctx, v);
    sketch.paper(ctx, v, { ground: "#f4f2ec", rule: "#dcd8cc", major: "#cfcabb" });
    ctx.globalAlpha = 0.5; // left over on purpose: begin() must reset it for the next frame
    sketch.line(ctx, sketch.ellipse(700, 500, 160, 90), t / 2, { width: 4, seed: 3 });
    sketch.line(ctx, sketch.box(500, 380, 400, 240), 1, { width: 3, color: "#1d2026" });
    sketch.label(ctx, "要点", 560, 360, t, 0.2, 1.8, { size: 40, color: "#d23a2a" });
  });
</script>
</body></html>`;

describe("a film drawn with sketch", () => {
  it("draws the same frame after seeking back, changes on the cut, and passes the layout check", async () => {
    const work = tempDir("mr-sketch-");
    writeFileSync(
      join(work, "timing.json"),
      JSON.stringify({
        total: 2,
        scenes: [
          { id: "a", name: "A", start: 0, dur: 1, speech: 0.5 },
          { id: "b", name: "B", start: 1, dur: 1, speech: 0.5 },
        ],
      })
    );
    const dir = writeKit(work);
    writeFileSync(join(dir, "index.html"), PAGE);
    const film = await openFilm(dir);
    try {
      const a = await film.frame(0.5);
      expect((await film.frame(1.5)).equals(a)).toBe(false);
      expect((await film.frame(0.5)).equals(a)).toBe(true);
      expect(await checkLayout(film)).toEqual([]);
      expect(await film.warnings()).toEqual([]);
    } finally {
      await film.close();
    }
  });
});
