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

// A picture of the MP4 at t, as PNG.
export function mp4Picture(mp4: string): (t: number) => Promise<Buffer> {
  const ff = findFfmpeg();
  return (t) => {
    const r = spawnSync(
      ff,
      ["-v", "error", "-ss", t.toFixed(3), "-i", mp4, "-frames:v", "1"].concat([
        "-f",
        "image2",
        "-c:v",
        "png",
        "-",
      ]),
      { maxBuffer: 64 * 1024 * 1024 }
    );
    if (r.status !== 0) throw new Error(`ffmpeg could not read ${mp4} at ${t}: ${r.stderr}`);
    return Promise.resolve(r.stdout);
  };
}

// Writes the sheet and, next to it, a .txt naming each tile; returns those names. `picture` gives
// the film at a time: from its MP4 (mp4Picture), or drawn by the film's pages before any build.
export async function writeSheet(
  picture: (t: number) => Promise<Buffer>,
  timing: Timing,
  out: string
): Promise<string[]> {
  const ff = findFfmpeg();
  const shots = sheetShots(timing);
  const dir = mkdtempSync(join(tmpdir(), "mr-sheet-"));
  const files = await Promise.all(
    shots.map(async (s, i) => {
      const f = join(dir, `${String(i).padStart(3, "0")}.png`);
      writeFileSync(f, await picture(s.t));
      return f;
    })
  );
  const rows = Math.ceil(files.length / COLS),
    n = rows * COLS;
  const inputs = files.flatMap((f) => ["-i", f]);
  for (let i = files.length; i < n; i++)
    inputs.push("-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`);
  const layout = Array.from(
    { length: n },
    (_, i) => `${(i % COLS) * W}_${Math.floor(i / COLS) * H}`
  ).join("|");
  const scaled = Array.from({ length: n }, (_, i) => `[${i}:v]scale=${W}:${H}[s${i}];`).join("");
  const stack = Array.from({ length: n }, (_, i) => `[s${i}]`).join("");
  const r = spawnSync(ff, [
    "-v",
    "error",
    "-y",
    ...inputs,
    "-filter_complex",
    `${scaled}${stack}xstack=inputs=${n}:layout=${layout}`,
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
