// Sets up <work>/film for an html film: the player, the stylesheets (and the parts of parts.css), GSAP, the Japanese fonts
// and the scene times. Claude writes <work>/film/index.html against these files.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadTiming } from "./work.ts";
import { readJson } from "./json.ts";

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

// Rewrites kit/timing.js from timing.json, and the drum hits of the rendered score
// (audio/hits.json) when there is one. build runs this too, so the film always uses the scene times
// of the current narration and the hits of the current score.
export function writeKitTiming(work: string): void {
  const { total, scenes, bpm, end } = loadTiming(work);
  const data = {
    total,
    ...(bpm === undefined ? {} : { bpm, end }),
    scenes: scenes.map(({ id, name, start, dur, speech, section }) => ({
      id,
      name,
      start,
      dur,
      speech,
      ...(section ? { section } : {}),
    })),
  };
  const hitsFile = join(work, "audio", "hits.json");
  const hits = existsSync(hitsFile) ? JSON.stringify(readJson(hitsFile)) : "null";
  writeFileSync(
    join(work, "film", "kit", "timing.js"),
    `window.__timing = ${JSON.stringify(data)};\nwindow.__hits = ${hits};\n`
  );
}

// GSAP's plugins a film may load from kit/gsap/ (all free since GSAP 3.13). Each defines a global
// of its own name, to pass to gsap.registerPlugin.
const GSAP_PLUGINS = [
  "CustomEase",
  "CustomWiggle",
  "CustomBounce",
  "EasePack",
  "DrawSVGPlugin",
  "MorphSVGPlugin",
  "MotionPathPlugin",
  "SplitText",
  "ScrambleTextPlugin",
  "TextPlugin",
  "Physics2DPlugin",
  "Flip",
];

// three.js ships only as an ES module, and a page opened from file:// cannot import modules. The
// module is self-contained and ends in one export list, so it becomes a classic script that sets
// window.THREE.
function threeAsScript(src: string): string {
  const at = src.lastIndexOf("export{");
  if (at < 0) throw new Error("three.module.min.js: no export list at the end");
  const list = src.slice(at + "export{".length, src.lastIndexOf("}"));
  const pairs = list.split(",").map((p) => {
    const [local, name] = p.trim().split(/\s+as\s+/);
    return `${name ?? local}:${local}`;
  });
  return `(()=>{${src.slice(0, at)}window.THREE=Object.freeze({${pairs.join(",")}});})();\n`;
}

function copyLibraries(kit: string): void {
  const gsap = require.resolve("gsap/dist/gsap.min.js");
  copyFileSync(gsap, join(kit, basename(gsap)));
  mkdirSync(join(kit, "gsap"), { recursive: true });
  for (const p of GSAP_PLUGINS)
    copyFileSync(join(dirname(gsap), `${p}.min.js`), join(kit, "gsap", `${p}.min.js`));
  // The package exports only its entry points; the minified module sits next to the CommonJS one.
  const three = join(dirname(require.resolve("three")), "three.module.min.js");
  writeFileSync(join(kit, "three.min.js"), threeAsScript(readFileSync(three, "utf8")));
}

export function writeKit(work: string): string {
  const film = join(work, "film");
  const kit = join(film, "kit");
  mkdirSync(join(kit, "fonts"), { recursive: true });
  for (const f of ["player.js", "beat.js", "fx.js", "base.css", "styles.css", "parts.css"])
    copyFileSync(join(KIT, f), join(kit, f));
  copyLibraries(kit);
  writeFileSync(join(kit, "fonts.css"), FONT_CSS.map((f) => fontCss(f, kit)).join("\n"));
  writeKitTiming(work);
  writeFileSync(join(film, "film.json"), JSON.stringify({ kind: "html" }) + "\n");
  return film;
}
