import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkDailyCap,
  checkRateLimit,
  countRecentUploadsWith,
  createRateLimiter,
  DAILY_UPLOAD_CAP,
  RATE_LIMIT,
} from "../../lib/telegram/limits";

describe("checkRateLimit", () => {
  test("allows every count below the default max of 8", () => {
    for (let count = 0; count < RATE_LIMIT.max; count++) {
      expect(checkRateLimit(count)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
  });

  test("exactly max uploads in the window is the boundary and is refused", () => {
    expect(checkRateLimit(RATE_LIMIT.max - 1).allowed).toBe(true);
    expect(checkRateLimit(RATE_LIMIT.max)).toEqual({
      allowed: false,
      retryAfterSeconds: RATE_LIMIT.windowSeconds,
    });
    expect(checkRateLimit(RATE_LIMIT.max + 25).allowed).toBe(false);
  });

  test("the quoted wait is the whole window rounded up to whole seconds", () => {
    expect(checkRateLimit(99, { windowSeconds: 90.4, max: 2 }).retryAfterSeconds).toBe(91);
    expect(checkRateLimit(2, { windowSeconds: 30, max: 2 }).retryAfterSeconds).toBe(30);
    expect(checkRateLimit(2, { windowSeconds: 60.25, max: 2 }).retryAfterSeconds).toBe(61);
  });

  test("custom limits move the boundary", () => {
    expect(checkRateLimit(1, { windowSeconds: 30, max: 1 }).allowed).toBe(false);
    expect(checkRateLimit(0, { windowSeconds: 30, max: 1 }).allowed).toBe(true);
    expect(checkRateLimit(50, { windowSeconds: 3600, max: 30 }).allowed).toBe(false);
  });
});

describe("checkDailyCap", () => {
  test("the boundary sits at the cap: 149 passes, 150 and 151 are refused", () => {
    expect(checkDailyCap(DAILY_UPLOAD_CAP.max - 1)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(checkDailyCap(DAILY_UPLOAD_CAP.max)).toEqual({
      allowed: false,
      retryAfterSeconds: DAILY_UPLOAD_CAP.windowSeconds,
    });
    expect(checkDailyCap(DAILY_UPLOAD_CAP.max + 1).allowed).toBe(false);
  });

  test("defaults to the shared daily constant and honours a custom cap", () => {
    expect(DAILY_UPLOAD_CAP).toEqual({ windowSeconds: 86400, max: 150 });
    expect(checkDailyCap(0, { windowSeconds: 3600, max: 3 })).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(checkDailyCap(3, { windowSeconds: 3600, max: 3 })).toEqual({
      allowed: false,
      retryAfterSeconds: 3600,
    });
  });
});

describe("createRateLimiter", () => {
  // Fake counter that answers the minute window and the day window with
  // different numbers, telling them apart by how far back the limiter asked.
  function fakeCounter(
    now: Date,
    minuteCounts: Record<string, number>,
    dayCounts: Record<string, number> = {},
  ) {
    const calls: Array<{ userId: string; since: Date; window: "minute" | "day" }> = [];
    return {
      calls,
      countRecentUploads: async (userId: string, since: Date): Promise<number> => {
        const gapSeconds = (now.getTime() - since.getTime()) / 1000;
        const window = gapSeconds > RATE_LIMIT.windowSeconds ? "day" : "minute";
        calls.push({ userId, since, window });
        return (window === "day" ? dayCounts : minuteCounts)[userId] ?? 0;
      },
    };
  }

  test("counts since one window ago and maps the pure verdict", async () => {
    const now = new Date("2026-10-28T09:00:00+08:00");
    const fake = fakeCounter(now, { "user-1": 7, "user-2": 8 });
    const limiter = createRateLimiter({ countRecentUploads: fake.countRecentUploads, now: () => now });

    expect(await limiter.check("user-1")).toEqual({ allowed: true });
    expect(await limiter.check("user-2")).toEqual({
      allowed: false,
      retryAfterSeconds: RATE_LIMIT.windowSeconds,
      window: "minute",
    });
    const expectedSince = new Date(now.getTime() - RATE_LIMIT.windowSeconds * 1000);
    // An allowed user is checked against both windows; a user the minute
    // limit already refuses never reaches the day count.
    expect(fake.calls).toEqual([
      { userId: "user-1", since: expectedSince, window: "minute" },
      { userId: "user-1", since: new Date(now.getTime() - DAILY_UPLOAD_CAP.windowSeconds * 1000), window: "day" },
      { userId: "user-2", since: expectedSince, window: "minute" },
    ]);
  });

  test("defaults to wall clock now when no clock is injected", async () => {
    const realNow = new Date();
    const fake = fakeCounter(realNow, {});
    const limiter = createRateLimiter({ countRecentUploads: fake.countRecentUploads });
    const before = Date.now() - RATE_LIMIT.windowSeconds * 1000;
    expect(await limiter.check("nobody")).toEqual({ allowed: true });
    expect(fake.calls[0].window).toBe("minute");
    expect(fake.calls[0].since.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("the daily cap adds one extra count query and trips with window day", async () => {
    const now = new Date("2026-10-28T09:00:00+08:00");
    const fake = fakeCounter(now, { "user-1": 3 }, { "user-1": DAILY_UPLOAD_CAP.max });
    const limiter = createRateLimiter({ countRecentUploads: fake.countRecentUploads, now: () => now });

    expect(await limiter.check("user-1")).toEqual({
      allowed: false,
      retryAfterSeconds: DAILY_UPLOAD_CAP.windowSeconds,
      window: "day",
    });
    expect(fake.calls).toEqual([
      { userId: "user-1", since: new Date(now.getTime() - RATE_LIMIT.windowSeconds * 1000), window: "minute" },
      { userId: "user-1", since: new Date(now.getTime() - DAILY_UPLOAD_CAP.windowSeconds * 1000), window: "day" },
    ]);
  });

  test("minute wins when both caps trip: only the minute window answers", async () => {
    const now = new Date("2026-10-28T09:00:00+08:00");
    const fake = fakeCounter(
      now,
      { "user-1": RATE_LIMIT.max },
      { "user-1": DAILY_UPLOAD_CAP.max + 10 },
    );
    const limiter = createRateLimiter({ countRecentUploads: fake.countRecentUploads, now: () => now });

    const verdict = await limiter.check("user-1");
    expect(verdict).toEqual({
      allowed: false,
      retryAfterSeconds: RATE_LIMIT.windowSeconds,
      window: "minute",
    });
    // The day count never even ran: the minute verdict short circuits.
    expect(fake.calls).toHaveLength(1);
  });
});

describe("countRecentUploadsWith", () => {
  function fakeClient(result: { count: number | null; error: unknown }) {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const fromCalls: string[] = [];
    const builder = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        calls.push({ op: "select", args: [opts] });
        return builder;
      },
      eq(column: string, value: string) {
        calls.push({ op: "eq", args: [column, value] });
        return builder;
      },
      gte(column: string, value: string) {
        calls.push({ op: "gte", args: [column, value] });
        return Promise.resolve(result);
      },
    };
    const client = {
      from: (table: string) => {
        fromCalls.push(table);
        return builder;
      },
    };
    return { client: client as unknown as SupabaseClient, calls, fromCalls };
  }

  test("counts the user's uploads rows created at or after since, head only", async () => {
    const since = new Date("2026-10-28T01:00:00.000Z");
    const fake = fakeClient({ count: 5, error: null });

    expect(await countRecentUploadsWith(fake.client, "user-1", since)).toBe(5);
    expect(fake.fromCalls).toEqual(["uploads"]);
    expect(fake.calls).toEqual([
      { op: "select", args: [{ count: "exact", head: true }] },
      { op: "eq", args: ["user_id", "user-1"] },
      { op: "gte", args: ["created_at", since.toISOString()] },
    ]);
  });

  test("a missing count is zero and a database error becomes a thrown message", async () => {
    const since = new Date("2026-10-28T01:00:00.000Z");
    expect(
      await countRecentUploadsWith(fakeClient({ count: null, error: null }).client, "u", since),
    ).toBe(0);
    const broken = fakeClient({ count: null, error: { code: "42P01", message: "missing table" } });
    await expect(countRecentUploadsWith(broken.client, "u", since)).rejects.toThrow(
      "db countRecentUploads failed [42P01]",
    );
  });
});

