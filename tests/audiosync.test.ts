// The MP4's own sound, measured against where the mix placed the score and the narration (#58).
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findFfmpeg, mix } from "../skills/motion-render/scripts/audio.ts";
import { writeWav } from "../skills/motion-render/scripts/score.ts";
import { measureAudio } from "../skills/motion-render/scripts/audiosync.ts";
import { loadScript, writeTiming, type Timing } from "../skills/motion-render/scripts/work.ts";
import { drumTrack, pcmWav, voice, workDir } from "./helpers.ts";

const SCRIPT = {
  bgm: "jazz drum and bass",
  bpm: 120,
  scenes: [
    { id: "intro", narration: "はじめに", section: "intro" },
    { id: "rise", narration: "高まる" },
    { id: "drop", narration: "全開", section: "drop" },
  ],
};

// A work with speech-like narration and a drum score, mixed as build mixes it.
async function mixedWork(): Promise<{ work: string; timing: Timing; audio: string }> {
  const work = workDir(SCRIPT);
  const lengths = { intro: 1.3, rise: 2.2, drop: 1.0 };
  Object.entries(lengths).forEach(([id, s], i) =>
    writeFileSync(join(work, "audio", `${id}.wav`), pcmWav(voice(s, i + 1)))
  );
  const script = loadScript(work);
  const timing = writeTiming(work, script);
  const score = join(work, "audio", "score.wav");
  writeWav(drumTrack(120, 0, Array(6).fill("drums")), score);
  const audio = join(work, "audio", "mix.m4a");
  await mix(work, script, { ...timing, score: { file: score, gain: 0.6 } }, audio);
  return { work, timing, audio };
}

// An MP4 of a still picture and the mix, its sound shifted by `ms` (as a later stage could).
function mp4Of(audio: string, out: string, total: number, ms: number): void {
  const shift = ms ? ["-af", `adelay=${ms}:all=1`] : [];
  const r = spawnSync(findFfmpeg(), [
    ...["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=240x136:r=60:d=${total}`],
    ...["-i", audio, "-map", "0:v", "-map", "1:a", ...shift],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", out],
  ]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

function refsOf(work: string, timing: Timing) {
  return {
    score: join(work, "audio", "score.wav"),
    narration: timing.scenes.map((s) => ({
      id: s.id,
      file: join(work, "audio", `${s.id}.wav`),
      at: s.start + 0.25,
    })),
    speed: 1.1,
  };
}

const scoreMs = (line: string): number => Number(/score ([+-]\d+\.\d) ms/.exec(line)?.[1]);
const voiceMs = (line: string): number => Number(/narration max ±(\d+\.\d) ms/.exec(line)?.[1]);

describe("the MP4's sound", () => {
  it("finds the score and every scene's narration where the mix put them", async () => {
    const { work, timing, audio } = await mixedWork();
    const mp4 = join(work, "on.mp4");
    mp4Of(audio, mp4, timing.total, 0);
    const r = measureAudio(mp4, refsOf(work, timing), 60);
    expect(r.problems).toEqual([]);
    expect(r.lines[0]).toMatch(/^audio: score [+-]\d+\.\d ms, narration max ±\d+\.\d ms$/);
    expect(Math.abs(scoreMs(r.lines[0]!))).toBeLessThan(1);
    expect(voiceMs(r.lines[0]!)).toBeLessThan(1);
  });

  it("measures a sound shifted 20 ms late within 1 ms, and calls it a problem", async () => {
    const { work, timing, audio } = await mixedWork();
    const mp4 = join(work, "late.mp4");
    mp4Of(audio, mp4, timing.total, 20);
    const r = measureAudio(mp4, refsOf(work, timing), 60);
    expect(scoreMs(r.lines[0]!)).toBeGreaterThan(19);
    expect(scoreMs(r.lines[0]!)).toBeLessThan(21);
    expect(voiceMs(r.lines[0]!)).toBeGreaterThan(19);
    expect(voiceMs(r.lines[0]!)).toBeLessThan(21);
    expect(r.problems[0]).toMatch(
      /^the score plays \+\d+\.\d ms late .*\(at most ±8\.3 ms, half a frame\)/
    );
    expect(r.problems).toHaveLength(4); // the score and the 3 scenes
  });

  it("calls an MP4 without sound a problem", async () => {
    const { work, timing } = await mixedWork();
    const mp4 = join(work, "mute.mp4");
    const r0 = spawnSync(findFfmpeg(), [
      ...["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=240x136:r=60:d=2"],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", mp4],
    ]);
    expect(r0.status).toBe(0);
    expect(measureAudio(mp4, refsOf(work, timing), 60).problems).toEqual([
      "the MP4 has no sound: build it again",
    ]);
  });
});
