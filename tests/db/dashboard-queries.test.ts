import { describe, expect, mock, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/db imports "server-only", which throws outside a React Server Component
// runtime. Neutralize it, then load the real query module.
mock.module("server-only", () => ({}));

const { createDashboardQueries } = await import("../../lib/db/dashboard-queries");

type Row = Record<string, unknown>;

type RecordedCall = {
  table: string;
  method: string;
  payload?: unknown;
  filters: Array<{ op: string; column: string; value: unknown }>;
  orders: Array<{ column: string; options: Record<string, unknown> | undefined }>;
  limit: number | null;
  orExpr: string | null;
};

// Fake PostgREST builder that actually applies eq/in/or/order/limit against
// in-memory rows, so ownership filters and ordering are under test, not just
// recorded. The or() shape supported is the one the dashboard uses:
// status.eq.open,or(status.eq.done,updated_at.gte.<iso>).
function makeDb(tables: { tasks?: Row[]; task_events?: Row[]; starters?: Row[]; weak_spots?: Row[] }) {
  const data: Record<string, Row[]> = {
    tasks: tables.tasks ?? [],
    task_events: tables.task_events ?? [],
    starters: tables.starters ?? [],
    weak_spots: tables.weak_spots ?? [],
  };
  const calls: RecordedCall[] = [];

  function build(table: string) {
    const call: RecordedCall = {
      table,
      method: "select",
      filters: [],
      orders: [],
      limit: null,
      orExpr: null,
    };
    calls.push(call);

    const matches = (row: Row): boolean =>
      call.filters.every((f) => {
        if (f.op === "eq") return row[f.column] === f.value;
        if (f.op === "in") return (f.value as unknown[]).includes(row[f.column]);
        return true;
      });

    const applyOr = (rows: Row[]): Row[] => {
      if (call.orExpr == null) return rows;
      const sinceMatch = /updated_at\.gte\.([0-9T:.+\-Z]+)/.exec(call.orExpr);
      if (sinceMatch == null) throw new Error(`fake: unsupported or expression: ${call.orExpr}`);
      const since = Date.parse(sinceMatch[1]);
      return rows.filter(
        (row) =>
          row.status === "open" ||
          (row.status === "done" && Date.parse(String(row.updated_at)) >= since),
      );
    };

    const applyOrders = (rows: Row[]): Row[] => {
      let out = rows;
      // PostgREST treats the first order param as primary and the rest as
      // tiebreakers, so apply them from least significant first.
      for (const { column, options } of [...call.orders].reverse()) {
        const ascending = options?.ascending !== false;
        const nullsFirst = options?.nullsFirst === true;
        out = [...out].sort((a, b) => {
          const av = a[column];
          const bv = b[column];
          if (av == null && bv == null) return 0;
          if (av == null) return nullsFirst ? -1 : 1;
          if (bv == null) return nullsFirst ? 1 : -1;
          const an = typeof av === "number" ? av : Date.parse(String(av));
          const bn = typeof bv === "number" ? bv : Date.parse(String(bv));
          if (!Number.isNaN(an) && !Number.isNaN(bn) && an !== bn) {
            return ascending ? an - bn : bn - an;
          }
          return 0;
        });
      }
      return out;
    };

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
      let rows = applyOrders(applyOr((data[table] ?? []).filter(matches))).map((row) => ({ ...row }));
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
      select(columns?: string) {
        void columns;
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
      or(expr: string) {
        call.orExpr = expr;
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

const HOUR = 60 * 60 * 1000;

function row(overrides: Row = {}): Row {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    user_id: "user-1",
    title: "CS2040 Lab 4",
    course: "CS2040",
    kind: "assignment",
    due_at: null,
    effort: "medium",
    status: "open",
    origin: "capture",
    source_upload_id: null,
    weak_spot_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("listDashboardTasks", () => {
  test("open tasks plus recently done, scoped to the user, due asc, limit 200", async () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * HOUR).toISOString();
    const db = makeDb({
      tasks: [
        row({ id: "later", due_at: "2026-12-01T00:00:00.000Z" }),
        row({ id: "sooner", due_at: "2026-11-05T00:00:00.000Z" }),
        row({ id: "no-due", due_at: null }),
        row({ id: "recent-done", status: "done", updated_at: recent }),
        row({ id: "old-done", status: "done", updated_at: old }),
        row({ id: "dismissed", status: "dismissed" }),
        row({ id: "someone-else", user_id: "user-2" }),
      ],
    });
    const q = createDashboardQueries(db.client);
    const tasks = await q.listDashboardTasks("user-1");
    expect(tasks.map((t) => t.id)).toEqual(["sooner", "later", "no-due", "recent-done"]);
    const call = db.calls[0];
    expect(call.table).toBe("tasks");
    expect(call.filters).toContainEqual({ op: "eq", column: "user_id", value: "user-1" });
    expect(call.orExpr).toContain("status.eq.open");
    expect(call.orExpr).toContain("status.eq.done");
    expect(call.orExpr).toContain("updated_at.gte.");
    expect(call.orders[0].column).toBe("due_at");
    expect(call.orders[0].options?.ascending).toBe(true);
    expect(call.orders[0].options?.nullsFirst).toBe(false);
    expect(call.limit).toBe(200);
  });
});

describe("getTaskForUser", () => {
  test("filters by BOTH ids", async () => {
    const db = makeDb({ tasks: [row({ id: "task-1", user_id: "user-1" })] });
    const q = createDashboardQueries(db.client);
    expect((await q.getTaskForUser("user-1", "task-1"))?.id).toBe("task-1");
    expect(await q.getTaskForUser("user-2", "task-1")).toBeNull();
    expect(await q.getTaskForUser("user-1", "task-9")).toBeNull();
    expect(db.calls[2].filters).toContainEqual({ op: "eq", column: "id", value: "task-9" });
    expect(db.calls[2].filters).toContainEqual({ op: "eq", column: "user_id", value: "user-1" });
  });
});

describe("listTaskEvents", () => {
  test("throws when the task does not belong to the user", async () => {
    const db = makeDb({ tasks: [row({ user_id: "user-2" })] });
    const q = createDashboardQueries(db.client);
    expect(q.listTaskEvents("user-1", "task-1")).rejects.toThrow(/not found for this user/);
  });

  test("newest first for an owned task", async () => {
    const db = makeDb({
      tasks: [row()],
      task_events: [
        { id: "old", task_id: "task-1", created_at: "2026-10-30T01:00:00.000Z" },
        { id: "new", task_id: "task-1", created_at: "2026-11-01T01:00:00.000Z" },
      ],
    });
    const q = createDashboardQueries(db.client);
    const events = await q.listTaskEvents("user-1", "task-1");
    expect(events.map((e) => e.id)).toEqual(["new", "old"]);
    expect(db.calls[1].orders[0]).toEqual({
      column: "created_at",
      options: { ascending: false },
    });
  });
});

describe("listLatestEventsForTasks", () => {
  test("one newest event per task, non owned ids dropped", async () => {
    const db = makeDb({
      tasks: [row({ id: "task-1" }), row({ id: "task-2" })],
      task_events: [
        { id: "e1", task_id: "task-1", created_at: "2026-10-30T01:00:00.000Z" },
        { id: "e2", task_id: "task-1", created_at: "2026-11-01T01:00:00.000Z" },
        { id: "e3", task_id: "task-2", created_at: "2026-11-02T01:00:00.000Z" },
        { id: "e4", task_id: "task-3", created_at: "2026-11-03T01:00:00.000Z" },
      ],
    });
    const q = createDashboardQueries(db.client);
    const events = await q.listLatestEventsForTasks("user-1", ["task-1", "task-2", "task-3"]);
    expect(events.map((e) => e.id).sort()).toEqual(["e2", "e3"]);
  });

  test("no task ids means no queries", async () => {
    const db = makeDb({});
    const q = createDashboardQueries(db.client);
    expect(await q.listLatestEventsForTasks("user-1", [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });
});

describe("getStarterForTask", () => {
  test("returns null when the task is not owned", async () => {
    const db = makeDb({ tasks: [row({ user_id: "user-2" })] });
    const q = createDashboardQueries(db.client);
    expect(await q.getStarterForTask("user-1", "task-1")).toBeNull();
  });

  test("latest starter wins", async () => {
    const db = makeDb({
      tasks: [row()],
      starters: [
        { id: "old", task_id: "task-1", type: "checklist", content: {}, created_at: "2026-10-30T01:00:00.000Z" },
        { id: "new", task_id: "task-1", type: "checklist", content: {}, created_at: "2026-11-01T01:00:00.000Z" },
      ],
    });
    const q = createDashboardQueries(db.client);
    const found = await q.getStarterForTask("user-1", "task-1");
    expect(found?.id).toBe("new");
    expect(db.calls[1].limit).toBe(1);
  });
});

describe("listStudyDecks", () => {
  test("flashcards decks for open or recent tasks, latest starter per task", async () => {
    const recent = new Date().toISOString();
    const db = makeDb({
      tasks: [
        row({ id: "deck-task", due_at: "2026-11-05T00:00:00.000Z" }),
        row({ id: "no-starter", due_at: "2026-11-06T00:00:00.000Z" }),
        row({ id: "recent-done", status: "done", updated_at: recent, due_at: "2026-11-01T00:00:00.000Z" }),
      ],
      starters: [
        { id: "deck-old", task_id: "deck-task", type: "flashcards", content: {}, created_at: "2026-10-30T01:00:00.000Z" },
        { id: "deck-new", task_id: "deck-task", type: "flashcards", content: {}, created_at: "2026-11-01T01:00:00.000Z" },
        { id: "checklist", task_id: "recent-done", type: "checklist", content: {}, created_at: "2026-11-01T01:00:00.000Z" },
      ],
    });
    const q = createDashboardQueries(db.client);
    const decks = await q.listStudyDecks("user-1");
    expect(decks).toHaveLength(1);
    expect(decks[0].task.id).toBe("deck-task");
    expect(decks[0].starter.id).toBe("deck-new");
  });

  test("no tasks means no decks", async () => {
    const db = makeDb({ tasks: [] });
    const q = createDashboardQueries(db.client);
    expect(await q.listStudyDecks("user-1")).toEqual([]);
  });
});

describe("listWeakSpotsForUser", () => {
  test("scoped to user, occurrences desc then last seen desc", async () => {
    const db = makeDb({
      weak_spots: [
        { id: "one", user_id: "user-1", occurrences: 1, last_seen_at: "2026-11-05T01:00:00.000Z" },
        { id: "three", user_id: "user-1", occurrences: 3, last_seen_at: "2026-11-01T01:00:00.000Z" },
        { id: "two", user_id: "user-1", occurrences: 2, last_seen_at: "2026-11-06T01:00:00.000Z" },
        { id: "other", user_id: "user-2", occurrences: 9, last_seen_at: "2026-11-06T01:00:00.000Z" },
      ],
    });
    const q = createDashboardQueries(db.client);
    const spots = await q.listWeakSpotsForUser("user-1");
    expect(spots.map((s) => s.id)).toEqual(["three", "two", "one"]);
  });
});

describe("updateStarterContent", () => {
  test("throws when the task is not owned", async () => {
    const db = makeDb({ tasks: [row({ user_id: "user-2" })] });
    const q = createDashboardQueries(db.client);
    expect(q.updateStarterContent("user-1", "task-1", "starter-1", {})).rejects.toThrow(
      /not found for this user/,
    );
  });

  test("saves content and throws when the starter is not on the task", async () => {
    const db = makeDb({
      tasks: [row()],
      starters: [{ id: "starter-1", task_id: "task-1", type: "checklist", content: { items: [] } }],
    });
    const q = createDashboardQueries(db.client);
    const next = { items: [{ id: "a", done: true }] };
    await q.updateStarterContent("user-1", "task-1", "starter-1", next);
    expect(db.data.starters[0].content).toEqual(next);
    expect(q.updateStarterContent("user-1", "task-1", "starter-9", next)).rejects.toThrow(
      /not found for this task/,
    );
  });
});

describe("setTaskStatusForUser", () => {
  test("sets status and updated_at, scoped by both ids", async () => {
    const db = makeDb({ tasks: [row({ status: "open", updated_at: "2026-10-01T00:00:00.000Z" })] });
    const q = createDashboardQueries(db.client);
    const updated = await q.setTaskStatusForUser("user-1", "task-1", "done");
    expect(updated.status).toBe("done");
    expect(db.data.tasks[0].status).toBe("done");
    expect(new Date(String(db.data.tasks[0].updated_at)).getTime()).toBeGreaterThan(
      Date.parse("2026-10-01T00:00:00.000Z"),
    );
  });

  test("a task that is not ours fails with a clear error", async () => {
    const db = makeDb({ tasks: [row({ user_id: "user-2" })] });
    const q = createDashboardQueries(db.client);
    expect(q.setTaskStatusForUser("user-1", "task-1", "done")).rejects.toThrow(
      /not found for this user/,
    );
  });
});
