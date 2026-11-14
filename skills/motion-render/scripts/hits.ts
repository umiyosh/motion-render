// Every drum hit of a track on a known grid: at each 16th-note slot, whether the kick (lows), the
// snare (mids with bright noise), a rim or ghost note (mids alone) or a hat (highs) hit, and how
// hard. The film animates from this list, so each slot is judged from the music itself.
import { chain, biquad, db, envelope, FPS, percentile, SR } from "./signal.ts";

type HitKind = "kick" | "snare" | "rim" | "ghost" | "hat";

export interface Hit {
  t: number; // the grid time of its 16th (the track sits on the grid within a few ms)
  slot: number; // 16th index from the grid's start
  k: HitKind;
  v: number; // 0..1, against the loudest hits of its kind in the track
}

// Rise of the log envelope over 8 ms, counted from `floor` up. Without a floor, a hit right after
// silence (the first beat of a drop) rises fastest where the noise first stirs, before the hit itself,
// and its level is read there and comes out too low to count.
function rise(e: Float64Array, floor: number): Float64Array {
  const o = new Float64Array(e.length);
  for (let i = 4; i < e.length - 4; i++)
    o[i] = Math.max(0, Math.log10(e[i + 4]! + floor) - Math.log10(e[i - 4]! + floor));
  return o;
}

interface Band {
  e: Float64Array;
  r: Float64Array;
}

function band(x: Float32Array): Band {
  const e = envelope(x, 10);
  return { e, r: rise(e, 0.003 * (percentile(e, 0.95) || 1e-5)) }; // 50 dB under the band's loud parts
}

interface Slot {
  t: number;
  lv: Record<"L" | "M" | "H", number>; // level just after the strongest rise near the slot, dB
  grow: Record<"L" | "M" | "H", number>; // how much each band grew across the slot, dB
}

// Level 6 ms after the strongest rise within -25..+35 ms of t.
// The loudest point 6-30 ms after the strongest rise: a bar placed after silence starts with a short
// fade-in of the audio just before it, whose rise can come before the hit's own; reading the peak
// that follows still finds the hit.
function levelAt(b: Band, t: number): number {
  const a = Math.round((t - 0.025) * FPS),
    z = Math.round((t + 0.035) * FPS);
  let m = Math.max(4, a);
  for (let i = Math.max(4, a); i < Math.min(b.r.length - 4, z); i++) if (b.r[i]! > b.r[m]!) m = i;
  let peak = 0;
  for (let i = m + 6; i <= m + 30 && i < b.e.length; i++) peak = Math.max(peak, b.e[i]!);
  return db(peak);
}

// The level 15 ms after t against the quietest point in the 40 ms before.
function growAt(e: Float64Array, t: number): number {
  const c = Math.round(t * FPS);
  let lo = Infinity;
  for (let i = Math.max(0, c - 45); i <= c - 5; i++) lo = Math.min(lo, e[i] ?? Infinity);
  let hi = 0;
  for (let i = c; i <= c + 25 && i < e.length; i++) hi = Math.max(hi, e[i]!);
  return db(hi) - db(Number.isFinite(lo) ? lo : 0);
}

// Level of the loudest 3% of slots: what a full hit of that band reads as in this track.
function top(slots: Slot[], f: (s: Slot) => number): number {
  const v = slots.map(f).sort((a, b) => b - a);
  return v[Math.floor(v.length * 0.03)] ?? 1;
}

const clamp = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;

function judge(s: Slot, slot: number, ref: Slot["lv"]): Hit[] {
  const out: Hit[] = [];
  const t = Math.round(s.t * 1000) / 1000;
  // kick: the lows grow by 9 dB or more and are loud
  if (s.grow.L >= 9 && s.lv.L > ref.L - 18)
    out.push({ t, slot, k: "kick", v: clamp(1 + (s.lv.L - ref.L) / 18) });
  // snare: the mids jump and are loud, with bright noise on top; the same without the highs is a rim
  if (s.grow.M >= 14 && s.lv.M > ref.M - 8)
    out.push({
      t,
      slot,
      k: s.lv.H > ref.H - 12 ? "snare" : "rim",
      v: clamp(1 + (s.lv.M - ref.M) / 8),
    });
  else if (s.grow.M >= 8 && s.lv.M > ref.M - 20)
    out.push({ t, slot, k: "ghost", v: clamp(1 + (s.lv.M - ref.M) / 20) });
  else if (s.grow.H >= 15 && s.lv.H > ref.H - 14)
    out.push({ t, slot, k: "hat", v: clamp(1 + (s.lv.H - ref.H) / 14) });
  return out;
}

// The hits of mono track `x` (analysis rate) on a 16th grid of `bpm` that starts at `t0` seconds.
export function detectHits(x: Float32Array, bpm: number, t0 = 0): Hit[] {
  const L = band(chain(x, "lp", 110, 2)),
    M = band(biquad(chain(x, "hp", 250, 3), "lp", 2500)),
    H = band(chain(x, "hp", 7000, 3));
  const step = 60 / bpm / 4;
  const slots: Slot[] = [];
  for (let t = t0; t < x.length / SR - 0.04; t += step) {
    slots.push({
      t,
      lv: { L: levelAt(L, t), M: levelAt(M, t), H: levelAt(H, t) },
      grow: { L: growAt(L.e, t), M: growAt(M.e, t), H: growAt(H.e, t) },
    });
  }
  const ref = {
    L: top(slots, (s) => s.lv.L),
    M: top(slots, (s) => s.lv.M),
    H: top(slots, (s) => s.lv.H),
  };
  return slots.flatMap((s, i) => judge(s, i, ref));
}

// One bar of hits as 16 characters in four groups: X kick and snare, K kick, S snare, r rim,
// g ghost, - hat, . nothing.
export function pattern(hits: Hit[], bar: number): string {
  let row = "";
  for (let j = 0; j < 16; j++) {
    const at = hits.filter((h) => h.slot === bar * 16 + j).map((h) => h.k);
    const K = at.includes("kick"),
      S = at.includes("snare") || at.includes("rim");
    row +=
      K && S
        ? "X"
        : K
          ? "K"
          : at.includes("snare")
            ? "S"
            : at.includes("rim")
              ? "r"
              : at.includes("ghost")
                ? "g"
                : at.includes("hat")
                  ? "-"
                  : ".";
    if (j % 4 === 3 && j < 15) row += " ";
  }
  return row;
}
