// Where the sound of a built MP4 sits, against where the mix put it (#58). Rounding in adelay, the
// encoder's leading delay and its edit list, and -shortest all act after the mix, so the timetable
// in hits.json cannot show them: the MP4's own audio is measured.
//
// Each part (the score, each scene's narration) is found in the MP4's audio by cross-correlating
// waveforms (normalized cross-correlation, as in Knapp & Carter 1976, "The generalized correlation
// method for estimation of time delay"). The other parts of the mix do not correlate with a part's
// waveform, so each part is found on its own; correlating onset envelopes instead, which are never
// negative, would let the loud drums swamp the narration. The search is coarse at 2 kHz over
// ±100 ms, then fine at 24 kHz over ±2 ms around the coarse peak, and a parabola through the
// highest three values places the peak between samples.
import { chain, decodeMono, SR } from "./signal.ts";
import type { SyncResult } from "./sync.ts";

const SEARCH_MS = 100;
const STEP = 12; // the coarse search reads every 12th sample: 2 kHz
const FINE = 48; // samples either side of the coarse peak in the fine search: 2 ms
const MIN_MATCH = 0.1; // normalized correlation below this: the part is not in the MP4's sound

// The parts the mix placed: the score from 0 s, and each scene's narration at its start plus the
// lead, played at `speed` (the mix runs atempo before placing it).
export interface AudioRefs {
  score?: string;
  narration: { id: string; file: string; at: number }[];
  speed: number;
}

type Found = { ms: number; beyond: boolean } | "silent" | "missing";

function prefixSquares(x: Float32Array): Float64Array {
  const p = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) p[i + 1] = p[i]! + x[i]! * x[i]!;
  return p;
}

// The normalized correlation of `ref` placed at sample p of `mix`, over the samples they share.
function ncc(mix: Float32Array, mm: Float64Array, ref: Float32Array, rr: Float64Array, p: number) {
  const a = Math.max(0, -p),
    b = Math.min(ref.length, mix.length - p);
  if (b - a < ref.length / 2) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += ref[i]! * mix[p + i]!;
  const e = (mm[p + b]! - mm[p + a]!) * (rr[b]! - rr[a]!);
  return e > 0 ? s / Math.sqrt(e) : 0;
}

// The best place for `ref` in `mix` within `reach` samples of `center`, between samples.
function peak(
  mix: Float32Array,
  mm: Float64Array,
  ref: Float32Array,
  center: number,
  reach: number
): { at: number; v: number; edge: boolean } {
  const rr = prefixSquares(ref);
  const v = Array.from({ length: 2 * reach + 1 }, (_, k) =>
    ncc(mix, mm, ref, rr, center + k - reach)
  );
  const k = v.reduce((best, x, i) => (x > v[best]! ? i : best), 0);
  if (k === 0 || k === v.length - 1) return { at: center + k - reach, v: v[k]!, edge: true };
  const y0 = v[k - 1]!,
    y1 = v[k]!,
    y2 = v[k + 1]!;
  const den = y0 - 2 * y1 + y2;
  return { at: center + k - reach + (den < 0 ? (0.5 * (y0 - y2)) / den : 0), v: y1, edge: false };
}

// Lowpassed under the coarse rate's Nyquist frequency, then every STEP-th sample.
function coarse(x: Float32Array): Float32Array {
  const low = chain(x, "lp", 800, 2, true);
  return Float32Array.from({ length: Math.floor(low.length / STEP) }, (_, i) => low[i * STEP]!);
}

interface Mix {
  full: Float32Array;
  fullSq: Float64Array;
  low: Float32Array;
  lowSq: Float64Array;
}

// How many ms after `at` the part `ref` plays in the mix (negative: before).
function offsetOf(mix: Mix, ref: Float32Array, at: number): Found {
  if (ref.every((v) => Math.abs(v) < 1e-4)) return "silent";
  const p = Math.round(at * SR);
  const reach = Math.round((SEARCH_MS * SR) / 1000 / STEP);
  const c = peak(mix.low, mix.lowSq, coarse(ref), Math.round(p / STEP), reach);
  if (c.v < MIN_MATCH) return "missing";
  if (c.edge) return { ms: ((c.at * STEP - p) / SR) * 1000, beyond: true };
  const f = peak(mix.full, mix.fullSq, ref, Math.round(c.at * STEP), FINE);
  return { ms: ((f.at - p) / SR) * 1000, beyond: false };
}

const signed = (ms: number): string =>
  `${ms < 0 && Math.abs(ms) >= 0.05 ? "-" : "+"}${Math.abs(ms).toFixed(1)}`;

function decodeSound(mp4: string): Float32Array | null {
  try {
    return decodeMono(mp4);
  } catch (e) {
    // an MP4 without an audio stream: ffmpeg finds nothing to write
    if (e instanceof Error && /does not contain any stream|matches no streams/.test(e.message))
      return null;
    throw e;
  }
}

// The offset of the score and of each scene's narration in the MP4's sound. More than half a frame
// off (`500 / fps` ms) is a problem: every hit and word the picture was timed to is off by as much.
export function measureAudio(mp4: string, refs: AudioRefs, fps: number): SyncResult {
  const sound = decodeSound(mp4);
  if (!sound) return { lines: [], problems: ["the MP4 has no sound: build it again"] };
  const low = coarse(sound);
  const mix = { full: sound, fullSq: prefixSquares(sound), low, lowSq: prefixSquares(low) };
  const half = 500 / fps;
  const problems: string[] = [];
  const judge = (what: string, f: Found): number | null => {
    if (f === "silent") return null;
    if (f === "missing") {
      problems.push(`${what} could not be found in the MP4's sound: build it again`);
      return null;
    }
    if (f.beyond || Math.abs(f.ms) > half)
      problems.push(
        `${what} plays ${f.beyond ? "more than 100" : signed(f.ms)} ms ${f.ms >= 0 ? "late" : "early"} in the MP4 against where the mix put it (at most ±${half.toFixed(1)} ms, half a frame): the sound moved after mixing, so every hit and word the picture was timed to is off by as much`
      );
    return f.ms;
  };
  const score = refs.score ? judge("the score", offsetOf(mix, decodeMono(refs.score), 0)) : null;
  const filter = `atempo=${refs.speed}`;
  const voice = refs.narration
    .map((n) =>
      judge(`the narration of "${n.id}"`, offsetOf(mix, decodeMono(n.file, filter), n.at))
    )
    .filter((v): v is number => v !== null);
  const worst = voice.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
  const line =
    `audio: score ${score === null ? "not measured" : `${signed(score)} ms`}, ` +
    `narration ${voice.length ? `max ±${worst.toFixed(1)} ms` : "not measured"}`;
  return { lines: [line], problems };
}
