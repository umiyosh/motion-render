#!/usr/bin/env node
// motion-render: テーマから作った Claude Motion の動画に、ナレーションと BGM を付けて MP4 にする CLI。
import { writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openFilm, checkFilmDir, type Film, type FilmMeta } from './render.ts';
import { narrate, bgm, bgmFile, mix, findFfmpeg } from './audio.ts';
import { loadScript, writeTiming, loadTiming, type Script, type Timing } from './work.ts';
import { errorMessage, field, readJson } from './json.ts';

const USAGE = `usage (one work dir per video; see SKILL.md for its layout):
  motion-render narrate <work>            Narrate every scene of <work>/script.json (Gemini TTS)
                                          and write the scene lengths to <work>/timing.json.
  motion-render bgm <work>                Make the BGM from script.json's "bgm" prompt (Lyria).
  motion-render prepare <storeDir> <work>/film
                                          Expand a Motion film's store (ArtifactData out_dir) into a film dir.
  motion-render stills <filmDir> <outDir> <t1,t2,...>
                                          Write PNG stills at the given seconds.
  motion-render build <work> [out.mp4]    Mix narration + BGM and render <work>/film to MP4.
                                          Without out.mp4: $MOTION_RENDER_OUT_DIR or the current dir, <work name>.mp4.

env:
  GEMINI_API_KEY         required by narrate and bgm
  MOTION_RENDER_OUT_DIR  default output directory for build
  CHROMIUM_PATH          use this Chrome/Chromium instead of the bundled one
  FFMPEG_PATH            use this ffmpeg instead of the bundled one`;

function die(msg: string, code = 1): never {
  console.error(`motion-render: ${msg}`);
  process.exit(code);
}

// A Motion store document is { data: {...} } or the bare object; returns the string field `key`.
function storeField(file: string, key: string): string | null {
  const d = readJson(file);
  const v = field(field(d, 'data') ?? d, key);
  return typeof v === 'string' ? v : null;
}

function prepare(storeDir: string, filmDir: string): void {
  const modsDir = join(storeDir, 'modules');
  const mods = existsSync(modsDir) ? readdirSync(modsDir).filter((n) => n.endsWith('.json')) : [];
  if (!mods.length) die(`no modules under ${modsDir}`);
  mkdirSync(join(filmDir, 'modules'), { recursive: true });
  for (const n of mods) {
    const file = join(modsDir, n);
    const text = storeField(file, 'text') ?? die(`${file} has no "text"`);
    writeFileSync(join(filmDir, 'modules', n.slice(0, -5)), text);
  }
  const script = join(storeDir, 'film', 'script.json');
  const cut = existsSync(script) ? (storeField(script, 'code') ?? die(`${script} has no "code"`)) : 'window.CUT = kit.scenes();';
  writeFileSync(join(filmDir, 'cut.js'), cut);
  const assetsDir = join(storeDir, 'assets');
  const blobs = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((n) => n.endsWith('.json') && !String(storeField(join(assetsDir, n), 'ref')).startsWith('data:')).map((n) => n.slice(0, -5))
    : [];
  if (blobs.length) console.error(`warning: put these uploaded assets into ${join(filmDir, 'assets')}: ${blobs.join(', ')}`);
  console.log(`modules: ${mods.map((n) => n.slice(0, -5)).join(', ')}`);
}

async function stills(filmDir: string, outDir: string, list: string): Promise<void> {
  const times = list.split(',').map(Number);
  if (times.some((t) => !Number.isFinite(t))) die(`times must be numbers: ${list}`);
  mkdirSync(outDir, { recursive: true });
  const film = await openFilm(filmDir);
  try {
    for (const t of times) writeFileSync(join(outDir, `t_${t.toFixed(2)}.png`), await film.frame(t));
    for (const w of await film.warnings()) console.error('runner', w);
  } finally {
    await film.close();
  }
  console.log(`done: ${times.length} stills in ${outDir}`);
}

async function runNarrate(work: string): Promise<void> {
  const script = loadScript(work);
  await narrate(work, script);
  const timing = writeTiming(work, script);
  for (const s of timing.scenes) console.log(`${s.id}\tstart ${s.start}s\tdur ${s.dur}s`);
  console.log(`total: ${timing.total}s -> ${join(work, 'timing.json')}`);
}

async function runBgm(work: string): Promise<void> {
  const file = await bgm(work, loadScript(work), loadTiming(work).total);
  console.log(`bgm: ${file}`);
}

// Pipes rendered frames straight into ffmpeg (no temp files) and muxes the mixed audio.
async function encode(film: Film, fps: number, audio: string, out: string): Promise<number> {
  const count = Math.round(film.meta.duration * fps);
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-i', audio,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out];
  const ff = spawn(findFfmpeg(), args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise<void>((ok, fail) => {
    ff.on('error', fail);
    ff.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with code ${code}`))));
  });
  ff.stdin.on('error', () => {}); // EPIPE when ffmpeg dies early; its exit code reports the cause.
  try {
    for (let i = 0; i < count; i++) {
      if (!ff.stdin.write(await film.frame(i / fps))) await once(ff.stdin, 'drain');
      if (i % Math.max(1, Math.round(count / 10)) === 0) console.error(`frames: ${i}/${count}`);
    }
  } finally {
    ff.stdin.end();
  }
  await finished;
  return count;
}

// Narration goes where each scene actually starts in the film (matched by scene id), so a film whose
// scene lengths differ from timing.json still stays in sync.
function placeOnFilm(timing: Timing, meta: FilmMeta, script: Script) {
  const parts = new Map(meta.parts.map((p) => [p.key, p]));
  const unknown = timing.scenes.filter((s) => !parts.has(s.id)).map((s) => s.id);
  if (unknown.length) die(`these script.json scenes are not in the film: ${unknown.join(', ')} (scene ids must match)`);
  return timing.scenes.map((s) => {
    const p = parts.get(s.id) ?? die(`scene "${s.id}" is not in the film`);
    if (s.speech + script.lead > p.dur + 0.05) console.error(`warning: narration of "${s.id}" (${s.speech}s) runs past its scene (${p.dur}s)`);
    return { ...s, start: p.a0 };
  });
}

async function build(work: string, out: string, fps: number): Promise<void> {
  if (!Number.isFinite(fps) || fps <= 0) die('--fps must be a positive number');
  const script = loadScript(work);
  const timing = loadTiming(work);
  const missing = timing.scenes.filter((s) => !existsSync(join(work, 'audio', `${s.id}.wav`))).map((s) => s.id);
  if (missing.length) die(`narration missing for: ${missing.join(', ')} (run "motion-render narrate ${work}")`);
  bgmFile(work);
  const filmDir = join(work, 'film');
  checkFilmDir(filmDir);

  const film = await openFilm(filmDir);
  try {
    const scenes = placeOnFilm(timing, film.meta, script);
    const audio = join(work, 'audio', 'mix.m4a');
    await mix(work, script, { scenes, total: film.meta.duration }, audio);
    mkdirSync(dirname(out), { recursive: true });
    const count = await encode(film, fps, audio, out);
    for (const w of await film.warnings()) console.error('runner', w);
    console.log(`done: ${out} (${film.meta.duration}s, ${count} frames, narration + BGM)`);
  } finally {
    await film.close();
  }
}

function version(): string {
  const v = field(readJson(fileURLToPath(new URL('../package.json', import.meta.url))), 'version');
  return typeof v === 'string' ? v : 'unknown';
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { fps: { type: 'string', default: '30' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) {
    console.log(version());
    return;
  }
  if (values.help || !cmd) { console.log(USAGE); return; }
  const [a, b, c] = rest;
  if (cmd === 'narrate' && a && rest.length === 1) return runNarrate(resolve(a));
  if (cmd === 'bgm' && a && rest.length === 1) return runBgm(resolve(a));
  if (cmd === 'prepare' && a && b && rest.length === 2) return prepare(a, b);
  if (cmd === 'stills' && a && b && c && rest.length === 3) return stills(a, b, c);
  if (cmd === 'build' && a && (rest.length === 1 || rest.length === 2)) {
    const work = resolve(a);
    const out = resolve(b ?? join(process.env.MOTION_RENDER_OUT_DIR || process.cwd(), `${basename(work)}.mp4`));
    return build(work, out, Number(values.fps));
  }
  die(`unknown command or wrong arguments\n\n${USAGE}`, 2);
}

main().catch((e: unknown) => die(errorMessage(e)));
