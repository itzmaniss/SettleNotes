// Tiny per user in-memory rate limit for the data download: max 3 exports
// per user per 10 minutes, per server process. The clock is injected so
// tests can walk the window without waiting. Memory only by design: a
// restart clears it, which is fine for a self harm limit on a read only
// endpoint.
export const EXPORT_RATE_LIMIT_MAX = 3;
export const EXPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export type ExportRateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export type ExportRateLimiter = (userId: string, at: Date) => ExportRateLimitVerdict;

export function createExportRateLimiter(
  max: number = EXPORT_RATE_LIMIT_MAX,
  windowMs: number = EXPORT_RATE_LIMIT_WINDOW_MS,
  now: () => Date = () => new Date(),
): ExportRateLimiter {
  const hits = new Map<string, number[]>();
  return (userId: string, at: Date = now()) => {
    const kept = (hits.get(userId) ?? []).filter((t) => at.getTime() - t < windowMs);
    if (kept.length >= max) {
      const retryAfterSeconds = Math.ceil((kept[0]! + windowMs - at.getTime()) / 1000);
      hits.set(userId, kept);
      return { ok: false, retryAfterSeconds };
    }
    kept.push(at.getTime());
    hits.set(userId, kept);
    return { ok: true };
  };
}
