// 1 本の動画を作る間に、各コマンドがいつからいつまで動いたかを <work>/steps.jsonl に残し、
// コマンドの時間と、その間の Claude の作業（原稿・映像を書く、静止画を見る）の時間に分けて表にする（times）。
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { field } from "./json.ts";

interface Step {
  cmd: string;
  start: number; // ms since the epoch
  end: number;
  ok: boolean;
}

const FILE = "steps.jsonl";
// Commands Claude starts in the background and keeps working while they run (SKILL.md), so their
// time is not a wait and the time beside them still counts as Claude's.
const BACKGROUND = new Set(["bgm", "sfx"]);
const GAP_MS = 1_000; // shorter gaps between commands are the shell, not work

// The work dir a command's path belongs to: <work> itself, or <work> for <work>/film. Null when the
// path is not in a work dir (a film dir on its own), so nothing is logged.
export function workOf(path: string): string | null {
  const p = resolve(path);
  for (const w of [p, basename(p) === "film" ? dirname(p) : null])
    if (w && existsSync(join(w, "script.json"))) return w;
  return null;
}

// Runs a command and logs its span, whether it succeeds or fails.
export async function timed<T>(
  work: string | null,
  cmd: string,
  run: () => Promise<T> | T
): Promise<T> {
  const start = Date.now();
  let ok = false;
  try {
    const r = await run();
    ok = true;
    return r;
  } finally {
    if (work) {
      const step: Step = { cmd, start, end: Date.now(), ok };
      appendFileSync(join(work, FILE), JSON.stringify(step) + "\n");
    }
  }
}

function parseStep(line: string): Step | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null; // a line cut short by a crash: the other steps still count
  }
  const cmd = field(v, "cmd"),
    start = field(v, "start"),
    end = field(v, "end"),
    ok = field(v, "ok");
  return typeof cmd === "string" &&
    typeof start === "number" &&
    typeof end === "number" &&
    typeof ok === "boolean"
    ? { cmd, start, end, ok }
    : null;
}

export function readSteps(work: string): Step[] {
  const file = join(work, FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map(parseStep)
    .filter((s): s is Step => s !== null)
    .sort((a, b) => a.start - b.start);
}

export interface Row {
  at: number; // s from the start of the run
  step: string;
  seconds: number;
}

// The run as rows in time order. A run starts when the work dir was made (Claude makes it before it
// writes script.json). Time no foreground command covers is Claude's; background commands are
// listed but leave that time to Claude.
export function stepRows(steps: Step[], runStart: number): Row[] {
  const rows: Row[] = [];
  let cursor = Math.min(runStart, steps[0]?.start ?? runStart);
  const t0 = cursor;
  const s = (ms: number) => Math.round(ms / 100) / 10;
  for (const st of steps) {
    const name = `${st.cmd}${st.ok ? "" : " (failed)"}`;
    if (BACKGROUND.has(st.cmd)) {
      rows.push({
        at: s(st.start - t0),
        step: `${name} (background)`,
        seconds: s(st.end - st.start),
      });
      continue;
    }
    if (st.start - cursor > GAP_MS)
      rows.push({ at: s(cursor - t0), step: "Claude", seconds: s(st.start - cursor) });
    rows.push({ at: s(st.start - t0), step: name, seconds: s(st.end - st.start) });
    cursor = Math.max(cursor, st.end);
  }
  return rows;
}

const clock = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
// Rounded to the whole second first, so 179.6 s reads "3 min 0 s", not "2 min 60 s".
export function span(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

// A Markdown table of the run, with the totals of Claude's time and of the commands it waited for.
export function stepsTable(work: string): string {
  const steps = readSteps(work);
  if (!steps.length) return `no steps logged in ${join(work, FILE)}`;
  const born = statSync(work);
  const rows = stepRows(steps, born.birthtimeMs || born.ctimeMs);
  const sum = (f: (r: Row) => boolean) => rows.filter(f).reduce((a, r) => a + r.seconds, 0);
  const last = rows.reduce((a, r) => Math.max(a, r.at + r.seconds), 0);
  const claude = sum((r) => r.step === "Claude");
  return [
    "| Start | Step | Time |",
    "| --- | --- | --- |",
    ...rows.map((r) => `| ${clock(r.at)} | ${r.step} | ${span(r.seconds)} |`),
    "",
    `total ${span(last)}: Claude ${span(claude)}, waiting on commands ${span(last - claude)}`,
  ].join("\n");
}
