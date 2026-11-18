// Skipping the layout check of a film that passed and has not changed (#94).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  filmHash,
  passedUnchanged,
  recordPass,
} from "../skills/motion-render/scripts/layoutcache.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "skills", "motion-render", "scripts", "cli.ts");

function film(): string {
  const dir = tempDir("mr-cache-");
  mkdirSync(join(dir, "kit"));
  writeFileSync(join(dir, "index.html"), "<p>a</p>");
  writeFileSync(join(dir, "kit", "timing.js"), "window.__timing = {};");
  return dir;
}

describe("the layout record", () => {
  it("says when an unchanged film passed, and forgets it when any file of the film changes", () => {
    const dir = film();
    expect(passedUnchanged(dir)).toBeNull();
    recordPass(dir, new Date(2026, 10, 18, 1, 40, 25));
    expect(passedUnchanged(dir)).toBe("01:40:25");
    writeFileSync(join(dir, "kit", "timing.js"), "window.__timing = { total: 2 };");
    expect(passedUnchanged(dir)).toBeNull();
  });

  it("leaves its own record out of the hash", () => {
    const dir = film();
    const before = filmHash(dir);
    recordPass(dir);
    expect(filmHash(dir)).toBe(before);
  });
});

describe("the check command with the record", () => {
  it("skips a whole film that passed and has not changed, but not a scene file", () => {
    const work = tempDir("mr-cache-");
    writeFileSync(
      join(work, "timing.json"),
      JSON.stringify({
        total: 1,
        scenes: [{ id: "intro", name: "Intro", start: 0, dur: 1, speech: 0.5 }],
      })
    );
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    run("kit", work);
    const dir = join(work, "film");
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script></head>
<body><div id="root"><!-- scenes --></div></body></html>`
    );
    mkdirSync(join(dir, "scenes"));
    writeFileSync(
      join(dir, "scenes", "01-intro.html"),
      `<section class="scene" id="intro"></section>`
    );
    expect(run("check", dir)).not.toContain("unchanged");
    expect(run("check", dir)).toContain("unchanged since");
    expect(run("check", dir, "01-intro.html")).not.toContain("unchanged");
  });
});
