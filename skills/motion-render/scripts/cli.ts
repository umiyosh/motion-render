#!/usr/bin/env node
// motion-render: テーマから作った動画（Claude Motion か html）に、ナレーションと BGM を付けて MP4 にする CLI。
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { openFilm, checkFilmDir, isHtmlFilm, capturePages, type Film } from "./render.ts";
import { inOrder } from "./inorder.ts";
import { checkLayout, formatIssue } from "./layout.ts";
import { writeKit, writeKitTiming } from "./kit.ts";
import { narrate, bgm, bgmFile, mix, findFfmpeg, encodeArgs, exited, FFMPEG_MS } from "./audio.ts";
import { limit } from "./limit.ts";
import { loadScript, writeTiming, loadTiming, placeOnFilm, placeSfx } from "./work.ts";
import { checkSfx, makeSfx, narrationLevel, previewSfx, sfxTrack } from "./sfx.ts";
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
  motion-render kit <work>                Set up <work>/film for an html film: player, fonts, GSAP and
                                          the scene times from timing.json (write film/index.html after).
  motion-render check <filmDir>           Check an html film's layout every 0.1s: overlaps, things
                                          sticking out of their box or the frame, things hidden under others,
                                          and text too small or too faint to read.
  motion-render stills <filmDir> <outDir> <t1,t2,...>
                                          Write PNG stills at the given seconds (and run check).
  motion-render build <work> [out.mp4]    Mix narration + BGM + sound effects and render <work>/film to MP4.
                                          Stops if check finds a layout issue in an html film.
                                          Without out.mp4: $MOTION_RENDER_OUT_DIR or the current dir, <work name>.mp4.

env:
  GEMINI_API_KEY         required by narrate and bgm
  ELEVENLABS_API_KEY     required by sfx
  MOTION_RENDER_OUT_DIR  default output directory for build
  CHROMIUM_PATH          use this Chrome/Chromium instead of the bundled one
  FFMPEG_PATH            use this ffmpeg instead of the bundled one
  MOTION_RENDER_PAGES    browsers that draw frames at once (default: half the cores, at most 8)`;

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

// Prints the layout issues and returns how many there are (0 for a Motion film, which is not checked).
async function reportLayout(film: Film): Promise<number> {
  const issues = await checkLayout(film);
  if (!issues) return 0;
  for (const i of issues) console.error(`layout: ${formatIssue(i)}`);
  console.error(issues.length ? `layout: ${issues.length} issues` : "layout: ok");
  return issues.length;
}

async function stills(filmDir: string, outDir: string, list: string): Promise<void> {
  const times = list.split(",").map(Number);
  if (times.some((t) => !Number.isFinite(t))) die(`times must be numbers: ${list}`);
  mkdirSync(outDir, { recursive: true });
  const film = await openFilm(filmDir, { pages: capturePages() });
  try {
    for (const t of times)
      writeFileSync(join(outDir, `t_${t.toFixed(2)}.png`), await film.frame(t));
    await reportLayout(film);
    for (const w of await film.warnings()) console.error("runner", w);
  } finally {
    await film.close();
  }
  console.log(`done: ${times.length} stills in ${outDir}`);
}

async function check(filmDir: string): Promise<void> {
  if (!isHtmlFilm(filmDir))
    die("check works on html films only (Motion films draw in their own player)");
  const film = await openFilm(filmDir, { pages: capturePages() });
  let n: number;
  try {
    n = await reportLayout(film);
  } finally {
    await film.close();
  }
  if (n) die(`${n} layout issues in ${filmDir}`);
  console.log(`layout ok: ${filmDir}`);
}

function runKit(work: string): void {
  loadTiming(work);
  console.log(`kit: ${join(writeKit(work), "kit")} (write ${join(work, "film", "index.html")})`);
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

// ffmpeg takes a frame in milliseconds. One that has not taken it after this is stuck.
const FRAME_MS = 60_000;

// Pipes rendered frames straight into ffmpeg (no temp files) and muxes the mixed audio. The whole
// encode runs as long as capture does, so the limits are per frame and for the final mux.
async function encode(film: Film, fps: number, audio: string, out: string): Promise<number> {
  const count = Math.round(film.meta.duration * fps);
  const args = encodeArgs(fps, audio, out);
  const ff = spawn(findFfmpeg(), args, { stdio: ["pipe", "inherit", "inherit"] });
  const kill = () => ff.kill("SIGKILL");
  const exit = exited(ff);
  ff.stdin.on("error", () => {}); // EPIPE when ffmpeg dies early; its exit code reports the cause.
  try {
    let i = 0;
    for await (const png of inOrder(count, film.pages, (k) => film.frame(k / fps))) {
      if (!ff.stdin.write(png))
        await limit(once(ff.stdin, "drain"), FRAME_MS, `ffmpeg taking frame ${i}`, kill);
      if (i % Math.max(1, Math.round(count / 10)) === 0) console.error(`frames: ${i}/${count}`);
      i++;
    }
  } finally {
    ff.stdin.end();
  }
  const code = await limit(exit, FFMPEG_MS, "ffmpeg finishing the MP4", kill);
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
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
  if (isHtmlFilm(filmDir)) writeKitTiming(work);

  const film = await openFilm(filmDir, { pages: capturePages() });
  console.error(`capture: ${film.pages} pages`);
  try {
    if (await reportLayout(film))
      throw new Error(
        `fix the layout issues above in ${join(filmDir, "index.html")}, then build again`
      );
    const warn = (w: string) => console.error(`warning: ${w}`);
    const scenes = placeOnFilm(timing, film.meta, script, warn);
    const narration = await narrationLevel(work, script);
    const sfx = placeSfx(script, film.meta.parts, warn).map((c) => sfxTrack(work, c, narration));
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

interface Command {
  args: number[]; // accepted argument counts
  run(args: string[], fps: number): Promise<void> | void;
}

function runBuild([a, b]: string[], fps: number): Promise<void> {
  const work = resolve(a!);
  const out = resolve(
    b ?? join(process.env.MOTION_RENDER_OUT_DIR || process.cwd(), `${basename(work)}.mp4`)
  );
  return build(work, out, fps);
}

const COMMANDS = new Map<string, Command>([
  ["narrate", { args: [1], run: ([w]) => runNarrate(resolve(w!)) }],
  ["bgm", { args: [1], run: ([w]) => runBgm(resolve(w!)) }],
  ["sfx", { args: [1], run: ([w]) => runSfx(resolve(w!)) }],
  ["kit", { args: [1], run: ([w]) => runKit(resolve(w!)) }],
  ["prepare", { args: [2], run: ([s, f]) => runPrepare(s!, f!) }],
  ["stills", { args: [3], run: ([f, o, t]) => stills(f!, o!, t!) }],
  ["check", { args: [1], run: ([f]) => check(f!) }],
  ["build", { args: [1, 2], run: runBuild }],
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
  if (values.version) return console.log(version());
  if (values.help || !cmd) return console.log(USAGE);
  const command = COMMANDS.get(cmd);
  if (!command || !command.args.includes(rest.length) || rest.some((a) => !a))
    die(`unknown command or wrong arguments\n\n${USAGE}`, 2);
  return command.run(rest, Number(values.fps));
}

main().catch((e: unknown) => die(errorMessage(e)));
