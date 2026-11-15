// Motion blur: the pictures of each frame are averaged by ffmpeg into one frame of the MP4.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { encodeArgs, findFfmpeg } from "../skills/motion-render/scripts/audio.ts";
import { tempDir } from "./helpers.ts";

describe("motion blur", () => {
  it("averages the pictures of each frame into one when the film asks for motion blur", () => {
    const dir = tempDir();
    const ff = findFfmpeg();
    const png = (c: string) =>
      execFileSync(ff, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${c}:s=64x36:d=0.04`,
        "-frames:v",
        "1",
        "-f",
        "image2",
        "-c:v",
        "png",
        "-",
      ]);
    const audio = join(dir, "a.m4a");
    execFileSync(ff, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "2",
      "-c:a",
      "aac",
      audio,
    ]);
    // 30 frames of 4 pictures each: half black, half white, so every frame averages to mid-gray.
    const input = Buffer.concat(
      Array.from({ length: 120 }, (_, i) => png(i % 4 < 2 ? "black" : "white"))
    );
    const out = join(dir, "blur.mp4");
    execFileSync(ff, encodeArgs(30, audio, out, 4), { input });
    const frames = execFileSync(ff, [
      "-v",
      "error",
      "-i",
      out,
      "-map",
      "0:v",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ]);
    expect(frames.length).toBe(30 * 64 * 36);
    const mean = frames.reduce((a, v) => a + v, 0) / frames.length;
    expect(mean).toBeGreaterThan(110);
    expect(mean).toBeLessThan(145);
  });
});
