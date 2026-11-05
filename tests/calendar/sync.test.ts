import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { syncUserCalendar } = await import("../../lib/calendar/sync");
const { buildEvent, eventHash } = await import("../../lib/calendar/event");
const { GoogleError } = await import("../../lib/calendar/google");
import type { GoogleCalendarClient } from "../../lib/calendar/google";
import type { SyncUserCalendarDeps, PlanTask } from "../../lib/calendar/sync";
import type { CalendarConnectionRow, CalendarEventLinkRow } from "../../lib/calendar/queries";

function openTask(id: string, title = `Task ${id}`): PlanTask {
  return { id, title, course: "E-Math", due_at: "2026-10-31T16:00:00.000Z", status: "open" };
}

// In-memory Google stand-in: stores calendars and events, throws typed
// GoogleError for missing events, so a second sync run must find no work.
class StatefulFakeGoogle implements GoogleCalendarClient {
  calendars = new Map<string, string>();
  events = new Map<string, { calendarId: string; body: unknown }>();
  calls: string[] = [];
  nextId = 1;

  constructor(seedCalendar = true) {
    if (seedCalendar) this.calendars.set("cal-1", "Settle");
  }

  async refreshAccessToken(): Promise<{ accessToken: string; expiresIn: number }> {
    this.calls.push("refresh");
    return { accessToken: "at-1", expiresIn: 3600 };
  }

  async exchangeCode(): Promise<{ accessToken: string; refreshToken: string | null }> {
    this.calls.push("exchange");
    return { accessToken: "at-1", refreshToken: "rt-1" };
  }

  async revokeToken(): Promise<void> {
    this.calls.push("revoke");
  }

  async createCalendar(accessToken: string, name: string): Promise<{ id: string }> {
    void accessToken;
    this.calls.push("createCalendar");
    const id = "cal-new";
    this.calendars.set(id, name);
    return { id };
  }

  async getCalendarExists(accessToken: string, calendarId: string): Promise<boolean> {
    void accessToken;
    this.calls.push("exists");
    return this.calendars.has(calendarId);
  }

  async insertEvent(
    accessToken: string,
    calendarId: string,
    event: unknown
  ): Promise<{ id: string }> {
    void accessToken;
    this.calls.push("insert");
    const id = `ev-${this.nextId++}`;
    this.events.set(id, { calendarId, body: event });
    return { id };
  }

  async patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: unknown
  ): Promise<void> {
    void accessToken;
    void calendarId;
    this.calls.push("patch");
    const current = this.events.get(eventId);
    if (!current) throw new GoogleError("gone", 404, "patchEvent");
    this.events.set(eventId, { ...current, body: event });
  }

  async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
    void accessToken;
    void calendarId;
    this.calls.push("delete");
    if (!this.events.has(eventId)) throw new GoogleError("gone", 404, "deleteEvent");
    this.events.delete(eventId);
  }

  async deleteCalendar(accessToken: string, calendarId: string): Promise<void> {
    void accessToken;
    this.calls.push("deleteCalendar");
    this.calendars.delete(calendarId);
  }
}

type FakeState = {
  connection: CalendarConnectionRow | null;
  links: Map<string, CalendarEventLinkRow>;
  statusCalls: string[];
  lockUntil: Date | null;
  releaseCalls: number;
  claimCalls: number;
};

function makeDeps(over: {
  connection?: CalendarConnectionRow | null;
  links?: CalendarEventLinkRow[];
  tasks?: PlanTask[];
  google?: GoogleCalendarClient;
}): { deps: SyncUserCalendarDeps; state: FakeState; google: GoogleCalendarClient } {
  const state: FakeState = {
    connection:
      over.connection !== undefined
        ? over.connection
        : ({
        user_id: "user-1",
        google_calendar_id: "cal-1",
        refresh_token_enc: "enc-1",
        status: "active",
        sync_lock_until: null,
        created_at: "",
        updated_at: "",
      } satisfies CalendarConnectionRow),
    links: new Map((over.links ?? []).map((l) => [l.task_id, l])),
    statusCalls: [],
    lockUntil: null,
    releaseCalls: 0,
    claimCalls: 0,
  };
  const google = over.google ?? new StatefulFakeGoogle();
  const deps: SyncUserCalendarDeps = {
    queries: {
      getConnection: async () => state.connection,
      upsertConnection: async (i) => {
        const row: CalendarConnectionRow = {
          user_id: i.userId,
          google_calendar_id: i.googleCalendarId,
          refresh_token_enc: i.refreshTokenEnc,
          status: i.status,
          sync_lock_until: null,
          created_at: "",
          updated_at: "",
        };
        state.connection = row;
        return row;
      },
      setConnectionStatus: async (_userId, status) => {
        state.statusCalls.push(status);
        if (state.connection) state.connection = { ...state.connection, status };
      },
      listLinks: async () => [...state.links.values()],
      upsertLink: async (i) => {
        const row: CalendarEventLinkRow = {
          task_id: i.taskId,
          user_id: i.userId,
          google_event_id: i.googleEventId,
          synced_hash: i.syncedHash,
          synced_at: (i.syncedAt ?? new Date()).toISOString(),
        };
        state.links.set(i.taskId, row);
        return row;
      },
      deleteLink: async (taskId) => {
        state.links.delete(taskId);
      },
      claimSyncLock: async (_userId, now, ttlMs) => {
        state.claimCalls += 1;
        if (state.lockUntil && state.lockUntil > now) return false;
        state.lockUntil = new Date(now.getTime() + ttlMs);
        return true;
      },
      releaseSyncLock: async () => {
        state.releaseCalls += 1;
        state.lockUntil = null;
      },
    },
    listOpenTasks: async () => over.tasks ?? [],
    google,
    decrypt: () => "refresh-plain",
    tokenKey: "key",
    now: () => new Date("2026-11-01T00:00:00Z"),
  };
  return { deps, state, google };
}

function linkRow(task: PlanTask, eventId = `ev-${task.id}`): CalendarEventLinkRow {
  return {
    task_id: task.id,
    user_id: "user-1",
    google_event_id: eventId,
    synced_hash: eventHash(buildEvent(task)),
    synced_at: "2026-01-01T00:00:00Z",
  };
}

describe("syncUserCalendar", () => {
  test("does nothing without an active connection", async () => {
    const google = new StatefulFakeGoogle();
    const { deps } = makeDeps({ connection: null, tasks: [openTask("a")], google });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
    expect(google.calls).toEqual([]);

    const reconnect = makeDeps({
      tasks: [openTask("a")],
      connection: {
        user_id: "user-1",
        google_calendar_id: "cal-1",
        refresh_token_enc: "enc-1",
        status: "needs_reconnect",
        sync_lock_until: null,
        created_at: "",
        updated_at: "",
      },
    });
    expect(await syncUserCalendar("user-1", reconnect.deps)).toEqual({
      created: 0,
      patched: 0,
      removed: 0,
      failed: 0,
    });
  });

  test("create, patch, remove and no-op in one run", async () => {
    const google = new StatefulFakeGoogle();
    const keep = openTask("keep");
    const changed = { ...openTask("changed"), title: "Renamed" };
    const staleLink: CalendarEventLinkRow = {
      ...linkRow(openTask("changed")),
      synced_hash: "stale",
      google_event_id: "ev-old",
    };
    google.events.set("ev-keep", { calendarId: "cal-1", body: buildEvent(keep) });
    google.events.set("ev-old", { calendarId: "cal-1", body: buildEvent(openTask("changed")) });
    google.events.set("ev-gone-task", { calendarId: "cal-1", body: {} });
    const { deps, state } = makeDeps({
      google,
      tasks: [keep, changed, openTask("fresh")],
      links: [
        linkRow(keep, "ev-keep"),
        staleLink,
        { task_id: "gone-task", user_id: "user-1", google_event_id: "ev-gone-task", synced_hash: "h", synced_at: "" },
      ],
    });
    const summary = await syncUserCalendar("user-1", deps);
    expect(summary).toEqual({ created: 1, patched: 1, removed: 1, failed: 0 });
    expect(state.links.has("gone-task")).toBe(false);
    expect(google.events.has("ev-gone-task")).toBe(false);
  });

  test("second run against the same fake Google finds no work", async () => {
    const google = new StatefulFakeGoogle();
    const { deps } = makeDeps({ google, tasks: [openTask("a"), openTask("b")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 2, patched: 0, removed: 0, failed: 0 });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
  });

  test("recreates a deleted Settle calendar once", async () => {
    const google = new StatefulFakeGoogle(false);
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    const summary = await syncUserCalendar("user-1", deps);
    expect(summary.created).toBe(1);
    expect(google.calls.filter((c) => c === "createCalendar")).toHaveLength(1);
    expect(state.connection?.google_calendar_id).toBe("cal-new");
  });

  test("auth on refresh marks needs_reconnect and stops", async () => {
    const google = new StatefulFakeGoogle();
    google.refreshAccessToken = async () => {
      throw new GoogleError("auth", 401, "refreshAccessToken");
    };
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
    expect(state.statusCalls).toEqual(["needs_reconnect"]);
  });

  test("rate on refresh stops quietly without a status change", async () => {
    const google = new StatefulFakeGoogle();
    google.refreshAccessToken = async () => {
      throw new GoogleError("rate", 429, "refreshAccessToken");
    };
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
    expect(state.statusCalls).toEqual([]);
  });

  test("rate mid-run stops and leaves the rest for the next run", async () => {
    const google = new StatefulFakeGoogle();
    const realInsert = google.insertEvent.bind(google);
    let calls = 0;
    google.insertEvent = async (t, c, e) => {
      calls += 1;
      if (calls === 1) throw new GoogleError("rate", 429, "insertEvent");
      return realInsert(t, c, e);
    };
    const { deps } = makeDeps({ google, tasks: [openTask("a"), openTask("b")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
    expect(calls).toBe(1);
  });

  test("auth mid-run marks needs_reconnect and stops", async () => {
    const google = new StatefulFakeGoogle();
    google.insertEvent = async () => {
      throw new GoogleError("auth", 401, "insertEvent");
    };
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
    expect(state.statusCalls).toEqual(["needs_reconnect"]);
  });

  test("gone on delete counts as already deleted", async () => {
    const google = new StatefulFakeGoogle();
    const { deps, state } = makeDeps({
      google,
      tasks: [],
      links: [{ task_id: "t", user_id: "user-1", google_event_id: "ev-missing", synced_hash: "h", synced_at: "" }],
    });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 1, failed: 0 });
    expect(state.links.has("t")).toBe(false);
  });

  test("gone on patch re-creates the event", async () => {
    const google = new StatefulFakeGoogle();
    const changed = { ...openTask("t"), title: "Renamed" };
    const { deps, state } = makeDeps({
      google,
      tasks: [changed],
      links: [{ ...linkRow(openTask("t")), synced_hash: "stale", google_event_id: "ev-missing" }],
    });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 1, removed: 0, failed: 0 });
    expect(state.links.get("t")?.google_event_id).not.toBe("ev-missing");
  });

  test("one task failure never aborts the others", async () => {
    const google = new StatefulFakeGoogle();
    google.insertEvent = async (t, c, e) => {
      void t;
      void c;
      const body = e as { summary?: string };
      if (body.summary === "Task bad") throw new GoogleError("other", 400, "insertEvent");
      return { id: `ev-${body.summary}` };
    };
    const { deps } = makeDeps({ google, tasks: [openTask("good"), openTask("bad")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 1, patched: 0, removed: 0, failed: 1 });
  });

  test("second call while the lock is held does nothing and skips Google", async () => {
    const google = new StatefulFakeGoogle();
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    state.lockUntil = new Date("2026-11-01T01:00:00Z");
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
    expect(google.calls).toEqual([]);
    expect(state.releaseCalls).toBe(0);
  });

  test("lock is released after a successful run", async () => {
    const google = new StatefulFakeGoogle();
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 1, patched: 0, removed: 0, failed: 0 });
    expect(state.releaseCalls).toBe(1);
    expect(state.lockUntil).toBeNull();
  });

  test("lock is released after an auth failure", async () => {
    const google = new StatefulFakeGoogle();
    google.refreshAccessToken = async () => {
      throw new GoogleError("auth", 401, "refreshAccessToken");
    };
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 0, patched: 0, removed: 0, failed: 0 });
    expect(state.releaseCalls).toBe(1);
    expect(state.lockUntil).toBeNull();
  });

  test("lock is released when the run throws", async () => {
    const google = new StatefulFakeGoogle();
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    deps.listOpenTasks = async () => {
      throw new Error("db down");
    };
    await expect(syncUserCalendar("user-1", deps)).rejects.toThrow("db down");
    expect(state.releaseCalls).toBe(1);
    expect(state.lockUntil).toBeNull();
  });

  test("an expired lock can be re-claimed", async () => {
    const google = new StatefulFakeGoogle();
    const { deps, state } = makeDeps({ google, tasks: [openTask("a")] });
    state.lockUntil = new Date("2025-01-01T00:00:00Z");
    expect(await syncUserCalendar("user-1", deps)).toEqual({ created: 1, patched: 0, removed: 0, failed: 0 });
    expect(state.claimCalls).toBe(1);
    expect(state.releaseCalls).toBe(1);
    expect(state.lockUntil).toBeNull();
  });
});
