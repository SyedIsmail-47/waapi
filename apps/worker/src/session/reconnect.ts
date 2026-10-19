export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  attempt: number;
};

/** Exponential backoff with full jitter. */
export function nextBackoffMs(opts: BackoffOptions): number {
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 60_000;
  const exp = Math.min(max, base * 2 ** Math.max(0, opts.attempt));
  return Math.floor(Math.random() * exp);
}
