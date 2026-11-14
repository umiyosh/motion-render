import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDir = (prefix = "mr-test-"): string => mkdtempSync(join(tmpdir(), prefix));

type BarKind = "pad" | "drums" | "silent" | "loud";

// A drum track at 44.1 kHz, interleaved stereo: `start` s of silence, then one bar per entry of
// `bars`. Drum bars have a kick on 1 and 3, a snare on 2 and 4 and a hat on every other 8th
// (pattern "K.-. S.-. K.-. S.-."); "loud" bars hit harder; "pad" bars hold a quiet chord only.
export function drumTrack(bpm: number, start: number, bars: BarKind[]): Float32Array {
  const RATE = 44100,
    bar = 240 / bpm,
    step = bar / 16;
  const n = Math.round((start + bars.length * bar + 1) * RATE);
  const x = new Float32Array(n);
  let seed = 7;
  const noise = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 31 - 1;
  };
  const add = (t: number, len: number, f: (dt: number) => number): void => {
    const a = Math.round(t * RATE);
    for (let i = 0; i < len * RATE && a + i < n; i++) x[a + i] += f(i / RATE);
  };
  // a soft 3 ms attack and a short drop in pitch keep the kick in the lows, as a real one is
  const kick = (t: number, g: number): void =>
    add(
      t,
      0.3,
      (dt) =>
        g *
        (1 - Math.exp(-dt / 0.003)) *
        Math.exp(-dt / 0.1) *
        Math.sin(2 * Math.PI * (50 * dt + 30 * 0.03 * (1 - Math.exp(-dt / 0.03))))
    );
  const snare = (t: number, g: number): void =>
    add(
      t,
      0.25,
      (dt) => g * Math.exp(-dt / 0.07) * (0.7 * noise() + 0.3 * Math.sin(2 * Math.PI * 240 * dt))
    );
  let last = 0,
    prev = 0;
  const hat = (t: number, g: number): void =>
    add(t, 0.06, (dt) => {
      const v = noise(),
        d = v - 2 * last + prev; // second difference: highs only
      prev = last;
      last = v;
      return g * Math.exp(-dt / 0.015) * d;
    });
  bars.forEach((kind, b) => {
    const t0 = start + b * bar;
    // phase from the track's own time, so the chord runs on across bar lines without a click
    if (kind === "pad")
      add(
        t0,
        bar,
        (dt) =>
          0.04 * (Math.sin(2 * Math.PI * 220 * (t0 + dt)) + Math.sin(2 * Math.PI * 330 * (t0 + dt)))
      );
    if (kind !== "drums" && kind !== "loud") return;
    const g = kind === "loud" ? 1 : 0.6;
    for (const s of [0, 8]) kick(t0 + s * step, 0.9 * g);
    for (const s of [4, 12]) snare(t0 + s * step, 0.5 * g);
    for (const s of [2, 6, 10, 14]) hat(t0 + s * step, 0.12 * g);
  });
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) out[i * 2] = out[i * 2 + 1] = Math.max(-1, Math.min(1, x[i]!));
  return out;
}

// A mono 16-bit PCM WAV of the given length (silence).
export function wav(seconds: number, rate = 24000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// A work dir with script.json and, optionally, narration WAVs of the given lengths.
export function workDir(script: object, speech: Record<string, number> = {}): string {
  const dir = tempDir("mr-work-");
  writeFileSync(join(dir, "script.json"), JSON.stringify(script));
  mkdirSync(join(dir, "audio"), { recursive: true });
  for (const [id, s] of Object.entries(speech))
    writeFileSync(join(dir, "audio", `${id}.wav`), wav(s));
  return dir;
}

export const SCRIPT = {
  bgm: "calm synth",
  scenes: [
    { id: "intro", name: "Intro", narration: "はじめに" },
    { id: "flow", narration: "流れ" },
  ],
};
