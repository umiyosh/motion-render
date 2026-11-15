// The tempo, beat grid and downbeat of a piece of music: autocorrelation for the period, dynamic
// programming for the beats (Ellis 2007), a weighted straight line through them for the grid, and
// the kicks and level changes for which beat of four starts a bar.
import { bands, db, FPS, mean, percentile, type Bands } from "./signal.ts";

// The beat period near `guess` seconds: the lag where the onset strength repeats best, scored over
// 1..8 beats so the answer is fine enough to start the tracker.
function period(onset: Float64Array, guess: number, span = 0.08): number {
  const D = 4; // ms per frame here
  const n = Math.floor(onset.length / D);
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < D; j++) m = Math.max(m, onset[i * D + j]!);
    o[i] = m;
  }
  const mu = mean(o);
  for (let i = 0; i < n; i++) o[i] -= mu;
  const K = 8;
  const maxLag = Math.ceil((guess * (1 + span) * K * 1000) / D) + 2;
  const acf = new Float64Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += o[i]! * o[i - lag]!;
    acf[lag] = s / Math.max(1, n - lag);
  }
  const at = (lag: number): number => {
    const i = Math.floor(lag),
      f = lag - i;
    return (acf[i] ?? 0) * (1 - f) + (acf[i + 1] ?? 0) * f;
  };
  let best = { T: guess, score: -Infinity };
  for (let T = guess * (1 - span); T <= guess * (1 + span); T += 0.0001) {
    let s = 0;
    for (let k = 1; k <= K; k++) s += at((k * T * 1000) / D);
    if (s > best.score) best = { T, score: s };
  }
  return best.T;
}

interface Beat {
  t: number;
  s: number; // onset strength there
}

// The beat times that collect the most onset strength while staying near period T, on 2 ms frames;
// each beat is then moved to the onset peak within 20 ms.
function track(onset: Float64Array, T: number): Beat[] {
  const D = 2;
  const n = Math.floor(onset.length / D);
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.max(onset[i * D]!, onset[i * D + 1] ?? 0);
  const sd = Math.sqrt(mean(o.map((v) => v * v))) || 1;
  const p = (T * 1000) / D;
  const lo = Math.round(p / 2),
    hi = Math.round(p * 2);
  const score = new Float64Array(n),
    back = new Int32Array(n).fill(-1);
  const pen = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) pen[d] = -400 * Math.log(d / p) ** 2;
  for (let i = 0; i < n; i++) {
    let best = 0,
      from = -1;
    for (let d = lo; d <= hi && d <= i; d++) {
      const v = score[i - d]! + pen[d]!;
      if (v > best) {
        best = v;
        from = i - d;
      }
    }
    score[i] = o[i]! / sd + best;
    back[i] = from;
  }
  let end = n - 1;
  for (let i = n - 1; i >= Math.max(0, n - Math.round(p)); i--)
    if (score[i]! > score[end]!) end = i;
  const frames: number[] = [];
  for (let i = end; i >= 0; i = back[i]!) frames.push(i);
  return frames.reverse().map((f) => peakNear(onset, f * D));
}

// The onset peak within 20 ms of frame c, refined between frames by a parabola.
function peakNear(onset: Float64Array, c: number): Beat {
  let m = c;
  for (let j = Math.max(1, c - 20); j <= Math.min(onset.length - 2, c + 20); j++)
    if (onset[j]! > onset[m]!) m = j;
  const a = onset[m - 1] ?? 0,
    b = onset[m] ?? 0,
    cc = onset[m + 1] ?? 0;
  const den = a - 2 * b + cc;
  const frac = den < 0 ? (0.5 * (a - cc)) / den : 0;
  return { t: (m + frac) / FPS, s: b };
}

interface Grid {
  T: number; // seconds per beat
  phase: number; // time of beat 0
  bpm: number;
}

// A straight grid through the tracked beats, weighted by onset strength, dropping beats more than
// 35 ms off after each pass.
function fit(beats: Beat[]): Grid {
  const med = percentile(
    beats.map((b) => b.s),
    0.5
  );
  let keep = beats.map((b, k) => ({ k, ...b })).filter((b) => b.s > 0.4 * med);
  let T = 0,
    phase = 0;
  for (let pass = 0; pass < 6; pass++) {
    let sw = 0,
      sk = 0,
      st = 0,
      skk = 0,
      skt = 0;
    for (const b of keep) {
      sw += b.s;
      sk += b.s * b.k;
      st += b.s * b.t;
      skk += b.s * b.k * b.k;
      skt += b.s * b.k * b.t;
    }
    T = (sw * skt - sk * st) / (sw * skk - sk * sk);
    phase = (st - T * sk) / sw;
    const next = keep.filter((b) => Math.abs(b.t - (phase + b.k * T)) < 0.035);
    if (next.length === keep.length || next.length < 8) break;
    keep = next;
  }
  return { T, phase, bpm: 60 / T };
}

interface BeatLevel {
  k: number;
  t: number;
  full: number; // dB
  low: number;
}

function levels(b: Bands, g: Grid): BeatLevel[] {
  const out: BeatLevel[] = [];
  for (let k = Math.ceil(-g.phase / g.T); g.phase + (k + 1) * g.T < b.seconds; k++) {
    const a = Math.round((g.phase + k * g.T) * FPS),
      z = Math.round((g.phase + (k + 1) * g.T) * FPS);
    const rmsOf = (e: Float64Array): number => {
      let s = 0;
      for (let i = a; i < z; i++) s += (e[i] ?? 0) ** 2;
      return db(Math.sqrt(s / Math.max(1, z - a)));
    };
    out.push({ k, t: g.phase + k * g.T, full: rmsOf(b.full), low: rmsOf(b.low) });
  }
  return out;
}

const mod4 = (k: number): number => ((k % 4) + 4) % 4;

// Where the level steps by 3 dB or more over 4 beats (full band or lows), as votes per beat of four.
function changeVotes(lv: BeatLevel[]): number[] {
  const w = 4;
  const avg = (i: number, j: number, f: (b: BeatLevel) => number): number =>
    mean(lv.slice(Math.max(0, i), Math.max(0, j)).map(f));
  const size = lv.map((_, i) => {
    if (i < w || i + w > lv.length) return 0;
    const full = avg(i, i + w, (x) => x.full) - avg(i - w, i, (x) => x.full);
    const low = avg(i, i + w, (x) => x.low) - avg(i - w, i, (x) => x.low);
    return Math.max(Math.abs(full), Math.abs(low));
  });
  const votes = [0, 0, 0, 0];
  size.forEach((v, i) => {
    if (v < 3) return;
    for (let j = Math.max(0, i - 2); j <= Math.min(size.length - 1, i + 2); j++)
      if (j !== i && size[j]! > v) return;
    votes[mod4(lv[i]!.k)]! += v;
  });
  return votes;
}

// Which beat of four starts a bar: the one where the kicks are strongest and the level changes fall,
// each vote as a share so neither outweighs the other by its units.
function downbeat(b: Bands, lv: BeatLevel[]): { down: number; kick: number[]; change: number[] } {
  const kick = [0, 0, 0, 0];
  for (const l of lv) {
    const i = Math.round(l.t * FPS);
    let m = 0;
    for (let j = i - 15; j <= i + 15; j++) m = Math.max(m, b.onsetLow[j] ?? 0);
    kick[mod4(l.k)]! += m;
  }
  const share = (v: number[]): number[] => {
    const s = v.reduce((a, x) => a + x, 0) || 1;
    return v.map((x) => Math.round((x / s) * 100) / 100);
  };
  const k = share(kick),
    c = share(changeVotes(lv));
  const both = k.map((x, i) => x + c[i]!);
  return { down: both.indexOf(Math.max(...both)), kick: k, change: c };
}

export interface TrackTempo {
  seconds: number;
  bpm: number; // measured
  T: number;
  first: number; // time of the first downbeat at or after 0
  votes: { kick: number[]; change: number[] }; // shares per beat of four, from beat `first`
}

// The tempo near `bpm` and the first downbeat of a mono track at the analysis rate.
export function measureTempo(x: Float32Array, bpm: number): TrackTempo {
  const b = bands(x);
  const grid = fit(track(b.onset, period(b.onset, 60 / bpm)));
  const lv = levels(b, grid);
  const { down, kick, change } = downbeat(b, lv);
  let k = Math.ceil(-grid.phase / grid.T - 1e-9);
  while (mod4(k) !== down) k++;
  const rot = (v: number[]): number[] => v.map((_, i) => v[(i + down) % 4]!);
  return {
    seconds: b.seconds,
    bpm: grid.bpm,
    T: grid.T,
    first: grid.phase + k * grid.T,
    votes: { kick: rot(kick), change: rot(change) },
  };
}
