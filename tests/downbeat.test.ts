// A second opinion on where a take's bars start, from Beat This! (#67): the vote over which beat of
// our bars its downbeats fall on, the line bgm and score print, the peaks, the 30 s windows, the
// spectrogram, nothing at all without onnxruntime-node, and (when the model is in the cache) a song
// whose bars it finds where they are, and one beat off when the song is moved by a beat.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  beatOfBar,
  cacheDir,
  checkTakes,
  downbeatLine,
  inWindows,
  loadOrt,
  peaks,
  spectrogram,
} from "../skills/motion-render/scripts/downbeat.ts";
import { writeWav } from "../skills/motion-render/scripts/score.ts";
import { drumTrack, tempDir } from "./helpers.ts";

describe("which beat of our bars the downbeats fall on", () => {
  it("votes by the nearest beat, and warns only for a clear vote off beat 1", () => {
    const on = (beat: number) =>
      Array.from({ length: 10 }, (_, b) => 0.5 + b * 2 + (beat - 1) * 0.5);
    expect(beatOfBar(on(1), 0.5, 0.5)).toEqual({ beat: 1, share: 1, n: 10 });
    expect(
      beatOfBar(
        on(4).map((t) => t + 0.04),
        0.5,
        0.5
      )
    ).toEqual({ beat: 4, share: 1, n: 10 });
    expect(downbeatLine(3, { beat: 1, share: 1, n: 30 })).toBeNull();
    expect(downbeatLine(3, { beat: 4, share: 0.5, n: 30 })).toBeNull(); // unclear
    expect(downbeatLine(3, { beat: 4, share: 1, n: 5 })).toBeNull(); // too few
    expect(downbeatLine(3, { beat: 4, share: 0.97, n: 33 })).toBe(
      "downbeat: take 3 disagrees (ml says beat 4: 97% of its 33 downbeats fall on beat 4 of these bars)"
    );
  });

  it("picks frames above 0 that are the highest within 3 frames, at 50 a second", () => {
    const v = new Float32Array(200).fill(-5);
    v.set([1, 3, 2], 10); // one peak at 11
    v.set([2, 2], 100); // two equal side by side: the first
    v[150] = 0; // not above 0
    expect(peaks(v)).toEqual([11 / 50, 100 / 50]);
  });

  it("runs 30 s windows that overlap by 6 frames at each inner edge, keeping the first", async () => {
    const frames = 4000,
      spect = { data: new Float32Array(frames * 128), frames };
    let n = 0;
    const out = await inWindows(spect, async () => {
      n++;
      return { beat: new Float32Array(1500).fill(n), downbeat: new Float32Array(1500).fill(-n) };
    });
    expect(n).toBe(3); // windows at 0, 1488 and 2976
    expect([out.beat[0], out.beat[1493], out.beat[1494], out.beat[2981], out.beat[2982]]).toEqual([
      1, 1, 2, 2, 3,
    ]);
    expect(out.beat[3999]).toBe(3);
    expect(out.downbeat[1494]).toBe(-2);
  });

  it("makes 50 frames a second of 128 log-mel bands", () => {
    // 1 s of a sine on bin 93 (2002 Hz); a filterbank of 4 bins a band puts it in band 23
    const x = Float32Array.from({ length: 22050 }, (_, i) =>
      Math.sin((2 * Math.PI * 93 * i) / 1024)
    );
    const fb = new Float32Array(513 * 128);
    for (let k = 0; k < 512; k++) fb[k * 128 + (k >> 2)] = 1;
    const s = spectrogram(x, fb);
    expect(s.frames).toBe(51);
    const mid = s.data.subarray(25 * 128, 26 * 128);
    expect(mid.indexOf(Math.max(...mid))).toBe(23);
  });

  it("does nothing without onnxruntime-node", async () => {
    expect(
      await checkTakes([{ take: 1, file: "x.mp3", filter: "anull", t0: 0, beat: 0.5 }], null)
    ).toBeNull();
  });
});

// 16 bars at 120 BPM after 0.5 s: drums (kick on 1 and 3, snare on 2 and 4), a bass that changes
// note on every bar and a crash on each bar's head, as music marks a bar: drums alone are a one-bar
// loop with nothing to tell beat 1 from beat 3.
function song(file: string): void {
  const RATE = 44100,
    start = 0.5,
    bars = 16,
    x = drumTrack(120, start, Array<"drums">(bars).fill("drums"));
  const notes = [55, 43.65, 65.41, 49];
  let seed = 3;
  const noise = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31 - 1;
  for (let b = 0; b < bars; b++)
    for (let i = 0; i < 2 * RATE; i++) {
      const dt = i / RATE,
        t = start + b * 2 + dt,
        f = notes[b % 4]!,
        k = Math.round(t * RATE) * 2;
      if (k + 1 >= x.length) break;
      const v =
        0.25 * Math.sin(2 * Math.PI * f * t) * Math.exp(-dt / 1.5) +
        0.05 * [4, 5, 6].reduce((a, h) => a + Math.sin(2 * Math.PI * f * h * t), 0) +
        (dt < 1.2 ? 0.15 * noise() * Math.exp(-dt / 0.35) : 0);
      x[k]! += v;
      x[k + 1]! += v;
    }
  writeWav(x, file);
}

const model = loadOrt() !== null && existsSync(join(cacheDir(), "beat_this.onnx"));

describe.skipIf(!model)("Beat This! on a song (with the model in the cache)", () => {
  it("finds the bars where they start, and one beat off when the song is moved by a beat", async () => {
    const file = join(tempDir("mr-downbeat-"), "song.wav");
    song(file);
    const at = (shift: number) => ({
      take: shift,
      file,
      filter: `atrim=start=${shift * 0.5}`,
      t0: 0.5,
      beat: 0.5,
    });
    const v = await checkTakes([at(0), at(1)]);
    expect(v?.get(0)).toMatchObject({ beat: 1 });
    expect(v?.get(0)!.share).toBeGreaterThan(0.9);
    expect(v?.get(1)).toMatchObject({ beat: 4 });
    expect(downbeatLine(0, v!.get(0)!)).toBeNull();
    expect(downbeatLine(1, v!.get(1)!)).toMatch(/^downbeat: take 1 disagrees \(ml says beat 4/);
  }, 120_000);
});
