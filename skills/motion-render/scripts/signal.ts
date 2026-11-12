// Audio as numbers for the beat analysis: decoding with ffmpeg, band filters and 1 ms envelopes.
import { spawnSync } from "node:child_process";
import { findFfmpeg } from "./audio.ts";

export const SR = 24000; // analysis rate
const HOP = 24; // samples per envelope frame
export const FPS = SR / HOP; // envelope frames per second: one per millisecond
export const RATE = 44100; // rate of the rendered score

function pcm(args: string[]): Float32Array {
  const r = spawnSync(findFfmpeg(), ["-v", "error", ...args, "-f", "f32le", "-"], {
    maxBuffer: 2 ** 31 - 1,
  });
  if (r.status !== 0) throw new Error(`ffmpeg could not decode: ${r.stderr.toString().trim()}`);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + (b.byteLength & ~3)));
}

// Mono at the analysis rate, after an optional ffmpeg audio filter (the tempo lock).
export function decodeMono(file: string, filter = "anull"): Float32Array {
  return pcm(["-i", file, "-vn", "-af", filter, "-ac", "1", "-ar", String(SR)]);
}

// Interleaved stereo at the render rate, after an optional ffmpeg audio filter.
export function decodeStereo(file: string, filter = "anull"): Float32Array {
  return pcm(["-i", file, "-vn", "-af", filter, "-ac", "2", "-ar", String(RATE)]);
}

export type Pass = "lp" | "hp";

// RBJ biquad (Q = 1/sqrt 2). Run once it delays the band slightly, as a causal filter does; the
// beat tracker runs it forward and backward (zeroPhase) so its envelopes carry no delay.
export function biquad(x: Float32Array, type: Pass, f: number, zeroPhase = false): Float32Array {
  const w = (2 * Math.PI * f) / SR,
    c = Math.cos(w),
    al = Math.sin(w) / Math.SQRT2;
  const k = type === "lp" ? (1 - c) / 2 : (1 + c) / 2;
  const a0 = 1 + al;
  const b0 = k / a0,
    b1 = ((type === "lp" ? 1 : -1) * 2 * k) / a0,
    a1 = (-2 * c) / a0,
    a2 = (1 - al) / a0;
  const run = (src: Float32Array): Float32Array => {
    const y = new Float32Array(src.length);
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    for (let i = 0; i < src.length; i++) {
      const v = b0 * src[i]! + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = src[i]!;
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
    return y;
  };
  return zeroPhase ? run(run(x).reverse()).reverse() : run(x);
}

// The same filter `times` times over.
export function chain(
  x: Float32Array,
  type: Pass,
  f: number,
  times: number,
  zero = false
): Float32Array {
  let y = x;
  for (let i = 0; i < times; i++) y = biquad(y, type, f, zero);
  return y;
}

// RMS of `x` in a centered window of `ms`, one value per millisecond.
export function envelope(x: Float32Array, ms: number): Float64Array {
  const pre = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) pre[i + 1] = pre[i]! + x[i]! * x[i]!;
  const half = Math.round((ms * SR) / 2000);
  const n = Math.floor(x.length / HOP);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i * HOP - half),
      b = Math.min(x.length, i * HOP + half);
    e[i] = Math.sqrt((pre[b]! - pre[a]!) / Math.max(1, b - a));
  }
  return e;
}

export function percentile(v: ArrayLike<number>, p: number): number {
  const s = Float64Array.from(v).sort();
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
}

export function mean(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]!;
  return v.length ? s / v.length : 0;
}

export const db = (v: number): number => 20 * Math.log10(Math.max(v, 1e-6));

// Onset strength of one band: the rise of its compressed envelope over 2*d ms, never negative.
function onsets(e: Float64Array, d = 6): Float64Array {
  const ref = percentile(e, 0.95) || 1e-9;
  const c = e.map((v) => Math.log1p((30 * v) / ref));
  const o = new Float64Array(e.length);
  for (let i = d; i < e.length - d; i++) o[i] = Math.max(0, c[i + d]! - c[i - d]!);
  return o;
}

export interface Bands {
  seconds: number;
  full: Float64Array; // envelopes, 1 ms
  low: Float64Array;
  onset: Float64Array; // onset strength of all bands together, 1 ms
  onsetLow: Float64Array; // of the lows only: where the kicks are
}

// The envelopes and onset strengths the beat tracker reads.
export function bands(x: Float32Array): Bands {
  const low = envelope(chain(x, "lp", 150, 2, true), 10),
    mid = envelope(biquad(biquad(x, "hp", 200, true), "lp", 2500, true), 10),
    high = envelope(chain(x, "hp", 6000, 2, true), 10);
  const oL = onsets(low),
    oM = onsets(mid),
    oH = onsets(high);
  const mL = mean(oL) || 1,
    mM = mean(oM) || 1,
    mH = mean(oH) || 1;
  const onset = new Float64Array(oL.length);
  for (let i = 0; i < oL.length; i++) onset[i] = oL[i]! / mL + oM[i]! / mM + (0.5 * oH[i]!) / mH;
  return { seconds: x.length / SR, full: envelope(x, 20), low, onset, onsetLow: oL };
}
