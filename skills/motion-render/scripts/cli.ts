#!/usr/bin/env node
// motion-render: テーマから作った Claude Motion の動画に、ナレーションと BGM を付けて MP4 にする CLI。
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { openFilm, checkFilmDir, type Film } from "./render.ts";
import { narrate, bgm, bgmFile, mix, findFfmpeg, encodeArgs } from "./audio.ts";
import { loadScript, writeTiming, loadTiming, placeOnFilm, placeSfx } from "./work.ts";
import { checkSfx, makeSfx, previewSfx, sfxTrack } from "./sfx.ts";
import { prepare } from "./store.ts";
import { errorMessage, field, readJson } from "./json.ts";

const USAGE = `usage (one work dir per video; see SKILL.md for its layout):
  motion-render narrate <work>            Narrate every scene of <work>/script.json (Gemini TTS)
                                          and write the scene lengths to <work>/timing.json.
  motion-render bgm <work>                Make the BGM from script.json's "bgm" prompt (Lyria).
  motion-render sfx <work>                Make the scenes' sound effects (ElevenLabs) and write
                                          <work>/audio/sfx/preview.m4a to listen to them all in order.
  motion-render prepare <storeDir> <work>/film
                                          Expand a Motion film's store (ArtifactData out_dir) into a film dir.
  motion-render stills <filmDir> <outDir> <t1,t2,...>
                                          Write PNG stills at the given seconds.
  motion-render build <work> [out.mp4]    Mix narration + BGM + sound effects and render <work>/film to MP4.
                                          Without out.mp4: $MOTION_RENDER_OUT_DIR or the current dir, <work name>.mp4.

env:
  GEMINI_API_KEY         required by narrate and bgm
  ELEVENLABS_API_KEY     required by sfx
  MOTION_RENDER_OUT_DIR  default output directory for build
  CHROMIUM_PATH          use this Chrome/Chromium instead of the bundled one
  FFMPEG_PATH            use this ffmpeg instead of the bundled one`;

function die(msg: string, code = 1): never {
  console.error(`motion-render: ${msg}`);
  process.exit(code);
}

function runPrepare(storeDir: string, filmDir: string): void {
  const { modules, blobs } = prepare(storeDir, filmDir);
  if (blobs.length)
    console.error(
      `warning: put these uploaded assets into ${join(filmDir, "assets")}: ${blobs.join(", ")}`
    );
  console.log(`modules: ${modules.join(", ")}`);
}

async function stills(filmDir: string, outDir: string, list: string): Promise<void> {
  const times = list.split(",").map(Number);
  if (times.some((t) => !Number.isFinite(t))) die(`times must be numbers: ${list}`);
  mkdirSync(outDir, { recursive: true });
  const film = await openFilm(filmDir);
  try {
    for (const t of times)
      writeFileSync(join(outDir, `t_${t.toFixed(2)}.png`), await film.frame(t));
    for (const w of await film.warnings()) console.error("runner", w);
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
  console.log(`total: ${timing.total}s -> ${join(work, "timing.json")}`);
}

async function runBgm(work: string): Promise<void> {
  const file = await bgm(work, loadScript(work), loadTiming(work).total);
  console.log(`bgm: ${file}`);
}

async function runSfx(work: string): Promise<void> {
  const script = loadScript(work);
  const made = await makeSfx(work, script);
  const preview = await previewSfx(work, script);
  if (!preview) {
    console.log("no sound effects in script.json");
    return;
  }
  for (const e of preview.list) console.log(`${e.offset}s\t${e.scene} +${e.at}s\t${e.prompt}`);
  console.log(`made ${made} new, listen to all of them: ${preview.file}`);
}

// Pipes rendered frames straight into ffmpeg (no temp files) and muxes the mixed audio.
async function encode(film: Film, fps: number, audio: string, out: string): Promise<number> {
  const count = Math.round(film.meta.duration * fps);
  const args = encodeArgs(fps, audio, out);
  const ff = spawn(findFfmpeg(), args, { stdio: ["pipe", "inherit", "inherit"] });
  const finished = new Promise<void>((ok, fail) => {
    ff.on("error", fail);
    ff.on("close", (code) =>
      code === 0 ? ok() : fail(new Error(`ffmpeg exited with code ${code}`))
    );
  });
  ff.stdin.on("error", () => {}); // EPIPE when ffmpeg dies early; its exit code reports the cause.
  try {
    for (let i = 0; i < count; i++) {
      if (!ff.stdin.write(await film.frame(i / fps))) await once(ff.stdin, "drain");
      if (i % Math.max(1, Math.round(count / 10)) === 0) console.error(`frames: ${i}/${count}`);
    }
  } finally {
    ff.stdin.end();
  }
  await finished;
  return count;
}

async function build(work: string, out: string, fps: number): Promise<void> {
  if (!Number.isFinite(fps) || fps <= 0) die("--fps must be a positive number");
  const script = loadScript(work);
  const timing = loadTiming(work);
  const missing = timing.scenes
    .filter((s) => !existsSync(join(work, "audio", `${s.id}.wav`)))
    .map((s) => s.id);
  if (missing.length)
    die(`narration missing for: ${missing.join(", ")} (run "motion-render narrate ${work}")`);
  bgmFile(work);
  checkSfx(work, script);
  const filmDir = join(work, "film");
  checkFilmDir(filmDir);

  const film = await openFilm(filmDir);
  try {
    const warn = (w: string) => console.error(`warning: ${w}`);
    const scenes = placeOnFilm(timing, film.meta, script, warn);
    const sfx = placeSfx(script, film.meta.parts, warn).map((c) => sfxTrack(work, c));
    const audio = join(work, "audio", "mix.m4a");
    await mix(work, script, { scenes, total: film.meta.duration, sfx }, audio);
    mkdirSync(dirname(out), { recursive: true });
    const count = await encode(film, fps, audio, out);
    for (const w of await film.warnings()) console.error("runner", w);
    const extra = sfx.length ? ` + ${sfx.length} sound effects` : "";
    console.log(`done: ${out} (${film.meta.duration}s, ${count} frames, narration + BGM${extra})`);
  } finally {
    await film.close();
  }
}

// Commands that take just the work dir.
const WORK_COMMANDS = new Map<string, (work: string) => Promise<void>>([
  ["narrate", runNarrate],
  ["bgm", runBgm],
  ["sfx", runSfx],
]);

function version(): string {
  const v = field(readJson(fileURLToPath(new URL("../package.json", import.meta.url))), "version");
  return typeof v === "string" ? v : "unknown";
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fps: { type: "string", default: "30" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) {
    console.log(version());
    return;
  }
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }
  const [a, b, c] = rest;
  const onWork = WORK_COMMANDS.get(cmd);
  if (onWork && a && rest.length === 1) return onWork(resolve(a));
  if (cmd === "prepare" && a && b && rest.length === 2) return runPrepare(a, b);
  if (cmd === "stills" && a && b && c && rest.length === 3) return stills(a, b, c);
  if (cmd === "build" && a && (rest.length === 1 || rest.length === 2)) {
    const work = resolve(a);
    const out = resolve(
      b ?? join(process.env.MOTION_RENDER_OUT_DIR || process.cwd(), `${basename(work)}.mp4`)
    );
    return build(work, out, Number(values.fps));
  }
  die(`unknown command or wrong arguments\n\n${USAGE}`, 2);
}

main().catch((e: unknown) => die(errorMessage(e)));
