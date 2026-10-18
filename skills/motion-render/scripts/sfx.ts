// 効果音（ElevenLabs Sound Effects）を作って保存し、合成のときの音量をそろえる。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { errorMessage, field, readJson } from "./json.ts";
import {
  runFfmpeg,
  sfxChain,
  TIMEOUT_MS,
  volumeStats,
  withRetries,
  type SfxTrack,
} from "./audio.ts";
import type { Script, SfxCue } from "./work.ts";

const API = "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128"; // the best format pay-as-you-go allows
const MODEL = "eleven_text_to_sound_v2";
const SILENT_DB = -60; // a peak below this means the effect came back silent
// Generated effects differ in level by 30 dB or more, so each is leveled against the narration: on
// average UNDER_NARRATION_DB below it (chosen by ear; 10 dB under was masked by the speech), times its
// volume, without letting its peak pass PEAK_DB.
const UNDER_NARRATION_DB = 4;
const PEAK_DB = -1;
const NARRATION_DB = -16; // Gemini TTS's usual average level, for when there is no narration yet
const PREVIEW_GAP = 0.6;

interface Level {
  mean: number;
  max: number;
}

// Effects are stored by what was asked for, so an unchanged effect is never paid for twice.
export const sfxKey = (prompt: string, duration: number): string =>
  createHash("sha256")
    .update(JSON.stringify([MODEL, prompt, duration]))
    .digest("hex")
    .slice(0, 16);

const sfxFile = (work: string, prompt: string, duration: number, ext: "mp3" | "json"): string =>
  join(work, "audio", "sfx", `${sfxKey(prompt, duration)}.${ext}`);

// The reason ElevenLabs gives: a plain string, {message}, or a validation list of {msg}.
function apiReason(body: unknown): string {
  const detail = field(body, "detail");
  if (typeof detail === "string") return detail;
  const message = field(detail, "message");
  if (typeof message === "string") return message;
  const msg = Array.isArray(detail) ? field(detail[0], "msg") : undefined;
  return typeof msg === "string" ? msg : "";
}

// The only call to the provider, so it can be swapped (fal.ai serves the same model per second).
async function soundEffect(key: string, prompt: string, duration: number): Promise<Buffer> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": key },
    body: JSON.stringify({ text: prompt, duration_seconds: duration, model_id: MODEL }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text; // not JSON: the status alone has to do
    }
    throw new Error(`HTTP ${res.status} ${apiReason(body)}`.trim());
  }
  return Buffer.from(await res.arrayBuffer());
}

const allSfx = (script: Script) =>
  script.scenes.flatMap((s) => s.sfx.map((fx) => ({ ...fx, scene: s.id })));

// Writes audio/sfx/<key>.mp3 and its measured level (<key>.json) for each distinct effect in the script.
// Effects already made are kept; a silent result counts as a failed attempt. Returns how many were made.
export async function makeSfx(work: string, script: Script): Promise<number> {
  const todo = new Map<string, { prompt: string; duration: number }>();
  for (const fx of allSfx(script))
    if (!existsSync(sfxFile(work, fx.prompt, fx.duration, "json")))
      todo.set(sfxKey(fx.prompt, fx.duration), fx);
  if (!todo.size) return 0;
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set (needed for sound effects)");
  mkdirSync(join(work, "audio", "sfx"), { recursive: true });
  for (const { prompt, duration } of todo.values()) {
    console.error(`sound effect: ${prompt}`);
    const mp3 = sfxFile(work, prompt, duration, "mp3");
    const level = await withRetries(`sound effect "${prompt}"`, async (): Promise<Level> => {
      try {
        writeFileSync(mp3, await soundEffect(key, prompt, duration));
      } catch (e) {
        throw new Error(`sound effect "${prompt}": ${errorMessage(e)}`);
      }
      const l = await volumeStats(mp3);
      if (l.max < SILENT_DB)
        throw new Error(`sound effect "${prompt}" came back silent (peak ${l.max} dB)`);
      return l;
    });
    writeFileSync(
      sfxFile(work, prompt, duration, "json"),
      JSON.stringify({ prompt, duration, ...level }, null, 2)
    );
  }
  return todo.size;
}

// Stops build before any rendering when an effect in the script was not made yet.
export function checkSfx(work: string, script: Script): void {
  const missing = [
    ...new Set(
      allSfx(script)
        .filter((fx) => !existsSync(sfxFile(work, fx.prompt, fx.duration, "json")))
        .map((fx) => `"${fx.prompt}"`)
    ),
  ];
  if (missing.length)
    throw new Error(
      `sound effects missing for: ${missing.join(", ")} (run "motion-render sfx ${work}")`
    );
}

function level(work: string, prompt: string, duration: number): Level {
  const file = sfxFile(work, prompt, duration, "json");
  const raw = existsSync(file) ? readJson(file) : undefined;
  const mean = field(raw, "mean"),
    max = field(raw, "max");
  if (typeof mean !== "number" || typeof max !== "number")
    throw new Error(`no usable sound effect for "${prompt}": run "motion-render sfx" again`);
  return { mean, max };
}

// The narration's average level in dBFS over the scenes narrated so far: what the effects are leveled against.
export async function narrationLevel(work: string, script: Script): Promise<number> {
  const files = script.scenes
    .map((s) => join(work, "audio", `${s.id}.wav`))
    .filter((f) => existsSync(f));
  if (!files.length) return NARRATION_DB;
  let sum = 0;
  for (const f of files) sum += (await volumeStats(f)).mean;
  return sum / files.length;
}

// An effect ready for mixing: its file, its time and the gain that puts it UNDER_NARRATION_DB below
// `narration` (dBFS), lowered by its own volume, with the peak capped.
export function sfxTrack(work: string, cue: SfxCue, narration: number): SfxTrack {
  const { mean, max } = level(work, cue.prompt, cue.duration);
  const db = Math.min(
    narration - UNDER_NARRATION_DB - mean + 20 * Math.log10(cue.volume),
    PEAK_DB - max
  );
  return {
    file: sfxFile(work, cue.prompt, cue.duration, "mp3"),
    start: cue.start,
    duration: cue.duration,
    gain: 10 ** (db / 20),
  };
}

interface PreviewEntry {
  offset: number;
  scene: string;
  at: number;
  prompt: string;
}

// audio/sfx/preview.m4a: every effect in script order, leveled as in the mix, with a gap after each,
// so a person can hear them all before the film is built. Null when the script has none.
export async function previewSfx(
  work: string,
  script: Script
): Promise<{ file: string; list: PreviewEntry[] } | null> {
  const all = allSfx(script);
  if (!all.length) return null;
  const narration = await narrationLevel(work, script);
  let offset = 0;
  const list: PreviewEntry[] = [],
    inputs: string[] = [],
    graph: string[] = [];
  all.forEach((fx, i) => {
    const t = sfxTrack(work, { ...fx, start: 0 }, narration);
    inputs.push("-i", t.file);
    graph.push(sfxChain(i, t, `s${i}`), `[s${i}]apad=pad_dur=${PREVIEW_GAP}[p${i}]`);
    list.push({
      offset: Math.round(offset * 100) / 100,
      scene: fx.scene,
      at: fx.at,
      prompt: fx.prompt,
    });
    offset += fx.duration + PREVIEW_GAP;
  });
  graph.push(`${all.map((_, i) => `[p${i}]`).join("")}concat=n=${all.length}:v=0:a=1[out]`);
  const file = join(work, "audio", "sfx", "preview.m4a");
  await runFfmpeg([
    ...inputs,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    file,
  ]);
  return { file, list };
}
