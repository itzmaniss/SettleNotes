import { describe, expect, mock, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/billing transitively imports "server-only", which throws outside a
// React Server Component runtime. Neutralize it, then load the real module.
mock.module("server-only", () => ({}));

const { createSubscriptionsQueries } = await import("../../lib/billing/subscriptions");

type FakeError = { message: string; code?: string };
type FakeReply = { data?: unknown; error?: FakeError | null };

type RecordedCall = {
  table: string;
  method: "select" | "insert" | "update" | "delete";
  payload: unknown;
  selectColumns: string | undefined;
  filters: { op: string; column: string; value: unknown }[];
  order: { column: string; options: Record<string, unknown> | undefined } | null;
  limit: number | null;
};

// Minimal chainable stand-in for the PostgREST builder, same shape as the
// fake in tests/billing/queries.test.ts.
function makeFakeClient(replyFor: (call: RecordedCall) => FakeReply): SupabaseClient {
  function build(table: string) {
    const call: RecordedCall = {
      table,
      method: "select",
      payload: undefined,
      selectColumns: undefined,
      filters: [],
      order: null,
      limit: null,
    };

    const respond = (allowEmpty: boolean): Promise<{ data: unknown; error: unknown }> => {
      const reply = replyFor(call);
      if (reply.error) return Promise.resolve({ data: null, error: reply.error });
      if (!allowEmpty && reply.data == null) {
        return Promise.resolve({
          data: null,
          error: { message: `fake: no single row for ${table} ${call.method}`, code: "PGRST116" },
        });
      }
      return Promise.resolve({ data: reply.data ?? null, error: null });
    };

    const filter = (op: string) => (column: string, value: unknown) => {
      call.filters.push({ op, column, value });
      return builder;
    };

    const builder = {
      insert(payload: unknown) {
        call.method = "insert";
        call.payload = payload;
        return builder;
      },
      update(payload: unknown) {
        call.method = "update";
        call.payload = payload;
        return builder;
      },
      delete() {
        call.method = "delete";
        return builder;
      },
      select(columns?: string) {
        call.selectColumns = columns;
        return builder;
      },
      eq: filter("eq"),
      order(column: string, options?: Record<string, unknown>) {
        call.order = { column, options };
        return builder;
      },
      limit(n: number) {
        call.limit = n;
        return builder;
      },
      single() {
        return respond(false);
      },
      maybeSingle() {
        return respond(true);
      },
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ): Promise<unknown> {
        // A bare insert/update/delete awaits without .select().
        return respond(true).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { from: build } as unknown as SupabaseClient;
}

const PERIOD_END = "2026-11-30T16:00:00.000Z";

function upsertInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    provider: "stars" as const,
    providerRef: "charge-1",
    plan: "pro" as const,
    status: "active" as const,
    currentPeriodEnd: new Date(PERIOD_END),
    ...overrides,
  };
}

describe("getLatestSubscription", () => {
  test("scopes by user and provider and takes the newest row", async () => {
    const seen: RecordedCall[] = [];
    const row = { id: "sub-1", current_period_end: PERIOD_END };
    const q = createSubscriptionsQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: row };
      }),
    );

    expect(await q.getLatestSubscription("user-1", "stars")).toEqual(
      expect.objectContaining(row),
    );

    const call = seen[0];
    expect(call.table).toBe("subscriptions");
    expect(call.filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "provider", value: "stars" },
    ]);
    expect(call.order).toEqual({ column: "created_at", options: { ascending: false } });
    expect(call.limit).toBe(1);
  });

  test("returns null when the user has no row for that provider", async () => {
    const q = createSubscriptionsQueries(makeFakeClient(() => ({ data: null })));
    expect(await q.getLatestSubscription("user-1", "stars")).toBeNull();
  });

  test("throws a clear error on a supabase failure", () => {
    const q = createSubscriptionsQueries(
      makeFakeClient(() => ({ error: { code: "42501", message: "permission denied" } })),
    );
    expect(q.getLatestSubscription("user-1", "stars")).rejects.toThrow(/getLatestSubscription/);
  });
});

describe("upsertSubscription", () => {
  test("updates the existing row, scoped by user and provider", async () => {
    const seen: RecordedCall[] = [];
    const q = createSubscriptionsQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: { id: "sub-1" } };
      }),
    );

    await q.upsertSubscription(upsertInput());

    const update = seen[0];
    expect(update.method).toBe("update");
    expect(update.filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "provider", value: "stars" },
    ]);
    expect(update.payload).toMatchObject({
      provider_ref: "charge-1",
      plan: "pro",
      status: "active",
      current_period_end: PERIOD_END,
    });
    // No insert after a matched update.
    expect(seen).toHaveLength(1);
  });

  test("inserts when no row exists yet, carrying the user id", async () => {
    const seen: RecordedCall[] = [];
    const q = createSubscriptionsQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return c.method === "update" ? { data: null } : { data: null };
      }),
    );

    await q.upsertSubscription(upsertInput());

    const insert = seen[1];
    expect(insert.method).toBe("insert");
    expect(insert.payload).toEqual({
      user_id: "user-1",
      provider: "stars",
      provider_ref: "charge-1",
      plan: "pro",
      status: "active",
      current_period_end: PERIOD_END,
    });
  });

  test("throws on an insert failure", () => {
    const q = createSubscriptionsQueries(
      makeFakeClient((c) =>
        c.method === "update" ? { data: null } : { error: { code: "23505", message: "duplicate" } },
      ),
    );
    expect(q.upsertSubscription(upsertInput())).rejects.toThrow(/upsertSubscription/);
  });
});

describe("billing events", () => {
  test("findBillingEvent reports whether the id was recorded", async () => {
    const seen: RecordedCall[] = [];
    const hit = createSubscriptionsQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: { id: "stars:charge-1" } };
      }),
    );
    expect(await hit.findBillingEvent("stars:charge-1")).toBe(true);
    expect(seen[0]).toMatchObject({
      table: "billing_events",
      selectColumns: "id",
      filters: [{ op: "eq", column: "id", value: "stars:charge-1" }],
    });

    const miss = createSubscriptionsQueries(makeFakeClient(() => ({ data: null })));
    expect(await miss.findBillingEvent("stars:charge-2")).toBe(false);
  });

  test("recordBillingEvent inserts id, provider and payload", async () => {
    const seen: RecordedCall[] = [];
    const q = createSubscriptionsQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      }),
    );

    await q.recordBillingEvent({ id: "stars:charge-1", provider: "stars", payload: { a: 1 } });

    expect(seen[0]).toMatchObject({
      table: "billing_events",
      method: "insert",
      payload: { id: "stars:charge-1", provider: "stars", payload: { a: 1 } },
    });
  });

  test("deleteBillingEvent deletes exactly that id", async () => {
    const seen: RecordedCall[] = [];
    const q = createSubscriptionsQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      }),
    );

    await q.deleteBillingEvent("stars:charge-1");

    expect(seen[0]).toMatchObject({
      table: "billing_events",
      method: "delete",
      filters: [{ op: "eq", column: "id", value: "stars:charge-1" }],
    });
  });
});

describe("markSubscriptionCanceled", () => {
  test("cancels exactly the user, provider and charge row", async () => {
    const seen: RecordedCall[] = [];
    const q = createSubscriptionsQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      }),
    );

    await q.markSubscriptionCanceled("user-1", "stars", "charge-1");

    const call = seen[0];
    expect(call.method).toBe("update");
    expect(call.payload).toMatchObject({ status: "canceled" });
    expect(call.filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "provider", value: "stars" },
      { op: "eq", column: "provider_ref", value: "charge-1" },
    ]);
  });

  test("throws a clear error on a supabase failure", () => {
    const q = createSubscriptionsQueries(
      makeFakeClient(() => ({ error: { message: "deadlock" } })),
    );
    expect(q.markSubscriptionCanceled("user-1", "stars", "charge-1")).rejects.toThrow(
      /markSubscriptionCanceled/,
    );
  });
});
