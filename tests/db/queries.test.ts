import { describe, expect, mock, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StarterRow, TaskRow, WeakSpotRow } from "../../lib/db/types";

// lib/db transitively imports "server-only", which throws outside a React
// Server Component runtime. Neutralize it, then load the real query module.
mock.module("server-only", () => ({}));

const { createQueries } = await import("../../lib/db/queries");

type FakeError = { message: string; code?: string; details?: string | null; hint?: string | null };
type FakeReply = { data?: unknown; error?: FakeError | null; count?: number | null };

type RecordedCall = {
  table: string;
  method: "select" | "insert" | "upsert" | "update";
  payload: unknown;
  upsertOptions: Record<string, unknown> | undefined;
  selectColumns: string | undefined;
  selectOptions: Record<string, unknown> | undefined;
  filters: { op: string; column: string; value: unknown }[];
  order: { column: string; options: Record<string, unknown> | undefined } | null;
  limit: number | null;
};

// Minimal chainable stand-in for the PostgREST builder: records every call and
// resolves through the test-provided replyFor(call).
function makeFakeClient(replyFor: (call: RecordedCall) => FakeReply): SupabaseClient {
  function build(table: string) {
    const call: RecordedCall = {
      table,
      method: "select",
      payload: undefined,
      upsertOptions: undefined,
      selectColumns: undefined,
      selectOptions: undefined,
      filters: [],
      order: null,
      limit: null,
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
      upsert(payload: unknown, options?: Record<string, unknown>) {
        call.method = "upsert";
        call.payload = payload;
        call.upsertOptions = options;
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
      lt: filter("lt"),
      is: filter("is"),
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

  return { from: build } as unknown as SupabaseClient;
}

describe("markUpdateSeen", () => {
  test("returns true the first time", async () => {
    const q = createQueries(makeFakeClient(() => ({ data: null })));
    expect(await q.markUpdateSeen(101)).toBe(true);
  });

  test("returns false on duplicate PK (23505)", async () => {
    const q = createQueries(
      makeFakeClient(() => ({ error: { code: "23505", message: "duplicate key value" } }))
    );
    expect(await q.markUpdateSeen(101)).toBe(false);
  });

  test("throws on any other error", async () => {
    const q = createQueries(
      makeFakeClient(() => ({ error: { code: "42501", message: "permission denied" } }))
    );
    expect(q.markUpdateSeen(101)).rejects.toThrow(/markUpdateSeen/);
  });
});

describe("updateTask", () => {
  test("filters by both id and user_id and sets updated_at", async () => {
    const seen: RecordedCall[] = [];
    const row: TaskRow = {
      id: "task-1",
      user_id: "user-1",
      title: "CS2100 assignment 2",
      course: "CS2100",
      kind: "assignment",
      due_at: "2026-11-02T15:59:00.000Z",
      effort: "medium",
      status: "done",
      origin: "capture",
      source_upload_id: null,
      weak_spot_id: null,
      created_at: "2026-10-30T00:00:00.000Z",
      updated_at: "2026-10-30T01:00:00.000Z",
    };
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: row };
      })
    );

    const out = await q.updateTask("task-1", "user-1", { status: "done" });
    expect(out).toEqual(row);

    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.table).toBe("tasks");
    expect(call.method).toBe("update");
    expect(call.filters).toEqual([
      { op: "eq", column: "id", value: "task-1" },
      { op: "eq", column: "user_id", value: "user-1" },
    ]);
    const payload = call.payload as Record<string, unknown>;
    expect(payload.status).toBe("done");
    expect(typeof payload.updated_at).toBe("string");
  });
});

describe("consumeLoginToken", () => {
  const now = new Date("2026-10-30T03:00:00Z");

  test("returns userId when the token matched", async () => {
    const seen: RecordedCall[] = [];
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: { user_id: "user-9" } };
      })
    );

    expect(await q.consumeLoginToken("hash-1", now)).toEqual({ userId: "user-9" });

    const call = seen[0];
    expect(call.table).toBe("login_tokens");
    expect(call.method).toBe("update");
    expect(call.filters).toEqual([
      { op: "eq", column: "token_hash", value: "hash-1" },
      { op: "is", column: "used_at", value: null },
      { op: "gt", column: "expires_at", value: now.toISOString() },
    ]);
    expect(call.payload).toEqual({ used_at: now.toISOString() });
    expect(call.selectColumns).toBe("user_id");
  });

  test("returns null when no row matched", async () => {
    const q = createQueries(makeFakeClient(() => ({ data: null })));
    expect(await q.consumeLoginToken("hash-miss", now)).toBeNull();
  });
});

describe("upsertWeakSpot", () => {
  const now = new Date("2026-10-30T10:00:00+08:00");
  const next = new Date("2026-11-02T10:00:00+08:00");

  test("increments occurrences on the existing row", async () => {
    const seen: RecordedCall[] = [];
    const existing = {
      id: "ws-1",
      user_id: "user-1",
      topic: "sign_errors",
      latest_misconception: "dropped minus",
      occurrences: 3,
      last_seen_at: "2026-10-01T00:00:00.000Z",
      next_review_at: null,
    };
    const updated = {
      ...existing,
      latest_misconception: "sign flip in step 2",
      occurrences: 4,
      last_seen_at: now.toISOString(),
      next_review_at: next.toISOString(),
    };
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return c.method === "select" ? { data: existing } : { data: updated };
      })
    );

    const out = await q.upsertWeakSpot({
      userId: "user-1",
      topic: "sign_errors",
      misconception: "sign flip in step 2",
      now,
      nextReviewAt: next,
    });
    expect(out).toEqual(updated);

    expect(seen).toHaveLength(2);
    const updateCall = seen[1];
    expect(updateCall.method).toBe("update");
    expect(updateCall.filters).toEqual([{ op: "eq", column: "id", value: "ws-1" }]);
    expect(updateCall.payload).toEqual({
      latest_misconception: "sign flip in step 2",
      occurrences: 4,
      last_seen_at: now.toISOString(),
      next_review_at: next.toISOString(),
    });
  });

  test("inserts with occurrences 1 when no row exists", async () => {
    const seen: RecordedCall[] = [];
    const row: WeakSpotRow = {
      id: "ws-2",
      user_id: "user-1",
      topic: "fractions",
      latest_misconception: "added denominators",
      occurrences: 1,
      last_seen_at: now.toISOString(),
      next_review_at: null,
    };
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return c.method === "select" ? { data: null } : { data: row };
      })
    );

    const out = await q.upsertWeakSpot({
      userId: "user-1",
      topic: "fractions",
      misconception: "added denominators",
      now,
      nextReviewAt: null,
    });
    expect(out).toEqual(row);

    const insertCall = seen[1];
    expect(insertCall.method).toBe("upsert");
    expect(insertCall.upsertOptions).toEqual({ onConflict: "user_id,topic" });
    expect(insertCall.payload).toMatchObject({ occurrences: 1, topic: "fractions" });
  });
});

describe("todaysAiSpend", () => {
  test("sums cost_usd since SGT midnight, tolerating null and string values", async () => {
    const seen: RecordedCall[] = [];
    const now = new Date("2026-10-30T03:30:00Z"); // 11:30 SGT
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: [{ cost_usd: 0.01 }, { cost_usd: "0.0025" }, { cost_usd: null }] };
      })
    );

    expect(await q.todaysAiSpend(now)).toBeCloseTo(0.0125, 10);
    // 2026-10-30 00:00 SGT == 2026-10-29 16:00 UTC
    expect(seen[0].filters).toEqual([
      { op: "gte", column: "created_at", value: "2026-10-29T16:00:00.000Z" },
    ]);
  });

  test("returns 0 when there are no calls", async () => {
    const q = createQueries(makeFakeClient(() => ({ data: [] })));
    expect(await q.todaysAiSpend(new Date("2026-10-30T03:30:00Z"))).toBe(0);
  });
});

describe("countUploadsLastHour", () => {
  test("counts uploads with a head+exact select in the last hour", async () => {
    const seen: RecordedCall[] = [];
    const now = new Date("2026-10-30T03:30:00Z");
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null, count: 7 };
      })
    );

    expect(await q.countUploadsLastHour("user-1", now)).toBe(7);

    const call = seen[0];
    expect(call.table).toBe("uploads");
    expect(call.selectOptions).toEqual({ count: "exact", head: true });
    expect(call.filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "gte", column: "created_at", value: "2026-10-30T02:30:00.000Z" },
    ]);
  });

  test("returns 0 when count is missing", async () => {
    const q = createQueries(makeFakeClient(() => ({ data: null, count: null })));
    expect(await q.countUploadsLastHour("user-1")).toBe(0);
  });
});

describe("upsertUser", () => {
  test("upserts on telegram_user_id with chat id and first name", async () => {
    const seen: RecordedCall[] = [];
    const row = {
      id: "u-1",
      telegram_user_id: 777,
      telegram_chat_id: 888,
      first_name: "Wei Ming",
      timezone: "Asia/Singapore",
      terms_accepted_at: null,
      terms_version: null,
      created_at: "2026-10-30T00:00:00.000Z",
    };
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: row };
      })
    );

    const out = await q.upsertUser({ telegramUserId: 777, telegramChatId: 888, firstName: "Wei Ming" });
    expect(out).toEqual(row);

    const call = seen[0];
    expect(call.table).toBe("users");
    expect(call.method).toBe("upsert");
    expect(call.upsertOptions).toEqual({ onConflict: "telegram_user_id" });
    expect(call.payload).toEqual({
      telegram_user_id: 777,
      telegram_chat_id: 888,
      first_name: "Wei Ming",
    });
  });
});

describe("listOpenTasks", () => {
  test("filters user + open and orders by due_at with nulls last", async () => {
    const seen: RecordedCall[] = [];
    const taskA: TaskRow = {
      id: "t-1",
      user_id: "user-1",
      title: "Math quiz revision",
      course: null,
      kind: "test",
      due_at: "2026-10-31T15:59:00.000Z",
      effort: null,
      status: "open",
      origin: "capture",
      source_upload_id: null,
      weak_spot_id: null,
      created_at: "2026-10-30T00:00:00.000Z",
      updated_at: "2026-10-30T00:00:00.000Z",
    };
    const taskB: TaskRow = { ...taskA, id: "t-2", title: "Read history chapter", kind: "reading", due_at: null };
    const tasks: TaskRow[] = [taskA, taskB];
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: tasks };
      })
    );

    expect(await q.listOpenTasks("user-1")).toEqual(tasks);

    const call = seen[0];
    expect(call.table).toBe("tasks");
    expect(call.filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "status", value: "open" },
    ]);
    expect(call.order).toEqual({
      column: "due_at",
      options: { ascending: true, nullsFirst: false },
    });
  });
});

describe("getStarter", () => {
  test("takes the latest row via order desc + limit 1 + maybeSingle", async () => {
    const seen: RecordedCall[] = [];
    const starter: StarterRow = {
      id: "s-1",
      task_id: "t-1",
      type: "checklist",
      content: { items: [] },
      annotated_image_path: null,
      created_at: "2026-10-30T01:00:00.000Z",
    };
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: starter };
      })
    );

    expect(await q.getStarter("t-1")).toEqual(starter);

    const call = seen[0];
    expect(call.table).toBe("starters");
    expect(call.filters).toEqual([{ op: "eq", column: "task_id", value: "t-1" }]);
    expect(call.order).toEqual({ column: "created_at", options: { ascending: false } });
    expect(call.limit).toBe(1);
  });

  test("returns null when there is no starter", async () => {
    const q = createQueries(makeFakeClient(() => ({ data: null })));
    expect(await q.getStarter("t-none")).toBeNull();
  });
});

describe("finishUpload", () => {
  test("writes only the provided patch keys", async () => {
    const seen: RecordedCall[] = [];
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      })
    );

    await q.finishUpload("up-1", { status: "failed", error: "boom" });

    const call = seen[0];
    expect(call.table).toBe("uploads");
    expect(call.method).toBe("update");
    expect(call.filters).toEqual([{ op: "eq", column: "id", value: "up-1" }]);
    expect(call.payload).toEqual({ status: "failed", error: "boom" });
  });
});

// Shared by the terms-semantics and getUserById assertions below.
const row = {
  id: "u-9",
  telegram_user_id: 42,
  telegram_chat_id: 42,
  first_name: "Tim",
  timezone: "Asia/Singapore",
  terms_accepted_at: "2026-10-31T01:00:00.000Z",
  terms_version: "2026-11-01",
  created_at: "2026-10-30T00:00:00.000Z",
};

describe("upsertUser terms semantics", () => {
  test("an upsert WITHOUT terms fields never writes them, so it cannot clear an acceptance", async () => {
    const seen: RecordedCall[] = [];
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: row };
      })
    );
    await q.upsertUser({ telegramUserId: 42, telegramChatId: 42, firstName: "Tim" });
    expect(seen[0].payload).toEqual({
      telegram_user_id: 42,
      telegram_chat_id: 42,
      first_name: "Tim",
    });
    expect(JSON.stringify(seen[0].payload)).not.toContain("terms_accepted_at");
    expect(JSON.stringify(seen[0].payload)).not.toContain("terms_version");
  });

  test("an upsert WITH terms fields writes both, timestamp as ISO", async () => {
    const seen: RecordedCall[] = [];
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: row };
      })
    );
    await q.upsertUser({
      telegramUserId: 42,
      telegramChatId: 42,
      firstName: "Tim",
      termsAcceptedAt: new Date("2026-10-31T09:00:00.000Z"),
      termsVersion: "2026-11-01",
    });
    expect(seen[0].payload).toEqual({
      telegram_user_id: 42,
      telegram_chat_id: 42,
      first_name: "Tim",
      terms_accepted_at: "2026-10-31T09:00:00.000Z",
      terms_version: "2026-11-01",
    });
  });

  test("an upsert with only the timestamp omits the version, and vice versa", async () => {
    const seen: RecordedCall[] = [];
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: row };
      })
    );
    await q.upsertUser({
      telegramUserId: 42,
      telegramChatId: 42,
      firstName: null,
      termsAcceptedAt: new Date("2026-10-31T09:00:00.000Z"),
    });
    expect(seen[0].payload).toHaveProperty("terms_accepted_at");
    expect(seen[0].payload).not.toHaveProperty("terms_version");
  });
});

describe("getUserById", () => {
  test("selects by id only and returns null for no row", async () => {
    const seen: RecordedCall[] = [];
    const q = createQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      })
    );
    expect(await q.getUserById("nope")).toBeNull();
    expect(seen[0].table).toBe("users");
    expect(seen[0].filters).toEqual([{ op: "eq", column: "id", value: "nope" }]);
  });

  test("returns the row when it exists", async () => {
    const q = createQueries(
      makeFakeClient(() => ({ data: row }))
    );
    expect(await q.getUserById("u-9")).toEqual(row);
  });
});
