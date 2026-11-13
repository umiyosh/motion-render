// The commands of a beat-synced film: the timing table Claude writes the music direction from, the
// takes shown bar by bar, scoring the film with the chosen bars, and measuring the MP4.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bgmTakes } from "./audio.ts";
import { clock, loadScript, loadTiming, type Script, type Timing } from "./work.ts";
import { filmTable, measureTake, renderScore, takeTable } from "./score.ts";
import { measureSync, measureSyncPictures, type SyncResult } from "./sync.ts";
import type { Film } from "./render.ts";
import { writeKitTiming } from "./kit.ts";
import { isRecord, readJson } from "./json.ts";
import type { Hit } from "./hits.ts";

// Where each scene starts on the bar grid, for writing score.txt.
export function timingTable(t: Timing): string {
  const bpm = t.bpm ?? 120,
    beat = 60 / bpm;
  const where = (s: number): string => {
    const n = Math.round(s / beat);
    return `bar ${Math.floor(n / 4)} beat ${(n % 4) + 1}`;
  };
  const lines = ["scene        start     where             section"];
  for (const s of t.scenes)
    lines.push(
      `${s.id.padEnd(12)} ${clock(s.start).padStart(8)}  ${where(s.start).padEnd(16)}  ${s.section ?? ""}`
    );
  if (t.end !== undefined)
    lines.push(`${"final hit".padEnd(12)} ${clock(t.end).padStart(8)}  ${where(t.end)}`);
  lines.push(
    `the film ends at ${clock(t.total)}: ${Math.ceil(t.total / (4 * beat) - 1e-6)} bars of ${(4 * beat).toFixed(3)} s at ${bpm} BPM`
  );
  return lines.join("\n");
}

export async function runBeatBgm(work: string, script: Script, bpm: number): Promise<void> {
  const files = await bgmTakes(work, script, bpm);
  const takes = files.map((f) => measureTake(work, f, Number(/take(\d+)/.exec(f)?.[1] ?? 0), bpm));
  writeFileSync(join(work, "audio", "bgm", "takes.json"), JSON.stringify(takes));
  const text = takes.map((t) => takeTable(t, bpm)).join("\n\n");
  writeFileSync(join(work, "audio", "bgm", "takes.txt"), `${text}\n`);
  console.log(text);
  console.log(
    `\nchoose a take and its bars, write them to "score" in script.json, then run "motion-render score ${work}" (the tables: ${join(work, "audio", "bgm", "takes.txt")})`
  );
}

export function runScore(work: string): void {
  const script = loadScript(work),
    timing = loadTiming(work);
  if (!script.bpm || !timing.bpm)
    throw new Error(
      'score is for beat-synced films: set "bpm" in script.json and run narrate again'
    );
  const s = renderScore(work, script, timing);
  if (existsSync(join(work, "film", "kit"))) writeKitTiming(work);
  console.log(filmTable(timing, s, script.bpm));
  for (const m of s.moments) console.log(`moment: ${m}`);
  for (const n of s.notes) console.log(`check: ${n}`);
  const n = (k: Hit["k"]): number => s.hits.filter((h) => h.k === k).length;
  console.log(
    `score: ${s.wav} (${n("kick")} kicks, ${n("snare")} snares, ${n("hat")} hats) -> audio/hits.json`
  );
}

// The rendered score for the mix, at the level script.scoreLevel asks for against the narration.
export function scoreInput(
  work: string,
  script: Script,
  narration: number
): { file: string; gain: number } {
  const meta = join(work, "audio", "score.json");
  if (!existsSync(meta)) throw new Error(`no score yet: run "motion-render score ${work}"`);
  const raw = readJson(meta);
  const cut = script.score;
  if (
    !isRecord(raw) ||
    typeof raw.loud !== "number" ||
    !cut ||
    raw.take !== cut.take ||
    raw.bars !== cut.bars
  )
    throw new Error(
      `script.json's "score" changed since the score was made: run "motion-render score ${work}"`
    );
  return {
    file: join(work, "audio", "score.wav"),
    gain: 10 ** ((narration + script.scoreLevel - raw.loud) / 20),
  };
}

function isHit(v: unknown): v is Hit {
  return (
    isRecord(v) &&
    typeof v.t === "number" &&
    typeof v.slot === "number" &&
    typeof v.k === "string" &&
    typeof v.v === "number"
  );
}

function loadHits(work: string): Hit[] {
  const file = join(work, "audio", "hits.json");
  if (!existsSync(file)) throw new Error(`no score yet: run "motion-render score ${work}"`);
  const raw = readJson(file);
  const hits = isRecord(raw) ? raw.hits : undefined;
  if (!Array.isArray(hits) || !hits.every(isHit))
    throw new Error(`${file} is malformed: run "motion-render score ${work}"`);
  return hits;
}

function printSync(r: SyncResult): string[] {
  for (const l of r.lines) console.log(`sync: ${l}`);
  for (const p of r.problems) console.log(`sync problem: ${p}`);
  console.log(r.problems.length ? `sync: ${r.problems.length} problems` : "sync: ok");
  return r.problems;
}

// Prints the measurements of the MP4 and returns the problems found.
export async function syncReport(
  work: string,
  script: Script,
  timing: Timing,
  mp4: string
): Promise<string[]> {
  return printSync(await measureSync(mp4, timing, script, loadHits(work)));
}

// The same measurements from the film's pages, at the 60 fps a beat-synced film is built at, before
// any build.
export async function syncPreview(
  work: string,
  script: Script,
  timing: Timing,
  film: Film
): Promise<string[]> {
  const fps = 60;
  const draw = (f: number) => film.frame(f / fps);
  return printSync(
    await measureSyncPictures({ draw, fps, ahead: film.pages }, timing, script, loadHits(work))
  );
}

export async function runSync(work: string, mp4: string): Promise<void> {
  const problems = await syncReport(work, loadScript(work), loadTiming(work), mp4);
  if (problems.length) throw new Error(`${problems.length} sync problems in ${mp4}`);
}
