import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  checkRateLimit,
  countRecentUploadsWith,
  createRateLimiter,
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

describe("createRateLimiter", () => {
  function fakeCounter(counts: Record<string, number>) {
    const calls: Array<{ userId: string; since: Date }> = [];
    return {
      calls,
      countRecentUploads: async (userId: string, since: Date): Promise<number> => {
        calls.push({ userId, since });
        return counts[userId] ?? 0;
      },
    };
  }

  test("counts since one window ago and maps the pure verdict", async () => {
    const now = new Date("2026-10-28T09:00:00+08:00");
    const fake = fakeCounter({ "user-1": 7, "user-2": 8 });
    const limiter = createRateLimiter({ countRecentUploads: fake.countRecentUploads, now: () => now });

    expect(await limiter.check("user-1")).toEqual({ allowed: true });
    expect(await limiter.check("user-2")).toEqual({
      allowed: false,
      retryAfterSeconds: RATE_LIMIT.windowSeconds,
    });
    const expectedSince = new Date(now.getTime() - RATE_LIMIT.windowSeconds * 1000);
    expect(fake.calls).toEqual([
      { userId: "user-1", since: expectedSince },
      { userId: "user-2", since: expectedSince },
    ]);
  });

  test("defaults to wall clock now when no clock is injected", async () => {
    const fake = fakeCounter({});
    const limiter = createRateLimiter({ countRecentUploads: fake.countRecentUploads });
    const before = Date.now() - RATE_LIMIT.windowSeconds * 1000;
    expect(await limiter.check("nobody")).toEqual({ allowed: true });
    expect(fake.calls[0].since.getTime()).toBeGreaterThanOrEqual(before);
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
