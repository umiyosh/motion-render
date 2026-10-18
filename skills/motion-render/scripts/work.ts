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

interface Scene {
  id: string;
  name?: string;
  narration: string;
  sfx: Sfx[];
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
}

interface TimingScene {
  id: string;
  name: string;
  start: number;
  dur: number;
  speech: number;
}

export interface Timing {
  total: number;
  scenes: TimingScene[];
}

const DEFAULTS = {
  voice: "Kore",
  speed: 1.1,
  ttsModel: "gemini-3.8-flash-tts",
  bgmModel: "lyria-3.5",
  bgmVolume: 0.15,
  sfxVolume: 0.5,
  lead: 0.25, // silence before each scene's narration
  tail: 0.35, // silence after it
  endHold: 3, // the last scene holds this long after its narration
};

const SFX_DURATION = 1.5; // asked for when a sound effect gives no length, so none runs long
const ID = /^[a-z][a-z0-9-]{0,31}$/;
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

function parseScenes(value: unknown, sfxVolume: number): Scene[] {
  if (!Array.isArray(value) || !value.length) fail('"scenes" must be a non-empty array');
  const seen = new Set<string>();
  return value.map((sc: unknown, i) => {
    if (!isRecord(sc)) fail(`scenes[${i}] must be an object`);
    const { id, name, narration } = sc;
    if (typeof id !== "string" || !ID.test(id)) fail(`scenes[${i}].id must match ${ID}`);
    if (seen.has(id)) fail(`scenes[${i}].id "${id}" is duplicated`);
    seen.add(id);
    if (typeof narration !== "string" || !narration.trim())
      fail(`scenes[${i}].narration is required (every scene is narrated)`);
    const sfx = parseSfx(sc.sfx, `scenes[${i}].sfx`, sfxVolume);
    return typeof name === "string" ? { id, name, narration, sfx } : { id, narration, sfx };
  });
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
  };
}

// Scene length = narration length at the given speed + lead + tail (+ endHold on the last scene).
export function writeTiming(work: string, script: Script): Timing {
  let start = 0;
  const scenes = script.scenes.map((sc, i) => {
    const speech = wavSeconds(join(work, "audio", `${sc.id}.wav`)) / script.speed;
    const hold = i === script.scenes.length - 1 ? script.endHold : 0;
    const dur = Math.round((script.lead + speech + script.tail + hold) * 10) / 10;
    const row = {
      id: sc.id,
      name: sc.name ?? sc.id,
      start: Math.round(start * 100) / 100,
      dur,
      speech: Math.round(speech * 100) / 100,
    };
    start += dur;
    return row;
  });
  const timing = { total: Math.round(start * 100) / 100, scenes };
  writeFileSync(join(work, "timing.json"), JSON.stringify(timing, null, 2));
  return timing;
}

function parseTimingScene(row: unknown): TimingScene | null {
  if (!isRecord(row)) return null;
  const { id, name, start, dur, speech } = row;
  if (typeof id !== "string" || typeof name !== "string") return null;
  if (typeof start !== "number" || typeof dur !== "number" || typeof speech !== "number")
    return null;
  return { id, name, start, dur, speech };
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
  return { total: raw.total, scenes };
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
