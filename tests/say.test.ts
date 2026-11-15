// Text that lands with the spoken word (#60): film.say brings an element's text in when the
// narration starts saying a word, in each of its ways, and the page passes layout and seek-back.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadScript, writeTiming } from "../skills/motion-render/scripts/work.ts";
import { pageWords } from "../skills/motion-render/scripts/words.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { pcmWav, spoken, workDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "skills", "motion-render", "scripts", "cli.ts");
const FRAME = 1 / 60;

const SCRIPT = {
  bgm: "x",
  scenes: [
    { id: "intro", narration: "はじめに、動く。" },
    { id: "drop", narration: "一打で着く。" },
  ],
};

// A work whose intro says はじめに at 0.2-1.0 s and 動く at 1.25-2.05 s into its WAV.
function work(): string {
  const w = workDir(SCRIPT);
  writeFileSync(join(w, "audio", "intro.wav"), pcmWav(spoken([0.2, 0.8, 0.25, 0.8])));
  writeFileSync(join(w, "audio", "drop.wav"), pcmWav(spoken([0.2, 0.7], 5)));
  return w;
}

const page = (how: string) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>body { background: #0b1622; color: #e9f0f7; }
  #t { position:absolute; left:0; right:0; top:420px; text-align:center; font-size:140px; font-weight:700; }</style>
</head><body><div id="root">
  <section class="scene" id="intro"><h1 id="t">動く</h1></section>
  <section class="scene" id="drop"></section>
</div>
<script>
  film.build(function (tl) { film.say(tl, "#t", "intro", "動く", { how: "${how}" }); });
</script></body></html>`;

// The film dir of a work with the page, and the time film.say should bring the word in at.
function film(how: string): { dir: string; at: number } {
  const w = work();
  const script = loadScript(w);
  const timing = writeTiming(w, script);
  const dir = writeKit(w);
  writeFileSync(join(dir, "index.html"), page(how));
  const word = pageWords(w, script, timing).intro!.at![5]!; // 動, from the intro's start (0 s)
  return { dir, at: word - 0.008 };
}

describe("film.say", () => {
  for (const how of ["rise", "scramble", "write"]) {
    it(`brings the word in ("${how}") within a frame of when the narration says it`, async () => {
      const { dir, at } = film(how);
      const f = await openFilm(dir);
      try {
        const shown = async (t: number) =>
          ((await f.inspect?.(t)) ?? []).filter((b) => b.label.startsWith("span.type-char")).length;
        expect(await shown(at - FRAME)).toBe(0);
        expect(await shown(at + FRAME)).toBeGreaterThan(0);
        expect(await shown(at + 0.8)).toBe(2); // 動 and く, settled before the intro ends
        expect(await f.warnings()).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }

  it("keeps every character where it settles while the scramble runs", async () => {
    const { dir, at } = film("scramble");
    const f = await openFilm(dir);
    try {
      const xs = async (t: number) =>
        ((await f.inspect?.(t)) ?? [])
          .filter((b) => b.label.startsWith("span.type-char"))
          .map((b) => Math.round(b.x));
      const running = await xs(at + 0.1),
        settled = await xs(at + 0.8);
      expect(running).toHaveLength(2);
      expect(running).toEqual(settled);
    } finally {
      await f.close();
    }
  });

  it("draws the same frames after seeking back, and passes the check command", () => {
    for (const how of ["rise", "scramble", "write"]) {
      const { dir } = film(how);
      const r = spawnSync(process.execPath, [CLI, "check", dir], { encoding: "utf8" });
      expect(r.stdout + r.stderr).toContain("layout ok");
      expect(r.status).toBe(0);
    }
  });

  it("refuses an unknown way, and a word the narration does not say", async () => {
    for (const [how, word, error] of [
      ["fade", "動く", /o\.how must be "rise", "scramble" or "write"/],
      ["rise", "止まる", /does not say "止まる"/],
    ] as const) {
      const { dir } = film(how);
      writeFileSync(join(dir, "index.html"), page(how).replace('"動く", {', `"${word}", {`));
      await expect(openFilm(dir)).rejects.toThrow(error);
    }
  });
});
