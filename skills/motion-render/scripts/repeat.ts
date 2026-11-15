// Whether a frame of an html film depends on how the page got to it. GSAP remembers each tween's
// start values the first time it renders and goes back to them when the playhead moves back across
// it, so two tweens writing one property can leave a frame different after seeking back: a word
// that should be up is gone, a camera is still zoomed. stills and the layout check seek back and
// forth, so what they show would not be what build draws. Frames drawn on pages the layout check
// has run through (seeking back) are compared with the same frames drawn going forward on a new page.
import { spawnSync } from "node:child_process";
import { findFfmpeg } from "./audio.ts";
import { openFilm, type Film } from "./render.ts";
import type { LayoutIssue } from "./layout.ts";

const W = 480,
  H = 270;
// dB. Drawing the same frame twice differs by raster noise only (70 dB and up, measured); a missing
// word or a camera left zoomed reads 15-25 dB.
const MIN_PSNR = 40;
const SAMPLES = 12;

function gray(png: Buffer): Uint8Array {
  const r = spawnSync(
    findFfmpeg(),
    [
      "-v",
      "error",
      "-f",
      "png_pipe",
      "-i",
      "-",
      "-vf",
      `scale=${W}:${H},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { input: png, maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0)
    throw new Error(`ffmpeg could not read a frame: ${r.stderr.toString().trim()}`);
  return new Uint8Array(r.stdout);
}

export function psnr(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error("frames of different sizes");
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i]! - b[i]!) ** 2;
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255 * a.length) / se);
}

// The middle of every scene checked, thinned to SAMPLES, plus the quarter points of short films.
export function repeatTimes(film: Pick<Film, "meta" | "only">): number[] {
  const parts = film.only
    ? film.meta.parts.filter((p) => film.only?.includes(p.key))
    : film.meta.parts;
  const mids = parts.flatMap((p) =>
    (parts.length < 4 ? [0.25, 0.5, 0.75] : [0.5]).map((f) => p.a0 + p.dur * f)
  );
  const every = Math.max(1, Math.ceil(mids.length / SAMPLES));
  return mids.filter((_, i) => i % every === 0).map((t) => Math.round(t * 60) / 60);
}

// Frames that differ between `used` (pages that have seeked through the film) and a new page.
export async function repeatIssues(
  used: Film,
  dir: string,
  scenes: string[]
): Promise<LayoutIssue[]> {
  const times = repeatTimes(used);
  const back: Buffer[] = [];
  for (const t of [...times].reverse()) back.unshift(await used.frame(t));
  const fresh = await openFilm(dir, { pages: 1, scenes });
  try {
    const out: LayoutIssue[] = [];
    for (const [i, t] of times.entries()) {
      const p = psnr(gray(back[i]!), gray(await fresh.frame(t)));
      if (p < MIN_PSNR)
        out.push({
          kind: "repeat",
          from: t,
          to: t,
          message: `the frame changes after seeking back (PSNR ${p.toFixed(0)} dB): draw what moves from the time alone with film.draw, or keep one tween per property`,
        });
    }
    return out;
  } finally {
    await fresh.close();
  }
}
