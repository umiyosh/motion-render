// html films in headless Chromium: the kit, scene times, frames, and the layout check.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { checkLayout, formatIssue } from "../skills/motion-render/scripts/layout.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { tempDir } from "./helpers.ts";

const CLI = join(import.meta.dirname, "..", "skills", "motion-render", "scripts", "cli.ts");

const TIMING = {
  total: 2,
  scenes: [
    { id: "intro", name: "Intro", start: 0, dur: 1, speech: 0.8 },
    { id: "deny", name: "Deny", start: 1, dur: 1, speech: 0.8 },
  ],
};

// The same with a deny scene long enough to breathe in.
const LONG = {
  total: 5,
  scenes: [TIMING.scenes[0]!, { ...TIMING.scenes[1]!, dur: 4 }],
};

// The scene of the WIF film that had the mistake: a token turned away at a condition box. With
// `wrong`, the ✕ is placed on its own and half of it ends up under the box.
// With `lively`, the chip flies to the dock on an arc and the condition box breathes, as
// references/html-film.md asks for.
function page(wrong: boolean, lively = false): string {
  const mark = wrong
    ? `<div id="cross" style="position:absolute; left:868px; top:300px; font-size:64px">✕</div>
       <div class="chip">OIDC トークン</div>`
    : `<div class="chip">OIDC トークン<span class="mark">✕</span></div>`;
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>
  body { background: #0b1622; color: #e9f0f7; }
  #cond { position:absolute; left:900px; top:290px; padding:16px; background:#0f1d31; border:3px solid #3ed6c4; font-size:30px; }
  .chip { position:absolute; left:400px; top:300px; padding:8px 20px; border:3px solid #ff6b6b; border-radius:30px; font-size:32px; }
  .mark { margin-left:16px; color:#ff6b6b; }
  #dock { position:absolute; left:1200px; top:600px; width:400px; height:160px; border:3px solid #2a4466; }
</style></head>
<body><div id="root">
  <section class="scene" id="intro"><h1 id="title" style="font-size:80px">条件</h1></section>
  <section class="scene" id="deny">
    <div id="cond" class="layer-card">assertion.repository == 'org/app'</div>
    <div id="dock" class="layer-card"></div>
    ${mark}
  </section>
</div>
<script>
  film.build(function (tl) {
    tl.fromTo("#title", { opacity: 0 }, { opacity: 1, duration: 0.3 }, film.at("intro", 0.1));
    ${
      lively
        ? `film.arc(tl, ".chip", "#dock", film.at("deny", 0.1), { dur: 0.6, lift: 150 });
    film.breathe(tl, "#cond", "deny", film.at("deny", 0), 0.01);`
        : `tl.to(".chip", { ...film.spot(".chip", "#dock"), duration: 0.3 }, film.at("deny", 0.1));`
    }
  });
</script>
</body></html>`;
}

// Small and faint text in the intro; in the deny scene a chip rests on a card's text for 0.3 s.
const TEXT_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>
  body { background: #0b1622; color: #e9f0f7; }
  #card { position:absolute; left:400px; top:300px; width:600px; height:200px; border:3px solid #2a4466; }
  #words { position:absolute; left:40px; top:80px; font-size:30px; }
  .chip { position:absolute; left:1300px; top:700px; padding:20px 60px; background:#3a1a22; font-size:32px; }
</style></head>
<body><div id="root">
  <section class="scene" id="intro">
    <p id="tiny" style="font-size:18px">出典</p>
    <p id="faint" style="color:#34465a; font-size:30px">薄い文字</p>
  </section>
  <section class="scene" id="deny">
    <div id="card"><span id="words">条件の文字</span></div>
    <div class="chip">チップ</div>
  </section>
</div>
<script>
  film.build(function (tl) {
    tl.to(".chip", { ...film.spot(".chip", "#words"), duration: 0.1 }, film.at("deny", 0));
    tl.to(".chip", { x: 0, y: 0, duration: 0.1 }, film.at("deny", 0.4));
  });
</script>
</body></html>`;

// An <svg> icon flies to a card, and inside a diagram drawn at twice its viewBox a dot moves onto a
// slot. #probe shows where the dot and the slot are on screen once the dot has arrived.
// `extra` goes into the root after the scenes.
function svgPage(extra = ""): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>
  body { background: #0b1622; color: #e9f0f7; }
  #ico { position:absolute; left:200px; top:200px; }
  #dock { position:absolute; left:1200px; top:600px; width:400px; height:160px; border:3px solid #2a4466; }
  #dia { position:absolute; left:300px; top:500px; }
  #probe { position:absolute; left:100px; top:900px; font-size:30px; }
</style></head>
<body><div id="root">
  <section class="scene" id="intro"><h1 style="font-size:80px">図</h1></section>
  <section class="scene" id="deny">
    <svg id="ico" width="60" height="60"><rect width="60" height="60" fill="#3ed6c4" /></svg>
    <div id="dock"></div>
    <svg id="dia" width="600" height="300" viewBox="0 0 300 150">
      <circle id="dot" cx="20" cy="20" r="10" fill="#ff6b6b" />
      <rect id="slot" x="200" y="100" width="40" height="30" fill="none" stroke="#2a4466" />
    </svg>
    <p id="probe"></p>
  </section>
  ${extra}
</div>
<script>
  film.build(function (tl) {
    tl.to("#ico", { ...film.spot("#ico", "#dock"), duration: 0.3 }, film.at("deny", 0.1));
    film.arc(tl, "#dot", "#slot", film.at("deny", 0.1), { dur: 0.3, lift: 40 });
    tl.call(function () {
      var c = function (s) {
        var r = document.querySelector(s).getBoundingClientRect();
        return Math.round(r.x + r.width / 2) + "," + Math.round(r.y + r.height / 2);
      };
      document.querySelector("#probe").textContent = c("#dot") + " " + c("#slot");
    }, null, film.at("deny", 0.6));
  });
</script>
</body></html>`;
}

function filmOf(html: string): string {
  const work = tempDir("mr-html-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
  const film = writeKit(work);
  writeFileSync(join(film, "index.html"), html);
  return film;
}

function htmlFilm(wrong: boolean, lively = false): string {
  const work = tempDir("mr-html-");
  writeFileSync(join(work, "timing.json"), JSON.stringify(lively ? LONG : TIMING));
  const film = writeKit(work);
  writeFileSync(join(film, "index.html"), page(wrong, lively));
  return film;
}

describe("html film", () => {
  it("takes scene times from timing.json and draws the same frame twice", async () => {
    const film = await openFilm(htmlFilm(false));
    try {
      expect(film.meta).toEqual({
        duration: 2,
        parts: [
          { key: "intro", a0: 0, dur: 1 },
          { key: "deny", a0: 1, dur: 1 },
        ],
      });
      const a = await film.frame(0.5);
      const b = await film.frame(1.5);
      expect(b.equals(a)).toBe(false);
      expect((await film.frame(0.5)).equals(a)).toBe(true);
      // film.spot sent the chip to the center of #dock.
      const boxes = (await film.inspect?.(1.9)) ?? [];
      const center = (l: string) => {
        const b = boxes.find((x) => x.label.startsWith(l));
        return b && [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];
      };
      expect(center("div.chip")).toEqual(center("#dock"));
      expect(await film.warnings()).toEqual([]);
    } finally {
      await film.close();
    }
  });

  it("finds the ✕ half under the condition box, and passes once the ✕ sits in its chip", async () => {
    const wrong = await openFilm(htmlFilm(true));
    try {
      expect((await checkLayout(wrong))?.map(formatIssue)).toEqual([
        `1.1-1.9s: #cond "assertion.repository == " and #cross "✕" partly overlap`,
      ]);
    } finally {
      await wrong.close();
    }
    const right = await openFilm(htmlFilm(false));
    try {
      expect(await checkLayout(right)).toEqual([]);
    } finally {
      await right.close();
    }
  });

  it("moves a chip on an arc, and still checks a box that breathes", async () => {
    const film = await openFilm(htmlFilm(true, true));
    try {
      // inspect seeks the page, so call it one time at a time.
      const box = async (t: number, l: string) =>
        ((await film.inspect?.(t)) ?? []).find((x) => x.label.startsWith(l));
      const center = async (t: number, l: string) => {
        const b = await box(t, l);
        return b ? [b.x + b.w / 2, b.y + b.h / 2] : [0, 0];
      };
      const [x0 = 0, y0 = 0] = await center(1, "div.chip");
      const [xm = 0, ym = 0] = await center(1.4, "div.chip");
      const [x1 = 0, y1 = 0] = await center(1.7, "div.chip");
      // Halfway along x, the chip is well above the straight line from start to dock.
      expect(xm).toBeGreaterThan(x0);
      expect(xm).toBeLessThan(x1);
      expect((y0 + y1) / 2 - ym).toBeGreaterThan(100);
      expect([x1, y1].map(Math.round)).toEqual((await center(1.7, "#dock")).map(Math.round));
      // #cond keeps breathing, yet the ✕ half under it is still reported.
      const w1 = (await box(1, "#cond"))?.w ?? 0;
      expect((await box(2.5, "#cond"))?.w ?? 0).toBeGreaterThan(w1 + 2);
      const issues = (await checkLayout(film))?.map(formatIssue) ?? [];
      expect(issues.some((i) => /#cond .* and #cross "✕" partly overlap/.test(i))).toBe(true);
    } finally {
      await film.close();
    }
  });

  it("reports small and faint text, and a chip resting on text for only 0.3 s", async () => {
    const work = tempDir("mr-html-");
    writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
    const dir = writeKit(work);
    writeFileSync(join(dir, "index.html"), TEXT_PAGE);
    const film = await openFilm(dir);
    try {
      const issues = ((await checkLayout(film)) ?? []).map(formatIssue);
      expect(issues).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/#tiny "出典" is 18px, smaller than 24px/),
          expect.stringMatching(/#faint "薄い文字" has contrast 1\.\d:1, needs 4\.5:1/),
          expect.stringMatching(/^1\.2-1\.4s: #words "条件の文字" is hidden under div\.chip/),
        ])
      );
    } finally {
      await film.close();
    }
  });

  it("fails to load with a pointer to the kit when the font is missing", async () => {
    const dir = htmlFilm(false);
    rmSync(join(dir, "kit", "fonts"), { recursive: true });
    await expect(openFilm(dir)).rejects.toThrow(/Noto Sans JP.*motion-render kit/);
  });

  it("is set up by the kit command, checked by the check command, and drawn by the stills command", () => {
    const work = tempDir("mr-html-");
    writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: "pipe" });
    expect(run("kit", work)).toContain("kit: ");
    expect(JSON.parse(readFileSync(join(work, "film", "film.json"), "utf8"))).toEqual({
      kind: "html",
    });
    expect(existsSync(join(work, "film", "kit", "gsap.min.js"))).toBe(true);
    writeFileSync(join(work, "film", "index.html"), page(true));
    expect(() => run("check", join(work, "film"))).toThrow(
      /#cond .* and #cross "✕" partly overlap/
    );
    writeFileSync(join(work, "film", "index.html"), page(false));
    expect(run("check", join(work, "film"))).toContain("layout ok");
    expect(run("stills", join(work, "film"), join(work, "stills"), "0.5,1.5")).toContain(
      "done: 2 stills"
    );
    expect(readdirSync(join(work, "stills")).sort()).toEqual(["t_0.50.png", "t_1.50.png"]);
  });
});

describe("film.spot and ids", () => {
  it("sends an <svg> icon and a shape inside a scaled diagram to their targets", async () => {
    const film = await openFilm(filmOf(svgPage()));
    try {
      const boxes = (await film.inspect?.(1.9)) ?? [];
      const box = (l: string) => boxes.find((x) => x.label.startsWith(l));
      const center = (l: string) => {
        const b = box(l);
        return b && [Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)];
      };
      expect(center("#ico")).toEqual(center("#dock"));
      // The slot's center is at (220, 115) in the viewBox, drawn at twice that from (300, 500).
      expect(box("#probe")?.label).toBe('#probe "740,730 740,730"');
    } finally {
      await film.close();
    }
  });

  it("fails to load when an id is used twice, as a chip named like its scene", async () => {
    await expect(openFilm(filmOf(svgPage('<div id="deny">チップ</div>')))).rejects.toThrow(
      /ids used more than once: deny\b/
    );
  });
});

describe("a stuck film page", () => {
  it("fails a frame whose seek never returns, naming the call and its time", async () => {
    const dir = htmlFilm(false);
    // From 1 s on, the page's seek spins forever, as a film with a bug in its own code could.
    const stuck = `<script>
      var seek = window.__film.seek;
      window.__film.seek = function (t) { if (t > 1) for (;;) {} return seek(t); };
    </script></body>`;
    const html = readFileSync(join(dir, "index.html"), "utf8").replace("</body>", stuck);
    writeFileSync(join(dir, "index.html"), html);
    const film = await openFilm(dir, { pageMs: 1000 });
    try {
      expect((await film.frame(0.5)).subarray(1, 4).toString()).toBe("PNG");
      await expect(film.frame(1.5)).rejects.toThrow(
        "the film page's __film.seek(1.5) did not finish in 1s"
      );
    } finally {
      await film.close();
    }
  });
});

describe("several pages", () => {
  it("draws the same frames and finds the same issues as one page", async () => {
    const dir = htmlFilm(true, true);
    const one = await openFilm(dir);
    const two = await openFilm(dir, { pages: 2 });
    try {
      expect(two.pages).toBe(2);
      const times = [0.5, 1.2, 1.5, 2.5, 3.5];
      const a = await Promise.all(times.map((t) => two.frame(t)));
      for (const [i, t] of times.entries()) expect(a[i]!.equals(await one.frame(t))).toBe(true);
      expect((await checkLayout(two))?.map(formatIssue)).toEqual(
        (await checkLayout(one))?.map(formatIssue)
      );
    } finally {
      await one.close();
      await two.close();
    }
  });
});

// A title that rises one character at a time with film.typeIn.
const TYPE_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>
  body { background: #0b1622; color: #e9f0f7; }
  #t { position:absolute; left:400px; top:300px; font-size:96px; font-weight:700; white-space:nowrap; }
</style></head>
<body><div id="root">
  <section class="scene" id="intro"><h1 id="t">ループ engineering</h1></section>
  <section class="scene" id="deny"></section>
</div>
<script>
  film.build(function (tl) {
    film.typeIn(tl, "#t", film.at("intro", 0.2));
  });
</script>
</body></html>`;

describe("film.typeIn", () => {
  it("raises a title one character at a time, keeping Latin words whole, with no layout issues", async () => {
    const work = tempDir("mr-html-");
    writeFileSync(join(work, "timing.json"), JSON.stringify(TIMING));
    const dir = writeKit(work);
    writeFileSync(join(dir, "index.html"), TYPE_PAGE);
    const film = await openFilm(dir);
    try {
      const chars = async (t: number) =>
        ((await film.inspect?.(t)) ?? []).filter((b) => b.label.startsWith("span.type-char"));
      expect(await chars(0.1)).toEqual([]);
      const done = await chars(0.95);
      expect(done.map((b) => b.label.match(/"(.*)"/)?.[1])).toEqual([
        "ル",
        "ー",
        "プ",
        "engineering",
      ]);
      // Settled on one baseline, left to right.
      expect(new Set(done.map((b) => Math.round(b.y))).size).toBe(1);
      expect(done.map((b) => b.x)).toEqual([...done.map((b) => b.x)].sort((a, b) => a - b));
      expect(await checkLayout(film)).toEqual([]);
      expect(await film.warnings()).toEqual([]);
    } finally {
      await film.close();
    }
  });
});

// A paper-style scene: a hand-drawn card placed with position: absolute, holding a title, a line of
// text faded into the paper and a pencil line that does not move.
const STYLE_PAGE = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<link rel="stylesheet" href="kit/styles.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>
  #card { position:absolute; left:300px; top:200px; width:600px; height:300px; padding:30px; background:var(--panel); }
  #t { font-size:48px; }
  #faint { font-size:30px; color:#d6cfbf; }
  #line { position:absolute; left:300px; top:700px; }
</style></head>
<body data-style="paper"><div id="root">
  <section class="scene" id="intro"><h1 style="font-size:80px">紙</h1></section>
  <section class="scene" id="deny">
    <div id="card" class="drawn layer-card"><p id="t">鉛筆で描く</p><p id="faint">薄い字</p></div>
    <svg id="line" class="sketch layer-line" width="800" height="60"><path d="M10 30 H790" stroke="currentColor" stroke-width="5" /></svg>
  </section>
</div>
<script>film.build(function (tl) {});</script>
</body></html>`;

describe("drawing styles", () => {
  it("puts the stylesheet and the hand-written font in the kit", () => {
    const dir = filmOf(STYLE_PAGE);
    expect(readFileSync(join(dir, "kit", "styles.css"), "utf8")).toContain('[data-style="paper"]');
    expect(readFileSync(join(dir, "kit", "fonts.css"), "utf8")).toContain("Klee One");
  });

  it("keeps a drawn card where the page puts it, measures its text against the card, and shimmers its lines the same way every time", async () => {
    const film = await openFilm(filmOf(STYLE_PAGE));
    try {
      const boxes = (await film.inspect?.(1.5)) ?? [];
      const card = boxes.find((b) => b.label.startsWith("#card"));
      expect(card && [card.x, card.y]).toEqual([300, 200]);
      expect((await checkLayout(film))?.map(formatIssue)).toEqual([
        expect.stringMatching(/#faint "薄い字" has contrast 1\.\d:1, needs 4\.5:1/),
      ]);
      // Nothing moves in the scene; only the lines are re-drawn 8 times a second.
      const a = await film.frame(1.5);
      expect((await film.frame(1.5)).equals(a)).toBe(true);
      expect((await film.frame(1.63)).equals(a)).toBe(false);
      expect(await film.warnings()).toEqual([]);
    } finally {
      await film.close();
    }
  });
});
