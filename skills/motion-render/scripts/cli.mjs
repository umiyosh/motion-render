#!/usr/bin/env node
// motion-render: テーマから作った Claude Motion の動画に、ナレーションと BGM を付けて MP4 にする CLI。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { openFilm, checkFilmDir } from './render.mjs';
import { narrate, bgm, bgmFile, mix, findFfmpeg } from './audio.mjs';
import { loadScript, writeTiming, loadTiming } from './work.mjs';

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

const die = (msg, code = 1) => { console.error(`motion-render: ${msg}`); process.exit(code); };

function prepare(storeDir, filmDir) {
  const doc = (p) => { const d = JSON.parse(readFileSync(p, 'utf8')); return d.data ?? d; };
  const modsDir = join(storeDir, 'modules');
  const mods = existsSync(modsDir) ? readdirSync(modsDir).filter((n) => n.endsWith('.json')) : [];
  if (!mods.length) die(`no modules under ${modsDir}`);
  mkdirSync(join(filmDir, 'modules'), { recursive: true });
  for (const n of mods) writeFileSync(join(filmDir, 'modules', n.slice(0, -5)), doc(join(modsDir, n)).text);
  const script = join(storeDir, 'film', 'script.json');
  writeFileSync(join(filmDir, 'cut.js'), existsSync(script) ? doc(script).code : 'window.CUT = kit.scenes();');
  const assetsDir = join(storeDir, 'assets');
  const blobs = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((n) => n.endsWith('.json') && !String(doc(join(assetsDir, n)).ref).startsWith('data:')).map((n) => n.slice(0, -5))
    : [];
  if (blobs.length) console.error(`warning: put these uploaded assets into ${join(filmDir, 'assets')}: ${blobs.join(', ')}`);
  console.log(`modules: ${mods.map((n) => n.slice(0, -5)).join(', ')}`);
}

async function stills(filmDir, outDir, list) {
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

async function runNarrate(work) {
  const script = loadScript(work);
  await narrate(work, script);
  const timing = writeTiming(work, script);
  for (const s of timing.scenes) console.log(`${s.id}\tstart ${s.start}s\tdur ${s.dur}s`);
  console.log(`total: ${timing.total}s -> ${join(work, 'timing.json')}`);
}

async function runBgm(work) {
  const file = await bgm(work, loadScript(work), loadTiming(work).total);
  console.log(`bgm: ${file}`);
}

// Pipes rendered frames straight into ffmpeg (no temp files) and muxes the mixed audio.
async function encode(film, fps, audio, out) {
  const count = Math.round(film.meta.duration * fps);
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-i', audio,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out];
  const ff = spawn(findFfmpeg(), args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise((ok, fail) => {
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
function placeOnFilm(timing, meta, script) {
  const parts = new Map((meta.parts ?? []).map((p) => [p.key, p]));
  const unknown = timing.scenes.filter((s) => !parts.has(s.id)).map((s) => s.id);
  if (unknown.length) die(`these script.json scenes are not in the film: ${unknown.join(', ')} (scene ids must match)`);
  return timing.scenes.map((s) => {
    const p = parts.get(s.id);
    if (s.speech + script.lead > p.dur + 0.05) console.error(`warning: narration of "${s.id}" (${s.speech}s) runs past its scene (${p.dur}s)`);
    return { ...s, start: p.a0 };
  });
}

async function build(work, out, fps) {
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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { fps: { type: 'string', default: '30' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return;
  }
  if (values.help || !cmd) { console.log(USAGE); return; }
  if (cmd === 'narrate' && rest.length === 1) return runNarrate(resolve(rest[0]));
  if (cmd === 'bgm' && rest.length === 1) return runBgm(resolve(rest[0]));
  if (cmd === 'prepare' && rest.length === 2) return prepare(rest[0], rest[1]);
  if (cmd === 'stills' && rest.length === 3) return stills(rest[0], rest[1], rest[2]);
  if (cmd === 'build' && (rest.length === 1 || rest.length === 2)) {
    const work = resolve(rest[0]);
    const out = resolve(rest[1] ?? join(process.env.MOTION_RENDER_OUT_DIR || process.cwd(), `${basename(work)}.mp4`));
    return build(work, out, Number(values.fps));
  }
  die(`unknown command or wrong arguments\n\n${USAGE}`, 2);
}

main().catch((e) => die(e.message));
