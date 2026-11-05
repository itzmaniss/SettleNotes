import { describe, expect, mock, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// lib/calendar transitively imports "server-only", which throws outside a
// React Server Component runtime. Neutralize it, then load the real module.
mock.module("server-only", () => ({}));

const { createCalendarQueries } = await import("../../lib/calendar/queries");
import { makeFakeClient, type RecordedCall } from "./fake-supabase";
import type { CalendarConnectionRow, CalendarEventLinkRow } from "../../lib/calendar/queries";

const CONNECTION: CalendarConnectionRow = {
  user_id: "user-1",
  google_calendar_id: "cal-1",
  refresh_token_enc: "enc-1",
  status: "active",
  sync_lock_until: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("calendar queries", () => {
  test("getConnection scopes by user and returns null when missing", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: CONNECTION };
      })
    );
    expect(await q.getConnection("user-1")).toEqual(CONNECTION);
    expect(seen[0].table).toBe("calendar_connections");
    expect(seen[0].filters).toEqual([{ op: "eq", column: "user_id", value: "user-1" }]);

    const missing = createCalendarQueries(makeFakeClient(() => ({ data: null })));
    expect(await missing.getConnection("user-1")).toBeNull();
  });

  test("upsertConnection writes on user_id conflict", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: CONNECTION };
      })
    );
    await q.upsertConnection({
      userId: "user-1",
      googleCalendarId: "cal-2",
      refreshTokenEnc: "enc-2",
      status: "active",
    });
    expect(seen[0].table).toBe("calendar_connections");
    expect(seen[0].method).toBe("upsert");
    expect(seen[0].upsertOptions).toEqual({ onConflict: "user_id" });
    expect(seen[0].payload).toMatchObject({
      user_id: "user-1",
      google_calendar_id: "cal-2",
      refresh_token_enc: "enc-2",
      status: "active",
    });
  });

  test("setConnectionStatus and deleteConnection scope by user", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      })
    );
    await q.setConnectionStatus("user-1", "needs_reconnect");
    expect(seen[0].payload).toMatchObject({ status: "needs_reconnect" });
    expect(seen[0].filters).toEqual([{ op: "eq", column: "user_id", value: "user-1" }]);

    await q.deleteConnection("user-1");
    expect(seen[1].method).toBe("delete");
    expect(seen[1].table).toBe("calendar_connections");
  });

  test("listLinks returns rows scoped by user, empty when none", async () => {
    const rows: CalendarEventLinkRow[] = [
      { task_id: "t1", user_id: "user-1", google_event_id: "ev-1", synced_hash: "h", synced_at: "" },
    ];
    const q = createCalendarQueries(makeFakeClient(() => ({ data: rows })));
    expect(await q.listLinks("user-1")).toEqual(rows);

    const empty = createCalendarQueries(makeFakeClient(() => ({ data: null })));
    expect(await empty.listLinks("user-1")).toEqual([]);
  });

  test("upsertLink writes on task_id conflict, deleteLink scopes by task", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: { task_id: "t1" } };
      })
    );
    await q.upsertLink({ taskId: "t1", userId: "user-1", googleEventId: "ev-1", syncedHash: "h" });
    expect(seen[0].table).toBe("calendar_event_links");
    expect(seen[0].method).toBe("upsert");
    expect(seen[0].upsertOptions).toEqual({ onConflict: "task_id" });
    expect(seen[0].payload).toMatchObject({ task_id: "t1", google_event_id: "ev-1", synced_hash: "h" });

    await q.deleteLink("t1");
    expect(seen[1].method).toBe("delete");
    expect(seen[1].filters).toEqual([{ op: "eq", column: "task_id", value: "t1" }]);
  });

  test("claimSyncLock sends one conditional update and returns true when a row updates", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: [{ user_id: "user-1" }] };
      })
    );
    const now = new Date("2026-11-01T00:00:00.000Z");
    expect(await q.claimSyncLock("user-1", now, 2 * 60 * 1000)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].table).toBe("calendar_connections");
    expect(seen[0].method).toBe("update");
    expect(seen[0].payload).toMatchObject({
      sync_lock_until: "2026-11-01T00:02:00.000Z",
    });
    expect(seen[0].filters).toEqual([
      { op: "eq", column: "user_id", value: "user-1" },
      {
        op: "or",
        column: "or",
        value: "sync_lock_until.is.null,sync_lock_until.lte.2026-11-01T00:00:00.000Z",
      },
    ]);
  });

  test("claimSyncLock returns false when no row updates", async () => {
    const q = createCalendarQueries(makeFakeClient(() => ({ data: [] })));
    expect(await q.claimSyncLock("user-1", new Date("2026-11-01T00:00:00.000Z"), 120000)).toBe(false);
  });

  test("releaseSyncLock clears the lock scoped by user", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      })
    );
    await q.releaseSyncLock("user-1");
    expect(seen[0].table).toBe("calendar_connections");
    expect(seen[0].method).toBe("update");
    expect(seen[0].payload).toMatchObject({ sync_lock_until: null });
    expect(seen[0].filters).toEqual([{ op: "eq", column: "user_id", value: "user-1" }]);
  });

  test("listActiveConnections filters active and passes the limit", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: [CONNECTION] };
      })
    );
    expect(await q.listActiveConnections(200)).toEqual([CONNECTION]);
    expect(seen[0].table).toBe("calendar_connections");
    expect(seen[0].filters).toEqual([{ op: "eq", column: "status", value: "active" }]);
    expect(seen[0].limitCount).toBe(200);

    const empty = createCalendarQueries(makeFakeClient(() => ({ data: null })));
    expect(await empty.listActiveConnections(200)).toEqual([]);
  });

  test("deleteLinksForUser scopes the delete by user", async () => {
    const seen: RecordedCall[] = [];
    const q = createCalendarQueries(
      makeFakeClient((c) => {
        seen.push(c);
        return { data: null };
      })
    );
    await q.deleteLinksForUser("user-1");
    expect(seen[0].method).toBe("delete");
    expect(seen[0].table).toBe("calendar_event_links");
    expect(seen[0].filters).toEqual([{ op: "eq", column: "user_id", value: "user-1" }]);
  });

  test("supabase failures throw a clear calendar error", async () => {
    const failing = (client: SupabaseClient) => createCalendarQueries(client);
    const bad = makeFakeClient(() => ({ error: { code: "42501", message: "denied" } }));
    expect(failing(bad).getConnection("u")).rejects.toThrow(/calendar getConnection/);
    expect(
      failing(bad).upsertLink({ taskId: "t", userId: "u", googleEventId: "e", syncedHash: "h" })
    ).rejects.toThrow(/calendar upsertLink/);
  });
});
