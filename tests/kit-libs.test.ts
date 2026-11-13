// The kit's drawing libraries (three.js, fx, GSAP plugins) and the frame time under motion blur.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const TIMING = {
  total: 2,
  scenes: [
    { id: "intro", name: "Intro", start: 0, dur: 1, speech: 0.8 },
    { id: "deny", name: "Deny", start: 1, dur: 1, speech: 0.8 },
  ],
};

function filmOf(html: string): string {
  const work = tempDir("mr-fx-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
  const film = writeKit(work);
  writeFileSync(join(film, "index.html"), html);
  return film;
}

// A film drawn with the kit's libraries: a three.js cube on a spring, a noise field with grain on a
// canvas, and a title split into characters by SplitText.
const RICH_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/gsap/SplitText.min.js"></script>
<script src="kit/three.min.js"></script><script src="kit/timing.js"></script>
<script src="kit/player.js"></script><script src="kit/fx.js"></script>
<style>body { background: #101418; color: #f2efe8; }
canvas { position:absolute; left:0; top:0; width:1920px; height:1080px; }
#title { position:absolute; left:144px; top:120px; margin:0; font-size:96px; }</style></head>
<body><div id="root">
  <canvas id="bg" class="layer-bg" data-layout-ok></canvas>
  <canvas id="gl" class="layer-bg" data-layout-ok></canvas>
  <h1 id="title">氷の線</h1>
</div>
<script>
  gsap.registerPlugin(SplitText);
  var ctx = fx.canvas("#bg"), g = fx.three("#gl");
  var cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ color: 0xe8553a }));
  g.scene.add(cube);
  g.camera.position.set(0, 0, 8);
  film.build(function (tl) {
    var s = new SplitText("#title", { type: "chars" });
    tl.from(s.chars, { yPercent: 100, autoAlpha: 0, stagger: 0.05, duration: 0.4 }, 0.1);
  });
  film.draw(function (t) {
    var r = fx.rand(3);
    ctx.fillStyle = "#101418";
    ctx.fillRect(0, 0, 1920, 1080);
    for (var i = 0; i < 200; i++) {
      ctx.fillStyle = "rgba(120,160,220," + (0.3 + 0.3 * fx.noise(i / 9, t, 0)) + ")";
      ctx.fillRect(r() * 1920, r() * 1080, 8, 8);
    }
    fx.grain(ctx, t, 0.08);
    var x = fx.follow(t, [[0, 200], [0.5, 1400], [1, 800]]);
    var line = fx.boil([[x, 900], [x + 300, 960], [x + 600, 900]], t, 3);
    ctx.strokeStyle = "#f2efe8";
    ctx.beginPath();
    line.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.stroke();
    var at = fx.project(cube.position, g.camera);
    ctx.fillRect(at.x - 4, at.y - 4, 8, 8);
    cube.scale.setScalar(0.2 + fx.spring(t, 0.3));
    cube.rotation.set(t, t * 1.3, 0);
    g.render();
  });
</script></body></html>`;

describe("the kit's drawing libraries", () => {
  it("draws three.js, fx and GSAP plugins, the same frame twice, without warnings", async () => {
    const film = await openFilm(filmOf(RICH_PAGE));
    try {
      const a = await film.frame(1.2);
      expect((await film.frame(0.4)).equals(a)).toBe(false);
      expect((await film.frame(1.2)).equals(a)).toBe(true);
      expect(await film.warnings()).toEqual([]);
    } finally {
      await film.close();
    }
  });
});

describe("motion blur pictures", () => {
  it("give film.draw the time of their MP4 frame, so a count-up reads the same in each", async () => {
    const film = await openFilm(
      filmOf(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>body { background: #101418; color: #f2efe8; } #n { position:absolute; left:144px; top:120px; font-size:96px; }</style></head>
<body><div id="root"><p id="n" class="num">0</p></div>
<script>film.draw(function (t, frame) { document.getElementById("n").textContent = String(Math.round(frame * 100)); });</script>
</body></html>`)
    );
    try {
      const own = await film.frame(0.5);
      expect((await film.frame(0.52, 0.5)).equals(own)).toBe(true);
      expect((await film.frame(0.52)).equals(own)).toBe(false);
    } finally {
      await film.close();
    }
  });
});
