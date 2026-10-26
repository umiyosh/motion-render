// Sets up <work>/film for an html film: the player, the stylesheets, GSAP, the Japanese fonts
// and the scene times. Claude writes <work>/film/index.html against these files.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadTiming } from "./work.ts";

const require = createRequire(import.meta.url);
const KIT = fileURLToPath(new URL("../kit/", import.meta.url));
// The weights the player loads (kit/player.js): Noto Sans JP for every film, Klee One for the
// hand-drawn styles of kit/styles.css.
const FONT_CSS = [
  require.resolve("@fontsource/noto-sans-jp/400.css"),
  require.resolve("@fontsource/noto-sans-jp/700.css"),
  require.resolve("@fontsource/klee-one/400.css"),
  require.resolve("@fontsource/klee-one/600.css"),
];

// Fontsource's CSS for one weight, cut down to woff2 files under fonts/ and font-display: block,
// so a frame is never drawn in a fallback font.
function fontCss(file: string, out: string): string {
  const files = join(dirname(file), "files");
  return readFileSync(file, "utf8")
    .replace(/font-display:\s*swap/g, "font-display: block")
    .replace(/,\s*url\([^)]*\.woff\) format\('woff'\)/g, "")
    .replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, (_, name: string) => {
      copyFileSync(join(files, name), join(out, "fonts", name));
      return `url(fonts/${name})`;
    });
}

// Rewrites kit/timing.js from timing.json. build runs this too, so the film always uses the
// scene times of the current narration.
export function writeKitTiming(work: string): void {
  const { total, scenes } = loadTiming(work);
  const data = { total, scenes: scenes.map(({ id, start, dur }) => ({ id, start, dur })) };
  writeFileSync(
    join(work, "film", "kit", "timing.js"),
    `window.__timing = ${JSON.stringify(data)};\n`
  );
}

export function writeKit(work: string): string {
  const film = join(work, "film");
  const kit = join(film, "kit");
  mkdirSync(join(kit, "fonts"), { recursive: true });
  for (const f of ["player.js", "base.css", "styles.css"]) copyFileSync(join(KIT, f), join(kit, f));
  const gsap = require.resolve("gsap/dist/gsap.min.js");
  copyFileSync(gsap, join(kit, basename(gsap)));
  writeFileSync(join(kit, "fonts.css"), FONT_CSS.map((f) => fontCss(f, kit)).join("\n"));
  writeKitTiming(work);
  writeFileSync(join(film, "film.json"), JSON.stringify({ kind: "html" }) + "\n");
  return film;
}
