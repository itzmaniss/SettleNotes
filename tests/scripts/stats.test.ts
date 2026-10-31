import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  collectStats,
  countBy,
  countDistinct,
  formatStats,
  parseStatsArgs,
  round2,
  sgtDayStart,
  statsToJson,
  summarizeAiCalls,
  summarizeSubscriptions,
  type AiCallLite,
  type SubscriptionLite,
} from "../../scripts/stats";

describe("parseStatsArgs", () => {
  test("defaults to the human table over 7 days", () => {
    expect(parseStatsArgs([])).toEqual({ json: false, days: 7 });
  });

  test("accepts --json and --days", () => {
    expect(parseStatsArgs(["--json"])).toEqual({ json: true, days: 7 });
    expect(parseStatsArgs(["--days", "1"])).toEqual({ json: false, days: 1 });
    expect(parseStatsArgs(["--json", "--days", "30"])).toEqual({ json: true, days: 30 });
  });

  test("rejects junk loudly", () => {
    expect(() => parseStatsArgs(["--days", "0"])).toThrow();
    expect(() => parseStatsArgs(["--days", "x"])).toThrow();
    expect(() => parseStatsArgs(["--write"])).toThrow(/Usage/);
  });
});

describe("pure helpers", () => {
  test("countBy and countDistinct", () => {
    expect(countBy([{ k: "a" }, { k: "a" }, { k: "b" }], (row) => row.k)).toEqual({ a: 2, b: 1 });
    expect(countDistinct(["u1", "u1", null, "u2"])).toBe(2);
    expect(countDistinct([null, null])).toBe(0);
  });

  test("sgtDayStart is SGT midnight as a UTC instant", () => {
    // 31 Oct 2026, 09:23 SGT = 01:23 UTC. The SGT day began 31 Oct 00:00 SGT
    // = 30 Oct 16:00 UTC.
    expect(sgtDayStart(new Date("2026-10-31T01:23:00.000Z")).toISOString()).toBe(
      "2026-10-30T16:00:00.000Z",
    );
    // 01:30 SGT on 1 Nov is already the November day.
    expect(sgtDayStart(new Date("2026-10-31T17:30:00.000Z")).toISOString()).toBe(
      "2026-10-31T16:00:00.000Z",
    );
  });

  test("round2", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(15.9833333)).toBe(15.98);
    expect(round2(10.6666666)).toBe(10.67);
    expect(round2(0)).toBe(0);
  });
});

describe("summarizeAiCalls", () => {
  const NOW = new Date("2026-10-31T10:00:00.000Z"); // 18:00 SGT

  function call(overrides: Partial<AiCallLite>): AiCallLite {
    return {
      user_id: "u1",
      purpose: "understand",
      cost_usd: 0.01,
      ok: true,
      created_at: "2026-10-31T02:00:00.000Z",
      ...overrides,
    };
  }

  test("counts, sums, splits today (SGT), averages per user and rates failures", () => {
    const rows = [
      call({ cost_usd: 0.04, purpose: "math" }),
      call({ cost_usd: 0.04, purpose: "math", created_at: "2026-10-31T01:00:00.000Z" }),
      // Yesterday SGT (30 Oct 20:00 SGT): counts in totals, not today.
      call({ cost_usd: 0.5, purpose: "transcribe", created_at: "2026-10-30T12:00:00.000Z", user_id: "u2" }),
      call({ ok: false, cost_usd: null, purpose: "math" }),
    ];
    const summary = summarizeAiCalls(rows, NOW);
    expect(summary.count).toBe(4);
    expect(summary.failures).toBe(1);
    expect(summary.failureRate).toBe(25);
    expect(summary.totalCostUsd).toBe(0.58);
    expect(summary.todayCostUsd).toBe(0.08);
    expect(summary.usersWithCalls).toBe(2);
    expect(summary.avgCostPerUserUsd).toBe(0.29);
    expect(summary.byPurpose.math).toEqual({ count: 3, costUsd: 0.08, failures: 1 });
    expect(summary.byPurpose.transcribe).toEqual({ count: 1, costUsd: 0.5, failures: 0 });
  });

  test("an empty database is zeros and never NaN", () => {
    const summary = summarizeAiCalls([], NOW);
    expect(summary.count).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.todayCostUsd).toBe(0);
    expect(summary.usersWithCalls).toBe(0);
    expect(summary.avgCostPerUserUsd).toBe(0);
    expect(summary.failureRate).toBe(0);
    expect(JSON.stringify(summary)).not.toContain("NaN");
  });
});

describe("summarizeSubscriptions", () => {
  function sub(overrides: Partial<SubscriptionLite>): SubscriptionLite {
    return { provider: "stripe", plan: "pro", provider_ref: "sub_123", ...overrides };
  }

  test("splits stripe recurring, paynow and stars, and prices the MRR band from plans.ts", () => {
    const rows = [
      sub({}),
      sub({ provider_ref: "sub_456" }),
      sub({ provider_ref: "paynow:cs_1" }),
      sub({ provider: "stars", provider_ref: "charge_1" }),
      sub({ provider: "stars", provider_ref: "charge_2" }),
    ];
    const summary = summarizeSubscriptions(rows);
    expect(summary.activeByProvider).toEqual({ stars: 2, stripe: 3 });
    expect(summary.activeByPlan).toEqual({ pro: 5 });
    expect(summary.stripeRecurring).toBe(2);
    expect(summary.stripePaynow).toBe(1);
    expect(summary.starsActive).toBe(2);
    // plans.ts Pro: S$7.99 monthly, S$63.99 yearly. 2 subscribers:
    // lower 2 * 63.99 / 12 = 10.67, upper 2 * 7.99 = 15.98.
    expect(summary.mrrEstimate).toEqual({ currency: "SGD", lower: 10.67, upper: 15.98 });
    // Stars are never converted: subscribers times the Stars price.
    expect(summary.starsPerMonth).toBe(1200);
  });

  test("empty table: no estimate, no Stars, zeros everywhere", () => {
    const summary = summarizeSubscriptions([]);
    expect(summary.activeByProvider).toEqual({});
    expect(summary.stripeRecurring).toBe(0);
    expect(summary.mrrEstimate).toBeNull();
    expect(summary.starsPerMonth).toBe(0);
  });
});

describe("collectStats", () => {
  // Minimal fake of the pieces of the Supabase client the script uses: a
  // chainable, thenable builder over an in-memory table map. Head selects
  // answer a count, everything else answers rows; filters are chainable and
  // ignored, because each count in the script owns its own table or filter
  // and the tests only assert the aggregate shapes.
  function fakeClient(tables: Record<string, Array<Record<string, unknown>>>) {
    return {
      from(table: string) {
        const rows = tables[table] ?? [];
        let headCount = false;
        const builder = {
          select(_columns: string, opts?: { count?: string; head?: boolean }) {
            if (opts?.head) headCount = true;
            return builder;
          },
          eq: () => builder,
          gte: () => builder,
          in: () => builder,
          order: () => builder,
          range(offset: number, end: number) {
            return Promise.resolve(
              headCount
                ? { count: rows.length, error: null }
                : { data: rows.slice(offset, end + 1), error: null },
            );
          },
          // Awaited directly on the count path, like the real builder.
          then(
            onFulfilled?: (value: { count: number | null; error: unknown }) => unknown,
          ) {
            return Promise.resolve(
              headCount ? { count: rows.length, error: null } : { count: rows.length, error: null },
            ).then(onFulfilled);
          },
        };
        return builder;
      },
    } as never;
  }

  test("collects every aggregate over the fake client and never writes", async () => {
    const now = new Date("2026-10-31T10:00:00.000Z");
    const client = fakeClient({
      users: Array.from({ length: 3 }, (_, i) => ({ id: `u${i}`, created_at: now.toISOString() })),
      uploads: [
        { id: "up1", kind: "photo", status: "done", user_id: "u0" },
        { id: "up2", kind: "photo", status: "failed", user_id: "u0" },
        { id: "up3", kind: "text", status: "done", user_id: "u1" },
      ],
      tasks: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` })),
      starters: [{ id: "s1", type: "checklist" }],
      weak_spots: [{ id: "w1", occurrences: 5 }],
      ai_calls: [
        { id: "a1", user_id: "u0", purpose: "understand", cost_usd: 0.01, ok: true, created_at: now.toISOString() },
      ],
      subscriptions: [{ id: "sb1", provider: "stars", plan: "pro", provider_ref: "c1" }],
      usage_events: [{ id: "ue1", feature: "math_diagnosis", status: "consumed" }],
      pending_actions: [{ id: "pa1", status: "pending" }],
    });

    const stats = await collectStats(client, { days: 7, now });
    expect(stats.users.total).toBe(3);
    expect(stats.uploads.total).toBe(3);
    expect(stats.uploads.byKind).toEqual({ photo: 2, text: 1 });
    expect(stats.uploads.byStatus).toEqual({ done: 2, failed: 1 });
    expect(stats.users.withUploads).toBe(2);
    expect(stats.tasks.total).toBe(5);
    expect(stats.aiCalls.count).toBe(1);
    expect(stats.subscriptions.starsActive).toBe(1);
    expect(stats.usageThisMonth.byFeature.math_diagnosis).toBe(1);
    expect(stats.pendingActions.byStatus.pending).toBe(1);
  });

  test("an empty database prints zeros and no NaN, in both renderings", async () => {
    const now = new Date("2026-10-31T10:00:00.000Z");
    const stats = await collectStats(fakeClient({}), { days: 7, now });
    const human = formatStats(stats).join("\n");
    const json = statsToJson(stats);
    expect(human).toContain("users: total 0");
    expect(human).toContain("estimated monthly recurring revenue: no recurring Stripe subscribers yet");
    expect(human).not.toMatch(/NaN/i);
    expect(json).not.toContain("NaN");
    expect(JSON.parse(json).users.total).toBe(0);
  });

  test("the human output mentions no names, ids, usernames or message text", async () => {
    const now = new Date("2026-10-31T10:00:00.000Z");
    const client = fakeClient({
      users: [{ id: "u0", first_name: "Secret Name", created_at: now.toISOString() }],
      uploads: [{ id: "up1", kind: "text", status: "done", user_id: "u0" }],
    });
    const stats = await collectStats(client, { days: 7, now });
    const output = formatStats(stats).join("\n") + statsToJson(stats);
    expect(output).not.toContain("Secret Name");
    expect(output).not.toContain("u0");
  });
});

// The read only guarantee, enforced on the source: the script never calls the
// PostgREST write methods or an RPC. Comments alone cannot satisfy this scan
// because it looks for call syntax.
describe("read only guarantee", () => {
  const source = readFileSync(new URL("../../scripts/stats.ts", import.meta.url), "utf8");

  test("stats.ts never calls insert, update, delete or rpc", () => {
    for (const method of ["insert", "update", "delete", "rpc", "upsert"]) {
      expect(source).not.toContain(`.${method}(`);
    }
  });

  test("stats.ts imports only the supabase client, env and plans config", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    for (const target of imports) {
      expect(["../lib/db/client", "../lib/env", "../lib/billing/plans"]).toContain(target);
    }
  });
});
