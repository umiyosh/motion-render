// Kinetic typography timed by the narration (kit/type.js, #60): text that comes in (film.say), is
// marked (film.mark), is replaced (film.swap) or counts up (film.count) as the narration says a word,
// and a line that lights up with the voice (film.karaoke). Every way passes layout and seek-back.
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadScript, writeTiming } from "../skills/motion-render/scripts/work.ts";
import { pageWords } from "../skills/motion-render/scripts/words.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { openFilm, type Film } from "../skills/motion-render/scripts/render.ts";
import type { LayoutBox } from "../skills/motion-render/scripts/layout.ts";
import { findFfmpeg } from "../skills/motion-render/scripts/audio.ts";
import { pcmWav, spoken, workDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "skills", "motion-render", "scripts", "cli.ts");
const FRAME = 1 / 60;
const ENTER = [
  "rise",
  "fade",
  "blur",
  "track",
  "pop",
  "slam",
  "flip",
  "wipe",
  "box",
  "assemble",
  "write",
  "scramble",
];

const SCRIPT = {
  bgm: "x",
  scenes: [
    { id: "intro", narration: "はじめに、動く。" },
    { id: "drop", narration: "一打で着く。" },
  ],
};

// A work whose intro says はじめに at 0.2-1.0 s and 動く at 1.25-2.05 s into its WAV.
function work(): string {
  const w = workDir(SCRIPT);
  writeFileSync(join(w, "audio", "intro.wav"), pcmWav(spoken([0.2, 0.8, 0.25, 0.8])));
  writeFileSync(join(w, "audio", "drop.wav"), pcmWav(spoken([0.2, 0.7], 5)));
  return w;
}

// A page with #t (and #n, a number) in the intro, running `code` in film.build.
const page = (code: string, text = "動く") => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script>
<script src="kit/player.js"></script><script src="kit/type.js"></script>
<style>body { background: #0b1622; color: #e9f0f7; }
  #t { position:absolute; left:0; right:0; top:360px; text-align:center; font-size:140px; font-weight:700; }
  #n { position:absolute; left:0; right:0; top:700px; text-align:center; font-size:90px; font-weight:700; }</style>
</head><body><div id="root">
  <section class="scene" id="intro"><h1 id="t">${text}</h1><p id="n" class="num">1,200</p></section>
  <section class="scene" id="drop"></section>
</div>
<script>
  film.build(function (tl) { ${code} });
</script></body></html>`;

// The film dir of a work with the page, and the film time at which the narration says 動く, shown
// 8 ms early (the intro starts at 0 s).
function film(code: string, text?: string): { dir: string; at: number } {
  const w = work();
  const script = loadScript(w);
  const timing = writeTiming(w, script);
  const dir = writeKit(w);
  writeFileSync(join(dir, "index.html"), page(code, text));
  return { dir, at: pageWords(w, script, timing).intro!.at![5]! - 0.008 };
}

async function withFilm<T>(dir: string, fn: (f: Film) => Promise<T>): Promise<T> {
  const f = await openFilm(dir);
  try {
    return await fn(f);
  } finally {
    await f.close();
  }
}

const boxes = async (f: Film, t: number): Promise<LayoutBox[]> => (await f.inspect?.(t)) ?? [];
// Whether anything of the word is drawn: its characters or the bar that reveals it.
const drawn = async (f: Film, t: number): Promise<number> =>
  (await boxes(f, t)).filter((b) => /^span\.(type-char|kt-box)/.test(b.label)).length;

// How many pixels of two PNG frames differ clearly in brightness: a glyph is thousands, the way
// two pages composite the same text is a handful.
// ffmpeg runs without blocking the worker, which must keep answering vitest while it decodes.
async function differ(a: Buffer, b: Buffer): Promise<number> {
  const gray = (png: Buffer) =>
    new Promise<Buffer>((ok, fail) => {
      const args = ["-v", "error", "-i", "-", "-f", "rawvideo", "-pix_fmt", "gray", "-"];
      const p = spawn(findFfmpeg(), args);
      const out: Buffer[] = [];
      p.stdout.on("data", (c: Buffer) => out.push(c));
      p.on("error", fail);
      p.on("close", (code) =>
        code === 0 ? ok(Buffer.concat(out)) : fail(new Error(`ffmpeg exited with ${code}`))
      );
      p.stdin.end(png);
    });
  const [x, y] = await Promise.all([gray(a), gray(b)]);
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]! - y[i]!) > 64) n++;
  return n;
}

const passesCheck = (dir: string): void => {
  const r = spawnSync(process.execPath, [CLI, "check", dir], { encoding: "utf8" });
  expect(r.stdout + r.stderr).toContain("layout ok");
  expect(r.status).toBe(0);
};

describe("film.say", () => {
  for (const how of ENTER) {
    it(`brings the word in ("${how}") within a frame of when the narration says it`, async () => {
      const { dir, at } = film(`film.say(tl, "#t", "intro", "動く", { how: "${how}" });`);
      await withFilm(dir, async (f) => {
        expect(await drawn(f, at - FRAME)).toBe(0);
        expect(await drawn(f, at + FRAME)).toBeGreaterThan(0);
        const settled = (await boxes(f, at + 1)).filter((b) =>
          b.label.startsWith("span.type-char")
        );
        expect(settled.map((b) => b.label)).toEqual(['span.type-char "動"', 'span.type-char "く"']);
        expect(await f.warnings()).toEqual([]);
      });
    });
  }

  it("lets every character of a scramble settle on its own glyph, the last one too", async () => {
    // 4 glyphs: the last settles at 0.45 + 3 × 0.05 = 0.6000000000000001 s, which GSAP rendered as
    // 0.6, so it kept its stand-in to the end of the scene. Kana, as a Latin run is one glyph
    const text = "音ハメだ";
    const a = film(`film.say(tl, "#t", "intro", "動く", { how: "scramble" });`, text);
    const fade = film(`film.say(tl, "#t", "intro", "動く", { how: "fade" });`, text);
    const end = a.at + 1; // both settled, still in the scene
    const [fa, fb] = [
      await withFilm(a.dir, (f) => f.frame(end)),
      await withFilm(fade.dir, (f) => f.frame(end)),
    ];
    expect(await differ(fa, fb)).toBeLessThan(50);
  });

  it("keeps every character where it settles while the scramble runs", async () => {
    const { dir, at } = film(`film.say(tl, "#t", "intro", "動く", { how: "scramble" });`);
    const xs = (bs: LayoutBox[]) =>
      bs.filter((b) => b.label.startsWith("span.type-char")).map((b) => Math.round(b.x));
    await withFilm(dir, async (f) => {
      const running = xs(await boxes(f, at + 0.1));
      expect(running).toHaveLength(2);
      expect(running).toEqual(xs(await boxes(f, at + 1)));
    });
  });

  it("draws a caret while it writes, and none once it has blinked out", async () => {
    const write = (cursor: boolean) =>
      film(`film.say(tl, "#t", "intro", "動く", { how: "write", cursor: ${cursor} });`);
    const plain = write(false),
      caret = write(true);
    const frames = (dir: string) =>
      withFilm(dir, async (f) => [await f.frame(plain.at + FRAME), await f.frame(plain.at + 1.2)]);
    const [a, b] = [await frames(plain.dir), await frames(caret.dir)];
    expect(a[0]!.equals(b[0]!)).toBe(false); // the caret after 動
    expect(a[1]!.equals(b[1]!)).toBe(true); // gone after its blinks
  });

  it("starts the characters in the order asked for", async () => {
    const { dir, at } = film(
      `film.say(tl, "#t", "intro", "動く", { how: "write", from: "end", stagger: 0.2 });`
    );
    await withFilm(dir, async (f) => {
      const first = (await boxes(f, at + 0.1)).filter((b) => b.label.startsWith("span.type-char"));
      expect(first.map((b) => b.label)).toEqual(['span.type-char "く"']);
    });
  });

  it("passes the check command (layout, and the same frames after seeking back) in every way", () => {
    for (const how of ENTER)
      passesCheck(
        film(`film.say(tl, "#t", "intro", "動く", { how: "${how}", cursor: true });`).dir
      );
  });

  it("refuses an unknown way, and a word the narration does not say", async () => {
    for (const [code, error] of [
      [`film.say(tl, "#t", "intro", "動く", { how: "wiggle" });`, /o\.how must be one of "rise"/],
      [`film.say(tl, "#t", "intro", "止まる");`, /does not say "止まる"/],
      [`film.say(tl, "#t", "intro", "動く", { from: "middle" });`, /o\.from must be/],
    ] as const)
      await expect(openFilm(film(code).dir)).rejects.toThrow(error);
  });
});

describe("film.mark", () => {
  for (const how of ["highlight", "underline", "strike"]) {
    it(`draws the ${how} as the narration says the word`, async () => {
      const { dir, at } = film(`film.mark(tl, "#t", "intro", "動く", { how: "${how}" });`);
      await withFilm(dir, async (f) => {
        const mark = async (t: number) =>
          (await boxes(f, t)).filter((b) => b.label.startsWith(`span.kt-${how}`)).length;
        expect(await mark(at - FRAME)).toBe(0);
        expect(await mark(at + 0.6)).toBe(1);
      });
    });
  }

  it("passes the check command in every way", () => {
    for (const how of ["highlight", "underline", "strike", "circle", "color", "bump"])
      passesCheck(film(`film.mark(tl, "#t", "intro", "動く", { how: "${how}" });`).dir);
  });
});

describe("film.swap", () => {
  for (const how of ["roll", "wipe", "blur", "cut"]) {
    it(`replaces the text ("${how}") as the narration says the word`, async () => {
      const { dir, at } = film(`film.swap(tl, "#t", "intro", "動く", "着く", { how: "${how}" });`);
      await withFilm(dir, async (f) => {
        const texts = async (t: number) =>
          (await boxes(f, t)).map((b) => b.label).filter((l) => /"(動く|着く)"/.test(l));
        expect(await texts(at - FRAME)).toEqual(['span "動く"']);
        expect(await texts(at + 1)).toEqual(['span "着く"']);
      });
      passesCheck(dir);
    });
  }
});

describe("film.count", () => {
  it("counts up to the number written, as the narration says the word", async () => {
    const { dir, at } = film(`film.count(tl, "#n", "intro", "動く");`);
    await withFilm(dir, async (f) => {
      const shown = async (t: number) =>
        (await boxes(f, t)).find((b) => b.label.startsWith("#n"))?.label.match(/"(.*)"/)?.[1];
      expect(await shown(at - FRAME)).toBe("0");
      const mid = Number((await shown(at + 0.3))?.replace(/,/g, ""));
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1200);
      expect(await shown(at + 1)).toBe("1,200");
    });
    passesCheck(dir);
  });
});

describe("film.karaoke", () => {
  it("lights each character as the voice reaches it", async () => {
    const { dir, at } = film(`film.karaoke(tl, "#t", "intro");`, "はじめに、動く。");
    await withFilm(dir, async (f) => {
      // dimmed text has no contrast to measure; a lit character has one
      const lit = async (t: number, ch: string) =>
        (await boxes(f, t)).find((b) => b.label === `span.type-char "${ch}"`)?.text?.contrast !==
        null;
      expect(await lit(at - 0.2, "は")).toBe(true);
      expect(await lit(at - 0.2, "動")).toBe(false);
      expect(await lit(at + 0.3, "動")).toBe(true);
    });
    passesCheck(dir);
  });
});

// Every way of every tool, as the code that runs it.
const EVERY = [
  ...ENTER.map((how) => `film.say(tl, "#t", "intro", "動く", { how: "${how}", cursor: true });`),
  ...["left", "down", "up"].map(
    (dir) => `film.say(tl, "#t", "intro", "動く", { how: "wipe", dir: "${dir}" });`
  ),
  ...["highlight", "underline", "strike", "circle", "color", "bump"].map(
    (how) => `film.mark(tl, "#t", "intro", "動く", { how: "${how}" });`
  ),
  ...["roll", "wipe", "blur", "cut"].map(
    (how) => `film.swap(tl, "#t", "intro", "動く", "着く", { how: "${how}" });`
  ),
  `film.count(tl, "#n", "intro", "動く");`,
];

describe("a frame in the middle of a move", () => {
  it("is the same drawn first and drawn again after seeking away, in every way", async () => {
    const differ: string[] = [];
    for (const code of EVERY) {
      const { dir, at } = film(code);
      const f = await openFilm(dir, { pages: 1 });
      try {
        for (const dt of [0.1, 0.25]) {
          const first = await f.frame(at + dt);
          await f.frame(at + 1.1);
          await f.frame(0.3);
          if (!first.equals(await f.frame(at + dt))) differ.push(`${code} at +${dt}`);
        }
      } finally {
        await f.close();
      }
    }
    expect(differ).toEqual([]);
  });
});

describe("film.mark circle", () => {
  it("is absent before the word, is drawn round over its time, and holds once drawn", async () => {
    const { dir, at } = film(`film.mark(tl, "#t", "intro", "動く", { how: "circle" });`);
    await withFilm(dir, async (f) => {
      const [early, before, a, b, c, done, later] = [
        await f.frame(at - 0.5),
        await f.frame(at - FRAME),
        await f.frame(at + 0.15),
        await f.frame(at + 0.3),
        await f.frame(at + 0.45),
        await f.frame(at + 0.7),
        await f.frame(at + 0.9),
      ];
      expect(early.equals(before)).toBe(true); // nothing of it before the word
      for (const [x, y] of [
        [before, a],
        [a, b],
        [b, c],
      ] as const)
        expect(x!.equals(y!)).toBe(false); // it grows
      expect(done.equals(later)).toBe(true); // and holds once drawn (it closes a little early: its length is taken generously)
    });
  });
});
