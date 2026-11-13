// The flow of a beat-synced film around the score: scene times on the beat grid, the takes from the
// music direction, scoring, mixing at the narration-relative level, and measuring the MP4.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadScript, loadTiming, writeTiming } from "../skills/motion-render/scripts/work.ts";
import { findLayoutIssues, type LayoutBox } from "../skills/motion-render/scripts/layout.ts";
import { psnr, repeatTimes } from "../skills/motion-render/scripts/repeat.ts";
import { findFfmpeg, mediaSeconds, mix } from "../skills/motion-render/scripts/audio.ts";
import { writeWav } from "../skills/motion-render/scripts/score.ts";
import { measureSync, measureSyncPictures } from "../skills/motion-render/scripts/sync.ts";
import { mp4Picture, writeSheet } from "../skills/motion-render/scripts/sheet.ts";
import {
  runBeatBgm,
  runScore,
  runSync,
  scoreInput,
  timingTable,
} from "../skills/motion-render/scripts/beatcli.ts";
import { drumTrack, tempDir, workDir } from "./helpers.ts";

const BEAT_SCRIPT = {
  bgm: "jazz drum and bass",
  bpm: 120,
  scenes: [
    { id: "intro", narration: "はじめに", section: "intro" },
    { id: "rise", narration: "高まる" },
    { id: "drop", narration: "全開", section: "drop" },
  ],
};

describe("scene times on the beat grid", () => {
  it("starts scenes on beats, sections on bar lines, and puts the final hit on the bar after the narration", () => {
    const work = workDir(BEAT_SCRIPT, { intro: 1.3, rise: 2.2, drop: 1.0 });
    const t = writeTiming(work, loadScript(work));
    const at = t.scenes.map((s) => s.start);
    // intro 0.25 + 1.3/1.1 + 0.35 = 1.78 -> beat 2.0; rise ends at 4.6 -> next bar line 6.0
    expect(at).toEqual([0, 2, 6]);
    expect(t.end).toBe(8);
    expect(t.total).toBe(11);
    expect(t.scenes[2]).toMatchObject({ section: "drop", dur: 5 });
    expect(loadTiming(work)).toEqual(t);
    const table = timingTable(t);
    expect(table).toMatch(/rise +0:02\.00 +bar 1 beat 1/);
    expect(table).toMatch(/drop +0:06\.00 +bar 3 beat 1 +drop/);
    expect(table).toMatch(/final hit +0:08\.00 +bar 4 beat 1/);
    expect(table).toContain("6 bars of 2.000 s at 120 BPM");
  });

  it("refuses an unknown section and a malformed score", () => {
    const bad = (extra: object) => () => loadScript(workDir({ ...BEAT_SCRIPT, ...extra }));
    expect(bad({ scenes: [{ id: "a", narration: "x", section: "chorus" }] })).toThrow(
      /section must be one of/
    );
    expect(bad({ score: { take: 0, bars: "0" } })).toThrow(/score.take/);
    expect(bad({ score: { take: 1, bars: "0-x" } })).toThrow(/score.bars/);
    expect(bad({ score: [] })).toThrow(/"score" must be an object/);
  });
});

function box(t: number, show: boolean, chars = 2): { t: number; boxes: LayoutBox[] } {
  const word: LayoutBox = {
    key: 1,
    label: 'span "点火"',
    x: 144,
    y: 800,
    w: 300,
    h: 140,
    cut: false,
    anc: [],
    ok: false,
    under: null,
    text: { px: 120, contrast: 12, chars },
  };
  return { t, boxes: show ? [word] : [] };
}

describe("big text on screen too briefly", () => {
  const samples = (from: number, to: number, chars = 2) =>
    Array.from({ length: 40 }, (_, i) => {
      const t = Math.round(i * 100) / 1000;
      return box(t, t >= from && t < to, chars);
    });

  it("asks for 2 s, and 1 s per 4 characters", () => {
    expect(findLayoutIssues(samples(1, 1.5)).map((i) => i.message)).toEqual([
      'span "点火" is on screen for 0.5s, needs 2.0s (big text stays 2 s, and 1 s per 4 characters)',
    ]);
    expect(findLayoutIssues(samples(1, 3.5))).toEqual([]);
    expect(findLayoutIssues(samples(1, 3.5, 12))[0]?.message).toMatch(/2\.5s, needs 3\.0s/);
  });

  it("lets text that lasts until its scene ends pass, and judges text taken away mid-scene", () => {
    expect(findLayoutIssues(samples(1, 1.5), [{ a0: 0, dur: 1.8 }])).toEqual([]);
    expect(findLayoutIssues(samples(1, 1.5), [{ a0: 0, dur: 4 }])).toHaveLength(1);
  });

  it("does not judge text that runs into either end of the samples", () => {
    expect(findLayoutIssues(samples(0, 0.5))).toEqual([]);
    expect(findLayoutIssues(samples(3.5, 9))).toEqual([]);
  });
});

describe("repeat check helpers", () => {
  it("measures how alike two frames are and picks times in each scene", () => {
    const a = new Uint8Array([10, 20, 30, 40]);
    expect(psnr(a, a)).toBe(Infinity);
    expect(psnr(a, new Uint8Array([10, 20, 30, 50]))).toBeCloseTo(34.2, 1);
    expect(() => psnr(a, new Uint8Array(3))).toThrow(/sizes/);
    const meta = {
      duration: 4,
      parts: [
        { key: "a", a0: 0, dur: 2 },
        { key: "b", a0: 2, dur: 2 },
      ],
    };
    expect(repeatTimes({ meta, only: null })).toEqual([0.5, 1, 1.5, 2.5, 3, 3.5]);
    expect(repeatTimes({ meta, only: ["b"] })).toEqual([2.5, 3, 3.5]);
  });
});

// A gray film at 60 fps: a block lights for 2 frames on each of `flashes`, the whole frame on `big`.
function testMp4(file: string, seconds: number, flashes: number[], big: number[]): void {
  const W = 480,
    H = 270,
    fps = 60,
    n = seconds * fps;
  const frames = Buffer.alloc(W * H * n, 40);
  const lit = (t: number, k: number) => {
    const f = Math.ceil((t - 0.008) * fps - 1e-6) + k;
    return f >= 0 && f < n ? f : -1;
  };
  for (const t of flashes)
    for (const k of [0, 1]) {
      const f = lit(t, k);
      if (f < 0) continue;
      for (let y = 40; y < 80; y++)
        frames.fill(220, f * W * H + y * W + 40, f * W * H + y * W + 100);
    }
  for (const t of big)
    for (const k of [0, 1, 2]) {
      const f = lit(t, k);
      if (f >= 0) frames.fill(250, f * W * H, (f + 1) * W * H);
    }
  const r = spawnSync(
    findFfmpeg(),
    [
      "-v",
      "error",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      `${W}x${H}`,
      "-r",
      "60",
      "-i",
      "-",
    ].concat(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "10", file]),
    { input: frames, maxBuffer: 1 << 26 }
  );
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

const SYNC_TIMING = {
  total: 8,
  bpm: 120,
  end: 6,
  scenes: [
    { id: "intro", name: "intro", start: 0, dur: 4, speech: 3.2, section: "intro" as const },
    { id: "drop", name: "drop", start: 4, dur: 4, speech: 1.5, section: "drop" as const },
  ],
};
const KICKS = Array.from({ length: 14 }, (_, i) => ({
  t: 0.5 + i * 0.5,
  slot: 4 + i * 4,
  k: "kick" as const,
  v: 0.9,
}));

describe("sync", () => {
  it("passes a film that moves on every kick and flashes on the drop and the final hit", async () => {
    const mp4 = join(tempDir(), "on.mp4");
    testMp4(
      mp4,
      8,
      KICKS.map((h) => h.t),
      [4, 6]
    );
    const r = await measureSync(mp4, SYNC_TIMING, { lead: 0.25 }, KICKS);
    expect(r.problems).toEqual([]);
    expect(r.lines.join("\n")).toMatch(
      /kicks in the drops: the picture moves on 100% of [1-9] \(an 8th later, with no hit: 0%\)/
    );
    expect(r.lines.join("\n")).toMatch(/drop "drop" 0:04\.00: .* [+-]?\d+ ms from the hit/);
  });

  it("measures the same from the frames it reads, drawn one by one, as from the whole MP4", async () => {
    const dir = tempDir();
    const mp4 = join(dir, "on.mp4");
    testMp4(
      mp4,
      8,
      KICKS.filter((h) => h.t >= 4).map((h) => h.t),
      [4, 6]
    );
    spawnSync(findFfmpeg(), ["-v", "error", "-i", mp4, join(dir, "f%04d.png")]);
    const draw = (f: number) =>
      Promise.resolve(readFileSync(join(dir, `f${String(f + 1).padStart(4, "0")}.png`)));
    const whole = await measureSync(mp4, SYNC_TIMING, { lead: 0.25 }, KICKS);
    const drawn = await measureSyncPictures(
      { draw, fps: 60, ahead: 4 },
      SYNC_TIMING,
      { lead: 0.25 },
      KICKS
    );
    expect(drawn.problems).toEqual(whole.problems);
    expect(drawn.lines.filter((l) => !/drop|final/.test(l))).toEqual(
      whole.lines.filter((l) => !/drop|final/.test(l))
    );
    expect(drawn.lines.join("\n")).toMatch(/drop "drop" 0:04\.00: .* [+-]?\d+ ms from the hit/);
  });

  it("times frames at the film's frame rate when the decoder drops a frame", async () => {
    // the film is 8.02 s long but its MP4 decodes to 8 s of frames (the last frame lost)
    const mp4 = join(tempDir(), "short.mp4");
    testMp4(
      mp4,
      8,
      KICKS.map((h) => h.t),
      [4, 6]
    );
    const r = await measureSync(mp4, { ...SYNC_TIMING, total: 8.02 }, { lead: 0.25 }, KICKS);
    expect(r.lines.join("\n")).toMatch(/final hit 0:06\.00: .* [+-]?\d ms from the hit/);
  });

  it("tiles the key moments of an MP4 into one sheet for a review", async () => {
    const dir = tempDir();
    const mp4 = join(dir, "film.mp4");
    testMp4(
      mp4,
      8,
      KICKS.map((h) => h.t),
      [4, 6]
    );
    const out = join(dir, "sheet.png");
    const names = await writeSheet(mp4Picture(mp4), SYNC_TIMING, out);
    // two scene middles, a beat before / on / after the drop, the final hit
    expect(names).toHaveLength(6);
    expect(names[0]).toMatch(/^1 \(row 1, column 1\): 0:02\.00 intro: middle/);
    expect(names.join("\n")).toMatch(/0:04\.02 drop: the drop/);
    expect(names.at(-1)).toMatch(/0:06\.05 the final hit$/);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(join(dir, "sheet.txt"), "utf8").trim().split("\n")).toHaveLength(6);
  });

  it("asks for kick reactions in the drops only", async () => {
    const mp4 = join(tempDir(), "calm.mp4");
    // moves on the drop's kicks (4 s on) only; the calm intro stays still on its kicks
    testMp4(
      mp4,
      8,
      KICKS.filter((h) => h.t >= 4).map((h) => h.t),
      [4, 6]
    );
    const r = await measureSync(mp4, SYNC_TIMING, { lead: 0.25 }, KICKS);
    expect(r.problems).toEqual([]);
  });

  it("fails a film that moves off the beat and does nothing on the drop", async () => {
    const mp4 = join(tempDir(), "off.mp4");
    testMp4(
      mp4,
      8,
      KICKS.map((h) => h.t + 0.25),
      []
    );
    const r = await measureSync(
      mp4,
      { ...SYNC_TIMING, scenes: [SYNC_TIMING.scenes[0]!, { ...SYNC_TIMING.scenes[1]!, start: 7 }] },
      { lead: 0.25 },
      KICKS
    );
    const all = r.problems.join("\n");
    expect(all).toMatch(/kicks in the drops: the picture moves on 0% of them, 100% with no hit/);
    expect(all).toMatch(/drop "drop" at 0:07\.00: the picture changes only/);
    expect(all).toMatch(/final hit at 0:06\.00/);
    expect(all).toMatch(/the narration stops for 3\.80 s before "drop"/);
    await expect(
      measureSync(mp4, { ...SYNC_TIMING, bpm: undefined }, { lead: 0.25 }, KICKS)
    ).rejects.toThrow(/no bpm/);
  });

  it("only reports the final hit of a film with no drop", async () => {
    const mp4 = join(tempDir(), "quiet.mp4");
    testMp4(mp4, 8, [], []);
    const calm = {
      ...SYNC_TIMING,
      scenes: SYNC_TIMING.scenes.map((s) => ({ ...s, section: "intro" as const })),
    };
    const r = await measureSync(mp4, calm, { lead: 0.25 }, KICKS);
    expect(r.lines.join("\n")).toMatch(/final hit 0:06\.00: the whole picture changes/);
    expect(r.problems.join("\n")).not.toMatch(/final hit/);
  });
});

function takeResponse(): Response {
  const file = join(tempDir(), "take.wav");
  writeWav(
    drumTrack(118, 0.2, ["pad", "pad", "drums", "drums", "silent", "loud", "loud", "loud"]),
    file
  );
  const data = readFileSync(file).toString("base64");
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data } }] } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("takes, scoring, mixing and measuring a beat-synced work", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => takeResponse())
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("makes four takes from score.txt, shows them bar by bar, scores the chosen bars and mixes them", async () => {
    const work = workDir(BEAT_SCRIPT, { intro: 1.3, rise: 2.2, drop: 1.0 });
    const script = loadScript(work);
    const timing = writeTiming(work, script);
    await expect(runBeatBgm(work, script, 120)).rejects.toThrow(/score\.txt/);
    writeFileSync(join(work, "score.txt"), "Score for a film. [0:00 - 0:06] build. [0:06] drop.");
    await runBeatBgm(work, script, 120);
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body));
    expect(sent.contents[0].parts[0].text).toMatch(
      /\[0:06\] drop\.\n\nInstrumental only.*exactly 120 BPM/s
    );
    expect(readFileSync(join(work, "audio", "bgm", "takes.txt"), "utf8")).toMatch(
      /^take 1: audio\/bgm\/take1\.wav/
    );
    expect(JSON.parse(readFileSync(join(work, "audio", "bgm", "takes.json"), "utf8"))).toHaveLength(
      4
    );

    // 6 bars of film: 2 pad, 1 drums, the silent bar, the drop on bar 3, the final hit on bar 4
    const scored = { ...BEAT_SCRIPT, score: { take: 2, bars: "0-1,2,4,5-6" } };
    writeFileSync(join(work, "script.json"), JSON.stringify(scored));
    expect(() => scoreInput(work, loadScript(work), -20)).toThrow(/no score yet/);
    runScore(work);
    expect(existsSync(join(work, "audio", "hits.json"))).toBe(true);
    const input = scoreInput(work, loadScript(work), -20);
    expect(input.gain).toBeGreaterThan(0);
    writeFileSync(
      join(work, "script.json"),
      JSON.stringify({ ...scored, score: { take: 2, bars: "0-5" } })
    );
    expect(() => scoreInput(work, loadScript(work), -20)).toThrow(
      /changed since the score was made/
    );

    const out = join(work, "audio", "mix.m4a");
    await mix(
      work,
      loadScript(work),
      { scenes: timing.scenes, total: timing.total, score: input },
      out
    );
    expect(await mediaSeconds(out)).toBeCloseTo(timing.total, 1);
  });

  it("refuses to score a film without a beat, and fails sync with its problems", async () => {
    const work = workDir({ ...BEAT_SCRIPT, bpm: undefined }, { intro: 1, rise: 1, drop: 1 });
    writeTiming(work, loadScript(work));
    expect(() => runScore(work)).toThrow(/beat-synced films/);
    const beat = workDir(BEAT_SCRIPT, { intro: 1.3, rise: 2.2, drop: 1.0 });
    writeTiming(beat, loadScript(beat));
    const mp4 = join(beat, "film.mp4");
    testMp4(mp4, 11, [], []);
    await expect(runSync(beat, mp4)).rejects.toThrow(/no score yet/);
    writeFileSync(
      join(beat, "audio", "hits.json"),
      JSON.stringify({ bpm: 120, bar: 2, hits: KICKS })
    );
    await expect(runSync(beat, mp4)).rejects.toThrow(/sync problems/);
    writeFileSync(join(beat, "audio", "hits.json"), JSON.stringify({ hits: [{ t: "x" }] }));
    await expect(runSync(beat, mp4)).rejects.toThrow(/malformed/);
  });
});
