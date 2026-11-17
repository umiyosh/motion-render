// film/kit/API.md (#93): the one page of what a film page can call. Every name the kit exports must be
// on it, so a function added to the kit without a line in references/html-film.md fails here.
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const KIT = join(import.meta.dirname, "..", "skills", "motion-render", "kit");

// The keys of the object a kit file assigns to window.<ns>.
function exported(file: string, ns: string): string[] {
  const lines = readFileSync(join(KIT, file), "utf8").split("\n");
  const at = lines.findIndex((l) => l.includes(`window.${ns} = {`));
  const keys: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^ {2}\};/.test(l)) break;
    const m = /^ {4}(\w+):/.exec(l);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

describe("the kit API page", () => {
  const work = tempDir("mr-api-");
  writeFileSync(
    join(work, "timing.json"),
    JSON.stringify({
      total: 2,
      scenes: [{ id: "intro", name: "Intro", start: 0, dur: 2, speech: 1 }],
    })
  );
  const page = readFileSync(join(writeKit(work), "kit", "API.md"), "utf8");

  it.each([
    ["film", "player.js"],
    ["fx", "fx.js"],
    ["beat", "beat.js"],
  ])("names every key of window.%s's object", (ns, file) => {
    const keys = exported(file, ns);
    expect(keys.length).toBeGreaterThan(10);
    expect(keys.filter((k) => !page.includes(`${ns}.${k}`))).toEqual([]);
  });

  it("lists the fonts with their weights, and how beat.ease.back is called", () => {
    expect(page).toContain("- 'Noto Sans JP': 400, 700");
    expect(page).toContain("- 'Klee One': 400, 600");
    expect(page).toContain("beat.ease.back(1.7)(p)");
  });
});
