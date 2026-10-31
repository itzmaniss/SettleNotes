import { describe, expect, mock, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/weakspots/queries imports "server-only", which bunfig.toml's preload
// already mocks; mock again defensively so this file stands alone.
mock.module("server-only", () => ({}));

const { createWeakSpotQueries } = await import("../../lib/weakspots/queries");

type Row = Record<string, unknown>;

type RecordedCall = {
  table: string;
  method: string;
  payload?: unknown;
  filters: Array<{ op: string; column: string; value: unknown }>;
  orders: Array<{ column: string; options: Record<string, unknown> | undefined }>;
  limit: number | null;
};

// Chainable PostgREST-shaped fake that applies eq/in/order/limit against
// in-memory rows, so ownership filters and ordering are under test.
function makeDb(tables: { tasks?: Row[]; weak_spots?: Row[] }) {
  const data: Record<string, Row[]> = {
    tasks: tables.tasks ?? [],
    weak_spots: tables.weak_spots ?? [],
  };
  const calls: RecordedCall[] = [];

  function build(table: string) {
    const call: RecordedCall = { table, method: "select", filters: [], orders: [], limit: null };
    calls.push(call);

    const matches = (row: Row): boolean =>
      call.filters.every((f) => {
        if (f.op === "eq") return row[f.column] === f.value;
        if (f.op === "in") return (f.value as unknown[]).includes(row[f.column]);
        return true;
      });

    const respond = (mode: "list" | "maybe" | "single") => {
      if (call.method === "update") {
        const patch = call.payload as Row;
        const matched = (data[table] ?? []).filter(matches);
        for (const row of matched) Object.assign(row, patch);
        const first = matched[0] == null ? null : { ...matched[0] };
        if (first == null && mode === "single") {
          return Promise.resolve({
            data: null,
            error: { message: "fake: no matching row", code: "PGRST116" },
            count: null,
          });
        }
        return Promise.resolve({ data: first, error: null, count: null });
      }
      let rows = (data[table] ?? []).filter(matches).map((row) => ({ ...row }));
      for (const { column, options } of [...call.orders].reverse()) {
        const ascending = options?.ascending !== false;
        rows = [...rows].sort((a, b) => {
          const an = Date.parse(String(a[column]));
          const bn = Date.parse(String(b[column]));
          if (Number.isNaN(an) || Number.isNaN(bn) || an === bn) return 0;
          return ascending ? an - bn : bn - an;
        });
      }
      if (call.limit != null) rows = rows.slice(0, call.limit);
      if (mode === "single" || mode === "maybe") {
        if (rows.length === 0 && mode === "single") {
          return Promise.resolve({
            data: null,
            error: { message: "fake: no rows", code: "PGRST116" },
            count: null,
          });
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null, count: null });
      }
      return Promise.resolve({ data: rows, error: null, count: null });
    };

    const builder = {
      select() {
        return builder;
      },
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
      eq(column: string, value: unknown) {
        call.filters.push({ op: "eq", column, value });
        return builder;
      },
      in(column: string, value: unknown[]) {
        call.filters.push({ op: "in", column, value });
        return builder;
      },
      order(column: string, options?: Record<string, unknown>) {
        call.orders.push({ column, options });
        return builder;
      },
      limit(n: number) {
        call.limit = n;
        return builder;
      },
      single() {
        return respond("single");
      },
      maybeSingle() {
        return respond("maybe");
      },
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ): Promise<unknown> {
        return respond("list").then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { client: { from: build } as unknown as SupabaseClient, calls, data };
}

function taskRow(overrides: Row = {}): Row {
  return {
    id: "review-1",
    user_id: "user-1",
    title: "Review: Sign errors",
    course: null,
    kind: "review",
    due_at: "2026-10-31T15:59:00.000Z",
    effort: "small",
    status: "open",
    origin: "weak_spot",
    source_upload_id: null,
    weak_spot_id: "spot-1",
    created_at: "2026-10-28T01:00:00.000Z",
    updated_at: "2026-10-28T01:00:00.000Z",
    ...overrides,
  };
}

describe("setWeakSpotNextReview", () => {
  test("writes the next review instant, filtered by BOTH ids", async () => {
    const db = makeDb({ weak_spots: [{ id: "spot-1", user_id: "user-1", next_review_at: null }] });
    const q = createWeakSpotQueries(db.client);
    const row = await q.setWeakSpotNextReview("user-1", "spot-1", new Date("2026-10-31T15:59:00.000Z"));
    expect(row.next_review_at).toBe("2026-10-31T15:59:00.000Z");
    expect(db.data.weak_spots[0].next_review_at).toBe("2026-10-31T15:59:00.000Z");
    expect(db.calls[0].filters).toContainEqual({ op: "eq", column: "id", value: "spot-1" });
    expect(db.calls[0].filters).toContainEqual({ op: "eq", column: "user_id", value: "user-1" });
  });

  test("null clears the schedule", async () => {
    const db = makeDb({
      weak_spots: [{ id: "spot-1", user_id: "user-1", next_review_at: "2026-10-31T15:59:00.000Z" }],
    });
    const q = createWeakSpotQueries(db.client);
    const row = await q.setWeakSpotNextReview("user-1", "spot-1", null);
    expect(row.next_review_at).toBeNull();
  });

  test("someone else's weak spot fails with a clear error", async () => {
    const db = makeDb({ weak_spots: [{ id: "spot-1", user_id: "user-2", next_review_at: null }] });
    const q = createWeakSpotQueries(db.client);
    expect(q.setWeakSpotNextReview("user-1", "spot-1", new Date())).rejects.toThrow(
      /db setWeakSpotNextReview failed/,
    );
  });
});

describe("findOpenReviewTask", () => {
  test("newest open review for the weak spot, scoped by user", async () => {
    const db = makeDb({
      tasks: [
        taskRow({ id: "old", created_at: "2026-10-27T01:00:00.000Z" }),
        taskRow({ id: "new", created_at: "2026-10-28T09:00:00.000Z" }),
        taskRow({ id: "done", status: "done", created_at: "2026-10-29T09:00:00.000Z" }),
        taskRow({ id: "practice", kind: "math_practice", created_at: "2026-10-30T09:00:00.000Z" }),
        taskRow({ id: "other-user", user_id: "user-2", created_at: "2026-10-31T09:00:00.000Z" }),
        taskRow({ id: "other-spot", weak_spot_id: "spot-2", created_at: "2026-10-31T09:00:00.000Z" }),
      ],
    });
    const q = createWeakSpotQueries(db.client);
    const task = await q.findOpenReviewTask("user-1", "spot-1");
    expect(task?.id).toBe("new");
    const call = db.calls[0];
    expect(call.filters).toContainEqual({ op: "eq", column: "user_id", value: "user-1" });
    expect(call.filters).toContainEqual({ op: "eq", column: "weak_spot_id", value: "spot-1" });
    expect(call.filters).toContainEqual({ op: "eq", column: "kind", value: "review" });
    expect(call.filters).toContainEqual({ op: "eq", column: "status", value: "open" });
    expect(call.orders[0]).toEqual({ column: "created_at", options: { ascending: false } });
    expect(call.limit).toBe(1);
  });

  test("no open review means null", async () => {
    const db = makeDb({ tasks: [taskRow({ status: "done" })] });
    const q = createWeakSpotQueries(db.client);
    expect(await q.findOpenReviewTask("user-1", "spot-1")).toBeNull();
  });
});

describe("listOpenReviewTasksByWeakSpot", () => {
  test("empty id list skips the query entirely", async () => {
    const db = makeDb({});
    const q = createWeakSpotQueries(db.client);
    expect(await q.listOpenReviewTasksByWeakSpot("user-1", [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  test("open reviews for the given spots only, scoped by user, newest first", async () => {
    const db = makeDb({
      tasks: [
        taskRow({ id: "newer", created_at: "2026-10-28T09:00:00.000Z" }),
        taskRow({ id: "older", created_at: "2026-10-27T01:00:00.000Z" }),
        taskRow({ id: "done", status: "done" }),
        taskRow({ id: "other-user", user_id: "user-2" }),
        taskRow({ id: "elsewhere", weak_spot_id: "spot-9" }),
      ],
    });
    const q = createWeakSpotQueries(db.client);
    const tasks = await q.listOpenReviewTasksByWeakSpot("user-1", ["spot-1", "spot-2"]);
    expect(tasks.map((t) => t.id)).toEqual(["newer", "older"]);
    const call = db.calls[0];
    expect(call.filters).toContainEqual({ op: "eq", column: "user_id", value: "user-1" });
    expect(call.filters).toContainEqual({ op: "in", column: "weak_spot_id", value: ["spot-1", "spot-2"] });
    expect(call.filters).toContainEqual({ op: "eq", column: "kind", value: "review" });
    expect(call.filters).toContainEqual({ op: "eq", column: "status", value: "open" });
  });
});
