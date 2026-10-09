// ナレーション（Gemini TTS）と BGM（Lyria）を作り、ffmpeg で 1 本の音声に合成する。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 90_000; // a TTS request once hung for 15 minutes without this
const RETRIES = 3;

// ffmpeg-static downloads its binary in a postinstall script, which Claude Code's plugin dependency
// install does not run: fetch it on first use instead.
function bundledFfmpeg() {
  const require = createRequire(import.meta.url);
  let bin;
  try {
    bin = require('ffmpeg-static');
  } catch {
    return null; // package not installed
  }
  if (bin && existsSync(bin)) return bin;
  const installer = join(dirname(require.resolve('ffmpeg-static')), 'install.js');
  if (!existsSync(installer)) return null;
  console.error('motion-render: downloading ffmpeg (first run only)...');
  spawnSync(process.execPath, [installer], { stdio: ['ignore', 'inherit', 'inherit'], cwd: dirname(installer) });
  return bin && existsSync(bin) ? bin : null;
}

export function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const bundled = bundledFfmpeg();
  if (bundled) return bundled;
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
  throw new Error('ffmpeg not found: install ffmpeg or set FFMPEG_PATH');
}

export function runFfmpeg(args) {
  return new Promise((ok, fail) => {
    const ff = spawn(findFfmpeg(), ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('error', fail);
    ff.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with code ${code}`))));
  });
}

// Calls Gemini generateContent and returns the first inline audio part: { mimeType, data: Buffer }.
async function generateAudio(model, body) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set (needed for narration and BGM)');
  let last;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(`${API}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${json.error?.message ?? ''}`.trim());
      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
      if (!part) throw new Error(`${model}: no audio in the response`);
      return { mimeType: part.inlineData.mimeType, data: Buffer.from(part.inlineData.data, 'base64') };
    } catch (e) {
      last = e;
      console.error(`motion-render: ${model} attempt ${attempt}/${RETRIES} failed: ${e.message}`);
    }
  }
  throw last;
}

// Gemini TTS returns WAV, or raw 16-bit PCM ("audio/L16;rate=24000") on some models: always store WAV.
function toWav({ mimeType, data }) {
  if (data.subarray(0, 4).toString() === 'RIFF') return data;
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function wavSeconds(file) {
  const b = readFileSync(file);
  let rate = 0, align = 0, size = 0;
  for (let o = 12; o + 8 <= b.length; o += 8 + b.readUInt32LE(o + 4)) {
    const id = b.toString('ascii', o, o + 4);
    if (id === 'fmt ') { rate = b.readUInt32LE(o + 12); align = b.readUInt16LE(o + 20); }
    if (id === 'data') { size = Math.min(b.readUInt32LE(o + 4), b.length - o - 8); break; }
  }
  if (!rate || !align) throw new Error(`${file}: not a PCM WAV file`);
  return size / (rate * align);
}

// Writes audio/<scene id>.wav for each scene. A scene is regenerated only when its narration text changed.
export async function narrate(work, script) {
  const dir = join(work, 'audio');
  mkdirSync(dir, { recursive: true });
  for (const s of script.scenes) {
    const wav = join(dir, `${s.id}.wav`), txt = join(dir, `${s.id}.txt`);
    if (existsSync(wav) && existsSync(txt) && readFileSync(txt, 'utf8') === s.narration) continue;
    console.error(`narration: ${s.id}`);
    const audio = await generateAudio(script.ttsModel, {
      contents: [{ parts: [{ text: s.narration }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: script.voice } } } },
    });
    writeFileSync(wav, toWav(audio));
    writeFileSync(txt, s.narration);
  }
}

// Writes audio/bgm.<ext> from the script's BGM prompt, asking for a little more than the film's length.
export async function bgm(work, script, seconds) {
  const dir = join(work, 'audio');
  mkdirSync(dir, { recursive: true });
  const prompt = `${script.bgm}\n\nInstrumental only, no vocals. About ${Math.ceil(seconds) + 10} seconds long. Keep a steady level so it can sit under a voice-over.`;
  const audio = await generateAudio(script.bgmModel, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['AUDIO'] } });
  const ext = /wav/.test(audio.mimeType) ? 'wav' : 'mp3';
  const file = join(dir, `bgm.${ext}`);
  writeFileSync(file, audio.data);
  writeFileSync(join(dir, 'bgm.json'), JSON.stringify({ file: `bgm.${ext}`, prompt }, null, 2));
  return file;
}

export function bgmFile(work) {
  const meta = join(work, 'audio', 'bgm.json');
  if (!existsSync(meta)) throw new Error(`no BGM yet: run "motion-render bgm ${work}"`);
  return join(work, 'audio', JSON.parse(readFileSync(meta, 'utf8')).file);
}

// Narration at each scene's start + lead, BGM at a constant level underneath (ducking made it pump).
export async function mix(work, script, timing, out) {
  const inputs = [], chains = [], labels = [];
  timing.scenes.forEach((s, i) => {
    inputs.push('-i', join(work, 'audio', `${s.id}.wav`));
    const ms = Math.round((s.start + script.lead) * 1000);
    chains.push(`[${i}:a]atempo=${script.speed},adelay=${ms}:all=1[n${i}]`);
    labels.push(`[n${i}]`);
  });
  const b = timing.scenes.length, total = timing.total;
  inputs.push('-stream_loop', '-1', '-i', bgmFile(work));
  const graph = [
    ...chains,
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0,aresample=44100,pan=stereo|c0=c0|c1=c0,apad=whole_dur=${total}[nar]`, // full level on both sides (an automatic upmix drops mono speech by 3 dB)
    `[${b}:a]atrim=0:${total},asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=${script.bgmVolume},afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, total - 3)}:d=3[bgm]`,
    '[nar][bgm]amix=inputs=2:normalize=0,alimiter=limit=0.95[out]',
  ].join(';');
  await runFfmpeg([...inputs, '-filter_complex', graph, '-map', '[out]', '-t', String(total), '-c:a', 'aac', '-b:a', '192k', out]);
}
