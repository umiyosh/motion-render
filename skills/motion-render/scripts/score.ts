// The score of a beat-synced film. Each generated take is measured bar by bar (tempo, downbeat,
// level and drum pattern) so Claude can choose a take and the order of its bars; the chosen bars are
// then played at the film's tempo onto the film's bar grid, and the drum hits of the result are
// written for the film to animate from.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeMono, decodeStereo, db, percentile, RATE, SR } from "./signal.ts";
import { measureTempo } from "./tempo.ts";
import { detectHits, pattern, type Hit } from "./hits.ts";
import { clock, type Script, type Timing } from "./work.ts";
import { isRecord, readJson } from "./json.ts";

const BIAS = 0.005; // s: the beat tracker reads onsets this much early (measured on synthetic tracks)
const r3 = (t: number): number => Math.round(t * 1000) / 1000;

// Plays a track at the speed that makes its tempo `target` (pitch moves with it, by under a
// semitone for the 2-5% Lyria is off). atempo would keep the pitch but smears the drum hits.
function lockFilter(measured: number, target: number): string {
  return `aresample=${RATE},asetrate=${Math.round((RATE * target) / measured)},aresample=${RATE}`;
}

interface TakeBar {
  t: number; // start in the tempo-locked take, s
  lvl: number; // dB against the take's loud bars
  kick: number;
  snare: number;
  hat: number;
  row: string; // drum pattern (hits.ts)
}

export interface Take {
  take: number;
  file: string;
  measured: number; // BPM as generated
  filter: string; // ffmpeg filter that locks it to the film's tempo
  beat: number; // s per beat after the lock
  votes: { kick: number[]; change: number[] };
  bars: TakeBar[];
}

// RMS level of each `bar`-long span of mono `x` (analysis rate) starting at `t0`, in dB.
function barLevels(x: Float32Array, t0: number, bar: number, n: number): number[] {
  return Array.from({ length: n }, (_, b) => {
    const a = Math.max(0, Math.round((t0 + b * bar) * SR)),
      z = Math.min(x.length, Math.round((t0 + (b + 1) * bar) * SR));
    let s = 0;
    for (let i = a; i < z; i++) s += x[i]! * x[i]!;
    return db(Math.sqrt(s / Math.max(1, z - a)));
  });
}

const count = (hits: Hit[], b: number, kinds: Hit["k"][]): number =>
  hits.filter((h) => Math.floor(h.slot / 16) === b && kinds.includes(h.k)).length;

// One generated take (`file` relative to `work`), measured at the film's tempo.
export function measureTake(work: string, file: string, take: number, bpm: number): Take {
  const raw = measureTempo(decodeMono(join(work, file)), bpm);
  const filter = lockFilter(raw.bpm, bpm);
  const x = decodeMono(join(work, file), filter);
  const tempo = measureTempo(x, bpm);
  const bar = 240 / bpm;
  const n = Math.max(0, Math.floor((tempo.seconds - tempo.first) / bar + 0.5));
  const hits = detectHits(x, bpm, tempo.first);
  const lv = barLevels(x, tempo.first, bar, n);
  const loud = percentile(lv, 0.85);
  return {
    take,
    file,
    measured: Math.round(raw.bpm * 100) / 100,
    filter,
    beat: tempo.T,
    votes: tempo.votes,
    bars: lv.map((v, b) => ({
      t: r3(tempo.first + b * bar),
      lvl: Math.round(v - loud),
      kick: count(hits, b, ["kick"]),
      snare: count(hits, b, ["snare", "rim"]),
      hat: count(hits, b, ["hat"]),
      row: pattern(hits, b),
    })),
  };
}

function label(b: TakeBar, prev: TakeBar | undefined): string {
  const kind =
    b.lvl <= -25
      ? "quiet"
      : b.kick + b.snare === 0
        ? "no drums"
        : b.lvl >= -3 && b.kick >= 1 && b.kick + b.snare >= 3
          ? "full"
          : "drums";
  const step = prev ? b.lvl - prev.lvl : 0;
  return step >= 6 ? `${kind} ▲${step}` : step <= -6 ? `${kind} ▼${-step}` : kind;
}

// The bar table Claude reads to choose a take and its bars.
export function takeTable(t: Take, bpm: number): string {
  const speed = ((bpm / t.measured - 1) * 100).toFixed(1);
  const v = (a: number[]): string => a.map((x) => x.toFixed(2)).join(" ");
  const lines = [
    `take ${t.take}: ${t.file}  ${t.measured} BPM, played ${speed}% faster to ${bpm} BPM, ${t.bars.length} bars`,
    `  downbeat votes by beat of the bar (1 2 3 4): kicks ${v(t.votes.kick)}, level changes ${v(t.votes.change)}`,
    "  bar  time     level  K  S  H  pattern              what",
  ];
  t.bars.forEach((b, i) => {
    const cells = [String(i).padStart(5), clock(b.t).padStart(8), String(b.lvl).padStart(5)];
    cells.push(String(b.kick).padStart(2), String(b.snare).padStart(2), String(b.hat).padStart(2));
    lines.push(`${cells.join(" ")}  ${b.row}  ${label(b, t.bars[i - 1])}`);
  });
  return lines.join("\n");
}

// "0-11,12-18,-1,30" as a list of take bars (-1 = a silent bar), checked against the take's length.
export function parseBars(spec: string, count: number): number[] {
  const out: number[] = [];
  for (const part of spec.split(",").map((p) => p.trim())) {
    if (part === "-1") {
      out.push(-1);
      continue;
    }
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new Error(`score.bars: "${part}" is not a bar, a range a-b or -1`);
    const a = Number(m[1]),
      b = Number(m[2] ?? m[1]);
    if (b < a) throw new Error(`score.bars: "${part}" runs backwards`);
    if (b >= count) throw new Error(`score.bars: bar ${b} is past the take's ${count} bars`);
    for (let x = a; x <= b; x++) out.push(x);
  }
  return out;
}

const PRE = Math.round(0.008 * RATE); // copy from just before each bar line, so its first hit is whole
const X = Math.round(0.01 * RATE); // crossfade at every jump

// Copies the take's bars (interleaved stereo at RATE) to the film's bars: runs of consecutive take
// bars as one piece, a 10 ms crossfade at every jump and before every silent bar.
function renderBars(
  src: Float32Array,
  starts: number[],
  map: number[],
  bpm: number,
  seconds: number
): Float32Array {
  const barLen = 240 / bpm;
  const total = Math.round(seconds * RATE);
  const out = new Float32Array(total * 2);
  for (let j = 0; j < map.length;) {
    if (map[j]! < 0) {
      j++;
      continue;
    }
    let e = j;
    while (e + 1 < map.length && map[e + 1] === map[e]! + 1) e++;
    const d0 = Math.round(j * barLen * RATE) - PRE,
      len = Math.round((e + 1) * barLen * RATE) - PRE - d0,
      s0 = Math.round((starts[map[j]!]! + BIAS) * RATE) - PRE;
    for (let i = j === 0 ? 0 : -X; i < len; i++) {
      const d = d0 + i,
        s = s0 + i;
      if (d < 0 || d >= total || s < 0 || s * 2 + 1 >= src.length) continue;
      const g = i < 0 ? (i + X) / X : i >= len - X && e + 1 < map.length ? (len - i) / X : 1;
      out[d * 2] += src[s * 2]! * g;
      out[d * 2 + 1] += src[s * 2 + 1]! * g;
    }
    j = e + 1;
  }
  return out;
}

export function writeWav(x: Float32Array, file: string): void {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++)
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i]! * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

function isTake(v: unknown): v is Take {
  return (
    isRecord(v) &&
    typeof v.take === "number" &&
    typeof v.file === "string" &&
    typeof v.filter === "string" &&
    Array.isArray(v.bars)
  );
}

// The measured takes that "motion-render bgm" wrote.
export function loadTakes(work: string): Take[] {
  const file = join(work, "audio", "bgm", "takes.json");
  if (!existsSync(file)) throw new Error(`no takes yet: run "motion-render bgm ${work}"`);
  const raw = readJson(file);
  if (!Array.isArray(raw) || !raw.every(isTake))
    throw new Error(`${file} is malformed: run "motion-render bgm ${work}" again`);
  return raw;
}

export interface Scored {
  wav: string;
  loud: number; // dB of its loud bars (85th percentile of bar levels)
  hits: Hit[];
  map: number[];
  notes: string[]; // what does not look right
  moments: string[]; // what a listener notices in the music, each needing an event in the story
}

// Film bar of each scene that starts a section, and where the final hit falls.
function cues(timing: Timing, bar: number): { at: number; what: string; section: string }[] {
  const list = timing.scenes
    .filter((s) => s.section)
    .map((s) => ({ at: Math.round(s.start / bar), what: s.id, section: s.section ?? "" }));
  if (timing.end !== undefined)
    list.push({ at: Math.round(timing.end / bar), what: "final hit", section: "end" });
  return list;
}

// Whether the music does at each cue what its section asks: a drop slams in on its first beat, a
// break goes quiet, the final hit hits and then rings out.
function judgeCues(timing: Timing, bar: number, lv: number[], hits: Hit[]): string[] {
  const onBeat1 = (b: number): boolean =>
    hits.some(
      (h) => (h.k === "kick" || h.k === "snare") && h.slot >= b * 16 && h.slot <= b * 16 + 1
    );
  return cues(timing, bar).flatMap(({ at, what, section }) => {
    const here = lv[at] ?? -99,
      before = lv[at - 1] ?? -99,
      after = lv[at + 1] ?? -99;
    // A drop may rise straight out of its build, so it needs to be full, not a jump from silence.
    if (section === "drop" && (!onBeat1(at) || here < -3 || here < before))
      return [
        `bar ${at} (${what}, drop): the music should slam in on beat 1, at full level and no quieter than the bar before (${before} -> ${here} dB)`,
      ];
    if (section === "break" && here > before - 6)
      return [
        `bar ${at} (${what}, break): the music should calm down, 6 dB or more under the bar before (${before} -> ${here} dB)`,
      ];
    if (section === "end" && (!onBeat1(at) || after > here - 3))
      return [
        `bar ${at} (final hit): one hit on beat 1, then quieter bars (${here} -> ${after} dB)`,
      ];
    return [];
  });
}

// Bars where the music stops dead before the final hit: near silence right after a bar that was
// playing. One stop, where the story holds its breath, lands; a stop before every drop makes the
// music sound switched off again and again (six test films: the one viewers liked stopped once, the
// rest two to five times).
function judgeStops(timing: Timing, bar: number, lv: number[]): string[] {
  const last = timing.end === undefined ? lv.length : Math.round(timing.end / bar);
  const stops: number[] = [];
  for (let b = 1; b < last; b++) if (lv[b]! <= -12 && lv[b - 1]! >= -6) stops.push(b);
  if (stops.length <= 1) return [];
  const list = stops.map((b) => `bar ${b} at ${clock(b * bar)}`).join(", ");
  return [
    `the music stops dead ${stops.length} times (${list}): keep one stop per film, where the story holds its breath, and let the other drops rise straight out of a build`,
  ];
}

// The moments a listener notices in the scored music: a bar where it drops out or comes back (9 dB
// or more against the bar before) and a bar with only one or two drum hits among louder ones. Each
// needs an event in the story at that time, or it sounds bolted on: the film should answer every one.
function moments(timing: Timing, bar: number, lv: number[], hits: Hit[]): string[] {
  const last = timing.end === undefined ? lv.length : Math.round(timing.end / bar) + 1;
  const heads = new Map(cues(timing, bar).map((c) => [c.at, `${c.what}, ${c.section}`]));
  const drums = (b: number): Hit[] =>
    hits.filter(
      (h) => h.slot >= b * 16 && h.slot < b * 16 + 16 && h.k !== "hat" && h.k !== "ghost"
    );
  const out: string[] = [];
  for (let b = 1; b < Math.min(last, lv.length); b++) {
    const d = lv[b]! - lv[b - 1]!,
      n = drums(b).length;
    let what = "";
    if (d <= -9) what = `the music drops out (${lv[b - 1]} -> ${lv[b]} dB)`;
    else if (d >= 9) what = `the music comes back (${lv[b - 1]} -> ${lv[b]} dB)`;
    else if (n > 0 && n <= 2 && lv[b]! <= -6 && drums(b - 1).length >= 4)
      what = `a lone hit at ${clock(drums(b)[0]!.t)} after a busy bar`;
    if (!what) continue;
    const at = heads.get(b);
    out.push(
      `${clock(b * bar)} bar ${b}: ${what}${at ? ` (start of ${at})` : " (no section starts here)"}`
    );
  }
  return out;
}

// Renders script.score onto the film's bars: audio/score.wav and audio/hits.json.
export function renderScore(work: string, script: Script, timing: Timing): Scored {
  const bpm = script.bpm,
    cut = script.score;
  if (!bpm || !cut)
    throw new Error('script.json needs "bpm" and "score" ({ "take": 1, "bars": "..." }) first');
  const take = loadTakes(work).find((t) => t.take === cut.take);
  if (!take) throw new Error(`take ${cut.take} is not in audio/bgm/takes.json`);
  const bar = 240 / bpm,
    filmBars = Math.ceil(timing.total / bar - 1e-6);
  const notes: string[] = [];
  let map = parseBars(cut.bars, take.bars.length);
  if (map.length < filmBars)
    notes.push(`score.bars has ${map.length} bars, the film ${filmBars}: the rest is silent`);
  if (map.length > filmBars)
    notes.push(
      `score.bars has ${map.length} bars, the film ${filmBars}: the extra bars are left out`
    );
  map = [...map, ...new Array<number>(Math.max(0, filmBars - map.length)).fill(-1)].slice(
    0,
    filmBars
  );
  const audio = renderBars(
    decodeStereo(join(work, take.file), take.filter),
    take.bars.map((b) => b.t),
    map,
    bpm,
    timing.total
  );
  const wav = join(work, "audio", "score.wav");
  writeWav(audio, wav);
  const mono = decodeMono(wav);
  const lv = barLevels(mono, 0, bar, filmBars);
  const loud = percentile(lv, 0.85);
  const rel = lv.map((v) => Math.round(v - loud));
  const hits = detectHits(mono, bpm, 0);
  writeFileSync(join(work, "audio", "hits.json"), JSON.stringify({ bpm, bar, hits }));
  writeFileSync(
    join(work, "audio", "score.json"),
    JSON.stringify({ take: cut.take, bars: cut.bars, loud: Math.round(loud * 10) / 10 }, null, 2)
  );
  return {
    wav,
    loud,
    hits,
    map,
    notes: [...notes, ...judgeCues(timing, bar, rel, hits), ...judgeStops(timing, bar, rel)],
    moments: moments(timing, bar, rel, hits),
  };
}

// The film's bars after scoring: which scene starts where, the take bar played and its drums.
export function filmTable(timing: Timing, s: Scored, bpm: number): string {
  const bar = 240 / bpm;
  const at = new Map(cues(timing, bar).map((c) => [c.at, `${c.what} (${c.section})`]));
  timing.scenes.forEach((sc) => {
    // starts are rounded to 10 ms, so a scene on a bar line can read as a hair before it
    const b = Math.floor(sc.start / bar + 0.01);
    if (!at.has(b)) at.set(b, sc.id);
  });
  const mono = decodeMono(s.wav);
  const lv = barLevels(mono, 0, bar, s.map.length);
  const loud = percentile(lv, 0.85);
  const lines = ["  bar  time     take  level  pattern              scene"];
  s.map.forEach((src, b) => {
    const cells = [
      String(b).padStart(5),
      clock(b * bar).padStart(8),
      String(src).padStart(5),
      String(Math.round(lv[b]! - loud)).padStart(6),
    ];
    lines.push(`${cells.join(" ")}  ${pattern(s.hits, b)}  ${at.get(b) ?? ""}`);
  });
  return lines.join("\n");
}
