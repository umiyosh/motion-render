// The finishing layer of a film (#64): one look per drawing style over the whole picture, put on by
// ffmpeg at export, after the motion blur. A look is a tone that holds for the whole film, light
// leaking in from one edge at the head of each section, and a glow on the head of each drop. It is
// a function of the time alone, so the same time gives the same picture.
//
// It does not answer each kick: brightening the whole frame is kept for the big moments
// (html-film.md: the whole picture is for the drop's head, a stop and the final hit), and a frame
// that flashes on every kick would also pass sync's test of the film reacting to the kicks.
//
// It works on the YUV picture x264 takes anyway, and costs little per frame: ffmpeg 6 runs its
// filters on one thread between decoding and x264, so their time adds to the build. Measured on a
// 30 s film of 1800 frames at 1080p (export alone 6.2 s): ffmpeg's colorbalance (6 s) gave way to
// a table on Y, U and V (lutyuv, 0.3 s), and a leak drawn for every frame (8 s) to a short clip per
// section head. Every pass over the whole frame that varies across it cost 3.5 to 7.5 s (a
// vignette, by ffmpeg's filter, a multiply or an overlay; a grain, which also made x264 5 to 8
// times slower), so a look has none: the styles draw their ground and its texture (styles.css).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffmpegSync } from "./audio.ts";
import type { Timing } from "./work.ts";

export const LOOKS = ["flat", "paper", "crayon", "blueprint", "collage", "whiteboard"] as const;
export type LookName = (typeof LOOKS)[number];

export function isLook(v: unknown): v is LookName {
  return typeof v === "string" && (LOOKS as readonly string[]).includes(v);
}

interface Look {
  contrast: number; // of Y about the middle grey
  u: number; // shift of U (Cb): more is bluer, less is yellower
  v: number; // shift of V (Cr): more is redder, less is greener
  leak: string; // colour of the light that leaks in at a section's head, RRGGBB
}

// Every look is plain to see beside the film without it: at a third of these values (contrast 1.04,
// shifts of 3), a leak of 0.22 and a glow of +0.06, the owner could hardly tell the two apart
// (2026-11-15). The dark flat style, the blueprint and the whiteboard lean cool; paper, crayon and
// collage warm.
const PRESETS: Record<LookName, Look> = {
  flat: { contrast: 1.12, u: 9, v: -3, leak: "4fd1c5" },
  paper: { contrast: 1.06, u: -9, v: 6, leak: "ffb347" },
  crayon: { contrast: 1.09, u: -12, v: 9, leak: "ff8a5c" },
  blueprint: { contrast: 1.09, u: 12, v: -6, leak: "9fd8ff" },
  collage: { contrast: 1.15, u: -9, v: 6, leak: "ffc070" },
  whiteboard: { contrast: 1.09, u: 3, v: 0, leak: "8ecbff" },
};

const FRAME = { w: 1920, h: 1080 };
const LEAK = { peak: 0.45, reach: 0.9, rise: 0.4, fall: 1.2 };
const GLOW = { brightness: 0.15, saturation: 0.5, fall: 0.6 };

// The heads of the sections that get a leak (every section but a drop) and of the drops, in s.
export function lookTimes(timing: Timing): { leaks: number[]; drops: number[] } {
  const heads = timing.scenes.filter((s) => s.section);
  return {
    leaks: heads.filter((s) => s.section !== "drop").map((s) => s.start),
    drops: heads.filter((s) => s.section === "drop").map((s) => s.start),
  };
}

const n = (v: number): string => v.toFixed(3);

// The leak's light, drawn once into a new temp dir: its colour, with its fall-off from the left
// edge in the alpha. Every leak of the film reuses it.
export function lookImage(name: LookName): string {
  const p = PRESETS[name];
  const leak = join(mkdtempSync(join(tmpdir(), "mr-look-")), "leak.png");
  // The fall-off spans under 60 levels of alpha over 1300 px, which showed as bands: a fixed dither
  // of one level breaks them (drawn once, so it costs nothing per frame).
  const alpha = `clip(255*${LEAK.peak}*max(0,1-X/(W*${LEAK.reach}))+2*random(1)-1,0,255)`;
  ffmpegSync(
    ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${p.leak}:s=${FRAME.w}x${FRAME.h}:d=1`]
      .concat(["-vf", `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'`])
      .concat(["-frames:v", "1", leak]),
    "draw the light leak of the look"
  );
  return leak;
}

// 0 before t0, 1 at t0, back to 0 over `fall` s: the glow of a drop.
function decay(t0: number, fall: number): string {
  return `between(t,${n(t0)},${n(t0 + fall)})*(1-(t-${n(t0)})/${n(fall)})`;
}

// A look for one film: its name, the film's timing and frame rate, the leak's light (lookImage),
// and the film time of the first frame (a still taken at that time; a build starts at 0).
export interface LookSpec {
  name: LookName;
  timing: Timing;
  fps: number;
  leak: string;
  offset?: number;
}

// The filtergraph that takes the picture labelled `input` to `output`.
export function lookGraph(
  { name, timing, fps, leak, offset = 0 }: LookSpec,
  input: string,
  output: string
): string {
  const p = PRESETS[name];
  const { leaks, drops } = lookTimes(timing);
  const start = offset ? `setpts=PTS+${n(offset)}/TB,` : "";
  const tone = `lutyuv=y='clip(${p.contrast}*(val-128)+128,0,255)':u='clip(val+${p.u},16,240)':v='clip(val+${p.v},16,240)'`;
  const parts = [`[${input}]${start}format=yuv420p,${tone}[look_0]`];
  // One short clip of the leak's light per section head, faded in and out, laid over only while it
  // shows: the frames between leaks pass through untouched.
  const span = LEAK.rise + LEAK.fall,
    frames = Math.ceil(span * fps);
  leaks.forEach((s, i) => {
    parts.push(
      `movie='${leak}',loop=loop=${frames}:size=1,setpts=N/${fps}/TB+${n(s)}/TB,` +
        `fade=t=in:st=${n(s)}:d=${LEAK.rise}:alpha=1,fade=t=out:st=${n(s + LEAK.rise)}:d=${LEAK.fall}:alpha=1[look_l${i}]`,
      `[look_${i}][look_l${i}]overlay=eof_action=pass:format=yuv420:enable='between(t,${n(s)},${n(s + span)})'[look_${i + 1}]`
    );
  });
  const glow = drops.map((d) => decay(d, GLOW.fall)).join("+");
  const eq = drops.length
    ? `eq=brightness='${GLOW.brightness}*(${glow})':saturation='1+${GLOW.saturation}*(${glow})':eval=frame`
    : "null";
  parts.push(`[look_${leaks.length}]${eq}[${output}]`);
  return parts.join(";");
}
