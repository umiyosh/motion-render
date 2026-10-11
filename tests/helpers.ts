import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDir = (prefix = "mr-test-"): string => mkdtempSync(join(tmpdir(), prefix));

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
