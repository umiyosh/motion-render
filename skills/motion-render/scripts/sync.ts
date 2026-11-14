// How a beat-synced MP4 keeps time, measured on the MP4: whether the narration runs on, whether the
// whole picture changes on the frame of each drop and of the final hit, and whether the picture
// moves on the frame of each kick in the drops. Each hit is compared with the same measure taken an
// 8th note later, where there is no hit, so a picture that is always moving does not pass.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { inOrder } from "./inorder.ts";
import { findFfmpeg, exited } from "./audio.ts";
import { clock, type Script, type Timing } from "./work.ts";
import type { Hit } from "./hits.ts";
import { percentile } from "./signal.ts";

const W = 240,
  H = 135;
// The picture is cut into 8 x 6 blocks: a flame or a meter that reacts to a kick is a small part of
// the frame, and its change is lost in the mean of the whole frame.
const COLS = 8,
  ROWS = 6,
  BLOCKS = COLS * ROWS;
const E = 0.008; // films show a hit this much early (kit/beat.js)
// Frames sampled across a preview for the film's usual change (the MP4 report reads them all).
const USUAL_SAMPLES = 300;

// Per frame, the mean absolute change of each block from the frame before, in gray levels.
interface Motion {
  frames: number;
  block(f: number, b: number): number;
  whole(f: number): number; // mean over the blocks
  sampled: number[]; // the frames whose change is known: all of an MP4, some of a preview
}

function blockOf(i: number): number {
  const x = i % W,
    y = Math.floor(i / W);
  return (
    Math.min(ROWS - 1, Math.floor((y * ROWS) / H)) * COLS +
    Math.min(COLS - 1, Math.floor((x * COLS) / W))
  );
}

function frameChange(f: Buffer, prev: Buffer | null): Float32Array {
  const b = new Float32Array(BLOCKS);
  if (!prev) return b;
  for (let i = 0; i < f.length; i++) b[blockOf(i)] += Math.abs(f[i]! - prev[i]!);
  const per = (W * H) / BLOCKS;
  return b.map((v) => v / per);
}

async function motionOf(mp4: string): Promise<Motion> {
  const ff = spawn(
    findFfmpeg(),
    [
      "-v",
      "error",
      "-i",
      mp4,
      "-vf",
      `scale=${W}:${H}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const size = W * H;
  const out: Float32Array[] = [];
  let prev: Buffer | null = null,
    rest = Buffer.alloc(0);
  ff.stdout.on("data", (d: Buffer) => {
    rest = Buffer.concat([rest, d]);
    while (rest.length >= size) {
      const f = Buffer.from(rest.subarray(0, size));
      out.push(frameChange(f, prev));
      prev = f;
      rest = rest.subarray(size);
    }
  });
  const code = await exited(ff);
  if (code !== 0) throw new Error(`ffmpeg could not read ${mp4}`);
  return {
    frames: out.length,
    block: (f, b) => out[f]?.[b] ?? 0,
    whole: (f) => (out[f] ? out[f].reduce((a, v) => a + v, 0) / BLOCKS : 0),
    sampled: out.map((_, f) => f),
  };
}

export interface SyncResult {
  lines: string[];
  problems: string[];
}

function narration(timing: Timing, script: Pick<Script, "lead">, bar: number): SyncResult {
  const spans = timing.scenes.map(
    (s) => [s.start + script.lead, s.start + script.lead + s.speech] as const
  );
  const voiced = spans.reduce((a, [x, y]) => a + y - x, 0);
  const share = voiced / (spans.at(-1)![1] - spans[0]![0]);
  const gaps = spans
    .slice(1)
    .map(([a], i) => ({ gap: a - spans[i]![1], at: timing.scenes[i + 1]!.id }));
  const worst = gaps.reduce((a, g) => (g.gap > a.gap ? g : a), { gap: 0, at: "" });
  const limit = Math.max(2, bar + 0.8); // a scene can wait up to a bar for its section to start
  const line = `narration: voice ${(share * 100).toFixed(0)}% of the time, longest pause ${worst.gap.toFixed(2)} s (before ${worst.at || "-"})`;
  return {
    lines: [line],
    problems:
      worst.gap > limit
        ? [
            `the narration stops for ${worst.gap.toFixed(2)} s before "${worst.at}" (at most ${limit.toFixed(1)} s)`,
          ]
        : [],
  };
}

// The big moments: each drop and the final hit should change the whole picture on their frame, by
// far more than the film's usual large changes (its 90th percentile).
function peaks(m: Motion, fps: number, timing: Timing): SyncResult {
  const usual = Math.max(
    0.5,
    percentile(
      Float64Array.from(m.sampled, (f) => m.whole(f)),
      0.9
    )
  );
  const cues = timing.scenes
    .filter((s) => s.section === "drop")
    .map((s) => ({ what: `drop "${s.id}"`, t: s.start, need: true }));
  // A film with no drop has no peak for its last hit to answer: its ending is measured, not required
  // to turn the whole picture over, which would bolt a jolt onto a calm film.
  if (timing.end !== undefined)
    cues.push({ what: "final hit", t: timing.end, need: cues.length > 0 });
  const lines: string[] = [],
    problems: string[] = [];
  for (const c of cues) {
    const f0 = Math.round(c.t * fps);
    let best = f0;
    for (let f = Math.max(1, f0 - 3); f <= Math.min(m.frames - 1, f0 + 3); f++)
      if (m.whole(f) > m.whole(best)) best = f;
    const ms = (best / fps - c.t) * 1000,
      x = m.whole(best) / usual;
    lines.push(
      `${c.what} ${clock(c.t)}: the whole picture changes ${x.toFixed(0)}x the film's usual large change, ${ms >= 0 ? "+" : ""}${ms.toFixed(0)} ms from the hit`
    );
    if (!c.need) continue;
    if (x < 4)
      problems.push(
        `${c.what} at ${clock(c.t)}: the picture changes only ${x.toFixed(1)}x its usual large change (needs 4x): change the whole picture on this hit, in the way the story's event calls for`
      );
    else if (Math.abs(ms) > 1000 / fps + 10)
      problems.push(`${c.what} at ${clock(c.t)}: the change is ${ms.toFixed(0)} ms off the hit`);
  }
  return { lines, problems };
}

const median4 = (f: (d: number) => number): number => {
  const v = [2, 3, 4, 5].map(f).sort((a, b) => a - b);
  return (v[1]! + v[2]!) / 2;
};

// Whether some part of the picture moves on the frame of hit time t (or the next): a block whose
// change is 3 times its usual change in the frames just before, and at least 2 gray levels. Null
// right after a big change (a flash, a shake), where a reaction cannot be told apart.
function moves(m: Motion, fps: number, t: number): boolean | null {
  const f0 = Math.ceil((t - E) * fps - 1e-6);
  if (f0 < 6 || f0 + 1 >= m.frames) return null;
  if (median4((d) => m.whole(f0 - d)) > 3) return null;
  for (let b = 0; b < BLOCKS; b++) {
    const base = median4((d) => m.block(f0 - d, b));
    if (Math.max(m.block(f0, b), m.block(f0 + 1, b)) >= 3 * base + 2) return true;
  }
  return false;
}

function rateOf(m: Motion, fps: number, times: number[]): { rate: number; n: number } {
  const seen = times.map((t) => moves(m, fps, t)).filter((x): x is boolean => x !== null);
  return { rate: seen.length ? seen.filter(Boolean).length / seen.length : 0, n: seen.length };
}

// The spans of the drop sections: from a drop scene to the next scene that starts a section.
function dropSpans(timing: Timing): [number, number][] {
  const marked = timing.scenes.filter((s) => s.section);
  return marked.flatMap((s, i) =>
    s.section === "drop" ? [[s.start, marked[i + 1]?.start ?? timing.total]] : []
  );
}

// The hit times in the drops, and the same an 8th later where no hit is, for kicks and for snares.
function reactionTimes(
  hits: Hit[],
  bpm: number,
  spans: [number, number][]
): { name: "kicks" | "snares"; on: number[]; off: number[] }[] {
  const eighth = 30 / bpm;
  const inDrop = (t: number): boolean => spans.some(([a, b]) => t >= a && t < b);
  return (["kicks", "snares"] as const).flatMap((name) => {
    const kinds: Hit["k"][] = name === "kicks" ? ["kick"] : ["snare", "rim"];
    const list = hits.filter((h) => kinds.includes(h.k) && h.v >= 0.5 && inDrop(h.t));
    if (!list.length) return [];
    const free = list.filter((h) => !hits.some((o) => Math.abs(o.t - (h.t + eighth)) < 0.04));
    return [{ name, on: list.map((h) => h.t), off: free.map((h) => h.t + eighth) }];
  });
}

// Kicks and snares in the drops: the share whose frame moves, against the same share an 8th later
// where no hit is, so a picture that is always moving does not pass. Only the drops need a reaction
// to every kick: outside them, a thing that jumps on every hit without a reason of its own looks
// forced. Snares are reported, not required: not every subject has a thing that snaps.
function reactions(
  m: Motion,
  fps: number,
  hits: Hit[],
  bpm: number,
  spans: [number, number][]
): SyncResult {
  const lines: string[] = [],
    problems: string[] = [];
  for (const { name, on: onTimes, off: offTimes } of reactionTimes(hits, bpm, spans)) {
    const on = rateOf(m, fps, onTimes),
      off = rateOf(m, fps, offTimes);
    const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
    lines.push(
      `${name} in the drops: the picture moves on ${pct(on.rate)} of ${on.n} (an 8th later, with no hit: ${pct(off.rate)})`
    );
    if (name === "kicks" && (on.rate < 0.8 || on.rate - off.rate < 0.4))
      problems.push(
        `kicks in the drops: the picture moves on ${pct(on.rate)} of them, ${pct(off.rate)} with no hit (needs 80%, and 40 points more than with no hit): let the thing that drives the story answer every kick, large enough to be seen, and settle within an 8th`
      );
  }
  return { lines, problems };
}

function bpmOf(timing: Timing): number {
  if (!timing.bpm) throw new Error("timing.json has no bpm: sync measures beat-synced films only");
  return timing.bpm;
}

function measure(
  motion: Motion,
  fps: number,
  timing: Timing,
  script: Pick<Script, "lead">,
  hits: Hit[]
): SyncResult {
  const bpm = bpmOf(timing);
  const parts = [
    narration(timing, script, 240 / bpm),
    peaks(motion, fps, timing),
    reactions(motion, fps, hits, bpm, dropSpans(timing)),
  ];
  return { lines: parts.flatMap((p) => p.lines), problems: parts.flatMap((p) => p.problems) };
}

// The whole report for one MP4 of a beat-synced film.
export async function measureSync(
  mp4: string,
  timing: Timing,
  script: Pick<Script, "lead">,
  hits: Hit[]
): Promise<SyncResult> {
  bpmOf(timing);
  const motion = await motionOf(mp4);
  // The film renders at a whole frame rate. Its MP4 can decode a frame short, and frames/total would
  // then time every later frame late (11 ms at 57 s of a 60 fps film).
  const fps = Math.round(motion.frames / timing.total);
  return measure(motion, fps, timing, script, hits);
}

// The frames whose change the report reads: around each drop and the final hit, the frames before
// and on each hit (and an 8th later) in the drops, and an even sample of the film for its usual
// change. A preview draws only these (and the frame before each), not the whole film.
function framesToMeasure(
  timing: Timing,
  hits: Hit[],
  fps: number
): { frames: number[]; usual: number[] } {
  const n = Math.round(timing.total * fps);
  const want = new Set<number>();
  const span = (a: number, b: number) => {
    for (let f = Math.max(1, a); f <= Math.min(n - 1, b); f++) want.add(f);
  };
  const cues = timing.scenes.filter((s) => s.section === "drop").map((s) => s.start);
  if (timing.end !== undefined) cues.push(timing.end);
  for (const t of cues) span(Math.round(t * fps) - 3, Math.round(t * fps) + 3);
  for (const r of reactionTimes(hits, bpmOf(timing), dropSpans(timing)))
    for (const t of [...r.on, ...r.off]) {
      const f0 = Math.ceil((t - E) * fps - 1e-6);
      span(f0 - 5, f0 + 1);
    }
  // The usual change comes from an even sample only: the frames around hits move more than most,
  // and counting them would raise the usual change and shrink every peak.
  const step = Math.max(1, Math.floor(n / USUAL_SAMPLES));
  const usual: number[] = [];
  for (let f = step; f < n; f += step) usual.push(f);
  for (const f of usual) want.add(f);
  return { frames: [...want].sort((a, b) => a - b), usual };
}

// The change of each frame in `frames` from the frame before, from pictures drawn on demand. The
// pictures stream through ffmpeg in order, `ahead` at a time, so only gray thumbnails are kept.
async function motionOfPictures(
  frames: number[],
  usual: number[],
  draw: (f: number) => Promise<Buffer>,
  total: number,
  ahead: number
): Promise<Motion> {
  const need = [...new Set(frames.flatMap((f) => [f - 1, f]))].sort((a, b) => a - b);
  const ff = spawn(
    findFfmpeg(),
    [
      "-v",
      "error",
      "-f",
      "image2pipe",
      "-i",
      "-",
      "-vf",
      `scale=${W}:${H}:flags=area,format=gray`,
    ].concat(["-f", "rawvideo", "-"]),
    { stdio: ["pipe", "pipe", "inherit"] }
  );
  const size = W * H;
  const gray: Buffer[] = [];
  let rest = Buffer.alloc(0);
  ff.stdout.on("data", (d: Buffer) => {
    rest = Buffer.concat([rest, d]);
    for (; rest.length >= size; rest = rest.subarray(size))
      gray.push(Buffer.from(rest.subarray(0, size)));
  });
  const exit = exited(ff);
  ff.stdin.on("error", () => {}); // EPIPE when ffmpeg dies early; its exit code reports the cause.
  try {
    for await (const png of inOrder(need.length, ahead, (i) => draw(need[i]!)))
      if (!ff.stdin.write(png)) await once(ff.stdin, "drain");
  } finally {
    ff.stdin.end();
  }
  if ((await exit) !== 0) throw new Error("ffmpeg could not read the preview's pictures");
  const at = new Map(need.map((f, i) => [f, gray[i]!]));
  const change = new Map(
    frames.map((f) => [f, frameChange(at.get(f)!, at.get(f - 1) ?? null)] as const)
  );
  return {
    frames: total,
    block: (f, b) => change.get(f)?.[b] ?? 0,
    whole: (f) => {
      const c = change.get(f);
      return c ? c.reduce((a, v) => a + v, 0) / BLOCKS : 0;
    },
    sampled: usual,
  };
}

// The same report as measureSync, from only the frames it reads, drawn at `fps` by `draw` (a
// picture of frame f): no MP4 is needed, so a film can be measured before it is built.
export async function measureSyncPictures(
  pictures: { draw: (f: number) => Promise<Buffer>; fps: number; ahead: number },
  timing: Timing,
  script: Pick<Script, "lead">,
  hits: Hit[]
): Promise<SyncResult> {
  const { draw, fps, ahead } = pictures;
  const { frames, usual } = framesToMeasure(timing, hits, fps);
  const total = Math.round(timing.total * fps);
  const motion = await motionOfPictures(frames, usual, draw, total, ahead);
  return measure(motion, fps, timing, script, hits);
}
