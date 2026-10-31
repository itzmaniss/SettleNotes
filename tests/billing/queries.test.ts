import { describe, expect, mock, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/billing transitively imports "server-only", which throws outside a
// React Server Component runtime. Neutralize it, then load the real module.
mock.module("server-only", () => ({}));

const { createBillingQueries } = await import("../../lib/billing/queries");

type FakeError = { message: string; code?: string };
type FakeReply = { data?: unknown; error?: FakeError | null; count?: number | null };

type RecordedCall = {
  table: string;
  method: "select" | "insert" | "update" | "rpc";
  payload: unknown;
  selectColumns: string | undefined;
  selectOptions: Record<string, unknown> | undefined;
  filters: { op: string; column: string; value: unknown }[];
  order: { column: string; options: Record<string, unknown> | undefined } | null;
  limit: number | null;
  rpcName: string | null;
  rpcArgs: Record<string, unknown> | null;
};

// Minimal chainable stand-in for the PostgREST builder plus an rpc entry
// point: records every call and resolves through the test-provided replyFor.
function makeFakeClient(replyFor: (call: RecordedCall) => FakeReply): SupabaseClient {
  function build(table: string) {
    const call: RecordedCall = {
      table,
      method: "select",
      payload: undefined,
      selectColumns: undefined,
      selectOptions: undefined,
      filters: [],
      order: null,
      limit: null,
      rpcName: null,
      rpcArgs: null,
    };

    const respond = (allowEmpty: boolean): Promise<{ data: unknown; error: unknown; count: number | null }> => {
      const reply = replyFor(call);
      if (reply.error) return Promise.resolve({ data: null, error: reply.error, count: null });
      if (!allowEmpty && reply.data == null) {
        return Promise.resolve({
          data: null,
          error: { message: `fake: no single row for ${table} ${call.method}`, code: "PGRST116" },
          count: null,
        });
      }
      return Promise.resolve({ data: reply.data ?? null, error: null, count: reply.count ?? null });
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
      select(columns?: string, options?: Record<string, unknown>) {
        call.selectColumns = columns;
        call.selectOptions = options;
        return builder;
      },
      eq: filter("eq"),
      gt: filter("gt"),
      gte: filter("gte"),
      in: filter("in"),
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
        onRejected?: (reason: unknown) => unknown
      ): Promise<unknown> {
        return respond(true).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return {
    from: build,
    rpc(name: string, args: Record<string, unknown>) {
      const call: RecordedCall = {
        table: "rpc",
        method: "rpc",
        payload: undefined,
        selectColumns: undefined,
        selectOptions: undefined,
        filters: [],
        order: null,
        limit: null,
        rpcName: name,
        rpcArgs: args,
      };
      const reply = replyFor(call);
      if (reply.error) return Promise.resolve({ data: null, error: reply.error, count: null });
      return Promise.resolve({ data: reply.data ?? null, error: null, count: reply.count ?? null });
    },
  } as unknown as SupabaseClient;
}

describe("getActiveSubscription", () => {
  test("scopes by user, requires active and unexpired, takes the newest row", async () => {
    const seen: RecordedCall[] = [];
    const row = { plan: "pro" as const, current_period_end: "2026-11-30T16:00:00.000Z", provider: "manual" };
    const now = new Date("2026-10-31T17:30:00Z");
    const q = createBillingQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: row };
      })
    );

    expect(await q.getActiveSubscription("user-1", now)).toEqual(row);

    const call = seen[0];
    expect(call.table).toBe("subscriptions");
    expect(call.selectColumns).toBe("plan, current_period_end, provider");
    expect(call.filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "status", value: "active" },
      { op: "gt", column: "current_period_end", value: "2026-10-31T17:30:00.000Z" },
    ]);
    expect(call.order).toEqual({ column: "current_period_end", options: { ascending: false } });
    expect(call.limit).toBe(1);
  });

  test("returns null when there is no active subscription", async () => {
    const q = createBillingQueries(makeFakeClient(() => ({ data: null })));
    expect(await q.getActiveSubscription("user-1", new Date())).toBeNull();
  });

  test("throws a clear error on a supabase failure", () => {
    const q = createBillingQueries(
      makeFakeClient(() => ({ error: { code: "42501", message: "permission denied" } }))
    );
    expect(q.getActiveSubscription("user-1", new Date())).rejects.toThrow(/getActiveSubscription/);
  });
});

describe("claimUsage", () => {
  const input = {
    userId: "user-1",
    feature: "math_diagnosis" as const,
    uploadId: "upload-1",
    limit: 3,
    periodStart: new Date("2026-10-31T16:00:00Z"),
  };

  test("calls claim_usage with the exact rpc args and returns the id", async () => {
    const seen: RecordedCall[] = [];
    const q = createBillingQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: "usage-1" };
      })
    );

    expect(await q.claimUsage(input)).toBe("usage-1");

    const call = seen[0];
    expect(call.method).toBe("rpc");
    expect(call.rpcName).toBe("claim_usage");
    expect(call.rpcArgs).toEqual({
      p_user: "user-1",
      p_feature: "math_diagnosis",
      p_upload: "upload-1",
      p_limit: 3,
      p_period_start: "2026-10-31T16:00:00.000Z",
    });
  });

  test("returns null when the claim is refused", async () => {
    const q = createBillingQueries(makeFakeClient(() => ({ data: null })));
    expect(await q.claimUsage(input)).toBeNull();
  });

  test("passes a null upload through and throws on rpc errors", async () => {
    const seen: RecordedCall[] = [];
    const errQ = createBillingQueries(
      makeFakeClient(() => ({ error: { code: "P0001", message: "nope" } }))
    );
    expect(errQ.claimUsage(input)).rejects.toThrow(/claimUsage/);

    const okQ = createBillingQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: "usage-2" };
      })
    );
    await okQ.claimUsage({ ...input, uploadId: null });
    expect(seen[0].rpcArgs).toMatchObject({ p_upload: null });
  });
});

describe("setUsageStatus", () => {
  test("only transitions a claimed row", async () => {
    const seen: RecordedCall[] = [];
    const q = createBillingQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      })
    );

    await q.setUsageStatus("usage-1", "consumed");

    const call = seen[0];
    expect(call.table).toBe("usage_events");
    expect(call.method).toBe("update");
    expect(call.payload).toEqual({ status: "consumed" });
    expect(call.filters).toEqual([
      { op: "eq", column: "id", value: "usage-1" },
      { op: "eq", column: "status", value: "claimed" },
    ]);
  });

  test("can release back to the ledger", async () => {
    const seen: RecordedCall[] = [];
    const q = createBillingQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      })
    );

    await q.setUsageStatus("usage-1", "released");
    expect(seen[0].payload).toEqual({ status: "released" });
  });

  test("throws a clear error on a supabase failure", () => {
    const q = createBillingQueries(
      makeFakeClient(() => ({ error: { message: "deadlock" } }))
    );
    expect(q.setUsageStatus("usage-1", "consumed")).rejects.toThrow(/setUsageStatus/);
  });
});

describe("countUsage", () => {
  test("counts claimed and consumed rows in the period, scoped by user", async () => {
    const seen: RecordedCall[] = [];
    const q = createBillingQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null, count: 3 };
      })
    );

    expect(
      await q.countUsage({
        userId: "user-1",
        feature: "math_diagnosis",
        periodStart: new Date("2026-10-31T16:00:00Z"),
      })
    ).toBe(3);

    const call = seen[0];
    expect(call.table).toBe("usage_events");
    expect(call.selectOptions).toEqual({ count: "exact", head: true });
    expect(call.filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "feature", value: "math_diagnosis" },
      { op: "gte", column: "created_at", value: "2026-10-31T16:00:00.000Z" },
      { op: "in", column: "status", value: ["claimed", "consumed"] },
    ]);
  });

  test("returns 0 when the count is missing", async () => {
    const q = createBillingQueries(makeFakeClient(() => ({ data: null, count: null })));
    expect(
      await q.countUsage({ userId: "user-1", feature: "brief_checklist", periodStart: new Date() })
    ).toBe(0);
  });
});
