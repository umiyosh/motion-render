// 作業フォルダ（1 本の動画の原稿・音声・映像データ）の script.json と timing.json を扱う。
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wavSeconds } from "./audio.ts";
import { isRecord, readJson, type Json } from "./json.ts";

// A sound effect, `at` seconds after its scene starts.
export interface Sfx {
  at: number;
  prompt: string;
  duration: number;
  volume: number;
}

// The part of the music a scene starts (beat-synced films): it starts on a bar line, and the score
// is cut so that this part of the music begins there.
const SECTIONS = ["intro", "build", "drop", "break", "groove", "outro"] as const;
type Section = (typeof SECTIONS)[number];

interface Scene {
  id: string;
  name?: string;
  narration: string;
  sfx: Sfx[];
  section?: Section;
}

// Which generated take scores the film, and which of its bars play at each bar of the film
// ("0-11,12-18,-1,30": ranges, single bars, -1 for a silent bar).
interface ScoreCut {
  take: number;
  bars: string;
}

export interface Script {
  bgm: string;
  scenes: Scene[];
  voice: string;
  speed: number;
  ttsModel: string;
  bgmModel: string;
  bgmVolume: number;
  sfxVolume: number;
  lead: number;
  tail: number;
  endHold: number;
  bpm?: number; // beat-synced film: scenes start on beats, sections on bar lines
  score?: ScoreCut;
  scoreLevel: number; // dB of the score's loud bars against the narration's mean level
}

export interface TimingScene {
  id: string;
  name: string;
  start: number;
  dur: number;
  speech: number;
  section?: Section;
}

export interface Timing {
  total: number;
  scenes: TimingScene[];
  bpm?: number;
  end?: number; // the final hit: the bar line after the last narration (beat-synced films)
}

const DEFAULTS = {
  voice: "Kore",
  speed: 1.1,
  ttsModel: "gemini-3.8-flash-tts",
  bgmModel: "lyria-3.5",
  bgmVolume: 0.15,
  sfxVolume: 1, // 1 = leveled 4 dB under the narration (sfx.ts)
  lead: 0.25, // silence before each scene's narration
  tail: 0.35, // silence after it
  endHold: 3, // the last scene holds this long after its narration
  // Loud bars of the score against the narration's mean. At +5 dB the voice sank under the drops;
  // the same film with the score at 0.9 times that (+4.1 dB) was judged right (2026-11-12).
  scoreLevel: 4.1,
};

const SFX_DURATION = 1.5; // asked for when a sound effect gives no length, so none runs long
const ID = /^[a-z][a-z0-9-]{0,31}$/;
// Scene narration is written to audio/<id>.wav, next to these files of the film's own.
const RESERVED = ["bgm", "score", "mix", "hits", "sfx"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(msg: string): never {
  throw new Error(`script.json: ${msg}`);
}

function parseSfx(value: unknown, path: string, volume: number): Sfx[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value.map((fx: unknown, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(fx)) fail(`${at} must be an object`);
    const { prompt } = fx;
    if (typeof prompt !== "string" || !prompt.trim()) fail(`${at}.prompt is required`);
    const s = { duration: SFX_DURATION, volume, ...fx };
    return {
      at: num(s, "at", 0, 600, at),
      prompt,
      duration: num(s, "duration", 0.5, 10, at),
      volume: num(s, "volume", 0, 1, at),
    };
  });
}

function isSection(v: unknown): v is Section {
  return typeof v === "string" && (SECTIONS as readonly string[]).includes(v);
}

function parseScenes(value: unknown, sfxVolume: number): Scene[] {
  if (!Array.isArray(value) || !value.length) fail('"scenes" must be a non-empty array');
  const seen = new Set<string>();
  return value.map((sc: unknown, i) => {
    if (!isRecord(sc)) fail(`scenes[${i}] must be an object`);
    const { id, name, narration, section } = sc;
    if (typeof id !== "string" || !ID.test(id)) fail(`scenes[${i}].id must match ${ID}`);
    if (seen.has(id)) fail(`scenes[${i}].id "${id}" is duplicated`);
    if (RESERVED.includes(id))
      fail(
        `scenes[${i}].id "${id}" is taken: audio/${id}.* holds the film's own audio (use another id)`
      );
    seen.add(id);
    if (typeof narration !== "string" || !narration.trim())
      fail(`scenes[${i}].narration is required (every scene is narrated)`);
    if (section !== undefined && !isSection(section))
      fail(`scenes[${i}].section must be one of ${SECTIONS.join(", ")}`);
    const sfx = parseSfx(sc.sfx, `scenes[${i}].sfx`, sfxVolume);
    return {
      id,
      narration,
      sfx,
      ...(typeof name === "string" ? { name } : {}),
      ...(section ? { section } : {}),
    };
  });
}

function parseScore(v: unknown): ScoreCut | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) fail('"score" must be an object: { "take": 1, "bars": "0-15,-1,16-31" }');
  const { take, bars } = v;
  if (typeof take !== "number" || !Number.isInteger(take) || take < 1)
    fail('"score.take" must be the number of a take (1, 2, ...)');
  if (
    typeof bars !== "string" ||
    !/^\s*-?\d+(\s*-\s*\d+)?(\s*,\s*-?\d+(\s*-\s*\d+)?)*\s*$/.test(bars)
  )
    fail(
      '"score.bars" must list bars like "0-11,12-18,-1,30" (ranges, single bars, -1 for silence)'
    );
  return { take, bars };
}

// These values are written into ffmpeg filter graphs and API URLs: accept plain numbers and names only.
function num(s: Json, key: string, min: number, max: number, path?: string): number {
  const v = s[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    fail(`${path ? `${path}.${key}` : `"${key}"`} must be a number between ${min} and ${max}`);
  return v;
}

function name(s: Json, key: string): string {
  const v = s[key];
  if (typeof v !== "string" || !NAME.test(v)) fail(`"${key}" must match ${NAME}`);
  return v;
}

export function loadScript(work: string): Script {
  const file = join(work, "script.json");
  if (!existsSync(file))
    throw new Error(`${file} not found (write the narration script first: see SKILL.md)`);
  const raw = readJson(file);
  if (!isRecord(raw)) fail("must be a JSON object");
  const s: Json = { ...DEFAULTS, ...raw };
  const { bgm } = s;
  if (typeof bgm !== "string" || !bgm.trim())
    fail('"bgm" (a prompt describing the music) is required');
  const sfxVolume = num(s, "sfxVolume", 0, 1);
  const scenes = parseScenes(s.scenes, sfxVolume);
  return {
    bgm,
    scenes,
    speed: num(s, "speed", 0.5, 2),
    bgmVolume: num(s, "bgmVolume", 0, 1),
    sfxVolume,
    lead: num(s, "lead", 0, 5),
    tail: num(s, "tail", 0, 5),
    endHold: num(s, "endHold", 0, 30),
    voice: name(s, "voice"),
    ttsModel: name(s, "ttsModel"),
    bgmModel: name(s, "bgmModel"),
    scoreLevel: num(s, "scoreLevel", -20, 12),
    ...(s.bpm === undefined ? {} : { bpm: num(s, "bpm", 60, 200) }),
    ...(s.score === undefined ? {} : { score: parseScore(s.score) }),
  };
}

const r3 = (t: number): number => Math.round(t * 1000) / 1000;
const up = (t: number, unit: number): number => Math.ceil(t / unit - 1e-6) * unit;

// Beat-synced lengths: every scene starts on a beat, a scene that starts a section on a bar line, and
// the last scene's narration ends before the final hit, which falls on the next bar line.
function gridScenes(script: Script, speeches: number[], bpm: number): Timing {
  const beat = 60 / bpm,
    bar = 4 * beat;
  let start = 0,
    end = 0;
  const scenes = script.scenes.map((sc, i) => {
    const need = start + script.lead + speeches[i]! + script.tail;
    const next = script.scenes[i + 1];
    end = next ? up(need, next.section ? bar : beat) : up(need, bar);
    const row = {
      id: sc.id,
      name: sc.name ?? sc.id,
      start: r3(start),
      dur: r3(end - start + (next ? 0 : script.endHold)),
      speech: Math.round(speeches[i]! * 100) / 100,
      ...(sc.section ? { section: sc.section } : {}),
    };
    start = end;
    return row;
  });
  return { total: r3(end + script.endHold), scenes, bpm, end: r3(end) };
}

// Scene length = narration length at the given speed + lead + tail (+ endHold on the last scene).
// With "bpm", the scenes are lengthened to the beat grid instead (gridScenes).
export function writeTiming(work: string, script: Script): Timing {
  const speeches = script.scenes.map(
    (sc) => wavSeconds(join(work, "audio", `${sc.id}.wav`)) / script.speed
  );
  let timing: Timing;
  if (script.bpm) timing = gridScenes(script, speeches, script.bpm);
  else {
    let start = 0;
    const scenes = script.scenes.map((sc, i) => {
      const hold = i === script.scenes.length - 1 ? script.endHold : 0;
      const dur = Math.round((script.lead + speeches[i]! + script.tail + hold) * 10) / 10;
      const row = {
        id: sc.id,
        name: sc.name ?? sc.id,
        start: Math.round(start * 100) / 100,
        dur,
        speech: Math.round(speeches[i]! * 100) / 100,
      };
      start += dur;
      return row;
    });
    timing = { total: Math.round(start * 100) / 100, scenes };
  }
  writeFileSync(join(work, "timing.json"), JSON.stringify(timing, null, 2));
  return timing;
}

function parseTimingScene(row: unknown): TimingScene | null {
  if (!isRecord(row)) return null;
  const { id, name, start, dur, speech, section } = row;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof start !== "number" || typeof dur !== "number" || typeof speech !== "number")
    return null;
  return { id, name, start, dur, speech, ...(isSection(section) ? { section } : {}) };
}

export function loadTiming(work: string): Timing {
  const file = join(work, "timing.json");
  if (!existsSync(file))
    throw new Error(`${file} not found: run "motion-render narrate ${work}" first`);
  const raw = readJson(file);
  const broken = (): never => {
    throw new Error(`${file} is malformed: run "motion-render narrate ${work}" again`);
  };
  if (!isRecord(raw) || typeof raw.total !== "number" || !Array.isArray(raw.scenes))
    return broken();
  const scenes = raw.scenes.map((row: unknown) => parseTimingScene(row) ?? broken());
  const { bpm, end } = raw;
  return {
    total: raw.total,
    scenes,
    ...(typeof bpm === "number" ? { bpm } : {}),
    ...(typeof end === "number" ? { end } : {}),
  };
}

// "1:05.23" for a time in seconds.
export function clock(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, "0")}`;
}

// Where a scene of the film starts and how long it lasts, as the player laid it out.
interface FilmScene {
  key: string;
  a0: number;
  dur: number;
}

// Narration goes where each scene actually starts in the film (matched by scene id), so a film whose
// scene lengths differ from timing.json still stays in sync. Narration longer than its scene is reported.
export function placeOnFilm(
  timing: Timing,
  meta: { parts: FilmScene[] },
  script: Pick<Script, "lead">,
  warn: (msg: string) => void
): TimingScene[] {
  const parts = new Map(meta.parts.map((p) => [p.key, p]));
  const unknown = timing.scenes.filter((s) => !parts.has(s.id)).map((s) => s.id);
  if (unknown.length) {
    throw new Error(
      `these script.json scenes are not in the film: ${unknown.join(", ")} (scene ids must match)`
    );
  }
  return timing.scenes.flatMap((s) => {
    const p = parts.get(s.id);
    if (!p) return [];
    if (s.speech + script.lead > p.dur + 0.05) {
      warn(`narration of "${s.id}" (${s.speech}s) runs past its scene (${p.dur}s)`);
    }
    return [{ ...s, start: p.a0 }];
  });
}

// A sound effect placed on the film's timeline.
export interface SfxCue extends Sfx {
  start: number;
}

// Each effect goes `at` seconds after where its scene actually starts in the film, so it stays on its
// animation even when the narration moves the scenes. An effect that starts after its scene ends is reported.
export function placeSfx(
  script: Pick<Script, "scenes">,
  parts: FilmScene[],
  warn: (msg: string) => void
): SfxCue[] {
  const byKey = new Map(parts.map((p) => [p.key, p]));
  const cues = script.scenes.flatMap((sc) => {
    const p = byKey.get(sc.id);
    if (!p) return [];
    return sc.sfx.map((fx) => {
      if (fx.at >= p.dur)
        warn(`sound effect "${fx.prompt}" at ${fx.at}s is past the end of "${sc.id}" (${p.dur}s)`);
      return { ...fx, start: Math.round((p.a0 + fx.at) * 1000) / 1000 };
    });
  });
  return cues.sort((a, b) => a.start - b.start);
}
