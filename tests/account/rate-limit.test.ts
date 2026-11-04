import { describe, expect, test } from "bun:test";
import {
  createExportRateLimiter,
  EXPORT_RATE_LIMIT_MAX,
  EXPORT_RATE_LIMIT_WINDOW_MS,
} from "../../lib/account/rate-limit";

// 4 Nov 2026, 09:00 SGT.
const T0 = new Date("2026-11-04T01:00:00.000Z");

function clock() {
  let at = T0.getTime();
  return {
    now: () => new Date(at),
    advance(seconds: number) {
      at += seconds * 1000;
    },
  };
}

describe("createExportRateLimiter", () => {
  test("constants: max 3 exports per 10 minutes", () => {
    expect(EXPORT_RATE_LIMIT_MAX).toBe(3);
    expect(EXPORT_RATE_LIMIT_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  test("the first three exports pass, the fourth in the window is refused", () => {
    const time = clock();
    const limiter = createExportRateLimiter(3, 10 * 60 * 1000, time.now);
    expect(limiter("user-1", time.now())).toEqual({ ok: true });
    time.advance(60);
    expect(limiter("user-1", time.now())).toEqual({ ok: true });
    time.advance(60);
    expect(limiter("user-1", time.now())).toEqual({ ok: true });
    time.advance(1);
    const refused = limiter("user-1", time.now());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      // The window closes 10 minutes after the FIRST hit in the window.
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(10 * 60);
    }
  });

  test("the window passes: an export just past 10 minutes from the first hit is allowed", () => {
    const time = clock();
    const limiter = createExportRateLimiter(3, 10 * 60 * 1000, time.now);
    expect(limiter("user-1", time.now()).ok).toBe(true);
    time.advance(60);
    expect(limiter("user-1", time.now()).ok).toBe(true);
    time.advance(60);
    expect(limiter("user-1", time.now()).ok).toBe(true);

    // Past the window the oldest hit ages out, so another export fits.
    time.advance(10 * 60 + 1);
    expect(limiter("user-1", time.now())).toEqual({ ok: true });
  });

  test("the limit is per user", () => {
    const time = clock();
    const limiter = createExportRateLimiter(3, 10 * 60 * 1000, time.now);
    for (let i = 0; i < 3; i++) {
      expect(limiter("user-1", time.now()).ok).toBe(true);
    }
    expect(limiter("user-1", time.now()).ok).toBe(false);
    // Another student is untouched.
    expect(limiter("user-2", time.now())).toEqual({ ok: true });
  });
});
