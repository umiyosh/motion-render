// How loud the built MP4 is, and setting it (#61). The mix ends in a sample-peak limiter, but AAC
// can overshoot between samples, so the MP4's own sound is measured: integrated loudness (LUFS) and
// true peak (dBTP), with ffmpeg's ebur128 filter (EBU R 128, ITU-R BS.1770-4). With a target in
// script.json, the whole mix is moved to it before encoding by one gain, so the narration and the
// score keep their balance (scoreLevel); a gain that would push the peaks over the ceiling stops at
// the ceiling instead. (loudnorm was tried first: its second pass took a correction measured for its
// dynamic mode and landed 2.6 LU under the target.)
import { ffmpegLog, runFfmpeg } from "./audio.ts";

export interface Loudness {
  lufs: number; // integrated loudness; -70 for silence
  truePeak: number; // dBTP; -Infinity for silence
}

// Room left under the ceiling when setting a gain: the MP4 encodes the sound again, and AAC can
// raise the true peak a little.
const HEADROOM = 0.3;

const number = (s: string | undefined): number =>
  s === undefined ? NaN : /^-inf$/i.test(s) ? -Infinity : Number(s);

// The summary ebur128 prints at the end of a run.
export function parseEbur128(log: string): Loudness {
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const lufs = number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const truePeak = number(/True peak:\s+Peak:\s+(-?(?:[\d.]+|inf)) dBFS/i.exec(summary)?.[1]);
  if (Number.isNaN(lufs) || Number.isNaN(truePeak))
    throw new Error("ffmpeg's ebur128 printed no summary of loudness and true peak");
  return { lufs, truePeak };
}

export function measureLoudness(file: string): Loudness {
  const log = ffmpegLog(
    ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
    `measure the loudness of ${file}`
  );
  return parseEbur128(log);
}

// The gain that moves a sound measured `l` to `target` LUFS, held so its true peak stays `HEADROOM`
// under `ceiling` dBTP. `short` is how far under the target that leaves it (0 when it reaches it).
export function gainFor(
  l: Loudness,
  target: number,
  ceiling: number
): { gain: number; short: number } {
  const want = target - l.lufs;
  const room = Number.isFinite(l.truePeak) ? ceiling - HEADROOM - l.truePeak : want;
  const gain = Math.min(want, room);
  return { gain, short: want - gain };
}

// Writes `out`: `input` moved by one gain towards `target` LUFS, under `ceiling` dBTP. Returns how
// many LU it falls short of the target (0 when it reaches it).
export async function normalize(
  input: string,
  out: string,
  target: number,
  ceiling: number
): Promise<number> {
  const { gain, short } = gainFor(measureLoudness(input), target, ceiling);
  await runFfmpeg([
    ...["-i", input, "-vn", "-af", `volume=${gain.toFixed(2)}dB`],
    ...["-ar", "44100", "-c:a", "aac", "-b:a", "192k", out],
  ]);
  return short;
}

// The line printed after build, and the warnings for it.
export function loudnessReport(
  l: Loudness,
  script: { loudness?: number; truePeak: number }
): { line: string; warnings: string[] } {
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "-inf");
  const warnings: string[] = [];
  if (l.truePeak > script.truePeak + 0.05)
    warnings.push(
      `the sound peaks at ${f(l.truePeak)} dBTP, over the ceiling of ${f(script.truePeak)} dBTP: players and streaming services may clip it (set "loudness" in script.json to bring it down, or lower "truePeak")`
    );
  if (script.loudness !== undefined && Math.abs(l.lufs - script.loudness) > 0.5)
    warnings.push(
      `the sound is ${f(l.lufs)} LUFS, more than 0.5 LU off the target of ${f(script.loudness)} LUFS`
    );
  return { line: `loudness: ${f(l.lufs)} LUFS, true peak ${f(l.truePeak)} dBTP`, warnings };
}
