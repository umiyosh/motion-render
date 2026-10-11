import { describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadScript,
  loadTiming,
  placeOnFilm,
  writeTiming,
} from "../skills/motion-render/scripts/work.ts";
import { SCRIPT, tempDir, workDir } from "./helpers.ts";

const scriptWith = (patch: object) => workDir({ ...SCRIPT, ...patch });

describe("loadScript", () => {
  it("fills in the defaults", () => {
    const s = loadScript(workDir(SCRIPT));
    expect(s).toMatchObject({
      voice: "Kore",
      speed: 1.1,
      ttsModel: "gemini-3.8-flash-tts",
      bgmModel: "lyria-3.5",
      bgmVolume: 0.15,
      lead: 0.25,
      tail: 0.35,
      endHold: 3,
    });
    expect(s.scenes).toEqual([
      { id: "intro", name: "Intro", narration: "はじめに" },
      { id: "flow", narration: "流れ" },
    ]);
  });

  it("keeps values the script sets", () => {
    expect(loadScript(scriptWith({ speed: 1.3, voice: "Puck" }))).toMatchObject({
      speed: 1.3,
      voice: "Puck",
    });
  });

  it("explains a missing script.json", () => {
    expect(() => loadScript(tempDir())).toThrow(/script\.json not found/);
  });

  it.each([
    ["not an object", [1, 2], /must be a JSON object/],
    ["no bgm", { ...SCRIPT, bgm: " " }, /"bgm" .* is required/],
    ["no scenes", { ...SCRIPT, scenes: [] }, /"scenes" must be a non-empty array/],
    ["scene not an object", { ...SCRIPT, scenes: ["x"] }, /scenes\[0\] must be an object/],
    [
      "bad id",
      { ...SCRIPT, scenes: [{ id: "Bad Id", narration: "a" }] },
      /scenes\[0\]\.id must match/,
    ],
    [
      "duplicated id",
      {
        ...SCRIPT,
        scenes: [
          { id: "a", narration: "x" },
          { id: "a", narration: "y" },
        ],
      },
      /"a" is duplicated/,
    ],
    [
      "empty narration",
      { ...SCRIPT, scenes: [{ id: "a", narration: "" }] },
      /narration is required/,
    ],
    ["speed out of range", { ...SCRIPT, speed: 3 }, /"speed" must be a number between 0.5 and 2/],
    ["volume not a number", { ...SCRIPT, bgmVolume: "loud" }, /"bgmVolume" must be a number/],
    ["model with a path", { ...SCRIPT, bgmModel: "../x" }, /"bgmModel" must match/],
  ])("rejects a script with %s", (_name, script, message) => {
    const dir = tempDir();
    writeFileSync(join(dir, "script.json"), JSON.stringify(script));
    expect(() => loadScript(dir)).toThrow(message);
  });
});

describe("writeTiming", () => {
  it("lays scenes end to end from the narration length, speed, lead, tail and the final hold", () => {
    const dir = workDir(
      { ...SCRIPT, speed: 1, lead: 0.5, tail: 0.5, endHold: 2 },
      { intro: 3, flow: 4 }
    );
    const timing = writeTiming(dir, loadScript(dir));
    expect(timing).toEqual({
      total: 11,
      scenes: [
        { id: "intro", name: "Intro", start: 0, dur: 4, speech: 3 },
        { id: "flow", name: "flow", start: 4, dur: 7, speech: 4 },
      ],
    });
    expect(JSON.parse(readFileSync(join(dir, "timing.json"), "utf8"))).toEqual(timing);
  });

  it("shortens speech by the speed factor", () => {
    const dir = workDir({ ...SCRIPT, speed: 2 }, { intro: 4, flow: 2 });
    expect(writeTiming(dir, loadScript(dir)).scenes.map((s) => s.speech)).toEqual([2, 1]);
  });
});

describe("loadTiming", () => {
  it("reads what writeTiming wrote", () => {
    const dir = workDir(SCRIPT, { intro: 1, flow: 1 });
    const written = writeTiming(dir, loadScript(dir));
    expect(loadTiming(dir)).toEqual(written);
  });

  it("asks for narrate when timing.json is missing", () => {
    expect(() => loadTiming(tempDir())).toThrow(/run "motion-render narrate/);
  });

  it.each([
    ["no scenes", { total: 1 }],
    ["a scene without a start", { total: 1, scenes: [{ id: "a", name: "a", dur: 1, speech: 1 }] }],
    ["a scene that is not an object", { total: 1, scenes: [null] }],
  ])("rejects timing.json with %s", (_name, timing) => {
    const dir = tempDir();
    writeFileSync(join(dir, "timing.json"), JSON.stringify(timing));
    expect(() => loadTiming(dir)).toThrow(/is malformed/);
  });
});

describe("placeOnFilm", () => {
  const timing = {
    total: 10,
    scenes: [
      { id: "intro", name: "Intro", start: 0, dur: 4, speech: 3 },
      { id: "flow", name: "Flow", start: 4, dur: 6, speech: 5 },
    ],
  };

  it("starts each narration where the film's scene starts, not where timing.json says", () => {
    const warn = vi.fn();
    const placed = placeOnFilm(
      timing,
      {
        parts: [
          { key: "flow", a0: 5.5, dur: 6 },
          { key: "intro", a0: 0, dur: 5.5 },
        ],
      },
      { lead: 0.25 },
      warn
    );
    expect(placed.map((s) => [s.id, s.start])).toEqual([
      ["intro", 0],
      ["flow", 5.5],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when narration runs past its scene in the film", () => {
    const warn = vi.fn();
    placeOnFilm(
      timing,
      {
        parts: [
          { key: "intro", a0: 0, dur: 2 },
          { key: "flow", a0: 2, dur: 6 },
        ],
      },
      { lead: 0.25 },
      warn
    );
    expect(warn).toHaveBeenCalledWith('narration of "intro" (3s) runs past its scene (2s)');
  });

  it("names scenes that the film does not have", () => {
    expect(() =>
      placeOnFilm(timing, { parts: [{ key: "intro", a0: 0, dur: 4 }] }, { lead: 0 }, vi.fn())
    ).toThrow("these script.json scenes are not in the film: flow (scene ids must match)");
  });
});
