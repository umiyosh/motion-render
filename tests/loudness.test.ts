// How loud the built MP4 is, and setting it (#61): reading ebur128 and loudnorm, the report and
// its warnings, the script.json fields, and setting a real mix with one gain.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { findFfmpeg, volumeStats } from "../skills/motion-render/scripts/audio.ts";
import {
  loudnessReport,
  measureLoudness,
  normalize,
  parseEbur128,
  gainFor,
} from "../skills/motion-render/scripts/loudness.ts";
import { loadScript } from "../skills/motion-render/scripts/work.ts";
import { SCRIPT, tempDir, workDir } from "./helpers.ts";

const EBUR128 = `[Parsed_ebur128_0 @ 0x1] t: 4.9  TARGET:-23 LUFS    M: -18.1 S: -18.3     I: -18.2 LUFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -18.2 LUFS
    Threshold: -28.3 LUFS

  Loudness range:
    LRA:         2.1 LU
    Threshold: -38.3 LUFS
    LRA low:   -19.2 LUFS
    LRA high:  -17.1 LUFS

  True peak:
    Peak:       -0.4 dBFS`;

describe("reading ffmpeg's measurements", () => {
  it("reads the integrated loudness and true peak of ebur128's summary", () => {
    expect(parseEbur128(EBUR128)).toEqual({ lufs: -18.2, truePeak: -0.4 });
    const silent = EBUR128.replace(
      "-18.2 LUFS\n    Threshold",
      "-70.0 LUFS\n    Threshold"
    ).replace("-0.4 dBFS", "-inf dBFS");
    expect(parseEbur128(silent)).toEqual({ lufs: -70, truePeak: -Infinity });
    expect(() => parseEbur128("no summary")).toThrow(/no summary/);
  });

  it("moves the sound by one gain to the target, stopping under the ceiling", () => {
    expect(gainFor({ lufs: -29, truePeak: -15.5 }, -16, -1)).toEqual({ gain: 13, short: 0 });
    const capped = gainFor({ lufs: -20, truePeak: -2 }, -14, -1);
    expect(capped.gain).toBeCloseTo(0.7, 6); // up to -1.3 dBTP, 0.3 under the ceiling
    expect(capped.short).toBeCloseTo(5.3, 6);
    expect(gainFor({ lufs: -12, truePeak: -0.5 }, -16, -1)).toEqual({ gain: -4, short: 0 });
  });
});

describe("the loudness report", () => {
  it("prints the loudness and warns over the ceiling and off the target", () => {
    const quiet = loudnessReport({ lufs: -18.2, truePeak: -1.6 }, { truePeak: -1 });
    expect(quiet).toEqual({ line: "loudness: -18.2 LUFS, true peak -1.6 dBTP", warnings: [] });
    const hot = loudnessReport({ lufs: -13.2, truePeak: -0.3 }, { truePeak: -1, loudness: -14 });
    expect(hot.warnings[0]).toMatch(/peaks at -0\.3 dBTP, over the ceiling of -1\.0 dBTP/);
    expect(hot.warnings[1]).toMatch(/-13\.2 LUFS, more than 0\.5 LU off the target of -14\.0/);
    expect(loudnessReport({ lufs: -70, truePeak: -Infinity }, { truePeak: -1 }).line).toBe(
      "loudness: -70.0 LUFS, true peak -inf dBTP"
    );
  });

  it("reads loudness and truePeak from script.json, with -1 dBTP by default", () => {
    expect(loadScript(workDir(SCRIPT))).toMatchObject({ truePeak: -1 });
    expect(loadScript(workDir({ ...SCRIPT, loudness: -14, truePeak: -2 }))).toMatchObject({
      loudness: -14,
      truePeak: -2,
    });
    expect(() => loadScript(workDir({ ...SCRIPT, loudness: 0 }))).toThrow(/"loudness" must be/);
    expect(() => loadScript(workDir({ ...SCRIPT, truePeak: 1 }))).toThrow(/"truePeak" must be/);
  });
});

// A mix-like file: 4 s of quiet noise, then 4 s 12 dB louder, as AAC.
function quietThenLoud(dir: string): string {
  const out = join(dir, "mix.m4a");
  const r = spawnSync(findFfmpeg(), [
    ...["-v", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=8:c=pink:r=44100:a=0.2:seed=3"],
    ...["-af", "volume='if(lt(t,4),0.25,1)':eval=frame", "-c:a", "aac", "-b:a", "192k", out],
  ]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return out;
}

// The mean level of [from, to) seconds of a file, in dB.
async function levelOf(file: string, from: number, to: number, dir: string): Promise<number> {
  const part = join(dir, `part-${from}.wav`);
  spawnSync(findFfmpeg(), [
    "-v",
    "error",
    "-y",
    "-ss",
    String(from),
    "-t",
    String(to - from),
    "-i",
    file,
    part,
  ]);
  return (await volumeStats(part)).mean;
}

describe("setting the loudness of a mix", () => {
  it("sets it to the target within 0.5 LU, keeps the peaks under the ceiling, and moves everything by one gain", async () => {
    const dir = tempDir();
    const mix = quietThenLoud(dir);
    const before = measureLoudness(mix);
    const set = join(dir, "set.m4a");
    const short = await normalize(mix, set, -18, -1);
    const after = measureLoudness(set);
    expect(short).toBe(0);
    expect(Math.abs(after.lufs + 18)).toBeLessThan(0.5);
    expect(after.truePeak).toBeLessThanOrEqual(-0.95);
    expect(after.lufs).not.toBeCloseTo(before.lufs, 0);
    // the quiet part stays 12 dB under the loud one: one gain for all
    const gapBefore = (await levelOf(mix, 4.5, 7.5, dir)) - (await levelOf(mix, 0.5, 3.5, dir));
    const gapAfter = (await levelOf(set, 4.5, 7.5, dir)) - (await levelOf(set, 0.5, 3.5, dir));
    expect(Math.abs(gapAfter - gapBefore)).toBeLessThan(0.3);
  });
});
