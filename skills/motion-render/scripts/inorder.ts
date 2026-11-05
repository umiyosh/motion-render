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

// Runs fn on each item with up to `n` running at once, for API calls whose results are saved one by
// one. After a failure no new item starts; the ones running finish, and the first error is thrown.
export async function inParallel<T>(
  items: readonly T[],
  n: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (!errors.length && next < items.length) {
      const i = next++;
      try {
        await fn(items[i]);
      } catch (e) {
        errors.push(e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (errors.length) throw errors[0];
}
