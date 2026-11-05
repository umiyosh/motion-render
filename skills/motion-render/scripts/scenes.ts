// html の映像を場面のまとまりごとに分けて書くためのファイル（film/scenes/*.html）を、
// index.html の <!-- scenes --> の行に差し込んで、プレーヤーが開く 1 枚のページにする。
// 何人かの書き手（サブエージェント）が同時に別々の場面を書けるようにするため。
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "<!-- scenes -->";
const DIR = "scenes";

// The scene files of a film dir, in name order (01-title.html, 02-flow.html, ...).
function sceneFiles(dir: string): string[] {
  const d = join(dir, DIR);
  return existsSync(d)
    ? readdirSync(d)
        .filter((n) => n.endsWith(".html"))
        .sort()
    : [];
}

// The scene ids a scene file defines (<section class="scene" id="...">), in order.
export function sceneIds(html: string): string[] {
  const ids: string[] = [];
  for (const m of html.matchAll(/<section\b[^>]*>/g)) {
    const tag = m[0];
    if (!/\bclass="[^"]*\bscene\b[^"]*"/.test(tag)) continue;
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

export interface FilmPage {
  file: string; // the page to open, in the film dir so its relative paths still work
  ids: string[] | null; // scene ids of the files put in when only some were asked for
  close(): void;
}

let made = 0;

// The page a runner opens. Without scene files it is index.html itself. With them, it is a copy of
// index.html with every scene file (or only those in `only`) put in at the marker, under a name of
// this process's own, so writers checking their scenes at the same time never share one.
export function filmPage(dir: string, only: string[] = []): FilmPage {
  const index = join(dir, "index.html");
  const all = sceneFiles(dir);
  const unknown = only.filter((n) => !all.includes(n));
  if (unknown.length)
    throw new Error(`no such scene file in ${join(dir, DIR)}: ${unknown.join(", ")}`);
  if (!all.length) return { file: index, ids: null, close: () => {} };
  const html = readFileSync(index, "utf8");
  if (!html.includes(MARKER))
    throw new Error(
      `${index} has no "${MARKER}" line, so the files in ${join(dir, DIR)} have nowhere to go. ` +
        "Put it inside #root, after the parts that stay across scenes."
    );
  const picked = only.length ? only : all;
  const parts = picked.map((n) => readFileSync(join(dir, DIR, n), "utf8"));
  const file = join(dir, `.page-${process.pid}-${made++}.html`);
  writeFileSync(
    file,
    html.replace(MARKER, () => parts.join("\n"))
  );
  return {
    file,
    ids: only.length ? parts.flatMap(sceneIds) : null,
    close: () => rmSync(file, { force: true }),
  };
}
