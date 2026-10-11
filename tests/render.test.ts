// Smoke tests in headless Chromium against a stub of the Motion player (tests/fixtures/player).
import { describe, expect, it } from "vitest";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { checkFilmDir, openFilm } from "../skills/motion-render/scripts/render.ts";
import { prepare } from "../skills/motion-render/scripts/store.ts";
import { tempDir } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const CLI = join(import.meta.dirname, "..", "skills", "motion-render", "scripts", "cli.ts");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function filmDir(): string {
  const dir = join(tempDir(), "film");
  prepare(join(FIXTURES, "store"), dir);
  cpSync(join(FIXTURES, "player"), dir, { recursive: true });
  return dir;
}

describe("openFilm", () => {
  it("loads the film, reads its scene layout, draws frames, and keeps the film off the network", async () => {
    const film = await openFilm(filmDir());
    try {
      expect(film.meta).toEqual({
        duration: 3.5,
        parts: [
          { key: "intro", a0: 0, dur: 1.5 },
          { key: "flow", a0: 1.5, dur: 2 },
        ],
      });
      const first = await film.frame(0.5);
      const second = await film.frame(2);
      expect(first.subarray(0, 4)).toEqual(PNG);
      expect(second.equals(first)).toBe(false);
      expect(await film.warnings()).toEqual(["warn: network: blocked"]);
    } finally {
      await film.close();
    }
  });

  it("reports a film that fails to load", async () => {
    const dir = filmDir();
    writeFileSync(join(dir, "cut.js"), "FAIL");
    await expect(openFilm(dir)).rejects.toThrow("film failed to load: cut.js threw");
  });

  it("asks for prepare when the film dir is incomplete", () => {
    expect(() => checkFilmDir(tempDir())).toThrow(
      /is not a film dir \(missing: index\.html.*Run "motion-render prepare"/
    );
  });
});

describe("motion-render command", () => {
  it("prepares a film from the store and writes stills, as the skill runs it", () => {
    const work = tempDir();
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    expect(run("prepare", join(FIXTURES, "store"), join(work, "film"))).toContain(
      "modules: base.css, scenes.json"
    );
    cpSync(join(FIXTURES, "player"), join(work, "film"), { recursive: true });
    expect(run("stills", join(work, "film"), join(work, "stills"), "0.5,2")).toContain(
      "done: 2 stills"
    );
    expect(readdirSync(join(work, "stills")).sort()).toEqual(["t_0.50.png", "t_2.00.png"]);
    expect(readFileSync(join(work, "stills", "t_2.00.png")).subarray(0, 4)).toEqual(PNG);
    expect(existsSync(join(work, "film", "cut.js"))).toBe(true);
  });

  it("prints its version and rejects unknown commands with usage", () => {
    const version = JSON.parse(readFileSync(join(CLI, "..", "..", "package.json"), "utf8")).version;
    expect(execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).trim()).toBe(
      version
    );
    expect(() => execFileSync(process.execPath, [CLI, "nope"], { stdio: "pipe" })).toThrow(
      /unknown command or wrong arguments/
    );
  });
});
