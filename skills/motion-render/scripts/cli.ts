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
import { repeatIssues } from "./repeat.ts";
import { writeKit, writeKitTiming } from "./kit.ts";
import {
  narrate,
  bgm,
  bgmFile,
  mix,
  findFfmpeg,
  encodeArgs,
  pictureTime,
  exited,
  FFMPEG_MS,
} from "./audio.ts";
import { limit } from "./limit.ts";
import { loadScript, writeTiming, loadTiming, placeOnFilm, placeSfx, type Script } from "./work.ts";
import {
  runBeatBgm,
  runScore,
  runSync,
  scoreInput,
  syncPreview,
  syncReport,
  timingTable,
} from "./beatcli.ts";
import { checkSfx, makeSfx, narrationLevel, previewSfx, sfxTrack } from "./sfx.ts";
import { prepare } from "./store.ts";
import { errorMessage, field, readJson } from "./json.ts";
import { stepsTable, timed, workOf } from "./steps.ts";
import { mp4Picture, writeSheet } from "./sheet.ts";

const USAGE = `usage (one work dir per video; see SKILL.md for its layout):
  motion-render narrate <work>            Narrate every scene of <work>/script.json (Gemini TTS)
                                          and write the scene lengths to <work>/timing.json.
  motion-render bgm <work>                Make the BGM from script.json's "bgm" prompt (Lyria). With "bpm":
                                          four takes from <work>/score.txt, each shown bar by bar.
  motion-render score <work>              Beat-synced films: play script.json's "score" (a take and its
                                          bars) onto the film's bars (audio/score.wav) and write its drum
                                          hits for the film (audio/hits.json, kit/timing.js).
  motion-render sync <work> <mp4>         Beat-synced films: measure on the MP4 whether the narration runs
                                          on, the drops and the final hit change the picture on their
                                          frame, and the picture moves on the kicks in the drops.
  motion-render sheet <work> <mp4> [out.png]
                                          One contact sheet of the MP4's key moments for a review (the
                                          middle of each scene, around each drop, the final hit), with
                                          a .txt naming each tile. Default: <work>/sheet.png.
  motion-render sfx <work>                Make the scenes' sound effects (ElevenLabs) and write
                                          <work>/audio/sfx/preview.m4a to listen to them all in order.
  motion-render prepare <storeDir> <work>/film
                                          Expand a Motion film's store (ArtifactData out_dir) into a film dir.
  motion-render kit <work>                Set up <work>/film for an html film: player, fonts, GSAP and
                                          the scene times from timing.json (write film/index.html after).
  motion-render check <filmDir> [<scene file>...]
                                          Check an html film's layout every 0.1s: overlaps, things
                                          sticking out of their box or the frame, things hidden under others,
                                          and text too small or too faint to read. With scene files
                                          (names in <filmDir>/scenes), only those are put in and checked.
  motion-render stills <filmDir> <outDir> <t1,t2,...>
                                          Write PNG stills at the given seconds (and run check).
  motion-render preview <work> [out.png]  Before building: run check, draw the contact sheet and, for a
                                          beat-synced film, the sync report, from only the frames they
                                          read (no MP4). Default sheet: <work>/sheet.png.
  motion-render build <work> [out.mp4]    Mix narration + BGM + sound effects and render <work>/film to MP4.
                                          Stops if check finds a layout issue in an html film.
                                          Without out.mp4: $MOTION_RENDER_OUT_DIR or the current dir, <work name>.mp4.
  motion-render times <work>              Show how long each step of this video took, as a table
                                          (commands from <work>/steps.jsonl, and Claude's work between them).

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
// After the layout check, frames are compared with a new page to catch frames that change after
// seeking back (repeat.ts).
async function reportLayout(film: Film, dir: string, scenes: string[] = []): Promise<number> {
  const layout = await checkLayout(film);
  if (!layout) return 0;
  const issues = [...layout, ...(await repeatIssues(film, dir, scenes))];
  for (const i of issues) console.error(`layout: ${formatIssue(i)}`);
  console.error(issues.length ? `layout: ${issues.length} issues` : "layout: ok");
  return issues.length;
}

async function stills(filmDir: string, outDir: string, list: string): Promise<void> {
  const times = list.split(",").map(Number);
  if (times.some((t) => !Number.isFinite(t))) throw new Error(`times must be numbers: ${list}`);
  mkdirSync(outDir, { recursive: true });
  const film = await openFilm(filmDir, { pages: capturePages() });
  try {
    for (const t of times)
      writeFileSync(join(outDir, `t_${t.toFixed(2)}.png`), await film.frame(t));
    await reportLayout(film, filmDir);
    for (const w of await film.warnings()) console.error("runner", w);
  } finally {
    await film.close();
  }
  console.log(`done: ${times.length} stills in ${outDir}`);
}

async function check(filmDir: string, scenes: string[]): Promise<void> {
  if (!isHtmlFilm(filmDir))
    throw new Error("check works on html films only (Motion films draw in their own player)");
  const film = await openFilm(filmDir, { pages: capturePages(), scenes });
  let n: number;
  try {
    n = await reportLayout(film, filmDir, scenes);
    // Errors from the page's own code (a path built from NaN, a failed selector) draw nothing and
    // break no layout rule, so the layout check alone would pass them.
    for (const w of await film.warnings()) console.error("runner", w);
  } finally {
    await film.close();
  }
  const what = scenes.length ? `${filmDir} (${scenes.join(", ")})` : filmDir;
  if (n) throw new Error(`${n} layout issues in ${what}`);
  console.log(`layout ok: ${what}`);
}

function runKit(work: string): void {
  loadTiming(work);
  console.log(`kit: ${join(writeKit(work), "kit")} (write ${join(work, "film", "index.html")})`);
}

async function runNarrate(work: string): Promise<void> {
  const script = loadScript(work);
  await narrate(work, script);
  const timing = writeTiming(work, script);
  if (timing.bpm) console.log(timingTable(timing));
  else for (const s of timing.scenes) console.log(`${s.id}\tstart ${s.start}s\tdur ${s.dur}s`);
  console.log(`total: ${timing.total}s -> ${join(work, "timing.json")}`);
}

async function runBgm(work: string): Promise<void> {
  const script = loadScript(work);
  if (script.bpm) return runBeatBgm(work, script, script.bpm);
  const file = await bgm(work, script, loadTiming(work).total);
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
async function encode(
  film: Film,
  fps: number,
  audio: string,
  out: string,
  blur: number
): Promise<number> {
  const count = Math.round(film.meta.duration * fps);
  const args = encodeArgs(fps, audio, out, blur);
  const ff = spawn(findFfmpeg(), args, { stdio: ["pipe", "inherit", "inherit"] });
  const kill = () => ff.kill("SIGKILL");
  const exit = exited(ff);
  ff.stdin.on("error", () => {}); // EPIPE when ffmpeg dies early; its exit code reports the cause.
  const pictures = count * blur;
  const at = (i: number) => pictureTime(Math.floor(i / blur), i % blur, fps, blur);
  try {
    let i = 0;
    for await (const png of inOrder(pictures, film.pages, (p) =>
      film.frame(at(p), Math.floor(p / blur) / fps)
    )) {
      if (!ff.stdin.write(png))
        await limit(once(ff.stdin, "drain"), FRAME_MS, `ffmpeg taking picture ${i}`, kill);
      if (i % Math.max(1, Math.round(pictures / 10)) === 0)
        console.error(`frames: ${Math.floor(i / blur)}/${count}`);
      i++;
    }
  } finally {
    ff.stdin.end();
  }
  const code = await limit(exit, FFMPEG_MS, "ffmpeg finishing the MP4", kill);
  if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
  return count;
}

// The layout check (and the repeat check) of an html film, on pages of its own: they seek back and
// forth, and frames are captured on new pages that only go forward, as a viewer's player does.
async function checkBeforeCapture(filmDir: string): Promise<void> {
  if (!isHtmlFilm(filmDir)) return;
  const film = await openFilm(filmDir, { pages: capturePages() });
  try {
    if (await reportLayout(film, filmDir))
      throw new Error(
        `fix the layout issues above in ${join(filmDir, "index.html")}, then build again`
      );
  } finally {
    await film.close();
  }
}

function checkInputs(work: string, script: Script): void {
  const missing = loadTiming(work)
    .scenes.filter((s) => !existsSync(join(work, "audio", `${s.id}.wav`)))
    .map((s) => s.id);
  if (missing.length)
    throw new Error(
      `narration missing for: ${missing.join(", ")} (run "motion-render narrate ${work}")`
    );
  if (!script.bpm) bgmFile(work);
  checkSfx(work, script);
}

// Beat-synced films are drawn at 60 fps: at 30, a hit can land up to 33 ms off its frame.
async function build(work: string, out: string, fpsArg: number): Promise<void> {
  const script = loadScript(work);
  const timing = loadTiming(work);
  const fps = Number.isNaN(fpsArg) ? (script.bpm ? 60 : 30) : fpsArg;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("--fps must be a positive number");
  checkInputs(work, script);
  const filmDir = join(work, "film");
  checkFilmDir(filmDir);
  if (isHtmlFilm(filmDir)) writeKitTiming(work);
  await checkBeforeCapture(filmDir);

  const film = await openFilm(filmDir, { pages: capturePages() });
  console.error(`capture: ${film.pages} pages`);
  try {
    const warn = (w: string) => console.error(`warning: ${w}`);
    const scenes = placeOnFilm(timing, film.meta, script, warn);
    const narration = await narrationLevel(work, script);
    const sfx = placeSfx(script, film.meta.parts, warn).map((c) => sfxTrack(work, c, narration));
    const audio = join(work, "audio", "mix.m4a");
    const score = script.bpm ? scoreInput(work, script, narration) : undefined;
    await mix(
      work,
      script,
      { scenes, total: film.meta.duration, sfx, ...(score ? { score } : {}) },
      audio
    );
    mkdirSync(dirname(out), { recursive: true });
    const count = await encode(film, fps, audio, out, script.motionBlur);
    for (const w of await film.warnings()) console.error("runner", w);
    const extra = sfx.length ? ` + ${sfx.length} sound effects` : "";
    console.log(`done: ${out} (${film.meta.duration}s, ${count} frames, narration + BGM${extra})`);
  } finally {
    await film.close();
  }
  if (timing.bpm) await syncReport(work, script, timing, out);
}

interface Command {
  args: [number, number]; // fewest and most arguments
  run(args: string[], fps: number): Promise<void> | void;
}

function runBuild([a, b]: string[], fps: number): Promise<void> {
  const work = resolve(a!);
  const out = resolve(
    b ?? join(process.env.MOTION_RENDER_OUT_DIR || process.cwd(), `${basename(work)}.mp4`)
  );
  return build(work, out, fps);
}

function printSheet(file: string, names: string[]): void {
  for (const n of names) console.log(n);
  console.log(
    `sheet: ${file} (${names.length} frames; names in ${file.replace(/\.png$/, "")}.txt)`
  );
}

async function runSheet(work: string, mp4: string, out?: string): Promise<void> {
  const file = out ? resolve(out) : join(work, "sheet.png");
  printSheet(file, await writeSheet(mp4Picture(mp4), loadTiming(work), file));
}

// How long the build will spend drawing, from pictures spread over the film: a heavy page (a large
// shadow blur or pattern fill on every frame) shows here, before a build of many minutes.
const ENCODE_SHARE = 1.5;

async function buildEstimate(film: Film, fps: number, blur: number): Promise<string> {
  const n = 4 * film.pages,
    total = film.meta.duration;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: n }, (_, i) => film.frame(((i + 0.5) / n) * total)));
  const each = (performance.now() - t0) / n;
  const pictures = Math.round(total * fps) * blur;
  // During a build the encoder shares the CPU: capture took 1.4 to 1.75 times the pictures drawn
  // here alone (a 73 s flat film and an 84 s textured one, 2026-11-13).
  const min = (ENCODE_SHARE * each * pictures) / 60_000;
  return `build estimate: about ${min.toFixed(1)} min for ${pictures} pictures (${each.toFixed(0)} ms each drawn alone, ${film.pages} pages at once)`;
}

// What a review needs, before any build: the layout check, the contact sheet and, for a beat-synced
// film, the sync report, from only the frames they read (drawn by the film's pages). The film is then
// built once, after the review.
async function preview(work: string, out?: string): Promise<void> {
  const script = loadScript(work);
  const timing = loadTiming(work);
  const filmDir = join(work, "film");
  checkFilmDir(filmDir);
  if (isHtmlFilm(filmDir)) writeKitTiming(work);
  await checkBeforeCapture(filmDir);
  const film = await openFilm(filmDir, { pages: capturePages() });
  let problems: string[] = [];
  try {
    const file = out ? resolve(out) : join(work, "sheet.png");
    printSheet(file, await writeSheet((t) => film.frame(t), timing, file));
    console.log(await buildEstimate(film, script.bpm ? 60 : 30, script.motionBlur));
    if (timing.bpm) problems = await syncPreview(work, script, timing, film);
    for (const w of await film.warnings()) console.error("runner", w);
  } finally {
    await film.close();
  }
  if (problems.length)
    throw new Error(`${problems.length} sync problems: fix them, then preview again`);
}

const COMMANDS = new Map<string, Command>([
  ["narrate", { args: [1, 1], run: ([w]) => runNarrate(resolve(w!)) }],
  ["bgm", { args: [1, 1], run: ([w]) => runBgm(resolve(w!)) }],
  ["score", { args: [1, 1], run: ([w]) => runScore(resolve(w!)) }],
  ["sync", { args: [2, 2], run: ([w, m]) => runSync(resolve(w!), resolve(m!)) }],
  ["sfx", { args: [1, 1], run: ([w]) => runSfx(resolve(w!)) }],
  ["sheet", { args: [2, 3], run: ([w, m, o]) => runSheet(resolve(w!), resolve(m!), o) }],
  ["preview", { args: [1, 2], run: ([w, o]) => preview(resolve(w!), o) }],
  ["kit", { args: [1, 1], run: ([w]) => runKit(resolve(w!)) }],
  ["prepare", { args: [2, 2], run: ([s, f]) => runPrepare(s!, f!) }],
  ["stills", { args: [3, 3], run: ([f, o, t]) => stills(f!, o!, t!) }],
  ["check", { args: [1, Infinity], run: ([f, ...s]) => check(f!, s) }],
  ["build", { args: [1, 2], run: runBuild }],
  ["times", { args: [1, 1], run: ([w]) => console.log(stepsTable(resolve(w!))) }],
]);
// Commands whose time is logged in the work dir of their first argument (steps.ts). prepare writes
// to its second.
const LOGGED = new Set([
  "narrate",
  "bgm",
  "score",
  "sfx",
  "kit",
  "prepare",
  "stills",
  "check",
  "build",
  "preview",
]);

function version(): string {
  const v = field(readJson(fileURLToPath(new URL("../package.json", import.meta.url))), "version");
  return typeof v === "string" ? v : "unknown";
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fps: { type: "string" }, // build: 30, or 60 for a beat-synced film
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) return console.log(version());
  if (values.help || !cmd) return console.log(USAGE);
  const command = COMMANDS.get(cmd);
  const [fewest, most] = command?.args ?? [0, 0];
  if (!command || rest.length < fewest || rest.length > most || rest.some((a) => !a))
    die(`unknown command or wrong arguments\n\n${USAGE}`, 2);
  const target = cmd === "prepare" ? rest[1] : rest[0];
  const work = LOGGED.has(cmd) && target ? workOf(target) : null;
  return timed(work, cmd, () => command.run(rest, Number(values.fps)));
}

main().catch((e: unknown) => die(errorMessage(e)));
