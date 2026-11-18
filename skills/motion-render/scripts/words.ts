// When each character of the narration is said (#59), measured on each scene's own WAV. The voice
// pauses at 、 and 。, and a pause is silence, so the voiced runs of the WAV are its phrases: each
// phrase starts where its voice rises out of the silence, and its characters are spread evenly over
// the run (Japanese morae are close to even in length).
//
// Measured on the 8 TTS scenes of promo-v11 against the hiss of s/sh kana, a character in mid-phrase
// lands about 90 ms off (median); a phrase start lands on the rise itself. ElevenLabs Forced
// Alignment was tried first and did no better: 70-260 ms late at phrase starts, 123 ms in mid-phrase,
// while it needs a key and sends the audio out. So nothing leaves the machine.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, decodeMono, envelope } from "./signal.ts";
import { clock, type Script, type Timing } from "./work.ts";
import { isRecord, readJson } from "./json.ts";
import { parseBars } from "./score.ts";
import type { SyncResult } from "./sync.ts";

const QUIET_DB = -35; // a 1 ms frame this far under the scene's peak is silence
const GAP_MS = 80; // silence this long splits the voice into runs (a pause)
const MARGIN = 0.02; // s: a character this close to the stop's edges is not in it
const PAUSE = /[、。，．,.!?！？]/u; // where the voice pauses
const QUIET = /[\s、。，．,.!?！？「」『』（）()・…:：;；"'“”‘’]/u; // not voiced

// The runs of the voice in a scene's samples, [start, end] in seconds, split at pauses.
function voicedRuns(x: Float32Array): [number, number][] {
  const e = envelope(x, 10); // one frame per millisecond
  const peak = e.reduce((a, v) => Math.max(a, v), 0);
  const runs: [number, number][] = [];
  let quiet = Infinity;
  for (let i = 0; i < e.length; i++) {
    if (db(e[i]! / (peak || 1)) <= QUIET_DB) {
      quiet++;
      continue;
    }
    if (quiet >= GAP_MS) runs.push([i / 1000, i / 1000]);
    runs.at(-1)![1] = (i + 1) / 1000;
    quiet = 0;
  }
  return runs;
}

// Joins neighboring runs across their shortest gaps until there are `n`: a breath or a pause the text
// does not mark splits a phrase in two.
function joinRuns(runs: [number, number][], n: number): [number, number][] {
  const r = runs.map(([a, b]): [number, number] => [a, b]);
  while (r.length > n) {
    let g = 1;
    for (let j = 2; j < r.length; j++) if (r[j]![0] - r[j - 1]![1] < r[g]![0] - r[g - 1]![1]) g = j;
    r[g - 1]![1] = r[g]![1];
    r.splice(g, 1);
  }
  return r;
}

// [start, end] in seconds into the samples for each character of `text` (by code point). A
// character that is not voiced (punctuation, spaces) gets the moment between its neighbors.
export function charTimes(x: Float32Array, text: string): [number, number][] {
  const ch = [...text];
  const phrases: number[][] = [[]];
  ch.forEach((c, i) => {
    if (PAUSE.test(c)) phrases.push([]);
    else if (!QUIET.test(c)) phrases.at(-1)!.push(i);
  });
  const ph = phrases.filter((p) => p.length);
  const found = voicedRuns(x);
  if (!ph.length || !found.length) return ch.map(() => [0, 0]);
  // When the voice ran on where the text marks a pause, its phrases cannot be told apart: the
  // whole voice is spread as one.
  const runs =
    found.length >= ph.length
      ? joinRuns(found, ph.length)
      : [[found[0]![0], found.at(-1)![1]] as [number, number]];
  const groups = runs.length === ph.length ? ph : [ph.flat()];
  const out: [number, number][] = ch.map(() => [NaN, NaN]);
  groups.forEach((p, j) => {
    const [a, b] = runs[j]!;
    p.forEach(
      (i, n) => (out[i] = [a + ((b - a) * n) / p.length, a + ((b - a) * (n + 1)) / p.length])
    );
  });
  let last = runs[0]![0];
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i]![0])) {
      const next = out.slice(i + 1).find((t) => !Number.isNaN(t[0]))?.[0] ?? last;
      out[i] = [last, next];
    }
    last = out[i]![1];
  }
  return out;
}

const sceneAudio = (work: string, id: string): string => join(work, "audio", `${id}.wav`);

// Each scene's text and the [start, end] of its characters in seconds into its WAV, for the scenes
// whose narration exists.
function loadWords(
  work: string,
  script: Pick<Script, "scenes">
): Record<string, { text: string; chars: [number, number][] }> {
  return Object.fromEntries(
    script.scenes.flatMap((s) => {
      const wav = sceneAudio(work, s.id);
      if (!existsSync(wav)) return [];
      return [[s.id, { text: s.narration, chars: charTimes(decodeMono(wav), s.narration) }]];
    })
  );
}

// Writes <work>/words.json after narrate, for reading: the same times kit and sync measure again from
// the WAVs, so a changed narration never leaves stale times behind.
export function writeWords(work: string, script: Pick<Script, "scenes">): number {
  const scenes = loadWords(work, script);
  const round = (t: number): number => Math.round(t * 1000) / 1000;
  const out = Object.fromEntries(
    Object.entries(scenes).map(([id, w]) => [
      id,
      { text: w.text, chars: w.chars.map(([a, b]) => [round(a), round(b)]) },
    ])
  );
  writeFileSync(join(work, "words.json"), JSON.stringify({ scenes: out }, null, 2) + "\n");
  return Object.keys(out).length;
}

// What a page needs for film.word, per scene: the text, where the narration starts in the scene
// (lead) and how long it lasts (speech), and the start of each character in seconds from the scene's
// start, or null when the scene has no narration yet.
export interface PageWords {
  text: string;
  lead: number;
  speech: number;
  at: number[] | null;
}

export function pageWords(
  work: string,
  script: Pick<Script, "scenes" | "lead" | "speed">,
  timing: Timing
): Record<string, PageWords> {
  const words = loadWords(work, script);
  const round = (t: number): number => Math.round(t * 1000) / 1000;
  return Object.fromEntries(
    script.scenes.map((s) => {
      const w = words[s.id];
      const speech = timing.scenes.find((t) => t.id === s.id)?.speech ?? 0;
      const at = w ? w.chars.map(([a]) => round(script.lead + a / script.speed)) : null;
      return [s.id, { text: s.narration, lead: script.lead, speech, at }];
    })
  );
}

// The film's stops: bars of -1 in script.score right after a playing bar, before the final hit.
function stopsOf(script: Script, timing: Timing): [number, number][] {
  if (!script.bpm || !script.score) return [];
  const bar = 240 / script.bpm;
  const map = parseBars(script.score.bars, Number.MAX_SAFE_INTEGER);
  const last = timing.end ?? timing.total;
  const stops: [number, number][] = [];
  map.forEach((v, b) => {
    if (v !== -1 || b * bar >= last - 1e-6) return;
    const prev = stops.at(-1);
    if (prev && Math.abs(prev[1] - b * bar) < 1e-6) prev[1] = (b + 1) * bar;
    else if (b > 0 && map[b - 1] !== -1) stops.push([b * bar, (b + 1) * bar]);
  });
  return stops;
}

// The narration against the film's stops: a stop is where the story holds its breath, so no voice
// goes in it. The voice is placed by its characters' times.
export function voiceInStops(work: string, script: Script, timing: Timing): SyncResult {
  const stops = stopsOf(script, timing);
  if (!stops.length) return { lines: [], problems: [] };
  const words = loadWords(work, script);
  const voiced = timing.scenes.flatMap((sc) => {
    const at = sc.start + script.lead,
      w = words[sc.id];
    if (!w) return [];
    return [...w.text].flatMap((c, i) =>
      QUIET.test(c)
        ? []
        : [
            {
              id: sc.id,
              what: c,
              a: at + w.chars[i]![0] / script.speed,
              b: at + w.chars[i]![1] / script.speed,
            },
          ]
    );
  });
  const problems: string[] = [];
  const lines = stops.map(([a, b]) => {
    const hit = voiced.filter((v) => v.b > a + MARGIN && v.a < b - MARGIN);
    if (hit.length) {
      const scene = hit[0]!.id;
      const said = hit
        .filter((v) => v.id === scene)
        .map((v) => v.what)
        .join("")
        .slice(0, 20);
      problems.push(
        `the narration speaks in the stop at ${clock(a)}-${clock(b)} ("${said}" of "${scene}"): the stop is where the story holds its breath; end the line before it or start the next after it`
      );
    }
    return `stop ${clock(a)}-${clock(b)}: ${hit.length ? "voice in it" : "no voice in it"}`;
  });
  return { lines, problems };
}

// The second, into its scene, of each sound effect timed by a word: the film's film.word for that
// word (lead + its time in the scene's WAV / speed), plus the offset, and with `snap` the nearest
// kick, snare or rim hit within an eighth of a bar, as beat.snap moves the film's motion. Times
// copied from words.json by hand were off by 0.03-0.40 s in #87. Before the score is arranged there
// are no hits, and a snapped effect keeps its word time.
export function resolveSfxTimes(work: string, script: Script, timing: Timing): Script {
  if (!script.scenes.some((s) => s.sfx.some((fx) => fx.word))) return script;
  const words = loadWords(work, script);
  const hits = loadSnapHits(work);
  const scenes = script.scenes.map((sc) => ({
    ...sc,
    sfx: sc.sfx.map((fx) => {
      if (!fx.word) return fx;
      const w = words[sc.id];
      if (!w)
        throw new Error(
          `sound effect "${fx.prompt}": scene "${sc.id}" has no narration audio yet (run narrate)`
        );
      const i = w.text.indexOf(fx.word.word);
      if (i < 0)
        throw new Error(
          `sound effect "${fx.prompt}": the narration of "${sc.id}" does not say "${fx.word.word}"`
        );
      let at = script.lead + w.chars[i]![0] / script.speed + fx.word.offset;
      const start = timing.scenes.find((t) => t.id === sc.id)?.start ?? 0;
      if (fx.word.snap && hits) {
        const near = nearestHit(hits, start + at);
        if (near !== null) at = near - start;
      }
      return { ...fx, at: Math.round(at * 1000) / 1000 };
    }),
  }));
  return { ...script, scenes };
}

interface SnapHits {
  bar: number;
  times: number[];
}

function loadSnapHits(work: string): SnapHits | null {
  const file = join(work, "audio", "hits.json");
  if (!existsSync(file)) return null;
  const raw = readJson(file);
  if (!isRecord(raw) || typeof raw.bar !== "number" || !Array.isArray(raw.hits)) return null;
  const times = raw.hits.flatMap((h: unknown) =>
    isRecord(h) && typeof h.t === "number" && (h.k === "kick" || h.k === "snare" || h.k === "rim")
      ? [h.t]
      : []
  );
  return { bar: raw.bar, times };
}

function nearestHit(h: SnapHits, t: number): number | null {
  let best: number | null = null;
  for (const x of h.times)
    if (Math.abs(x - t) <= h.bar / 8 && (best === null || Math.abs(x - t) < Math.abs(best - t)))
      best = x;
  return best;
}
