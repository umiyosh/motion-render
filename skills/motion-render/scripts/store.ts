// Motion の映像データ（ArtifactData の out_dir に保存した store）を、描画できる film フォルダに展開する。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { field, readJson } from "./json.ts";

export interface Prepared {
  modules: string[];
  // Uploaded assets that are not inline data: URLs, so they must be copied into <film>/assets by hand.
  blobs: string[];
}

// A Motion store document is { data: {...} } or the bare object; returns the string field `key`.
function storeField(file: string, key: string): string | null {
  const d = readJson(file);
  const v = field(field(d, "data") ?? d, key);
  return typeof v === "string" ? v : null;
}

function requireField(file: string, key: string): string {
  const v = storeField(file, key);
  if (v === null) throw new Error(`${file} has no "${key}"`);
  return v;
}

const jsonNames = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : [];

export function prepare(storeDir: string, filmDir: string): Prepared {
  const modsDir = join(storeDir, "modules");
  const mods = jsonNames(modsDir);
  if (!mods.length) throw new Error(`no modules under ${modsDir}`);
  mkdirSync(join(filmDir, "modules"), { recursive: true });
  for (const n of mods) {
    writeFileSync(join(filmDir, "modules", n.slice(0, -5)), requireField(join(modsDir, n), "text"));
  }
  const script = join(storeDir, "film", "script.json");
  const cut = existsSync(script) ? requireField(script, "code") : "window.CUT = kit.scenes();";
  writeFileSync(join(filmDir, "cut.js"), cut);
  const assetsDir = join(storeDir, "assets");
  const blobs = jsonNames(assetsDir)
    .filter((n) => !String(storeField(join(assetsDir, n), "ref")).startsWith("data:"))
    .map((n) => n.slice(0, -5));
  return { modules: mods.map((n) => n.slice(0, -5)), blobs };
}
