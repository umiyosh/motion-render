// The commands of a beat-synced film: the timing table Claude writes the music direction from, the
// takes shown bar by bar, scoring the film with the chosen bars, and measuring the MP4.
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bgmTakes } from "./audio.ts";
import { clock, loadScript, loadTiming, type Script, type Timing } from "./work.ts";
import { filmTable, loadTakes, measureTake, renderScore, takeTable, type Take } from "./score.ts";
import { draftScores, type Draft } from "./draft.ts";
import { measureSync, measureSyncPictures, type SyncResult } from "./sync.ts";
import type { Film } from "./render.ts";
import { writeKitTiming } from "./kit.ts";
import { errorMessage, isRecord, readJson } from "./json.ts";
import { beatsToMove, checkTakes, downbeatLine, movedLine } from "./downbeat.ts";
import type { Hit } from "./hits.ts";
import { voiceInStops } from "./words.ts";

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

// Each take's draft played as "score" would play it (in a temp dir, so the work's own score is left
// as it was), ranked by what score would say: its check lines first, then the moments a listener
// notices (each needs an event in the story).
function rankDrafts(
  work: string,
  script: Script,
  drafts: Draft[]
): (Draft & { checks: number; moments: number })[] {
  const timing = loadTiming(work);
  const tmp = mkdtempSync(join(tmpdir(), "mr-draft-"));
  return drafts
    .map((d) => {
      const tried = { ...script, score: { take: d.take, bars: d.bars } };
      const s = renderScore(work, tried, timing, tmp);
      return { ...d, checks: s.notes.length, moments: s.moments.length };
    })
    .sort((a, b) => a.checks - b.checks || a.moments - b.moments || a.joins - b.joins);
}

// The takes the last "bgm" made (audio/bgm.json), to measure again at another tempo.
function keptTakes(work: string): string[] {
  const file = join(work, "audio", "bgm.json");
  if (!existsSync(file)) throw new Error(`no takes yet (${file}): run bgm without --again first`);
  const v = readJson(file);
  const takes = isRecord(v) ? v.takes : undefined;
  if (!Array.isArray(takes) || !takes.every((t) => typeof t === "string"))
    throw new Error(`${file}: "takes" must be a list of files`);
  return takes;
}

const MAX_SHIFT = 0.05; // locking a take to the film's tempo moves its pitch by as much

// When every take came back more than 5% off the asked tempo, locking one to it would move its pitch
// by over a semitone and change its sound. Lyria often holds a tempo of its own for a style, and the
// film's tempo can follow it instead: the scenes move to the new beat grid, the speech stays.
function tempoAdvice(takes: Take[], bpm: number, work: string): string | null {
  const off = takes.map((t) => t.measured);
  if (!off.length || off.some((m) => Math.abs(bpm / m - 1) <= MAX_SHIFT)) return null;
  const near = Math.round([...off].sort((a, b) => a - b)[off.length >> 1]!);
  return `tempo: every take is more than 5% off ${bpm} BPM (${Math.min(...off)}-${Math.max(...off)} BPM), and locking one to ${bpm} would shift its pitch and sound. Set "bpm" to ${near} in script.json, run "motion-render narrate ${work}" (it keeps the speech) and "motion-render bgm ${work} --again" to measure these takes at ${near} BPM without making new ones`;
}

// The takes with their bar starts checked by Beat This! (downbeat.ts), and the line to print under
// each it had something to say about. With `bpm`, a take whose downbeats it hears clearly on
// another beat is measured again from there; else such a take only gets a warning. Without
// onnxruntime-node nothing changes, and a check that fails is reported and left out.
async function checkDownbeats(
  work: string,
  takes: Take[],
  bpm?: number
): Promise<{ takes: Take[]; notes: Map<number, string> }> {
  const notes = new Map<number, string>();
  try {
    const audio = takes.map((t) => ({
      take: t.take,
      file: resolve(work, t.file),
      filter: t.filter,
      t0: t.bars[0]?.t ?? 0,
      beat: t.beat,
    }));
    const verdicts = await checkTakes(audio);
    if (!verdicts) return { takes, notes };
    const checked = takes.map((t) => {
      const v = verdicts.get(t.take);
      if (!v) return t;
      const move = bpm ? beatsToMove(v) : 0;
      const line = move ? movedLine(t.take, v) : downbeatLine(t.take, v);
      if (line) notes.set(t.take, line);
      return move ? measureTake(work, t.file, t.take, bpm!, move) : t;
    });
    return { takes: checked, notes };
  } catch (e) {
    console.error(`downbeat: not checked (${errorMessage(e)})`);
    return { takes, notes };
  }
}

export async function runBeatBgm(
  work: string,
  script: Script,
  bpm: number,
  again = false
): Promise<void> {
  const files = again ? keptTakes(work) : await bgmTakes(work, script, bpm);
  const measured = files.map((f) =>
    measureTake(work, f, Number(/take(\d+)/.exec(f)?.[1] ?? 0), bpm)
  );
  // Before the drafts: a take whose bars Beat This! moved is drafted on its new bars.
  const { takes, notes } = await checkDownbeats(work, measured, bpm);
  writeFileSync(join(work, "audio", "bgm", "takes.json"), JSON.stringify(takes));
  const drafts = rankDrafts(work, script, draftScores(takes, loadTiming(work), bpm)).map(
    (d) =>
      `draft: { "take": ${d.take}, "bars": "${d.bars}" }  (${d.checks} check lines, ${d.moments} moments, ${d.joins} joins)`
  );
  const advice = tempoAdvice(takes, bpm, work);
  const text = [
    ...takes.map((t) => [takeTable(t, bpm), notes.get(t.take)].filter(Boolean).join("\n")),
    drafts.join("\n"),
    ...(advice ? [advice] : []),
  ].join("\n\n");
  writeFileSync(join(work, "audio", "bgm", "takes.txt"), `${text}\n`);
  console.log(text);
  console.log(
    `\nstart from a draft (the first fits best), change it to fit the story, write it to "score" in script.json, then run "motion-render score ${work}" (the tables: ${join(work, "audio", "bgm", "takes.txt")})`
  );
}

export async function runScore(work: string): Promise<void> {
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
  const chosen = loadTakes(work).filter((t) => t.take === script.score?.take);
  for (const line of (await checkDownbeats(work, chosen)).notes.values()) console.log(line);
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

// Prints the measurements, with the check of the narration against the stops (it needs no picture),
// and returns the problems found.
function printSync(m: SyncResult, work: string, script: Script, timing: Timing): string[] {
  const s = voiceInStops(work, script, timing);
  const r = { lines: [...m.lines, ...s.lines], problems: [...m.problems, ...s.problems] };
  for (const l of r.lines) console.log(`sync: ${l}`);
  for (const p of r.problems) console.log(`sync problem: ${p}`);
  console.log(r.problems.length ? `sync: ${r.problems.length} problems` : "sync: ok");
  return r.problems;
}

// Prints the measurements of the MP4, its sound included, and returns the problems found. `picture`
// is the film before its finish, when the build put one on (look.ts).
export async function syncReport(
  work: string,
  script: Script,
  timing: Timing,
  mp4: string,
  picture?: string
): Promise<string[]> {
  const score = join(work, "audio", "score.wav");
  const audio = {
    ...(existsSync(score) ? { score } : {}),
    narration: timing.scenes.map((s) => ({
      id: s.id,
      file: join(work, "audio", `${s.id}.wav`),
      at: s.start + script.lead,
    })),
    speed: script.speed,
  };
  return printSync(
    await measureSync(mp4, timing, script, loadHits(work), {
      audio,
      ...(picture ? { picture } : {}),
    }),
    work,
    script,
    timing
  );
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
    await measureSyncPictures({ draw, fps, ahead: film.pages }, timing, script, loadHits(work)),
    work,
    script,
    timing
  );
}

export async function runSync(work: string, mp4: string): Promise<void> {
  const problems = await syncReport(work, loadScript(work), loadTiming(work), mp4);
  if (problems.length) throw new Error(`${problems.length} sync problems in ${mp4}`);
}
