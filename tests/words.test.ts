// When each character of the narration is said (#59): the alignment to the script, words.json and
// its cache, the times a page gets, film.word, and the narration against the film's stops.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  alignChars,
  loadWords,
  pageWords,
  voiceInStops,
  writeWords,
  type Timed,
} from "../skills/motion-render/scripts/words.ts";
import { loadScript, writeTiming } from "../skills/motion-render/scripts/work.ts";
import { writeKit } from "../skills/motion-render/scripts/kit.ts";
import { openFilm } from "../skills/motion-render/scripts/render.ts";
import { pcmWav, voice, workDir } from "./helpers.ts";

// What Forced Alignment returns for `text`: one character every 0.1 s from `from`.
const timed = (text: string, from = 0.1): Timed[] =>
  [...text].map((c, i) => ({ text: c, start: from + i * 0.1, end: from + i * 0.1 + 0.08 }));

describe("alignChars", () => {
  it("gives each character of the text the time of its partner", () => {
    expect(alignChars("一打", timed("一打"))).toEqual([
      [0.1, 0.18],
      [0.2, 0.28],
    ]);
  });

  it("pairs hiragana with katakana, skips extra characters and puts a missing one between its neighbors", () => {
    // the API wrote ぎっと for ギット, and an extra "、"; "ブ" came back as nothing
    const got = [...timed("ぎっと、", 0), ...timed("は", 0.5)];
    const t = alignChars("ギットブは", got);
    expect(t.slice(0, 3)).toEqual([
      [0, 0.08],
      [0.1, 0.18],
      [0.2, 0.28],
    ]);
    expect(t[3]![0]).toBeGreaterThanOrEqual(0.28);
    expect(t[3]![1]).toBeLessThanOrEqual(0.5);
    expect(t[4]).toEqual([0.5, 0.58]);
  });

  it("refuses an empty answer", () => {
    expect(() => alignChars("一打", [])).toThrow(/no characters/);
  });
});

const SCRIPT = {
  bgm: "x",
  bpm: 120,
  scenes: [
    { id: "intro", narration: "はじめに、動く。", section: "intro" },
    { id: "drop", narration: "一打で着く。", section: "drop" },
  ],
};

// A work whose narration WAVs are speech-like (the times in the tests come from the mocked API).
function work(): string {
  const w = workDir(SCRIPT);
  writeFileSync(join(w, "audio", "intro.wav"), pcmWav(voice(1.2, 1)));
  writeFileSync(join(w, "audio", "drop.wav"), pcmWav(voice(0.9, 2)));
  return w;
}

function aligned(): Response {
  return new Response(
    JSON.stringify({ characters: timed("はじめに、動く。"), words: [], loss: 0.1 })
  );
}

describe("word times", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("writes words.json from Forced Alignment, and never sends the same audio twice", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => aligned())
    );
    const w = work();
    const script = loadScript(w);
    expect(await writeWords(w, script)).toBe(2);
    const sent = vi.mocked(fetch).mock.calls[0]!;
    expect(sent[0]).toBe("https://api.elevenlabs.io/v1/forced-alignment");
    const form = sent[1]!.body as FormData;
    expect(form.get("text")).toMatch(/^(はじめに、動く。|一打で着く。)$/);
    expect((sent[1]!.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    const saved = JSON.parse(readFileSync(join(w, "words.json"), "utf8"));
    expect(saved.scenes.intro.chars[5][0]).toBeCloseTo(0.6, 6); // "動", after "、"
    expect(await writeWords(w, script)).toBe(2);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
  });

  it("drops the times of a scene whose audio changed", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => aligned())
    );
    const w = work();
    const script = loadScript(w);
    await writeWords(w, script);
    writeFileSync(join(w, "audio", "intro.wav"), pcmWav(voice(1.3, 9)));
    expect(Object.keys(loadWords(w, script))).toEqual(["drop"]);
  });

  it("warns and goes on without a key, and when the API refuses", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const w = work();
    const script = loadScript(w);
    expect(await writeWords(w, script)).toBe(0);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(
      /ELEVENLABS_API_KEY is not set: no word times/
    );
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: { message: "missing the permission" } }), {
            status: 401,
          })
      )
    );
    expect(await writeWords(w, script)).toBe(0);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toMatch(
      /no word times for "intro": HTTP 401 missing the permission/
    );
    expect(existsSync(join(w, "words.json"))).toBe(true);
  });

  it("gives a page each character's time from its scene's start: lead, then the time at speed", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => aligned())
    );
    const w = work();
    const script = loadScript(w);
    const timing = writeTiming(w, script);
    await writeWords(w, script);
    const p = pageWords(w, script, timing);
    expect(p.intro!.at![5]).toBeCloseTo(0.25 + 0.6 / 1.1, 3);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    writeFileSync(join(w, "audio", "drop.wav"), pcmWav(voice(1, 3)));
    expect(pageWords(w, script, timing).drop!.at).toBeNull();
  });
});

describe("the narration against the stops", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 120 BPM: bars of 2 s. The stop is bar 2 (4-6 s); the drop starts at 6 s.
  const timing = {
    total: 10,
    bpm: 120,
    end: 8,
    scenes: [
      { id: "intro", name: "intro", start: 0, dur: 6, speech: 1, section: "intro" as const },
      { id: "drop", name: "drop", start: 6, dur: 4, speech: 0.8, section: "drop" as const },
    ],
  };
  const scored = (bars: string) => ({ ...loadScript(work()), score: { take: 1, bars } });

  it("passes a film whose narration rests in the stop", () => {
    const s = scored("0-1,-1,2-4");
    const r = voiceInStops(work(), s, timing);
    expect(r.problems).toEqual([]);
    expect(r.lines).toEqual(["stop 0:04.00-0:06.00: no voice in it (by scene speech spans)"]);
  });

  it("names the words said in the stop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    // the intro's "動く" comes 4.4-4.6 s into its WAV, 3.9-4.4 s into the film at 1.1x: into the stop at 4 s
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ characters: timed("はじめに、動く。", 3.9) }))
      )
    );
    const w = work();
    const s = { ...loadScript(w), score: { take: 1, bars: "0-1,-1,2-4" } };
    await writeWords(w, s);
    const r = voiceInStops(w, s, timing);
    expect(r.problems[0]).toMatch(
      /speaks in the stop at 0:04\.00-0:06\.00 \("[^"]*く" of "intro"\)/
    );
    expect(r.lines[0]).toMatch(/voice in it \(by word times\)/);
  });

  it("checks nothing without a score or a stop", () => {
    expect(voiceInStops(work(), loadScript(work()), timing)).toEqual({ lines: [], problems: [] });
    expect(voiceInStops(work(), scored("0-4"), timing).lines).toEqual([]);
  });
});

const WORD_PAGE = (word: string) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="kit/fonts.css"><link rel="stylesheet" href="kit/base.css">
<script src="kit/gsap.min.js"></script><script src="kit/timing.js"></script><script src="kit/player.js"></script>
<style>body { background: #0b1622; color: #e9f0f7; } #t { position:absolute; left:200px; top:200px; font-size:60px; }</style>
</head><body><div id="root">
  <section class="scene" id="intro"><p id="t">-</p></section>
  <section class="scene" id="drop"></section>
</div>
<script>
  film.build(function () {
    document.getElementById("t").textContent = "at " + film.word("intro", "${word}").toFixed(3);
  });
</script></body></html>`;

describe("film.word", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function pageText(w: string, word: string): Promise<string> {
    const dir = writeKit(w);
    writeFileSync(join(dir, "index.html"), WORD_PAGE(word));
    const film = await openFilm(dir);
    try {
      const boxes = (await film.inspect?.(0.5)) ?? [];
      return boxes.find((b) => b.label.startsWith("#t"))?.label ?? "";
    } finally {
      await film.close();
    }
  }

  it("returns when the word starts, from the word times or, without them, from its place in the text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = work();
    const script = loadScript(w);
    writeTiming(w, script);
    // no times: "動" comes after 4 of the 6 spoken characters (はじめに動く), over 1.2/1.1 s of speech
    expect(await pageText(w, "動く")).toContain(`at ${(0.25 + (4 / 6) * (1.2 / 1.1)).toFixed(3)}`);
    vi.stubEnv("ELEVENLABS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => aligned())
    );
    await writeWords(w, script);
    expect(await pageText(w, "動く")).toContain(`at ${(0.25 + 0.6 / 1.1).toFixed(3)}`);
  });

  it("stops the page on a word the narration does not say", async () => {
    const w = work();
    writeTiming(w, loadScript(w));
    await expect(pageText(w, "止まる")).rejects.toThrow(/does not say "止まる"/);
  });
});
