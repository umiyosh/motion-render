// When each character of the narration is said (#59): ElevenLabs Forced Alignment takes a scene's
// audio and its exact text and returns the time of every character. The text is what TTS read, so no
// speech has to be recognized and katakana-written terms match as written. The times go to
// <work>/words.json (seconds into each scene's WAV), to kit/timing.js for film.word, and to the
// stop check of sync.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, field, isRecord, readJson } from "./json.ts";
import { Busy, busyWait, TIMEOUT_MS, withRetries } from "./audio.ts";
import { apiReason } from "./sfx.ts";
import { inParallel } from "./inorder.ts";
import { clock, type Script, type Timing } from "./work.ts";
import { parseBars } from "./score.ts";
import type { SyncResult } from "./sync.ts";

const API = "https://api.elevenlabs.io/v1/forced-alignment";
const AT_ONCE = 3; // the plan's concurrency, as for sound effects
const MARGIN = 0.02; // s: a character this close to the stop's edges is not in it

export interface Timed {
  text: string;
  start: number;
  end: number;
}

// One scene: the hash of its WAV and text, the text, and [start, end] in seconds into the WAV for
// each character of the text (by code point).
export interface SceneWords {
  hash: string;
  text: string;
  chars: [number, number][];
}
export type Words = Record<string, SceneWords>;

export const wordsHash = (wav: Buffer, text: string): string =>
  createHash("sha256").update(wav).update("\0").update(text).digest("hex").slice(0, 16);

// Hiragana and katakana, full and half width, and case count as the same character.
function norm(c: string): string {
  const k = c.normalize("NFKC").toLowerCase();
  const code = k.codePointAt(0) ?? 0;
  return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : k;
}

// The times of the narration's characters, from the characters the API returned: an edit-distance
// alignment (Levenshtein) pairs them; a character of the text left without a partner gets a time
// between its neighbors'.
export function alignChars(text: string, got: Timed[]): [number, number][] {
  const a = [...text],
    b = got.flatMap((g) => [...g.text].map((c) => ({ c, start: g.start, end: g.end })));
  if (!b.length) throw new Error("no characters to align");
  const n = a.length,
    m = b.length;
  const d = Array.from({ length: n + 1 }, (_, i) =>
    Array.from({ length: m + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j - 1]! + (norm(a[i - 1]!) === norm(b[j - 1]!.c) ? 0 : 1),
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1
      );
  const pair: (number | null)[] = new Array<number | null>(n).fill(null);
  for (let i = n, j = m; i > 0 && j > 0;) {
    const sub = norm(a[i - 1]!) === norm(b[j - 1]!.c) ? 0 : 1;
    if (d[i]![j] === d[i - 1]![j - 1]! + sub) pair[--i] = --j;
    else if (d[i]![j] === d[i - 1]![j]! + 1) i--;
    else j--;
  }
  const out: [number, number][] = pair.map((j) =>
    j === null ? [NaN, NaN] : [b[j]!.start, b[j]!.end]
  );
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(out[i]![0])) continue;
    const prev = out.slice(0, i).findLast((t) => !Number.isNaN(t[0]));
    const next = out.slice(i + 1).find((t) => !Number.isNaN(t[0]));
    const t = prev?.[1] ?? next?.[0] ?? 0;
    out[i] = [t, next ? Math.max(t, next[0]) : t];
  }
  return out;
}

function isTimed(v: unknown): v is Timed {
  return (
    isRecord(v) &&
    typeof v.text === "string" &&
    typeof v.start === "number" &&
    typeof v.end === "number"
  );
}

// The only call to the provider.
async function forcedAlignment(key: string, wav: Buffer, text: string): Promise<Timed[]> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "narration.wav");
  form.append("text", text);
  const res = await fetch(API, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw; // not JSON: the status alone has to do
  }
  if (!res.ok) {
    const msg = `HTTP ${res.status} ${apiReason(body)}`.trim();
    if (res.status === 429)
      throw new Busy(msg, busyWait(body, res.headers.get("retry-after"), 2_000));
    throw new Error(msg);
  }
  const chars = field(body, "characters");
  if (!Array.isArray(chars) || !chars.every(isTimed))
    throw new Error("the response has no characters with times");
  return chars;
}

function isSceneWords(v: unknown): v is SceneWords {
  return (
    isRecord(v) &&
    typeof v.hash === "string" &&
    typeof v.text === "string" &&
    Array.isArray(v.chars) &&
    v.chars.every(
      (c) => Array.isArray(c) && c.length === 2 && c.every((x) => typeof x === "number")
    )
  );
}

function readWords(file: string): Words {
  if (!existsSync(file)) return {};
  const scenes = field(readJson(file), "scenes");
  if (!isRecord(scenes)) return {};
  return Object.fromEntries(Object.entries(scenes).filter(([, v]) => isSceneWords(v))) as Words;
}

const sceneAudio = (work: string, id: string): string => join(work, "audio", `${id}.wav`);

// The scenes of words.json whose WAV and text are still the ones the times were taken from.
export function loadWords(work: string, script: Pick<Script, "scenes">): Words {
  const all = readWords(join(work, "words.json"));
  return Object.fromEntries(
    script.scenes.flatMap((s) => {
      const w = all[s.id];
      const wav = sceneAudio(work, s.id);
      if (!w || !existsSync(wav) || w.text !== s.narration) return [];
      return w.hash === wordsHash(readFileSync(wav), s.narration) ? [[s.id, w]] : [];
    })
  );
}

// Writes <work>/words.json after narrate. Each scene's alignment is kept under audio/words/ by the
// hash of its WAV and text, so the same audio is never sent twice. Without ELEVENLABS_API_KEY, or
// when a scene fails, it warns and goes on: film.word then estimates from the narration's length.
export async function writeWords(work: string, script: Script): Promise<number> {
  const key = process.env.ELEVENLABS_API_KEY;
  const cache = join(work, "audio", "words");
  const scenes = script.scenes.map((s) => {
    const wav = readFileSync(sceneAudio(work, s.id));
    return { id: s.id, text: s.narration, wav, hash: wordsHash(wav, s.narration) };
  });
  const out: Words = {};
  const todo = scenes.filter((s) => !existsSync(join(cache, `${s.hash}.json`)));
  if (todo.length && !key)
    console.error(
      "warning: ELEVENLABS_API_KEY is not set: no word times (film.word estimates them from the narration's length)"
    );
  if (todo.length && key) {
    mkdirSync(cache, { recursive: true });
    await inParallel(todo, AT_ONCE, async (s) => {
      try {
        const chars = await withRetries(`word times of "${s.id}"`, () =>
          forcedAlignment(key, s.wav, s.text)
        );
        writeFileSync(join(cache, `${s.hash}.json`), JSON.stringify(chars));
      } catch (e) {
        console.error(`warning: no word times for "${s.id}": ${errorMessage(e)}`);
      }
    });
  }
  for (const s of scenes) {
    const file = join(cache, `${s.hash}.json`);
    if (!existsSync(file)) continue;
    const raw = readJson(file);
    if (!Array.isArray(raw) || !raw.every(isTimed)) continue;
    out[s.id] = { hash: s.hash, text: s.text, chars: alignChars(s.text, raw) };
  }
  writeFileSync(join(work, "words.json"), JSON.stringify({ scenes: out }, null, 2) + "\n");
  return Object.keys(out).length;
}

// What a page needs for film.word, per scene: the text, where the narration starts in the scene
// (lead) and how long it lasts (speech), and the start of each character in seconds from the scene's
// start, or null when there are no times for it.
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

const SILENT = /[\s、。，．,.!?！？「」『』（）()・…:：;；"'“”‘’]/u;

// The film's stops (script.score bars of -1 after a playing bar, before the final hit) against the
// times the narration speaks: a stop is where the story holds its breath, so no voice goes in it.
// The voice is placed by its characters' times when there are any, else by each scene's speech.
export function voiceInStops(work: string, script: Script, timing: Timing): SyncResult {
  if (!script.bpm || !script.score) return { lines: [], problems: [] };
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
  if (!stops.length) return { lines: [], problems: [] };
  const words = loadWords(work, script);
  const voiced = timing.scenes.flatMap((sc) => {
    const at = sc.start + script.lead,
      w = words[sc.id];
    const text = script.scenes.find((s) => s.id === sc.id)?.narration ?? "";
    if (!w) return [{ id: sc.id, what: text, a: at, b: at + sc.speech }];
    return [...text].flatMap((c, i) =>
      SILENT.test(c)
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
  const by =
    Object.keys(words).length === script.scenes.length ? "word times" : "scene speech spans";
  const problems: string[] = [];
  const lines = stops.map(([a, b]) => {
    const hit = voiced.filter((v) => v.b > a + MARGIN && v.a < b - MARGIN);
    if (hit.length) {
      const scene = hit[0]!.id,
        said = hit
          .filter((v) => v.id === scene)
          .map((v) => v.what)
          .join("")
          .slice(0, 20);
      problems.push(
        `the narration speaks in the stop at ${clock(a)}-${clock(b)} ("${said}" of "${scene}"): the stop is where the story holds its breath; end the line before it or start the next after it`
      );
    }
    return `stop ${clock(a)}-${clock(b)}: ${hit.length ? "voice in it" : "no voice in it"} (by ${by})`;
  });
  return { lines, problems };
}
