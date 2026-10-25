// ナレーション（Gemini TTS）と BGM（Lyria）を作り、ffmpeg で 1 本の音声に合成する。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { errorMessage, field, readJson } from "./json.ts";
import { limit } from "./limit.ts";
import type { Script } from "./work.ts";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
export const TIMEOUT_MS = 90_000; // a TTS request once hung for 15 minutes without this
const RETRIES = 3;
// An audio job (mixing a few minutes of sound, measuring a level) takes ffmpeg seconds. One still
// running after this is stuck, not slow.
export const FFMPEG_MS = 300_000;

interface Audio {
  mimeType: string;
  data: Buffer;
}

// One sound effect on the film timeline. `gain` multiplies its volume (it already holds the leveling).
export interface SfxTrack {
  file: string;
  start: number;
  duration: number;
  gain: number;
}

// Where each scene's narration and each sound effect go on the film timeline.
export interface MixTiming {
  scenes: { id: string; start: number }[];
  total: number;
  sfx?: SfxTrack[];
}

// ffmpeg-static downloads its binary in a postinstall script, which Claude Code's plugin dependency
// install does not run: fetch it on first use instead.
function bundledFfmpeg(): string | null {
  const require = createRequire(import.meta.url);
  let bin: unknown;
  try {
    bin = require("ffmpeg-static");
  } catch {
    return null; // package not installed
  }
  if (typeof bin !== "string") return null;
  if (existsSync(bin)) return bin;
  const installer = join(dirname(require.resolve("ffmpeg-static")), "install.js");
  if (!existsSync(installer)) return null;
  console.error("motion-render: downloading ffmpeg (first run only)...");
  spawnSync(process.execPath, [installer], {
    stdio: ["ignore", "inherit", "inherit"],
    cwd: dirname(installer),
  });
  return existsSync(bin) ? bin : null;
}

export function findFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundled = bundledFfmpeg();
  if (bundled) return bundled;
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0) return "ffmpeg";
  throw new Error("ffmpeg not found: install ffmpeg or set FFMPEG_PATH");
}

// Resolves with ffmpeg's exit code once it has exited.
export function exited(ff: ChildProcess): Promise<number | null> {
  return new Promise((ok, fail) => {
    ff.on("error", fail);
    ff.on("close", ok);
  });
}

// Waits for ffmpeg to exit, killing it if it runs past ms.
function finish(ff: ChildProcess, what: string, ms: number): Promise<number | null> {
  return limit(exited(ff), ms, what, () => ff.kill("SIGKILL"));
}

export async function runFfmpeg(args: string[], ms = FFMPEG_MS): Promise<void> {
  const ff = spawn(findFfmpeg(), ["-y", "-loglevel", "error", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await finish(ff, `ffmpeg writing ${basename(args.at(-1) ?? "")}`, ms);
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
}

// Length of an audio file in seconds, from the Duration line ffmpeg prints for its input (no decoding).
export async function mediaSeconds(file: string, ms = FFMPEG_MS): Promise<number> {
  const ff = spawn(findFfmpeg(), ["-hide_banner", "-i", file], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  ff.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  // ffmpeg exits with an error here because no output is given; only the Duration line matters.
  await finish(ff, `ffmpeg reading the length of ${basename(file)}`, ms);
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if (!m) throw new Error(`could not read the length of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Average and peak level of an audio file in dBFS (ffmpeg's volumedetect). Silence reads as -91 dB or lower.
export async function volumeStats(
  file: string,
  ms = FFMPEG_MS
): Promise<{ mean: number; max: number }> {
  const args = ["-hide_banner", "-nostats", "-i", file, "-af", "volumedetect", "-f", "null", "-"];
  const ff = spawn(findFfmpeg(), args, { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  ff.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const code = await finish(ff, `ffmpeg measuring ${basename(file)}`, ms);
  const level = (name: string): number => {
    const v = new RegExp(`${name}: (-?[\\d.]+|-inf) dB`).exec(log)?.[1];
    return v === "-inf" ? -120 : Number(v ?? NaN);
  };
  const mean = level("mean_volume"),
    max = level("max_volume");
  if (code !== 0 || !Number.isFinite(mean) || !Number.isFinite(max))
    throw new Error(`could not measure the level of ${file} (ffmpeg exited with ${code})`);
  return { mean, max };
}

// Runs `attempt` up to RETRIES times, logging each failure under `label`, and rethrows the last error.
export async function withRetries<T>(label: string, attempt: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= RETRIES; i++) {
    try {
      return await attempt();
    } catch (e) {
      last = e;
      console.error(`motion-render: ${label} attempt ${i}/${RETRIES} failed: ${errorMessage(e)}`);
    }
  }
  throw last;
}

// Picks the first inline audio part out of a generateContent response.
function audioPart(json: unknown): { mimeType: string; data: string } | null {
  const candidates = field(json, "candidates");
  const first: unknown = Array.isArray(candidates) ? candidates[0] : undefined;
  const list = field(field(first, "content"), "parts");
  if (!Array.isArray(list)) return null;
  for (const p of list) {
    const inline = field(p, "inlineData");
    const mimeType = field(inline, "mimeType");
    const data = field(inline, "data");
    if (typeof mimeType === "string" && typeof data === "string") return { mimeType, data };
  }
  return null;
}

// Calls Gemini generateContent and returns the first inline audio part.
async function generateAudio(model: string, body: object): Promise<Audio> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set (needed for narration and BGM)");
  return withRetries(model, async () => {
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json: unknown = await res.json();
    if (!res.ok) {
      const detail = field(field(json, "error"), "message");
      throw new Error(
        `${model}: HTTP ${res.status} ${typeof detail === "string" ? detail : ""}`.trim()
      );
    }
    const part = audioPart(json);
    if (!part) throw new Error(`${model}: no audio in the response`);
    return { mimeType: part.mimeType, data: Buffer.from(part.data, "base64") };
  });
}

// Gemini TTS returns WAV, or raw 16-bit PCM ("audio/L16;rate=24000") on some models: always store WAV.
function toWav({ mimeType, data }: Audio): Buffer {
  if (data.subarray(0, 4).toString() === "RIFF") return data;
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
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

export function wavSeconds(file: string): number {
  const b = readFileSync(file);
  let rate = 0,
    align = 0,
    size = 0;
  for (let o = 12; o + 8 <= b.length; o += 8 + b.readUInt32LE(o + 4)) {
    const id = b.toString("ascii", o, o + 4);
    if (id === "fmt ") {
      rate = b.readUInt32LE(o + 12);
      align = b.readUInt16LE(o + 20);
    }
    if (id === "data") {
      size = Math.min(b.readUInt32LE(o + 4), b.length - o - 8);
      break;
    }
  }
  if (!rate || !align) throw new Error(`${file}: not a PCM WAV file`);
  return size / (rate * align);
}

// Writes audio/<scene id>.wav for each scene. A scene is regenerated only when its narration text changed.
export async function narrate(work: string, script: Script): Promise<void> {
  const dir = join(work, "audio");
  mkdirSync(dir, { recursive: true });
  for (const s of script.scenes) {
    const wav = join(dir, `${s.id}.wav`),
      txt = join(dir, `${s.id}.txt`);
    if (existsSync(wav) && existsSync(txt) && readFileSync(txt, "utf8") === s.narration) continue;
    console.error(`narration: ${s.id}`);
    const audio = await generateAudio(script.ttsModel, {
      contents: [{ parts: [{ text: s.narration }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: script.voice } } },
      },
    });
    writeFileSync(wav, toWav(audio));
    writeFileSync(txt, s.narration);
  }
}

// Writes audio/bgm.<ext> from the script's BGM prompt, asking for a little more than the film's length.
export async function bgm(work: string, script: Script, seconds: number): Promise<string> {
  const dir = join(work, "audio");
  mkdirSync(dir, { recursive: true });
  const prompt = `${script.bgm}\n\nInstrumental only, no vocals. About ${Math.ceil(seconds) + 10} seconds long. Keep a steady level so it can sit under a voice-over.`;
  const audio = await generateAudio(script.bgmModel, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["AUDIO"] },
  });
  const ext = /wav/.test(audio.mimeType) ? "wav" : "mp3";
  const file = join(dir, `bgm.${ext}`);
  writeFileSync(file, audio.data);
  writeFileSync(join(dir, "bgm.json"), JSON.stringify({ file: `bgm.${ext}`, prompt }, null, 2));
  return file;
}

export function bgmFile(work: string): string {
  const meta = join(work, "audio", "bgm.json");
  if (!existsSync(meta)) throw new Error(`no BGM yet: run "motion-render bgm ${work}"`);
  const file = field(readJson(meta), "file");
  if (typeof file !== "string")
    throw new Error(`${meta} is malformed: run "motion-render bgm ${work}" again`);
  return join(work, "audio", file);
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

// One sound effect as a filter chain from input `input` to [label]: cut to its length (generated audio can
// run long), leveled by `gain`, faded at both ends so it cannot click, and delayed to its start.
export function sfxChain(input: number, t: SfxTrack, label: string): string {
  const fade = Math.min(0.25, t.duration / 3);
  return [
    `[${input}:a]atrim=0:${t.duration},asetpts=PTS-STARTPTS,aresample=44100`,
    "aformat=channel_layouts=stereo",
    `volume=${t.gain.toFixed(4)}`,
    "afade=t=in:d=0.01",
    `afade=t=out:st=${round(t.duration - fade)}:d=${round(fade)}`,
    `adelay=${Math.round(t.start * 1000)}:all=1[${label}]`,
  ].join(",");
}

// Narration at each scene's start + lead, BGM at a constant level underneath (ducking made it pump),
// and the sound effects at their times.
const LOOP_FROM = 30; // s into the BGM where a return lands, past its intro
const LOOP_FADE = 3; // s of crossfade at each return
// s at the end of the BGM left out when it loops: its closing bars fade out, and crossfading a fade
// into the next pass leaves the music thin for a few seconds. The film fades out on its own.
const LOOP_TAIL = 6;

export interface BgmLoop {
  inputs: string[]; // ffmpeg input arguments for the BGM, in order from input number `first`
  chains: string[]; // filters that make the long-enough BGM
  label: string; // the stream to take the BGM from
}

// A BGM shorter than the film carries on as the same piece: after its first pass it goes back to a
// point past its intro (never to its start, which sounds like a new piece beginning) and crossfades
// there, as many times as the film needs. Every pass stops before the closing bars. Each return reads
// the file again as its own input, seeked past the intro: splitting one input with asplit stops the
// music at the first crossfade with the bundled ffmpeg 6.0.
export function bgmLoop(
  file: string,
  first: number,
  len: number,
  total: number,
  out: string
): BgmLoop {
  if (len >= total) return { inputs: ["-i", file], chains: [], label: `${first}:a` };
  if (len < 4 * LOOP_FADE + LOOP_TAIL)
    return { inputs: ["-stream_loop", "-1", "-i", file], chains: [], label: `${first}:a` };
  const body = round(len - LOOP_TAIL);
  const from = round(Math.min(LOOP_FROM, len / 4));
  const returns = Math.ceil((total - body) / (body - from - LOOP_FADE));
  const inputs = ["-t", String(body), "-i", file];
  const chains: string[] = [];
  let last = `${first}:a`;
  for (let i = 1; i <= returns; i++) {
    inputs.push("-ss", String(from), "-t", String(round(body - from)), "-i", file);
    const next = i === returns ? out : `${out}${i}`;
    chains.push(`[${last}][${first + i}:a]acrossfade=d=${LOOP_FADE}:c1=tri:c2=tri[${next}]`);
    last = next;
  }
  return { inputs, chains, label: out };
}

export async function mix(
  work: string,
  script: Script,
  timing: MixTiming,
  out: string
): Promise<void> {
  const inputs: string[] = [],
    chains: string[] = [],
    labels: string[] = [];
  timing.scenes.forEach((s, i) => {
    inputs.push("-i", join(work, "audio", `${s.id}.wav`));
    const ms = Math.round((s.start + script.lead) * 1000);
    chains.push(`[${i}:a]atempo=${script.speed},adelay=${ms}:all=1[n${i}]`);
    labels.push(`[n${i}]`);
  });
  const b = timing.scenes.length,
    total = timing.total,
    bgmIn = bgmFile(work);
  const loop = bgmLoop(bgmIn, b, await mediaSeconds(bgmIn), total, "bgmx");
  inputs.push(...loop.inputs);
  const fxFirst = b + loop.inputs.filter((a) => a === "-i").length;
  const sfx = timing.sfx ?? [];
  const fx = sfx.map((t, i) => {
    inputs.push("-i", t.file);
    return { chain: sfxChain(fxFirst + i, t, `s${i}`), label: `[s${i}]` };
  });
  const graph = [
    ...chains,
    `${labels.join("")}amix=inputs=${labels.length}:normalize=0,aresample=44100,pan=stereo|c0=c0|c1=c0,apad=whole_dur=${total}[nar]`, // full level on both sides (an automatic upmix drops mono speech by 3 dB)
    ...loop.chains,
    `[${loop.label}]atrim=0:${total},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${script.bgmVolume},afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, total - 3)}:d=3[bgm]`,
    ...fx.map((f) => f.chain),
    `[nar][bgm]${fx.map((f) => f.label).join("")}amix=inputs=${2 + fx.length}:normalize=0,alimiter=limit=0.95[out]`,
  ].join(";");
  await runFfmpeg([
    ...inputs,
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    "-t",
    String(total),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    out,
  ]);
}

// ffmpeg arguments that read PNG frames from stdin and mux them with the mixed audio into an MP4.
export function encodeArgs(fps: number, audio: string, out: string): string[] {
  return [
    ["-y", "-loglevel", "error"],
    ["-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-i", audio],
    ["-map", "0:v", "-map", "1:a"],
    ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "medium"],
    ["-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out],
  ].flat();
}
