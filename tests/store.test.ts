import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare } from "../skills/motion-render/scripts/store.ts";
import { tempDir } from "./helpers.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "store");

describe("prepare", () => {
  it("writes each module's text, the cut script, and lists assets that are not inline", () => {
    const film = join(tempDir(), "film");
    const result = prepare(FIXTURE, film);

    expect(result).toEqual({ modules: ["base.css", "scenes.json"], blobs: ["logo.png"] });
    expect(readdirSync(join(film, "modules")).sort()).toEqual(["base.css", "scenes.json"]);
    expect(readFileSync(join(film, "modules", "base.css"), "utf8")).toBe("#stage { color: #fff }");
    expect(
      JSON.parse(readFileSync(join(film, "modules", "scenes.json"), "utf8")).scenes
    ).toHaveLength(2);
    expect(readFileSync(join(film, "cut.js"), "utf8")).toBe("window.CUT = kit.scenes();");
  });

  it("uses the default cut when the store has no film script", () => {
    const store = tempDir();
    mkdirSync(join(store, "modules"));
    writeFileSync(join(store, "modules", "scenes.json.json"), JSON.stringify({ text: "{}" }));
    const film = join(tempDir(), "film");
    expect(prepare(store, film)).toEqual({ modules: ["scenes.json"], blobs: [] });
    expect(readFileSync(join(film, "cut.js"), "utf8")).toBe("window.CUT = kit.scenes();");
  });

  it("fails without modules, and names a module that has no text", () => {
    const store = tempDir();
    expect(() => prepare(store, join(store, "film"))).toThrow(/no modules under/);
    mkdirSync(join(store, "modules"));
    writeFileSync(join(store, "modules", "a.js.json"), JSON.stringify({ data: { code: "x" } }));
    expect(() => prepare(store, join(store, "film"))).toThrow(/a\.js\.json has no "text"/);
  });

  it("names a film script that has no code", () => {
    const store = tempDir();
    mkdirSync(join(store, "modules"));
    mkdirSync(join(store, "film"));
    writeFileSync(join(store, "modules", "a.js.json"), JSON.stringify({ text: "x" }));
    writeFileSync(join(store, "film", "script.json"), JSON.stringify({ data: {} }));
    expect(() => prepare(store, join(store, "film-out"))).toThrow(/script\.json has no "code"/);
  });
});
