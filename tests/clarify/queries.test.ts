import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaskRow } from "../../lib/db/types";
import { createPendingActionsQueries } from "../../lib/clarify/queries";
import type { PendingActionInput, PendingActionRow } from "../../lib/clarify/types";

// Minimal chainable stand-in for the PostgREST builder, in the same style as
// tests/db/queries.test.ts: every call is recorded and the test-provided
// replyFor decides what comes back.
type FakeError = { message: string; code?: string };
type FakeReply = { data?: unknown; error?: FakeError | null };

type RecordedCall = {
  table: string;
  method: "select" | "insert" | "update";
  payload: unknown;
  filters: { op: string; column: string; value: unknown }[];
  single: boolean;
};

function makeFakeClient(replyFor: (call: RecordedCall) => FakeReply): SupabaseClient {
  function build(table: string) {
    const call: RecordedCall = { table, method: "select", payload: undefined, filters: [], single: false };
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
      select() {
        // Keeps whatever insert/update recorded; only reads start as select.
        return builder;
      },
      eq: filter("eq"),
      gt: filter("gt"),
      single() {
        call.single = true;
        return respond(false);
      },
      maybeSingle() {
        call.single = false;
        return respond(true);
      },
      // A bare update chain (no select) is awaited directly, so the builder
      // itself must be thenable.
      then(
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ): Promise<unknown> {
        return respond(true).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }
  return { from: build } as unknown as SupabaseClient;
}

const NOW = new Date("2026-10-31T09:00:00+08:00");

const createInput: PendingActionInput = {
  userId: "user-1",
  uploadId: "upload-1",
  kind: "create",
  taskId: null,
  payload: {
    title: "MA2001 Quiz 2",
    course: "MA2001",
    kind: "test",
    dueAt: "2026-11-10T15:59:00.000Z",
    effort: null,
    evidence: "got quiz 2 on tue",
  },
};

const row: PendingActionRow = {
  id: "pending-1",
  user_id: "user-1",
  upload_id: "upload-1",
  kind: "create",
  task_id: null,
  payload: createInput.payload,
  status: "pending",
  expires_at: "2026-11-01T01:00:00.000Z",
  created_at: "2026-10-31T01:00:00.000Z",
  resolved_at: null,
};

describe("pending_actions queries", () => {
  test("insert stores user, upload, kind, task and payload", async () => {
    let seen: RecordedCall | undefined;
    const client = makeFakeClient((call) => {
      seen = call;
      return { data: row };
    });
    const q = createPendingActionsQueries(client);
    const out = await q.insertPendingAction(createInput);
    expect(out).toEqual(row);
    expect(seen?.table).toBe("pending_actions");
    expect(seen?.method).toBe("insert");
    expect(seen?.payload).toEqual({
      user_id: "user-1",
      upload_id: "upload-1",
      kind: "create",
      task_id: null,
      payload: createInput.payload,
    });
  });

  test("insert maps a missing upload to null instead of an empty string", async () => {
    let seen: RecordedCall | undefined;
    const client = makeFakeClient((call) => {
      seen = call;
      return { data: { ...row, upload_id: null } };
    });
    const q = createPendingActionsQueries(client);
    await q.insertPendingAction({ ...createInput, uploadId: null });
    expect((seen?.payload as { upload_id: unknown }).upload_id).toBeNull();
  });

  test("getPendingAction is scoped by id and user_id", async () => {
    let seen: RecordedCall | undefined;
    const client = makeFakeClient((call) => {
      seen = call;
      return { data: row };
    });
    const q = createPendingActionsQueries(client);
    expect(await q.getPendingAction("pending-1", "user-1")).toEqual(row);
    expect(seen?.filters).toEqual([
      { op: "eq", column: "id", value: "pending-1" },
      { op: "eq", column: "user_id", value: "user-1" },
    ]);
  });

  test("claim updates only this user's pending, unexpired row and returns it", async () => {
    let seen: RecordedCall | undefined;
    const client = makeFakeClient((call) => {
      seen = call;
      return { data: { ...row, status: "accepted", resolved_at: NOW.toISOString() } };
    });
    const q = createPendingActionsQueries(client);
    const claimed = await q.claimPendingAction("pending-1", "user-1", "accepted", NOW);
    expect(claimed?.status).toBe("accepted");
    expect(seen?.method).toBe("update");
    expect(seen?.payload).toEqual({ status: "accepted", resolved_at: NOW.toISOString() });
    expect(seen?.filters).toEqual([
      { op: "eq", column: "id", value: "pending-1" },
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "status", value: "pending" },
      { op: "gt", column: "expires_at", value: NOW.toISOString() },
    ]);
  });

  test("claim returns null when the update matched zero rows (double tap or expired)", async () => {
    const client = makeFakeClient(() => ({ data: null }));
    const q = createPendingActionsQueries(client);
    expect(await q.claimPendingAction("pending-1", "user-1", "dismissed", NOW)).toBeNull();
  });

  test("reset hands the row back to pending, scoped by user, clearing resolved_at", async () => {
    let seen: RecordedCall | undefined;
    const client = makeFakeClient((call) => {
      seen = call;
      return { data: null };
    });
    const q = createPendingActionsQueries(client);
    await q.resetPendingAction("pending-1", "user-1");
    expect(seen?.method).toBe("update");
    expect(seen?.payload).toEqual({ status: "pending", resolved_at: null });
    expect(seen?.filters).toEqual([
      { op: "eq", column: "id", value: "pending-1" },
      { op: "eq", column: "user_id", value: "user-1" },
    ]);
  });

  test("getOpenTask is scoped by id, user and open status", async () => {
    let seen: RecordedCall | undefined;
    const task = {
      id: "task-1",
      user_id: "user-1",
      title: "CS2030 Lab 4",
      course: null,
      kind: "assignment",
      due_at: null,
      effort: null,
      status: "open",
      origin: "capture",
      source_upload_id: null,
      weak_spot_id: null,
      created_at: "2026-10-30T01:00:00.000Z",
      updated_at: "2026-10-30T01:00:00.000Z",
    } satisfies TaskRow;
    const client = makeFakeClient((call) => {
      seen = call;
      return { data: task };
    });
    const q = createPendingActionsQueries(client);
    expect(await q.getOpenTask("task-1", "user-1")).toEqual(task);
    expect(seen?.table).toBe("tasks");
    expect(seen?.filters).toEqual([
      { op: "eq", column: "id", value: "task-1" },
      { op: "eq", column: "user_id", value: "user-1" },
      { op: "eq", column: "status", value: "open" },
    ]);
  });

  test("getUserByTelegramId filters by telegram_user_id and may find nobody", async () => {
    let seen: RecordedCall | undefined;
    const client = makeFakeClient((call) => {
      seen = call;
      return { data: null };
    });
    const q = createPendingActionsQueries(client);
    expect(await q.getUserByTelegramId(101)).toBeNull();
    expect(seen?.table).toBe("users");
    expect(seen?.filters).toEqual([{ op: "eq", column: "telegram_user_id", value: 101 }]);
  });

  test("a database error surfaces as a thrown db failure", async () => {
    const client = makeFakeClient(() => ({ error: { code: "42501", message: "permission denied" } }));
    const q = createPendingActionsQueries(client);
    await expect(q.insertPendingAction(createInput)).rejects.toThrow(
      "db insertPendingAction failed [42501]: permission denied",
    );
  });
});
