// A face a film uses only on a canvas (#90): no element of the page uses it, so the browser would not
// load it; the player loads every face the page names before the first frame.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

// The text is drawn only when the face is already in, and only in the first scene.
const PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<script src="kit/beat.js"></script><script src="kit/fx.js"></script>
<style>#cv { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }</style>
</head><body><div id="root"><canvas id="cv"></canvas></div>
<script>
  var ctx = fx.canvas("#cv");
  film.draw(function (t) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#f4f2ec";
    ctx.fillRect(0, 0, 1920, 1080);
    if (t < 1 && document.fonts.check("600 96px 'Klee One'", "要点")) {
      ctx.fillStyle = "#d23a2a";
      ctx.font = "600 96px 'Klee One', sans-serif";
      ctx.fillText("要点が絵になっていない", 200, 540);
    }
  });
</script>
</body></html>`;

describe("canvas text", () => {
  it("loads a face the page uses only on a canvas before the first frame", async () => {
    const work = tempDir("mr-canvas-font-");
    writeFileSync(
      join(work, "timing.json"),
      JSON.stringify({
        total: 2,
        scenes: [
          { id: "a", name: "A", start: 0, dur: 1, speech: 0.8 },
          { id: "b", name: "B", start: 1, dur: 1, speech: 0.8 },
        ],
      })
    );
    const dir = writeKit(work);
    writeFileSync(join(dir, "index.html"), PAGE);
    const film = await openFilm(dir);
    try {
      // The first frame has the hand-written text; the second is the bare paper.
      const text = await film.frame(0.5);
      expect(text.equals(await film.frame(1.5))).toBe(false);
      expect((await film.frame(0.5)).equals(text)).toBe(true);
    } finally {
      await film.close();
    }
  });
});
