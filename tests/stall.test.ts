// Commands that wait on ffmpeg must not wait forever (#51): a stalled ffmpeg is killed and the
// command fails with what it was waiting for.
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureSyncPictures } from "../skills/motion-render/scripts/sync.ts";
import { ffmpegSync, findFfmpeg } from "../skills/motion-render/scripts/audio.ts";
import { gray } from "../skills/motion-render/scripts/repeat.ts";
import { tempDir } from "./helpers.ts";

// An "ffmpeg" that never reads its input and never exits.
function stuckFfmpeg(): string {
  const file = join(tempDir("mr-stuck-"), "ffmpeg");
  writeFileSync(file, "#!/bin/sh\nexec sleep 600\n");
  chmodSync(file, 0o755);
  return file;
}

// An "ffmpeg" that stalls on its first run and is the real one after that.
function stuckOnceFfmpeg(): string {
  const dir = tempDir("mr-stuck-once-");
  const file = join(dir, "ffmpeg");
  const ran = join(dir, "ran");
  writeFileSync(
    file,
    `#!/bin/sh\nif [ -e '${ran}' ]; then exec '${findFfmpeg()}' "$@"; fi\n: > '${ran}'\nexec sleep 600\n`
  );
  chmodSync(file, 0o755);
  return file;
}

// One small PNG, made by the real ffmpeg.
function png(): Buffer {
  return ffmpegSync(
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=gray:s=64x36",
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2pipe",
      "-",
    ],
    "make a png"
  );
}

const TIMING = {
  total: 4,
  bpm: 120,
  end: 3,
  scenes: [{ id: "drop", name: "drop", start: 0, dur: 4, speech: 3, section: "drop" as const }],
};
const KICKS = [1, 1.5, 2, 2.5].map((t, i) => ({ t, slot: 4 + 4 * i, k: "kick" as const, v: 0.9 }));

describe("a stalled ffmpeg", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails the preview's sync measure instead of waiting forever", async () => {
    vi.stubEnv("FFMPEG_PATH", stuckFfmpeg());
    // pictures far larger than a pipe's buffer, so the writer has to wait for ffmpeg to read
    const big = Buffer.alloc(4 << 20, 7);
    const started = Date.now();
    await expect(
      measureSyncPictures(
        { draw: () => Promise.resolve(big), fps: 60, ahead: 2, ffmpegMs: 500 },
        TIMING,
        { lead: 0.25 },
        KICKS
      )
    ).rejects.toThrow(/ffmpeg .* did not finish in 0\.5s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("fails a run of ffmpeg to the end (the sheet, decoding) instead of waiting forever", () => {
    vi.stubEnv("FFMPEG_PATH", stuckFfmpeg());
    expect(() => ffmpegSync(["-i", "x"], "tile the sheet", { ms: 300 })).toThrow(
      "ffmpeg did not tile the sheet in 0.3s"
    );
  });

  // The seek-back check once sat 15 minutes on an idle ffmpeg reading one frame (#75)
  it("fails the seek-back check's frame reading after a second try, naming the frame", () => {
    const frame = png();
    vi.stubEnv("FFMPEG_PATH", stuckFfmpeg());
    const started = Date.now();
    expect(() => gray(frame, "the frame at 1.00 s", 300)).toThrow(
      "ffmpeg did not read the frame at 1.00 s in 0.3s (2 tries)"
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reads the frame when ffmpeg stalls only once", () => {
    const frame = png();
    vi.stubEnv("FFMPEG_PATH", stuckOnceFfmpeg());
    expect(gray(frame, "the frame at 1.00 s", 2_000)).toHaveLength(480 * 270);
  });
});
