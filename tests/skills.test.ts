// The plugin has two skills on one CLI: /motion-render (a plain explainer in one pass) and
// /motion-render:rich (beat-synced). Both guides point into each other's sections and into
// html-film.md by name, so a renamed section or command would leave them pointing at nothing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SKILLS = join(import.meta.dirname, "..", "skills");
const PLAIN = readFileSync(join(SKILLS, "motion-render", "SKILL.md"), "utf8");
const RICH = readFileSync(join(SKILLS, "rich", "SKILL.md"), "utf8");
const FILM = readFileSync(join(SKILLS, "motion-render", "references", "html-film.md"), "utf8");
const CLI = join(SKILLS, "motion-render", "scripts", "cli.ts");

// Headings, and the bold labels that open a paragraph (**語りの決まり:**), which the guides also name.
const headings = (md: string): string[] => [
  ...[...md.matchAll(/^#+ (.+)$/gm)].map((m) => m[1]!.trim()),
  ...[...md.matchAll(/^\*\*([^*]+?):?\*\*/gm)].map((m) => m[1]!.trim()),
];

// 「0. 準備」 names the heading "0. 準備（毎回、最初に確かめる）" too.
const hasSection = (md: string, name: string): boolean =>
  headings(md).some((h) => h === name || h.startsWith(`${name}（`));

// The 「…」 names on the lines of `md` that mention `marker`.
function sectionsNamed(md: string, marker: string): string[] {
  return md
    .split("\n")
    .filter((line) => line.includes(marker))
    .flatMap((line) => [...line.matchAll(/「([^」]+)」/g)].map((m) => m[1]!));
}

const missing = (md: string, names: string[]): string[] => names.filter((n) => !hasSection(md, n));

function frontmatter(md: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
  );
}

const usage = (): string => execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });

describe("the two skills", () => {
  it("are named after their folders, so the plugin offers /motion-render and /motion-render:rich", () => {
    expect(frontmatter(PLAIN).name).toBe("motion-render");
    expect(frontmatter(RICH).name).toBe("rich");
  });

  it("each send the other's requests to the other", () => {
    expect(frontmatter(PLAIN).description).toMatch(/\/motion-render:rich を使う/);
    expect(frontmatter(RICH).description).toMatch(/\/motion-render を使う/);
  });

  it("point only at sections that exist in html-film.md", () => {
    const names = [...sectionsNamed(PLAIN, "html-film.md"), ...sectionsNamed(RICH, "html-film.md")];
    expect(names.length).toBeGreaterThan(5);
    expect(missing(FILM, names)).toEqual([]);
  });

  it("point only at sections that exist in each other", () => {
    const fromRich = sectionsNamed(RICH, "<base>/SKILL.md");
    expect(fromRich).toContain("0. 準備");
    expect(missing(PLAIN, fromRich)).toEqual([]);
    expect(missing(PLAIN, sectionsNamed(RICH, "`/motion-render` の"))).toEqual([]);
    expect(missing(RICH, sectionsNamed(FILM, "skills/rich/SKILL.md"))).toEqual([]);
  });

  it("point only at their own sections when they say 下の", () => {
    for (const md of [PLAIN, RICH]) {
      const names = [...md.matchAll(/下の「([^」]+)」/g)].map((m) => m[1]!);
      expect(missing(md, names)).toEqual([]);
    }
  });

  it("run only commands the CLI has", () => {
    const help = usage();
    for (const md of [PLAIN, RICH]) {
      const commands = new Set([...md.matchAll(/motion-render (\w+) </g)].map((m) => m[1]!));
      expect(commands.size).toBeGreaterThan(5);
      expect([...commands].filter((c) => !help.includes(`motion-render ${c} `))).toEqual([]);
    }
  });

  it("keep the beat-sync fields out of the plain script.json", () => {
    const shape = /```json\n([\s\S]*?)```/.exec(PLAIN)?.[1] ?? "";
    expect(shape).not.toMatch(/"bpm"|"section"|"score"/);
  });
});
