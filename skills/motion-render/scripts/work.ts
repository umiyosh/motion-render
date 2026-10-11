// 作業フォルダ（1 本の動画の原稿・音声・映像データ）の script.json と timing.json を扱う。
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wavSeconds } from './audio.ts';
import { isRecord, readJson, type Json } from './json.ts';

export interface Scene {
  id: string;
  name?: string;
  narration: string;
}

export interface Script {
  bgm: string;
  scenes: Scene[];
  voice: string;
  speed: number;
  ttsModel: string;
  bgmModel: string;
  bgmVolume: number;
  lead: number;
  tail: number;
  endHold: number;
}

export interface TimingScene {
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
  voice: 'Kore',
  speed: 1.1,
  ttsModel: 'gemini-3.8-flash-tts',
  bgmModel: 'lyria-3.5',
  bgmVolume: 0.15,
  lead: 0.25, // silence before each scene's narration
  tail: 0.35, // silence after it
  endHold: 3, // the last scene holds this long after its narration
};

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(msg: string): never {
  throw new Error(`script.json: ${msg}`);
}

function parseScenes(value: unknown): Scene[] {
  if (!Array.isArray(value) || !value.length) fail('"scenes" must be a non-empty array');
  const seen = new Set<string>();
  return value.map((sc: unknown, i) => {
    if (!isRecord(sc)) fail(`scenes[${i}] must be an object`);
    const { id, name, narration } = sc;
    if (typeof id !== 'string' || !ID.test(id)) fail(`scenes[${i}].id must match ${ID}`);
    if (seen.has(id)) fail(`scenes[${i}].id "${id}" is duplicated`);
    seen.add(id);
    if (typeof narration !== 'string' || !narration.trim()) fail(`scenes[${i}].narration is required (every scene is narrated)`);
    return typeof name === 'string' ? { id, name, narration } : { id, narration };
  });
}

// These values are written into ffmpeg filter graphs and API URLs: accept plain numbers and names only.
function num(s: Json, key: string, min: number, max: number): number {
  const v = s[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`"${key}" must be a number between ${min} and ${max}`);
  return v;
}

function name(s: Json, key: string): string {
  const v = s[key];
  if (typeof v !== 'string' || !NAME.test(v)) fail(`"${key}" must match ${NAME}`);
  return v;
}

export function loadScript(work: string): Script {
  const file = join(work, 'script.json');
  if (!existsSync(file)) throw new Error(`${file} not found (write the narration script first: see SKILL.md)`);
  const raw = readJson(file);
  if (!isRecord(raw)) fail('must be a JSON object');
  const s: Json = { ...DEFAULTS, ...raw };
  const { bgm } = s;
  if (typeof bgm !== 'string' || !bgm.trim()) fail('"bgm" (a prompt describing the music) is required');
  const scenes = parseScenes(s.scenes);
  return {
    bgm,
    scenes,
    speed: num(s, 'speed', 0.5, 2),
    bgmVolume: num(s, 'bgmVolume', 0, 1),
    lead: num(s, 'lead', 0, 5),
    tail: num(s, 'tail', 0, 5),
    endHold: num(s, 'endHold', 0, 30),
    voice: name(s, 'voice'),
    ttsModel: name(s, 'ttsModel'),
    bgmModel: name(s, 'bgmModel'),
  };
}

// Scene length = narration length at the given speed + lead + tail (+ endHold on the last scene).
export function writeTiming(work: string, script: Script): Timing {
  let start = 0;
  const scenes = script.scenes.map((sc, i) => {
    const speech = wavSeconds(join(work, 'audio', `${sc.id}.wav`)) / script.speed;
    const hold = i === script.scenes.length - 1 ? script.endHold : 0;
    const dur = Math.round((script.lead + speech + script.tail + hold) * 10) / 10;
    const row = { id: sc.id, name: sc.name ?? sc.id, start: Math.round(start * 100) / 100, dur, speech: Math.round(speech * 100) / 100 };
    start += dur;
    return row;
  });
  const timing = { total: Math.round(start * 100) / 100, scenes };
  writeFileSync(join(work, 'timing.json'), JSON.stringify(timing, null, 2));
  return timing;
}

function parseTimingScene(row: unknown): TimingScene | null {
  if (!isRecord(row)) return null;
  const { id, name, start, dur, speech } = row;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (typeof start !== 'number' || typeof dur !== 'number' || typeof speech !== 'number') return null;
  return { id, name, start, dur, speech };
}

export function loadTiming(work: string): Timing {
  const file = join(work, 'timing.json');
  if (!existsSync(file)) throw new Error(`${file} not found: run "motion-render narrate ${work}" first`);
  const raw = readJson(file);
  const broken = (): never => {
    throw new Error(`${file} is malformed: run "motion-render narrate ${work}" again`);
  };
  if (!isRecord(raw) || typeof raw.total !== 'number' || !Array.isArray(raw.scenes)) return broken();
  const scenes = raw.scenes.map((row: unknown) => parseTimingScene(row) ?? broken());
  return { total: raw.total, scenes };
}
