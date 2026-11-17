// film/kit/API.md: one short page of everything the kit offers a film page (film, fx, beat) and the
// fonts it carries, so Claude reads the signatures once instead of the kit's source (#93). The tables
// are taken from references/html-film.md, so the page and the guide never disagree, and a test
// checks that every name the kit exports is in them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The table that follows the first line containing `marker` in the guide.
function tableAfter(lines: string[], marker: string): string[] {
  const at = lines.findIndex((l) => l.includes(marker));
  if (at < 0) throw new Error(`html-film.md has no "${marker}"`);
  const start = lines.findIndex((l, i) => i > at && l.startsWith("|"));
  const end = lines.findIndex((l, i) => i > start && !l.startsWith("|"));
  return lines.slice(start, end < 0 ? undefined : end);
}

// Each family in fonts.css with its weights, read from the file the kit wrote.
function fontsIn(css: string): string[] {
  const weights = new Map<string, Set<string>>();
  for (const m of css.matchAll(/font-family:\s*'?"?([^'";]+)'?"?;[^}]*?font-weight:\s*(\d+)/g)) {
    const set = weights.get(m[1]!) ?? new Set<string>();
    set.add(m[2]!);
    weights.set(m[1]!, set);
  }
  return [...weights].map(([family, w]) => `- '${family}': ${[...w].sort().join(", ")}`);
}

export function kitApiPage(skillDir: string, fontsCss: string): string {
  const guide = readFileSync(join(skillDir, "references", "html-film.md"), "utf8").split("\n");
  const section = (title: string, marker: string, note: string): string =>
    [`## ${title}`, "", note, "", ...tableAfter(guide, marker)].join("\n");
  return [
    "# kit API",
    "",
    "What the film page can call. Written by `motion-render kit` from references/html-film.md; do not edit.",
    "",
    section(
      "film (kit/player.js)",
      "プレーヤーが用意するもの",
      "Scene times, words, the GSAP timeline, and the helpers that place things on them."
    ),
    "",
    section(
      "fx (kit/fx.js)",
      "`kit/fx.js` が用意するもの",
      "Pure functions of their inputs. `fx.canvas(selector)` returns the canvas's 2D context, the size of the screen."
    ),
    "",
    section(
      "beat (kit/beat.js)",
      "`kit/beat.js` が用意するもの",
      "Values from the time alone, for `film.draw`. `beat.ease.back(s)` returns an easing: `beat.ease.back(1.7)(p)`."
    ),
    "",
    "## Fonts (kit/fonts.css)",
    "",
    ...fontsIn(fontsCss),
    "",
  ].join("\n");
}
