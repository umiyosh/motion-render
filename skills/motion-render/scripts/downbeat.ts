// A second opinion on where a take's bars start (#67), from machine learning: Beat This! (Foscarin,
// Schlüter and Widmer, "Beat this! Accurate beat tracking without DBN postprocessing", ISMIR 2024;
// CPJKU, code and weights under the MIT licence), its final0 model exported to ONNX
// (huggingface.co/musetric/beat-this-onnx), run with onnxruntime-node when that is installed. Without
// it nothing here runs and the steps go on as before. The model (190 MB) is fetched on first use and
// checked against its SHA-256.
//
// The input follows the published preprocessing: 22.05 kHz mono; an STFT of 1024 points every 441
// samples (50 frames a second) with a periodic Hann window, centred with reflect padding; the
// magnitude over sqrt(1024), on 128 mel bands (the filterbank shipped with the export), then
// log(1 + 1000 x). It is fed 1500 frames (30 s) at a time, overlapping by 6 frames at each inner edge,
// and the frames of the first window that holds them inside its edges are kept. A beat or downbeat is
// a frame whose logit is above 0 and the highest within 3 frames ("minimal" postprocessing: no DBN,
// and no madmom, whose DBN is patented and not for commercial use). Each downbeat moves to its
// nearest beat.
//
// On 22 takes of earlier films, 11 put their downbeats on another beat of our bars than the first,
// and in the 5 whose bar start we had on a snare (a backbeat), it moved the start to the kick.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { ffmpegSync } from "./audio.ts";
import { isRecord } from "./json.ts";

const MODEL = {
  base: "https://huggingface.co/musetric/beat-this-onnx/resolve/25308706dda545c0d5950065bb0604ad71bcf1f5",
  files: {
    "beat_this.onnx": "1337dc6c21257ed6b803418efc320df42b5d8eb296ef16648ef60457cd4b9e55",
    "mel-filterbank.bin": "1ee975d96f44ccf2c3bfe37825c1c1f0b089f5703c7a12a84b1f0a3bce004533",
  },
};
const RATE = 22050,
  N = 1024,
  HOP = 441,
  BINS = N / 2 + 1,
  MELS = 128,
  FPS = RATE / HOP,
  CHUNK = 1500,
  BORDER = 6;

// The part of onnxruntime-node used here, checked when it is loaded (it is an optional dependency).
interface Tensor {
  data: ArrayLike<number>;
}
interface Session {
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
}
export interface Ort {
  InferenceSession: {
    create(path: string, options?: { logSeverityLevel?: number }): Promise<Session>;
  };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
}
function isOrt(v: unknown): v is Ort {
  if (!isRecord(v) || typeof v.Tensor !== "function") return false;
  // InferenceSession is a class: create is a static method of a function
  const s: unknown = v.InferenceSession;
  return typeof s === "function" && "create" in s && typeof s.create === "function";
}

// onnxruntime-node, or null when it is not installed.
export function loadOrt(): Ort | null {
  try {
    const m: unknown = createRequire(import.meta.url)("onnxruntime-node");
    return isOrt(m) ? m : null;
  } catch {
    return null; // not installed: the check is skipped
  }
}

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return process.env.MOTION_RENDER_CACHE || join(base, "motion-render", "beat-this");
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

// A file of the model in the cache, fetched and checked the first time.
async function modelFile(name: keyof typeof MODEL.files): Promise<string> {
  const dir = cacheDir(),
    file = join(dir, name),
    want = MODEL.files[name];
  if (existsSync(file) && sha256(readFileSync(file)) === want) return file;
  mkdirSync(dir, { recursive: true });
  console.error(`downbeat: fetching ${name} of Beat This! into ${dir} (first use only)`);
  const res = await fetch(`${MODEL.base}/${name}`, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`could not fetch ${name}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (sha256(body) !== want) throw new Error(`${name} came back with another SHA-256`);
  writeFileSync(`${file}.part`, body);
  renameSync(`${file}.part`, file);
  return file;
}

// The take as the film plays it (its tempo lock), 22.05 kHz mono.
function decode(file: string, filter: string): Float32Array {
  const out = ffmpegSync(
    ["-v", "error", "-i", file, "-af", filter, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"],
    `decode ${file} for Beat This!`,
    { maxBuffer: 1 << 30 }
  );
  return new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
}

// In-place radix-2 FFT of N points.
const COS = Float64Array.from({ length: N / 2 }, (_, k) => Math.cos((-2 * Math.PI * k) / N));
const SIN = Float64Array.from({ length: N / 2 }, (_, k) => Math.sin((-2 * Math.PI * k) / N));
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= N; len <<= 1)
    for (let i = 0, step = N / len; i < N; i += len)
      for (let k = 0; k < len / 2; k++) {
        const a = i + k,
          b = a + len / 2,
          wr = COS[k * step]!,
          wi = SIN[k * step]!;
        const tr = re[b]! * wr - im[b]! * wi,
          ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
}

// The log-mel spectrogram the model takes: frames x 128, row by row. `fb` is the 513 x 128
// filterbank.
export function spectrogram(
  x: Float32Array,
  fb: Float32Array
): { data: Float32Array; frames: number } {
  const frames = 1 + Math.floor(x.length / HOP),
    data = new Float32Array(frames * MELS);
  const at = (i: number): number =>
    i < 0 ? (x[-i] ?? 0) : i >= x.length ? (x[2 * x.length - 2 - i] ?? 0) : x[i]!;
  const re = new Float64Array(N),
    im = new Float64Array(N),
    mag = new Float64Array(BINS);
  for (let f = 0; f < frames; f++) {
    for (let n = 0; n < N; n++) {
      re[n] = at(f * HOP + n - N / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N));
      im[n] = 0;
    }
    fft(re, im);
    for (let k = 0; k < BINS; k++) mag[k] = Math.hypot(re[k]!, im[k]!) / Math.sqrt(N);
    for (let m = 0; m < MELS; m++) {
      let s = 0;
      for (let k = 0; k < BINS; k++) s += mag[k]! * fb[k * MELS + m]!;
      data[f * MELS + m] = Math.log1p(1000 * s);
    }
  }
  return { data, frames };
}

export type Logits = { beat: Float32Array; downbeat: Float32Array };

// The logits of every frame, from windows of CHUNK frames run through `run`.
export async function inWindows(
  spect: { data: Float32Array; frames: number },
  run: (window: Float32Array) => Promise<Logits>
): Promise<Logits> {
  const { data, frames } = spect;
  const beat = new Float32Array(frames),
    downbeat = new Float32Array(frames),
    kept = new Uint8Array(frames);
  for (let start = 0; ; start += CHUNK - 2 * BORDER) {
    const w = new Float32Array(CHUNK * MELS);
    w.set(data.subarray(start * MELS, Math.min(frames, start + CHUNK) * MELS));
    const out = await run(w);
    const last = start + CHUNK >= frames;
    for (let i = 0; i < CHUNK && start + i < frames; i++) {
      const inside = (start === 0 || i >= BORDER) && (last || i < CHUNK - BORDER);
      if (!inside || kept[start + i]) continue;
      kept[start + i] = 1;
      beat[start + i] = out.beat[i]!;
      downbeat[start + i] = out.downbeat[i]!;
    }
    if (last) return { beat, downbeat };
  }
}

// Seconds of the frames whose logit is above 0 and the highest within 3 frames; of two such frames
// side by side, the first.
export function peaks(v: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (!(v[i]! > 0)) continue;
    let top = true;
    for (let k = Math.max(0, i - 3); k <= Math.min(v.length - 1, i + 3); k++)
      if (v[k]! > v[i]!) top = false;
    if (top && !(out.length && i - Math.round(out[out.length - 1]! * FPS) <= 1)) out.push(i / FPS);
  }
  return out;
}

// Which beat of our bars the downbeats fall on: the bars start at t0, a beat lasts `beat` s.
export interface Verdict {
  beat: number; // 1-4: the beat of our bars most downbeats fall on
  share: number; // of the downbeats, on that beat
  n: number; // downbeats
}
export function beatOfBar(downbeats: number[], t0: number, beat: number): Verdict {
  const votes = [0, 0, 0, 0];
  for (const d of downbeats) votes[((Math.round((d - t0) / beat) % 4) + 4) % 4]!++;
  const most = Math.max(...votes),
    n = downbeats.length;
  return { beat: votes.indexOf(most) + 1, share: n ? most / n : 0, n };
}

// The line bgm and score print for a take whose bar starts the model disagrees with, or null. A
// warning only: our bars stay as they are.
export function downbeatLine(take: number, v: Verdict): string | null {
  if (v.n < 8 || v.share < 0.6 || v.beat === 1) return null;
  return `downbeat: take ${take} disagrees (ml says beat ${v.beat}: ${Math.round(100 * v.share)}% of its ${v.n} downbeats fall on beat ${v.beat} of these bars)`;
}

export interface TakeAudio {
  take: number;
  file: string; // the take's audio
  filter: string; // ffmpeg filter that locks it to the film's tempo
  t0: number; // start of its bar 0, after the lock
  beat: number; // s per beat after the lock
}

// The model's verdict on each take, or null when onnxruntime-node is not installed.
export async function checkTakes(
  takes: TakeAudio[],
  ort = loadOrt()
): Promise<Map<number, Verdict> | null> {
  if (!ort) return null;
  const fb = readFileSync(await modelFile("mel-filterbank.bin"));
  const filterbank = new Float32Array(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.length));
  // Errors only: the export carries unused initializers, and onnxruntime warns of each.
  const session = await ort.InferenceSession.create(await modelFile("beat_this.onnx"), {
    logSeverityLevel: 3,
  });
  const run = async (w: Float32Array): Promise<Logits> => {
    const out = await session.run({ spect: new ort.Tensor("float32", w, [1, CHUNK, MELS]) });
    const { beat, downbeat } = out;
    if (!beat || !downbeat) throw new Error("Beat This! gave no beat or downbeat output");
    return { beat: Float32Array.from(beat.data), downbeat: Float32Array.from(downbeat.data) };
  };
  const verdicts = new Map<number, Verdict>();
  for (const t of takes) {
    const logits = await inWindows(spectrogram(decode(t.file, t.filter), filterbank), run);
    const beats = peaks(logits.beat);
    const downs = peaks(logits.downbeat).map((d) =>
      beats.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a), d)
    );
    verdicts.set(t.take, beatOfBar(downs, t.t0, t.beat));
  }
  return verdicts;
}
