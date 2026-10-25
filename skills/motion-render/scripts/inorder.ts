// Yields get(0) … get(count - 1) in order while keeping up to `ahead` of them in flight, so the
// pages of a film draw frames in parallel and the frames still come out in film order. At most
// `ahead` results are held at once.
export async function* inOrder<T>(
  count: number,
  ahead: number,
  get: (i: number) => Promise<T>
): AsyncGenerator<T> {
  const queue: Promise<T>[] = [];
  let next = 0;
  for (let i = 0; i < count; i++) {
    while (next < count && queue.length < Math.max(1, ahead)) {
      const p = get(next++);
      // Awaited in order below. This only keeps a later one that fails while an earlier one is
      // still awaited from being reported as unhandled.
      p.catch(() => {});
      queue.push(p);
    }
    const p = queue.shift();
    if (!p) return;
    yield await p;
  }
}
