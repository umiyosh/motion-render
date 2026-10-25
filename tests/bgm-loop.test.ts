// The BGM loop through the real ffmpeg: a filter graph that is right on paper can still drop the
// music with the bundled ffmpeg (asplit + acrossfade stopped at the first crossfade in 6.0).
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  bgmLoop,
  mediaSeconds,
  runFfmpeg,
  volumeStats,
} from "../skills/motion-render/scripts/audio.ts";
import { tempDir } from "./helpers.ts";

describe("bgmLoop with ffmpeg", () => {
  it("keeps a 20 s BGM playing to the end of a 40 s film", async () => {
    const dir = tempDir("mr-bgm-");
    const bgm = join(dir, "bgm.wav"),
      out = join(dir, "out.wav"),
      tail = join(dir, "tail.wav");
    await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=20", bgm]);
    const loop = bgmLoop(bgm, 0, await mediaSeconds(bgm), 40, "x");
    expect(loop.chains.length).toBeGreaterThan(0);
    await runFfmpeg([
      ...loop.inputs,
      "-filter_complex",
      [...loop.chains, `[${loop.label}]atrim=0:40,asetpts=PTS-STARTPTS[o]`].join(";"),
      "-map",
      "[o]",
      out,
    ]);
    expect(await mediaSeconds(out)).toBeCloseTo(40, 0);
    await runFfmpeg(["-sseof", "-5", "-i", out, tail]);
    expect((await volumeStats(tail)).mean).toBeGreaterThan(-30);
  });
});
