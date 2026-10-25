// Layout check of an html film: samples the page through the film and reports what a viewer would
// see as a mistake: two things partly on top of each other, something sticking out of the box it
// sits in or out of the frame, something hidden under another thing, and text too small or too
// faint to read.
// Only what stays still is reported, so a chip passing over a card on its way is not a mistake.
import type { Film } from "./render.ts";
import { isRecord } from "./json.ts";

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
}

export interface LayoutSample {
  t: number;
  boxes: LayoutBox[];
}

export interface LayoutIssue {
  kind: "overlap" | "outside" | "frame" | "hidden" | "small" | "faint";
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

// A finding counts when it holds in at least two samples in a row, so a single in-between frame of
// a transition is not reported. Each finding is reported once with the span it was seen over.
export function findLayoutIssues(samples: LayoutSample[]): LayoutIssue[] {
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
    return { px: v.px, contrast: v.contrast };
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

// Samples the whole film every `step` seconds. A finding needs two samples in a row, so at 0.1 s a
// pose held for 0.2 s is reported. Motion films draw inside their own player and cannot be
// inspected, so they get null.
export async function checkLayout(film: Film, step = 0.1): Promise<LayoutIssue[] | null> {
  if (!film.inspect) return null;
  const samples: LayoutSample[] = [];
  for (let i = 0; i * step < film.meta.duration; i++) {
    const t = Math.round(i * step * 1000) / 1000;
    samples.push({ t, boxes: await film.inspect(t) });
  }
  return findLayoutIssues(samples);
}
