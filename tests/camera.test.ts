// The camera of an html film (#62): a magnification by equal ratios, a push-in a notch per kick, and
// fx.camera's moves (a zoom about a fixed point, the fly of van Wijk and Nuij, a shot taking over),
// as values of t; then a film whose camera pushes in past a shape, which the layout check lets run
// off the frame, and past a word, which it does not.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { checkLayout, formatIssue } from "../skills/motion-render/scripts/layout.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

type Ease = (p: number) => number;
interface View {
  x: number;
  y: number;
  s: number;
}
interface Shot {
  t: number;
  x?: number;
  y?: number;
  s?: number;
  dur: number;
  ease?: Ease;
  fly?: boolean;
}
interface Hit {
  t: number;
  k: string;
  v: number;
}
interface Kit {
  fx: {
    zoom(t: number, t0: number, s0: number, s1: number, dur: number, ez?: Ease): number;
    camera(sel: string, shots: Shot[]): (t: number, k?: number) => View;
    onFrame(v: View, x: number, y: number): { x: number; y: number };
  };
  beat: {
    E: number;
    zoomSteps(list: Hit[], t: number, s0: number, ratio: number, dur?: number, ez?: Ease): number;
  };
  layer: { style: Record<string, string>; attrs: Record<string, string> };
}

const KIT = join(import.meta.dirname, "../skills/motion-render/kit");
const linear: Ease = (p) => p;

// fx.js and beat.js run as they do in the film page, on a window with only what they read.
function loadKit(): Kit {
  const layer = { style: {} as Record<string, string>, attrs: {} as Record<string, string> };
  const el = {
    style: layer.style,
    setAttribute: (n: string, v: string) => (layer.attrs[n] = v),
  };
  const window: Record<string, unknown> = {
    film: {},
    __timing: { bpm: 120, scenes: [] },
    __hits: { hits: [] },
  };
  const context = { window, document: { querySelector: () => el } };
  for (const f of ["fx.js", "beat.js"])
    runInNewContext(readFileSync(join(KIT, f), "utf8"), context);
  return { fx: window.fx as Kit["fx"], beat: window.beat as Kit["beat"], layer };
}

describe("a magnification by equal ratios", () => {
  const { fx, beat } = loadKit();

  it("multiplies by the same ratio in equal times, and ends at s0 and s1", () => {
    const at = [0, 0.25, 0.5, 0.75, 1].map((p) => fx.zoom(2 + p, 2, 1, 4, 1, linear));
    for (let i = 1; i < at.length; i++) expect(at[i]! / at[i - 1]!).toBeCloseTo(Math.SQRT2, 9);
    expect(fx.zoom(1, 2, 1, 4, 1)).toBe(1);
    expect(fx.zoom(3.5, 2, 1, 4, 1)).toBe(4);
    expect(fx.zoom(2, 2, 0.5, 3, 1)).toBe(0.5);
  });

  it("is a pure function of its inputs", () => {
    const a = fx.zoom(2.4, 2, 1, 4, 1);
    fx.zoom(2.9, 2, 1, 4, 1);
    expect(fx.zoom(2.4, 2, 1, 4, 1)).toBe(a);
  });

  it("pushes in a notch per kick, each notch the same ratio", () => {
    const kicks = [1, 2, 3].map((t) => ({ t, k: "kick", v: 1 }));
    const after = (t: number) => beat.zoomSteps(kicks, t + 0.5, 1, 1.1, 0.08);
    expect(beat.zoomSteps(kicks, 0.5, 1, 1.1)).toBe(1);
    expect(after(1)).toBeCloseTo(1.1, 9);
    expect(after(2) / after(1)).toBeCloseTo(1.1, 9);
    expect(after(3)).toBeCloseTo(1.331, 9);
    // the notch starts on the frame of the kick (shown E early) and has landed 0.08 s later
    expect(beat.zoomSteps(kicks, 1 - beat.E - 0.001, 1, 1.1)).toBe(1);
    expect(beat.zoomSteps(kicks, 1 - beat.E + 0.001, 1, 1.1)).toBeGreaterThan(1);
    expect(beat.zoomSteps(kicks, 1 - beat.E + 0.08, 1, 1.1)).toBeCloseTo(1.1, 9);
  });
});

describe("fx.camera", () => {
  it("rests until its first shot, then pushes in about the one point that stays put", () => {
    const { fx, layer } = loadKit();
    const cam = fx.camera("#cam", [{ t: 1, x: 1500, y: 300, s: 3, dur: 1, ease: linear }]);
    expect(cam(0.5)).toEqual({ x: 960, y: 540, s: 1 });
    expect(layer.style.transform).toBe("translate(0px,0px) scale(1)");
    expect(layer.attrs["data-camera"]).toBe("");
    // (F - a) * 1 = (F - b) * 3: F = (1770, 180) shows at the same place all the way in
    for (const t of [1.2, 1.5, 1.8, 2]) {
      const p = fx.onFrame(cam(t), 1770, 180);
      expect(p.x).toBeCloseTo(1770, 6);
      expect(p.y).toBeCloseTo(180, 6);
    }
    expect(cam(1.5).s).toBeCloseTo(Math.sqrt(3), 9);
    const end = cam(2.5);
    expect(end).toEqual({ x: 1500, y: 300, s: 3 });
    expect(fx.onFrame(end, 1500, 300)).toEqual({ x: 960, y: 540 });
    expect(layer.style.transform).toBe("translate(-3540px,-360px) scale(3)");
  });

  it("flies to a far point by pulling out on the way, landing exactly", () => {
    const { fx } = loadKit();
    const shots = [
      { t: 0, x: 500, y: 540, s: 2, dur: 0 },
      { t: 1, x: 1420, y: 540, s: 2, dur: 1, fly: true, ease: linear },
    ];
    const cam = fx.camera("#cam", shots);
    expect(cam(0.5)).toEqual({ x: 500, y: 540, s: 2 });
    expect(cam(1.5).s).toBeLessThan(1.5);
    expect(cam(1.5).x).toBeCloseTo(960, 6);
    const xs = [1.1, 1.3, 1.5, 1.7, 1.9].map((t) => cam(t).x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    expect(cam(2)).toEqual({ x: 1420, y: 540, s: 2 });
  });

  it("opens on the view of a shot of no length at 0 s, from the first frame", () => {
    const { fx } = loadKit();
    const cam = fx.camera("#cam", [{ t: 0, x: 700, y: 400, s: 2, dur: 0 }]);
    expect(cam(0)).toEqual({ x: 700, y: 400, s: 2 });
    expect(fx.zoom(0, 0, 1, 4, 0)).toBe(4);
  });

  it("never looks past the layer's edges", () => {
    const { fx } = loadKit();
    const cam = fx.camera("#cam", [
      { t: 0, x: 100, y: 1000, s: 2, dur: 1 },
      { t: 2, s: 0.5, dur: 1 },
    ]);
    // at 2 times the frame shows 960 x 540 px of the layer: its center stays 480 and 270 px in
    expect(cam(1.5)).toEqual({ x: 480, y: 810, s: 2 });
    // zoomed out past the whole layer, it is kept at the layer's center
    expect(cam(3.5)).toEqual({ x: 960, y: 540, s: 0.5 });
  });

  it("lets a shot take over from where the one before it is, and multiplies by k", () => {
    const { fx } = loadKit();
    const cam = fx.camera("#cam", [
      { t: 0, s: 2, dur: 2 },
      { t: 1, x: 700, s: 1.5, dur: 1 },
    ]);
    const before = cam(1 - 1e-9),
      after = cam(1);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.s).toBeCloseTo(before.s, 6);
    expect(cam(3)).toEqual({ x: 700, y: 540, s: 1.5 });
    expect(cam(3, 1.2).s).toBeCloseTo(1.8, 9);
    // the same t gives the same view, whatever was asked for before
    const a = cam(1.4);
    cam(0.2);
    expect(cam(1.4)).toEqual(a);
  });
});

const TIMING = {
  total: 3,
  bpm: 120,
  scenes: [
    { id: "intro", name: "Intro", start: 0, dur: 1.5, speech: 1 },
    { id: "close", name: "Close", start: 1.5, dur: 1.5, speech: 1 },
  ],
};

// A board and a word inside the camera's layer, and a title outside it. The camera pushes in 2.5
// times: the board then runs off every edge, and the word, at rest inside the frame, is cut by its
// right edge.
function film(word: boolean): string {
  const work = tempDir("mr-camera-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
  mkdirSync(join(work, "audio"));
  writeFileSync(join(work, "audio", "hits.json"), JSON.stringify({ bpm: 120, bar: 2, hits: [] }));
  const dir = writeKit(work);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script>
<script src="kit/player.js"></script><script src="kit/beat.js"></script><script src="kit/fx.js"></script>
<style>
  body { background: #0b1622; color: #e9f0f7; }
  #cam { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }
  #board { position: absolute; left: 400px; top: 200px; width: 1100px; height: 680px; background: #1d3a52; }
  #tag { position: absolute; left: 1256px; top: 600px; margin: 0; font-size: 40px; white-space: nowrap; }
  #title { position: absolute; left: 144px; top: 900px; margin: 0; font-size: 56px; }
</style></head>
<body><div id="root">
  <div id="cam" class="layer-bg"><div id="board" class="layer-card"></div>${
    word ? '<p id="tag" class="layer-caption">ラベルの文字</p>' : ""
  }</div>
  <p id="title" class="layer-caption">寄って見る</p>
</div>
<script>
  var cam = fx.camera("#cam", [{ t: 0.4, s: 2.5, dur: 0.6 }]);
  film.draw(function (t) { cam(t); });
</script>
</body></html>`
  );
  return dir;
}

describe("a film with a camera", () => {
  it("draws the same frame after seeking back, and lets the shapes it pushes past run off the frame", async () => {
    const f = await openFilm(film(false));
    try {
      const a = await f.frame(0.7);
      expect((await f.frame(2)).equals(a)).toBe(false);
      expect((await f.frame(0.7)).equals(a)).toBe(true);
      expect(await checkLayout(f)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("still stops a word it leaves cut by the frame", async () => {
    const f = await openFilm(film(true));
    try {
      const issues = ((await checkLayout(f)) ?? []).map(formatIssue);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/s: #tag "ラベルの文字" is cut off by the frame$/);
    } finally {
      await f.close();
    }
  });
});
