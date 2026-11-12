// One contact sheet of a film's MP4 for a critic: the middle of every scene, a beat before, on and
// after each drop, and the final hit, four to a row. A critic reads one image instead of a hundred
// frames, which keeps a review round to minutes.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfmpeg } from "./audio.ts";
import { clock, type Timing } from "./work.ts";

interface Shot {
  t: number;
  label: string;
}

const W = 480,
  H = 270,
  COLS = 4;

// The moments worth seeing, in time order.
function sheetShots(timing: Timing): Shot[] {
  const beat = timing.bpm ? 60 / timing.bpm : 0.5;
  const shots: Shot[] = [];
  for (const s of timing.scenes) {
    if (s.section === "drop")
      shots.push(
        { t: s.start - beat, label: `${s.id}: a beat before the drop` },
        { t: s.start + 0.02, label: `${s.id}: the drop` },
        { t: s.start + beat, label: `${s.id}: a beat after` }
      );
    shots.push({ t: s.start + s.dur / 2, label: `${s.id}: middle` });
  }
  if (timing.end !== undefined) shots.push({ t: timing.end + 0.05, label: "the final hit" });
  return shots.filter((s) => s.t >= 0 && s.t < timing.total).sort((a, b) => a.t - b.t);
}

// Writes the sheet and, next to it, a .txt naming each tile; returns those names.
export function writeSheet(mp4: string, timing: Timing, out: string): string[] {
  const ff = findFfmpeg();
  const shots = sheetShots(timing);
  const dir = mkdtempSync(join(tmpdir(), "mr-sheet-"));
  const files = shots.map((s, i) => {
    const f = join(dir, `${String(i).padStart(3, "0")}.png`);
    const r = spawnSync(ff, [
      "-v",
      "error",
      "-y",
      "-ss",
      s.t.toFixed(3),
      "-i",
      mp4,
      "-frames:v",
      "1",
      "-vf",
      `scale=${W}:${H}`,
      f,
    ]);
    if (r.status !== 0) throw new Error(`ffmpeg could not read ${mp4} at ${s.t}: ${r.stderr}`);
    return f;
  });
  const rows = Math.ceil(files.length / COLS),
    n = rows * COLS;
  const inputs = files.flatMap((f) => ["-i", f]);
  for (let i = files.length; i < n; i++)
    inputs.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`);
  const layout = Array.from(
    { length: n },
    (_, i) => `${(i % COLS) * W}_${Math.floor(i / COLS) * H}`
  ).join("|");
  const stack = Array.from({ length: n }, (_, i) => `[${i}:v]`).join("");
  const r = spawnSync(ff, [
    "-v",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    `${stack}xstack=inputs=${n}:layout=${layout}`,
    "-frames:v",
    "1",
    out,
  ]);
  if (r.status !== 0) throw new Error(`ffmpeg could not tile the sheet: ${r.stderr}`);
  const names = shots.map(
    (s, i) =>
      `${i + 1} (row ${Math.floor(i / COLS) + 1}, column ${(i % COLS) + 1}): ${clock(s.t)} ${s.label}`
  );
  writeFileSync(out.replace(/\.png$/, "") + ".txt", names.join("\n") + "\n");
  return names;
}
