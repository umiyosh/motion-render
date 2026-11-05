// Scene files: an html film written as index.html plus film/scenes/*.html, put together at its marker.
import { describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { checkLayout, formatIssue } from "../skills/motion-render/scripts/layout.ts";
import { filmPage, sceneIds } from "../skills/motion-render/scripts/scenes.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "skills", "motion-render", "scripts", "cli.ts");

const TIMING = {
  total: 2,
  scenes: [
    { id: "intro", name: "Intro", start: 0, dur: 1, speech: 0.8 },
    { id: "deny", name: "Deny", start: 1, dur: 1, speech: 0.8 },
  ],
};

// The shared page: head, palette and a part that stays across scenes. The scenes go in at the marker.
const INDEX = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>body { background: #0b1622; color: #e9f0f7; }</style></head>
<body><div id="root">
  <div id="stage"><p id="logo" class="layer-card" style="position:absolute; left:200px; top:900px; font-size:30px">ロゴ</p></div>
  <!-- scenes -->
</div></body></html>`;

const INTRO = `<style>#title { font-size: 80px; }</style>
<section class="scene" id="intro"><h1 id="title">条件</h1></section>
<script>
  film.build(function (tl) {
    tl.fromTo("#title", { opacity: 0 }, { opacity: 1, duration: 0.3 }, film.at("intro", 0.1));
  });
</script>`;

// A ✕ placed on its own, half under the box.
const DENY = `<section class="scene" id="deny">
  <div id="cond" class="layer-card" style="position:absolute; left:900px; top:290px; padding:16px; background:#0f1d31; font-size:30px">条件の箱</div>
  <div id="cross" style="position:absolute; left:868px; top:300px; font-size:64px">✕</div>
</section>`;

function sceneFilm(files: Record<string, string>, index = INDEX): string {
  const work = tempDir("mr-scenes-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
  const film = writeKit(work);
  writeFileSync(join(film, "index.html"), index);
  mkdirSync(join(film, "scenes"));
  for (const [name, html] of Object.entries(files)) writeFileSync(join(film, "scenes", name), html);
  return film;
}

describe("filmPage", () => {
  it("is index.html itself when there are no scene files", () => {
    const work = tempDir("mr-scenes-");
    expect(filmPage(work).file).toBe(join(work, "index.html"));
  });

  it("puts the scene files in at the marker in name order, and removes its copy on close", () => {
    const film = sceneFilm({ "02-deny.html": DENY, "01-intro.html": INTRO });
    const page = filmPage(film);
    const html = readdirSync(film).filter((n) => n.startsWith(".page-"));
    expect(html).toHaveLength(1);
    expect(page.ids).toBeNull();
    page.close();
    expect(readdirSync(film).filter((n) => n.startsWith(".page-"))).toEqual([]);
  });

  it("names a missing marker and an unknown scene file", () => {
    expect(() => filmPage(sceneFilm({ "01-intro.html": INTRO }, "<html></html>"))).toThrow(
      /has no "<!-- scenes -->" line/
    );
    expect(() => filmPage(sceneFilm({ "01-intro.html": INTRO }), ["03-end.html"])).toThrow(
      /no such scene file .*: 03-end\.html/
    );
  });

  it("reads the scene ids of a file", () => {
    expect(sceneIds(INTRO + DENY)).toEqual(["intro", "deny"]);
    expect(sceneIds('<section class="box" id="x"></section>')).toEqual([]);
  });
});

describe("a film in scene files", () => {
  it("draws like one page, and checks only the scenes of the files asked for", async () => {
    const film = sceneFilm({ "01-intro.html": INTRO, "02-deny.html": DENY });
    const whole = await openFilm(film);
    try {
      expect(whole.meta.duration).toBe(2);
      expect((await checkLayout(whole))?.map(formatIssue)).toEqual([
        `1.1-1.9s: #cond "条件の箱" and #cross "✕" partly overlap`,
      ]);
      expect(await whole.warnings()).toEqual([]);
    } finally {
      await whole.close();
    }
    const intro = await openFilm(film, { scenes: ["01-intro.html"] });
    try {
      expect(intro.only).toEqual(["intro"]);
      expect(await checkLayout(intro)).toEqual([]);
    } finally {
      await intro.close();
    }
    expect(readdirSync(film).filter((n) => n.startsWith(".page-"))).toEqual([]);
  });

  it("is checked by scene file with the check command", () => {
    const film = sceneFilm({ "01-intro.html": INTRO, "02-deny.html": DENY });
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    expect(run("check", film, "01-intro.html")).toContain("layout ok");
    expect(() => run("check", film, "02-deny.html")).toThrow(/#cross "✕" partly overlap/);
  });
});
