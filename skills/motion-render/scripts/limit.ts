// Time limits for the steps that can stall without an error: calls into the film page and ffmpeg.
// A stalled step then fails with its name instead of leaving the command waiting forever.

// Fails with "<what> did not finish in <n>s" if p has not settled within ms. `onTimeout` runs first,
// to stop what is stuck (kill ffmpeg, for example).
export function limit<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      onTimeout?.();
      fail(new Error(`${what} did not finish in ${ms / 1000}s`));
    }, ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
