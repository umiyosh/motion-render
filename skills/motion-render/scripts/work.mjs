// 作業フォルダ（1 本の動画の原稿・音声・映像データ）の script.json と timing.json を扱う。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wavSeconds } from './audio.mjs';

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
const NUMBERS = [['speed', 0.5, 2], ['bgmVolume', 0, 1], ['lead', 0, 5], ['tail', 0, 5], ['endHold', 0, 30]];

export function loadScript(work) {
  const file = join(work, 'script.json');
  if (!existsSync(file)) throw new Error(`${file} not found (write the narration script first: see SKILL.md)`);
  const s = { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
  const fail = (msg) => { throw new Error(`script.json: ${msg}`); };
  if (typeof s.bgm !== 'string' || !s.bgm.trim()) fail('"bgm" (a prompt describing the music) is required');
  if (!Array.isArray(s.scenes) || !s.scenes.length) fail('"scenes" must be a non-empty array');
  const seen = new Set();
  s.scenes.forEach((sc, i) => {
    if (!ID.test(sc.id ?? '')) fail(`scenes[${i}].id must match ${ID}`);
    if (seen.has(sc.id)) fail(`scenes[${i}].id "${sc.id}" is duplicated`);
    seen.add(sc.id);
    if (typeof sc.narration !== 'string' || !sc.narration.trim()) fail(`scenes[${i}].narration is required (every scene is narrated)`);
  });
  // These values are written into ffmpeg filter graphs and API URLs: accept plain numbers and names only.
  for (const [key, min, max] of NUMBERS) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key]) || s[key] < min || s[key] > max) fail(`"${key}" must be a number between ${min} and ${max}`);
  }
  for (const key of ['voice', 'ttsModel', 'bgmModel']) {
    if (typeof s[key] !== 'string' || !NAME.test(s[key])) fail(`"${key}" must match ${NAME}`);
  }
  return s;
}

// Scene length = narration length at the given speed + lead + tail (+ endHold on the last scene).
export function writeTiming(work, script) {
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

export function loadTiming(work) {
  const file = join(work, 'timing.json');
  if (!existsSync(file)) throw new Error(`${file} not found: run "motion-render narrate ${work}" first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}
