// A first draft of score.bars for each take: the film's sections laid on runs of the take's bars
// whose character fits (quiet, drums, full), each section head meeting what "score" checks, and as
// few joins as possible. Claude starts from the draft and changes it to fit the story; the draft only
// saves reading four bar tables from scratch.
import type { Take, TakeBar } from "./score.ts";
import type { Timing } from "./work.ts";

type Kind = "quiet" | "drums" | "full";
type Part = "intro" | "build" | "drop" | "break" | "groove" | "outro";

export interface Draft {
  take: number;
  bars: string;
  joins: number;
  score: number;
  misses: string[]; // section heads the take has no fitting bar for
}

function kind(b: TakeBar): Kind {
  if (b.kick + b.snare === 0 || b.lvl <= -12) return "quiet";
  return b.lvl >= -3 && b.kick >= 1 && b.kick + b.snare >= 3 ? "full" : "drums";
}

const FIT: Record<Part, Record<Kind, number>> = {
  intro: { quiet: 2, drums: 1, full: -2 },
  build: { quiet: 0, drums: 2, full: 0 },
  drop: { quiet: -3, drums: 0, full: 2 },
  break: { quiet: 2, drums: 1, full: -3 },
  groove: { quiet: -1, drums: 2, full: 1 },
  outro: { quiet: 2, drums: 1, full: -1 },
};

const hitOn1 = (b: TakeBar): boolean => /^[KSX]/.test(b.row);
const JOIN = 3; // a run that goes straight on from the one before is worth this much
const HEAD = 10; // a section head that fails what "score" checks costs this much
const MOMENT = 4; // a jump of 9 dB or more that no section head explains costs this much

interface Run {
  part: Part;
  from: number; // film bar
  len: number;
}

// The film's bars up to the final hit, as runs of one section each.
function runs(timing: Timing, bar: number, last: number): Run[] {
  const heads = timing.scenes
    .filter((s) => s.section)
    .map((s) => ({ at: Math.round(s.start / bar), part: s.section as Part }))
    .filter((h) => h.at < last);
  if (!heads.length || heads[0]!.at > 0) heads.unshift({ at: 0, part: "intro" });
  return heads
    .map((h, i) => ({ part: h.part, from: h.at, len: (heads[i + 1]?.at ?? last) - h.at }))
    .filter((r) => r.len > 0);
}

// The value of playing take bars s .. s+len-1 for a run, after take bar `prev` (-1 at the start).
function fit(bars: TakeBar[], r: Run, s: number, prev: number): number {
  let v = 0;
  for (let i = 0; i < r.len; i++) v += FIT[r.part][kind(bars[s + i]!)];
  // The music dropping out or coming back inside a section is a moment the story has no event for.
  for (let i = 1; i < r.len; i++)
    if (Math.abs(bars[s + i]!.lvl - bars[s + i - 1]!.lvl) >= 9) v -= MOMENT;
  const head = bars[s]!,
    before = prev >= 0 ? bars[prev]! : undefined;
  if (r.part === "drop" && (!hitOn1(head) || head.lvl < -3 || (before && head.lvl < before.lvl)))
    v -= HEAD;
  if (r.part === "break" && before && head.lvl > before.lvl - 6) v -= HEAD;
  // Only a break may stop the music dead; elsewhere a section comes in without a jolt.
  if (r.part !== "break" && r.part !== "drop" && before && head.lvl <= before.lvl - 9) v -= MOMENT;
  if (s === prev + 1) v += JOIN;
  return v;
}

// The final hit: a bar with a hit on beat 1 and quieter bars after it, then those bars to the end.
function ending(bars: TakeBar[], prev: number, n: number): { list: number[]; ok: boolean } {
  const ok = (i: number) => hitOn1(bars[i]!) && (bars[i + 1]?.lvl ?? -99) <= bars[i]!.lvl - 3;
  const pick = ok(prev + 1)
    ? prev + 1
    : bars.map((_, i) => i).find((i) => i > bars.length / 2 && ok(i));
  if (pick === undefined) return { list: new Array<number>(n).fill(-1), ok: false };
  const list = Array.from({ length: n }, (_, k) => (pick + k < bars.length ? pick + k : -1));
  return { list, ok: true };
}

function compress(map: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < map.length;) {
    let j = i;
    while (map[i]! >= 0 && map[j + 1] === map[j]! + 1) j++;
    out.push(j > i ? `${map[i]}-${map[j]}` : String(map[i]));
    i = j + 1;
  }
  return out.join(",");
}

// The best start bar of each run over the whole film (dynamic programming on where the run before
// ended), so a section can choose bars that the next one goes straight on from.
function bestStarts(bars: TakeBar[], rs: Run[]): { starts: number[]; score: number } {
  const n = bars.length;
  // best[e] = best total with the runs so far ending on take bar e; from[r][e] = its start
  let best = new Map<number, number>([[-1, 0]]);
  const from: Map<number, { s: number; prev: number }>[] = [];
  for (const r of rs) {
    const next = new Map<number, number>(),
      back = new Map<number, { s: number; prev: number }>();
    for (const [prev, total] of best)
      for (let s = 0; s + r.len <= n; s++) {
        const v = total + fit(bars, r, s, prev),
          e = s + r.len - 1;
        if (v > (next.get(e) ?? -Infinity)) {
          next.set(e, v);
          back.set(e, { s, prev });
        }
      }
    from.push(back);
    best = next;
  }
  let end = -1,
    score = -Infinity;
  for (const [e, v] of best) if (v > score) [end, score] = [e, v];
  const starts: number[] = [];
  for (let r = rs.length - 1; r >= 0; r--) {
    const step = from[r]!.get(end)!;
    starts.unshift(step.s);
    end = step.prev;
  }
  return { starts, score };
}

// One take's draft for the film's bars.
function draftTake(take: Take, timing: Timing, bpm: number): Draft {
  const bar = 240 / bpm,
    total = Math.ceil(timing.total / bar - 1e-6),
    last = timing.end === undefined ? total : Math.round(timing.end / bar);
  const bars = take.bars;
  const rs = runs(timing, bar, last);
  const misses: string[] = [];
  if (rs.some((r) => r.len > bars.length))
    return {
      take: take.take,
      bars: "",
      joins: 0,
      score: -Infinity,
      misses: ["a section longer than the take"],
    };
  const { starts, score } = bestStarts(bars, rs);
  const map: number[] = [];
  rs.forEach((r, i) => {
    const s = starts[i]!;
    if (fit(bars, r, s, map.length ? map[map.length - 1]! : -1) < -HEAD / 2)
      misses.push(`bar ${r.from} (${r.part})`);
    for (let k = 0; k < r.len; k++) map.push(s + k);
  });
  const end = ending(bars, map.length ? map[map.length - 1]! : -1, total - last);
  if (!end.ok && timing.end !== undefined) misses.push(`bar ${last} (final hit)`);
  map.push(...end.list);
  const joins = map.slice(1).filter((b, i) => b !== map[i]! + 1).length;
  return { take: take.take, bars: compress(map), joins, score, misses };
}

// Drafts for every take, the best first.
export function draftScores(takes: Take[], timing: Timing, bpm: number): Draft[] {
  return takes
    .map((t) => draftTake(t, timing, bpm))
    .filter((d) => d.bars)
    .sort((a, b) => a.misses.length - b.misses.length || b.score - a.score);
}
