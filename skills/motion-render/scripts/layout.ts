// Layout check of an html film: samples the page through the film and reports what a viewer would
// see as a mistake: two things partly on top of each other, something sticking out of the box it
// sits in or out of the frame, something hidden under another thing, and text too small or too
// faint to read.
// Only what stays still is reported, so a chip passing over a card on its way is not a mistake.
import type { Film } from "./render.ts";
import { isRecord } from "./json.ts";
import { inOrder } from "./inorder.ts";

// A thing that paints on screen at one moment (snapshot.js). Coordinates are CSS px in the frame.
export interface LayoutBox {
  key: number; // stable across samples: its index among the page's elements
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cut: boolean; // part of it lies outside the frame
  anc: number[]; // keys of the painted boxes it sits inside in the DOM, nearest first
  ok: boolean; // data-layout-ok on it or an ancestor: the overlap is intended
  under: number | null; // key of a solid box drawn over most of it, if any
  text: BoxText | null; // its own text, if it has any
}

interface BoxText {
  px: number; // font size as drawn, after transforms
  contrast: number | null; // WCAG ratio over its background; null when faded or not measurable
  chars?: number; // characters of its own text, spaces left out
}

export interface LayoutSample {
  t: number;
  boxes: LayoutBox[];
}

export interface LayoutIssue {
  kind: "overlap" | "outside" | "frame" | "hidden" | "small" | "faint" | "brief" | "repeat";
  from: number;
  to: number;
  message: string;
}

const SLACK = 2; // px of overlap that reads as touching, not overlapping
// px a box may shift between samples and still count as still. A slow push-in or a breathing card
// moves 1-2 px per sample and is still to the eye; a chip on its way moves tens of px.
const MOVED = 3;

// Text on a 1080p frame. Below MIN_PX it is hard to read on a phone. Contrast follows WCAG: 4.5:1
// for body text, 3:1 for large text (headings and big numbers, LARGE_PX and up).
const MIN_PX = 24;
const LARGE_PX = 40;

type Rect = Pick<LayoutBox, "x" | "y" | "w" | "h">;

function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > SLACK && h > SLACK;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - SLACK &&
    inner.y >= outer.y - SLACK &&
    inner.x + inner.w <= outer.x + outer.w + SLACK &&
    inner.y + inner.h <= outer.y + outer.h + SLACK
  );
}

function still(a: Rect, b: Rect | undefined): boolean {
  if (!b) return false;
  const d = [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h];
  return d.every((v) => Math.abs(v) <= MOVED);
}

interface Finding {
  id: string;
  kind: LayoutIssue["kind"];
  message: string;
}

function textFindings(b: LayoutBox): Finding[] {
  const out: Finding[] = [];
  if (!b.text) return out;
  const { px, contrast } = b.text;
  if (px < MIN_PX)
    out.push({
      id: `small:${b.key}`,
      kind: "small",
      message: `${b.label} is ${px}px, smaller than ${MIN_PX}px`,
    });
  const need = px >= LARGE_PX ? 3 : 4.5;
  if (contrast !== null && contrast < need)
    out.push({
      id: `faint:${b.key}`,
      kind: "faint",
      message: `${b.label} has contrast ${contrast.toFixed(1)}:1, needs ${need}:1`,
    });
  return out;
}

// What is wrong with one still box on its own: cut by the frame, out of its box, or hidden.
function boxFindings(b: LayoutBox, byKey: Map<number, LayoutBox>, quiet: Set<number>): Finding[] {
  const out: Finding[] = [];
  if (b.cut)
    out.push({
      id: `frame:${b.key}`,
      kind: "frame",
      message: `${b.label} is cut off by the frame`,
    });
  out.push(...textFindings(b));
  if (b.ok) return out;
  const parent = byKey.get(b.anc[0] ?? -1);
  if (parent && !contains(parent, b))
    out.push({
      id: `outside:${b.key}`,
      kind: "outside",
      message: `${b.label} sticks out of ${parent.label}`,
    });
  // Something resting inside b (a chip on a card) is on top of it, not hiding it.
  const over = b.under === null ? undefined : byKey.get(b.under);
  if (over && quiet.has(over.key) && !contains(b, over))
    out.push({
      id: `hidden:${b.key}:${over.key}`,
      kind: "hidden",
      message: `${b.label} is hidden under ${over.label}`,
    });
  return out;
}

// Two still boxes, neither inside the other in the DOM, partly on top of each other. A pair where
// one is drawn over the other is reported as hidden instead.
function pairOverlaps(a: LayoutBox, b: LayoutBox): boolean {
  if (a.ok || b.ok || a.anc.includes(b.key) || b.anc.includes(a.key)) return false;
  if (a.under === b.key || b.under === a.key) return false;
  return overlaps(a, b) && !contains(a, b) && !contains(b, a);
}

function findingsAt(boxes: LayoutBox[], prev: Map<number, LayoutBox>): Finding[] {
  const quiet = boxes.filter((b) => still(b, prev.get(b.key)));
  const keys = new Set(quiet.map((b) => b.key));
  const byKey = new Map(boxes.map((b) => [b.key, b]));
  const out = quiet.flatMap((b) => boxFindings(b, byKey, keys));
  quiet.forEach((a, i) => {
    for (const b of quiet.slice(i + 1))
      if (pairOverlaps(a, b))
        out.push({
          id: `overlap:${a.key}:${b.key}`,
          kind: "overlap",
          message: `${a.label} and ${b.label} partly overlap`,
        });
  });
  return out;
}

interface Seen extends LayoutIssue {
  last: number; // index of the last sample it was seen in
  run: number; // samples in a row up to `last`
  best: number; // longest run
}

// Big text (headings, big numbers, words that land on a hit) has to stay long enough to read:
// 2 s, and 1 s per 4 characters. A viewer shown 点火 for 0.13 s sees a flicker, not a word.
const READ_MIN = 2;
const READ_CHARS = 4;

interface Run {
  from: number;
  n: number;
  label: string;
  chars: number;
  edge: boolean; // started where the samples start: its true length is unknown
}

// Text that stays until its scene is about to end is read with that scene's narration; what is
// judged is text taken away while its scene goes on. 0.5 s: film.caption leaves 0.45 s before the end.
const SCENE_END = 0.5;

// The scenes as [start, end) spans, for the scene a run of samples starts in.
export type SceneSpan = { a0: number; dur: number };

function lastsItsScene(from: number, to: number, scenes: SceneSpan[]): boolean {
  const s = scenes.find((p) => from >= p.a0 - 1e-6 && from < p.a0 + p.dur);
  return !!s && to >= s.a0 + s.dur - SCENE_END - 1e-6;
}

function briefIssue(r: Run, to: number, step: number, scenes: SceneSpan[]): LayoutIssue[] {
  const secs = r.n * step,
    need = Math.max(READ_MIN, r.chars / READ_CHARS);
  if (r.edge || secs + 1e-6 >= need || lastsItsScene(r.from, to, scenes)) return [];
  return [
    {
      kind: "brief",
      from: r.from,
      to,
      message: `${r.label} is on screen for ${secs.toFixed(1)}s, needs ${need.toFixed(1)}s (big text stays 2 s, and 1 s per 4 characters)`,
    },
  ];
}

// Runs of samples in which each big text box is on screen. A run that touches the first or the last
// sample of a stretch of samples (the film's ends, or the edges of the scenes being checked) is
// not judged, since it may go on outside them.
function briefTexts(samples: LayoutSample[], scenes: SceneSpan[]): LayoutIssue[] {
  const step = samples.length > 1 ? samples[1]!.t - samples[0]!.t : 0.1;
  const open = new Map<number, Run>();
  const out: LayoutIssue[] = [];
  samples.forEach((s, i) => {
    const edge = i === 0 || s.t - samples[i - 1]!.t > step * 1.5;
    if (edge) open.clear();
    const here = new Set<number>();
    for (const b of s.boxes) {
      if (!b.text || b.text.px < LARGE_PX || !b.text.chars) continue;
      here.add(b.key);
      const r = open.get(b.key);
      if (r) r.n++;
      else open.set(b.key, { from: s.t, n: 1, label: b.label, chars: b.text.chars, edge });
    }
    for (const [k, r] of open)
      if (!here.has(k)) {
        out.push(...briefIssue(r, s.t, step, scenes));
        open.delete(k);
      }
  });
  return out;
}

// A finding counts when it holds in at least two samples in a row, so a single in-between frame of
// a transition is not reported. Each finding is reported once with the span it was seen over.
// `scenes` lets big text that lasts its scene pass the reading-time rule.
export function findLayoutIssues(samples: LayoutSample[], scenes: SceneSpan[] = []): LayoutIssue[] {
  return [...stillIssues(samples), ...briefTexts(samples, scenes)].sort((a, b) => a.from - b.from);
}

function stillIssues(samples: LayoutSample[]): LayoutIssue[] {
  const seen = new Map<string, Seen>();
  let prev = new Map<number, LayoutBox>();
  samples.forEach((s, i) => {
    for (const f of findingsAt(s.boxes, prev)) {
      const e = seen.get(f.id);
      const run = e && e.last === i - 1 ? e.run + 1 : 1;
      seen.set(f.id, {
        kind: f.kind,
        message: f.message,
        from: e ? e.from : s.t,
        to: s.t,
        last: i,
        run,
        best: Math.max(e ? e.best : 0, run),
      });
    }
    prev = new Map(s.boxes.map((b) => [b.key, b]));
  });
  return [...seen.values()]
    .filter((e) => e.best >= 2)
    .sort((a, b) => a.from - b.from)
    .map(({ kind, from, to, message }) => ({ kind, from, to, message }));
}

export function formatIssue(i: LayoutIssue): string {
  const f = i.from.toFixed(1),
    t = i.to.toFixed(1);
  return `${f === t ? f : `${f}-${t}`}s: ${i.message}`;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseText(v: unknown): BoxText | null | undefined {
  if (v === null) return null;
  if (isRecord(v) && num(v.px) && (v.contrast === null || num(v.contrast)))
    return { px: v.px, contrast: v.contrast, ...(num(v.chars) ? { chars: v.chars } : {}) };
  return undefined;
}

function parseBox(v: unknown): LayoutBox {
  if (isRecord(v)) {
    const { key, label, x, y, w, h, cut, anc, ok, under } = v;
    const text = parseText(v.text);
    if (
      num(key) &&
      typeof label === "string" &&
      num(x) &&
      num(y) &&
      num(w) &&
      num(h) &&
      typeof cut === "boolean" &&
      typeof ok === "boolean" &&
      Array.isArray(anc) &&
      anc.every(num) &&
      (under === null || num(under)) &&
      text !== undefined
    )
      return { key, label, x, y, w, h, cut, anc, ok, under, text };
  }
  throw new Error("the layout snapshot of the film page is malformed");
}

// The snapshot comes from the film page, whose code is not ours, so its shape is checked here.
export function parseBoxes(raw: unknown): LayoutBox[] {
  if (!Array.isArray(raw)) throw new Error("the layout snapshot of the film page is malformed");
  return raw.map(parseBox);
}

// Samples the whole film every `step` seconds, on all of the film's pages at once, and judges the
// samples in film order. A finding needs two samples in a row, so at 0.1 s a pose held for 0.2 s is
// reported. A film opened with only some scene files is sampled over those scenes only. Motion films
// draw inside their own player and cannot be inspected, so they get null.
export async function checkLayout(film: Film, step = 0.1): Promise<LayoutIssue[] | null> {
  const inspect = film.inspect;
  if (!inspect) return null;
  const only = film.only;
  const spans = only ? film.meta.parts.filter((p) => only.includes(p.key)) : null;
  const times = Array.from(
    { length: Math.ceil(film.meta.duration / step - 1e-9) },
    (_, i) => Math.round(i * step * 1000) / 1000
  ).filter((t) => !spans || spans.some((p) => t >= p.a0 && t < p.a0 + p.dur));
  const sample = (i: number): Promise<LayoutSample> => {
    const t = times[i] ?? 0;
    return inspect(t).then((boxes) => ({ t, boxes }));
  };
  const samples: LayoutSample[] = [];
  for await (const s of inOrder(times.length, film.pages, sample)) samples.push(s);
  return findLayoutIssues(samples, film.meta.parts);
}
