// The finishing layer of a film (#64): the look named in script.json, the export arguments of a
// film without one (unchanged, so not a pixel moves), and a real export with one: light leaking in
// at a section's head from the left edge only, a glow at a drop's head, the same frames every time,
// and a grey copy for sync in which the added light does not move a thing.
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeArgs, findFfmpeg, type Finish } from "../skills/motion-render/scripts/audio.ts";
import { lookGraph, lookImage, lookTimes } from "../skills/motion-render/scripts/look.ts";
import { loadScript, type Timing } from "../skills/motion-render/scripts/work.ts";
import { SCRIPT, tempDir, workDir } from "./helpers.ts";

describe("the look in script.json", () => {
  it("takes one of the looks, and nothing else", () => {
    expect(loadScript(workDir(SCRIPT)).look).toBeUndefined();
    expect(loadScript(workDir({ ...SCRIPT, look: "paper" })).look).toBe("paper");
    expect(() => loadScript(workDir({ ...SCRIPT, look: "sepia" }))).toThrow(
      /"look" must be one of flat, paper, crayon, blueprint, collage, whiteboard/
    );
  });
});

describe("a film without a look", () => {
  it("is exported with the same arguments as before looks", () => {
    expect(encodeArgs(30, "mix.m4a", "out.mp4")).toEqual(
      ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "30", "-i", "-"].concat(
        ["-i", "mix.m4a", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p"],
        ["-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-shortest"],
        ["-movflags", "+faststart", "out.mp4"]
      )
    );
    expect(encodeArgs(30, "mix.m4a", "out.mp4", 3)).toEqual(
      ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", "90", "-i", "-"].concat(
        ["-i", "mix.m4a", "-map", "0:v", "-map", "1:a", "-vf"],
        ["tmix=frames=3,select='eq(mod(n\\,3)\\,2)',setpts=N/(30*TB)", "-fps_mode", "cfr"],
        ["-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium"],
        ["-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", "out.mp4"]
      )
    );
  });
});

const FPS = 30;
// 3 s: a section (a leak) at 0.5 s and a drop (a glow) at 2 s.
const TIMING: Timing = {
  total: 3,
  bpm: 120,
  scenes: [
    { id: "calm", name: "Calm", start: 0, dur: 0.5, speech: 0.4 },
    { id: "rise", name: "Rise", start: 0.5, dur: 1.5, speech: 1, section: "build" },
    { id: "full", name: "Full", start: 2, dur: 1, speech: 0.8, section: "drop" },
  ],
};

function ff(args: string[]): Buffer {
  const r = spawnSync(findFfmpeg(), ["-v", "error", "-y", ...args], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  return r.stdout;
}

// Exports 3 s of a still mid-grey picture through encodeArgs, as a build pipes its frames.
async function exportGrey(dir: string, name: string): Promise<{ mp4: string; plain: string }> {
  const png = join(dir, "grey.png"),
    audio = join(dir, "silence.m4a");
  ff(["-f", "lavfi", "-i", "color=c=0x808080:s=1920x1080:d=1", "-frames:v", "1", png]);
  ff(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "3", "-c:a", "aac", audio]);
  const leak = lookImage("paper");
  const mp4 = join(dir, `${name}.mp4`),
    plain = join(dir, `${name}.mkv`);
  const finish: Finish = {
    graph: (i, o) => lookGraph({ name: "paper", timing: TIMING, fps: FPS, leak }, i, o),
    plain: { file: plain, w: 240, h: 135 },
  };
  const p = spawn(findFfmpeg(), encodeArgs(FPS, audio, mp4, 1, finish), {
    stdio: ["pipe", "ignore", "inherit"],
  });
  const frame = readFileSync(png);
  for (let i = 0; i < 3 * FPS; i++) p.stdin.write(frame);
  p.stdin.end();
  const code = await new Promise((ok) => p.on("close", ok));
  expect(code).toBe(0);
  return { mp4, plain };
}

// The mean luma of a strip of the frame at t: x from `left` to `left + w` of 1920.
function luma(mp4: string, t: number, left: number, w = 200): number {
  const raw = ff(
    ["-ss", String(t), "-i", mp4, "-frames:v", "1"].concat([
      "-vf",
      `crop=${w}:1080:${left}:0,scale=1:1:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-",
    ])
  );
  return raw[0]!;
}

describe("a film with a look", () => {
  it("lets light in at a section's head from the left, glows at a drop's head, and keeps sync's copy still", async () => {
    expect(lookTimes(TIMING)).toEqual({ leaks: [0.5], drops: [2] });
    const dir = tempDir("mr-look-");
    const a = await exportGrey(dir, "a");
    // the leak: the left edge brightens at its peak (0.4 s after the head) and is gone 1.6 s after the head
    expect(luma(a.mp4, 0.9, 0) - luma(a.mp4, 0.2, 0)).toBeGreaterThan(8);
    expect(Math.abs(luma(a.mp4, 0.9, 1700) - luma(a.mp4, 0.2, 1700))).toBeLessThanOrEqual(1);
    expect(Math.abs(luma(a.mp4, 2.8, 0) - luma(a.mp4, 0.2, 0))).toBeLessThanOrEqual(1);
    // the glow: the whole frame is brighter on the drop's head than just before, and settles back to
    // where it was before the leak (at 1.9 s the leak is still fading)
    expect(luma(a.mp4, 2.0, 900) - luma(a.mp4, 1.9, 900)).toBeGreaterThan(8);
    expect(Math.abs(luma(a.mp4, 2.8, 900) - luma(a.mp4, 0.2, 900))).toBeLessThanOrEqual(1);
    // sync's copy is the picture before the look: still, so no light reads as a reaction
    const grey = ff(["-i", a.plain, "-f", "rawvideo", "-"]);
    const size = 240 * 135,
      frames = grey.length / size;
    expect(frames).toBe(3 * FPS);
    expect(grey.subarray(0, size).equals(grey.subarray(size * 60, size * 61))).toBe(true);
    // the same input gives the same frames
    const b = await exportGrey(dir, "b");
    const md5 = (f: string) =>
      String(ff(["-i", f, "-an", "-f", "framemd5", "-"]))
        .split("\n")
        .filter((l) => !l.startsWith("#"));
    expect(md5(b.mp4)).toEqual(md5(a.mp4));
  }, 120_000);
});
