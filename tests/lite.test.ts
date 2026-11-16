// The /motion-render:lite guide points into the full skill's docs by section name and runs the same
// CLI, so a renamed section or command would leave it pointing at nothing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SKILLS = join(import.meta.dirname, "..", "skills");
const LITE = readFileSync(join(SKILLS, "lite", "SKILL.md"), "utf8");
const FULL = readFileSync(join(SKILLS, "motion-render", "SKILL.md"), "utf8");
const FILM = readFileSync(join(SKILLS, "motion-render", "references", "html-film.md"), "utf8");
const CLI = join(SKILLS, "motion-render", "scripts", "cli.ts");

const headings = (md: string): string[] => [...md.matchAll(/^#+ (.+)$/gm)].map((m) => m[1]!.trim());

// 「0. 準備」 names the heading "0. 準備（毎回、最初に確かめる）" too.
const hasSection = (md: string, name: string): boolean =>
  headings(md).some((h) => h === name || h.startsWith(`${name}（`));

// The 「…」 names on the lines that mention `marker`.
function sectionsNamed(marker: string): string[] {
  return LITE.split("\n")
    .filter((line) => line.includes(marker))
    .flatMap((line) => [...line.matchAll(/「([^」]+)」/g)].map((m) => m[1]!));
}

function frontmatter(md: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
  );
}

describe("the lite skill", () => {
  it("is named after its folder, so the plugin offers it as /motion-render:lite", () => {
    const meta = frontmatter(LITE);
    expect(meta.name).toBe("lite");
    expect(meta.description).toMatch(/\/motion-render を使う/);
  });

  it("points only at sections that exist in html-film.md", () => {
    const names = sectionsNamed("html-film.md");
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => !hasSection(FILM, n))).toEqual([]);
  });

  it("points only at sections that exist in the full skill", () => {
    const names = sectionsNamed("<full>/SKILL.md");
    expect(names).toContain("0. 準備");
    expect(names.filter((n) => !hasSection(FULL, n))).toEqual([]);
  });

  it("points only at its own sections when it says 下の", () => {
    const names = [...LITE.matchAll(/下の「([^」]+)」/g)].map((m) => m[1]!);
    expect(names.filter((n) => !hasSection(LITE, n))).toEqual([]);
  });

  it("runs only commands the CLI has", () => {
    const usage = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
    const commands = new Set([...LITE.matchAll(/motion-render (\w+) </g)].map((m) => m[1]!));
    expect(commands.size).toBeGreaterThan(5);
    expect([...commands].filter((c) => !usage.includes(`motion-render ${c} `))).toEqual([]);
  });

  it("keeps the beat-sync fields out of its script.json", () => {
    const shape = /```json\n([\s\S]*?)```/.exec(LITE)?.[1] ?? "";
    expect(shape).not.toMatch(/"bpm"|"section"|"score"/);
  });
});
