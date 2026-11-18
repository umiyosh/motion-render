// Skips the layout check of a film that passed it and has not changed since (#94). check, preview and
// build each ran the whole check (8-25 s); a run in #87 ran it 13 times, most on a film it had just
// passed. The check runs on pages of its own and frames are drawn on new pages (#49), so skipping it
// changes no frame. The record is film/.layout-ok: the hash of every file of the film and of the
// check's own code, so a changed film or a new version of the check runs it again.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, readJson } from "./json.ts";

const RECORD = ".layout-ok";
const CHECK_CODE = ["layout.ts", "snapshot.js", "repeat.ts"].map((f) =>
  fileURLToPath(new URL(`./${f}`, import.meta.url))
);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === RECORD) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export function filmHash(filmDir: string): string {
  const h = createHash("sha256");
  for (const file of filesUnder(filmDir).sort()) {
    h.update(relative(filmDir, file));
    h.update(readFileSync(file));
  }
  for (const file of CHECK_CODE) h.update(readFileSync(file));
  return h.digest("hex");
}

// When the film passed the check as it is now, the time it passed; otherwise null.
export function passedUnchanged(filmDir: string): string | null {
  const file = join(filmDir, RECORD);
  if (!existsSync(file)) return null;
  const rec = readJson(file);
  if (!isRecord(rec) || typeof rec.hash !== "string" || typeof rec.at !== "string") return null;
  return rec.hash === filmHash(filmDir) ? rec.at : null;
}

export function recordPass(filmDir: string, now: Date = new Date()): void {
  const at = now.toTimeString().slice(0, 8);
  writeFileSync(join(filmDir, RECORD), JSON.stringify({ hash: filmHash(filmDir), at }) + "\n");
}
