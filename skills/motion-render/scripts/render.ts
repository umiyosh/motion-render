// 映像（Motion のプレーヤー、または html の映像）を headless Chromium で開き、任意の時刻のコマを PNG で返す。
// ブラウザは playwright-core の版に対応する Chromium を使い、無ければ初回に自動で取得する。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { chromium, type Browser, type LaunchOptions, type Page } from "playwright-core";
import { errorMessage, field, isRecord, readJson } from "./json.ts";
import { parseBoxes, type LayoutBox } from "./layout.ts";
import { limit } from "./limit.ts";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CLI = join(dirname(require.resolve("playwright-core")), "cli.js");
const SNAPSHOT = fileURLToPath(new URL("snapshot.js", import.meta.url));
// A call into the film page takes well under a second. The page's code is not ours and can loop
// forever, and Playwright's evaluate never gives up on its own, so each call gets this limit.
const PAGE_MS = 60_000;

// Runs one call into the film page under the time limit, named for the error.
type Call = <T>(p: Promise<T>, what: string) => Promise<T>;

// Seconds as the error shows them: 0.3, not 0.30000000000000004.
const sec = (t: number) => String(+t.toFixed(3));

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
  // html films only: what paints on screen at t, for the layout check.
  inspect?(t: number): Promise<LayoutBox[]>;
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
    // An html film's hook: the page lays itself out at time t and the runner screenshots it.
    __film: {
      load(): unknown;
      seek(t: number): unknown;
      // Optional: false while the page is still settling. Polled from Node, since a film page may
      // control its own timers.
      ready?(): unknown;
    };
    // Added by snapshot.js for the layout check.
    __layoutSnapshot(): unknown;
  }
}

// A film dir is a Motion film unless its film.json says {"kind": "html"}.
export function isHtmlFilm(dir: string): boolean {
  const f = join(dir, "film.json");
  return existsSync(f) && field(readJson(f), "kind") === "html";
}

export function checkFilmDir(dir: string): void {
  const need = isHtmlFilm(dir) ? ["index.html"] : REQUIRED;
  const missing = need.filter((f) => !existsSync(join(dir, f)));
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

// Opens the film page with the network cut off: only files under the film dir and data:/blob: load.
async function openPage(browser: Browser): Promise<Page> {
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
  return page;
}

async function motionFilm(page: Page, dir: string, call: Call): Promise<Omit<Film, "close">> {
  await page.goto(pathToFileURL(resolve(dir, "index.html")).href + "#tools");
  await page.waitForFunction(() => typeof window.__animation === "object");
  const res = await call(
    page.evaluate((f) => window.__animation.load(f), readFilm(dir)),
    "__animation.load()"
  );
  const error = field(res, "error");
  if (error) {
    const msg = field(error, "message");
    throw new Error(
      "film failed to load: " + (typeof msg === "string" && msg ? msg : String(error))
    );
  }
  return {
    meta: parseMeta(field(res, "meta")),
    async frame(t) {
      const url = await call(
        page.evaluate((tt) => window.__animation.frame(tt, { scale: 1 }), t),
        `__animation.frame(${sec(t)})`
      );
      if (typeof url !== "string" || !url.includes(","))
        throw new Error(`the film player returned no frame at ${t}s`);
      return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    },
    async warnings() {
      const log = await call(
        page.evaluate(() => window.__animation.consoleLog()),
        "__animation.consoleLog()"
      );
      if (!Array.isArray(log)) return [];
      return log
        .filter((l: unknown) => isRecord(l) && l.level !== "log")
        .map((l: unknown) => `${String(field(l, "level"))}: ${String(field(l, "text"))}`);
    },
  };
}

async function waitReady(page: Page, call: Call): Promise<void> {
  const deadline = Date.now() + 30_000;
  const ready = () =>
    call(
      page.evaluate(() => !window.__film.ready || window.__film.ready() !== false),
      "__film.ready()"
    );
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error("the film page did not become ready in 30s");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function htmlFilm(page: Page, dir: string, call: Call): Promise<Omit<Film, "close">> {
  const log: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") log.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => log.push(`error: ${e.message}`));
  await page.goto(pathToFileURL(resolve(dir, "index.html")).href);
  await page.waitForFunction(() => typeof window.__film === "object");
  let meta: unknown;
  try {
    await waitReady(page, call);
    meta = await call(
      page.evaluate(() => window.__film.load()),
      "__film.load()"
    );
  } catch (e) {
    throw new Error("film failed to load: " + errorMessage(e));
  }
  let injected = false;
  const seek = async (t: number) => {
    await call(
      page.evaluate((tt) => window.__film.seek(tt), t),
      `__film.seek(${sec(t)})`
    );
    await waitReady(page, call);
  };
  return {
    meta: parseMeta(meta),
    async frame(t) {
      await seek(t);
      return call(page.screenshot({ type: "png" }), `screenshot at ${sec(t)}s`);
    },
    async inspect(t) {
      await seek(t);
      if (!injected) await call(page.addScriptTag({ path: SNAPSHOT }), "snapshot.js");
      injected = true;
      return parseBoxes(
        await call(
          page.evaluate(() => window.__layoutSnapshot()),
          `layout snapshot at ${sec(t)}s`
        )
      );
    },
    warnings: () => Promise.resolve(log),
  };
}

// Opens the film and returns its meta and a way to grab frames as PNG. Each call into the page
// fails after pageMs.
export async function openFilm(dir: string, pageMs = PAGE_MS): Promise<Film> {
  checkFilmDir(dir);
  const browser = await launch();
  const call: Call = (p, what) => limit(p, pageMs, `the film page's ${what}`);
  try {
    const page = await openPage(browser);
    const film = await (isHtmlFilm(dir) ? htmlFilm : motionFilm)(page, dir, call);
    return { ...film, close: () => browser.close() };
  } catch (e) {
    await browser.close();
    throw e;
  }
}
