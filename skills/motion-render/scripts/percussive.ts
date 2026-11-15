// The percussive part of the lows, for telling kicks from bass. A bass line can fill the lows as
// loudly as the kick and roll between the kicks, so the level of the lows alone cannot tell them
// apart (#54). In a spectrogram a bass note runs along time and a kick stands up across frequency;
// median filtering along each direction separates the two (harmonic-percussive separation), and the
// energy of the percussive part below 150 Hz is where the kicks are.
import { SR } from "./signal.ts";

const N = 2048; // 85 ms frames: bins of 12 Hz, fine enough to resolve a bass note in the lows
const HOP = 120; // 5 ms
export const PFPS = SR / HOP; // frames per second of the envelope
const LO = 2, // bins of the kick: 23..150 Hz
  HI = 13;
const ALONG = 8; // half-lengths of the medians: 85 ms along time, 50 Hz across frequency
const ACROSS = 4;
const KEEP = HI + ACROSS + 1; // bins needed for the median across frequency

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len,
      wr = Math.cos(a),
      wi = Math.sin(a),
      half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < half; k++) {
        const p = i + k,
          q = p + half;
        const vr = re[q]! * cr - im[q]! * ci,
          vi = re[q]! * ci + im[q]! * cr;
        re[q] = re[p]! - vr;
        im[q] = im[p]! - vi;
        re[p] = re[p]! + vr;
        im[p] = im[p]! + vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// Magnitudes of the lowest KEEP bins, one frame per HOP, each frame centred on its time.
function lowSpectrum(x: Float32Array): Float64Array[] {
  const win = Float64Array.from(
    { length: N },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
  );
  const frames: Float64Array[] = [];
  const re = new Float64Array(N),
    im = new Float64Array(N);
  for (let c = 0; c < x.length; c += HOP) {
    for (let i = 0; i < N; i++) {
      re[i] = (x[c - N / 2 + i] ?? 0) * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    frames.push(Float64Array.from({ length: KEEP }, (_, k) => Math.hypot(re[k]!, im[k]!)));
  }
  return frames;
}

function median(v: number[]): number {
  v.sort((a, b) => a - b);
  return v[v.length >> 1]!;
}

// Energy of the percussive part of 23..150 Hz, one value per 5 ms frame (frame i at i / PFPS s).
export function lowPercussion(x: Float32Array): Float64Array {
  const S = lowSpectrum(x);
  const out = new Float64Array(S.length);
  for (let f = 0; f < S.length; f++) {
    let e = 0;
    for (let k = LO; k <= HI; k++) {
      const along: number[] = [],
        across: number[] = [];
      for (let d = -ALONG; d <= ALONG; d++) along.push(S[f + d]?.[k] ?? 0);
      for (let d = -ACROSS; d <= ACROSS; d++) across.push(S[f]![k + d] ?? 0);
      const h = median(along),
        p = median(across);
      const share = (p * p) / (p * p + h * h + 1e-12);
      e += (S[f]![k]! * share) ** 2;
    }
    out[f] = Math.sqrt(e);
  }
  return out;
}
