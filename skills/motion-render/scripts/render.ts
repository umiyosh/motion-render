// Motion のプレーヤーを headless Chromium で開き、任意の時刻のコマを PNG で返す。
// ブラウザは playwright-core の版に対応する Chromium を使い、無ければ初回に自動で取得する。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { chromium, type Browser, type LaunchOptions } from "playwright-core";
import { errorMessage, field, isRecord } from "./json.ts";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = join(dirname(require.resolve("playwright-core")), "cli.js");

const KIND: Partial<Record<string, string>> = {
  ".css": "css",
  ".html": "html",
  ".js": "js",
  ".json": "json",
  ".txt": "text",
};
const MIME: Partial<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};
const REQUIRED = [
  "index.html",
  "artifact-type/app.js",
  "artifact-type/app.css",
  "cut.js",
  "modules/scenes.json",
];

// The film's code is untrusted: no network, nothing outside the film dir, and Chromium's own
// sandbox stays on (Playwright turns it off by default).
const LAUNCH: LaunchOptions = {
  chromiumSandbox: true,
  args: [
    "--font-render-hinting=none",
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ],
};

interface FilmData {
  title: string;
  script: string;
  modules: { name: string; kind: string | undefined; text: string }[];
  assets: { name: string; mime: string | undefined; base64: string }[];
}

// A scene of the film as the player laid it out: key = scene id, a0 = start (s), dur = length (s).
interface FilmPart {
  key: string;
  a0: number;
  dur: number;
}

interface FilmMeta {
  duration: number;
  parts: FilmPart[];
}

export interface Film {
  meta: FilmMeta;
  frame(t: number): Promise<Buffer>;
  warnings(): Promise<string[]>;
  close(): Promise<void>;
}

declare global {
  interface Window {
    // The Motion player's hook. Its results come from the film's code, so they are read as unknown.
    __animation: {
      load(film: FilmData): unknown;
      frame(t: number, opts: { scale: number }): unknown;
      consoleLog(): unknown;
    };
  }
}

export function checkFilmDir(dir: string): void {
  const missing = REQUIRED.filter((f) => !existsSync(join(dir, f)));
  if (missing.length)
    throw new Error(
      `${dir} is not a film dir (missing: ${missing.join(", ")}). Run "motion-render prepare" first.`
    );
}

function readFilm(dir: string): FilmData {
  const ls = (d: string) => (existsSync(d) ? readdirSync(d) : []);
  return {
    title: "film",
    script: readFileSync(join(dir, "cut.js"), "utf8"),
    modules: ls(join(dir, "modules")).map((n) => ({
      name: n,
      kind: KIND[extname(n.replace(/~\d+$/, ""))],
      text: readFileSync(join(dir, "modules", n), "utf8"),
    })),
    assets: ls(join(dir, "assets")).map((n) => ({
      name: n,
      mime: MIME[extname(n).toLowerCase()],
      base64: readFileSync(join(dir, "assets", n)).toString("base64"),
    })),
  };
}

function parseMeta(meta: unknown): FilmMeta {
  const duration = field(meta, "duration");
  const parts = field(meta, "parts") ?? [];
  if (
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Array.isArray(parts)
  ) {
    throw new Error("the film player returned no valid duration or scene list");
  }
  return {
    duration,
    parts: parts.map((p: unknown) => {
      const key = field(p, "key"),
        a0 = field(p, "a0"),
        dur = field(p, "dur");
      if (typeof key !== "string" || typeof a0 !== "number" || typeof dur !== "number")
        throw new Error("the film player returned a malformed scene");
      return { key, a0, dur };
    }),
  };
}

async function launch(): Promise<Browser> {
  const opts: LaunchOptions = process.env.CHROMIUM_PATH
    ? { ...LAUNCH, executablePath: process.env.CHROMIUM_PATH }
    : LAUNCH;
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (opts.executablePath || !/Executable doesn't exist/.test(errorMessage(e))) throw e;
    console.error(
      "motion-render: downloading Chromium for this playwright-core version (first run only)..."
    );
    const r = spawnSync(process.execPath, [PLAYWRIGHT_CLI, "install", "chromium"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (r.status !== 0)
      throw new Error(
        "Chromium download failed. Set CHROMIUM_PATH to a local Chrome or Chromium instead."
      );
    return chromium.launch(opts);
  }
}

// Opens the film and returns its meta and a way to grab frames as PNG.
export async function openFilm(dir: string): Promise<Film> {
  checkFilmDir(dir);
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.context().addInitScript(() => {
      for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection"])
        Reflect.deleteProperty(globalThis, k);
    });
    let here: string | null = null;
    await page.context().route("**/*", (r) => {
      const u = r.request().url();
      if (!here && r.request().isNavigationRequest()) here = u.slice(0, u.lastIndexOf("/") + 1);
      return (here && u.startsWith(here)) || /^(data|blob):/.test(u) ? r.continue() : r.abort();
    });
    await page.goto(pathToFileURL(resolve(dir, "index.html")).href + "#tools");
    await page.waitForFunction(() => typeof window.__animation === "object");
    const res = await page.evaluate((f) => window.__animation.load(f), readFilm(dir));
    const error = field(res, "error");
    if (error) {
      const msg = field(error, "message");
      throw new Error(
        "film failed to load: " + (typeof msg === "string" && msg ? msg : String(error))
      );
    }
    const meta = parseMeta(field(res, "meta"));
    return {
      meta,
      async frame(t) {
        const url = await page.evaluate((tt) => window.__animation.frame(tt, { scale: 1 }), t);
        if (typeof url !== "string" || !url.includes(","))
          throw new Error(`the film player returned no frame at ${t}s`);
        return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      },
      async warnings() {
        const log = await page.evaluate(() => window.__animation.consoleLog());
        if (!Array.isArray(log)) return [];
        return log
          .filter((l: unknown) => isRecord(l) && l.level !== "log")
          .map((l: unknown) => `${String(field(l, "level"))}: ${String(field(l, "text"))}`);
      },
      close: () => browser.close(),
    };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
